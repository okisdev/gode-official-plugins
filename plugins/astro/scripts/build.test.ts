import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import { selectedPlatforms, verifyLock } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-astro-build-'))
  directories.push(directory)
  const source = join(directory, 'astro')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(source, 'server'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  for (const name of ['package.json', 'package-lock.json'])
    await cp(join(import.meta.dirname, '..', 'server', name), join(source, 'server', name))
  const output = join(directory, 'out')
  const install = vi.fn(async (_command: string, _args: string[], options: { cwd: string }) => {
    const modules = join(options.cwd, 'node_modules')
    await mkdir(join(modules, '@astrojs', 'language-server', 'bin'), { recursive: true })
    await mkdir(join(modules, 'typescript', 'lib'), { recursive: true })
    await writeFile(join(modules, '@astrojs', 'language-server', 'bin', 'nodeServer.js'), 'server')
    await writeFile(join(modules, 'typescript', 'lib', 'typescript.js'), 'typescript')
  })
  return { directory, source, output, install }
}

test('selects four platforms and requires exact, integrity-pinned server dependencies', async () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  const server = JSON.parse(
    await readFile(join(import.meta.dirname, '..', 'server/package.json'), 'utf8'),
  )
  const lock = JSON.parse(
    await readFile(join(import.meta.dirname, '..', 'server/package-lock.json'), 'utf8'),
  )
  expect(server.dependencies).toEqual({ '@astrojs/language-server': '2.17.1', typescript: '5.9.3' })
  expect(() => verifyLock(lock, server)).not.toThrow()
  expect(() =>
    verifyLock(lock, { ...server, dependencies: { ...server.dependencies, typescript: '^5.9.3' } }),
  ).toThrow()
  const changed = structuredClone(lock)
  delete changed.packages['node_modules/typescript'].integrity
  expect(() => verifyLock(changed, server)).toThrow('not pinned')
})

test('builds a self-contained platform archive with npm ci from the committed lockfile', async () => {
  const fixture = await fixtures()
  const [archive = ''] = await buildPlugin(['linux-x64'], fixture)
  expect(fixture.install).toHaveBeenCalledOnce()
  expect(fixture.install.mock.calls[0]?.[0]).toBe('npm')
  expect(fixture.install.mock.calls[0]?.[1]).toEqual(
    expect.arrayContaining(['ci', '--omit=dev', '--ignore-scripts']),
  )
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  expect(files).toEqual(
    expect.arrayContaining([
      'main.js',
      'manifest.json',
      'server/',
      'server/package.json',
      'server/package-lock.json',
      'server/node_modules/@astrojs/language-server/bin/nodeServer.js',
      'server/node_modules/typescript/lib/typescript.js',
    ]),
  )
  const unpacked = join(fixture.directory, 'unpacked')
  await mkdir(unpacked)
  execFileSync('tar', ['-xzf', archive, '-C', unpacked])
  expect(
    (await stat(join(unpacked, 'server/node_modules/typescript/lib/typescript.js'))).isFile(),
  ).toBe(true)
  expect(await readdir(fixture.output)).toEqual([`astro-${manifest.version}-linux-x64.tar.gz`])
})

test('rejects a corrupt server lock before installing or leaving an archive', async () => {
  const fixture = await fixtures()
  const path = join(fixture.source, 'server/package-lock.json')
  const lock = JSON.parse(await readFile(path, 'utf8'))
  lock.packages['node_modules/typescript'].integrity = 'bad'
  await writeFile(path, JSON.stringify(lock))
  await expect(buildPlugin(['linux-x64'], fixture)).rejects.toThrow('not pinned')
  expect(fixture.install).not.toHaveBeenCalled()
  await expect(readdir(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
})
