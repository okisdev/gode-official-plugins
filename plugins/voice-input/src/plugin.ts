import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DictationAudio,
  DictationSession,
  DictationStart,
  PluginSettingValue,
  PluginStep,
  PluginStatus,
} from '@gode/plugin-sdk'
import {
  DictationRecordings,
  PluginError,
  type DictationRecording,
  type PluginContext,
  type PluginHandlers,
} from '@gode/plugin-sdk/plugin'
import resources from '../resources.json'
import { clearPartials, downloadModels, modelsPresent, type ModelSet } from './download'
import { LocalEngine } from './engine'
import { VoiceHistory } from './history'
import { VoiceMemory } from './memory'
import { polishedText, polishMessages } from './polish-logic'
import { detectSpeech, findSpeechPause } from './speech-logic'
import { VoiceStats } from './stats'
import {
  apiURL,
  applyVocabulary,
  cleanTranscript,
  formatBytes,
  joinTranscript,
  responseJSON,
  transcriptionRequest,
} from './transcription-logic'

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function logReason(error: unknown): string {
  if (!(error instanceof Error)) return 'Operation failed'
  if (error.cause) return logReason(error.cause)
  if (error.name === 'AbortError') return 'Request aborted'
  if (error.name === 'TimeoutError') return 'Request timed out'
  const code = (error as NodeJS.ErrnoException).code
  if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) return code
  if (/^HTTP [1-5]\d{2}$/.test(error.message)) return error.message
  if (error.message.startsWith('Integrity check failed for ')) return 'Model integrity check failed'
  if (error.message.startsWith('Unexpected size for ')) return 'Unexpected model size'
  switch (error.message) {
    case 'fetch failed':
    case 'Invalid URL':
    case 'Expected an HTTP or HTTPS API address':
    case 'The server returned no transcription':
      return error.message
    case 'error.notReady':
      return 'Plugin is not ready'
    case 'error.session':
      return 'Dictation session has not started'
    case 'error.engine':
      return 'Local engine failed'
    default:
      return 'Operation failed'
  }
}

async function readResponse(response: Response): Promise<unknown> {
  try {
    return await responseJSON(response)
  } catch (error) {
    if (response.ok) throw error
    throw new Error(reason(error), { cause: new Error(`HTTP ${response.status}`) })
  }
}

export function createVoicePlugin(
  { setStatus, setView, log }: PluginContext,
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
  let currentStatus: PluginStatus | undefined
  const recordings = new DictationRecordings()
  const recognized = new Map<string, { seconds: number; start: number; text: string }>()
  const text = (key: string, fallback = ''): string =>
    typeof settings[key] === 'string' ? settings[key] : fallback
  const local = (): boolean => text('engine', 'local') === 'local'
  const polishOn = (): boolean => settings.polish === true
  const selected = (): ModelSet =>
    models.find((model) => model.id === text('localModel', 'qwen3-asr-1.7b')) ?? models[0]!
  const createEngine = (): LocalEngine => {
    const [model, projector] = selected().files
    return new LocalEngine({
      name: 'recognition',
      log,
      executable,
      model: join(directory, model!.file),
      projector: join(directory, projector!.file),
    })
  }
  const polishPresent = (): Promise<boolean> => modelsPresent(directory, polish.files)
  const status = (value: PluginStatus): void => {
    if (!disposed) {
      currentStatus = value
      setStatus(value)
    }
  }
  const updateStep = (id: string, step: Partial<PluginStep>): void => {
    if (!currentStatus) return
    status({
      ...currentStatus,
      steps: currentStatus.steps?.map((item) => (item.id === id ? { ...item, ...step } : item)),
    })
  }
  async function refresh(preserveDownload = true): Promise<void> {
    const steps: PluginStep[] = []
    let next: PluginStatus
    if (local()) {
      const model = selected()
      const files = model.files
      ready = await modelsPresent(directory, files)
      next = {
        state: ready ? 'ready' : 'setup',
        message: ready ? 'status.localReady' : 'status.setup',
      }
      const size = formatBytes(
        files.reduce((sum, file) => sum + file.size, 0),
        locale,
      )
      steps.push({
        id: 'model',
        title: 'step.model',
        message: ready ? 'step.modelDone' : 'step.modelTodo',
        values: {
          model: model.id === 'qwen3-asr-1.7b' ? 'Qwen3-ASR 1.7B' : 'Qwen3-ASR 0.6B',
          size,
        },
        state: ready ? 'done' : 'todo',
        fields: ['engine', 'localModel'],
        action: ready ? 'removeModel' : 'downloadModel',
      })
    } else if (!text('serverURL').trim()) {
      ready = false
      next = { state: 'setup', message: 'status.setup' }
      steps.push({
        id: 'server',
        title: 'step.server',
        message: 'step.serverTodo',
        state: 'todo',
        fields: ['engine', 'serverURL', 'apiKey', 'model'],
      })
    } else {
      try {
        const url = new URL(apiURL(text('serverURL').trim(), 'audio/transcriptions'))
        ready = true
        next = { state: 'ready', message: 'status.serverReady', values: { host: url.host } }
        steps.push({
          id: 'server',
          title: 'step.server',
          message: 'step.serverDone',
          state: 'done',
          fields: ['engine', 'serverURL', 'apiKey', 'model'],
          action: 'checkServer',
        })
      } catch (error) {
        ready = false
        next = { state: 'setup', message: 'status.setup' }
        steps.push({
          id: 'server',
          title: 'step.server',
          message: 'status.serverFailed',
          values: { reason: reason(error) },
          state: 'failed',
          fields: ['engine', 'serverURL', 'apiKey', 'model'],
          action: 'checkServer',
        })
      }
    }
    if (polishOn()) {
      const present = await polishPresent()
      steps.push({
        id: 'polish',
        title: 'step.polish',
        message: present ? 'step.polishDone' : 'step.polishTodo',
        values: {
          size: formatBytes(
            polish.files.reduce((sum, file) => sum + file.size, 0),
            locale,
          ),
        },
        state: present ? 'done' : 'todo',
        optional: true,
        fields: ['polish'],
        action: present ? 'removePolishModel' : 'downloadPolishModel',
      })
    }
    if (preserveDownload && download) {
      const id = download.model === polish ? 'polish' : 'model'
      const active = currentStatus?.steps?.find(
        (step) => step.id === id && step.state === 'working',
      )
      const index = steps.findIndex((step) => step.id === id)
      if (active && index !== -1) steps.splice(index, 1, active)
    }
    status({ ...next, steps, actions: [] })
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
      const value = await readResponse(response)
      if (
        !value ||
        typeof value !== 'object' ||
        !('text' in value) ||
        typeof value.text !== 'string'
      )
        throw new Error('The server returned no transcription')
      return { text: cleanTranscript(value.text, options.removeFillers) }
    } catch (error) {
      const failure = new PluginError({
        message: 'error.recognition',
        values: { reason: reason(error) },
      })
      failure.cause = error
      throw failure
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
      const result = await engine.use((base, apiKey) =>
        transcribe(base, recording, trimmed, [], { ...options, apiKey }),
      )
      return final ? result : { text: applyVocabulary(result.text, vocabulary) }
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError({ message: 'error.engine', values: { reason: reason(error) } })
    }
  }

  async function tidy(
    recording: DictationRecording,
    text: string,
  ): Promise<{ text: string; ran: boolean }> {
    if (!text || !polishOn()) return { text, ran: false }
    let ran = false
    try {
      if (!(await polishPresent())) return { text, ran }
      return await polishEngine.use(async (base, apiKey) => {
        ran = true
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            messages: polishMessages(text, memory.vocabulary(recording.vocabulary)),
            temperature: 0,
            max_tokens: Math.min(512, 2 * text.length + 16),
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.any([recording.signal, AbortSignal.timeout(5000)]),
        })
        const value = (await readResponse(response)) as {
          choices?: { message?: { content?: unknown } }[]
        }
        const reply = value?.choices?.[0]?.message?.content
        return { text: typeof reply === 'string' ? (polishedText(text, reply) ?? text) : text, ran }
      })
    } catch (error) {
      if (!recording.signal.aborted) log('warning', `Dictation polish failed: ${logReason(error)}`)
      return { text, ran }
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
      polishEngine = new LocalEngine({
        name: 'polish',
        log,
        executable,
        model: join(directory, polish.files[0]!.file),
      })
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
      if (wasPolish && !polishOn()) {
        if (download?.model === polish) await stopDownload()
        await polishEngine.stop()
      }
      await refresh()
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
        const files = target.files.map((file) => file.file).join(', ')
        log(
          'info',
          `Model download started: ${files} (${target.files.reduce((sum, file) => sum + file.size, 0)} bytes)`,
        )
        let lastProgress = 0
        if (target !== polish && currentStatus)
          status({ ...currentStatus, state: 'setup', message: 'status.setup' })
        updateStep(target === polish ? 'polish' : 'model', {
          state: 'working',
          message: target === polish ? 'status.polishDownloading' : 'status.downloading',
          values: {
            done: formatBytes(0, locale),
            total: formatBytes(
              target.files.reduce((sum, file) => sum + file.size, 0),
              locale,
            ),
          },
          progress: 0,
          action: 'stopDownload',
        })
        const task = (async () => {
          try {
            await downloadModels(directory, target.files, controller.signal, (done, bytes) => {
              if (done !== 0 && done !== bytes && Date.now() - lastProgress < 100) return
              lastProgress = Date.now()
              updateStep(target === polish ? 'polish' : 'model', {
                state: 'working',
                message: target === polish ? 'status.polishDownloading' : 'status.downloading',
                progress: done / bytes,
                values: { done: formatBytes(done, locale), total: formatBytes(bytes, locale) },
                action: 'stopDownload',
              })
            })
            log('info', `Model download finished: ${files}`)
            if (!controller.signal.aborted) await refresh(false)
          } catch (error) {
            if (controller.signal.aborted) log('info', `Model download stopped: ${files}`)
            else {
              log('error', `Model download failed: ${files}: ${logReason(error)}`)
              updateStep(target === polish ? 'polish' : 'model', {
                state: 'failed',
                message:
                  target === polish ? 'status.polishDownloadFailed' : 'status.downloadFailed',
                values: { reason: reason(error) },
                progress: undefined,
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
        if (!text('serverURL').trim()) {
          log('warning', 'Server check failed: No server address')
          return refresh()
        }
        const controller = new AbortController()
        check = controller
        updateStep('server', { state: 'working', message: 'status.checking', action: undefined })
        void (async () => {
          try {
            await readResponse(
              await fetch(apiURL(text('serverURL').trim(), 'models'), {
                headers: secrets.apiKey ? { Authorization: `Bearer ${secrets.apiKey}` } : {},
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
              }),
            )
            if (!controller.signal.aborted) {
              log('info', 'Server check succeeded')
              await refresh()
            }
          } catch (error) {
            if (!controller.signal.aborted) {
              log('error', `Server check failed: ${logReason(error)}`)
              updateStep('server', {
                state: 'failed',
                message: 'status.serverFailed',
                values: { reason: reason(error) },
                action: 'checkServer',
              })
            }
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
        recognized.set(request.session, { seconds: 0, start: 0, text: '' })
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
        let signal: AbortSignal | undefined
        try {
          known(request)
          return await recordings.append(request, async (recording) => {
            signal = recording.signal
            if (!local()) return null
            const preview = recognized.get(request.session)!
            if (recording.seconds - preview.seconds < 1) return null
            const audio = recording.wav()
            let pcm = audio.subarray(44 + Math.round(preview.start * 16000) * 2)
            while (pcm.byteLength > 20 * 32000) {
              const window = pcm.subarray(0, 30 * 32000 + request.audio.byteLength)
              const pause = findSpeechPause(window, 5)
              const cut =
                pause ?? (window.byteLength >= 30 * 32000 ? window.byteLength / 32000 : null)
              if (cut === null) break
              const speech = detectSpeech(pcm.subarray(0, Math.round(cut * 16000) * 2))
              if (speech.hasSpeech && speech.span) {
                preview.seconds = recording.seconds
                const result = await recognize(recording, audio, {
                  start: preview.start + speech.span.start,
                  end: preview.start + speech.span.end,
                })
                preview.text = joinTranscript(preview.text, result.text)
              }
              preview.start += cut
              pcm = audio.subarray(44 + Math.round(preview.start * 16000) * 2)
            }
            const speech = detectSpeech(pcm)
            if (!speech.hasSpeech || !speech.span)
              return preview.text ? { text: preview.text } : null
            preview.seconds = recording.seconds
            const result = await recognize(recording, audio, {
              start: preview.start + speech.span.start,
              end: preview.start + speech.span.end,
            })
            return { text: joinTranscript(preview.text, result.text) }
          })
        } catch (error) {
          if (!signal?.aborted) log('warning', `Dictation preview failed: ${logReason(error)}`)
          throw error
        }
      }
      const request = message.params as DictationSession
      let signal: AbortSignal | undefined
      try {
        if (!ready) {
          recordings.cancel(request)
          throw new PluginError({ message: 'error.notReady' })
        }
        known(request)
        return await recordings.finish(request, async (recording) => {
          signal = recording.signal
          const audio = recording.wav()
          const speech = detectSpeech(audio.subarray(44))
          if (!speech.hasSpeech || !speech.span) {
            log(
              'info',
              `Dictation finished: ${recording.seconds.toFixed(2)} s audio, recognition 0.00 s, polish skipped`,
            )
            return { text: '' }
          }
          const started = performance.now()
          const raw = await recognize(recording, audio, speech.span, true)
          const recognitionSeconds = (performance.now() - started) / 1000
          const polished = await tidy(recording, raw.text)
          const result = {
            text: applyVocabulary(polished.text, memory.vocabulary(recording.vocabulary)),
          }
          if (result.text && !recording.signal.aborted) {
            if (settings.keepHistory !== false) history.record(result.text, recording.seconds)
            if (settings.learnTerms !== false) memory.record(result.text, recording.vocabulary)
            stats.record(result.text, recording.seconds)
          }
          if (!recording.signal.aborted)
            log(
              'info',
              `Dictation finished: ${recording.seconds.toFixed(2)} s audio, recognition ${recognitionSeconds.toFixed(2)} s, polish ${polished.ran ? 'ran' : 'skipped'}`,
            )
          return result
        })
      } catch (error) {
        if (!signal?.aborted) log('error', `Dictation finish failed: ${logReason(error)}`)
        throw error
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
