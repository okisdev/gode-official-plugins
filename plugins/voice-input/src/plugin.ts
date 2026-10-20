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
import { clearPartials, downloadModels, modelsPresent, type ModelFile } from './download'
import { LocalEngine } from './engine'
import { VoiceHistory } from './history'
import { VoiceMemory } from './memory'
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
  models: readonly ModelFile[] = resources.models,
): PluginHandlers & { dispose(): Promise<void>; kill(): void } {
  let settings: Readonly<Record<string, PluginSettingValue>> = {}
  let secrets: Readonly<Record<string, string>> = {}
  let locale = 'en'
  let directory = ''
  let engine: LocalEngine
  let stats: VoiceStats
  let history: VoiceHistory
  let memory: VoiceMemory
  let ready = false
  let download: { controller: AbortController; task: Promise<void> } | undefined
  let check: AbortController | undefined
  let disposed = false
  const recordings = new DictationRecordings()
  const recognized = new Map<string, number>()
  const text = (key: string, fallback = ''): string =>
    typeof settings[key] === 'string' ? settings[key] : fallback
  const local = (): boolean => text('engine', 'local') === 'local'
  const status = (value: PluginStatus): void => {
    if (!disposed) setStatus(value)
  }
  const total = models.reduce((sum, model) => sum + model.size, 0)

  async function refresh(): Promise<void> {
    ready = false
    if (local()) {
      ready = await modelsPresent(directory, models)
      status(
        ready
          ? { state: 'ready', message: 'status.localReady' }
          : {
              state: 'setup',
              message: 'status.modelMissing',
              values: { size: formatBytes(total, locale) },
              action: 'downloadModel',
            },
      )
    } else if (!text('serverURL').trim()) {
      status({ state: 'setup', message: 'status.serverMissing' })
    } else {
      try {
        const url = new URL(apiURL(text('serverURL').trim(), 'audio/transcriptions'))
        ready = true
        status({ state: 'ready', message: 'status.serverReady', values: { host: url.host } })
      } catch (error) {
        status({
          state: 'failed',
          message: 'status.serverFailed',
          values: { reason: reason(error) },
        })
      }
    }
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
    corrections: readonly string[],
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
      return {
        text: applyVocabulary(cleanTranscript(value.text, options.removeFillers), corrections),
      }
    } catch (error) {
      throw new PluginError({ message: 'error.recognition', values: { reason: reason(error) } })
    }
  }

  async function recognize(
    recording: DictationRecording,
    audio: Uint8Array,
    span: { start: number; end: number },
  ): Promise<{ text: string }> {
    const isLocal = local()
    const vocabulary = memory.vocabulary(recording.vocabulary)
    const options = {
      model: isLocal ? models[0]!.file : text('model', 'gpt-4o-transcribe'),
      language: text('language', 'auto'),
      apiKey: isLocal ? undefined : secrets.apiKey,
      removeFillers: settings.removeFillers !== false,
    }
    if (!isLocal)
      return transcribe(
        text('serverURL').trim(),
        recording,
        audio,
        memory.vocabulary(recording.vocabulary, 50),
        vocabulary,
        options,
      )
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
      return await engine.use((base) =>
        transcribe(base, recording, trimmed, [], vocabulary, options),
      )
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError({ message: 'error.engine', values: { reason: reason(error) } })
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
      await clearPartials(directory, models)
      engine = new LocalEngine({
        executable: join(message.paths.plugin, 'bin/llama-server'),
        model: join(directory, models[0]!.file),
        projector: join(directory, models[1]!.file),
      })
      await refresh()
    },
    async settings(message) {
      check?.abort()
      const wasLocal = local()
      settings = message.settings
      secrets = message.secrets
      if (wasLocal && !local()) {
        await stopDownload()
        await engine.stop()
      }
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
        await Promise.all(models.map((model) => rm(join(directory, model.file), { force: true })))
        await refresh()
      } else if (action === 'downloadModel' && local() && !download) {
        ready = false
        await engine.stop()
        const controller = new AbortController()
        let lastProgress = 0
        const task = (async () => {
          try {
            await downloadModels(directory, models, controller.signal, (done, bytes) => {
              if (done !== 0 && done !== bytes && Date.now() - lastProgress < 100) return
              lastProgress = Date.now()
              status({
                state: 'working',
                message: 'status.downloading',
                progress: done / bytes,
                values: { done: formatBytes(done, locale), total: formatBytes(bytes, locale) },
                action: 'stopDownload',
              })
            })
            if (!controller.signal.aborted) await refresh()
          } catch (error) {
            if (!controller.signal.aborted)
              status({
                state: 'failed',
                message: 'status.downloadFailed',
                values: { reason: reason(error) },
                action: 'downloadModel',
              })
          } finally {
            download = undefined
          }
        })()
        download = { controller, task }
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
          const result = await recognize(recording, audio, speech.span)
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
    kill: () => engine?.kill(),
    async dispose() {
      disposed = true
      ready = false
      check?.abort()
      for (const session of recognized.keys()) recordings.cancel({ session })
      recognized.clear()
      await Promise.all([stats?.dispose(), history?.dispose(), memory?.dispose()])
      await stopDownload()
      await engine?.stop()
    },
  }
}
