import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { lspTest } from '../../../test-support/lsp'
import manifest from '../manifest.json'

lspTest(
  'the unpacked astro server answers LSP initialize',
  resolve(import.meta.dirname, '..'),
  manifest,
  'astro',
  () => import('./main'),
  async (session) => {
    expect(session.launch.kind).toBe('script')
    expect(existsSync(session.launch.path)).toBe(true)
    expect(
      existsSync(
        (session.launch.initializationOptions as { typescript: { tsdk: string } }).typescript.tsdk,
      ),
    ).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
)
