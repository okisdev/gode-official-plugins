import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import build from '../build.ts'
import resources from '../resources.json'

test('pins a Coursier native launcher for every plugin platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const asset of Object.values(resources.platforms)) {
    expect(asset.url).toContain('coursier/coursier/releases/download/v2.1.25-M26/')
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the pinned Coursier executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-scala-build-'))
  try {
    const runtime = join(directory, 'coursier.gz')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, gzipSync('native launcher'))
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledExactlyOnceWith(resources.platforms['linux-x64'])
    const executable = join(output, 'bin/coursier')
    expect((await stat(executable)).mode & 0o111).not.toBe(0)
    expect(await readFile(executable, 'utf8')).toBe('native launcher')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
