import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginManifestSchema, pluginViewDataSchemas, type HostMessage } from '@gode/plugin-sdk'
import type { SetPluginView } from '@gode/plugin-sdk/plugin'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import { LocalEngine } from './engine'
import { createVoicePlugin } from './plugin'
import { model, noise, pcm } from './test-fixtures'

const disk = vi.hoisted(() => ({
  fail: '',
  hold: '',
  failed: false,
  release: undefined as (() => void) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
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
      work('http://localhost/v1'),
    )
  }
  if (options.history !== undefined)
    await writeFile(join(directory, 'history.json'), options.history)
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
    settings: { engine: options.local ? 'local' : 'server', serverURL: 'http://localhost/v1' },
    secrets: {},
    locale: options.locale ?? 'en',
    paths: { data: directory, plugin: directory },
  }
  const launch = async () => {
    const setView = vi.fn<SetPluginView>()
    const plugin = createVoicePlugin(() => {}, setView, models)
    cleanups.push(() => plugin.dispose())
    await plugin.start(start)
    const view = (id: 'history' | 'memory') =>
      pluginViewDataSchemas.list.parse(setView.mock.calls.findLast(([viewId]) => viewId === id)![1])
    return { plugin, setView, view }
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
  expect(parsed.version).toBe('0.0.6')
  expect(parsed.groups?.find((group) => group.title === 'group.history')?.fields).toEqual(
    ['keepHistory', 'learnTerms'].map((key) => ({
      key,
      kind: 'toggle',
      title: `${key}.title`,
      description: `${key}.description`,
      default: true,
    })),
  )
  expect(parsed.actions).toEqual(
    expect.arrayContaining([
      { id: 'clearHistory', title: 'action.clearHistory' },
      { id: 'clearMemory', title: 'action.clearMemory' },
    ]),
  )
  const { plugin, setView, view, directory } = await setup()
  expect(view('history')).toEqual({ items: [], empty: 'view.history.empty' })
  expect(view('memory')).toEqual({ items: [], empty: 'view.memory.empty' })
  expect(await readdir(directory)).toEqual(['models'])
  await dictate(plugin)
  await dictate(plugin)
  for (const [id, data] of setView.mock.calls) {
    if (id === 'history' || id === 'memory')
      expect(pluginViewDataSchemas.list.safeParse(data).success).toBe(true)
  }
  expect(view('memory').items).toEqual([
    { id: 'usecomposertext', text: 'useComposerText', detail: 'Heard in 2 dictations' },
  ])
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

test('keeps only the newest 200 dictations', async () => {
  const { plugin, response, view, directory } = await setup()
  for (let index = 0; index < 203; index++) {
    response.text = `recording ${index}`
    await dictate(plugin)
  }
  expect(view('history').items).toHaveLength(200)
  expect(view('history').items[0]?.text).toBe('recording 202')
  expect(view('history').items.at(-1)?.text).toBe('recording 3')
  await plugin.dispose()
  expect(JSON.parse(await readFile(join(directory, 'history.json'), 'utf8'))).toHaveLength(200)
})

test('turning history off stops saving, keeps existing entries, and allows delete and clear actions', async () => {
  const { plugin, start, view, directory, launch } = await setup()
  await dictate(plugin)
  await dictate(plugin)
  const entries = view('history').items
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { ...start.settings, keepHistory: false },
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
    settings: { ...start.settings, learnTerms: false },
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
    const { plugin, response, view } = await setup({ local })
    response.text =
      Array.from({ length: 55 }, (_, index) => `term${index}`).join(' ') + ' useComposerText'
    await dictate(plugin)
    await dictate(plugin)
    response.text = 'use composer text and G O D E'
    const words = view('memory').items.map((item) => item.text)
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
  response.text = 'hello '.repeat(2000).trim()
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
