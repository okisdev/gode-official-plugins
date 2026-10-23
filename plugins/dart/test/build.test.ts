import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import build from '../build.ts'

test('stages an executable launcher for the Dart SDK server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-dart-build-'))
  try {
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory,
      cache: directory,
      pinned: async () => {
        throw new Error('no download expected')
      },
    })
    const launcher = join(directory, 'bin', 'dart-language-server')
    expect(await readFile(launcher, 'utf8')).toBe(
      '#!/bin/sh\nexec dart language-server --protocol=lsp "$@"\n',
    )
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
