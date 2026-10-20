import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import lock from '../server/package-lock.json'
import { selectedPlatforms, verifyLockfile } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const root = resolve(import.meta.dirname, '..')
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-svelte-build-'))
  directories.push(directory)
  const source = join(directory, 'svelte')
  const output = join(directory, 'out')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(source, 'scripts'))
  await mkdir(join(source, 'server'))
  await copyFile(join(root, 'manifest.json'), join(source, 'manifest.json'))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  await copyFile(join(root, 'scripts/pipe-entry.cjs'), join(source, 'scripts/pipe-entry.cjs'))
  for (const name of ['package.json', 'package-lock.json'])
    await copyFile(join(root, 'server', name), join(source, 'server', name))
  const install = vi.fn(async (server: string) => {
    const bin = join(server, 'node_modules', 'svelte-language-server', 'bin')
    await mkdir(bin, { recursive: true })
    await writeFile(
      join(bin, 'server.js'),
      "#! /usr/bin/env node\n\nconst { startServer } = require('../dist/src/server');\n\nstartServer();\n",
    )
  })
  return { directory, source, output, install }
}

test('selects four platforms and requires a registry SHA-512 for every locked package', () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  expect(lock.packages['node_modules/svelte-language-server'].version).toBe('0.18.4')
  expect(() => verifyLockfile(lock, '0.18.4')).not.toThrow()
  expect(() => verifyLockfile(lock, '0.18.5')).toThrow('does not pin')
  const altered = structuredClone(lock)
  altered.packages['node_modules/svelte-language-server'].integrity = 'sha512-invalid'
  expect(() => verifyLockfile(altered, '0.18.4')).toThrow('SHA-512')
})

test('builds matching self-contained archives for requested platforms', async () => {
  const fixture = await fixtures()
  const archives = await buildPlugin(['darwin-arm64', 'linux-x64'], fixture)
  expect(fixture.install).toHaveBeenCalledTimes(1)
  expect(archives).toHaveLength(2)
  const contents = archives.map((archive) =>
    execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort(),
  )
  expect(contents[0]).toEqual(contents[1])
  expect(contents[0]).toContain('main.js')
  expect(contents[0]).toContain('manifest.json')
  expect(contents[0]).toContain('server/node_modules/svelte-language-server/bin/server.js')
  expect(contents[0]).toContain('server/package-lock.json')
  expect(
    execFileSync(
      'tar',
      ['-xOzf', archives[0]!, 'server/node_modules/svelte-language-server/bin/server.js'],
      { encoding: 'utf8' },
    ),
  ).toContain('createConnection()')
  expect(await readdir(fixture.output)).toEqual([
    `svelte-${manifest.version}-darwin-arm64.tar.gz`,
    `svelte-${manifest.version}-linux-x64.tar.gz`,
  ])
})

test('rejects a broken lock without installing or leaving an archive', async () => {
  const fixture = await fixtures()
  const path = join(fixture.source, 'server', 'package-lock.json')
  const altered = JSON.parse(await readFile(path, 'utf8'))
  delete altered.packages['node_modules/svelte-language-server'].integrity
  await writeFile(path, JSON.stringify(altered))
  await expect(buildPlugin(['linux-x64'], fixture)).rejects.toThrow('SHA-512')
  expect(fixture.install).not.toHaveBeenCalled()
  await expect(readdir(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
})
