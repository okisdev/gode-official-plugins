import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginContext } from '@gode/plugin-sdk/plugin'
import type { Names } from '../names'
import { formatBytes, logReason, reason } from '../recognition/transcription-logic'
import type { createVoiceStatus } from '../status'
import { clearPartials, downloadModels, type ModelSet } from './download'
import type { LocalEngine } from './engine'

export function createModelActions({
  directory,
  locale,
  models,
  polishModels,
  selected,
  selectedPolish,
  polishService,
  local,
  engine,
  polishEngine,
  status,
  log,
}: {
  directory: () => string
  locale: () => string
  models: readonly ModelSet[]
  polishModels: readonly ModelSet[]
  selected: () => ModelSet
  selectedPolish: () => ModelSet
  polishService: () => boolean
  local: () => boolean
  engine: () => LocalEngine
  polishEngine: () => LocalEngine
  status: ReturnType<typeof createVoiceStatus>
  log: PluginContext<Names>['log']
}) {
  let download: { controller: AbortController; task: Promise<void>; model: ModelSet } | undefined
  async function stopDownload(): Promise<void> {
    download?.controller.abort()
    await download?.task
  }

  async function action(action: Names['actions'] | Names['itemActions']): Promise<void> {
    if (action === 'stopDownload') {
      await stopDownload()
      await status.refresh()
    } else if (action === 'removeModel') {
      await stopDownload()
      await engine().stop()
      await Promise.all(
        selected().files.map((file) => rm(join(directory(), file.file), { force: true })),
      )
      await status.refresh()
    } else if (action === 'removePolishModel' && !polishService()) {
      const polish = selectedPolish()
      if (download?.model === polish) await stopDownload()
      await polishEngine().stop()
      await Promise.all(
        polish.files.map((file) => rm(join(directory(), file.file), { force: true })),
      )
      await status.refresh()
    } else if (
      ((action === 'downloadModel' && local()) ||
        (action === 'downloadPolishModel' && !polishService())) &&
      !download
    ) {
      const target = action === 'downloadModel' ? selected() : selectedPolish()
      const isPolish = action === 'downloadPolishModel'
      if (!isPolish) {
        status.ready = false
        await engine().stop()
      } else await polishEngine().stop()
      const controller = new AbortController()
      const files = target.files.map((file) => file.file).join(', ')
      log(
        'info',
        `Model download started: ${files} (${target.files.reduce((sum, file) => sum + file.size, 0)} bytes)`,
      )
      let lastProgress = 0
      if (!isPolish && status.current)
        status.status({ ...status.current, state: 'setup', message: 'status.setup' })
      status.updateStep(isPolish ? 'polish' : 'model', {
        state: 'working',
        message: isPolish ? 'status.polishDownloading' : 'status.downloading',
        values: {
          done: formatBytes(0, locale()),
          total: formatBytes(
            target.files.reduce((sum, file) => sum + file.size, 0),
            locale(),
          ),
        },
        progress: 0,
        action: 'stopDownload',
      })
      const task = (async () => {
        try {
          await downloadModels(directory(), target.files, controller.signal, (done, bytes) => {
            if (done !== 0 && done !== bytes && Date.now() - lastProgress < 100) return
            lastProgress = Date.now()
            status.updateStep(isPolish ? 'polish' : 'model', {
              state: 'working',
              message: isPolish ? 'status.polishDownloading' : 'status.downloading',
              progress: done / bytes,
              values: { done: formatBytes(done, locale()), total: formatBytes(bytes, locale()) },
              action: 'stopDownload',
            })
          })
          log('info', `Model download finished: ${files}`)
          if (!controller.signal.aborted) await status.refresh(false)
        } catch (error) {
          if (controller.signal.aborted) log('info', `Model download stopped: ${files}`)
          else {
            log('error', `Model download failed: ${files}: ${logReason(error)}`)
            status.updateStep(isPolish ? 'polish' : 'model', {
              state: 'failed',
              message: isPolish ? 'status.polishDownloadFailed' : 'status.downloadFailed',
              values: { reason: reason(error) },
              progress: undefined,
              action: isPolish ? 'downloadPolishModel' : 'downloadModel',
            })
          }
        } finally {
          download = undefined
        }
      })()
      download = { controller, task, model: target }
    }
  }

  return {
    get downloading() {
      return download?.model
    },
    async initialize() {
      await mkdir(directory(), { recursive: true })
      await clearPartials(
        directory(),
        [...models, ...polishModels].flatMap((model) => [...model.files]),
      )
    },
    stopDownload,
    action,
  }
}
