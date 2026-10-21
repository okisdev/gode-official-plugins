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
  polish,
  selected,
  local,
  engine,
  polishEngine,
  status,
  log,
}: {
  directory: () => string
  locale: () => string
  models: readonly ModelSet[]
  polish: ModelSet
  selected: () => ModelSet
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
    } else if (action === 'removePolishModel') {
      if (download?.model.id === polish.id) await stopDownload()
      await polishEngine().stop()
      await Promise.all(
        polish.files.map((file) => rm(join(directory(), file.file), { force: true })),
      )
      await status.refresh()
    } else if (
      ((action === 'downloadModel' && local()) || action === 'downloadPolishModel') &&
      !download
    ) {
      const target = action === 'downloadModel' ? selected() : polish
      if (target !== polish) {
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
      if (target !== polish && status.current)
        status.status({ ...status.current, state: 'setup', message: 'status.setup' })
      status.updateStep(target === polish ? 'polish' : 'model', {
        state: 'working',
        message: target === polish ? 'status.polishDownloading' : 'status.downloading',
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
            status.updateStep(target === polish ? 'polish' : 'model', {
              state: 'working',
              message: target === polish ? 'status.polishDownloading' : 'status.downloading',
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
            status.updateStep(target === polish ? 'polish' : 'model', {
              state: 'failed',
              message: target === polish ? 'status.polishDownloadFailed' : 'status.downloadFailed',
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
        [...models, polish].flatMap((model) => [...model.files]),
      )
    },
    stopDownload,
    action,
  }
}
