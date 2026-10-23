import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins Biome executables for every supported platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/biomejs/biome/releases/download/%40biomejs/biome%402.6.2/biome-${platform}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the pinned executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-biome-build-'))
  try {
    const runtime = join(directory, 'runtime')
    await writeFile(runtime, 'biome executable')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: join(directory, 'plugin'),
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(await readFile(join(directory, 'plugin/bin/biome'), 'utf8')).toBe('biome executable')
    expect((await stat(join(directory, 'plugin/bin/biome'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
