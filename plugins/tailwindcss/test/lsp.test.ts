import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test.skipIf(!built())(
  'the unpacked Tailwind CSS server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'css' })
    expect(session.launch.kind).toBe('script')
    expect(existsSync(session.launch.path)).toBe(true)
    const bin = dirname(session.launch.path)
    expect(existsSync(join(bin, 'oxide-helper.js'))).toBe(true)
    expect(readdirSync(bin).some((file) => /^watcher-.*\.node$/.test(file))).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  30_000,
)
