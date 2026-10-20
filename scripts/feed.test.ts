import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginCatalogSchema, type PluginManifest } from '@gode/plugin-sdk'
import { packPlugin } from '@gode/plugin-sdk/pack'
import { readSignedPluginReleases } from '@gode/plugin-sdk/sign'
import { afterEach, expect, test } from 'vitest'
import { localCatalog } from './index-logic.mjs'
import { buildIndex } from './index.mjs'
import { archiveMatches, catalogPlan, releasePlan } from './release-logic.mjs'

const manifest: PluginManifest = {
  id: 'echo',
  publisher: 'gode',
  version: '1.0.0',
  minimumAppVersion: '0.1.0',
  capabilities: ['dictation'],
  main: 'main.js',
  name: 'name',
  description: 'description',
  groups: [],
  actions: [],
  strings: { en: { name: 'Echo', description: 'Types what it hears.' } },
}

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function archives(contents: PluginManifest = manifest) {
  const directory = await mkdtemp(join(tmpdir(), 'gode-plugin-feed-'))
  directories.push(directory)
  const source = join(directory, 'source')
  await mkdir(source)
  await writeFile(join(source, 'manifest.json'), JSON.stringify(contents))
  await writeFile(join(source, 'main.js'), '')
  return {
    directory,
    built: [
      await packPlugin(source, 'linux-x64', join(directory, 'out')),
      await packPlugin(source, 'darwin-arm64', join(directory, 'out')),
    ],
  }
}

test('local feed writes a catalog, signed releases, and archives under publisher and id', async () => {
  const { directory, built } = await archives()
  const feed = join(directory, 'feed')
  const catalog = await buildIndex(
    built.map((archive) => archive.path),
    feed,
  )
  expect(pluginCatalogSchema.parse(catalog)).toEqual(catalog)
  expect(JSON.parse(await readFile(join(feed, 'index.json'), 'utf8'))).toEqual(catalog)
  expect((await readdir(feed)).sort()).toEqual(['.dev-key.pem', 'gode', 'index.json'])
  expect((await readdir(join(feed, 'gode/echo'))).sort()).toEqual([
    'echo-1.0.0-darwin-arm64.tar.gz',
    'echo-1.0.0-linux-x64.tar.gz',
    'releases.json',
  ])
  const releases = readSignedPluginReleases(
    JSON.parse(await readFile(join(feed, 'gode/echo/releases.json'), 'utf8')),
  )
  expect(releases.publicKey).toBe(catalog.plugins[0]?.publicKey)
  expect(Object.keys(releases.releases[0]!.builds).sort()).toEqual(['darwin-arm64', 'linux-x64'])
  expect(releases.releases[0]!.builds['linux-x64']?.url).toBe('echo-1.0.0-linux-x64.tar.gz')
})

test('catalog rejects inconsistent or repeated builds', async () => {
  const first = await archives()
  const second = await archives({ ...manifest, version: '2.0.0' })
  const key = 'wJs_n7Y1AOGueMmZxdB11qxUmh-XmzNRdibp1kc1mvM'
  expect(() => localCatalog([first.built[0], second.built[0]], key)).toThrow('Inconsistent')
  expect(() => localCatalog([first.built[0], first.built[0]], key)).toThrow('Duplicate')
  expect(() => localCatalog([], key)).toThrow('No plugin archives')
})

test('release plan uploads archives before the signed file and keeps the catalog separate', () => {
  const plan = releasePlan('echo', '/tmp/echo', ['echo-1.0.0-linux-x64.tar.gz'])
  expect(plan.map((item) => item.file)).toEqual([
    'gode/echo/echo-1.0.0-linux-x64.tar.gz',
    'gode/echo/releases.json',
  ])
  expect(plan[0]?.args).toContain('gode/updates/plugins/gode/echo/echo-1.0.0-linux-x64.tar.gz')
  expect(plan[0]?.args).toContain('public, max-age=31536000, immutable')
  expect(plan[1]?.args).toContain('no-cache')
  expect(catalogPlan('/tmp/catalog.json').args).toContain('gode/updates/plugins/index.json')
  expect(archiveMatches(Buffer.from('same'), Buffer.from('same'))).toBe(true)
  expect(archiveMatches(Buffer.from('local'), Buffer.from('remote'))).toBe(false)
})
