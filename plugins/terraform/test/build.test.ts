import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins terraform-ls 0.39.0 for every plugin platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const targets = {
    'darwin-arm64': 'darwin_arm64',
    'darwin-x64': 'darwin_amd64',
    'linux-x64': 'linux_amd64',
    'linux-arm64': 'linux_arm64',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    const file = `terraform-ls_0.39.0_${targets[platform as keyof typeof targets]}.zip`
    expect(asset.url).toBe(`https://releases.hashicorp.com/terraform-ls/0.39.0/${file}`)
    expect(asset.file).toBe(file)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the pinned executable from its zip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-terraform-build-'))
  try {
    const source = join(directory, 'source')
    const output = join(directory, 'plugin')
    await mkdir(source)
    await mkdir(output)
    await writeFile(join(source, 'terraform-ls'), 'terraform-ls executable')
    const runtime = join(directory, 'runtime.zip')
    execFileSync('zip', ['-q', runtime, 'terraform-ls'], { cwd: source })
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/terraform-ls'), 'utf8')).toBe('terraform-ls executable')
    expect((await stat(join(output, 'bin/terraform-ls'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
