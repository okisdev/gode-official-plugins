import { existsSync } from 'node:fs'
import { PluginError, findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test('asks for the Dart SDK when dart is unavailable', async () => {
  const previous = process.env.PATH
  process.env.PATH = ''
  try {
    try {
      await plugin.launch({ plugin: '/plugin', data: '/data' }, { root: '/work', language: 'dart' })
      throw new Error('Expected dart to be missing')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError)
      expect((error as PluginError).text.message).toBe('missing')
    }
  } finally {
    process.env.PATH = previous
  }
})

test.skipIf(!built() || !findProgram('dart'))(
  'the unpacked Dart server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'dart' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  30_000,
)
