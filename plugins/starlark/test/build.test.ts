import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins the four starpls releases', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const assets = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-amd64',
    'linux-x64': 'linux-amd64',
    'linux-arm64': 'linux-aarch64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/withered-magic/starpls/releases/download/v0.1.22/starpls-${assets[platform as keyof typeof assets]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('copies the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-starlark-build-'))
  try {
    const runtime = join(directory, 'runtime')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, 'starpls executable')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/starpls'), 'utf8')).toBe('starpls executable')
    expect((await stat(join(output, 'bin/starpls'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
