import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins the four Taplo release binaries', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const assets = {
    'darwin-arm64': 'taplo-darwin-aarch64.gz',
    'darwin-x64': 'taplo-darwin-x86_64.gz',
    'linux-arm64': 'taplo-linux-aarch64.gz',
    'linux-x64': 'taplo-linux-x86_64.gz',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/tamasfe/taplo/releases/download/0.10.0/${assets[platform as keyof typeof assets]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('gunzips the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-toml-build-'))
  try {
    const runtime = join(directory, 'runtime.gz')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, gzipSync('taplo executable'))
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/taplo'), 'utf8')).toBe('taplo executable')
    expect((await stat(join(output, 'bin/taplo'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
