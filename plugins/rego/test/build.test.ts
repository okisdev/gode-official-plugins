import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins the four Regal releases', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const assets = {
    'darwin-arm64': 'Darwin_arm64',
    'darwin-x64': 'Darwin_x86_64',
    'linux-x64': 'Linux_x86_64',
    'linux-arm64': 'Linux_arm64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/open-policy-agent/regal/releases/download/v0.43.0/regal_${assets[platform as keyof typeof assets]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('copies the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-rego-build-'))
  try {
    const runtime = join(directory, 'runtime')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, 'regal executable')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/regal'), 'utf8')).toBe('regal executable')
    expect((await stat(join(output, 'bin/regal'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
