import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from 'vitest'
import resources from './resources.json'
import build from './build'

test('pins the four rust-analyzer releases', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-05/rust-analyzer-${triples[platform as keyof typeof triples]}.gz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('gunzips the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-rust-build-'))
  try {
    const runtime = join(directory, 'runtime.gz')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, gzipSync('rust-analyzer executable'))
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/rust-analyzer'), 'utf8')).toBe(
      'rust-analyzer executable',
    )
    expect((await stat(join(output, 'bin/rust-analyzer'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
