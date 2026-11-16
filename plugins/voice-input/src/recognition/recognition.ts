import { PluginError, type DictationRecording } from '@gode/plugin-sdk/plugin'
import type { VoiceMemory } from '../data/memory'
import type { ModelSet } from '../models/download'
import type { LocalEngine } from '../models/engine'
import type { SpeechServer } from './server'
import { detectSpeech, recordingParts } from './speech-logic'
import {
  apiURL,
  chatRequest,
  cleanTranscript,
  joinTranscript,
  readResponse,
  reason,
  transcriptionRequest,
  transcriptText,
} from './transcription-logic'
import { applyVocabulary } from './vocabulary-logic'

const dataURLServers = new Set<string>()

async function transcribe(
  server: Pick<SpeechServer, 'base' | 'endpoint' | 'apiKey' | 'model' | 'language' | 'chat'>,
  recording: DictationRecording,
  audio: Uint8Array,
  vocabulary: readonly string[],
  removeFillers: boolean,
): Promise<{ text: string }> {
  try {
    const send = (dataURL: boolean): Promise<Response> =>
      fetch(apiURL(server.base, server.endpoint), {
        ...(server.chat
          ? chatRequest({ audio, vocabulary }, server, dataURL)
          : transcriptionRequest({ audio, vocabulary }, server)),
        signal: AbortSignal.any([recording.signal, AbortSignal.timeout(180_000)]),
      })
    let response = await send(dataURLServers.has(server.base))
    if (
      server.chat &&
      !dataURLServers.has(server.base) &&
      [400, 415, 422].includes(response.status)
    ) {
      const retry = await send(true)
      if (retry.ok) {
        dataURLServers.add(server.base)
        void response.body?.cancel()
        response = retry
      } else void retry.body?.cancel()
    }
    const text = transcriptText(await readResponse(response))
    if (text === undefined) throw new Error('The server returned no transcription')
    return { text: cleanTranscript(text, removeFillers) }
  } catch (error) {
    const failure = new PluginError({
      message: 'error.recognition',
      values: { reason: reason(error) },
    })
    failure.cause = error
    throw failure
  }
}

function part(audio: Uint8Array, span: { start: number; end: number }): Uint8Array {
  const pcm = audio.subarray(
    44 + Math.round(span.start * 16000) * 2,
    44 + Math.round(span.end * 16000) * 2,
  )
  const wav = new Uint8Array(44 + pcm.byteLength)
  wav.set(audio.subarray(0, 44))
  wav.set(pcm, 44)
  const header = new DataView(wav.buffer)
  header.setUint32(4, 36 + pcm.byteLength, true)
  header.setUint32(40, pcm.byteLength, true)
  return wav
}

export function createRecognition({
  local,
  server,
  language,
  selected,
  removeFillers,
  vocabulary,
  engine,
}: {
  local: () => boolean
  server: () => SpeechServer
  language: () => string
  selected: () => ModelSet
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
    const words = vocabulary(recording.vocabulary)
    if (!local()) {
      const chosen = server()
      const sent = chosen.prompt ? vocabulary(recording.vocabulary, 50) : []
      const seconds = (audio.byteLength - 44) / 32000
      const parts =
        chosen.maxSeconds && seconds > chosen.maxSeconds
          ? recordingParts(audio.subarray(44), chosen.maxSeconds)
              .map((span) => part(audio, span))
              .filter((wav) => detectSpeech(wav.subarray(44)).hasSpeech)
          : [audio]
      let text = ''
      for (const wav of parts)
        text = joinTranscript(
          text,
          (await transcribe(chosen, recording, wav, sent, removeFillers())).text,
        )
      return { text: final ? text : applyVocabulary(text, words) }
    }
    try {
      const result = await engine().use((base, apiKey) =>
        transcribe(
          {
            base,
            endpoint: 'audio/transcriptions',
            apiKey,
            model: selected().files[0]!.file,
            language: language(),
          },
          recording,
          part(audio, span),
          [],
          removeFillers(),
        ),
      )
      return final ? result : { text: applyVocabulary(result.text, words) }
    } catch (error) {
      if (error instanceof PluginError) throw error
      throw new PluginError({ message: 'error.engine', values: { reason: reason(error) } })
    }
  }
}
