import { existsSync } from 'node:fs'
import { PluginError, findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test('asks for opam when ocamllsp is missing', async () => {
  const previous = process.env.PATH
  process.env.PATH = ''
  try {
    try {
      await plugin.launch(
        { plugin: '/plugin', data: '/data' },
        { root: '/work', language: 'ocaml' },
      )
      throw new Error('Expected ocamllsp to be missing')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginError)
      expect((error as PluginError).text.message).toBe('missing')
    }
  } finally {
    process.env.PATH = previous
  }
})

test.skipIf(!built() || !findProgram('ocamllsp'))(
  'the unpacked OCaml server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'ocaml' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  30_000,
)
