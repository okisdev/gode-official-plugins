import type { DictationAudio, DictationSession, DictationStart } from '@gode/plugin-sdk'
import {
  DictationRecordings,
  PluginError,
  type PluginContext,
  type PluginHandlers,
} from '@gode/plugin-sdk/plugin'
import type { VoiceHistory } from '../data/history'
import type { VoiceMemory } from '../data/memory'
import type { VoiceStats } from '../data/stats'
import type { LocalEngine } from '../models/engine'
import type { Names } from '../names'
import type { createPolish } from './polish'
import type { createRecognition } from './recognition'
import { detectSpeech, findSpeechPause } from './speech-logic'
import { applyVocabulary, joinTranscript, logReason } from './transcription-logic'

export function createDictation({
  ready,
  local,
  polishOn,
  polishPresent,
  engine,
  polishEngine,
  recognize,
  tidy,
  vocabulary,
  keepHistory,
  learnTerms,
  history,
  memory,
  stats,
  log,
}: {
  ready: () => boolean
  local: () => boolean
  polishOn: () => boolean
  polishPresent: () => Promise<boolean>
  engine: () => LocalEngine
  polishEngine: () => LocalEngine
  recognize: ReturnType<typeof createRecognition>
  tidy: ReturnType<typeof createPolish>
  vocabulary: VoiceMemory['vocabulary']
  keepHistory: () => boolean
  learnTerms: () => boolean
  history: () => VoiceHistory
  memory: () => VoiceMemory
  stats: () => VoiceStats
  log: PluginContext<Names>['log']
}) {
  const recordings = new DictationRecordings()
  const recognized = new Map<string, { seconds: number; start: number; text: string }>()
  function known(request: DictationSession): void {
    if (!recognized.has(request.session)) throw new PluginError({ message: 'error.session' })
  }

  const call: NonNullable<PluginHandlers<Names>['call']> = async (message) => {
    if (message.method === 'dictation.cancel') {
      const request = message.params as DictationSession
      recordings.cancel(request)
      recognized.delete(request.session)
      return null
    }
    if (message.method === 'dictation.start') {
      if (!ready()) return null
      const request = message.params as DictationStart
      recordings.start(request)
      recognized.set(request.session, { seconds: 0, start: 0, text: '' })
      if (local())
        void engine()
          .use(async () => null)
          .catch(() => {})
      if (polishOn())
        void polishPresent()
          .then((present) => {
            if (present && recognized.has(request.session))
              void polishEngine()
                .use(async () => null)
                .catch(() => {})
          })
          .catch(() => {})
      return null
    }
    if (message.method === 'dictation.append') {
      if (!ready()) return null
      const request = message.params as DictationAudio
      let signal: AbortSignal | undefined
      try {
        known(request)
        return await recordings.append(request, async (recording) => {
          signal = recording.signal
          if (!local()) return null
          const preview = recognized.get(request.session)!
          if (recording.seconds - preview.seconds < 1) return null
          const audio = recording.wav()
          let pcm = audio.subarray(44 + Math.round(preview.start * 16000) * 2)
          while (pcm.byteLength > 20 * 32000) {
            const window = pcm.subarray(0, 30 * 32000 + request.audio.byteLength)
            const pause = findSpeechPause(window, 5)
            const cut =
              pause ?? (window.byteLength >= 30 * 32000 ? window.byteLength / 32000 : null)
            if (cut === null) break
            const speech = detectSpeech(pcm.subarray(0, Math.round(cut * 16000) * 2))
            if (speech.hasSpeech && speech.span) {
              preview.seconds = recording.seconds
              const result = await recognize(recording, audio, {
                start: preview.start + speech.span.start,
                end: preview.start + speech.span.end,
              })
              preview.text = joinTranscript(preview.text, result.text)
            }
            preview.start += cut
            pcm = audio.subarray(44 + Math.round(preview.start * 16000) * 2)
          }
          const speech = detectSpeech(pcm)
          if (!speech.hasSpeech || !speech.span) return preview.text ? { text: preview.text } : null
          preview.seconds = recording.seconds
          const result = await recognize(recording, audio, {
            start: preview.start + speech.span.start,
            end: preview.start + speech.span.end,
          })
          return { text: joinTranscript(preview.text, result.text) }
        })
      } catch (error) {
        if (!signal?.aborted) log('warning', `Dictation preview failed: ${logReason(error)}`)
        throw error
      }
    }
    const request = message.params as DictationSession
    let signal: AbortSignal | undefined
    try {
      if (!ready()) {
        recordings.cancel(request)
        throw new PluginError({ message: 'error.notReady' })
      }
      known(request)
      return await recordings.finish(request, async (recording) => {
        signal = recording.signal
        const audio = recording.wav()
        const speech = detectSpeech(audio.subarray(44))
        if (!speech.hasSpeech || !speech.span) {
          log(
            'info',
            `Dictation finished: ${recording.seconds.toFixed(2)} s audio, recognition 0.00 s, polish skipped`,
          )
          return { text: '' }
        }
        const started = performance.now()
        const raw = await recognize(recording, audio, speech.span, true)
        const recognitionSeconds = (performance.now() - started) / 1000
        const polished = await tidy(recording, raw.text)
        const result = {
          text: applyVocabulary(polished.text, vocabulary(recording.vocabulary)),
        }
        if (result.text && !recording.signal.aborted) {
          if (keepHistory()) history().record(result.text, recording.seconds)
          if (learnTerms()) memory().record(result.text, recording.vocabulary)
          stats().record(result.text, recording.seconds)
        }
        if (!recording.signal.aborted)
          log(
            'info',
            `Dictation finished: ${recording.seconds.toFixed(2)} s audio, recognition ${recognitionSeconds.toFixed(2)} s, polish ${polished.ran ? 'ran' : 'skipped'}`,
          )
        return result
      })
    } catch (error) {
      if (!signal?.aborted) log('error', `Dictation finish failed: ${logReason(error)}`)
      throw error
    } finally {
      recognized.delete(request.session)
    }
  }

  return {
    call,
    dispose() {
      for (const session of recognized.keys()) recordings.cancel({ session })
      recognized.clear()
    },
  }
}
