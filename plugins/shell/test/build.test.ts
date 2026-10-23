import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import manifest from '../plugin.json'
import server from '../server/package.json'

const version = server.dependencies['bash-language-server']

test('pins the bash-language-server release in the manifest and lockfile', async () => {
  expect(manifest.includes).toContainEqual(
    expect.objectContaining({ name: 'bash-language-server', version }),
  )
  const lock = JSON.parse(
    await readFile(join(import.meta.dirname, '../server/package-lock.json'), 'utf8'),
  )
  expect(lock.packages[''].dependencies['bash-language-server']).toBe(version)
  expect(lock.packages['node_modules/bash-language-server'].version).toBe(version)
  expect(lock.packages['node_modules/bash-language-server'].integrity).toMatch(/^sha512-/)
})
