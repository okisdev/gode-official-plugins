import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginContext } from '@gode/plugin-sdk/plugin'
import type { Names } from '../names'
import { formatBytes, logReason, reason } from '../recognition/transcription-logic'
import type { createVoiceStatus } from '../status'
import { clearPartials, downloadModels, type ModelSet } from './download'
import type { LocalEngine } from './engine'

export type DownloadStep = 'model' | 'polish'

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
  const downloads = new Map<
    DownloadStep,
    { controller: AbortController; task: Promise<void>; model: ModelSet }
  >()
  async function stopDownload(step?: DownloadStep): Promise<void> {
    const stopped = [...downloads].filter(([id]) => !step || id === step).map(([, item]) => item)
    for (const download of stopped) download.controller.abort()
    await Promise.all(stopped.map((download) => download.task))
  }

  async function action(action: Names['actions'] | Names['itemActions']): Promise<void> {
    if (action === 'stopDownload' || action === 'stopPolishDownload') {
      await stopDownload(action === 'stopDownload' ? 'model' : 'polish')
      await status.refresh()
    } else if (action === 'removeModel') {
      await stopDownload('model')
      await engine().stop()
      await Promise.all(
        selected().files.map((file) => rm(join(directory(), file.file), { force: true })),
      )
      await status.refresh()
    } else if (action === 'removePolishModel' && !polishService()) {
      const polish = selectedPolish()
      if (downloads.get('polish')?.model === polish) await stopDownload('polish')
      await polishEngine().stop()
      await Promise.all(
        polish.files.map((file) => rm(join(directory(), file.file), { force: true })),
      )
      await status.refresh()
    } else if (
      ((action === 'downloadModel' && local()) ||
        (action === 'downloadPolishModel' && !polishService())) &&
      !downloads.has(action === 'downloadModel' ? 'model' : 'polish')
    ) {
      const target = action === 'downloadModel' ? selected() : selectedPolish()
      const isPolish = action === 'downloadPolishModel'
      const step: DownloadStep = isPolish ? 'polish' : 'model'
      const stop = isPolish ? 'stopPolishDownload' : 'stopDownload'
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
      status.updateStep(step, {
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
        action: stop,
      })
      const task = (async () => {
        try {
          await downloadModels(directory(), target.files, controller.signal, (done, bytes) => {
            if (done !== 0 && done !== bytes && Date.now() - lastProgress < 100) return
            lastProgress = Date.now()
            status.updateStep(step, {
              state: 'working',
              message: isPolish ? 'status.polishDownloading' : 'status.downloading',
              progress: done / bytes,
              values: { done: formatBytes(done, locale()), total: formatBytes(bytes, locale()) },
              action: stop,
            })
          })
          log('info', `Model download finished: ${files}`)
          downloads.delete(step)
          if (!controller.signal.aborted) await status.refresh()
        } catch (error) {
          if (controller.signal.aborted) log('info', `Model download stopped: ${files}`)
          else {
            log('error', `Model download failed: ${files}: ${logReason(error)}`)
            status.updateStep(step, {
              state: 'failed',
              message: isPolish ? 'status.polishDownloadFailed' : 'status.downloadFailed',
              values: { reason: reason(error) },
              progress: undefined,
              action: isPolish ? 'downloadPolishModel' : 'downloadModel',
            })
          }
        } finally {
          downloads.delete(step)
        }
      })()
      downloads.set(step, { controller, task, model: target })
    }
  }

  return {
    downloading: (step: DownloadStep): ModelSet | undefined => downloads.get(step)?.model,
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
