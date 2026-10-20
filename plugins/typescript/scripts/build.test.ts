import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import resources from '../resources.json'
import { runtimeFiles, selectedPlatforms, verifySHA256 } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-typescript-build-'))
  directories.push(directory)
  const source = join(directory, 'typescript')
  const runtime = join(directory, 'package')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(runtime, 'lib'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  for (const name of ['LICENSE', 'NOTICE.txt']) await writeFile(join(runtime, name), name)
  for (const name of ['tsc', 'lib.d.ts', 'lib.es5.d.ts', 'lib.dom.d.ts', 'lib.esnext.d.ts'])
    await writeFile(join(runtime, 'lib', name), name, { mode: 0o755 })
  await writeFile(join(runtime, 'README.md'), 'omit')
  const archive = join(directory, 'runtime.tgz')
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package'])
  const sha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  await writeFile(
    join(source, 'resources.json'),
    JSON.stringify({
      platforms: {
        'linux-x64': { file: 'runtime.tgz', url: 'https://example.test/runtime.tgz', sha256 },
      },
    }),
  )
  const output = join(directory, 'out')
  const download = vi.fn(async (_asset: unknown, path: string) => copyFile(archive, path))
  return { directory, source, output, download }
}

test('selects four pinned platforms and only the compiler, declarations, and notices', () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://registry.npmjs.org/@typescript/typescript-${platform}/-/typescript-${platform}-7.0.2.tgz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(
    runtimeFiles([
      'package/LICENSE',
      'package/NOTICE.txt',
      'package/lib/tsc',
      'package/lib/lib.d.ts',
      'package/lib/lib.es5.d.ts',
      'package/lib/lib.dom.d.ts',
      'package/lib/lib.esnext.d.ts',
      'package/README.md',
      'package/lib/tsc.sig',
      'package/lib/../escape',
    ]),
  ).toEqual([
    'package/LICENSE',
    'package/NOTICE.txt',
    'package/lib/lib.d.ts',
    'package/lib/lib.dom.d.ts',
    'package/lib/lib.es5.d.ts',
    'package/lib/lib.esnext.d.ts',
    'package/lib/tsc',
  ])
  expect(() => runtimeFiles([])).toThrow('Runtime archive lacks')
  expect(() => verifySHA256('bad', 'expected', 'runtime.tgz')).toThrow('SHA-256 mismatch')
})

test('builds a self-contained archive and redownloads a corrupt cache entry', async () => {
  const fixture = await fixtures()
  const [archive = ''] = await buildPlugin(['linux-x64'], fixture)
  expect(
    execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort(),
  ).toEqual(
    [
      'LICENSE',
      'NOTICE.txt',
      'bin/',
      'bin/tsc',
      'bin/lib.d.ts',
      'bin/lib.es5.d.ts',
      'bin/lib.dom.d.ts',
      'bin/lib.esnext.d.ts',
      'main.js',
      'manifest.json',
    ].sort(),
  )
  const unpacked = join(fixture.directory, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  expect((await stat(join(unpacked, 'bin/tsc'))).mode & 0o111).not.toBe(0)
  await buildPlugin(['linux-x64'], fixture)
  expect(fixture.download).toHaveBeenCalledTimes(1)
  await writeFile(join(fixture.output, '.cache/runtime.tgz'), 'corrupt')
  await buildPlugin(['linux-x64'], fixture)
  expect(fixture.download).toHaveBeenCalledTimes(2)
  expect(await readdir(fixture.output)).toEqual([
    '.cache',
    `typescript-${manifest.version}-linux-x64.tar.gz`,
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
