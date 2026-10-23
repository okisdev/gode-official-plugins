import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@gode/plugin-sdk/test'
import pkg from '../server/package.json' with { type: 'json' }

const root = join(fileURLToPath(import.meta.url), '..', '..')
const serverVersion = pkg.dependencies['graphql-language-service-cli']

test('locks the exact graphql-language-service-cli version', async () => {
  expect(serverVersion).toMatch(/^\d+\.\d+\.\d+$/)
  const lock = JSON.parse(await readFile(join(root, 'server/package-lock.json'), 'utf8'))
  expect(lock.packages['node_modules/graphql-language-service-cli'].version).toBe(serverVersion)
})
