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
import { createServerCheck } from './recognition/server'
import { reason } from './recognition/transcription-logic'
import { createVoiceStatus } from './status'

export function createVoicePlugin(
  { setStatus, setView, log, synced }: PluginContext<Names>,
  models: readonly ModelSet[] = resources.models,
  polish: ModelSet = resources.polish,
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
  const vocabulary: VoiceMemory['vocabulary'] = (request, limit) =>
    memory.vocabulary(request, limit)
  const status = createVoiceStatus({
    setStatus,
    directory: () => directory,
    locale: () => locale,
    local,
    text,
    selected,
    polish,
    polishOn,
    polishPresent,
    downloading: () => modelActions.downloading,
  })
  const modelActions = createModelActions({
    directory: () => directory,
    locale: () => locale,
    models,
    polish,
    selected,
    local,
    engine: () => engine,
    polishEngine: () => polishEngine,
    status,
    log,
  })
  const server = createServerCheck({ text, apiKey: () => secrets.apiKey, status, log })
  const recognize = createRecognition({
    local,
    text,
    selected,
    apiKey: () => secrets.apiKey,
    removeFillers: () => settings.removeFillers !== false,
    vocabulary,
    engine: () => engine,
  })
  const tidy = createPolish({
    polishOn,
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
      polishEngine = new LocalEngine({
        name: 'polish',
        log,
        executable,
        model: join(directory, polish.files[0]!.file),
      })
      await status.refresh()
    },
    async settings(message) {
      server.cancel()
      const wasLocal = local()
      const wasPolish = polishOn()
      const previousModel = selected().id
      settings = message.settings
      secrets = message.secrets
      const modelChanged = previousModel !== selected().id
      if ((wasLocal && !local()) || modelChanged) {
        status.ready = false
        await modelActions.stopDownload()
        await engine.stop()
      }
      if (modelChanged) engine = createEngine()
      if (wasPolish && !polishOn()) {
        if (modelActions.downloading === polish) await modelActions.stopDownload()
        await polishEngine.stop()
      }
      await status.refresh()
    },
    async action(action, item, text) {
      if (action === 'deleteEntry' && item) {
        history.delete(item)
      } else if (action === 'clearHistory') {
        history.clear()
      } else if (action === 'forgetTerm' && item) {
        memory.forget(item)
      } else if (action === 'addTerm' && text !== undefined) {
        memory.add(text)
      } else if (action === 'clearMemory') {
        memory.clear()
      } else if (action === 'checkServer' && !local()) {
        await server.run()
      } else {
        await modelActions.action(action)
      }
    },
    query({ view, search, cursor, limit }) {
      if (view === 'history') return history.query(search, cursor, limit)
      if (view === 'memory') return memory.query(search, cursor, limit)
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
      dictation.dispose()
      await Promise.all([stats?.dispose(), history?.dispose(), memory?.dispose()])
      await modelActions.stopDownload()
      await engine?.stop()
      await polishEngine?.stop()
    },
  }
}
