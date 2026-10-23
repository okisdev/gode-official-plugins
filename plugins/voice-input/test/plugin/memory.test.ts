import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginManifestSchema, pluginViewDataSchemas, type HostMessage } from '@gode/plugin-sdk'
import type { PluginContext, SetPluginView } from '@gode/plugin-sdk/plugin'
import { afterEach, expect, test, vi } from '@gode/plugin-sdk/test'
import {
  emptyStores,
  manifest,
  model,
  noise,
  pcm,
  settings,
  testSynced,
} from '../fixtures/index.ts'

const disk = {
  fail: '',
  hold: '',
  failed: false,
  release: undefined as (() => void) | undefined,
}
vi.doMock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const path = typeof args[0] === 'string' ? args[0] : ''
      if (disk.hold && path.endsWith(disk.hold)) {
        disk.hold = ''
        await new Promise<void>((resolve) => {
          disk.release = resolve
        })
      }
      if (disk.fail && path.endsWith(disk.fail)) {
        disk.fail = ''
        disk.failed = true
        throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      }
      return actual.writeFile(...args)
    },
  }
})

const { LocalEngine } = await import('../../src/models/engine.ts')
const { createVoicePlugin } = await import('../../src/plugin.ts')

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  disk.release?.()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  disk.fail = ''
  disk.hold = ''
  disk.failed = false
  disk.release = undefined
})

async function setup(
  options: {
    local?: boolean
    locale?: Extract<HostMessage, { type: 'start' }>['locale']
    history?: string
    memory?: string
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'gode-voice-records-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const models = ['model.gguf', 'projector.gguf'].map((file) =>
    model(file, 'http://localhost/model', 'model bytes'),
  )
  if (options.local) {
    await mkdir(join(directory, 'models'))
    for (const entry of models)
      await writeFile(join(directory, 'models', entry.file), 'model bytes')
    vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
      work('http://localhost/v1', 'local-test-key'),
    )
  }
  if (options.history !== undefined)
    await writeFile(join(directory, 'history.json'), options.history)
  if (options.memory !== undefined) await writeFile(join(directory, 'memory.json'), options.memory)
  const response = { text: 'useComposerText', status: 200 }
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ text: response.text }), { status: response.status }),
    ),
  )
  const start: Extract<HostMessage, { type: 'start' }> = {
    type: 'start',
    settings: settings({
      engine: options.local ? 'local' : 'server',
      serverURL: 'http://localhost/v1',
    }),
    secrets: {},
    locale: options.locale ?? 'en',
    paths: { data: directory, plugin: directory },
    stores: emptyStores(),
  }
  const synced = testSynced()
  const launch = async () => {
    const setView = vi.fn<SetPluginView>()
    const log = vi.fn<PluginContext['log']>()
    const plugin = createVoicePlugin({ setStatus: () => {}, setView, log, synced }, [
      { id: 'qwen3-asr-1.7b', files: models },
    ])
    cleanups.push(() => plugin.dispose())
    await plugin.start(start)
    const view = (id: 'history' | 'memory') =>
      pluginViewDataSchemas[id === 'history' ? 'list' : 'terms'].parse(
        setView.mock.calls.findLast(([viewId]) => viewId === id)![1],
      )
    return { plugin, setView, view, log }
  }
  return { ...(await launch()), start, launch, directory, response }
}

type VoicePlugin = ReturnType<typeof createVoicePlugin>
const audio = pcm(1)
let sequence = 0

async function begin(plugin: VoicePlugin, vocabulary: readonly string[] = []) {
  const session = String(++sequence)
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session, vocabulary },
  })
  return session
}

function append(plugin: VoicePlugin, session: string, samples: Uint8Array = audio) {
  return plugin.call({
    type: 'call',
    id: 2,
    method: 'dictation.append',
    params: { session, audio: samples },
  })
}

function finish(plugin: VoicePlugin, session: string) {
  return plugin.call({ type: 'call', id: 3, method: 'dictation.finish', params: { session } })
}

async function dictate(
  plugin: VoicePlugin,
  vocabulary: readonly string[] = [],
  samples: Uint8Array = audio,
) {
  const session = await begin(plugin, vocabulary)
  await append(plugin, session, samples)
  return finish(plugin, session)
}

test('declares enabled settings and list actions, and publishes valid empty and populated views', async () => {
  const parsed = pluginManifestSchema.parse(manifest)
  expect(parsed.version).toBe('0.0.10')
  expect(parsed.groups?.find((group) => group.title === 'group.history')?.fields).toEqual([
    ...['keepHistory', 'learnTerms'].map((key) => ({
      key,
      kind: 'toggle',
      title: `${key}.title`,
      description: `${key}.description`,
      default: true,
    })),
    { key: 'syncTerms', kind: 'toggle', title: 'syncTerms.title', default: true },
  ])
  expect(parsed.stores).toEqual([
    { id: 'vocabulary', kind: 'map', title: 'sync.vocabulary', sync: 'syncTerms' },
    { id: 'terms', kind: 'map', title: 'sync.terms', sync: 'syncTerms' },
    { id: 'forgotten', kind: 'set', title: 'sync.forgotten', sync: 'syncTerms' },
  ])
  expect(parsed.actions).toEqual(
    expect.arrayContaining([
      { id: 'clearHistory', title: 'action.clearHistory', confirm: 'confirm.clearHistory' },
      { id: 'clearMemory', title: 'action.clearMemory', confirm: 'confirm.clearMemory' },
    ]),
  )
  const { plugin, setView, view, directory } = await setup()
  expect(view('history')).toEqual({ items: [], total: 0, empty: 'view.history.empty' })
  expect(view('memory')).toEqual({ items: [], total: 0, empty: 'view.memory.empty' })
  expect(await readdir(directory)).toEqual(['models'])
  await dictate(plugin)
  await dictate(plugin)
  for (const [id, data] of setView.mock.calls) {
    if (id === 'history' || id === 'memory')
      expect(
        pluginViewDataSchemas[id === 'history' ? 'list' : 'terms'].safeParse(data).success,
      ).toBe(true)
  }
  expect(view('memory').items).toEqual([
    {
      id: 'usecomposertext',
      text: 'useComposerText',
      detail: 'Heard in 2 dictations',
      automatic: true,
    },
  ])
  expect(view('history').total).toBe(2)
  expect(view('memory').total).toBe(1)
})

test('unknown dictation methods fail without finishing a live session', async () => {
  const { plugin } = await setup()
  const session = await begin(plugin)
  await expect(
    plugin.call({
      type: 'call',
      id: 2,
      method: 'dictation.unknown' as 'dictation.finish',
      params: { session },
    }),
  ).rejects.toThrow('Unknown method: dictation.unknown')
  await expect(finish(plugin, session)).resolves.toEqual({ text: '' })
})

test('saves only finished text with its recording duration, newest first, and restores it', async () => {
  const { plugin, response, directory, launch, view } = await setup()
  const now = Date.now()
  const session = await begin(plugin)
  await append(plugin, session)
  expect(view('history').items).toEqual([])
  await finish(plugin, session)
  response.text = 'Second result'
  await dictate(plugin, [], pcm(2.5))
  await plugin.dispose()
  const entries = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))
  expect(entries).toEqual([
    { id: expect.any(String), text: 'Second result', time: expect.any(Number), seconds: 2.5 },
    { id: expect.any(String), text: 'useComposerText', time: expect.any(Number), seconds: 1 },
  ])
  expect(entries[1].time).toBeGreaterThanOrEqual(now)
  expect(entries[0].id).not.toBe(entries[1].id)
  const replacement = await launch()
  expect(replacement.view('history')).toEqual(view('history'))
})

test('loaded history, learned terms and requested vocabulary never enter the log', async () => {
  const term = 'PrivateMemoryTerm'
  const { plugin, log, response, view } = await setup({
    history: JSON.stringify([
      { id: 'private-history-id', text: 'Private history entry', time: 1, seconds: 1 },
    ]),
    memory: JSON.stringify({
      terms: [{ key: term.toLowerCase(), count: 2, time: Date.now(), forms: { [term]: 2 } }],
      forgotten: [],
    }),
  })
  expect(view('memory').items[0]?.text).toBe(term)
  expect(view('history').items[0]?.text).toBe('Private history entry')
  expect(log).not.toHaveBeenCalled()
  response.text = 'Private finished transcript'
  await expect(dictate(plugin, ['PrivateVocabulary'])).resolves.toEqual({ text: response.text })
  const body = vi.mocked(fetch).mock.calls[0]![1]!.body as FormData
  expect(body.get('prompt')).toBe(`PrivateVocabulary, ${term}`)
  expect(log.mock.calls).toEqual([
    [
      'info',
      expect.stringMatching(
        /^Dictation finished: 1\.00 s audio, 0 segments before stop, recognition \d+\.\d{2} s, polish skipped$/,
      ),
    ],
  ])
  expect(JSON.stringify(log.mock.calls).toLowerCase()).not.toContain('private')
})

test('keeps the newest 10,000 dictations and evicts the oldest', async () => {
  const history = JSON.stringify(
    Array.from({ length: 10_001 }, (_, index) => ({
      id: String(index),
      text: `recording ${index}`,
      time: index,
      seconds: 1,
    })),
  )
  const { plugin, response, view, directory } = await setup({ history })
  expect(view('history').items).toHaveLength(20)
  expect(view('history').total).toBe(10_000)
  expect(view('history').items[0]?.text).toBe('recording 10000')
  expect(view('history').items.at(-1)?.text).toBe('recording 9981')
  response.text = 'newest recording'
  await dictate(plugin)
  expect(view('history').total).toBe(10_000)
  await plugin.dispose()
  const stored = JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))
  expect(stored).toHaveLength(10_000)
  expect(stored[0].text).toBe('newest recording')
  expect(stored.at(-1).text).toBe('recording 2')
})

test('pages history newest first, searches without case, and deletes an entry from a later page', async () => {
  const history = JSON.stringify(
    Array.from({ length: 55 }, (_, index) => ({
      id: String(index),
      text: `${index % 2 ? 'Beta' : 'Alpha'} recording ${index}`,
      time: index,
      seconds: 1,
    })),
  )
  const { plugin, view } = await setup({ history })
  const query = (search: string, cursor: string | null, limit: number, list = 'history') =>
    plugin.query({ type: 'query', id: 1, view: list, search, cursor, limit })
  expect(view('history').total).toBe(55)
  expect(view('history').items).toHaveLength(20)
  const first = await query('', null, 20)
  const second = await query('', first.cursor, 20)
  const last = await query('', second.cursor, 20)
  expect([first.cursor, second.cursor, last.cursor]).toEqual(['20', '40', null])
  expect([...first.items, ...second.items, ...last.items].map((item) => item.id)).toEqual(
    Array.from({ length: 55 }, (_, index) => String(54 - index)),
  )
  expect(await query('', '999', 20)).toEqual({ items: [], cursor: null })
  const matches = await query('aLpHa', null, 10)
  expect(matches.items).toHaveLength(10)
  expect(matches.cursor).toBe('10')
  expect((await query('aLpHa', matches.cursor, 30)).items).toHaveLength(18)
  expect(await query('not present', null, 20)).toEqual({ items: [], cursor: null })
  const deep = last.items[0]!.id
  await plugin.action('deleteEntry', deep)
  expect(view('history').total).toBe(54)
  expect((await query('', '40', 20)).items.map((item) => item.id)).not.toContain(deep)
  expect(() => query('', null, 20, 'unknown')).toThrow('Unknown view: unknown')
})

test('pages learned terms newest first and searches their text without case', async () => {
  const memory = JSON.stringify({
    terms: Array.from({ length: 25 }, (_, index) => ({
      key: `term${index}`,
      count: 26 - index,
      time: index,
      forms: { [`Term${index}`]: 26 - index },
    })),
    forgotten: [],
  })
  const { plugin, view } = await setup({ memory })
  const query = (search: string, cursor: string | null, limit: number) =>
    plugin.query({ type: 'query', id: 1, view: 'memory', search, cursor, limit })
  expect(view('memory').total).toBe(25)
  expect(view('memory').items).toHaveLength(20)
  const first = await query('', null, 10)
  const second = await query('', first.cursor, 10)
  const last = await query('', second.cursor, 10)
  expect([first.cursor, second.cursor, last.cursor]).toEqual(['10', '20', null])
  expect([...first.items, ...second.items, ...last.items].map((item) => item.id)).toEqual(
    Array.from({ length: 25 }, (_, index) => `term${24 - index}`),
  )
  expect((await query('TERM2', null, 10)).items.map((item) => item.id)).toEqual([
    'term24',
    'term23',
    'term22',
    'term21',
    'term20',
    'term2',
  ])
  expect(await query('', '999', 10)).toEqual({ items: [], cursor: null })
})

test('turning history off stops saving, keeps existing entries, and allows delete and clear actions', async () => {
  const { plugin, start, view, directory, launch } = await setup()
  await dictate(plugin)
  await dictate(plugin)
  const entries = view('history').items
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: settings({ ...start.settings, keepHistory: false }),
  })
  await dictate(plugin)
  expect(view('history').items).toEqual(entries)
  await plugin.action('deleteEntry')
  await plugin.action('deleteEntry', 'missing')
  expect(view('history').items).toEqual(entries)
  await plugin.action('deleteEntry', entries[1]!.id)
  expect(view('history').items).toEqual([entries[0]])
  await plugin.dispose()
  const replacement = await launch()
  expect(replacement.view('history').items).toEqual([entries[0]])
  await replacement.plugin.action('clearHistory')
  expect(replacement.view('history').items).toEqual([])
  await replacement.plugin.dispose()
  expect(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))).toEqual([])
})

test.each(['', ' \n ', 'Um, uh.'])(
  'empty cleaned text creates neither history nor memory: %j',
  async (text) => {
    const { plugin, response, view, directory } = await setup()
    response.text = text
    await expect(dictate(plugin)).resolves.toEqual({ text: '' })
    await plugin.dispose()
    expect(view('history').items).toEqual([])
    expect(view('memory').items).toEqual([])
    expect(await readdir(directory)).toEqual(['models'])
  },
)

test.each([Buffer.alloc(32000), noise(1), new Uint8Array()])(
  'no-speech recordings create neither store',
  async (samples) => {
    const { plugin, directory } = await setup()
    await expect(dictate(plugin, [], samples)).resolves.toEqual({ text: '' })
    expect(fetch).not.toHaveBeenCalled()
    await plugin.dispose()
    expect(await readdir(directory)).toEqual(['models'])
  },
)

test('previews, cancellation and failed final recognition do not save or learn', async () => {
  const { plugin, response, view, directory } = await setup({ local: true })
  const session = await begin(plugin)
  await expect(append(plugin, session)).resolves.toEqual({ text: 'useComposerText' })
  await plugin.call({ type: 'call', id: 4, method: 'dictation.cancel', params: { session } })
  response.status = 503
  await expect(dictate(plugin, [], pcm(0.8))).rejects.toMatchObject({
    text: { message: 'error.recognition' },
  })
  await plugin.dispose()
  expect(view('history').items).toEqual([])
  expect(view('memory').items).toEqual([])
  expect(await readdir(directory)).toEqual(['models'])
})

test.each(['history', 'memory'])(
  '%s write failure never fails dictation and later writes retain all changes',
  async (name) => {
    const { plugin, view, directory } = await setup()
    disk.fail = `${name}.json.tmp`
    await expect(dictate(plugin)).resolves.toEqual({ text: 'useComposerText' })
    await vi.waitFor(() => expect(disk.failed).toBe(true))
    await expect(dictate(plugin)).resolves.toEqual({ text: 'useComposerText' })
    expect(view('history').items).toHaveLength(2)
    expect(view('memory').items[0]?.detail).toBe('Heard in 2 dictations')
    await plugin.dispose()
    const stored = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
    if (name === 'history') expect(stored).toHaveLength(2)
    else expect(stored.terms[0].count).toBe(2)
    expect((await readdir(directory)).some((file) => file.endsWith('.tmp'))).toBe(false)
  },
)

test.each(['history', 'memory'])(
  'a pending %s write does not delay dictation or lose concurrent changes',
  async (name) => {
    const { plugin, directory, view } = await setup()
    disk.hold = `${name}.json.tmp`
    await expect(dictate(plugin)).resolves.toEqual({ text: 'useComposerText' })
    await vi.waitFor(() => expect(disk.release).toBeTypeOf('function'))
    await Promise.all([dictate(plugin), dictate(plugin)])
    expect(view('history').items).toHaveLength(3)
    expect(view('memory').items[0]?.detail).toBe('Heard in 3 dictations')
    disk.release!()
    await plugin.dispose()
    const stored = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
    if (name === 'history') expect(stored).toHaveLength(3)
    else expect(stored.terms[0].count).toBe(3)
  },
)

test('learning can be stopped while existing memory is used, forgotten across restart, and cleared', async () => {
  const { plugin, response, start, view, launch } = await setup()
  await dictate(plugin)
  await dictate(plugin)
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: settings({ ...start.settings, learnTerms: false }),
  })
  response.text = 'use composer text and newIdentifier'
  await expect(dictate(plugin)).resolves.toEqual({ text: 'useComposerText and newIdentifier' })
  await dictate(plugin)
  expect(view('memory').items).toHaveLength(1)
  expect(view('memory').items[0]?.detail).toBe('Heard in 2 dictations')
  await plugin.action('forgetTerm', view('memory').items[0]!.id)
  await plugin.dispose()
  const replacement = await launch()
  response.text = 'useComposerText'
  await dictate(replacement.plugin)
  await dictate(replacement.plugin)
  expect(replacement.view('memory').items).toEqual([])
  await replacement.plugin.action('clearMemory')
  await dictate(replacement.plugin)
  expect(replacement.view('memory').items).toEqual([])
  await dictate(replacement.plugin)
  expect(replacement.view('memory').items[0]?.text).toBe('useComposerText')
})

test.each([true, false])(
  'learned terms reach recognition with request vocabulary (local: %s)',
  async (local) => {
    const { plugin, response } = await setup({ local })
    response.text =
      Array.from({ length: 55 }, (_, index) => `term${index}`).join(' ') + ' useComposerText'
    await dictate(plugin)
    await dictate(plugin)
    response.text = 'use composer text and G O D E'
    const words = (
      await plugin.query({
        type: 'query',
        id: 1,
        view: 'memory',
        search: '',
        cursor: null,
        limit: 100,
      })
    ).items.map((item) => item.text)
    const request = ['Gode', words[0]!.toUpperCase()]
    await expect(dictate(plugin, request)).resolves.toEqual({ text: 'useComposerText and Gode' })
    const body = vi.mocked(fetch).mock.calls.at(-1)![1]!.body as FormData
    if (local) expect(body.has('prompt')).toBe(false)
    else {
      expect(body.get('prompt')).toBe([...request, ...words.slice(1, 51)].join(', '))
      expect((body.get('prompt') as string).split(', ')).toHaveLength(52)
    }
  },
)

test.each(['en', 'de', 'zh-Hans', 'zh-Hant'] as const)(
  'formats recording lengths in %s',
  async (locale) => {
    const stored = JSON.stringify([
      { id: 'minute', text: 'Long recording', time: 2, seconds: 65 },
      { id: 'second', text: 'Short recording', time: 1, seconds: 4 },
    ])
    const { view } = await setup({ locale, history: stored })
    const unit = (value: number, name: string) =>
      new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(
        value,
      )
    expect(view('history').items.map((item) => item.detail)).toEqual([
      `${unit(1, 'minute')} ${unit(5, 'second')}`,
      unit(4, 'second'),
    ])
  },
)

test('retains full long transcriptions on disk while publishing within SDK bounds', async () => {
  const { plugin, response, view, directory } = await setup()
  response.text = 'hello world '.repeat(2000).trim()
  await dictate(plugin)
  expect(view('history').items[0]?.text).toHaveLength(10_000)
  await plugin.dispose()
  expect(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))[0].text).toBe(
    response.text,
  )
})

test.each(['{invalid', 'null', '[{}]', '[{"id":"a","text":"x","seconds":-1,"time":0}]'])(
  'corrupt history starts empty and can be replaced: %s',
  async (history) => {
    const { plugin, view } = await setup({ history })
    expect(view('history').items).toEqual([])
    await dictate(plugin)
    expect(view('history').items).toHaveLength(1)
  },
)
