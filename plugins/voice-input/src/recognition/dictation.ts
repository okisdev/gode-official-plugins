import type {
  DictationAudio,
  DictationSession,
  DictationStart,
  DictationVocabulary,
} from '@gode/plugin-sdk'
import {
  DictationRecordings,
  PluginError,
  type DictationRecording,
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
import { detectSpeech, segmentCut, sentencePause, speechPauses } from './speech-logic'
import { continuedText, joinTranscript, logReason } from './transcription-logic'
import { applyVocabulary } from './vocabulary-logic'

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
  type Session = {
    abort: AbortController
    start: number
    seconds: number
    text: string
    raw: string
    segments: number
    committing: Promise<void>
  }
  const sessions = new Map<string, Session>()
  function known(request: DictationSession): Session {
    const session = sessions.get(request.session)
    if (!session) throw new PluginError({ message: 'error.session' })
    return session
  }
  function drop(request: DictationSession, expected?: Session): void {
    if (expected && sessions.get(request.session) !== expected) return
    sessions.get(request.session)?.abort.abort()
    sessions.delete(request.session)
  }

  function hold(session: Session, selected: LocalEngine): void {
    void selected
      .use(
        () =>
          new Promise<void>((resolve) => {
            if (session.abort.signal.aborted) return resolve()
            session.abort.signal.addEventListener('abort', () => resolve(), { once: true })
          }),
      )
      .catch(() => {})
  }

  async function commit(session: Session, recording: DictationRecording): Promise<void> {
    const kept = { ...recording, signal: session.abort.signal }
    const audio = recording.wav()
    let pcm = audio.subarray(44 + Math.round(session.start * 16000) * 2)
    while (pcm.byteLength > 15 * 32000) {
      const window = pcm.subarray(0, 30 * 32000)
      const cut = segmentCut(speechPauses(window), window.byteLength / 32000)
      if (!cut) return
      const speech = detectSpeech(pcm.subarray(0, Math.round(cut.at * 16000) * 2))
      if (speech.hasSpeech && speech.span) {
        const result = await recognize(
          kept,
          audio,
          {
            start: session.start + speech.span.start,
            end: session.start + speech.span.end,
          },
          true,
        )
        const text = cut.pause < sentencePause ? continuedText(result.text) : result.text
        session.raw = joinTranscript(session.raw, text)
        session.text = joinTranscript(
          session.text,
          applyVocabulary(text, vocabulary(recording.vocabulary)),
        )
        session.segments++
        session.seconds = recording.seconds
      }
      session.start += cut.at
      pcm = audio.subarray(44 + Math.round(session.start * 16000) * 2)
    }
  }

  const call: NonNullable<PluginHandlers<Names>['call']> = async (message) => {
    if (
      !['dictation.start', 'dictation.append', 'dictation.finish', 'dictation.cancel'].includes(
        message.method,
      )
    ) {
      if (message.method !== 'dictation.adoptVocabulary')
        throw new Error(`Unknown method: ${message.method}`)
      const request = message.params as DictationVocabulary
      for (const word of request.vocabulary) memory().add(word)
      return null
    }
    if (message.method === 'dictation.cancel') {
      const request = message.params as DictationSession
      recordings.cancel(request)
      drop(request)
      return null
    }
    if (message.method === 'dictation.start') {
      if (!ready()) return null
      const request = message.params as DictationStart
      recordings.start(request)
      drop(request)
      const session: Session = {
        abort: new AbortController(),
        start: 0,
        seconds: 0,
        text: '',
        raw: '',
        segments: 0,
        committing: Promise.resolve(),
      }
      sessions.set(request.session, session)
      if (local()) hold(session, engine())
      if (polishOn())
        void polishPresent()
          .then((present) => {
            if (present && sessions.get(request.session) === session) hold(session, polishEngine())
          })
          .catch(() => {})
      return null
    }
    if (message.method === 'dictation.append') {
      if (!ready()) return null
      const request = message.params as DictationAudio
      let signal: AbortSignal | undefined
      try {
        const session = known(request)
        return await recordings.append(request, async (recording) => {
          signal = recording.signal
          if (!local() || recording.seconds - session.seconds < 1) return null
          session.committing = session.committing
            .then(() => commit(session, recording))
            .catch((error) => {
              if (!session.abort.signal.aborted)
                log('warning', `Dictation segment failed: ${logReason(error)}`)
            })
          await session.committing
          const audio = recording.wav()
          const speech = detectSpeech(audio.subarray(44 + Math.round(session.start * 16000) * 2))
          if (!speech.hasSpeech || !speech.span) return session.text ? { text: session.text } : null
          session.seconds = recording.seconds
          const result = await recognize(recording, audio, {
            start: session.start + speech.span.start,
            end: session.start + speech.span.end,
          })
          return { text: joinTranscript(session.text, result.text) }
        })
      } catch (error) {
        if (!signal?.aborted) log('warning', `Dictation preview failed: ${logReason(error)}`)
        throw error
      }
    }
    const request = message.params as DictationSession
    let signal: AbortSignal | undefined
    let session: Session | undefined
    try {
      if (!ready()) {
        recordings.cancel(request)
        throw new PluginError({ message: 'error.notReady' })
      }
      const current = known(request)
      session = current
      return await recordings.finish(request, async (recording) => {
        signal = recording.signal
        await current.committing
        const audio = recording.wav()
        const speech = detectSpeech(audio.subarray(44 + Math.round(current.start * 16000) * 2))
        const started = performance.now()
        const tail =
          speech.hasSpeech && speech.span
            ? (
                await recognize(
                  recording,
                  audio,
                  {
                    start: current.start + speech.span.start,
                    end: current.start + speech.span.end,
                  },
                  true,
                )
              ).text
            : ''
        const recognitionSeconds = (performance.now() - started) / 1000
        const polished = await tidy(recording, joinTranscript(current.raw, tail))
        const text = polished.text
        if (!text) {
          log(
            'info',
            `Dictation finished: ${recording.seconds.toFixed(2)} s audio, recognition 0.00 s, polish skipped`,
          )
          return { text: '' }
        }
        const result = { text: applyVocabulary(text, vocabulary(recording.vocabulary)) }
        if (!recording.signal.aborted) {
          if (keepHistory()) history().record(result.text, recording.seconds)
          if (learnTerms()) memory().record(result.text, recording.vocabulary)
          stats().record(result.text, recording.seconds)
          log(
            'info',
            `Dictation finished: ${recording.seconds.toFixed(2)} s audio, ${current.segments} segments before stop, recognition ${recognitionSeconds.toFixed(2)} s, polish ${polished.outcome}`,
          )
        }
        return result
      })
    } catch (error) {
      if (!signal?.aborted) log('error', `Dictation finish failed: ${logReason(error)}`)
      throw error
    } finally {
      drop(request, session)
    }
  }

  return {
    call,
    dispose() {
      for (const session of sessions.keys()) {
        recordings.cancel({ session })
        drop({ session })
      }
    },
  }
}
