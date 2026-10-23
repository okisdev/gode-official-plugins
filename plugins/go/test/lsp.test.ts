import { existsSync } from 'node:fs'
import { findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built() || !findProgram('go'))(
  'the installed gopls answers LSP initialize from the built archive',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'go' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  180_000,
)
