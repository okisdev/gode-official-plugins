import type { DictationRecording, PluginContext } from '@gode/plugin-sdk/plugin'
import type { VoiceMemory } from '../data/memory'
import type { LocalEngine } from '../models/engine'
import type { Names } from '../names'
import { polishedText, polishMessages } from './polish-logic'
import { logReason, readResponse } from './transcription-logic'

export function createPolish({
  polishOn,
  polishPresent,
  engine,
  vocabulary,
  log,
}: {
  polishOn: () => boolean
  polishPresent: () => Promise<boolean>
  engine: () => LocalEngine
  vocabulary: VoiceMemory['vocabulary']
  log: PluginContext<Names>['log']
}) {
  return async function tidy(
    recording: DictationRecording,
    text: string,
  ): Promise<{ text: string; ran: boolean }> {
    if (!text || !polishOn()) return { text, ran: false }
    let ran = false
    try {
      if (!(await polishPresent())) return { text, ran }
      return await engine().use(async (base, apiKey) => {
        ran = true
        const response = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            messages: polishMessages(text, vocabulary(recording.vocabulary)),
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
}
