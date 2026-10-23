import type { PluginContext } from '@gode/plugin-sdk/plugin'
import type { Names } from '../names'
import type { createVoiceStatus } from '../status'
import { apiURL, logReason, readResponse, reason } from './transcription-logic'

export function createServerCheck({
  kind,
  base,
  apiKey,
  status,
  log,
}: {
  kind: 'speech' | 'polish'
  base: () => string
  apiKey: () => string | undefined
  status: ReturnType<typeof createVoiceStatus>
  log: PluginContext<Names>['log']
}) {
  let check: AbortController | undefined
  const { refresh, updateStep } = status
  const step = kind === 'speech' ? 'server' : 'polish'
  const action = kind === 'speech' ? 'checkServer' : 'checkPolishService'
  const label = kind === 'speech' ? 'Server' : 'Polish service'
  return {
    async run() {
      check?.abort()
      if (!base()) {
        log('warning', `${label} check failed: No server address`)
        return refresh()
      }
      const controller = new AbortController()
      check = controller
      updateStep(step, { state: 'working', message: 'status.checking', action: undefined })
      void (async () => {
        try {
          await readResponse(
            await fetch(apiURL(base(), 'models'), {
              headers: apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {},
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
            }),
          )
          if (!controller.signal.aborted) {
            log('info', `${label} check succeeded`)
            await refresh()
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            log('error', `${label} check failed: ${logReason(error)}`)
            updateStep(step, {
              state: 'failed',
              message: 'status.serverFailed',
              values: { reason: reason(error) },
              action,
            })
          }
        }
      })()
    },
    cancel() {
      check?.abort()
    },
  }
}
