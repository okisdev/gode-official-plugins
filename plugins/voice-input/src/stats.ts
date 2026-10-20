import { join } from 'node:path'
import type { SetPluginView } from '@gode/plugin-sdk/plugin'
import { AtomicFile } from './atomic-file'

interface Counts {
  words: number
  seconds: number
  dictations: number
}

interface Stats {
  totals: Counts
  days: Record<string, Counts>
}

const emptyCounts = (): Counts => ({ words: 0, seconds: 0, dictations: 0 })

export function countWords(text: string): number {
  let characters = 0
  const rest = text
    .normalize('NFC')
    .replace(
      /[\p{Script=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\uac00-\ud7a3]/gu,
      (character) => {
        if (/[\p{L}\p{N}]/u.test(character)) characters++
        return ' '
      },
    )
  return characters + (rest.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0)
}

function localDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

function recentDays(days: Stats['days'], now: Date): Stats['days'] {
  const oldest = new Date(now)
  oldest.setDate(oldest.getDate() - 399)
  const cutoff = localDate(oldest)
  return Object.fromEntries(
    Object.entries(days)
      .filter(([date]) => date >= cutoff)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-400),
  )
}

function validCounts(value: unknown): value is Counts {
  if (!value || typeof value !== 'object') return false
  const counts = value as Counts
  return (
    Number.isSafeInteger(counts.words) &&
    counts.words >= 0 &&
    Number.isFinite(counts.seconds) &&
    counts.seconds >= 0 &&
    Number.isSafeInteger(counts.dictations) &&
    counts.dictations >= 0
  )
}

function parseStats(value: unknown): Stats {
  if (value && typeof value === 'object') {
    const stats = value as Stats
    if (
      validCounts(stats.totals) &&
      stats.days &&
      typeof stats.days === 'object' &&
      !Array.isArray(stats.days) &&
      Object.entries(stats.days).every(
        ([date, counts]) =>
          /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          Number.isFinite(Date.parse(date)) &&
          new Date(date).toISOString().slice(0, 10) === date &&
          validCounts(counts),
      )
    )
      return stats
  }
  return { totals: emptyCounts(), days: {} }
}

export class VoiceStats {
  private stats: Stats = { totals: emptyCounts(), days: {} }
  private readonly file: AtomicFile
  private midnight: ReturnType<typeof setTimeout> | undefined

  constructor(
    directory: string,
    private readonly setView: SetPluginView,
  ) {
    this.file = new AtomicFile(join(directory, 'stats.json'))
  }

  async read(): Promise<void> {
    this.stats = parseStats(await this.file.read())
    this.stats.days = recentDays(this.stats.days, new Date())
    this.publish()
    this.armMidnight()
  }

  record(text: string, seconds: number): void {
    const now = new Date()
    const date = localDate(now)
    const words = countWords(text)
    const add = (counts: Counts): Counts => ({
      words: counts.words + words,
      seconds: counts.seconds + seconds,
      dictations: counts.dictations + 1,
    })
    this.stats = {
      totals: add(this.stats.totals),
      days: recentDays(
        { ...this.stats.days, [date]: add(this.stats.days[date] ?? emptyCounts()) },
        now,
      ),
    }
    this.publish()
    this.file.write(this.stats)
  }

  async dispose(): Promise<void> {
    if (this.midnight) clearTimeout(this.midnight)
    await this.file.dispose()
  }

  private armMidnight(): void {
    if (this.midnight) clearTimeout(this.midnight)
    const next = new Date()
    next.setHours(24, 0, 0, 0)
    this.midnight = setTimeout(() => {
      this.publish()
      this.armMidnight()
    }, next.getTime() - Date.now())
    this.midnight.unref()
  }

  private publish(): void {
    this.setView('usage', {
      figures: [
        {
          label: 'view.today',
          value: this.stats.days[localDate(new Date())]?.words ?? 0,
          format: 'count',
        },
        { label: 'view.total', value: this.stats.totals.words, format: 'count' },
        { label: 'view.speaking', value: this.stats.totals.seconds, format: 'duration' },
        { label: 'view.dictations', value: this.stats.totals.dictations, format: 'count' },
      ],
    })
    this.setView('activity', {
      unit: 'view.activity.unit',
      days: Object.entries(this.stats.days)
        .filter(([, counts]) => counts.words > 0)
        .map(([date, counts]) => ({ date, value: counts.words })),
    })
  }
}
