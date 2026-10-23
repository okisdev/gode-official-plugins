import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@gode/plugin-sdk/test'
import pkg from '../server/package.json' with { type: 'json' }

const root = join(fileURLToPath(import.meta.url), '..', '..')
const serverVersion = pkg.dependencies['@prisma/language-server']

test('locks the exact @prisma/language-server version', async () => {
  expect(serverVersion).toMatch(/^\d+\.\d+\.\d+$/)
  const lock = JSON.parse(await readFile(join(root, 'server/package-lock.json'), 'utf8'))
  expect(lock.packages['node_modules/@prisma/language-server'].version).toBe(serverVersion)
})
