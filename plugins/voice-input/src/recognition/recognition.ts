import { PluginError, type DictationRecording } from '@gode/plugin-sdk/plugin'
import type { VoiceMemory } from '../data/memory'
import type { ModelSet } from '../models/download'
import type { LocalEngine } from '../models/engine'
import type { Names } from '../names'
import {
  apiURL,
  cleanTranscript,
  readResponse,
  reason,
  transcriptionRequest,
} from './transcription-logic'
import { applyVocabulary } from './vocabulary-logic'

async function transcribe(
  base: string,
  recording: DictationRecording,
  audio: Uint8Array,
  vocabulary: readonly string[],
  options: { model: string; language: string; apiKey?: string; removeFillers: boolean },
): Promise<{ text: string }> {
  try {
    const response = await fetch(apiURL(base, 'audio/transcriptions'), {
      ...transcriptionRequest({ audio, vocabulary }, options),
      signal: AbortSignal.any([recording.signal, AbortSignal.timeout(180_000)]),
    })
    const value = await readResponse(response)
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string')
      throw new Error('The server returned no transcription')
    return { text: cleanTranscript(value.text, options.removeFillers) }
  } catch (error) {
    const failure = new PluginError({
      message: 'error.recognition',
      values: { reason: reason(error) },
    })
    failure.cause = error
    throw failure
  }
}

export function createRecognition({
  local,
  text,
  selected,
  apiKey,
  removeFillers,
  vocabulary,
  engine,
}: {
  local: () => boolean
  text: (key: Names['settings'], fallback?: string) => string
  selected: () => ModelSet
  apiKey: () => string | undefined
  removeFillers: () => boolean
  vocabulary: VoiceMemory['vocabulary']
  engine: () => LocalEngine
}) {
  return async function recognize(
    recording: DictationRecording,
    audio: Uint8Array,
    span: { start: number; end: number },
    final = false,
  ): Promise<{ text: string }> {
    const isLocal = local()
    const words = vocabulary(recording.vocabulary)
    const options = {
      model: isLocal ? selected().files[0]!.file : text('model', 'gpt-4o-transcribe'),
      language: text('language', 'auto'),
      apiKey: isLocal ? undefined : apiKey(),
      removeFillers: removeFillers(),
    }
    if (!isLocal) {
      const result = await transcribe(
        text('serverURL').trim(),
        recording,
        audio,
        vocabulary(recording.vocabulary, 50),
        options,
      )
      return final ? result : { text: applyVocabulary(result.text, words) }
    }
    const pcm = audio.subarray(
      44 + Math.round(span.start * 16000) * 2,
      44 + Math.round(span.end * 16000) * 2,
    )
    const trimmed = new Uint8Array(44 + pcm.byteLength)
    trimmed.set(audio.subarray(0, 44))
    trimmed.set(pcm, 44)
    const header = new DataView(trimmed.buffer)
    header.setUint32(4, 36 + pcm.byteLength, true)
    header.setUint32(40, pcm.byteLength, true)
    try {
      const result = await engine().use((base, apiKey) =>
        transcribe(base, recording, trimmed, [], { ...options, apiKey }),
      )
      return final ? result : { text: applyVocabulary(result.text, words) }
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError({ message: 'error.engine', values: { reason: reason(error) } })
    }
  }
}
