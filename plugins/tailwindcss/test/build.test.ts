import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import manifest from '../plugin.json' with { type: 'json' }
import serverPackage from '../server/package.json' with { type: 'json' }

test('pins @tailwindcss/language-server to the manifest version', () => {
  const included = manifest.includes.find((entry) => entry.name === '@tailwindcss/language-server')
  expect(included?.version).toBe('0.14.29')
  expect(serverPackage.dependencies['@tailwindcss/language-server']).toBe(included?.version)
  const lock = JSON.parse(
    readFileSync(join(import.meta.dirname, '../server/package-lock.json'), 'utf8'),
  ) as {
    packages: Record<string, { version?: string }>
  }
  expect(lock.packages['node_modules/@tailwindcss/language-server']?.version).toBe('0.14.29')
})
