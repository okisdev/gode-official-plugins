import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostMessage, PluginStatus } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import { createVoicePlugin } from './plugin'
import { fixture, model, pcm } from './test-fixtures'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(listener: Parameters<typeof fixture>[0]) {
  const server = await fixture(listener)
  cleanups.push(() => server.close())
  const statuses: PluginStatus[] = []
  const models = ['model.gguf', 'projector.gguf'].map((file) =>
    model(file, server.url, 'model bytes'),
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
    paths: { data: server.directory, plugin: server.directory },
  }
  await plugin.start(start)
  return { server, statuses, plugin, start }
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
            : { text: 'language English<asr_text>Um, make test.' },
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
