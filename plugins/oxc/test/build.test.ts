import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

const exec = promisify(execFile)

test('pins Oxlint archives for every supported platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/oxc-project/oxc/releases/download/oxlint_v1.89.0/oxlint-${triples[platform as keyof typeof triples]}.tar.gz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('extracts the pinned Oxlint executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-oxc-build-'))
  try {
    const member = 'oxlint-aarch64-apple-darwin'
    await mkdir(join(directory, 'source'))
    await writeFile(join(directory, 'source', member), 'oxlint executable')
    const runtime = join(directory, 'runtime.tar.gz')
    await exec('tar', ['-czf', runtime, '-C', join(directory, 'source'), member])
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: join(directory, 'plugin'),
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(await readFile(join(directory, 'plugin/bin/oxlint'), 'utf8')).toBe('oxlint executable')
    expect((await stat(join(directory, 'plugin/bin/oxlint'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
