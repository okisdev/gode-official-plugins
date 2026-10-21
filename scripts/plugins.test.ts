import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, test } from 'node:test'
import { locales } from '@gode/format'
import { pluginManifestSchema } from '@gode/plugin-sdk'
import { checkPlugin } from '@gode/plugin-sdk/check'
import { readPluginSource } from '@gode/plugin-sdk/source'

const plugins = resolve(import.meta.dirname, '..', 'plugins')

for (const id of readdirSync(plugins)) {
  const root = join(plugins, id)
  describe(id, () => {
    test('the manifest passes the SDK check', async () => {
      assert.deepEqual(await checkPlugin(root), [])
    })

    test('the manifest has a catalog for every supported locale', async () => {
      const source = await readPluginSource(root)
      const manifest = pluginManifestSchema.parse(source.manifest)
      assert.deepEqual(Object.keys(manifest.strings).sort(), [...locales].sort())
    })

    test('the plugin reaches Gode only through @gode/plugin-sdk', () => {
      const violations: string[] = []
      const files = ['src', 'test'].flatMap((folder) =>
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
