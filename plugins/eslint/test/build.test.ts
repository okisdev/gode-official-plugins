import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import manifest from '../plugin.json' with { type: 'json' }
import serverPackage from '../server/package.json' with { type: 'json' }

test('pins vscode-langservers-extracted to the manifest version', () => {
  const included = manifest.includes.find((entry) => entry.name === 'vscode-langservers-extracted')
  expect(included?.version).toBe('4.10.0')
  expect(serverPackage.dependencies['vscode-langservers-extracted']).toBe(included?.version)
  const lock = JSON.parse(
    readFileSync(join(import.meta.dirname, '../server/package-lock.json'), 'utf8'),
  ) as {
    packages: Record<string, { version?: string }>
  }
  expect(lock.packages['node_modules/vscode-langservers-extracted']?.version).toBe('4.10.0')
})
