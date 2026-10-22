import { join } from 'node:path'
import type { PluginViewPage } from '@gode/plugin-sdk'
import type { PluginContext, SetPluginView, SyncedMap, SyncedSet } from '@gode/plugin-sdk/plugin'
import de from '../../i18n/de.json'
import en from '../../i18n/en.json'
import es from '../../i18n/es.json'
import fr from '../../i18n/fr.json'
import ja from '../../i18n/ja.json'
import ko from '../../i18n/ko.json'
import ptBR from '../../i18n/pt-BR.json'
import ru from '../../i18n/ru.json'
import zhHans from '../../i18n/zh-Hans.json'
import zhHant from '../../i18n/zh-Hant.json'
import { AtomicFile } from './atomic-file'
import type { Names } from '../names'
import { extractTerms } from './memory-logic'

const catalogs: Record<string, Record<string, string>> = {
  de,
  en,
  es,
  fr,
  ja,
  ko,
  'pt-BR': ptBR,
  ru,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
}

interface Term {
  key: string
  count: number
  time: number
  forms: Record<string, number>
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 200 && key === key.toLowerCase()
}

function validSyncedTerm(key: string, spelling: unknown): spelling is string {
  return (
    validKey(key) &&
    typeof spelling === 'string' &&
    spelling.length <= 1000 &&
    spelling.toLowerCase() === key
  )
}

function validTerm(value: unknown): value is Term {
  if (!value || typeof value !== 'object') return false
  const term = value as Term
  return (
    validKey(term.key) &&
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
  private own = new Map<string, string>()
  private forgotten = new Set<string>()
  private readonly file: AtomicFile
  private readonly syncedTerms: SyncedMap
  private readonly syncedOwn: SyncedMap
  private readonly syncedForgotten: SyncedSet
  private migrated = false
  private unlisten: (() => void)[] = []

  constructor(
    directory: string,
    private readonly locale: string,
    private readonly setView: SetPluginView<Names>,
    synced: PluginContext<Names>['synced'],
  ) {
    this.file = new AtomicFile(join(directory, 'memory.json'))
    this.syncedTerms = synced('terms')
    this.syncedOwn = synced('vocabulary')
    this.syncedForgotten = synced('forgotten')
  }

  async read(): Promise<void> {
    const value = (await this.file.read()) as
      | { terms?: unknown; own?: unknown; forgotten?: unknown; migrated?: unknown }
      | undefined
    if (
      value &&
      Array.isArray(value.terms) &&
      value.terms.every(validTerm) &&
      Array.isArray(value.forgotten) &&
      value.forgotten.every(validKey)
    ) {
      this.migrated = value.migrated === true
      this.forgotten = new Set(value.forgotten)
      this.terms = new Map(value.terms.map((term) => [term.key, term]))
      this.pruneForgotten(false)
      if (!this.migrated) {
        for (const term of this.learned()
          .filter((term) => !this.forgotten.has(term.key))
          .sort((a, b) => b.time - a.time)
          .slice(0, 300)) {
          const spelling = surface(term)
          if (validSyncedTerm(term.key, spelling) && !this.syncedTerms.has(term.key))
            this.syncedTerms.set(term.key, spelling)
        }
        const forgotten = new Set(this.syncedForgotten.values())
        for (const key of this.forgotten) {
          forgotten.delete(key)
          forgotten.add(key)
        }
        while (forgotten.size > 1000) forgotten.delete(forgotten.values().next().value!)
        for (const key of this.syncedForgotten.values()) {
          if (!forgotten.has(key)) this.syncedForgotten.delete(key)
        }
        for (const key of forgotten) this.syncedForgotten.add(key)
        this.migrated = true
        this.save()
      }
    }
    this.own = new Map(
      this.syncedOwn.entries().filter(([key, spelling]) => validSyncedTerm(key, spelling)),
    )
    this.reconcile()
    if (value || this.terms.size || this.own.size || this.forgotten.size) {
      this.migrated = true
      this.save()
    }
    this.unlisten.push(
      this.syncedOwn.onChange(({ changed, deleted }) => {
        for (const key of changed) {
          const spelling = this.syncedOwn.get(key)
          if (!validSyncedTerm(key, spelling)) {
            this.own.delete(key)
            continue
          }
          this.own.set(key, spelling)
          this.terms.delete(key)
          this.syncedTerms.delete(key)
          this.forgotten.delete(key)
          this.syncedForgotten.delete(key)
        }
        for (const key of deleted) {
          if (!this.own.delete(key)) continue
          this.forgotten.add(key)
          this.pruneForgotten()
          this.syncedForgotten.add(key)
        }
        this.changed()
      }),
      this.syncedTerms.onChange(({ changed, deleted }) => {
        for (const key of changed) {
          const spelling = this.syncedTerms.get(key)
          if (this.forgotten.has(key) || this.own.has(key)) this.syncedTerms.delete(key)
          else if (validSyncedTerm(key, spelling)) this.learn(key, spelling)
          else if ((this.terms.get(key)?.count ?? 0) >= 2) this.terms.delete(key)
        }
        for (const key of deleted) {
          if ((this.terms.get(key)?.count ?? 0) >= 2) this.terms.delete(key)
        }
        this.prune()
        this.changed()
      }),
      this.syncedForgotten.onChange(({ added, deleted }) => {
        for (const key of added) {
          if (!validKey(key)) continue
          if (this.own.has(key)) {
            this.syncedForgotten.delete(key)
            continue
          }
          this.terms.delete(key)
          this.syncedTerms.delete(key)
          this.forgotten.delete(key)
          this.forgotten.add(key)
        }
        for (const key of deleted) this.forgotten.delete(key)
        this.pruneForgotten()
        this.changed()
      }),
    )
    this.publish()
  }

  record(text: string, vocabulary: readonly string[]): void {
    const seen = new Set<string>()
    for (const form of extractTerms(text, vocabulary)) {
      const key = form.toLowerCase()
      if (this.forgotten.has(key) || this.own.has(key)) continue
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
    for (const key of seen) {
      const term = this.terms.get(key)
      if (term && term.count >= 2 && this.syncedTerms.get(key) !== surface(term))
        this.syncedTerms.set(key, surface(term))
    }
    this.changed()
  }

  vocabulary(request: readonly string[], limit = 300): string[] {
    const existing = new Set<string>()
    const words: string[] = []
    let kept = 0
    const append = (word: string, bounded: boolean): void => {
      const key = word.normalize('NFC').trim().toLowerCase()
      if (!key || existing.has(key) || (bounded && kept >= limit)) return
      existing.add(key)
      words.push(word)
      if (bounded) kept++
    }
    for (const word of [...this.own.values()].reverse()) append(word, true)
    for (const word of request) append(word, false)
    for (const term of this.learned()) append(surface(term), true)
    return words
  }

  add(text: string): void {
    const spelling = text.normalize('NFC').trim()
    const key = spelling.toLowerCase()
    if (!validSyncedTerm(key, spelling) || this.own.has(key)) return
    this.own.set(key, spelling)
    this.syncedOwn.set(key, spelling)
    this.terms.delete(key)
    this.syncedTerms.delete(key)
    this.forgotten.delete(key)
    this.syncedForgotten.delete(key)
    this.changed()
  }

  forget(key: string): void {
    if (!this.terms.has(key) && !this.own.has(key)) return
    this.own.delete(key)
    this.syncedOwn.delete(key)
    this.terms.delete(key)
    this.syncedTerms.delete(key)
    this.forgotten.add(key)
    this.pruneForgotten()
    this.syncedForgotten.add(key)
    this.changed()
  }

  clear(): void {
    this.own.clear()
    this.syncedOwn.clear()
    this.terms.clear()
    this.forgotten.clear()
    this.syncedTerms.clear()
    this.syncedForgotten.clear()
    this.changed()
  }

  dispose(): Promise<void> {
    for (const unlisten of this.unlisten) unlisten()
    this.unlisten = []
    return this.file.dispose()
  }

  query(search: string, cursor: string | null, limit: number): PluginViewPage {
    const matches = this.items().filter((item) =>
      item.text.toLowerCase().includes(search.toLowerCase()),
    )
    const offset = cursor === null ? 0 : Number(cursor)
    const page = matches.slice(offset, offset + limit)
    const next = offset + page.length
    return {
      items: page,
      cursor: next < matches.length ? String(next) : null,
    }
  }

  private learned(): Term[] {
    return [...this.terms.values()]
      .filter((term) => term.count >= 2)
      .sort((a, b) => b.count - a.count || b.time - a.time || a.key.localeCompare(b.key))
  }

  private prune(): void {
    const recent = this.learned().sort((a, b) => b.time - a.time)
    for (const term of recent.slice(300)) {
      this.terms.delete(term.key)
      this.syncedTerms.delete(term.key)
    }
  }

  private pruneForgotten(sync = true): void {
    while (this.forgotten.size > 1000) {
      const oldest = this.forgotten.values().next().value!
      this.forgotten.delete(oldest)
      if (sync) this.syncedForgotten.delete(oldest)
    }
  }

  private learn(key: string, spelling: string): void {
    if (this.own.has(key)) return
    const previous = this.terms.get(key)
    if (previous && previous.count >= 2 && surface(previous) === spelling) return
    const count = Math.max(2, previous?.count ?? 0)
    this.terms.set(key, {
      key,
      count,
      time: previous?.time ?? Date.now(),
      forms: {
        ...previous?.forms,
        [spelling]: Math.max(0, ...Object.values(previous?.forms ?? {})) + 1,
      },
    })
  }

  private reconcile(): void {
    this.forgotten = new Set(this.syncedForgotten.values().filter(validKey))
    for (const key of this.own.keys()) {
      this.terms.delete(key)
      this.syncedTerms.delete(key)
      this.forgotten.delete(key)
      this.syncedForgotten.delete(key)
    }
    this.pruneForgotten()
    for (const [key, term] of this.terms) {
      if (
        this.forgotten.has(key) ||
        (term.count >= 2 && !validSyncedTerm(key, this.syncedTerms.get(key)))
      )
        this.terms.delete(key)
    }
    for (const [key, spelling] of this.syncedTerms.entries()) {
      if (this.forgotten.has(key) || this.own.has(key)) this.syncedTerms.delete(key)
      else if (validSyncedTerm(key, spelling)) this.learn(key, spelling)
    }
    this.prune()
  }

  private changed(): void {
    this.publish()
    this.migrated = true
    this.save()
  }

  private save(): void {
    this.file.write({
      terms: [...this.terms.values()],
      own: [...this.own.values()],
      forgotten: [...this.forgotten],
      migrated: this.migrated,
    })
  }

  private publish(): void {
    const items = this.items()
    this.setView('memory', {
      items: items.slice(0, 20),
      total: items.length,
      empty: 'view.memory.empty',
    })
  }

  private items(): PluginViewPage['items'] {
    return [
      ...[...this.own].reverse().map(([id, text]) => ({ id, text })),
      ...this.learned()
        .sort((a, b) => b.time - a.time || a.key.localeCompare(b.key))
        .map((term) => this.item(term)),
    ]
  }

  private item(term: Term): PluginViewPage['items'][number] {
    const strings: Record<string, string> = catalogs[this.locale] ?? en
    const plurals = new Intl.PluralRules(this.locale)
    const numbers = new Intl.NumberFormat(this.locale)
    return {
      id: term.key,
      text: surface(term),
      automatic: true,
      detail: (
        strings[`memory.heard.${plurals.select(term.count)}`] ?? strings['memory.heard.other']!
      ).replace('{count}', numbers.format(term.count)),
    }
  }
}
