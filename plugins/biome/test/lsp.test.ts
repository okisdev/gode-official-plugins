import { existsSync } from 'node:fs'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the built Biome server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'typescript' })
    expect(session.launch.kind).toBe('program')
    expect(session.launch.args).toEqual(['lsp-proxy', expect.stringMatching(/^--log-path=/)])
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  30_000,
)
