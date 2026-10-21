import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect } from 'vitest'
import { lspTest } from '../../../test-support/lsp'
import manifest from '../manifest.json'

lspTest(
  'the unpacked svelte server answers LSP initialize',
  resolve(import.meta.dirname, '..'),
  manifest,
  'svelte',
  () => import('./main'),
  async (session) => {
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
)
