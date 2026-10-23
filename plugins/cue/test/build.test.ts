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

test('pins CUE archives for every plugin platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const triples = {
    'darwin-arm64': 'darwin_arm64',
    'darwin-x64': 'darwin_amd64',
    'linux-x64': 'linux_amd64',
    'linux-arm64': 'linux_arm64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/cue-lang/cue/releases/download/v0.17.1/cue_v0.17.1_${triples[platform as keyof typeof triples]}.tar.gz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('extracts the pinned executable and makes it executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-cue-build-'))
  try {
    const source = join(directory, 'source')
    const runtime = join(directory, 'runtime.tar.gz')
    const output = join(directory, 'plugin')
    await mkdir(source)
    await mkdir(output)
    await writeFile(join(source, 'cue'), 'cue executable')
    await exec('tar', ['-czf', runtime, '-C', source, 'cue'])
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/cue'), 'utf8')).toBe('cue executable')
    expect((await stat(join(output, 'bin/cue'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
