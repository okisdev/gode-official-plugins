import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import resources from '../resources.json'
import { selectedPlatforms, verifySHA256 } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-rust-build-'))
  directories.push(directory)
  const source = join(directory, 'rust')
  await mkdir(join(source, 'src'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  const archive = join(directory, 'runtime.gz')
  await writeFile(archive, gzipSync('rust-analyzer executable'))
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  await writeFile(
    join(source, 'resources.json'),
    JSON.stringify({
      platforms: {
        'linux-x64': { file: 'runtime.gz', url: 'https://example.test/runtime.gz', sha256 },
      },
    }),
  )
  const output = join(directory, 'out')
  const download = vi.fn(async (_asset: unknown, path: string) => copyFile(archive, path))
  return { directory, source, output, download }
}

test('selects four pinned platform binaries', () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-05/rust-analyzer-${triples[platform as keyof typeof triples]}.gz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(() => verifySHA256('bad', 'expected', 'runtime.gz')).toThrow('SHA-256 mismatch')
})

test('builds a self-contained archive and redownloads a corrupt cache entry', async () => {
  const fixture = await fixtures()
  const [archive = ''] = await buildPlugin(['linux-x64'], fixture)
  expect(
    execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort(),
  ).toEqual(['bin/', 'bin/rust-analyzer', 'main.js', 'manifest.json'].sort())
  const unpacked = join(fixture.directory, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  expect((await stat(join(unpacked, 'bin/rust-analyzer'))).mode & 0o111).not.toBe(0)
  expect(await readFile(join(unpacked, 'bin/rust-analyzer'), 'utf8')).toBe(
    'rust-analyzer executable',
  )
  await buildPlugin(['linux-x64'], fixture)
  expect(fixture.download).toHaveBeenCalledTimes(1)
  await writeFile(join(fixture.output, '.cache/runtime.gz'), 'corrupt')
  await buildPlugin(['linux-x64'], fixture)
  expect(fixture.download).toHaveBeenCalledTimes(2)
  expect(await readdir(fixture.output)).toEqual([
    '.cache',
    `rust-${manifest.version}-linux-x64.tar.gz`,
  ])
})

test('rejects a mismatched download without leaving a final file or archive', async () => {
  const fixture = await fixtures()
  await expect(
    buildPlugin(['linux-x64'], {
      ...fixture,
      download: async (_asset: unknown, path: string) => writeFile(path, 'bad'),
    }),
  ).rejects.toThrow('SHA-256 mismatch')
  expect(await readdir(join(fixture.output, '.cache'))).toEqual([])
  expect(await readdir(fixture.output)).toEqual(['.cache'])
})
