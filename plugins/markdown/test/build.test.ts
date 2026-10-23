import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins the Marksman release for all four platforms', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const assets = {
    'darwin-arm64': 'marksman-macos',
    'darwin-x64': 'marksman-macos',
    'linux-arm64': 'marksman-linux-arm64',
    'linux-x64': 'marksman-linux-x64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/artempyanykh/marksman/releases/download/2026-02-08/${assets[platform as keyof typeof assets]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(resources.platforms['darwin-arm64'].sha256).toBe(resources.platforms['darwin-x64'].sha256)
})

test('stages the pinned executable with execute permission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-markdown-build-'))
  try {
    const runtime = join(directory, 'runtime')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, 'marksman executable')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(await readFile(join(output, 'bin/marksman'), 'utf8')).toBe('marksman executable')
    expect((await stat(join(output, 'bin/marksman'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
