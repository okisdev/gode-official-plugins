import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

const exec = promisify(execFile)

test('pins the four clojure-lsp native releases', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const archives = {
    'darwin-arm64': 'macos-aarch64',
    'darwin-x64': 'macos-amd64',
    'linux-x64': 'linux-amd64',
    'linux-arm64': 'linux-aarch64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/clojure-lsp/clojure-lsp/releases/download/2026.10.15-11.42.38/clojure-lsp-native-${archives[platform as keyof typeof archives]}.zip`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('extracts the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-clojure-build-'))
  try {
    const executable = join(directory, 'clojure-lsp')
    const archive = join(directory, 'runtime.zip')
    const output = join(directory, 'plugin')
    await mkdir(output)
    await writeFile(executable, 'clojure-lsp executable')
    await exec('zip', ['-j', archive, executable])
    const pinned = vi.fn(async () => archive)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/clojure-lsp'), 'utf8')).toBe('clojure-lsp executable')
    expect((await stat(join(output, 'bin/clojure-lsp'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
