import { join } from 'node:path'
import type { SetPluginView } from '@gode/plugin-sdk/plugin'
import manifest from '../manifest.json'
import { AtomicFile } from './atomic-file'
import { extractTerms } from './memory-logic'

interface Term {
  key: string
  count: number
  time: number
  forms: Record<string, number>
}

function validTerm(value: unknown): value is Term {
  if (!value || typeof value !== 'object') return false
  const term = value as Term
  return (
    typeof term.key === 'string' &&
    term.key.length > 0 &&
    term.key.length <= 200 &&
    term.key === term.key.toLowerCase() &&
    Number.isSafeInteger(term.count) &&
    term.count > 0 &&
    Number.isSafeInteger(term.time) &&
    term.time >= 0 &&
    !!term.forms &&
    typeof term.forms === 'object' &&
    !Array.isArray(term.forms) &&
    Object.keys(term.forms).length > 0 &&
    Object.entries(term.forms).every(
      ([form, count]) =>
        form.toLowerCase() === term.key && Number.isSafeInteger(count) && count > 0,
    )
  )
}

function surface(term: Term): string {
  return Object.entries(term.forms).sort(([, a], [, b]) => b - a)[0]![0]
}

export class VoiceMemory {
  private terms = new Map<string, Term>()
  private forgotten = new Set<string>()
  private readonly file: AtomicFile

  constructor(
    directory: string,
    private readonly locale: string,
    private readonly setView: SetPluginView,
  ) {
    this.file = new AtomicFile(join(directory, 'memory.json'))
  }

  async read(): Promise<void> {
    const value = (await this.file.read()) as { terms?: unknown; forgotten?: unknown } | undefined
    if (
      value &&
      Array.isArray(value.terms) &&
      value.terms.every(validTerm) &&
      Array.isArray(value.forgotten) &&
      value.forgotten.every(
        (key): key is string =>
          typeof key === 'string' &&
          key.length > 0 &&
          key.length <= 200 &&
          key === key.toLowerCase(),
      )
    ) {
      this.forgotten = new Set(value.forgotten)
      this.terms = new Map(
        value.terms.filter((term) => !this.forgotten.has(term.key)).map((term) => [term.key, term]),
      )
      this.prune()
    }
    this.publish()
  }

  record(text: string, vocabulary: readonly string[]): void {
    const seen = new Set<string>()
    for (const form of extractTerms(text, vocabulary)) {
      const key = form.toLowerCase()
      if (this.forgotten.has(key)) continue
      const previous = this.terms.get(key)
      this.terms.set(key, {
        key,
        count: (previous?.count ?? 0) + (seen.has(key) ? 0 : 1),
        time: Date.now(),
        forms: {
          ...previous?.forms,
          [form]: (previous && Object.hasOwn(previous.forms, form) ? previous.forms[form]! : 0) + 1,
        },
      })
      seen.add(key)
    }
    if (!seen.size) return
    this.prune()
    this.changed()
  }

  vocabulary(request: readonly string[], limit = 300): string[] {
    const existing = new Set(request.map((word) => word.normalize('NFC').trim().toLowerCase()))
    return [
      ...request,
      ...this.learned()
        .filter((term) => !existing.has(term.key))
        .slice(0, limit)
        .map(surface),
    ]
  }

  forget(key: string): void {
    if (!this.terms.has(key)) return
    this.terms.delete(key)
    this.forgotten.add(key)
    this.changed()
  }

  clear(): void {
    this.terms.clear()
    this.forgotten.clear()
    this.changed()
  }

  dispose(): Promise<void> {
    return this.file.dispose()
  }

  private learned(): Term[] {
    return [...this.terms.values()]
      .filter((term) => term.count >= 2)
      .sort((a, b) => b.count - a.count || b.time - a.time || a.key.localeCompare(b.key))
  }

  private prune(): void {
    const recent = this.learned().sort((a, b) => b.time - a.time)
    for (const term of recent.slice(300)) this.terms.delete(term.key)
  }

  private changed(): void {
    this.publish()
    this.file.write({ terms: [...this.terms.values()], forgotten: [...this.forgotten] })
  }

  private publish(): void {
    const strings: Record<string, string> =
      manifest.strings[this.locale as keyof typeof manifest.strings] ?? manifest.strings.en
    const plurals = new Intl.PluralRules(this.locale)
    const numbers = new Intl.NumberFormat(this.locale)
    this.setView('memory', {
      items: this.learned().map((term) => ({
        id: term.key,
        text: surface(term),
        detail: (
          strings[`memory.heard.${plurals.select(term.count)}`] ?? strings['memory.heard.other']!
        ).replace('{count}', numbers.format(term.count)),
      })),
      empty: 'view.memory.empty',
    })
  }
}
