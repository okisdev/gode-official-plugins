import { join } from 'node:path'
import type { PluginSettingValue } from '@gode/plugin-sdk'
import type { PluginContext, PluginHandlers } from '@gode/plugin-sdk/plugin'
import resources from '../resources.json'
import { VoiceHistory } from './data/history'
import { VoiceMemory } from './data/memory'
import { VoiceStats } from './data/stats'
import { createModelActions } from './models/actions'
import { modelsPresent, type ModelSet } from './models/download'
import { LocalEngine } from './models/engine'
import type { Names } from './names'
import { createDictation } from './recognition/dictation'
import { createPolish } from './recognition/polish'
import { createRecognition } from './recognition/recognition'
import { createServerCheck, type SpeechServer } from './recognition/server'
import { reason } from './recognition/transcription-logic'
import { createVoiceStatus } from './status'

export function createVoicePlugin(
  {
    setStatus,
    setView,
    log,
    synced,
  }: Pick<PluginContext<Names>, 'setStatus' | 'setView' | 'log' | 'synced'>,
  models: readonly ModelSet[] = resources.models,
  polishModels: readonly ModelSet[] = resources.polishModels,
): Required<
  Pick<PluginHandlers<Names>, 'start' | 'settings' | 'action' | 'query' | 'call' | 'error'>
> & {
  dispose(): Promise<void>
  kill(): void
} {
  let settings: Readonly<Partial<Record<Names['settings'], PluginSettingValue>>> = {}
  let secrets: Readonly<Record<string, string>> = {}
  let locale = 'en'
  let directory = ''
  let executable = ''
  let engine: LocalEngine
  let polishEngine: LocalEngine
  let stats: VoiceStats
  let history: VoiceHistory
  let memory: VoiceMemory
  const text = (key: Names['settings'], fallback = ''): string =>
    typeof settings[key] === 'string' ? settings[key] : fallback
  const local = (): boolean => text('engine', 'local') === 'local'
  const speechServer = (): SpeechServer =>
    text('engine') === 'upload'
      ? {
          base: text('uploadURL').trim(),
          apiKey: secrets.uploadApiKey,
          prompt: false,
          maxSeconds: 110,
          set: Boolean(text('uploadURL').trim()),
          check: false,
          fields: ['engine', 'uploadURL', 'uploadApiKey'],
        }
      : text('engine') === 'chat'
        ? {
            base: text('chatURL').trim(),
            endpoint: 'chat/completions',
            apiKey: secrets.chatApiKey,
            model: text('chatModel').trim(),
            language: text('language', 'auto'),
            prompt: true,
            maxSeconds: 110,
            chat: true,
            set: Boolean(text('chatURL').trim() && text('chatModel').trim()),
            check: true,
            fields: ['engine', 'chatURL', 'chatApiKey', 'chatModel'],
          }
        : {
            base: text('serverURL').trim(),
            endpoint: 'audio/transcriptions',
            apiKey: secrets.apiKey,
            model: text('model', 'gpt-4o-transcribe'),
            language: text('language', 'auto'),
            prompt: true,
            set: Boolean(text('serverURL').trim()),
            check: true,
            fields: ['engine', 'serverURL', 'apiKey', 'model'],
          }
  const polishOn = (): boolean => settings.polish === true
  const polishService = (): boolean => text('polishModel') === 'server'
  const selected = (): ModelSet =>
    models.find((model) => model.id === text('localModel', 'qwen3-asr-1.7b')) ?? models[0]!
  const selectedPolish = (): ModelSet =>
    polishModels.find((model) => model.id === text('polishModel', 'qwen3.5-4b')) ?? polishModels[0]!
  const createEngine = (): LocalEngine => {
    const [model, projector] = selected().files
    return new LocalEngine({
      name: 'recognition',
      log,
      executable,
      model: join(directory, model!.file),
      projector: join(directory, projector!.file),
      idleMs: 60_000,
    })
  }
  const createPolishEngine = (): LocalEngine =>
    new LocalEngine({
      name: 'polish',
      log,
      executable,
      model: join(directory, selectedPolish().files[0]!.file),
      context: 8192,
      idleMs: 0,
    })
  const polishPresent = (): Promise<boolean> =>
    polishService() ? Promise.resolve(false) : modelsPresent(directory, selectedPolish().files)
  const vocabulary: VoiceMemory['vocabulary'] = (request, limit) =>
    memory.vocabulary(request, limit)
  const status = createVoiceStatus({
    setStatus,
    directory: () => directory,
    locale: () => locale,
    local,
    server: speechServer,
    text,
    selected,
    selectedPolish,
    polishService,
    polishOn,
    polishPresent,
    downloading: (step) => modelActions.downloading(step),
  })
  const modelActions = createModelActions({
    directory: () => directory,
    locale: () => locale,
    models,
    polishModels,
    selected,
    selectedPolish,
    polishService,
    local,
    engine: () => engine,
    polishEngine: () => polishEngine,
    status,
    log,
  })
  const server = createServerCheck({
    kind: 'speech',
    base: () => speechServer().base,
    apiKey: () => speechServer().apiKey,
    status,
    log,
  })
  const polishServer = createServerCheck({
    kind: 'polish',
    base: () => text('polishServerURL').trim(),
    apiKey: () => secrets.polishApiKey,
    status,
    log,
  })
  const recognize = createRecognition({
    local,
    server: speechServer,
    language: () => text('language', 'auto'),
    selected,
    removeFillers: () => settings.removeFillers !== false,
    vocabulary,
    engine: () => engine,
  })
  const tidy = createPolish({
    polishOn,
    service: () =>
      !polishService()
        ? undefined
        : text('polishServerURL').trim() && text('polishServerModel').trim()
          ? {
              base: text('polishServerURL').trim(),
              apiKey: secrets.polishApiKey,
              model: text('polishServerModel').trim(),
            }
          : null,
    polishPresent,
    engine: () => polishEngine,
    vocabulary,
    log,
  })
  const dictation = createDictation({
    ready: () => status.ready,
    local,
    polishOn,
    polishPresent,
    engine: () => engine,
    polishEngine: () => polishEngine,
    recognize,
    tidy,
    vocabulary,
    keepHistory: () => settings.keepHistory !== false,
    learnTerms: () => settings.learnTerms !== false,
    history: () => history,
    memory: () => memory,
    stats: () => stats,
    log,
  })
  return {
    async start(message) {
      settings = message.settings
      secrets = message.secrets
      locale = message.locale
      stats = new VoiceStats(message.paths.data, setView)
      await stats.read()
      history = new VoiceHistory(message.paths.data, locale, setView)
      memory = new VoiceMemory(message.paths.data, locale, setView, synced)
      await history.read()
      await memory.read()
      directory = join(message.paths.data, 'models')
      await modelActions.initialize()
      executable = join(message.paths.plugin, 'bin/llama-server')
      engine = createEngine()
      polishEngine = createPolishEngine()
      await status.refresh()
    },
    async settings(message) {
      server.cancel()
      polishServer.cancel()
      const wasLocal = local()
      const wasPolish = polishOn()
      const previousModel = selected().id
      const previousPolishModel = polishService() ? 'server' : selectedPolish().id
      settings = message.settings
      secrets = message.secrets
      const modelChanged = previousModel !== selected().id
      const polishChanged =
        previousPolishModel !== (polishService() ? 'server' : selectedPolish().id)
      if ((wasLocal && !local()) || modelChanged) {
        status.ready = false
        await modelActions.stopDownload('model')
        await engine.stop()
      }
      if (modelChanged) engine = createEngine()
      if ((wasPolish && !polishOn()) || polishChanged) {
        await modelActions.stopDownload('polish')
        await polishEngine.stop()
      }
      if (polishChanged) polishEngine = createPolishEngine()
      await status.refresh()
    },
    async action(action, item, text) {
      if (action === 'deleteEntry' && item) {
        history.delete(item)
      } else if (action === 'clearHistory') {
        history.clear()
      } else if (action === 'acceptSuggestion' && item) {
        memory.accept(item)
      } else if ((action === 'forgetTerm' || action === 'ignoreSuggestion') && item) {
        memory.forget(item)
      } else if (action === 'addTerm' && text !== undefined) {
        memory.add(text)
      } else if (action === 'clearMemory') {
        memory.clear()
      } else if (action === 'checkServer' && !local() && speechServer().check) {
        await server.run()
      } else if (action === 'checkPolishService' && polishService()) {
        await polishServer.run()
      } else {
        await modelActions.action(action)
      }
    },
    query({ view, search, cursor, limit }) {
      if (view === 'history') return history.query(search, cursor, limit)
      if (view === 'memory' || view === 'suggestions')
        return memory.query(view, search, cursor, limit)
      throw new Error(`Unknown view: ${view}`)
    },
    call: dictation.call,
    error: (error) => ({ message: 'error.engine', values: { reason: reason(error) } }),
    kill: () => {
      engine?.kill()
      polishEngine?.kill()
    },
    async dispose() {
      status.dispose()
      server.cancel()
      polishServer.cancel()
      dictation.dispose()
      await Promise.all([stats?.dispose(), history?.dispose(), memory?.dispose()])
      await modelActions.stopDownload()
      await engine?.stop()
      await polishEngine?.stop()
    },
  }
}
