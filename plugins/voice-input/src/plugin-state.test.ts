import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostMessage, PluginStatus } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import { createVoicePlugin } from './plugin'
import { LocalEngine } from './engine'
import { model, pcm } from './test-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-voice-state-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const statuses: PluginStatus[] = []
  const models = ['model.gguf', 'projector.gguf'].map((name) =>
    model(name, 'http://127.0.0.1/model', 'model bytes'),
  )
  const smaller = ['small-model.gguf', 'small-projector.gguf'].map((name) =>
    model(name, 'http://127.0.0.1/small', 'small'),
  )
  const polish = {
    id: 'qwen3.5-2b',
    files: [model('polish.gguf', 'http://127.0.0.1/polish', 'polish bytes')],
  }
  const plugin = createVoicePlugin(
    (status) => statuses.push(status),
    () => {},
    [
      { id: 'qwen3-asr-1.7b', files: models },
      { id: 'qwen3-asr-0.6b', files: smaller },
    ],
    polish,
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
  return { plugin, statuses, directory, start, models, smaller, polish }
}

test('missing tidy model leaves recognition ready, and download and removal use the same verified files', async () => {
  const { plugin, statuses, directory, start, models, polish } = await setup()
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.modelMissing' })
  for (const file of models) await writeFile(join(directory, 'models', file.file), 'model bytes')
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  expect(statuses.at(-1)).toMatchObject({
    state: 'ready',
    message: 'status.polishMissing',
    action: 'downloadPolishModel',
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('polish bytes')),
  )
  await plugin.action('downloadPolishModel')
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.localReady'))
  expect(
    statuses
      .filter((status) => status.message === 'status.polishDownloading')
      .map((status) => status.progress),
  ).toEqual([0, 1])
  expect(await readdir(join(directory, 'models'))).toContain(polish.files[0]!.file)
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'local', polish: false },
  })
  expect(await readdir(join(directory, 'models'))).toContain(polish.files[0]!.file)
  await plugin.action('removePolishModel')
  expect(await readdir(join(directory, 'models'))).toEqual(models.map((file) => file.file))
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  expect(statuses.at(-1)?.message).toBe('status.polishMissing')
})

test('a failed tidy model download leaves dictation ready for a retry', async () => {
  const { plugin, statuses, directory, start, models } = await setup()
  for (const file of models) await writeFile(join(directory, 'models', file.file), 'model bytes')
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('bad bytes')),
  )
  await plugin.action('downloadPolishModel')
  await vi.waitFor(() =>
    expect(statuses.at(-1)).toMatchObject({
      state: 'ready',
      message: 'status.polishDownloadFailed',
      action: 'downloadPolishModel',
    }),
  )
  expect(await readdir(join(directory, 'models'))).toEqual(models.map((file) => file.file))
  await expect(
    plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.start',
      params: { session: 'after-failure', vocabulary: [] },
    }),
  ).resolves.toBeNull()
})

test('selected model controls setup, download and removal while both sets can coexist', async () => {
  const { plugin, statuses, directory, start, models, smaller } = await setup()
  const fetchModel = vi.fn(async (_url: string, _init?: RequestInit) => new Response('small'))
  vi.stubGlobal('fetch', fetchModel)
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'local', localModel: 'qwen3-asr-0.6b' },
  })
  expect(statuses.at(-1)).toMatchObject({
    state: 'setup',
    message: 'status.modelMissing',
    values: { size: '10 Byte' },
  })
  await plugin.action('downloadModel')
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.localReady'))
  expect(fetchModel).toHaveBeenCalledTimes(2)
  expect(fetchModel.mock.calls.every(([url]) => url === 'http://127.0.0.1/small')).toBe(true)
  expect(await readdir(join(directory, 'models'))).toEqual(smaller.map((file) => file.file))
  for (const file of models) await writeFile(join(directory, 'models', file.file), 'model bytes')
  await plugin.action('removeModel')
  expect(statuses.at(-1)?.message).toBe('status.modelMissing')
  expect((await readdir(join(directory, 'models'))).sort()).toEqual(
    models.map((file) => file.file).sort(),
  )
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local' } })
  expect(statuses.at(-1)?.message).toBe('status.localReady')
})

test('switching models cancels a pending download and restarts with the selected paths', async () => {
  const { plugin, statuses, directory, start, models, smaller } = await setup()
  for (const file of models) await writeFile(join(directory, 'models', file.file), 'model bytes')
  for (const file of smaller) await writeFile(join(directory, 'models', file.file), 'small')
  const paths: string[][] = []
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async function (
    this: LocalEngine,
    work,
  ) {
    const options = (this as unknown as { options: { model: string; projector: string } }).options
    paths.push([options.model, options.projector])
    return work('http://127.0.0.1/v1')
  })
  const stopped = vi.spyOn(LocalEngine.prototype, 'stop')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        }),
    ),
  )
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local' } })
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session: 'default', vocabulary: [] },
  })
  await vi.waitFor(() => expect(paths).toHaveLength(1))
  expect(paths[0]).toEqual(models.map((file) => join(directory, 'models', file.file)))
  await plugin.action('downloadModel')
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'local', localModel: 'qwen3-asr-0.6b' },
  })
  expect(statuses.at(-1)?.message).toBe('status.localReady')
  expect(stopped).toHaveBeenCalledTimes(2)
  expect((await readdir(join(directory, 'models'))).sort()).toEqual(
    [...models, ...smaller].map((file) => file.file).sort(),
  )
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session: 'small', vocabulary: [] },
  })
  await vi.waitFor(() => expect(paths).toHaveLength(2))
  expect(paths[1]).toEqual(smaller.map((file) => join(directory, 'models', file.file)))
})

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
  await writeFile(join(directory, 'models/small-model.gguf.partial'), 'incomplete')
  const statuses: PluginStatus[] = []
  const replacement = createVoicePlugin(
    (status) => statuses.push(status),
    () => {},
    [
      {
        id: 'qwen3-asr-1.7b',
        files: ['model.gguf', 'projector.gguf'].map((name) =>
          model(name, 'http://127.0.0.1/model', 'model bytes'),
        ),
      },
      {
        id: 'qwen3-asr-0.6b',
        files: ['small-model.gguf', 'small-projector.gguf'].map((name) =>
          model(name, 'http://127.0.0.1/small', 'small'),
        ),
      },
    ],
  )
  cleanups.push(() => replacement.dispose())
  await replacement.start(start)
  expect(statuses.at(-1)?.message).toBe('status.localReady')
  expect(await readdir(join(directory, 'models'))).not.toContain('model.gguf.partial')
  expect(await readdir(join(directory, 'models'))).not.toContain('small-model.gguf.partial')
})
