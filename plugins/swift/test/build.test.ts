import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import build from '../build.ts'

test.each([
  ['darwin-arm64', '#!/bin/sh\nexec xcrun sourcekit-lsp "$@"\n'],
  ['linux-arm64', '#!/bin/sh\nexec sourcekit-lsp "$@"\n'],
] as const)('stages an executable Swift launcher for %s', async (platform, command) => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-swift-build-'))
  try {
    await build({
      root: directory,
      platform,
      directory,
      cache: directory,
      pinned: async () => {
        throw new Error('no download expected')
      },
    })
    const launcher = join(directory, 'bin', 'sourcekit-lsp')
    expect(await readFile(launcher, 'utf8')).toBe(command)
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
