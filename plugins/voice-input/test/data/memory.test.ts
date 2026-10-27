import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginViewDataSchemas } from '@gode/plugin-sdk'
import type { SetPluginView } from '@gode/plugin-sdk/plugin'
import { afterEach, expect, test, vi } from '@gode/plugin-sdk/test'
import { VoiceMemory } from '../../src/data/memory.ts'
import { extractTerms } from '../../src/data/memory-logic.ts'
import { testSynced } from '../fixtures/index.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function setup(locale = 'en', stored?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'gode-voice-memory-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  if (stored !== undefined) await writeFile(join(directory, 'memory.json'), stored)
  const setView = vi.fn<SetPluginView>()
  const synced = testSynced()
  const memory = new VoiceMemory(directory, locale, setView, synced)
  cleanups.push(() => memory.dispose())
  await memory.read()
  const view = (id: 'memory' | 'suggestions' = 'suggestions') => {
    const data = setView.mock.calls.findLast(([viewId]) => viewId === id)![1]
    return pluginViewDataSchemas[id === 'memory' ? 'terms' : 'list'].parse(data)
  }
  return { memory, directory, setView, view, synced }
}

test.each([
  ['用 whisper 和 Gode 写代码', [], ['whisper', 'Gode']],
  ['使用café还有naïve，和 api', [], ['café', 'naïve', 'api']],
  ['日本語でwhisperを使う', [], ['whisper']],
  ['한국어로 whisper 사용', [], ['whisper']],
  [
    'useComposerText PascalCase snake_case kebab-case file.ts gpt4 4o',
    [],
    ['useComposerText', 'PascalCase', 'snake_case', 'kebab-case', 'file.ts', 'gpt4', '4o'],
  ],
  ['API GPU UI HTTP', [], ['API', 'GPU', 'UI', 'HTTP']],
  ['I work with Alice and Zürich. Bob uses Graphite! Carol visits Berlin?', [], []],
  ['Today, we test code with use Composer text in the Agent Doc project.', [], []],
  ['“Alice” said hello.\n(Bob) spoke. “Carol” spoke.', [], []],
  ['中文 the AND This was with from have your about would please just one 123 3.14', [], []],
  ['123 456 3.14 2026', [], []],
  ['中文 an to go ox abc café', [], ['abc', 'café']],
  [
    '中文 WHISPER API useComposerText file.ts',
    ['whisper', 'api', 'usecomposertext', 'FILE.TS'],
    [],
  ],
  ['中文 Cafe\u0301', ['Café'], []],
  ['ordinary lowercase words without mixed script', [], []],
] as const)('extracts candidates from %s', (text, vocabulary, expected) => {
  expect(extractTerms(text, vocabulary)).toEqual(expected)
})

test('counts separate dictations, retains the most frequent spelling and excludes request vocabulary', async () => {
  const { memory, view, directory, synced } = await setup()
  memory.record('中文 Gode Gode GODE API', ['API'])
  expect(view().items).toEqual([])
  await memory.dispose()
  const replacement = new VoiceMemory(directory, 'en', () => {}, synced)
  cleanups.push(() => replacement.dispose())
  await replacement.read()
  expect(replacement.vocabulary([])).toEqual([])
  replacement.record('中文 GODE', [])
  expect(replacement.vocabulary([])).toEqual([])
  replacement.record('中文 GODE GODE', [])
  expect(replacement.vocabulary([])).toEqual([])
  expect(replacement.query('suggestions', '', null, 10).items).toEqual([
    { id: 'gode', text: 'GODE', time: expect.any(Number), detail: 'Heard in 3 dictations' },
  ])
  expect(replacement.vocabulary(['gode'])).toEqual(['gode'])
  await replacement.dispose()
  expect(JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8'))).toMatchObject({
    terms: [{ key: 'gode', count: 3, forms: { Gode: 2, GODE: 4 } }],
  })
})

test('handles surface forms that are also object property names', async () => {
  const { memory, view } = await setup()
  memory.record('中文 constructor toString', [])
  memory.record('中文 constructor toString', [])
  expect(view().items.map((item) => item.text)).toEqual(['constructor', 'toString'])
  await memory.dispose()
})

test('evicts the least recently heard learned term, regardless of count', async () => {
  let time = 1
  vi.spyOn(Date, 'now').mockImplementation(() => time++)
  const { memory, view, synced } = await setup()
  for (let index = 0; index < 300; index++) {
    memory.record(`term${index}`, [])
    memory.record(`term${index}`, [])
  }
  memory.record('term0', [])
  memory.record('term300', [])
  memory.record('term300', [])
  const words = view().items.map((item) => item.text)
  expect(words).toHaveLength(20)
  expect(view().total).toBe(300)
  expect(words).toContain('term0')
  expect(memory.query('suggestions', '', null, 100).items.map((item) => item.text)).toContain(
    'term300',
  )
  expect(memory.query('suggestions', '', null, 100).items.map((item) => item.text)).not.toContain(
    'term1',
  )
  expect(words[0]).toBe('term300')
  expect(synced('terms').has('term1')).toBe(false)
  expect(synced('terms').size).toBe(300)
}, 30000)

test('migration keeps the newest 1,000 forgotten terms in the store', async () => {
  const forgotten = Array.from({ length: 1001 }, (_, index) => `term${index}`)
  const { memory, synced } = await setup('en', JSON.stringify({ terms: [], forgotten }))
  expect(synced('forgotten').size).toBe(1000)
  expect(synced('forgotten').has('term0')).toBe(false)
  expect(synced('forgotten').has('term1000')).toBe(true)
  await memory.dispose()
})

test('forgetting a new term evicts the oldest forgotten term before adding it', async () => {
  const forgotten = Array.from({ length: 1000 }, (_, index) => `term${index}`)
  const { memory, synced } = await setup('en', JSON.stringify({ terms: [], forgotten }))
  memory.record('term1000', [])
  memory.record('term1000', [])
  memory.forget('term1000')
  expect(synced('forgotten').size).toBe(1000)
  expect(synced('forgotten').has('term0')).toBe(false)
  expect(synced('forgotten').has('term1000')).toBe(true)
})

test('forgetting survives restart and clear removes candidates and the forgotten set', async () => {
  const { memory, directory, view, synced } = await setup()
  memory.record('useComposerText API', [])
  memory.record('useComposerText', [])
  memory.forget(view().items[0]!.id)
  expect(view().items).toEqual([])
  await memory.dispose()
  const replacement = new VoiceMemory(directory, 'en', () => {}, synced)
  cleanups.push(() => replacement.dispose())
  await replacement.read()
  replacement.record('useComposerText USECOMPOSERTEXT', [])
  replacement.record('useComposerText', [])
  expect(replacement.vocabulary([])).toEqual([])
  replacement.clear()
  replacement.record('API useComposerText', [])
  expect(replacement.vocabulary([])).toEqual([])
  replacement.record('useComposerText', [])
  expect(replacement.vocabulary([])).toEqual([])
  expect(replacement.query('suggestions', '', null, 10).items[0]?.text).toBe('useComposerText')
  await replacement.dispose()
  expect(JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8')).forgotten).toEqual([])
})

test('added words win over learned terms, deduplicate, and survive restart', async () => {
  const { memory, directory, view, synced } = await setup()
  memory.record('useComposerText', [])
  memory.record('useComposerText', [])
  memory.add('  UseComposerText  ')
  memory.add('usecomposertext')
  expect(view('memory').items).toEqual([{ id: 'usecomposertext', text: 'UseComposerText' }])
  expect(view().items).toEqual([])
  expect(synced('terms').has('usecomposertext')).toBe(false)
  expect(synced('vocabulary').entries()).toEqual([['usecomposertext', 'UseComposerText']])
  memory.record('useComposerText', [])
  memory.record('useComposerText', [])
  expect(view('memory').items).toEqual([{ id: 'usecomposertext', text: 'UseComposerText' }])
  await memory.dispose()
  expect(JSON.parse(await readFile(join(directory, 'memory.json'), 'utf8')).own).toEqual([
    'UseComposerText',
  ])
  const replacement = new VoiceMemory(directory, 'en', () => {}, synced)
  cleanups.push(() => replacement.dispose())
  await replacement.read()
  expect(replacement.vocabulary([])).toEqual(['UseComposerText'])
})

test('accept moves a suggestion into own words and vocabulary', async () => {
  const { memory, view } = await setup()
  memory.record('useComposerText', [])
  memory.record('useComposerText', [])
  const suggestion = view().items[0]!
  expect(memory.vocabulary([])).toEqual([])
  memory.accept(suggestion.id)
  expect(view().items).toEqual([])
  expect(view('memory').items).toEqual([{ id: suggestion.id, text: suggestion.text }])
  expect(memory.vocabulary([])).toEqual(['useComposerText'])
})

test('removing a person word prevents relearning until it is added again', async () => {
  const { memory, view, synced } = await setup()
  memory.add('Gode')
  memory.forget('gode')
  expect(view().items).toEqual([])
  expect(synced('vocabulary').size).toBe(0)
  expect(synced('forgotten').has('gode')).toBe(true)
  memory.record('Gode', [])
  memory.record('Gode', [])
  expect(view().items).toEqual([])
  memory.add('  GODE  ')
  expect(view('memory').items).toEqual([{ id: 'gode', text: 'GODE' }])
  expect(synced('forgotten').has('gode')).toBe(false)
  memory.clear()
  expect(view().items).toEqual([])
  expect(synced('vocabulary').size).toBe(0)
})

test('vocabulary places person words before request words without learned terms or duplicates', async () => {
  const { memory, view } = await setup()
  memory.add('Gode')
  memory.add('SwiftUI')
  let now = 1
  vi.spyOn(Date, 'now').mockImplementation(() => now++)
  memory.record('useComposerText', [])
  memory.record('useComposerText', [])
  memory.record('API', [])
  memory.record('API', [])
  expect(memory.vocabulary(['gode', 'Custom', 'CUSTOM', 'usecomposertext'])).toEqual([
    'SwiftUI',
    'Gode',
    'Custom',
    'usecomposertext',
  ])
  expect(memory.vocabulary(['Custom'], 1)).toEqual(['SwiftUI', 'Custom'])
  expect(view('memory').items).toEqual([
    { id: 'swiftui', text: 'SwiftUI' },
    { id: 'gode', text: 'Gode' },
  ])
  expect(view().items).toEqual([
    { id: 'api', text: 'API', time: expect.any(Number), detail: 'Heard in 2 dictations' },
    {
      id: 'usecomposertext',
      text: 'useComposerText',
      time: expect.any(Number),
      detail: 'Heard in 2 dictations',
    },
  ])
  expect(memory.query('memory', 'go', null, 10).items).toEqual([{ id: 'gode', text: 'Gode' }])
})

test.each([
  ['en', 2, 'Heard in 2 dictations'],
  ['de', 2, 'In 2 Diktaten gehört'],
  ['es', 2, 'Escuchado en 2 dictados'],
  ['fr', 2, 'Entendu dans 2 dictées'],
  ['ja', 2, '2回の音声入力で使用'],
  ['ko', 2, '받아쓰기 2회에서 사용'],
  ['pt-BR', 2, 'Ouvido em 2 ditados'],
  ['ru', 2, 'Встречается в 2 диктовках'],
  ['ru', 5, 'Встречается в 5 диктовках'],
  ['ru', 21, 'Встречается в 21 диктовке'],
  ['zh-Hans', 2, '在 2 次听写中出现'],
  ['zh-Hant', 2, '在 2 次聽寫中出現'],
] as const)(
  'localizes suggestion counts in %s for %s dictations',
  async (locale, count, expected) => {
    const { memory, view, setView } = await setup(locale)
    for (let index = 0; index < count; index++) memory.record('API', [])
    expect(view().items).toEqual([
      { id: 'api', text: 'API', time: expect.any(Number), detail: expected },
    ])
    for (const [id, data] of setView.mock.calls) {
      expect(['memory', 'suggestions']).toContain(id)
      expect(
        pluginViewDataSchemas[id === 'memory' ? 'terms' : 'list'].safeParse(data).success,
      ).toBe(true)
    }
  },
)

test.each([
  '{invalid',
  'null',
  '{"terms":[]}',
  '{"terms":[{}],"forgotten":[]}',
  '{"terms":[],"forgotten":[1]}',
])('corrupt memory starts empty: %s', async (stored) => {
  const { memory, view } = await setup('en', stored)
  expect(view('memory')).toEqual({ items: [], total: 0, empty: 'view.memory.empty' })
  expect(view()).toEqual({ items: [], total: 0, empty: 'view.suggestions.empty' })
  memory.record('API', [])
  memory.record('API', [])
  expect(view().items[0]?.text).toBe('API')
})

test('caps restored learned terms and rejects terms whose ids exceed the list contract', async () => {
  const terms = Array.from({ length: 301 }, (_, index) => ({
    key: `term${index}`,
    count: 2,
    time: index,
    forms: { [`term${index}`]: 2 },
  }))
  const { memory, view } = await setup('en', JSON.stringify({ terms, forgotten: [] }))
  expect(view().items).toHaveLength(20)
  expect(view().total).toBe(300)
  expect(memory.vocabulary([])).not.toContain('term0')
  const long = `gpt${'4'.repeat(201)}`
  expect(extractTerms(long, [])).toEqual([])
})
