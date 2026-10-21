import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginManifestSchema, pluginViewDataSchemas, type HostMessage } from '@gode/plugin-sdk'
import type { SetPluginView } from '@gode/plugin-sdk/plugin'
import { afterEach, expect, test, vi } from '@gode/plugin-sdk/test'
import { manifest, model, noise, pcm, wav, settings } from '../fixtures/index.ts'

const disk = {
  failNext: false,
  failed: false,
  holdNext: false,
  release: undefined as (() => void) | undefined,
}
vi.doMock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (disk.holdNext && typeof args[0] === 'string' && args[0].endsWith('stats.json.tmp')) {
        disk.holdNext = false
        await new Promise<void>((resolve) => {
          disk.release = resolve
        })
      }
      if (disk.failNext && typeof args[0] === 'string' && args[0].endsWith('stats.json.tmp')) {
        disk.failNext = false
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
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  disk.failNext = false
  disk.failed = false
  disk.holdNext = false
  disk.release = undefined
})

async function setup(
  listener: typeof fetch = async () => new Response('{}'),
  options: { local?: boolean; stored?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gode-voice-usage-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'data')
  vi.stubGlobal('fetch', vi.fn(listener))
  const models = ['model.gguf', 'projector.gguf'].map((file) =>
    model(file, 'http://127.0.0.1/model', 'model bytes'),
  )
  if (options.local) {
    await mkdir(join(directory, 'models'), { recursive: true })
    for (const entry of models)
      await writeFile(join(directory, 'models', entry.file), 'model bytes')
  }
  if (options.stored !== undefined) {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'stats.json'), options.stored)
  }
  const setView = vi.fn<SetPluginView>()
  const plugin = createVoicePlugin({ setStatus: () => {}, setView, log: () => {} }, [
    { id: 'qwen3-asr-1.7b', files: models },
  ])
  cleanups.push(() => plugin.dispose())
  const start: Extract<HostMessage, { type: 'start' }> = {
    type: 'start',
    settings: settings({
      engine: options.local ? 'local' : 'server',
      serverURL: 'http://127.0.0.1/v1',
      language: 'en',
    }),
    secrets: { apiKey: 'secret' },
    locale: 'en',
    paths: { data: directory, plugin: root },
  }
  await plugin.start(start)
  return { directory, plugin, start, models, setView }
}

function figures(today: number, total: number, seconds: number, dictations: number) {
  return {
    figures: [
      { label: 'view.today', value: today, format: 'count' },
      { label: 'view.total', value: total, format: 'count' },
      { label: 'view.speaking', value: seconds, format: 'duration' },
      { label: 'view.dictations', value: dictations, format: 'count' },
    ],
  }
}

type VoicePlugin = ReturnType<typeof createVoicePlugin>
let nextSession = 0

async function begin(
  plugin: VoicePlugin,
  vocabulary: readonly string[] = ['Gode'],
): Promise<string> {
  const session = `session-${++nextSession}`
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session, vocabulary },
  })
  return session
}

function append(plugin: VoicePlugin, session: string, audio: Uint8Array) {
  return plugin.call({
    type: 'call',
    id: 2,
    method: 'dictation.append',
    params: { session, audio },
  })
}

function finish(plugin: VoicePlugin, session: string) {
  return plugin.call({ type: 'call', id: 3, method: 'dictation.finish', params: { session } })
}

async function dictate(
  plugin: VoicePlugin,
  seconds = 2.5,
  vocabulary: readonly string[] = ['Gode'],
) {
  const session = await begin(plugin, vocabulary)
  await append(plugin, session, pcm(seconds))
  return finish(plugin, session)
}

async function saved(directory: string, dictations = 1, seconds?: number) {
  let value: StatsSnapshot | undefined
  await vi.waitFor(async () => {
    value = JSON.parse(await readFile(join(directory, 'stats.json'), 'utf8')) as StatsSnapshot
    expect(value.totals.dictations).toBe(dictations)
    if (seconds !== undefined) expect(value.totals.seconds).toBe(seconds)
  })
  return value!
}

type StatsSnapshot = {
  totals: { words: number; seconds: number; dictations: number }
  days: Record<string, { words: number; seconds: number; dictations: number }>
}

test('declares usage views with the SDK schema and sends empty views without creating a file', async () => {
  expect(pluginManifestSchema.parse(manifest).views).toEqual([
    {
      id: 'history',
      kind: 'list',
      title: 'view.history',
      description: 'view.history.description',
      itemActions: [{ id: 'deleteEntry', title: 'action.deleteEntry', destructive: true }],
      actions: ['clearHistory'],
    },
    {
      id: 'memory',
      kind: 'list',
      title: 'view.memory',
      description: 'view.memory.description',
      itemActions: [{ id: 'forgetTerm', title: 'action.forgetTerm', destructive: true }],
      actions: ['clearMemory'],
    },
    { id: 'usage', kind: 'figures', title: 'view.usage' },
    {
      id: 'activity',
      kind: 'calendar',
      title: 'view.activity',
      description: 'view.activity.description',
    },
  ])
  const { setView, directory } = await setup()
  expect(setView.mock.calls).toEqual([
    ['usage', figures(0, 0, 0, 0)],
    ['activity', { unit: 'view.activity.unit', days: [] }],
    ['history', { items: [], total: 0, empty: 'view.history.empty' }],
    ['memory', { items: [], total: 0, empty: 'view.memory.empty' }],
  ])
  for (const [id, data] of setView.mock.calls)
    expect(
      pluginViewDataSchemas[
        id === 'usage' ? 'figures' : id === 'activity' ? 'calendar' : 'list'
      ].safeParse(data).success,
    ).toBe(true)
  await expect(readFile(join(directory, 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('local sessions warm the engine and clean interim and final text', async () => {
  const { plugin, directory, setView } = await setup(
    async () =>
      new Response(JSON.stringify({ text: 'language English<asr_text>Um, G O D E works.' })),
    { local: true },
  )
  const use = vi
    .spyOn(LocalEngine.prototype, 'use')
    .mockImplementation(async (work) => work('http://127.0.0.1:12345/v1', 'local-test-key'))
  const session = await begin(plugin)
  expect(use).toHaveBeenCalledTimes(1)
  await expect(append(plugin, session, pcm(1.25))).resolves.toEqual({
    text: 'Gode works.',
  })
  expect(use).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, init] = vi.mocked(fetch).mock.calls[0]!
  expect(url).toBe('http://127.0.0.1:12345/v1/audio/transcriptions')
  expect(init?.headers).toEqual({ Authorization: 'Bearer local-test-key' })
  const body = init?.body as FormData
  expect(body.get('model')).toBe('model.gguf')
  expect(body.get('language')).toBe('en')
  expect(body.has('prompt')).toBe(false)
  expect(Buffer.from(await (body.get('file') as File).arrayBuffer())).toEqual(wav(1.25))
  expect(setView).toHaveBeenCalledTimes(4)
  await expect(readFile(join(directory, 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(append(plugin, session, pcm(1.25))).resolves.toEqual({ text: 'Gode works.' })
  await expect(finish(plugin, session)).resolves.toEqual({ text: 'Gode works.' })
  expect(
    Buffer.from(
      await (
        (vi.mocked(fetch).mock.calls[2]![1]!.body as FormData).get('file') as File
      ).arrayBuffer(),
    ),
  ).toEqual(wav(2.5))
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(2, 2, 2.5, 1)])
})

test('start replies while the local engine is still warming', async () => {
  const { plugin } = await setup(undefined, { local: true })
  const use = vi
    .spyOn(LocalEngine.prototype, 'use')
    .mockImplementation(async () => new Promise<never>(() => {}))
  await expect(begin(plugin)).resolves.toBeTypeOf('string')
  expect(use).toHaveBeenCalledOnce()
})

test('server sessions append without a request and finish once', async () => {
  const listener = vi.fn(async () => new Response(JSON.stringify({ text: 'Hello' })))
  const { plugin, setView, directory } = await setup(listener)
  const use = vi.spyOn(LocalEngine.prototype, 'use')
  const session = await begin(plugin)
  await expect(append(plugin, session, pcm(1))).resolves.toBeNull()
  await expect(append(plugin, session, pcm(1.5))).resolves.toBeNull()
  expect(listener).not.toHaveBeenCalled()
  expect(use).not.toHaveBeenCalled()
  expect(setView).toHaveBeenCalledTimes(4)
  await expect(readFile(join(directory, 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(finish(plugin, session)).resolves.toEqual({ text: 'Hello' })
  expect(listener).toHaveBeenCalledTimes(1)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(1, 1, 2.5, 1)])
})

test.each([
  { local: true, kind: 'noise' },
  { local: false, kind: 'noise' },
  { local: true, kind: 'silence' },
  { local: false, kind: 'silence' },
  { local: true, kind: 'empty' },
  { local: false, kind: 'empty' },
])(
  '$kind skips preview, final recognition and statistics (local: $local)',
  async ({ local, kind }) => {
    const { plugin, directory, setView } = await setup(
      async () => new Response(JSON.stringify({ text: 'Invented text' })),
      { local },
    )
    const use = vi
      .spyOn(LocalEngine.prototype, 'use')
      .mockImplementation(async (work) => work('http://127.0.0.1/v1', 'local-test-key'))
    const session = await begin(plugin, ['Gode', 'Gode One', 'agentdoc', 'useComposerText'])
    use.mockClear()
    if (kind !== 'empty')
      await expect(
        append(plugin, session, kind === 'noise' ? noise(3) : Buffer.alloc(3 * 32000)),
      ).resolves.toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    await expect(finish(plugin, session)).resolves.toEqual({ text: '' })
    expect(fetch).not.toHaveBeenCalled()
    expect(use).not.toHaveBeenCalled()
    expect(setView.mock.calls).toEqual([
      ['usage', figures(0, 0, 0, 0)],
      ['activity', { unit: 'view.activity.unit', days: [] }],
      ['history', { items: [], total: 0, empty: 'view.history.empty' }],
      ['memory', { items: [], total: 0, empty: 'view.memory.empty' }],
    ])
    await expect(readFile(join(directory, 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

test.each([true, false])('local=%s sends the correct vocabulary and audio span', async (local) => {
  const { plugin, setView } = await setup(
    async () => new Response(JSON.stringify({ text: 'G O D E and agent doc' })),
    { local },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const vocabulary = ['Gode', 'Gode One', 'agentdoc', 'useComposerText']
  const session = await begin(plugin, vocabulary)
  const audio = Buffer.concat([noise(1.2), pcm(2), noise(1.8, { seed: 7 })])
  await append(plugin, session, audio)
  await expect(finish(plugin, session)).resolves.toEqual({ text: 'Gode and agentdoc' })
  expect(fetch).toHaveBeenCalledTimes(local ? 2 : 1)
  for (const [, init] of vi.mocked(fetch).mock.calls) {
    const form = init!.body as FormData
    expect(form.has('prompt')).toBe(!local)
    const sent = Buffer.from(await (form.get('file') as File).arrayBuffer())
    expect(sent.readUInt32LE(4)).toBe(sent.length - 8)
    expect(sent.readUInt32LE(40)).toBe(sent.length - 44)
    expect(sent.subarray(8, 40)).toEqual(wav(5).subarray(8, 40))
    if (local) {
      const offset = audio.indexOf(sent.subarray(44))
      expect(offset % 2).toBe(0)
      expect(offset / 32000).toBeGreaterThanOrEqual(0.85)
      expect(offset / 32000).toBeLessThanOrEqual(1.2)
      expect((offset + sent.length - 44) / 32000).toBeGreaterThanOrEqual(3.2)
      expect((offset + sent.length - 44) / 32000).toBeLessThanOrEqual(3.55)
    } else {
      expect(form.get('prompt')).toBe(vocabulary.join(', '))
      expect(sent.subarray(44)).toEqual(audio)
    }
  }
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(3, 3, 5, 1)])
})

test('noise does not consume the preview throttle or borrow speech from another session', async () => {
  const { plugin, setView } = await setup(
    async () => new Response(JSON.stringify({ text: 'G O D E' })),
    { local: true },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const quiet = await begin(plugin)
  const speaking = await begin(plugin)
  await expect(append(plugin, speaking, noise(1.2))).resolves.toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  const preview = append(plugin, speaking, pcm(0.5))
  await expect(append(plugin, quiet, noise(3))).resolves.toBeNull()
  await expect(finish(plugin, quiet)).resolves.toEqual({ text: '' })
  await expect(preview).resolves.toEqual({ text: 'Gode' })
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(finish(plugin, speaking)).resolves.toEqual({ text: 'Gode' })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(1, 1, 1.7, 1)])
})

test('start and append return null while not ready, and finish reports not ready', async () => {
  const plugin = createVoicePlugin({ setStatus: () => {}, setView: () => {}, log: () => {} })
  await expect(begin(plugin)).resolves.toBeTypeOf('string')
  await expect(append(plugin, 'missing', pcm(1))).resolves.toBeNull()
  await expect(finish(plugin, 'missing')).rejects.toMatchObject({
    text: { message: 'error.notReady' },
  })
  const started = await setup()
  const active = await begin(started.plugin)
  await started.plugin.settings({
    type: 'settings',
    settings: settings({ engine: 'local' }),
    secrets: {},
  })
  await begin(started.plugin)
  await expect(append(started.plugin, 'missing', pcm(1))).resolves.toBeNull()
  await expect(finish(started.plugin, 'missing')).rejects.toMatchObject({
    text: { message: 'error.notReady' },
  })
  await expect(finish(started.plugin, active)).rejects.toMatchObject({
    text: { message: 'error.notReady' },
  })
  await started.plugin.settings({ ...started.start, type: 'settings' })
  await expect(append(started.plugin, active, pcm(1))).rejects.toMatchObject({
    text: { message: 'error.session' },
  })
})

test('overlapping local sessions keep their own audio, vocabulary and settings', async () => {
  const requests: { respond: (response: Response) => void; form: FormData }[] = []
  const { plugin, start, setView } = await setup(
    async (_url, init) =>
      new Promise<Response>((respond) => {
        requests.push({ respond, form: init?.body as FormData })
      }),
    { local: true },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1:12345/v1', 'local-test-key'),
  )
  const first = await begin(plugin)
  const preview = append(plugin, first, pcm(2.5))
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: settings({ ...start.settings, language: 'fr', removeFillers: false }),
  })
  const second = await begin(plugin, ['agentdoc'])
  await append(plugin, second, pcm(0.5))
  const final = finish(plugin, second)
  await vi.waitFor(() => expect(requests).toHaveLength(2))
  requests[1]!.respond(new Response(JSON.stringify({ text: 'Um, agent doc.' })))
  await expect(final).resolves.toEqual({ text: 'Um, agentdoc.' })
  requests[0]!.respond(new Response(JSON.stringify({ text: 'Um, G O D E.' })))
  await expect(preview).resolves.toEqual({ text: 'Gode.' })
  expect(requests.map(({ form }) => form.has('prompt'))).toEqual([false, false])
  expect(requests.map(({ form }) => form.get('language'))).toEqual(['en', 'fr'])
  for (const [index, expected] of [wav(2.5), wav(0.5)].entries()) {
    const file = requests[index]!.form.get('file') as File
    expect(Buffer.from(await file.arrayBuffer())).toEqual(expected)
  }
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(2, 2, 0.5, 1)])
  expect(setView).toHaveBeenCalledTimes(7)
  await plugin.call({ type: 'call', id: 4, method: 'dictation.cancel', params: { session: first } })
})

test('local append waits for another second and keeps bounded previews growing past a minute', async () => {
  const parts = Array.from({ length: 13 }, (_, index) => `part${index + 1}`)
  const audio = Buffer.concat(
    parts.flatMap((_, index) => [
      pcm(5, { fundamental: 120 + index * 7 }),
      ...(index < parts.length - 1 ? [Buffer.alloc(32000)] : []),
    ]),
  )
  const requests: Buffer[] = []
  const offsets: number[] = []
  let finishing = false
  const { plugin } = await setup(
    async (_url, init) => {
      const form = init!.body as FormData
      const sent = Buffer.from(await (form.get('file') as File).arrayBuffer())
      requests.push(sent)
      expect(sent.readUInt32LE(4)).toBe(sent.length - 8)
      expect(sent.readUInt32LE(40)).toBe(sent.length - 44)
      if (finishing) return new Response(JSON.stringify({ text: 'Final result.' }))
      expect((sent.length - 44) / 32000).toBeLessThanOrEqual(31)
      const samples = sent.subarray(44)
      const anchor = samples.findIndex((byte) => byte !== 0)
      expect(anchor).toBeGreaterThanOrEqual(0)
      const offset = audio.indexOf(samples.subarray(anchor, anchor + 2048)) - anchor
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset % 2).toBe(0)
      expect(audio.subarray(offset, offset + samples.length).equals(samples)).toBe(true)
      offsets.push(offset)
      const start = offset / 32000
      const end = (offset + sent.length - 44) / 32000
      const text = parts.filter((_, index) => start < index * 6 + 5 && end > index * 6).join(' ')
      return new Response(JSON.stringify({ text }))
    },
    { local: true },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const session = await begin(plugin)
  await expect(append(plugin, session, audio.subarray(0, 24000))).resolves.toBeNull()
  expect(fetch).not.toHaveBeenCalled()
  await expect(append(plugin, session, audio.subarray(24000, 32000))).resolves.toEqual({
    text: 'part1',
  })
  await expect(append(plugin, session, audio.subarray(32000, 48000))).resolves.toBeNull()
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(append(plugin, session, audio.subarray(48000, 64000))).resolves.toEqual({
    text: 'part1',
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  for (let seconds = 3; seconds <= audio.length / 32000; seconds++)
    await expect(
      append(plugin, session, audio.subarray((seconds - 1) * 32000, seconds * 32000)),
    ).resolves.toEqual({ text: parts.slice(0, Math.ceil(seconds / 6)).join(' ') })
  expect(offsets.filter((offset) => offset > 0).length).toBeGreaterThan(50)
  const previews = requests.length
  finishing = true
  await expect(finish(plugin, session)).resolves.toEqual({ text: 'Final result.' })
  expect(requests.length).toBe(previews + 1)
  expect(requests.at(-1)!.subarray(44).equals(audio)).toBe(true)
  expect(requests.filter((sent) => sent.length === audio.length + 44).length).toBe(1)
})

test('local preview commits continuous speech at 30 seconds and keeps text during silence', async () => {
  const requests: number[] = []
  const { plugin } = await setup(
    async (_url, init) => {
      const form = init!.body as FormData
      requests.push(((form.get('file') as File).size - 44) / 32000)
      return new Response(JSON.stringify({ text: 'Hello' }))
    },
    { local: true },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const session = await begin(plugin)
  const audio = pcm(61)
  for (let seconds = 1; seconds <= 61; seconds++)
    await expect(
      append(plugin, session, audio.subarray((seconds - 1) * 32000, seconds * 32000)),
    ).resolves.toEqual({
      text: Array(Math.ceil(seconds / 30))
        .fill('Hello')
        .join(' '),
    })
  expect(requests).toHaveLength(61)
  expect(Math.max(...requests)).toBeLessThanOrEqual(31)
  expect(requests[29]).toBe(30)
  expect(requests[59]).toBe(30)
  await expect(append(plugin, session, Buffer.alloc(30 * 32000))).resolves.toEqual({
    text: 'Hello Hello Hello',
  })
  const count = requests.length
  await expect(append(plugin, session, noise(2))).resolves.toEqual({
    text: 'Hello Hello Hello',
  })
  expect(requests).toHaveLength(count)
  const quiet = await begin(plugin)
  await expect(append(plugin, quiet, Buffer.alloc(32000))).resolves.toBeNull()
  await expect(append(plugin, session, pcm(1))).resolves.toEqual({
    text: 'Hello Hello Hello Hello',
  })
  expect(requests).toHaveLength(count + 1)
})

test('preview throttling across 30 seconds still bounds each request by one append', async () => {
  const requests: number[] = []
  const { plugin } = await setup(
    async (_url, init) => {
      const form = init!.body as FormData
      requests.push(((form.get('file') as File).size - 44) / 32000)
      return new Response(JSON.stringify({ text: 'Hello' }))
    },
    { local: true },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const session = await begin(plugin)
  const audio = pcm(30.5)
  await expect(append(plugin, session, audio.subarray(0, 29.5 * 32000))).resolves.toEqual({
    text: 'Hello',
  })
  for (let quarter = 0; quarter < 3; quarter++)
    await expect(
      append(
        plugin,
        session,
        audio.subarray((29.5 + quarter / 4) * 32000, (29.75 + quarter / 4) * 32000),
      ),
    ).resolves.toBeNull()
  expect(requests).toHaveLength(1)
  await expect(append(plugin, session, audio.subarray(30.25 * 32000))).resolves.toEqual({
    text: 'Hello',
  })
  expect(requests).toEqual([29.5, 30.25])
  await expect(append(plugin, session, pcm(1))).resolves.toEqual({ text: 'Hello Hello' })
  expect(requests).toHaveLength(3)
  expect(requests[2]).toBeLessThanOrEqual(31)
})

test('cancel aborts an in-flight request and forgets the session', async () => {
  let signal: AbortSignal | undefined
  const { plugin } = await setup(
    async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
      )
    },
    { local: true },
  )
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const session = await begin(plugin)
  const preview = append(plugin, session, pcm(1))
  const failed = expect(preview).rejects.toMatchObject({ text: { message: 'error.recognition' } })
  await vi.waitFor(() => expect(signal).toBeDefined())
  await plugin.call({ type: 'call', id: 4, method: 'dictation.cancel', params: { session } })
  expect(signal!.aborted).toBe(true)
  await failed
  await expect(finish(plugin, session)).rejects.toMatchObject({
    text: { message: 'error.session' },
  })
})

test('finish aborts an in-flight preview and recognizes the whole recording', async () => {
  let previewSignal: AbortSignal | undefined
  const listener = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (!previewSignal) {
      previewSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) =>
        previewSignal!.addEventListener('abort', () => reject(previewSignal!.reason), {
          once: true,
        }),
      )
    }
    return new Response(JSON.stringify({ text: 'Finished' }))
  })
  const { plugin } = await setup(listener, { local: true })
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'local-test-key'),
  )
  const session = await begin(plugin)
  const preview = append(plugin, session, pcm(1))
  const failed = expect(preview).rejects.toMatchObject({ text: { message: 'error.recognition' } })
  await vi.waitFor(() => expect(previewSignal).toBeDefined())
  await append(plugin, session, pcm(0.5))
  await expect(finish(plugin, session)).resolves.toEqual({ text: 'Finished' })
  expect(previewSignal!.aborted).toBe(true)
  await failed
  expect(listener).toHaveBeenCalledTimes(2)
})

test('unknown sessions fail append and finish', async () => {
  const { plugin } = await setup()
  await expect(append(plugin, 'unknown', pcm(1))).rejects.toMatchObject({
    text: { message: 'error.session' },
  })
  await expect(finish(plugin, 'unknown')).rejects.toMatchObject({
    text: { message: 'error.session' },
  })
})

test('statistics survive restart and publish totals and calendar days using the local date', async () => {
  vi.stubEnv('TZ', 'Pacific/Kiritimati')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T12:30:00Z'))
  let text = '今天用 Gode 写了 3 个 tests.'
  const { plugin, start, models, setView, directory } = await setup(
    async () => new Response(JSON.stringify({ text })),
  )
  await dictate(plugin)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(9, 9, 2.5, 1)])
  expect(setView.mock.calls.at(-1)).toEqual([
    'activity',
    { unit: 'view.activity.unit', days: [{ date: '2026-01-02', value: 9 }] },
  ])
  expect(await saved(directory)).toEqual({
    totals: { words: 9, seconds: 2.5, dictations: 1 },
    days: { '2026-01-02': { words: 9, seconds: 2.5, dictations: 1 } },
  })
  await plugin.dispose()
  vi.setSystemTime(new Date('2026-01-02T12:30:00Z'))
  const replacementViews = vi.fn<SetPluginView>()
  const replacement = createVoicePlugin(
    { setStatus: () => {}, setView: replacementViews, log: () => {} },
    [{ id: 'qwen3-asr-1.7b', files: models }],
  )
  cleanups.push(() => replacement.dispose())
  await replacement.start(start)
  expect(replacementViews.mock.calls).toEqual([
    ['usage', figures(0, 9, 2.5, 1)],
    ['activity', { unit: 'view.activity.unit', days: [{ date: '2026-01-02', value: 9 }] }],
    setView.mock.calls.findLast(([id]) => id === 'history'),
    ['memory', { items: [], total: 0, empty: 'view.memory.empty' }],
  ])
  text = 'Hello again'
  await dictate(replacement, 1.25, [])
  expect(replacementViews.mock.calls.at(-2)).toEqual(['usage', figures(2, 11, 3.75, 2)])
  expect(replacementViews.mock.calls.at(-1)).toEqual([
    'activity',
    {
      unit: 'view.activity.unit',
      days: [
        { date: '2026-01-02', value: 9 },
        { date: '2026-01-03', value: 2 },
      ],
    },
  ])
  await saved(directory, 2)
  await vi.waitFor(async () =>
    expect((await readdir(directory)).sort()).toEqual(['history.json', 'models', 'stats.json']),
  )
})

test.each([
  '{invalid',
  'null',
  '{"totals":{},"days":{}}',
  '{"totals":{"words":-1,"seconds":0,"dictations":0},"days":{}}',
  '{"totals":{"words":1,"seconds":1,"dictations":1},"days":{"2026-02-30":{"words":1,"seconds":1,"dictations":1}}}',
])('corrupt statistics start empty and are replaced after a transcription: %s', async (stored) => {
  const { plugin, setView, directory } = await setup(
    async () => new Response(JSON.stringify({ text: 'Hello' })),
    { stored },
  )
  expect(setView.mock.calls[0]).toEqual(['usage', figures(0, 0, 0, 0)])
  expect(setView.mock.calls[1]).toEqual(['activity', { unit: 'view.activity.unit', days: [] }])
  await dictate(plugin)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(1, 1, 2.5, 1)])
  expect((await saved(directory, 1, 2.5)).totals).toEqual({
    words: 1,
    seconds: 2.5,
    dictations: 1,
  })
})

test.each(['', ' \n ', 'language English<asr_text>Um, uh.'])(
  'empty final text is not counted: %j',
  async (text) => {
    const { plugin, setView, directory } = await setup(
      async () => new Response(JSON.stringify({ text })),
    )
    await expect(dictate(plugin)).resolves.toEqual({ text: '' })
    expect(setView).toHaveBeenCalledTimes(4)
    await expect(readFile(join(directory, 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

test('failed transcriptions are not counted', async () => {
  const { plugin, setView, directory } = await setup(
    async () =>
      new Response(JSON.stringify({ error: { message: 'Unavailable' } }), { status: 503 }),
  )
  await expect(dictate(plugin)).rejects.toMatchObject({
    text: { message: 'error.recognition' },
  })
  expect(setView).toHaveBeenCalledTimes(4)
  await expect(readFile(join(directory, 'stats.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('non-empty punctuation counts a dictation and audio but adds no calendar value', async () => {
  const { plugin, setView } = await setup(async () => new Response(JSON.stringify({ text: '...' })))
  await dictate(plugin)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(0, 0, 2.5, 1)])
  expect(setView.mock.calls.at(-1)).toEqual(['activity', { unit: 'view.activity.unit', days: [] }])
})

test('overlapping transcriptions persist all counts without temporary files left behind', async () => {
  const { plugin, setView, directory } = await setup(
    async () => new Response(JSON.stringify({ text: 'Hello world' })),
  )
  await Promise.all(Array.from({ length: 5 }, () => dictate(plugin)))
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(10, 10, 12.5, 5)])
  expect(setView).toHaveBeenCalledTimes(19)
  expect((await saved(directory, 5)).totals).toEqual({
    words: 10,
    seconds: 12.5,
    dictations: 5,
  })
  await vi.waitFor(async () =>
    expect((await readdir(directory)).sort()).toEqual(['history.json', 'models', 'stats.json']),
  )
})

test('ENOSPC does not fail dictation and the next record persists the latest counts', async () => {
  const { plugin, setView, directory } = await setup(
    async () => new Response(JSON.stringify({ text: 'Hello' })),
  )
  disk.failNext = true
  await expect(dictate(plugin)).resolves.toEqual({ text: 'Hello' })
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(1, 1, 2.5, 1)])
  await vi.waitFor(() => expect(disk.failed).toBe(true))
  await expect(dictate(plugin, 1)).resolves.toEqual({ text: 'Hello' })
  expect((await saved(directory, 2, 3.5)).totals).toEqual({ words: 2, seconds: 3.5, dictations: 2 })
})

test('a pending statistics write does not delay the final text', async () => {
  const { plugin, directory } = await setup(
    async () => new Response(JSON.stringify({ text: 'Hello' })),
  )
  disk.holdNext = true
  await expect(dictate(plugin)).resolves.toEqual({ text: 'Hello' })
  await vi.waitFor(() => expect(disk.release).toBeTypeOf('function'))
  disk.release!()
  expect((await saved(directory)).totals.dictations).toBe(1)
})

test('usage republished at successive local midnights and stops on dispose', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date(2026, 0, 1, 23, 59, 59))
  const { plugin, setView } = await setup(
    async () => new Response(JSON.stringify({ text: 'Hello' })),
  )
  await dictate(plugin)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(1, 1, 2.5, 1)])
  await vi.advanceTimersByTimeAsync(1000)
  expect(setView.mock.calls.at(-2)).toEqual(['usage', figures(0, 1, 2.5, 1)])
  const count = setView.mock.calls.length
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
  expect(setView).toHaveBeenCalledTimes(count + 2)
  await plugin.dispose()
  const stopped = setView.mock.calls.length
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
  expect(setView).toHaveBeenCalledTimes(stopped)
})

test('retains only the last 400 local days while preserving all-time totals', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2025, 1, 4, 12))
  const counts = { words: 1, seconds: 1, dictations: 1 }
  const days = Object.fromEntries(
    Array.from({ length: 401 }, (_, index) => [
      new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
      counts,
    ]),
  )
  const { plugin, setView, directory } = await setup(
    async () => new Response(JSON.stringify({ text: 'Hello world' })),
    { stored: JSON.stringify({ totals: { words: 401, seconds: 401, dictations: 401 }, days }) },
  )
  const activity = pluginViewDataSchemas.calendar.parse(setView.mock.calls[1]?.[1])
  expect(activity.days).toHaveLength(400)
  expect(activity.days[0]?.date).toBe('2024-01-02')
  expect(setView.mock.calls[0]).toEqual(['usage', figures(1, 401, 401, 401)])
  await dictate(plugin)
  const first = await saved(directory, 402)
  expect(Object.keys(first.days)).toHaveLength(400)
  expect(first.days['2024-01-01']).toBeUndefined()
  expect(first.days['2025-02-04']).toEqual({ words: 3, seconds: 3.5, dictations: 2 })
  expect(first.totals).toEqual({ words: 403, seconds: 403.5, dictations: 402 })
  vi.setSystemTime(new Date(2026, 2, 11, 12))
  await dictate(plugin)
  const later = await saved(directory, 403)
  expect(Object.keys(later.days)).toEqual(['2026-03-11'])
  expect(later.totals).toEqual({ words: 405, seconds: 406, dictations: 403 })
})
