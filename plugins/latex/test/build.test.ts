import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

const exec = promisify(execFile)

test('pins the four texlab releases', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const releases = {
    'darwin-arm64': 'texlab-aarch64-macos.tar.gz',
    'darwin-x64': 'texlab-x86_64-macos.tar.gz',
    'linux-x64': 'texlab-x86_64-linux.tar.gz',
    'linux-arm64': 'texlab-aarch64-linux.tar.gz',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/latex-lsp/texlab/releases/download/v5.26.0/${releases[platform as keyof typeof releases]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('unpacks the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-latex-build-'))
  try {
    const runtime = join(directory, 'runtime.tar.gz')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(join(directory, 'texlab'), 'texlab executable')
    await exec('tar', ['-czf', runtime, '-C', directory, 'texlab'])
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/texlab'), 'utf8')).toBe('texlab executable')
    expect((await stat(join(output, 'bin/texlab'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
