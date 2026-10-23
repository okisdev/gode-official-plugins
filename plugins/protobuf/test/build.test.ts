import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins Buf binaries for every plugin platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const triples = {
    'darwin-arm64': 'Darwin-arm64',
    'darwin-x64': 'Darwin-x86_64',
    'linux-x64': 'Linux-x86_64',
    'linux-arm64': 'Linux-aarch64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/bufbuild/buf/releases/download/v1.75.0/buf-${triples[platform as keyof typeof triples]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('copies the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-protobuf-build-'))
  try {
    const runtime = join(directory, 'runtime')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, 'buf executable')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/buf'), 'utf8')).toBe('buf executable')
    expect((await stat(join(output, 'bin/buf'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
