import { locales } from '@gode/format'
import { catalogMistakes } from '@gode/format/typography'
import { describe, expect, it } from 'vitest'
import manifest from '../manifest.json'

const english = manifest.strings.en
const translatedLocales = locales.filter((locale) => locale !== 'en')
const placeholders = (value: string) => [...new Set(value.match(/\{[^{}]+\}/gu) ?? [])].sort()

describe('Python manifest strings', () => {
  it('has a catalog for every supported locale', () => {
    expect(Object.keys(manifest.strings).sort()).toEqual([...locales].sort())
  })

  describe.each(translatedLocales)('%s', (locale) => {
    const catalog = manifest.strings[locale]

    it('has exactly the English keys', () => {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort())
    })

    it('keeps the placeholders for every key', () => {
      for (const [key, value] of Object.entries(english)) {
        expect(placeholders(catalog[key as keyof typeof catalog]), key).toEqual(placeholders(value))
      }
    })

    it('passes the catalog typography rules', () => {
      for (const [rule, found] of Object.entries(catalogMistakes(locale, english, catalog))) {
        expect(found, rule).toEqual([])
      }
    })
  })
})
