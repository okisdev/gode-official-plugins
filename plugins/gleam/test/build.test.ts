import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import build from '../build.ts'

test('stages an executable launcher for the installed Gleam compiler', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-gleam-build-'))
  try {
    await build({
      root: directory,
      platform: 'linux-x64',
      directory,
      cache: directory,
      pinned: vi.fn(),
    })
    const launcher = join(directory, 'bin/gleam-lsp')
    expect(await readFile(launcher, 'utf8')).toBe('#!/bin/sh\nexec gleam lsp "$@"\n')
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
