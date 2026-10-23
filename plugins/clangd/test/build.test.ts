import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build, { runtimeRoot } from '../build.ts'

test('pins the three clangd release builds and recognizes their archive layout', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
  ])
  expect(resources.platforms['darwin-arm64']).toEqual(resources.platforms['darwin-x64'])
  for (const asset of Object.values(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/clangd/clangd/releases/download/23.1.0/${asset.file}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(
    runtimeRoot([
      'clangd_23.1.0/LICENSE.TXT',
      'clangd_23.1.0/bin/clangd',
      'clangd_23.1.0/lib/clang/23/include/stddef.h',
    ]),
  ).toBe('clangd_23.1.0')
  expect(() => runtimeRoot(['clangd_23.1.0/bin/clangd'])).toThrow(
    'lacks clangd, its license or its clang headers',
  )
})

test('stages clangd and its clang headers from the pinned zip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-clangd-build-'))
  try {
    const source = join(directory, 'source/clangd_23.1.0')
    const output = join(directory, 'plugin')
    await mkdir(join(source, 'bin'), { recursive: true })
    await mkdir(join(source, 'lib/clang/23/include'), { recursive: true })
    await mkdir(output)
    await writeFile(join(source, 'bin/clangd'), 'clangd executable')
    await writeFile(join(source, 'LICENSE.TXT'), 'license')
    await writeFile(join(source, 'lib/clang/23/include/stddef.h'), 'header')
    await writeFile(join(source, 'README.md'), 'omit')
    const archive = join(directory, 'runtime.zip')
    execFileSync('zip', ['-qr', archive, 'clangd_23.1.0'], { cwd: join(directory, 'source') })
    const pinned = vi.fn(async () => archive)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(await readFile(join(output, 'bin/clangd'), 'utf8')).toBe('clangd executable')
    expect(await readFile(join(output, 'LICENSE.TXT'), 'utf8')).toBe('license')
    expect((await stat(join(output, 'bin/clangd'))).mode & 0o111).not.toBe(0)
    expect(await readFile(join(output, 'lib/clang/23/include/stddef.h'), 'utf8')).toBe('header')
    await expect(stat(join(output, 'README.md'))).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
