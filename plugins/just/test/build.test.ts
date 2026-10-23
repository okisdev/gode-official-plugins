import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins just-lsp for the four platforms', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    const file = `just-lsp-0.10.0-${triples[platform as keyof typeof triples]}.tar.gz`
    expect(asset.url).toBe(`https://github.com/terror/just-lsp/releases/download/0.10.0/${file}`)
    expect(asset.file).toBe(file)
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the pinned executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-just-build-'))
  try {
    const source = join(directory, 'source')
    const output = join(directory, 'plugin')
    await mkdir(source)
    await mkdir(output)
    await writeFile(join(source, 'just-lsp'), 'server executable')
    const archive = join(directory, 'server.tar.gz')
    execFileSync('tar', ['-czf', archive, '-C', source, './just-lsp'])
    const pinned = vi.fn(async () => archive)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/just-lsp'), 'utf8')).toBe('server executable')
    expect((await stat(join(output, 'bin/just-lsp'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
