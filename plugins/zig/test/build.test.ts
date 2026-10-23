import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import build from '../build.ts'
import resources from '../resources.json'

const exec = promisify(execFile)

test('pins ZLS for every plugin platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const targets = {
    'darwin-arm64': 'aarch64-macos',
    'darwin-x64': 'x86_64-macos',
    'linux-x64': 'x86_64-linux',
    'linux-arm64': 'aarch64-linux',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/zigtools/zls/releases/download/0.17.0/zls-${targets[platform as keyof typeof targets]}.tar.xz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the pinned ZLS executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-zig-build-'))
  try {
    const input = join(root, 'input')
    const output = join(root, 'plugin')
    const archive = join(root, 'zls.tar.xz')
    await mkdir(input)
    await mkdir(output)
    await writeFile(join(input, 'zls'), 'ZLS executable', { mode: 0o755 })
    await exec('tar', ['-cJf', archive, '-C', input, 'zls'])
    const pinned = vi.fn(async () => archive)
    await build({ root, platform: 'darwin-arm64', directory: output, cache: root, pinned })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(await readFile(join(output, 'bin/zls'), 'utf8')).toBe('ZLS executable')
    expect((await stat(join(output, 'bin/zls'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
