import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { afterEach, expect, test, vi } from 'vitest'
import manifest from '../manifest.json'
import serverLock from '../server/package-lock.json'
import serverManifest from '../server/package.json'
import { selectedPlatforms, verifyServerLock } from './build-logic.mjs'
import { buildPlugin } from './build.mjs'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixtures() {
  const directory = await mkdtemp(join(tmpdir(), 'gode-vue-build-'))
  directories.push(directory)
  const source = join(directory, 'vue')
  const output = join(directory, 'out')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(source, 'server'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'src/main.ts'), 'process.parentPort.on("message", () => {})')
  await writeFile(join(source, 'server/package.json'), JSON.stringify(serverManifest))
  await writeFile(join(source, 'server/package-lock.json'), JSON.stringify(serverLock))
  const install = vi.fn(async (server: string) => {
    const bin = join(server, 'node_modules/@vue/language-server/bin')
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'vue-language-server.js'), 'process.exit(0)')
    await mkdir(join(server, 'node_modules/typescript/lib'), { recursive: true })
    await writeFile(join(server, 'node_modules/typescript/lib/typescript.js'), '')
  })
  return { source, output, install, directory }
}

test('selects four platforms and requires registry SHA-512 integrity for every server package', () => {
  expect(selectedPlatforms([], pluginPlatforms)).toEqual([
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
  ])
  expect(selectedPlatforms(['linux-x64', 'linux-x64'], pluginPlatforms)).toEqual(['linux-x64'])
  expect(() => selectedPlatforms(['windows-x64'], pluginPlatforms)).toThrow('Unsupported')
  expect(() => verifyServerLock(serverManifest, serverLock)).not.toThrow()
  const corrupt = structuredClone(serverLock)
  delete (corrupt.packages['node_modules/@vue/language-server'] as { integrity?: string }).integrity
  expect(() => verifyServerLock(serverManifest, corrupt)).toThrow('lacks SHA-512 integrity')
  expect(() =>
    verifyServerLock(
      { ...serverManifest, dependencies: { ...serverManifest.dependencies, typescript: '5.9.3' } },
      serverLock,
    ),
  ).toThrow('differ from the lockfile')
})

test('packs the server and leaves no staging directory', async () => {
  const fixture = await fixtures()
  const [archive = ''] = await buildPlugin(['linux-x64'], fixture)
  const files = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n')
  expect(files).toContain('manifest.json')
  expect(files).toContain('main.js')
  expect(files).toContain('server/package.json')
  expect(files).toContain('server/package-lock.json')
  expect(files).toContain('server/node_modules/@vue/language-server/bin/vue-language-server.js')
  expect(files).toContain('server/node_modules/typescript/lib/typescript.js')
  expect(
    JSON.parse(execFileSync('tar', ['-xOzf', archive, 'manifest.json'], { encoding: 'utf8' })).id,
  ).toBe('vue')
  expect(await readdir(fixture.output)).toEqual([`vue-${manifest.version}-linux-x64.tar.gz`])
  expect(fixture.install).toHaveBeenCalledTimes(1)
})

test('rejects a broken lock before installing or publishing an archive', async () => {
  const fixture = await fixtures()
  const corrupt = JSON.parse(
    await readFile(join(fixture.source, 'server/package-lock.json'), 'utf8'),
  )
  corrupt.packages['node_modules/@vue/language-server'].integrity = 'bad'
  await writeFile(join(fixture.source, 'server/package-lock.json'), JSON.stringify(corrupt))
  await expect(buildPlugin(['linux-x64'], fixture)).rejects.toThrow('lacks SHA-512 integrity')
  expect(fixture.install).not.toHaveBeenCalled()
  await expect(readdir(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' })
})
