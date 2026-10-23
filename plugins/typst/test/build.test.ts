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

test('pins the four tinymist releases', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const releases = {
    'darwin-arm64': 'tinymist-aarch64-apple-darwin.tar.gz',
    'darwin-x64': 'tinymist-x86_64-apple-darwin.tar.gz',
    'linux-x64': 'tinymist-x86_64-unknown-linux-gnu.tar.gz',
    'linux-arm64': 'tinymist-aarch64-unknown-linux-gnu.tar.gz',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/Myriad-Dreamin/tinymist/releases/download/v0.15.10/${releases[platform as keyof typeof releases]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('unpacks the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-typst-build-'))
  try {
    const runtime = join(directory, 'runtime.tar.gz')
    const output = join(directory, 'plugin')
    await mkdir(output)
    const archiveDirectory = 'tinymist-x86_64-unknown-linux-gnu'
    await mkdir(join(directory, archiveDirectory))
    await writeFile(join(directory, archiveDirectory, 'tinymist'), 'tinymist executable')
    await exec('tar', ['-czf', runtime, '-C', directory, archiveDirectory])
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/tinymist'), 'utf8')).toBe('tinymist executable')
    expect((await stat(join(output, 'bin/tinymist'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
