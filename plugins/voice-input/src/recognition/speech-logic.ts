function speechRuns(pcm: Uint8Array): { start: number; end: number; voiced: number }[] {
  const samples = Math.floor(pcm.byteLength / 2)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const frames: { start: number; end: number; energy: number; crossings: number }[] = []
  for (let start = 0; start < samples; start += 480) {
    const end = Math.min(samples, start + 480)
    let power = 0
    let crossings = 0
    let previous = view.getInt16(start * 2, true)
    for (let index = start; index < end; index++) {
      const sample = view.getInt16(index * 2, true)
      power += (sample / 32768) ** 2
      if (index > start && sample >= 0 !== previous >= 0) crossings++
      previous = sample
    }
    frames.push({
      start,
      end,
      energy: 10 * Math.log10(Math.max(1e-10, power / (end - start))),
      crossings: crossings / Math.max(1, end - start - 1),
    })
  }
  const energies = frames.map((frame) => frame.energy).sort((a, b) => a - b)
  const floor = energies[Math.floor(energies.length * 0.1)] ?? -100
  const threshold = Math.max(-50, floor + 12)
  const runs: { start: number; end: number; voiced: number }[] = []
  for (const frame of frames) {
    if (frame.energy < threshold || frame.crossings < 0.02 || frame.crossings > 0.35) continue
    const previous = runs.at(-1)
    if (previous && frame.start - previous.end <= 3360) {
      previous.end = frame.end
      previous.voiced += frame.end - frame.start
    } else {
      runs.push({ start: frame.start, end: frame.end, voiced: frame.end - frame.start })
    }
  }
  return runs.filter((run) => run.voiced >= 1920)
}

export function speechPauses(pcm: Uint8Array): { at: number; length: number }[] {
  const runs = speechRuns(pcm)
  const pauses: { at: number; length: number }[] = []
  for (let index = 1; index < runs.length; index++) {
    const before = runs[index - 1]!
    const after = runs[index]!
    pauses.push({
      at: (before.end + after.start) / 32000,
      length: (after.start - before.end) / 16000,
    })
  }
  return pauses
}

export const sentencePause = 0.75

export function segmentCut(
  pauses: readonly { at: number; length: number }[],
  windowSeconds: number,
): { at: number; pause: number } | null {
  let sentence: (typeof pauses)[number] | undefined
  let longest: (typeof pauses)[number] | undefined
  for (const pause of pauses) {
    if (pause.at < 10) continue
    if (pause.length >= sentencePause && (!sentence || pause.at > sentence.at)) sentence = pause
    if (
      !longest ||
      pause.length > longest.length ||
      (pause.length === longest.length && pause.at > longest.at)
    )
      longest = pause
  }
  if (sentence) return { at: sentence.at, pause: sentence.length }
  if (windowSeconds < 30) return null
  return longest ? { at: longest.at, pause: longest.length } : { at: 30, pause: 0 }
}

export function detectSpeech(pcm: Uint8Array): {
  hasSpeech: boolean
  voicedSeconds: number
  span: { start: number; end: number } | null
} {
  const samples = Math.floor(pcm.byteLength / 2)
  const smoothed = speechRuns(pcm)
  const voicedSeconds = smoothed.reduce((sum, run) => sum + run.voiced, 0) / 16000
  const first = smoothed[0]
  const last = smoothed.at(-1)
  return {
    hasSpeech: voicedSeconds >= 0.25,
    voicedSeconds,
    span:
      first && last
        ? {
            start: Math.max(0, first.start / 16000 - 0.3),
            end: Math.min(samples / 16000, last.end / 16000 + 0.3),
          }
        : null,
  }
}
