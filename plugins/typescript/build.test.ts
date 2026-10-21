import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from 'vitest'
import resources from './resources.json'
import build, { runtimeFiles } from './build'

test('pins four native runtimes and selects only the compiler, declarations, and notices', () => {
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
})

test('extracts the selected runtime files into the archive layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-typescript-build-'))
  try {
    const source = join(directory, 'source/package')
    const output = join(directory, 'plugin')
    await mkdir(join(source, 'lib'), { recursive: true })
    await mkdir(output)
    for (const name of ['LICENSE', 'NOTICE.txt']) await writeFile(join(source, name), name)
    for (const name of ['tsc', 'lib.d.ts', 'lib.es5.d.ts', 'lib.dom.d.ts', 'lib.esnext.d.ts'])
      await writeFile(join(source, 'lib', name), name, { mode: 0o755 })
    await writeFile(join(source, 'README.md'), 'omit')
    const runtime = join(directory, 'runtime.tgz')
    execFileSync('tar', ['-czf', runtime, '-C', join(directory, 'source'), 'package'])
    const pinned = vi.fn(async () => runtime)
    await build({
      root: directory,
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readdir(output)).toEqual(['LICENSE', 'NOTICE.txt', 'bin'])
    expect((await readdir(join(output, 'bin'))).sort()).toEqual([
      'lib.d.ts',
      'lib.dom.d.ts',
      'lib.es5.d.ts',
      'lib.esnext.d.ts',
      'tsc',
    ])
    expect(await readFile(join(output, 'LICENSE'), 'utf8')).toBe('LICENSE')
    expect((await stat(join(output, 'bin/tsc'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
