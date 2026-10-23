import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import pkg from '../server/package.json' with { type: 'json' }

test('locks the yaml-language-server release', () => {
  const version = pkg.dependencies['yaml-language-server']
  expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  const lock = JSON.parse(
    readFileSync(join(import.meta.dirname, '../server/package-lock.json'), 'utf8'),
  )
  expect(lock.packages[''].dependencies['yaml-language-server']).toBe(version)
  const pinned = lock.packages['node_modules/yaml-language-server']
  expect(pinned.version).toBe(version)
  expect(pinned.resolved).toBe(
    `https://registry.npmjs.org/yaml-language-server/-/yaml-language-server-${version}.tgz`,
  )
  expect(pinned.integrity).toMatch(/^sha512-[A-Za-z0-9+/=]+$/)
  expect(pinned.bin?.['yaml-language-server']).toBe('bin/yaml-language-server')
})
