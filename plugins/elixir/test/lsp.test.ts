import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the unpacked Expert server answers LSP initialize',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'gode-elixir-home-'))
    const originalHome = process.env.HOME
    process.env.HOME = home
    try {
      const session = await startLanguageServer(plugin, { language: 'elixir' })
      try {
        expect(session.launch.kind).toBe('program')
        expect(session.launch.args).toEqual(['--stdio'])
        expect(existsSync(session.launch.path)).toBe(true)
        const initialized = await session.initialize()
        expect(initialized.error).toBeUndefined()
        expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
      } finally {
        await session.stop()
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(home, { recursive: true, force: true })
    }
  },
  30_000,
)
