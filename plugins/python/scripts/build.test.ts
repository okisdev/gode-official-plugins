import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import lock from '../server/package-lock.json'
import { assertLockedPackages, selectedPlatforms } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-python-build-'))
  directories.push(directory)
  const source = join(directory, 'python')
  const output = join(directory, 'out')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(source, 'server'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  await writeFile(join(source, 'server/package.json'), '{"name":"fixture","version":"1.0.0"}')
  await writeFile(
    join(source, 'server/package-lock.json'),
    JSON.stringify({ packages: { '': { name: 'fixture', version: '1.0.0' } } }),
  )
  const install = vi.fn(async (path: string) => {
    const server = join(path, 'node_modules', 'basedpyright')
    await mkdir(server, { recursive: true })
    await writeFile(join(server, 'langserver.index.js'), 'process.exit(0)')
  })
  return { directory, source, output, install }
}

test('selects four platforms and requires SHA-512 integrity for every locked package', () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  expect(lock.packages[''].dependencies.basedpyright).toBe('1.40.2')
  expect(lock.packages['node_modules/basedpyright'].version).toBe('1.40.2')
  expect(() => assertLockedPackages(lock)).not.toThrow()
  expect(() =>
    assertLockedPackages({
      packages: { 'node_modules/bad': { resolved: 'https://example.test/bad.tgz' } },
    }),
  ).toThrow('Unpinned package URL')
  expect(() =>
    assertLockedPackages({
      packages: { 'node_modules/bad': { resolved: 'https://registry.npmjs.org/bad/-/bad.tgz' } },
    }),
  ).toThrow('Missing SHA-512 integrity')
})

test('packs the locked server installation and no staging files', async () => {
  const fixture = await fixtures()
  const [archive = ''] = await buildPlugin(['linux-x64'], fixture)
  expect(fixture.install).toHaveBeenCalledTimes(1)
  expect(
    execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort(),
  ).toEqual(
    [
      'main.js',
      'manifest.json',
      'server/',
      'server/package.json',
      'server/package-lock.json',
      'server/node_modules/',
      'server/node_modules/basedpyright/',
      'server/node_modules/basedpyright/langserver.index.js',
    ].sort(),
  )
  expect(
    JSON.parse(await readFile(join(fixture.source, 'server/package-lock.json'), 'utf8')),
  ).toMatchObject({ packages: { '': { name: 'fixture' } } })
  expect(await readdir(fixture.output)).toEqual([`python-${manifest.version}-linux-x64.tar.gz`])
})

test('an installation failure leaves no archive or staging directory', async () => {
  const fixture = await fixtures()
  await expect(
    buildPlugin(['linux-x64'], {
      ...fixture,
      install: async () => {
        throw new Error('install failed')
      },
    }),
  ).rejects.toThrow('install failed')
  expect(await readdir(fixture.output)).toEqual([])
})
