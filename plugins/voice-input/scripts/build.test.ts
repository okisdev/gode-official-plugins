import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import { runtimeFiles, selectedPlatforms, verifySHA256 } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-plugin-build-'))
  directories.push(directory)
  const source = join(directory, 'voice-input')
  const runtime = join(directory, 'llama-b11724')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(runtime)
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  for (const name of [
    'llama-server',
    'LICENSE',
    'llama-cli',
    'libggml-base.so.0.27.0',
    'libggml-cpu-zen4.so',
    'libllama-server-impl.so',
    'libllama-quantize-impl.so',
  ])
    await writeFile(join(runtime, name), name, { mode: 0o755 })
  await symlink('libggml-base.so.0.27.0', join(runtime, 'libggml-base.so.0'))
  const archive = join(directory, 'runtime.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', directory, 'llama-b11724'])
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  const resources = {
    models: [{ size: 2520744000 }, { size: 288 }],
    runtime: {
      directory: 'llama-b11724',
      platforms: { 'linux-x64': { file: 'runtime.tar.gz', sha256 } },
    },
  }
  await writeFile(join(source, 'resources.json'), JSON.stringify(resources))
  const output = join(directory, 'out')
  const download = vi.fn(async (_runtime, _asset, path: string) => {
    await copyFile(archive, path)
  })
  return { directory, source, output, download, archive, resources }
}

test('platforms and archive selection retain runtime dependencies, not tools', async () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  const entries = [
    'llama-server',
    'LICENSE',
    'libllama-server-impl.dylib',
    'libggml-metal.0.dylib',
    'libllama-common.0.7.0.dylib',
    'libmtmd.0.dylib',
    'libllama-quantize-impl.dylib',
    'llama-cli',
    '../escape',
  ].map((name) => `llama-b11724/${name}`)
  expect(runtimeFiles(entries, 'llama-b11724', 'darwin-arm64')).toEqual(entries.slice(0, 6).sort())
  expect(() => runtimeFiles([], 'llama-b11724', 'linux-x64')).toThrow('llama-server')
  expect(
    runtimeFiles(
      ['llama-server', 'LICENSE', 'libggml-cpu-armv9.2_2.so'].map((file) => `llama-b11724/${file}`),
      'llama-b11724',
      'linux-arm64',
    ),
  ).toContain('llama-b11724/libggml-cpu-armv9.2_2.so')
  expect(() => verifySHA256('bad', 'expected', 'archive')).toThrow('SHA-256 mismatch')
})

test('build produces a self-contained archive and verifies the cache', async () => {
  const f = await fixtures()
  const [archive = ''] = await buildPlugin(['linux-x64'], f)
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .sort()
  expect(listing).toEqual(
    [
      'manifest.json',
      'main.js',
      'bin/',
      'bin/LICENSE',
      'bin/llama-server',
      'bin/libggml-base.so.0.27.0',
      'bin/libggml-base.so.0',
      'bin/libggml-cpu-zen4.so',
      'bin/libllama-server-impl.so',
    ].sort(),
  )
  const unpacked = join(f.directory, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  expect(await readFile(join(unpacked, 'bin/libggml-base.so.0'), 'utf8')).toBe(
    'libggml-base.so.0.27.0',
  )
  expect((await stat(join(unpacked, 'bin/llama-server'))).mode & 0o111).not.toBe(0)
  await buildPlugin(['linux-x64'], f)
  expect(f.download).toHaveBeenCalledTimes(1)
  await writeFile(join(f.output, '.cache/runtime.tar.gz'), 'corrupt')
  await buildPlugin(['linux-x64'], f)
  expect(f.download).toHaveBeenCalledTimes(2)
  expect(await readdir(f.output)).toEqual([
    '.cache',
    `voice-input-${manifest.version}-linux-x64.tar.gz`,
  ])
})

test('download hash failure leaves neither cache nor package, and manifests validate before download', async () => {
  const f = await fixtures()
  await expect(
    buildPlugin(['linux-x64'], {
      ...f,
      download: async (_runtime: unknown, _asset: unknown, path: string) => writeFile(path, 'bad'),
    }),
  ).rejects.toThrow('SHA-256 mismatch')
  expect(await readdir(join(f.output, '.cache'))).toEqual([])
  expect(await readdir(f.output)).toEqual(['.cache'])
  await writeFile(
    join(f.source, 'manifest.json'),
    JSON.stringify({ ...manifest, version: 'invalid' }),
  )
  await expect(buildPlugin(['linux-x64'], f)).rejects.toThrow()
  expect(f.download).not.toHaveBeenCalled()
})
