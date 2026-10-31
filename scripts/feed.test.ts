import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginCatalogSchema, type PluginManifest } from '@gode/plugin-sdk'
import { packPlugin } from '@gode/plugin-sdk/pack'
import { readSignedPluginReleases } from '@gode/plugin-sdk/sign'
import { afterEach, test } from 'node:test'
import { localCatalog } from './index-logic.mjs'
import { buildIndex } from './index.mjs'
import {
  archiveMatches,
  catalogPlan,
  deletePlan,
  releasePlan,
  retainedReleases,
} from './release-logic.mjs'

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
  stores: [],
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
  assert.deepEqual(pluginCatalogSchema.parse(catalog), catalog)
  assert.deepEqual(JSON.parse(await readFile(join(feed, 'index.json'), 'utf8')), catalog)
  assert.deepEqual((await readdir(feed)).sort(), ['.dev-key.pem', 'gode', 'index.json'])
  assert.deepEqual((await readdir(join(feed, 'gode/echo'))).sort(), [
    'echo-1.0.0-darwin-arm64.tar.br',
    'echo-1.0.0-linux-x64.tar.br',
    'releases.json',
  ])
  const releases = readSignedPluginReleases(
    JSON.parse(await readFile(join(feed, 'gode/echo/releases.json'), 'utf8')),
  )
  assert.equal(releases.publicKey, catalog.plugins[0]?.publicKey)
  assert.deepEqual(Object.keys(releases.releases[0]!.builds).sort(), ['darwin-arm64', 'linux-x64'])
  assert.equal(releases.releases[0]!.builds['linux-x64']?.url, 'echo-1.0.0-linux-x64.tar.br')
})

test('catalog rejects inconsistent or repeated builds', async () => {
  const first = await archives()
  const second = await archives({ ...manifest, version: '2.0.0' })
  const key = 'wJs_n7Y1AOGueMmZxdB11qxUmh-XmzNRdibp1kc1mvM'
  assert.throws(() => localCatalog([first.built[0], second.built[0]], key), /Inconsistent/)
  assert.throws(() => localCatalog([first.built[0], first.built[0]], key), /Duplicate/)
  assert.throws(() => localCatalog([], key), /No plugin archives/)
})

test('release plan uploads archives before the signed file and keeps the catalog separate', () => {
  const plan = releasePlan('echo', '/tmp/echo', ['echo-1.0.0-linux-x64.tar.br'])
  assert.deepEqual(
    plan.map((item) => item.file),
    ['gode/echo/echo-1.0.0-linux-x64.tar.br', 'gode/echo/releases.json'],
  )
  assert.ok(plan[0]?.args.includes('gode/updates/plugins/gode/echo/echo-1.0.0-linux-x64.tar.br'))
  assert.ok(plan[0]?.args.includes('public, max-age=31536000, immutable'))
  assert.ok(plan[1]?.args.includes('no-cache'))
  assert.ok(catalogPlan('/tmp/catalog.json').args.includes('gode/updates/plugins/index.json'))
  assert.equal(archiveMatches(Buffer.from('same'), Buffer.from('same')), true)
  assert.equal(archiveMatches(Buffer.from('local'), Buffer.from('remote')), false)
})

function release(
  version: string,
  minimumAppVersion: string,
  platforms = ['linux-x64', 'darwin-arm64'],
) {
  return {
    manifest: { version, minimumAppVersion },
    builds: Object.fromEntries(
      platforms.map((platform) => [platform, { url: `echo-${version}-${platform}.tar.br` }]),
    ),
  }
}

test('retention keeps three newest releases and the newest release for each older app minimum', () => {
  const releases = [
    release('1.12.0', '0.3.0'),
    release('1.11.0', '0.4.0'),
    release('1.10.0', '0.3.0'),
    release('1.9.0', '0.3.0'),
    release('1.8.0', '0.2.0'),
    release('1.7.0', '0.2.0'),
    release('1.6.0', '0.1.19'),
    release('1.5.0', '0.1.19-beta.92'),
    release('1.4.0', '0.1.19-beta.84'),
    release('1.3.0', '0.1.19-beta.84'),
    release('1.2.0', '0.1.19'),
    release('1.1.0', '0.5.0'),
  ]
  const original = structuredClone(releases)
  assert.deepEqual(
    retainedReleases(releases).map((item) => item.manifest.version),
    ['1.12.0', '1.11.0', '1.10.0', '1.8.0', '1.6.0', '1.5.0', '1.4.0'],
  )
  assert.deepEqual(releases, original)
  assert.deepEqual(retainedReleases(releases.slice(0, 2)), releases.slice(0, 2))
})

test('deletion plan removes only old unreferenced plugin archives from R2', () => {
  const previous = [
    release('1.4.0', '0.3.0'),
    release('1.3.0', '0.3.0'),
    release('1.2.0', '0.2.0'),
    release('1.1.0', '0.2.0'),
    release('1.0.0', '0.1.0'),
  ]
  previous[4]!.builds['darwin-arm64'] = { url: 'https://example.com/external.tar.br' }
  const retained = [release('1.5.0', '0.3.0'), ...previous.slice(0, 3)]
  const plan = deletePlan('echo', previous, retained)
  assert.deepEqual(
    plan.map((item) => item.file),
    [
      'gode/echo/echo-1.1.0-linux-x64.tar.br',
      'gode/echo/echo-1.1.0-darwin-arm64.tar.br',
      'gode/echo/echo-1.0.0-linux-x64.tar.br',
    ],
  )
  assert.deepEqual(plan[0]?.args, [
    'exec',
    'wrangler',
    'r2',
    'object',
    'delete',
    'gode/updates/plugins/gode/echo/echo-1.1.0-linux-x64.tar.br',
    '--remote',
  ])
  assert.deepEqual(deletePlan('echo', previous, previous), [])
})
