import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PluginViewPage } from '@gode/plugin-sdk'
import type { SetPluginView } from '@gode/plugin-sdk/plugin'
import { AtomicFile } from './atomic-file'
import type { Names } from '../names'

interface Entry {
  id: string
  text: string
  time: number
  seconds: number
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Entry
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    entry.id.length <= 200 &&
    typeof entry.text === 'string' &&
    entry.text.trim().length > 0 &&
    Number.isSafeInteger(entry.time) &&
    entry.time >= 0 &&
    Number.isFinite(entry.seconds) &&
    entry.seconds >= 0
  )
}

export class VoiceHistory {
  private entries: Entry[] = []
  private readonly file: AtomicFile

  constructor(
    directory: string,
    private readonly locale: string,
    private readonly setView: SetPluginView<Names>,
  ) {
    this.file = new AtomicFile(join(directory, 'history.json'))
  }

  async read(): Promise<void> {
    const value = await this.file.read()
    if (
      Array.isArray(value) &&
      value.every(validEntry) &&
      new Set(value.map((entry) => entry.id)).size === value.length
    )
      this.entries = value.sort((a, b) => b.time - a.time).slice(0, 10_000)
    this.publish()
  }

  record(text: string, seconds: number): void {
    if (!text.trim()) return
    this.entries = [{ id: randomUUID(), text, time: Date.now(), seconds }, ...this.entries].slice(
      0,
      10_000,
    )
    this.changed()
  }

  delete(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id)
    this.changed()
  }

  clear(): void {
    this.entries = []
    this.changed()
  }

  dispose(): Promise<void> {
    return this.file.dispose()
  }

  query(search: string, cursor: string | null, limit: number): PluginViewPage {
    const matches = this.entries.filter((entry) =>
      entry.text.toLowerCase().includes(search.toLowerCase()),
    )
    const offset = cursor === null ? 0 : Number(cursor)
    const page = matches.slice(offset, offset + limit)
    const next = offset + page.length
    return {
      items: page.map((entry) => this.item(entry)),
      cursor: next < matches.length ? String(next) : null,
    }
  }

  private changed(): void {
    this.publish()
    this.file.write(this.entries)
  }

  private publish(): void {
    this.setView('history', {
      items: this.entries.slice(0, 20).map((entry) => this.item(entry)),
      total: this.entries.length,
      empty: 'view.history.empty',
    })
  }

  private item(entry: Entry): PluginViewPage['items'][number] {
    const minutes = new Intl.NumberFormat(this.locale, {
      style: 'unit',
      unit: 'minute',
      unitDisplay: 'short',
    })
    const seconds = new Intl.NumberFormat(this.locale, {
      style: 'unit',
      unit: 'second',
      unitDisplay: 'short',
    })
    const rounded = Math.round(entry.seconds)
    return {
      id: entry.id,
      text: entry.text.slice(0, 10_000),
      time: entry.time,
      detail:
        rounded < 60
          ? seconds.format(rounded)
          : `${minutes.format(Math.floor(rounded / 60))} ${seconds.format(rounded % 60)}`,
    }
  }
}
