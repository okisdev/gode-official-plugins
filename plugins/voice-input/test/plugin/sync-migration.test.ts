import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, vi } from '@gode/plugin-sdk/test'

test('existing memory migrates once and later store deletions win', async () => {
  let memory = JSON.stringify({
    terms: [{ key: 'gode', count: 3, time: 1, forms: { Gode: 3 } }],
    forgotten: ['oldterm'],
  })
  vi.doMock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
      ...actual,
      mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
        const directory = await actual.mkdtemp(...args)
        if (String(args[0]).includes('gode-plugin-test-'))
          await actual.writeFile(join(directory, 'memory.json'), memory)
        return directory
      },
    }
  })
  vi.resetModules()
  const { startPlugin } = await import('@gode/plugin-sdk/test')
  const { default: plugin } = await import('../../src/main.ts')
  const settings = { engine: 'server' as const, serverURL: 'http://localhost/v1' }
  const first = await startPlugin(plugin, { settings })
  expect(first.stores).toEqual({ terms: { gode: 'Gode' }, forgotten: ['oldterm'] })
  await vi.waitFor(async () => {
    const saved = JSON.parse(await readFile(join(first.paths.data, 'memory.json'), 'utf8'))
    expect(saved.migrated).toBe(true)
  })
  memory = await readFile(join(first.paths.data, 'memory.json'), 'utf8')
  const second = await startPlugin(plugin, {
    settings,
    stores: { terms: {}, forgotten: first.stores.forgotten },
  })
  expect(second.stores.terms).toEqual({})
  expect(second.views.memory).toMatchObject({ total: 0 })
})
