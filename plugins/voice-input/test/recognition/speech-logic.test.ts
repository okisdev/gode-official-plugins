import { expect, test } from '@gode/plugin-sdk/test'
import {
  detectSpeech,
  segmentCut,
  sentencePause,
  speechPauses,
} from '../../src/recognition/speech-logic.ts'
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

test('returns every gap between voiced runs with midpoint and length', () => {
  const audio = Buffer.concat([
    pcm(4),
    Buffer.alloc(32000),
    pcm(4),
    Buffer.alloc(2 * 32000),
    pcm(2),
    Buffer.alloc(3 * 32000),
  ])
  const pauses = speechPauses(audio)
  expect(pauses).toHaveLength(2)
  expect(pauses[0]!.at).toBeGreaterThan(4)
  expect(pauses[0]!.at).toBeLessThan(5)
  expect(pauses[0]!.length).toBeCloseTo(1, 1)
  expect(pauses[1]!.at).toBeGreaterThan(9)
  expect(pauses[1]!.at).toBeLessThan(11)
  expect(pauses[1]!.length).toBeCloseTo(2, 1)
})

test('does not count leading or trailing silence, continuous speech or noise as pauses', () => {
  for (const audio of [
    Buffer.alloc(10 * 32000),
    noise(10),
    pcm(10),
    Buffer.concat([Buffer.alloc(6 * 32000), pcm(2), Buffer.alloc(6 * 32000)]),
  ])
    expect(speechPauses(audio)).toEqual([])
  expect(speechPauses(Buffer.concat([pcm(2), Buffer.alloc(32000), pcm(2)]))).toHaveLength(1)
})

test('pause finding uses smoothed runs and reads PCM subarrays', () => {
  const audio = mix(Buffer.concat([pcm(6), Buffer.alloc(3 * 32000)]), tone(0.06, 800), 7)
  expect(speechPauses(audio)).toEqual([])
  const speech = Buffer.concat([pcm(6), Buffer.alloc(32000), pcm(2)])
  const backing = Buffer.concat([Buffer.alloc(7), speech, Buffer.alloc(9)])
  expect(speechPauses(backing.subarray(7, backing.length - 9))).toEqual(speechPauses(speech))
  expect(speechPauses(speech)[0]!.at).toBeGreaterThanOrEqual(6)
  expect(speechPauses(speech)[0]!.at).toBeLessThanOrEqual(7)
})

test('sentence pause wins over a later short pause', () => {
  expect(sentencePause).toBe(0.75)
  expect(
    segmentCut(
      [
        { at: 9, length: 2 },
        { at: 12, length: 0.8 },
        { at: 20, length: 0.3 },
      ],
      25,
    ),
  ).toEqual({ at: 12, pause: 0.8 })
})

test('full window uses the longest eligible pause and the latest on a tie', () => {
  expect(
    segmentCut(
      [
        { at: 8, length: 0.7 },
        { at: 12, length: 0.4 },
        { at: 24, length: 0.6 },
        { at: 18, length: 0.6 },
        { at: 27, length: 0.2 },
      ],
      30,
    ),
  ).toEqual({ at: 24, pause: 0.6 })
})

test('full window without an eligible pause cuts at 30 seconds', () => {
  expect(segmentCut([], 30)).toEqual({ at: 30, pause: 0 })
  expect(segmentCut([{ at: 5, length: 2 }], 30)).toEqual({ at: 30, pause: 0 })
})

test('waits for more audio when no sentence pause and the window is short', () => {
  expect(segmentCut([], 20)).toBeNull()
  expect(segmentCut([{ at: 15, length: 0.5 }], 29.99)).toBeNull()
})
