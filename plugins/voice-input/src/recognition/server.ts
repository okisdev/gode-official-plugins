import type { PluginContext } from '@gode/plugin-sdk/plugin'
import type { Names } from '../names'
import type { createVoiceStatus } from '../status'
import { apiURL, logReason, readResponse, reason } from './transcription-logic'

export function createServerCheck({
  text,
  apiKey,
  status,
  log,
}: {
  text: (key: Names['settings'], fallback?: string) => string
  apiKey: () => string | undefined
  status: ReturnType<typeof createVoiceStatus>
  log: PluginContext<Names>['log']
}) {
  let check: AbortController | undefined
  const { refresh, updateStep } = status
  return {
    async run() {
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
              headers: apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {},
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
    },
    cancel() {
      check?.abort()
    },
  }
}
