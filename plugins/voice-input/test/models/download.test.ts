import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from '@gode/plugin-sdk/test'
import { downloadModels, modelsPresent } from '../../src/models/download.ts'
import { fixture, model } from '../fixtures/index.ts'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const item of fixtures.splice(0)) await item.close()
})

test('verifies streamed bytes and atomically publishes both model files', async () => {
  const server = await fixture((_request, response) => {
    response.write('model ')
    response.end('bytes')
  })
  fixtures.push(server)
  const models = ['model.gguf', 'projector.gguf'].map((file) =>
    model(file, server.url, 'model bytes'),
  )
  const progress: number[] = []
  await downloadModels(server.directory, models, new AbortController().signal, (done) =>
    progress.push(done),
  )
  expect(await modelsPresent(server.directory, models)).toBe(true)
  expect(await readFile(join(server.directory, 'model.gguf'), 'utf8')).toBe('model bytes')
  expect((await readdir(server.directory)).sort()).toEqual(['model.gguf', 'projector.gguf'])
  expect(progress.at(-1)).toBe(22)
})

test.each(['hash', 'size'])('%s mismatch leaves no final file or partial', async (failure) => {
  const server = await fixture((_request, response) => response.end('wrong'))
  fixtures.push(server)
  const entry = model('model.gguf', server.url, failure === 'hash' ? 'right' : 'longer')
  await expect(
    downloadModels(server.directory, [entry], new AbortController().signal, () => {}),
  ).rejects.toThrow('Integrity')
  expect(await readdir(server.directory)).toEqual([])
})

test('abort during streaming removes partials before settling', async () => {
  const server = await fixture((_request, response) => {
    response.write('first')
  })
  fixtures.push(server)
  const controller = new AbortController()
  await expect(
    downloadModels(
      server.directory,
      [model('model.gguf', server.url, 'first last')],
      controller.signal,
      (done) => {
        if (done) controller.abort()
      },
    ),
  ).rejects.toThrow()
  expect(await readdir(server.directory)).toEqual([])
})
