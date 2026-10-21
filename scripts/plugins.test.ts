import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { locales } from '@gode/format'
import { checkPlugin } from '@gode/plugin-sdk/check'
import { describe, expect, test } from 'vitest'

const plugins = resolve(import.meta.dirname, '..', 'plugins')
const support = resolve(import.meta.dirname, '..', 'test-support')

for (const id of readdirSync(plugins)) {
  const root = join(plugins, id)
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    strings: Record<string, unknown>
  }
  describe(id, () => {
    test('the manifest passes the SDK check', async () => {
      expect(await checkPlugin(root)).toEqual([])
    })

    test('the manifest has a catalog for every supported locale', () => {
      expect(Object.keys(manifest.strings).sort()).toEqual([...locales].sort())
    })

    test('the plugin reaches Gode only through @gode/plugin-sdk', () => {
      const violations: string[] = []
      const files = readdirSync(join(root, 'src'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(root, 'src', name))
      if (readdirSync(root).includes('build.ts')) files.push(join(root, 'build.ts'))
      if (readdirSync(root).includes('build.test.ts')) files.push(join(root, 'build.test.ts'))
      for (const path of files) {
        const source = readFileSync(path, 'utf8')
        for (const [, from, bare, dynamic] of source.matchAll(
          /^(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'|^import\s*'([^']+)'|\bimport\(\s*'([^']+)'/gm,
        )) {
          const specifier = from ?? bare ?? dynamic ?? ''
          const testFile = path.endsWith('.test.ts')
          const target = resolve(dirname(path), specifier)
          const inside = (folder: string) => {
            const offset = relative(folder, target)
            return offset !== '..' && !offset.startsWith(`..${sep}`)
          }
          const allowed = specifier.startsWith('.')
            ? inside(root) || (testFile && inside(support))
            : specifier.startsWith('node:') ||
              /^@gode\/plugin-sdk(?:\/.*)?$/.test(specifier) ||
              (testFile && specifier === 'vitest')
          if (!allowed) violations.push(`${id}/${relative(root, path)} -> ${specifier}`)
        }
      }
      expect(violations).toEqual([])
    })
  })
}
