import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import pkg from '../server/package.json' with { type: 'json' }

test('locks the vscode-langservers-extracted release', () => {
  const version = pkg.dependencies['vscode-langservers-extracted']
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  const lock = JSON.parse(
    readFileSync(join(import.meta.dirname, '../server/package-lock.json'), 'utf8'),
  )
  expect(lock.packages[''].dependencies['vscode-langservers-extracted']).toBe(version)
  const pinned = lock.packages['node_modules/vscode-langservers-extracted']
  expect(pinned.version).toBe(version)
  expect(pinned.resolved).toBe(
    `https://registry.npmjs.org/vscode-langservers-extracted/-/vscode-langservers-extracted-${version}.tgz`,
  )
  expect(pinned.integrity).toMatch(/^sha512-[A-Za-z0-9+/=]+$/)
  expect(pinned.bin?.['vscode-json-language-server']).toBe('bin/vscode-json-language-server')
})
