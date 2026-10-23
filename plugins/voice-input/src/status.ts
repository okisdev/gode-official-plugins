import type { PluginStep, PluginStatus } from '@gode/plugin-sdk'
import type { PluginContext } from '@gode/plugin-sdk/plugin'
import { modelsPresent, type ModelSet } from './models/download'
import type { Names } from './names'
import { apiURL, formatBytes, reason } from './recognition/transcription-logic'

export function createVoiceStatus({
  setStatus,
  directory,
  locale,
  local,
  text,
  selected,
  selectedPolish,
  polishService,
  polishOn,
  polishPresent,
  downloading,
}: {
  setStatus: PluginContext<Names>['setStatus']
  directory: () => string
  locale: () => string
  local: () => boolean
  text: (key: Names['settings'], fallback?: string) => string
  selected: () => ModelSet
  selectedPolish: () => ModelSet
  polishService: () => boolean
  polishOn: () => boolean
  polishPresent: () => Promise<boolean>
  downloading: () => ModelSet | undefined
}) {
  let ready = false
  let disposed = false
  let currentStatus: PluginStatus<Names> | undefined
  const status = (value: PluginStatus<Names>): void => {
    if (!disposed) {
      currentStatus = value
      setStatus(value)
    }
  }
  const updateStep = (id: string, step: Partial<PluginStep<Names>>): void => {
    if (!currentStatus) return
    status({
      ...currentStatus,
      steps: currentStatus.steps?.map((item) => (item.id === id ? { ...item, ...step } : item)),
    })
  }
  async function refresh(preserveDownload = true): Promise<void> {
    const steps: PluginStep<Names>[] = []
    let next: PluginStatus<Names>
    if (local()) {
      const model = selected()
      const files = model.files
      ready = await modelsPresent(directory(), files)
      next = {
        state: ready ? 'ready' : 'setup',
        message: ready ? 'status.localReady' : 'status.setup',
      }
      const size = formatBytes(
        files.reduce((sum, file) => sum + file.size, 0),
        locale(),
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
      if (polishService()) {
        const fields = [
          'polish',
          'polishModel',
          'polishServerURL',
          'polishApiKey',
          'polishServerModel',
        ] as const
        const base = text('polishServerURL').trim()
        const model = text('polishServerModel').trim()
        if (!base || !model) {
          steps.push({
            id: 'polish',
            title: 'step.polish',
            state: 'todo',
            message: 'step.polishServiceTodo',
            optional: true,
            fields: [...fields],
          })
        } else {
          try {
            const host = new URL(apiURL(base, 'models')).host
            steps.push({
              id: 'polish',
              title: 'step.polish',
              state: 'done',
              message: 'step.polishServiceDone',
              values: { host },
              optional: true,
              fields: [...fields],
              action: 'checkPolishService',
            })
          } catch (error) {
            steps.push({
              id: 'polish',
              title: 'step.polish',
              state: 'failed',
              message: 'status.serverFailed',
              values: { reason: reason(error) },
              optional: true,
              fields: [...fields],
              action: 'checkPolishService',
            })
          }
        }
      } else {
        const polish = selectedPolish()
        const present = await polishPresent()
        steps.push({
          id: 'polish',
          title: 'step.polish',
          message: present ? 'step.polishDone' : 'step.polishTodo',
          values: {
            model: polish.id === 'qwen3.5-4b' ? 'Qwen3.5 4B' : 'Qwen3.5 2B',
            size: formatBytes(
              polish.files.reduce((sum, file) => sum + file.size, 0),
              locale(),
            ),
          },
          state: present ? 'done' : 'todo',
          optional: true,
          fields: ['polish', 'polishModel'],
          action: present ? 'removePolishModel' : 'downloadPolishModel',
        })
      }
    }
    const download = downloading()
    if (preserveDownload && download) {
      const id = download === selectedPolish() ? 'polish' : 'model'
      const active = currentStatus?.steps?.find(
        (step) => step.id === id && step.state === 'working',
      )
      const index = steps.findIndex((step) => step.id === id)
      if (active && index !== -1) steps.splice(index, 1, active)
    }
    status({ ...next, steps, actions: [] })
  }

  return {
    get ready() {
      return ready
    },
    set ready(value: boolean) {
      ready = value
    },
    get current() {
      return currentStatus
    },
    status,
    updateStep,
    refresh,
    dispose() {
      disposed = true
      ready = false
    },
  }
}
