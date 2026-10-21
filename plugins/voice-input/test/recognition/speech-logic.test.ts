import { expect, test } from '@gode/plugin-sdk/test'
import { detectSpeech, findSpeechPause } from '../../src/recognition/speech-logic.ts'
import { noise, pcm } from '../fixtures/index.ts'

function mix(background: Buffer, foreground: Buffer, start: number): Buffer {
  const audio = Buffer.from(background)
  for (let index = 0; index < foreground.length; index += 2) {
    const offset = Math.round(start * 16000) * 2 + index
    audio.writeInt16LE(
      Math.max(-32768, Math.min(32767, audio.readInt16LE(offset) + foreground.readInt16LE(index))),
      offset,
    )
  }
  return audio
}

function tone(seconds: number, frequency: number, db = -20): Buffer {
  const audio = Buffer.alloc(Math.round(seconds * 32000))
  for (let offset = 0; offset < audio.length; offset += 2)
    audio.writeInt16LE(
      Math.round(
        32768 * 10 ** (db / 20) * Math.SQRT2 * Math.sin((2 * Math.PI * frequency * offset) / 32000),
      ),
      offset,
    )
  return audio
}

test.each([0, 0.015, 1, 5])('digital silence of %s seconds has no speech', (seconds) => {
  expect(detectSpeech(Buffer.alloc(Math.round(seconds * 32000)))).toEqual({
    hasSpeech: false,
    voicedSeconds: 0,
    span: null,
  })
})

test.each([1, 7, 42])(
  'room noise at -39 dBFS with random -22 dBFS peaks is rejected (seed %s)',
  (seed) => {
    const audio = noise(6, { seed })
    let power = 0
    let peak = 0
    for (let index = 0; index < audio.length; index += 2) {
      const sample = audio.readInt16LE(index) / 32768
      power += sample ** 2
      peak = Math.max(peak, Math.abs(sample))
    }
    expect(10 * Math.log10(power / (audio.length / 2))).toBeCloseTo(-39, 0)
    expect(20 * Math.log10(peak)).toBeCloseTo(-22, 1)
    expect(detectSpeech(audio)).toEqual({ hasSpeech: false, voicedSeconds: 0, span: null })
  },
)

test('low hum mixed with room noise is rejected', () => {
  expect(detectSpeech(mix(noise(5), tone(5, 60, -30), 0)).hasSpeech).toBe(false)
})

test.each([
  [120, 3, -20, -39],
  [160, 4, -20, -39],
  [220, 6, -20, -39],
  [120, 3, -35, -55],
  [160, 4, -35, -55],
  [220, 6, -35, -55],
])(
  'detects %s Hz, %s syllables/s at %s dBFS over %s dBFS noise',
  (fundamental, syllables, db, noiseDb) => {
    const speech = pcm(2, { fundamental, syllables, db })
    const audio = mix(noise(5, { db: noiseDb, peaks: noiseDb === -39 }), speech, 1.2)
    const result = detectSpeech(audio)
    expect(result.hasSpeech).toBe(true)
    expect(result.voicedSeconds).toBeGreaterThanOrEqual(0.25)
    expect(result.span!.start).toBeGreaterThanOrEqual(1.2 - 0.35)
    expect(result.span!.start).toBeLessThanOrEqual(1.2)
    expect(result.span!.end).toBeGreaterThanOrEqual(3.2)
    expect(result.span!.end).toBeLessThanOrEqual(3.2 + 0.35)
  },
)

test('recognizes speech starting immediately with no separate noise lead-in', () => {
  expect(detectSpeech(pcm(1))).toMatchObject({ hasSpeech: true, span: { start: 0, end: 1 } })
})

test.each([0.03, 0.06, 0.09])(
  'rejects repeated click bursts lasting %s seconds before hangover',
  (seconds) => {
    let audio = noise(3, { db: -55, peaks: false })
    for (const start of [0.31, 0.8, 1.2, 1.8]) audio = mix(audio, tone(seconds, 800), start)
    expect(detectSpeech(audio)).toEqual({ hasSpeech: false, voicedSeconds: 0, span: null })
  },
)

test('rejects loud hiss, low-frequency rumble and DC even above the adaptive floor', () => {
  const silence = Buffer.alloc(4 * 32000)
  for (const burst of [
    noise(1, { db: -20, peaks: false }),
    tone(1, 60),
    Buffer.from(new Int16Array(16000).fill(3277).buffer),
  ])
    expect(detectSpeech(mix(silence, burst, 1)).hasSpeech).toBe(false)
})

test('requires both 12 dB above the noise floor and at least -50 dBFS', () => {
  expect(detectSpeech(mix(noise(4, { peaks: false }), tone(1, 800, -30), 1)).hasSpeech).toBe(false)
  expect(detectSpeech(mix(Buffer.alloc(4 * 32000), tone(1, 800, -51), 1)).hasSpeech).toBe(false)
  expect(detectSpeech(mix(noise(4, { peaks: false }), tone(1, 800, -24), 1)).hasSpeech).toBe(true)
})

test('requires 250 ms of speech without counting trailing hangover or padding', () => {
  for (const [seconds, hasSpeech] of [
    [0.24, false],
    [0.27, true],
  ] as const) {
    const result = detectSpeech(mix(Buffer.alloc(32000), tone(seconds, 800), 0.3))
    expect(result.hasSpeech).toBe(hasSpeech)
    expect(result.voicedSeconds).toBeCloseTo(seconds)
    expect(result.span!.start).toBe(0)
    expect(result.span!.end).toBeCloseTo(0.3 + seconds + 0.3)
  }
})

test('hangover joins syllables up to 210 ms apart without counting the gaps', () => {
  for (const [gap, expected] of [
    [0.21, 0.18],
    [0.24, 0],
  ] as const) {
    let audio = mix(Buffer.alloc(32000), tone(0.09, 800), 0.3)
    audio = mix(audio, tone(0.09, 800), 0.39 + gap)
    expect(detectSpeech(audio).voicedSeconds).toBeCloseTo(expected)
    expect(detectSpeech(audio).hasSpeech).toBe(false)
  }
})

test('reads PCM subarrays and clips padding at recording boundaries', () => {
  const backing = Buffer.concat([Buffer.alloc(7), pcm(0.5), Buffer.alloc(9)])
  expect(detectSpeech(backing.subarray(7, backing.length - 9))).toMatchObject({
    hasSpeech: true,
    span: { start: 0, end: 0.5 },
  })
})

test('finds the latest pause between voiced runs with enough audio before it', () => {
  const audio = Buffer.concat([
    pcm(4),
    Buffer.alloc(32000),
    pcm(4),
    Buffer.alloc(32000),
    pcm(2),
    Buffer.alloc(3 * 32000),
  ])
  const pause = findSpeechPause(audio, 5)!
  expect(pause).toBeGreaterThanOrEqual(9)
  expect(pause).toBeLessThanOrEqual(10)
  expect(findSpeechPause(audio, pause)).toBe(pause)
  expect(findSpeechPause(audio, pause + 1 / 16000)).toBeNull()
  expect(detectSpeech(audio.subarray(0, Math.round(pause * 16000) * 2)).hasSpeech).toBe(true)
  expect(detectSpeech(audio.subarray(Math.round(pause * 16000) * 2)).hasSpeech).toBe(true)
})

test('does not use leading or trailing silence, continuous speech or noise as pauses', () => {
  for (const audio of [
    Buffer.alloc(10 * 32000),
    noise(10),
    pcm(10),
    Buffer.concat([Buffer.alloc(6 * 32000), pcm(2), Buffer.alloc(6 * 32000)]),
    Buffer.concat([pcm(2), Buffer.alloc(32000), pcm(2)]),
  ])
    expect(findSpeechPause(audio, 5)).toBeNull()
})

test('pause finding uses smoothed runs and reads PCM subarrays', () => {
  const audio = mix(Buffer.concat([pcm(6), Buffer.alloc(3 * 32000)]), tone(0.06, 800), 7)
  expect(findSpeechPause(audio, 5)).toBeNull()
  const speech = Buffer.concat([pcm(6), Buffer.alloc(32000), pcm(2)])
  const backing = Buffer.concat([Buffer.alloc(7), speech, Buffer.alloc(9)])
  expect(findSpeechPause(backing.subarray(7, backing.length - 9), 5)).toBe(
    findSpeechPause(speech, 5),
  )
  expect(findSpeechPause(speech, 5)).toBeGreaterThanOrEqual(6)
  expect(findSpeechPause(speech, 5)).toBeLessThanOrEqual(7)
})
