import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostMessage, PluginStatus } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import { createVoicePlugin } from './plugin'
import { LocalEngine } from './engine'
import { fixture, model, pcm } from './test-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function setup(listener: Parameters<typeof fixture>[0]) {
  const server = await fixture(listener)
  cleanups.push(() => server.close())
  const statuses: PluginStatus[] = []
  const models = ['model.gguf', 'projector.gguf'].map((file) =>
    model(file, server.url, 'model bytes'),
  )
  const polish = { id: 'qwen3.5-2b', files: [model('polish.gguf', server.url, 'polish bytes')] }
  const plugin = createVoicePlugin(
    (status) => statuses.push(status),
    () => {},
    [{ id: 'qwen3-asr-1.7b', files: models }],
    polish,
  )
  cleanups.push(() => plugin.dispose())
  const start: Extract<HostMessage, { type: 'start' }> = {
    type: 'start',
    settings: { engine: 'local' },
    secrets: {},
    locale: 'de',
    paths: { data: server.directory, plugin: server.directory },
  }
  await plugin.start(start)
  return { server, statuses, plugin, start, polish }
}

test('missing, downloading, ready and removal use manifest states and localized sizes', async () => {
  const { server, statuses, plugin } = await setup((_request, response) =>
    response.end('model bytes'),
  )
  expect(statuses.at(-1)).toMatchObject({
    state: 'setup',
    message: 'status.modelMissing',
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
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.localReady'))
  expect(statuses.find((status) => status.message === 'status.downloading')).toMatchObject({
    state: 'working',
    progress: 0,
    action: 'stopDownload',
    values: { done: '0 Byte', total: '22 Byte' },
  })
  await plugin.action('removeModel')
  expect(statuses.at(-1)?.message).toBe('status.modelMissing')
  expect(await readdir(join(server.directory, 'models'))).toEqual([])
})

test('download failure offers retry and stopping a retry cleans partials', async () => {
  let slow = false
  const { server, statuses, plugin } = await setup((_request, response) => {
    if (slow) response.write('model')
    else response.end('bad')
  })
  await plugin.action('downloadModel')
  await vi.waitFor(() =>
    expect(statuses.at(-1)).toMatchObject({
      state: 'failed',
      message: 'status.downloadFailed',
      action: 'downloadModel',
    }),
  )
  slow = true
  await plugin.action('downloadModel')
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.downloading'))
  await plugin.action('stopDownload')
  expect(statuses.at(-1)?.message).toBe('status.modelMissing')
  expect(await readdir(join(server.directory, 'models'))).toEqual([])
})

test('server settings, check, transcription and API failures use the contract', async () => {
  let fail = false
  const requests: { url: string; auth?: string; body: string }[] = []
  const { server, statuses, plugin } = await setup(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ url: request.url!, auth: request.headers.authorization, body })
    response.writeHead(fail ? 401 : 200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        fail
          ? { error: { message: 'Invalid key' } }
          : request.url?.endsWith('/models')
            ? { data: [] }
            : { text: 'language English<asr_text>um, make test.' },
      ),
    )
  })
  await plugin.settings({ type: 'settings', settings: { engine: 'server' }, secrets: {} })
  expect(statuses.at(-1)?.message).toBe('status.serverMissing')
  await plugin.settings({
    type: 'settings',
    settings: {
      engine: 'server',
      serverURL: `${server.url}/v1`,
      model: 'whisper-1',
      language: 'en',
    },
    secrets: { apiKey: 'secret' },
  })
  expect(statuses.at(-1)).toMatchObject({
    state: 'ready',
    message: 'status.serverReady',
    values: { host: new URL(server.url).host },
  })
  await plugin.action('checkServer')
  expect(statuses.at(-1)?.message).toBe('status.checking')
  await vi.waitFor(() => expect(statuses.at(-1)?.message).toBe('status.serverReady'))
  const call = {
    type: 'call',
    id: 2,
    method: 'dictation.finish',
    params: { session: 'server' },
  } as const
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session: 'server', vocabulary: ['make test'] },
  })
  await expect(
    plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.append',
      params: { session: 'server', audio: pcm(1) },
    }),
  ).resolves.toBeNull()
  await expect(plugin.call(call)).resolves.toEqual({ text: 'make test.' })
  expect(requests.at(-1)).toMatchObject({ url: '/v1/audio/transcriptions', auth: 'Bearer secret' })
  expect(requests.at(-1)?.body).toContain('whisper-1')
  expect(requests.at(-1)?.body).toContain('make test')
  fail = true
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

test('a missing local executable produces error.engine', async () => {
  const { server, plugin, start } = await setup((_request, response) => response.end())
  await mkdir(join(server.directory, 'models'), { recursive: true })
  for (const file of ['model.gguf', 'projector.gguf'])
    await writeFile(join(server.directory, 'models', file), 'model bytes')
  await plugin.settings({ ...start, type: 'settings' })
  await expect(
    plugin.call({
      type: 'call',
      id: 1,
      method: 'dictation.start',
      params: { session: 'local', vocabulary: [] },
    }),
  ).resolves.toBeNull()
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.append',
    params: { session: 'local', audio: pcm(0.5) },
  })
  await expect(
    plugin.call({ type: 'call', id: 1, method: 'dictation.finish', params: { session: 'local' } }),
  ).rejects.toMatchObject({ text: { message: 'error.engine' } })
})

async function finish(plugin: Awaited<ReturnType<typeof setup>>['plugin']) {
  await plugin.call({
    type: 'call',
    id: 1,
    method: 'dictation.start',
    params: { session: 'tidy', vocabulary: ['agentdoc'] },
  })
  await plugin.call({
    type: 'call',
    id: 2,
    method: 'dictation.append',
    params: { session: 'tidy', audio: pcm(1) },
  })
  return plugin.call({
    type: 'call',
    id: 3,
    method: 'dictation.finish',
    params: { session: 'tidy' },
  })
}

test.each([
  ['accepted', 'Please send to Agent Doc on Thursday.', 'Please send to agentdoc on Thursday.'],
  ['rejected', 'Paris', 'Please send to agentdoc on Wednesday, I mean Thursday.'],
  ['failed', '', 'Please send to agentdoc on Wednesday, I mean Thursday.'],
  ['timeout', '', 'Please send to agentdoc on Wednesday, I mean Thursday.'],
])(
  'finish uses a tidy edit or falls back when the reply is %s',
  async (caseName, reply, expected) => {
    const requests: { url: string; body: string }[] = []
    const { server, plugin, start, statuses, polish } = await setup(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      requests.push({ url: request.url!, body })
      if (request.url?.endsWith('/audio/transcriptions')) {
        response.end(
          JSON.stringify({ text: 'Um, please send to Agent Doc on Wednesday, I mean Thursday.' }),
        )
      } else if (caseName === 'failed') {
        response.writeHead(500)
        response.end('error')
      } else if (caseName !== 'timeout') {
        response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }))
      }
    })
    await mkdir(join(server.directory, 'models'), { recursive: true })
    await writeFile(join(server.directory, 'models', polish.files[0]!.file), 'polish bytes')
    const used = vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async function (
      this: LocalEngine,
      work,
    ) {
      return work(`${server.url}/v1`)
    })
    await plugin.settings({
      ...start,
      type: 'settings',
      settings: { engine: 'server', serverURL: `${server.url}/v1`, polish: true },
    })
    expect(statuses.at(-1)?.state).toBe('ready')
    await expect(finish(plugin)).resolves.toEqual({ text: expected })
    expect(used).toHaveBeenCalled()
    const sent = requests.find((request) => request.url === '/v1/chat/completions')
    expect(sent).toBeDefined()
    expect(JSON.parse(sent!.body)).toMatchObject({
      temperature: 0,
      max_tokens: Math.min(
        512,
        2 * 'Please send to Agent Doc on Wednesday, I mean Thursday.'.length + 16,
      ),
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(JSON.parse(sent!.body).messages.at(-1)).toEqual({
      role: 'user',
      content: '<transcript>Please send to Agent Doc on Wednesday, I mean Thursday.</transcript>',
    })
  },
  8000,
)

test('polish off never starts the tidy engine or sends a chat request', async () => {
  const requests: string[] = []
  const { server, plugin, start, polish } = await setup((request, response) => {
    requests.push(request.url!)
    response.end(
      JSON.stringify({ text: 'Um, please send to Agent Doc on Wednesday, I mean Thursday.' }),
    )
  })
  await mkdir(join(server.directory, 'models'), { recursive: true })
  await writeFile(join(server.directory, 'models', polish.files[0]!.file), 'polish bytes')
  const used = vi.spyOn(LocalEngine.prototype, 'use')
  await plugin.settings({
    ...start,
    type: 'settings',
    settings: { engine: 'server', serverURL: `${server.url}/v1`, polish: false },
  })
  await expect(finish(plugin)).resolves.toEqual({
    text: 'Please send to agentdoc on Wednesday, I mean Thursday.',
  })
  expect(used).not.toHaveBeenCalled()
  expect(requests).toEqual(['/v1/audio/transcriptions'])
})

test('local recognition also tidies only the final transcript', async () => {
  const requests: string[] = []
  const { server, plugin, start, polish } = await setup((request, response) => {
    requests.push(request.url!)
    response.end(
      JSON.stringify(
        request.url?.endsWith('/chat/completions')
          ? { choices: [{ message: { content: 'Please send to Agent Doc on Thursday.' } }] }
          : { text: 'Um, please send to Agent Doc on Wednesday, I mean Thursday.' },
      ),
    )
  })
  await mkdir(join(server.directory, 'models'), { recursive: true })
  for (const file of ['model.gguf', 'projector.gguf'])
    await writeFile(join(server.directory, 'models', file), 'model bytes')
  await writeFile(join(server.directory, 'models', polish.files[0]!.file), 'polish bytes')
  vi.spyOn(LocalEngine.prototype, 'use').mockImplementation(async function (
    this: LocalEngine,
    work,
  ) {
    return work(`${server.url}/v1`)
  })
  await plugin.settings({ ...start, type: 'settings', settings: { engine: 'local', polish: true } })
  await expect(finish(plugin)).resolves.toEqual({ text: 'Please send to agentdoc on Thursday.' })
  expect(requests).toContain('/v1/audio/transcriptions')
  expect(requests).toContain('/v1/chat/completions')
})
