import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostMessage, PluginStatus } from '@gode/plugin-sdk'
import type { PluginContext } from '@gode/plugin-sdk/plugin'
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
  const log = vi.fn<PluginContext['log']>()
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
    { setStatus: (status) => statuses.push(status), setView: () => {}, log },
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
  return { plugin, statuses, directory, start, models, smaller, polish, log }
}

test('settings publish one recognition step and an optional tidy step in order', async () => {
  const { plugin, statuses, start } = await setup()
  expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.setup', actions: [] })
  expect(statuses.at(-1)?.steps).toMatchObject([
    {
      id: 'model',
      title: 'step.model',
      state: 'todo',
      fields: ['engine', 'localModel'],
      action: 'downloadModel',
    },
  ])
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  expect(statuses.at(-1)?.steps).toMatchObject([
    { id: 'model', state: 'todo' },
    {
      id: 'polish',
      title: 'step.polish',
      state: 'todo',
      optional: true,
      fields: ['polish'],
      action: 'downloadPolishModel',
    },
  ])
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'server', polish: true },
  })
  expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.setup', actions: [] })
  expect(statuses.at(-1)?.steps).toMatchObject([
    {
      id: 'server',
      title: 'step.server',
      state: 'todo',
      fields: ['engine', 'serverURL', 'apiKey', 'model'],
    },
    { id: 'polish', state: 'todo', optional: true },
  ])
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'server', serverURL: 'http://127.0.0.1/v1' },
  })
  expect(statuses.at(-1)).toMatchObject({
    state: 'ready',
    message: 'status.serverReady',
    actions: [],
  })
  expect(statuses.at(-1)?.steps).toMatchObject([
    { id: 'server', state: 'done', message: 'step.serverDone', action: 'checkServer' },
  ])
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'server', serverURL: 'invalid' },
  })
  expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.setup', actions: [] })
  expect(statuses.at(-1)?.steps?.[0]).toMatchObject({
    id: 'server',
    state: 'failed',
    message: 'status.serverFailed',
    action: 'checkServer',
  })
})

test('missing tidy model leaves recognition ready, and download and removal use the same verified files', async () => {
  const { plugin, statuses, directory, start, models, polish } = await setup()
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  expect(statuses.at(-1)).toMatchObject({
    state: 'setup',
    message: 'status.setup',
    actions: [],
    steps: [
      { id: 'model', state: 'todo' },
      { id: 'polish', state: 'todo', optional: true },
    ],
  })
  for (const file of models) await writeFile(join(directory, 'models', file.file), 'model bytes')
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  expect(statuses.at(-1)).toMatchObject({
    state: 'ready',
    message: 'status.localReady',
    actions: [],
  })
  expect(statuses.at(-1)?.steps).toMatchObject([
    { id: 'model', state: 'done', action: 'removeModel' },
    {
      id: 'polish',
      state: 'todo',
      message: 'step.polishTodo',
      optional: true,
      fields: ['polish'],
      action: 'downloadPolishModel',
    },
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('polish bytes')),
  )
  await plugin.action('downloadPolishModel')
  await vi.waitFor(() => expect(statuses.at(-1)?.steps?.at(-1)?.state).toBe('done'))
  expect([
    ...new Set(
      statuses
        .filter((status) => status.steps?.at(-1)?.message === 'status.polishDownloading')
        .map((status) => status.steps?.at(-1)?.progress),
    ),
  ]).toEqual([0, 1])
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
  expect(statuses.at(-1)?.steps?.at(-1)?.message).toBe('step.polishTodo')
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
  await vi.waitFor(() => {
    expect(statuses.at(-1)).toMatchObject({
      state: 'ready',
      message: 'status.localReady',
      actions: [],
    })
    expect(statuses.at(-1)?.steps?.at(-1)).toMatchObject({
      state: 'failed',
      message: 'status.polishDownloadFailed',
      action: 'downloadPolishModel',
    })
  })
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

test('turning off tidy up stops its download and removes its step', async () => {
  const { plugin, statuses, directory, start } = await setup()
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
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
  await plugin.action('downloadPolishModel')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(statuses.at(-1)?.steps?.at(-1)).toMatchObject({ id: 'polish', state: 'working' })
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'local', polish: false },
  })
  expect(statuses.at(-1)?.steps?.map((step) => step.id)).toEqual(['model'])
  expect(await readdir(join(directory, 'models'))).toEqual([])
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
  expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.setup', actions: [] })
  expect(statuses.at(-1)?.steps?.[0]).toMatchObject({
    id: 'model',
    state: 'todo',
    message: 'step.modelTodo',
    values: { model: 'Qwen3-ASR 0.6B', size: '10 Byte' },
    fields: ['engine', 'localModel'],
    action: 'downloadModel',
  })
  await plugin.action('downloadModel')
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.localReady'))
  expect(fetchModel).toHaveBeenCalledTimes(2)
  expect(fetchModel.mock.calls.every(([url]) => url === 'http://127.0.0.1/small')).toBe(true)
  expect(await readdir(join(directory, 'models'))).toEqual(smaller.map((file) => file.file))
  for (const file of models) await writeFile(join(directory, 'models', file.file), 'model bytes')
  await plugin.action('removeModel')
  expect(statuses.at(-1)?.steps?.[0]?.message).toBe('step.modelTodo')
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
    return work('http://127.0.0.1/v1', 'local-test-key')
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
  expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.setup', actions: [] })
  expect(statuses.at(-1)?.steps?.[0]).toMatchObject({
    id: 'model',
    state: 'todo',
    message: 'step.modelTodo',
    values: { model: 'Qwen3-ASR 1.7B', size: '22 Byte' },
    fields: ['engine', 'localModel'],
    action: 'downloadModel',
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
  expect([
    ...new Set(
      statuses
        .filter((status) => status.steps?.[0]?.message === 'status.downloading')
        .map((status) => status.steps?.[0]?.progress),
    ),
  ]).toEqual([0, 1])
  expect(await readdir(join(directory, 'models'))).toHaveLength(2)
  await plugin.action('removeModel')
  expect(statuses.at(-1)?.steps?.[0]?.message).toBe('step.modelTodo')
  expect(await readdir(join(directory, 'models'))).toEqual([])
})

test('a failed download can be retried, stopped, and retried successfully', async () => {
  const { plugin, statuses, directory } = await setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('wrong bytes')),
  )
  await plugin.action('downloadModel')
  await vi.waitFor(() => {
    expect(statuses.at(-1)).toMatchObject({ state: 'setup', message: 'status.setup', actions: [] })
    expect(statuses.at(-1)?.steps?.[0]).toMatchObject({
      state: 'failed',
      message: 'status.downloadFailed',
      action: 'downloadModel',
    })
  })
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
  expect(statuses.at(-1)?.steps?.[0]?.message).toBe('step.modelTodo')
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
  expect(statuses.at(-1)?.steps?.[0]?.message).toBe('step.serverTodo')
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
  expect(statuses.at(-1)?.steps?.[0]?.message).toBe('status.checking')
  await plugin.settings({ type: 'settings', settings: { engine: 'local' }, secrets: {} })
  respond(new Response('{}'))
  await Promise.resolve()
  expect(statuses.at(-1)?.steps?.[0]?.message).toBe('step.modelTodo')
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
  await vi.waitFor(() => {
    expect(statuses.at(-1)).toMatchObject({
      state: 'ready',
      message: 'status.serverReady',
      actions: [],
    })
    expect(statuses.at(-1)?.steps?.[0]).toMatchObject({
      state: 'failed',
      message: 'status.serverFailed',
      values: { reason: 'Invalid key' },
      action: 'checkServer',
    })
  })
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
    { setStatus: (status) => statuses.push(status), setView: () => {}, log: () => {} },
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

test('model downloads log their size, completion, failure and cancellation without progress noise', async () => {
  const { plugin, log } = await setup()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('model bytes')),
  )
  await plugin.action('downloadModel')
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith('info', 'Model download finished: model.gguf, projector.gguf'),
  )
  expect(log.mock.calls).toEqual([
    ['info', 'Model download started: model.gguf, projector.gguf (22 bytes)'],
    ['info', 'Model download finished: model.gguf, projector.gguf'],
  ])
  await plugin.action('removeModel')
  vi.mocked(fetch).mockImplementation(async () => new Response('private response', { status: 503 }))
  await plugin.action('downloadModel')
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith(
      'error',
      'Model download failed: model.gguf, projector.gguf: HTTP 503',
    ),
  )
  vi.mocked(fetch).mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(new Error('private cancellation reason')),
          { once: true },
        )
      }),
  )
  vi.mocked(fetch).mockClear()
  await plugin.action('downloadModel')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  await plugin.action('stopDownload')
  expect(log.mock.calls.slice(-2)).toEqual([
    ['info', 'Model download started: model.gguf, projector.gguf (22 bytes)'],
    ['info', 'Model download stopped: model.gguf, projector.gguf'],
  ])
  expect(log).toHaveBeenCalledTimes(6)
  expect(JSON.stringify(log.mock.calls)).not.toContain('private')
})

test('server checks log results and safe reasons without addresses, settings or response bodies', async () => {
  const { plugin, log } = await setup()
  await plugin.settings({
    type: 'settings',
    settings: {
      engine: 'server',
      serverURL: 'https://private-host.invalid/private-path',
      model: 'private-model',
      language: 'private-language',
    },
    secrets: { apiKey: 'private-api-key' },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"data":[]}')),
  )
  await plugin.action('checkServer')
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('info', 'Server check succeeded'))
  vi.mocked(fetch).mockImplementation(
    async () =>
      new Response(
        '{"error":{"message":"private-api-key private-vocabulary private-transcript"}}',
        { status: 401 },
      ),
  )
  await plugin.action('checkServer')
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith('error', 'Server check failed: HTTP 401'))
  vi.mocked(fetch).mockRejectedValue(
    new TypeError('private address and key', {
      cause: Object.assign(new Error('private address'), { code: 'ECONNREFUSED' }),
    }),
  )
  await plugin.action('checkServer')
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith('error', 'Server check failed: ECONNREFUSED'),
  )
  await plugin.settings({
    type: 'settings',
    settings: {
      engine: 'server',
      serverURL: 'https://private-user:private-password@private-host.invalid/v1',
    },
    secrets: { apiKey: 'private-api-key' },
  })
  await plugin.action('checkServer')
  await vi.waitFor(() =>
    expect(log).toHaveBeenCalledWith(
      'error',
      'Server check failed: Expected an HTTP or HTTPS API address',
    ),
  )
  expect(log).toHaveBeenCalledTimes(4)
  expect(JSON.stringify(log.mock.calls)).not.toContain('private')
})

test.each([false, true])(
  'dictation logs duration and whether polish ran (%s) while keeping content private',
  async (polishOn) => {
    const { plugin, directory, start, models, polish, log } = await setup()
    for (const entry of models)
      await writeFile(join(directory, 'models', entry.file), 'model bytes')
    await writeFile(join(directory, 'models', polish.files[0]!.file), 'polish bytes')
    vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async function (
      this: LocalEngine,
      work,
    ) {
      const name = (this as unknown as { options: { name: string } }).options.name
      return work('http://127.0.0.1/v1', `private-${name}-key`)
    })
    let transcriptions = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url).endsWith('/chat/completions')) {
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer private-polish-key')
          return new Response(
            JSON.stringify({ choices: [{ message: { content: 'Private transcript.' } }] }),
          )
        }
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer private-recognition-key',
        )
        return new Response(
          JSON.stringify({
            text: ++transcriptions === 1 ? 'Private preview.' : 'Private transcript.',
          }),
        )
      }),
    )
    await plugin.settings({
      ...start,
      type: 'settings',
      settings: { engine: 'local', polish: polishOn, language: 'private-language' },
    })
    await plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.start',
      params: { session: 'private-session', vocabulary: ['PrivateVocabulary'] },
    })
    await expect(
      plugin.call({
        type: 'call',
        id: 2,
        method: 'dictation.append',
        params: { session: 'private-session', audio: pcm(1) },
      }),
    ).resolves.toEqual({ text: 'Private preview.' })
    expect(log).not.toHaveBeenCalled()
    await expect(
      plugin.call({
        type: 'call',
        id: 3,
        method: 'dictation.finish',
        params: { session: 'private-session' },
      }),
    ).resolves.toEqual({ text: 'Private transcript.' })
    expect(log.mock.calls).toEqual([
      [
        'info',
        expect.stringMatching(
          new RegExp(
            `^Dictation finished: 1\\.00 s audio, recognition \\d+\\.\\d{2} s, polish ${polishOn ? 'ran' : 'skipped'}$`,
          ),
        ),
      ],
    ])
    expect(fetch).toHaveBeenCalledTimes(polishOn ? 3 : 2)
    expect(JSON.stringify(log.mock.calls).toLowerCase()).not.toContain('private')
  },
)

test('preview and finish failures log safe reasons at warning and error level', async () => {
  const { plugin, directory, start, models, log } = await setup()
  for (const entry of models) await writeFile(join(directory, 'models', entry.file), 'model bytes')
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async (work) =>
    work('http://127.0.0.1/v1', 'private-key'),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'Private transcript preview vocabulary key private-key' },
          }),
          { status: 503 },
        ),
    ),
  )
  await plugin.settings({ ...start, type: 'settings' })
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session: 'private-session', vocabulary: ['PrivateVocabulary'] },
  })
  await expect(
    plugin.call({
      type: 'call',
      id: 2,
      method: 'dictation.append',
      params: { session: 'private-session', audio: pcm(1) },
    }),
  ).rejects.toMatchObject({ text: { message: 'error.recognition' } })
  await expect(
    plugin.call({
      type: 'call',
      id: 3,
      method: 'dictation.finish',
      params: { session: 'private-session' },
    }),
  ).rejects.toMatchObject({ text: { message: 'error.recognition' } })
  expect(log.mock.calls).toEqual([
    ['warning', 'Dictation preview failed: HTTP 503'],
    ['error', 'Dictation finish failed: HTTP 503'],
  ])
})
