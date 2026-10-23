import { findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built() || !findProgram('Rscript') || !findProgram('R'))(
  'the R server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'r' })
    expect(session.launch.kind).toBe('program')
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  180_000,
)
