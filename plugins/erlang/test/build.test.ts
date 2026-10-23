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

test('pins the four OTP 29.1 ELP release archives', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const targets = {
    'darwin-arm64': 'macos-aarch64-apple-darwin',
    'darwin-x64': 'macos-x86_64-apple-darwin',
    'linux-x64': 'linux-x86_64-unknown-linux-gnu',
    'linux-arm64': 'linux-aarch64-unknown-linux-gnu',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/WhatsApp/erlang-language-platform/releases/download/2026-10-14/elp-${targets[platform as keyof typeof targets]}-otp-29.1.tar.gz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the pinned executable with execute permission', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-erlang-build-'))
  try {
    const input = join(directory, 'input')
    const output = join(directory, 'plugin')
    const archive = join(directory, 'elp.tar.gz')
    await mkdir(input)
    await mkdir(output)
    await writeFile(join(input, 'elp'), 'ELP executable')
    await exec('tar', ['-czf', archive, '-C', input, 'elp'])
    const pinned = vi.fn(async () => archive)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/elp'), 'utf8')).toBe('ELP executable')
    expect((await stat(join(output, 'bin/elp'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
