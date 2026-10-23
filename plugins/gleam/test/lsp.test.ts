import { existsSync } from 'node:fs'
import { findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test, vi } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test('reports a missing Gleam compiler', () => {
  vi.stubEnv('PATH', '')
  try {
    expect(() =>
      plugin.launch(
        { plugin: '/tmp/plugin', data: '/tmp/data' },
        { root: '/tmp', language: 'gleam' },
      ),
    ).toThrow('missing')
  } finally {
    vi.unstubAllEnvs()
  }
})

test.skipIf(!built() || !findProgram('gleam'))(
  'the unpacked Gleam server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'gleam' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  30_000,
)
