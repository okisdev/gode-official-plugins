import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DictationAudio,
  DictationSession,
  DictationStart,
  PluginSettingValue,
  PluginStatus,
} from '@gode/plugin-sdk'
import {
  DictationRecordings,
  PluginError,
  type DictationRecording,
  type PluginHandlers,
  type SetPluginView,
} from '@gode/plugin-sdk/plugin'
import resources from '../resources.json'
import { clearPartials, downloadModels, modelsPresent, type ModelSet } from './download'
import { LocalEngine } from './engine'
import { VoiceHistory } from './history'
import { VoiceMemory } from './memory'
import { polishedText, polishMessages } from './polish-logic'
import { detectSpeech } from './speech-logic'
import { VoiceStats } from './stats'
import {
  apiURL,
  applyVocabulary,
  cleanTranscript,
  formatBytes,
  responseJSON,
  transcriptionRequest,
} from './transcription-logic'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createVoicePlugin(
  setStatus: (status: PluginStatus) => void,
  setView: SetPluginView,
  models: readonly ModelSet[] = resources.models,
  polish: ModelSet = resources.polish,
): Required<Pick<PluginHandlers, 'start' | 'settings' | 'action' | 'query' | 'call' | 'error'>> & {
  dispose(): Promise<void>
  kill(): void
} {
  let settings: Readonly<Record<string, PluginSettingValue>> = {}
  let secrets: Readonly<Record<string, string>> = {}
  let locale = 'en'
  let directory = ''
  let executable = ''
  let engine: LocalEngine
  let polishEngine: LocalEngine
  let stats: VoiceStats
  let history: VoiceHistory
  let memory: VoiceMemory
  let ready = false
  let download: { controller: AbortController; task: Promise<void>; model: ModelSet } | undefined
  let check: AbortController | undefined
  let disposed = false
  const recordings = new DictationRecordings()
  const recognized = new Map<string, number>()
  const text = (key: string, fallback = ''): string =>
    typeof settings[key] === 'string' ? settings[key] : fallback
  const local = (): boolean => text('engine', 'local') === 'local'
  const polishOn = (): boolean => settings.polish === true
  const selected = (): ModelSet =>
    models.find((model) => model.id === text('localModel', 'qwen3-asr-1.7b')) ?? models[0]!
  const createEngine = (): LocalEngine => {
    const [model, projector] = selected().files
    return new LocalEngine({
      executable,
      model: join(directory, model!.file),
      projector: join(directory, projector!.file),
    })
  }
  const polishPresent = (): Promise<boolean> => modelsPresent(directory, polish.files)
  const status = (value: PluginStatus): void => {
    if (!disposed) setStatus(value)
  }
  async function refresh(): Promise<void> {
    ready = false
    let next: PluginStatus
    if (local()) {
      const files = selected().files
      ready = await modelsPresent(directory, files)
      next = ready
        ? { state: 'ready', message: 'status.localReady' }
        : {
            state: 'setup',
            message: 'status.modelMissing',
            values: {
              size: formatBytes(
                files.reduce((sum, file) => sum + file.size, 0),
                locale,
              ),
            },
            action: 'downloadModel',
          }
    } else if (!text('serverURL').trim()) {
      next = { state: 'setup', message: 'status.serverMissing' }
    } else {
      try {
        const url = new URL(apiURL(text('serverURL').trim(), 'audio/transcriptions'))
        ready = true
        next = { state: 'ready', message: 'status.serverReady', values: { host: url.host } }
      } catch (error) {
        next = {
          state: 'failed',
          message: 'status.serverFailed',
          values: { reason: reason(error) },
        }
      }
    }
    if (ready && polishOn() && !(await polishPresent()))
      next = { state: 'ready', message: 'status.polishMissing', action: 'downloadPolishModel' }
    status(next)
  }

  async function stopDownload(): Promise<void> {
    download?.controller.abort()
    await download?.task
  }

  async function transcribe(
    base: string,
    recording: DictationRecording,
    audio: Uint8Array,
    vocabulary: readonly string[],
    options: { model: string; language: string; apiKey?: string; removeFillers: boolean },
  ): Promise<{ text: string }> {
    try {
      const response = await fetch(apiURL(base, 'audio/transcriptions'), {
        ...transcriptionRequest({ audio, vocabulary }, options),
        signal: AbortSignal.any([recording.signal, AbortSignal.timeout(180_000)]),
      })
      const value = await responseJSON(response)
      if (
        !value ||
        typeof value !== 'object' ||
        !('text' in value) ||
        typeof value.text !== 'string'
      )
        throw new Error('The server returned no transcription')
      return { text: cleanTranscript(value.text, options.removeFillers) }
    } catch (error) {
      throw new PluginError({ message: 'error.recognition', values: { reason: reason(error) } })
    }
  }

  async function recognize(
    recording: DictationRecording,
    audio: Uint8Array,
    span: { start: number; end: number },
    final = false,
  ): Promise<{ text: string }> {
    const isLocal = local()
    const vocabulary = memory.vocabulary(recording.vocabulary)
    const options = {
      model: isLocal ? selected().files[0]!.file : text('model', 'gpt-4o-transcribe'),
      language: text('language', 'auto'),
      apiKey: isLocal ? undefined : secrets.apiKey,
      removeFillers: settings.removeFillers !== false,
    }
    if (!isLocal) {
      const result = await transcribe(
        text('serverURL').trim(),
        recording,
        audio,
        memory.vocabulary(recording.vocabulary, 50),
        options,
      )
      return final ? result : { text: applyVocabulary(result.text, vocabulary) }
    }
    const pcm = audio.subarray(
      44 + Math.round(span.start * 16000) * 2,
      44 + Math.round(span.end * 16000) * 2,
    )
    const trimmed = new Uint8Array(44 + pcm.byteLength)
    trimmed.set(audio.subarray(0, 44))
    trimmed.set(pcm, 44)
    const header = new DataView(trimmed.buffer)
    header.setUint32(4, 36 + pcm.byteLength, true)
    header.setUint32(40, pcm.byteLength, true)
    try {
      const result = await engine.use((base) => transcribe(base, recording, trimmed, [], options))
      return final ? result : { text: applyVocabulary(result.text, vocabulary) }
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError({ message: 'error.engine', values: { reason: reason(error) } })
    }
  }

  async function tidy(recording: DictationRecording, text: string): Promise<string> {
    if (!text || !polishOn()) return text
    try {
      if (!(await polishPresent())) return text
      return await polishEngine.use(async (base) => {
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: polishMessages(text, memory.vocabulary(recording.vocabulary)),
            temperature: 0,
            max_tokens: Math.min(512, 2 * text.length + 16),
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.any([recording.signal, AbortSignal.timeout(5000)]),
        })
        const value = (await responseJSON(response)) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const reply = value?.choices?.[0]?.message?.content
        return typeof reply === 'string' ? (polishedText(text, reply) ?? text) : text
      })
    } catch {
      return text
    }
  }

  function known(request: DictationSession): void {
    if (!recognized.has(request.session)) throw new PluginError({ message: 'error.session' })
  }

  return {
    async start(message) {
      settings = message.settings
      secrets = message.secrets
      locale = message.locale
      stats = new VoiceStats(message.paths.data, setView)
      await stats.read()
      history = new VoiceHistory(message.paths.data, locale, setView)
      memory = new VoiceMemory(message.paths.data, locale, setView)
      await history.read()
      await memory.read()
      directory = join(message.paths.data, 'models')
      await mkdir(directory, { recursive: true })
      await clearPartials(
        directory,
        [...models, polish].flatMap((model) => [...model.files]),
      )
      executable = join(message.paths.plugin, 'bin/llama-server')
      engine = createEngine()
      polishEngine = new LocalEngine({ executable, model: join(directory, polish.files[0]!.file) })
      await refresh()
    },
    async settings(message) {
      check?.abort()
      const wasLocal = local()
      const wasPolish = polishOn()
      const previousModel = selected().id
      settings = message.settings
      secrets = message.secrets
      const modelChanged = previousModel !== selected().id
      if ((wasLocal && !local()) || modelChanged) {
        ready = false
        await stopDownload()
        await engine.stop()
      }
      if (modelChanged) engine = createEngine()
      if (wasPolish && !polishOn()) await polishEngine.stop()
      if (!download) await refresh()
    },
    async action(action, item) {
      if (action === 'deleteEntry' && item) {
        history.delete(item)
      } else if (action === 'clearHistory') {
        history.clear()
      } else if (action === 'forgetTerm' && item) {
        memory.forget(item)
      } else if (action === 'clearMemory') {
        memory.clear()
      } else if (action === 'stopDownload') {
        await stopDownload()
        await refresh()
      } else if (action === 'removeModel') {
        await stopDownload()
        await engine.stop()
        await Promise.all(
          selected().files.map((file) => rm(join(directory, file.file), { force: true })),
        )
        await refresh()
      } else if (action === 'removePolishModel') {
        if (download?.model.id === polish.id) await stopDownload()
        await polishEngine.stop()
        await Promise.all(
          polish.files.map((file) => rm(join(directory, file.file), { force: true })),
        )
        await refresh()
      } else if (
        ((action === 'downloadModel' && local()) || action === 'downloadPolishModel') &&
        !download
      ) {
        const target = action === 'downloadModel' ? selected() : polish
        if (target !== polish) {
          ready = false
          await engine.stop()
        } else await polishEngine.stop()
        const controller = new AbortController()
        let lastProgress = 0
        const task = (async () => {
          try {
            await downloadModels(directory, target.files, controller.signal, (done, bytes) => {
              if (done !== 0 && done !== bytes && Date.now() - lastProgress < 100) return
              lastProgress = Date.now()
              status({
                state: 'working',
                message: target === polish ? 'status.polishDownloading' : 'status.downloading',
                progress: done / bytes,
                values: { done: formatBytes(done, locale), total: formatBytes(bytes, locale) },
                action: 'stopDownload',
              })
            })
            if (!controller.signal.aborted) await refresh()
          } catch (error) {
            if (!controller.signal.aborted) {
              if (target === polish && !ready) await refresh()
              else
                status({
                  state: target === polish ? 'ready' : 'failed',
                  message:
                    target === polish ? 'status.polishDownloadFailed' : 'status.downloadFailed',
                  values: { reason: reason(error) },
                  action: target === polish ? 'downloadPolishModel' : 'downloadModel',
                })
            }
          } finally {
            download = undefined
          }
        })()
        download = { controller, task, model: target }
      } else if (action === 'checkServer' && !local()) {
        check?.abort()
        if (!text('serverURL').trim()) return refresh()
        const controller = new AbortController()
        check = controller
        ready = false
        status({ state: 'working', message: 'status.checking' })
        void (async () => {
          try {
            await responseJSON(
              await fetch(apiURL(text('serverURL').trim(), 'models'), {
                headers: secrets.apiKey ? { Authorization: `Bearer ${secrets.apiKey}` } : {},
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              }),
            )
            if (!controller.signal.aborted) await refresh()
          } catch (error) {
            if (!controller.signal.aborted)
              status({
                state: 'failed',
                message: 'status.serverFailed',
                values: { reason: reason(error) },
              })
          }
        })()
      }
    },
    query({ view, search, cursor, limit }) {
      if (view === 'history') return history.query(search, cursor, limit)
      if (view === 'memory') return memory.query(search, cursor, limit)
      throw new Error(`Unknown view: ${view}`)
    },
    async call(message) {
      if (message.method === 'dictation.cancel') {
        const request = message.params as DictationSession
        recordings.cancel(request)
        recognized.delete(request.session)
        return null
      }
      if (message.method === 'dictation.start') {
        if (!ready) return null
        const request = message.params as DictationStart
        recordings.start(request)
        recognized.set(request.session, 0)
        if (local()) void engine.use(async () => null).catch(() => {})
        if (polishOn())
          void polishPresent()
            .then((present) => {
              if (present && recognized.has(request.session))
                void polishEngine.use(async () => null).catch(() => {})
            })
            .catch(() => {})
        return null
      }
      if (message.method === 'dictation.append') {
        if (!ready) return null
        const request = message.params as DictationAudio
        known(request)
        return recordings.append(request, async (recording) => {
          if (!local() || recording.seconds > 30) return null
          const previous = recognized.get(request.session)!
          if (recording.seconds - previous < 1) return null
          const audio = recording.wav()
          const speech = detectSpeech(audio.subarray(44))
          if (!speech.hasSpeech || !speech.span) return null
          recognized.set(request.session, recording.seconds)
          return recognize(recording, audio, speech.span)
        })
      }
      const request = message.params as DictationSession
      if (!ready) {
        recordings.cancel(request)
        recognized.delete(request.session)
        throw new PluginError({ message: 'error.notReady' })
      }
      known(request)
      try {
        return await recordings.finish(request, async (recording) => {
          const audio = recording.wav()
          const speech = detectSpeech(audio.subarray(44))
          if (!speech.hasSpeech || !speech.span) return { text: '' }
          const raw = await recognize(recording, audio, speech.span, true)
          const result = {
            text: applyVocabulary(
              await tidy(recording, raw.text),
              memory.vocabulary(recording.vocabulary),
            ),
          }
          if (result.text && !recording.signal.aborted) {
            if (settings.keepHistory !== false) history.record(result.text, recording.seconds)
            if (settings.learnTerms !== false) memory.record(result.text, recording.vocabulary)
            stats.record(result.text, recording.seconds)
          }
          return result
        })
      } finally {
        recognized.delete(request.session)
      }
    },
    error: (error) => ({ message: 'error.engine', values: { reason: reason(error) } }),
    kill: () => {
      engine?.kill()
      polishEngine?.kill()
    },
    async dispose() {
      disposed = true
      ready = false
      check?.abort()
      for (const session of recognized.keys()) recordings.cancel({ session })
      recognized.clear()
      await Promise.all([stats?.dispose(), history?.dispose(), memory?.dispose()])
      await stopDownload()
      await engine?.stop()
      await polishEngine?.stop()
    },
  }
}
