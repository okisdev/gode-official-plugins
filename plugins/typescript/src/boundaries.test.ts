import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { expect, test } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const packages = new Set([
  '@gode/plugin-sdk',
  '@gode/plugin-sdk/plugin',
  '@gode/plugin-sdk/pack',
  'esbuild',
  'vitest',
])
const testPackages = new Set(['@gode/format', '@gode/format/typography'])

test('the plugin reaches Gode only through @gode/plugin-sdk, as a plugin from any publisher would', () => {
  const violations: string[] = []
  for (const folder of ['src', 'scripts'])
    for (const name of readdirSync(join(root, folder))) {
      if (!/\.(?:ts|mjs)$/.test(name)) continue
      const path = join(root, folder, name)
      const source = readFileSync(path, 'utf8')
      for (const [, from, bare, dynamic] of source.matchAll(
        /^(?:import|export)\b[^;]*?\bfrom\s*'([^']+)'|^import\s*'([^']+)'|\bimport\(\s*'([^']+)'/gm,
      )) {
        const specifier = from ?? bare ?? dynamic ?? ''
        const allowed = specifier.startsWith('.')
          ? !relative(root, resolve(dirname(path), specifier)).startsWith(`..${sep}`)
          : specifier.startsWith('node:') ||
            packages.has(specifier) ||
            (name.endsWith('.test.ts') && testPackages.has(specifier))
        if (!allowed) violations.push(`${folder}/${name} -> ${specifier}`)
      }
    }
  expect(violations).toEqual([])
})
