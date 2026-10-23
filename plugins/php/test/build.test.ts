import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins the Phpactor release phar', () => {
  expect(resources.phar).toEqual({
    url: 'https://github.com/phpactor/phpactor/releases/download/2026.10.07.0/phpactor.phar',
    file: 'phpactor-2026.10.07.0.phar',
    sha256: 'b28bf6166e016d539fc2f2aec18ef918b12590e436a6f1ccbdf30b5bbdbdb16b',
  })
})

test('stages the verified phar and an executable PHP launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-php-build-'))
  try {
    const runtime = join(directory, 'runtime.phar')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, 'phar bytes')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.phar)
    expect(await readFile(join(output, 'bin/phpactor.phar'), 'utf8')).toBe('phar bytes')
    expect(await readFile(join(output, 'bin/phpactor'), 'utf8')).toBe(
      '#!/bin/sh\nexec php "$(dirname "$0")/phpactor.phar" language-server "$@"\n',
    )
    expect((await stat(join(output, 'bin/phpactor'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
