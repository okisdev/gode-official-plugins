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

test('pins the FsAutoComplete 0.85.4 package for every platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const asset of Object.values(resources.platforms)) {
    expect(asset.url).toBe(
      'https://github.com/ionide/FsAutoComplete/releases/download/v0.85.4/fsautocomplete.0.85.4.nupkg',
    )
    expect(asset.sha256).toBe('6610d99bd1ce44acd426e6e9c1b5b05adbc90a96a175c1493e18511ae4027abd')
  }
})

test('stages the pinned .NET server and executable launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-fsharp-build-'))
  try {
    const payload = join(directory, 'tools/net8.0/any')
    await mkdir(payload, { recursive: true })
    await writeFile(join(payload, 'fsautocomplete.dll'), 'server')
    const archive = join(directory, 'server.nupkg')
    await exec('zip', ['-q', '-r', archive, 'tools'], { cwd: directory })
    const output = join(directory, 'plugin')
    await mkdir(output)
    const pinned = vi.fn(async () => archive)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(await readFile(join(output, 'server/fsautocomplete.dll'), 'utf8')).toBe('server')
    const launcher = join(output, 'bin/fsautocomplete')
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
    expect(await readFile(launcher, 'utf8')).toContain('exec dotnet')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
