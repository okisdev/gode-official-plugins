import type { DictationRecording, PluginContext } from '@gode/plugin-sdk/plugin'
import type { VoiceMemory } from '../data/memory'
import type { LocalEngine } from '../models/engine'
import type { Names } from '../names'
import { polishedText, polishMessages } from './polish-logic'
import { apiURL, logReason, readResponse } from './transcription-logic'

/** What became of one transcript: the model's edit was typed, refused for reading as no edit of it, failed to
 * come back, or never asked for. */
export type PolishOutcome = 'kept' | 'refused' | 'failed' | 'skipped'

/** The person's own service that takes OpenAI-style chat requests. */
export type PolishService = { base: string; apiKey?: string; model: string }

export function createPolish({
  polishOn,
  service,
  polishPresent,
  engine,
  vocabulary,
  log,
}: {
  polishOn: () => boolean
  /** The service to ask, `undefined` for the local model, or null while the chosen service lacks an address or a
   * model. */
  service: () => PolishService | null | undefined
  polishPresent: () => Promise<boolean>
  engine: () => LocalEngine
  vocabulary: VoiceMemory['vocabulary']
  log: PluginContext<Names>['log']
}) {
  return async function tidy(
    recording: DictationRecording,
    text: string,
  ): Promise<{ text: string; outcome: PolishOutcome }> {
    if (!text || !polishOn()) return { text, outcome: 'skipped' }
    const remote = service()
    try {
      if (remote === null || (!remote && !(await polishPresent())))
        return { text, outcome: 'skipped' }
      const ask = async (base: string, apiKey: string | undefined, model?: string) => {
        const response = await fetch(apiURL(base, 'chat/completions'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            ...(model ? { model } : { chat_template_kwargs: { enable_thinking: false } }),
            messages: polishMessages(text, vocabulary(recording.vocabulary)),
            temperature: 0,
            max_tokens: Math.min(4096, 2 * text.length + 64),
          }),
          signal: AbortSignal.any([
            recording.signal,
            AbortSignal.timeout(10_000 + 20 * text.length),
          ]),
        })
        return (await readResponse(response)) as {
          choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]
        } | null
      }
      const value = remote
        ? await ask(remote.base, remote.apiKey, remote.model)
        : await engine().use((base, apiKey) => ask(base, apiKey))
      const choice = value?.choices?.[0]
      const reply = choice?.message?.content
      const polished =
        typeof reply === 'string' && choice?.finish_reason !== 'length'
          ? polishedText(text, reply)
          : null
      return polished === null ? { text, outcome: 'refused' } : { text: polished, outcome: 'kept' }
    } catch (error) {
      if (!recording.signal.aborted) log('warning', `Dictation polish failed: ${logReason(error)}`)
      return { text, outcome: recording.signal.aborted ? 'skipped' : 'failed' }
    }
  }
}
