import { existsSync } from 'node:fs'
import { PluginError, findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test('a missing dotnet reports the installation requirement', () => {
  const path = process.env.PATH
  try {
    process.env.PATH = ''
    expect(() =>
      plugin.launch(
        { plugin: '/tmp/plugin', data: '/tmp/data' },
        { root: '/tmp', language: 'csharp' },
      ),
    ).toThrow(PluginError)
    expect(() =>
      plugin.launch(
        { plugin: '/tmp/plugin', data: '/tmp/data' },
        { root: '/tmp', language: 'csharp' },
      ),
    ).toThrow('missing')
  } finally {
    process.env.PATH = path
  }
})

test.skipIf(!built() || !findProgram('dotnet'))(
  'the unpacked C# server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'csharp' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  60_000,
)
