import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@gode/plugin-sdk/test'
import manifest from '../plugin.json'
import server from '../server/package.json'

const version = server.dependencies['dockerfile-language-server-nodejs']

test('pins the dockerfile-language-server-nodejs release in the manifest and lockfile', async () => {
  expect(manifest.includes).toContainEqual(
    expect.objectContaining({ name: 'dockerfile-language-server-nodejs', version }),
  )
  const lock = JSON.parse(
    await readFile(join(import.meta.dirname, '../server/package-lock.json'), 'utf8'),
  )
  expect(lock.packages[''].dependencies['dockerfile-language-server-nodejs']).toBe(version)
  expect(lock.packages[`node_modules/dockerfile-language-server-nodejs`].version).toBe(version)
  expect(lock.packages[`node_modules/dockerfile-language-server-nodejs`].integrity).toMatch(
    /^sha512-/,
  )
})
