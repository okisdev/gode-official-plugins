import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { pluginCatalogSchema, pluginManifestSchema } from '@gode/plugin-sdk'
import { checkPlugin } from '@gode/plugin-sdk/check'
import { readPluginSource } from '@gode/plugin-sdk/source'

const plugins = resolve(import.meta.dirname, '..', 'plugins')

for (const id of readdirSync(plugins)) {
  const root = join(plugins, id)
  describe(id, () => {
    test('the manifest passes the SDK check', async () => {
      assert.deepEqual(await checkPlugin(root), [])
    })

    test('the plugin reaches Gode only through @gode/plugin-sdk', async () => {
      const violations: string[] = []
      const { manifest } = await readPluginSource(root)
      const files = ['src', 'test']
        .filter((folder) => manifest.pack === undefined || existsSync(join(root, folder)))
        .flatMap((folder) =>
          readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
            .map((entry) => join(entry.parentPath, entry.name)),
        )
      if (readdirSync(root).includes('build.ts')) files.push(join(root, 'build.ts'))
      for (const path of files) {
        const source = readFileSync(path, 'utf8')
        for (const [, from, bare, dynamic] of source.matchAll(
          /^(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'|^import\s*'([^']+)'|\bimport\(\s*'([^']+)'/gm,
        )) {
          const specifier = from ?? bare ?? dynamic ?? ''
          const target = resolve(dirname(path), specifier)
          const offset = relative(root, target)
          const allowed = specifier.startsWith('.')
            ? offset !== '..' && !offset.startsWith(`..${sep}`)
            : specifier.startsWith('node:') || /^@gode\/plugin-sdk(?:\/.*)?$/.test(specifier)
          if (!allowed) violations.push(`${id}/${relative(root, path)} -> ${specifier}`)
        }
      }
      assert.deepEqual(violations, [])
    })
  })
}

test('Vite+ is a cataloged pack of Oxc and Oxfmt without a process or languages', async () => {
  const root = join(plugins, 'vite-plus')
  const source = await readPluginSource(root)
  assert.deepEqual(source.problems, [])
  const manifest = pluginManifestSchema.parse(source.manifest)
  assert.deepEqual(manifest.pack, ['gode/oxc', 'gode/oxfmt'])
  assert.deepEqual(manifest.capabilities, [])
  assert.equal(manifest.languages, undefined)
  assert.deepEqual(
    readdirSync(root)
      .filter((entry) => !['node_modules', 'out'].includes(entry))
      .sort(),
    ['i18n', 'icon.svg', 'package.json', 'plugin.json'],
  )
  const catalog = pluginCatalogSchema.parse(
    JSON.parse(readFileSync(join(plugins, '..', 'catalog.json'), 'utf8')),
  )
  const index = catalog.plugins.findIndex((plugin) => plugin.id === 'oxfmt')
  assert.ok(index >= 0)
  assert.deepEqual(catalog.plugins[index + 1], {
    ...catalog.plugins[index],
    id: 'vite-plus',
    source: 'gode/vite-plus/releases.json',
  })
})
