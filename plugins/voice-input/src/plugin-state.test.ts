import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostMessage, PluginStatus } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import { createVoicePlugin } from './plugin'
import { model, pcm } from './test-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllGlobals()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-voice-state-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const statuses: PluginStatus[] = []
  const models = ['model.gguf', 'projector.gguf'].map((name) =>
    model(name, 'http://127.0.0.1/model', 'model bytes'),
  )
  const plugin = createVoicePlugin(
    (status) => statuses.push(status),
    () => {},
    models,
  )
  cleanups.push(() => plugin.dispose())
  const start: Extract<HostMessage, { type: 'start' }> = {
    type: 'start',
    settings: { engine: 'local' },
    secrets: {},
    locale: 'de',
    paths: { plugin: directory, data: directory },
  }
  await plugin.start(start)
  return { plugin, statuses, directory, start }
}

test('local lifecycle publishes setup, progress, ready and removal without losing control messages', async () => {
  const { plugin, statuses, directory, start } = await setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('model bytes')),
  )
  expect(statuses.at(-1)).toMatchObject({
    state: 'setup',
    message: 'status.modelMissing',
    values: { size: '22 Byte' },
  })
  await expect(
    plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.finish',
      params: { session: 'missing' },
    }),
  ).rejects.toMatchObject({ text: { message: 'error.notReady' } })
  await plugin.action('downloadModel')
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'local', language: 'zh' },
  })
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.localReady'))
  expect(
    statuses
      .filter((status) => status.message === 'status.downloading')
      .map((status) => status.progress),
  ).toEqual([0, 1])
  expect(await readdir(join(directory, 'models'))).toHaveLength(2)
  await plugin.action('removeModel')
  expect(statuses.at(-1)?.message).toBe('status.modelMissing')
  expect(await readdir(join(directory, 'models'))).toEqual([])
})

test('a failed download can be retried, stopped, and retried successfully', async () => {
  const { plugin, statuses, directory } = await setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('wrong bytes')),
  )
  await plugin.action('downloadModel')
  await vi.waitFor(() =>
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      message: 'status.downloadFailed',
      action: 'downloadModel',
    }),
  )
  expect(await readdir(join(directory, 'models'))).toEqual([])
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('model'))
          },
        }),
      ),
  )
  await plugin.action('downloadModel')
  await vi.waitFor(async () =>
    expect(await readdir(join(directory, 'models'))).toContain('model.gguf.partial'),
  )
  await plugin.action('stopDownload')
  expect(await readdir(join(directory, 'models'))).toEqual([])
  expect(statuses.at(-1)?.message).toBe('status.modelMissing')
  vi.mocked(fetch).mockImplementation(async () => new Response('model bytes'))
  await plugin.action('downloadModel')
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.localReady'))
})

test('server checks cannot overwrite settings changed while they are pending', async () => {
  const { plugin, statuses } = await setup()
  await plugin.settings({
    type: 'settings',
    settings: { engine: 'server', serverURL: '' },
    secrets: {},
  })
  expect(statuses.at(-1)?.message).toBe('status.serverMissing')
  await plugin.settings({
    type: 'settings',
    settings: { engine: 'server', serverURL: 'http://127.0.0.1/v1' },
    secrets: {},
  })
  expect(statuses.at(-1)).toMatchObject({
    state: 'ready',
    message: 'status.serverReady',
    values: { host: '127.0.0.1' },
  })
  let respond!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    ),
  )
  await plugin.action('checkServer')
  expect(statuses.at(-1)?.message).toBe('status.checking')
  await plugin.settings({ type: 'settings', settings: { engine: 'local' }, secrets: {} })
  respond(new Response('{}'))
  await Promise.resolve()
  expect(statuses.at(-1)?.message).toBe('status.modelMissing')
})

test('server transcription sends multipart options, and API errors stay localized', async () => {
  const { plugin, statuses } = await setup()
  await plugin.settings({
    type: 'settings',
    settings: {
      engine: 'server',
      serverURL: 'http://127.0.0.1/v1',
      model: 'whisper-1',
      language: 'zh',
    },
    secrets: { apiKey: 'key' },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ text: 'language Chinese<asr_text>嗯，make test' })),
    ),
  )
  await expect(
    plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.start',
      params: { session: 'server', vocabulary: ['make test'] },
    }),
  ).resolves.toBeNull()
  await expect(
    plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.append',
      params: { session: 'server', audio: pcm(1) },
    }),
  ).resolves.toBeNull()
  const call = {
    type: 'call',
    id: 2,
    method: 'dictation.finish',
    params: { session: 'server' },
  } as const
  await expect(plugin.call(call)).resolves.toEqual({ text: 'make test' })
  const [url, init] = vi.mocked(fetch).mock.calls[0]!
  expect(url).toBe('http://127.0.0.1/v1/audio/transcriptions')
  expect(init?.headers).toEqual({ Authorization: 'Bearer key' })
  expect((init!.body as FormData).get('language')).toBe('zh')
  expect((init!.body as FormData).get('prompt')).toBe('make test')
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid key' } }), { status: 401 }),
  )
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session: 'server', vocabulary: ['make test'] },
  })
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.append',
    params: { session: 'server', audio: pcm(1) },
  })
  await expect(plugin.call(call)).rejects.toMatchObject({
    text: { message: 'error.recognition', values: { reason: 'Invalid key' } },
  })
  await plugin.action('checkServer')
  await vi.waitFor(() =>
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      message: 'status.serverFailed',
      values: { reason: 'Invalid key' },
    }),
  )
})

test('startup removes stale partials and recognizes previously verified models', async () => {
  const { plugin, directory, start } = await setup()
  await plugin.dispose()
  for (const file of ['model.gguf', 'projector.gguf'])
    await writeFile(join(directory, 'models', file), 'model bytes')
  await writeFile(join(directory, 'models/model.gguf.partial'), 'incomplete')
  const statuses: PluginStatus[] = []
  const replacement = createVoicePlugin(
    (status) => statuses.push(status),
    () => {},
    ['model.gguf', 'projector.gguf'].map((name) =>
      model(name, 'http://127.0.0.1/model', 'model bytes'),
    ),
  )
  cleanups.push(() => replacement.dispose())
  await replacement.start(start)
  expect(statuses.at(-1)?.message).toBe('status.localReady')
  expect(await readdir(join(directory, 'models'))).not.toContain('model.gguf.partial')
})
