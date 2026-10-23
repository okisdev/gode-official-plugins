import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins Expert v0.2.1 for all plugin platforms', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const assets = {
    'darwin-arm64': 'darwin_arm64',
    'darwin-x64': 'darwin_amd64',
    'linux-x64': 'linux_amd64',
    'linux-arm64': 'linux_arm64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/expert-lsp/expert/releases/download/v0.2.1/expert_${assets[platform as keyof typeof assets]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the verified Expert binary as an executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-elixir-build-'))
  try {
    const runtime = join(directory, 'runtime')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(runtime, 'Expert executable')
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/expert'), 'utf8')).toBe('Expert executable')
    expect((await stat(join(output, 'bin/expert'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
