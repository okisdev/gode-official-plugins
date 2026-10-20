import { execFileSync } from 'node:child_process'
import { glob, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginCatalogSchema } from '@gode/plugin-sdk'
import { buildPluginRelease } from '@gode/plugin-sdk/release'
import { pluginPublicKey } from '@gode/plugin-sdk/sign'
import { archiveMatches, catalogPlan, releasePlan } from './release-logic.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const catalogPath = join(repository, 'catalog.json')
const remote = 'https://gode.harisfox.com/updates/plugins'

/** The `gode-plugin-signing` Keychain password holds the PKCS #8 PEM encoded as base64. */
function signingKey() {
  const encoded = execFileSync(
    'security',
    ['find-generic-password', '-s', 'gode-plugin-signing', '-w'],
    { encoding: 'utf8' },
  ).trim()
  const pem = Buffer.from(encoded, 'base64').toString('utf8')
  pluginPublicKey(pem)
  return pem
}

function upload(item) {
  execFileSync('pnpm', item.args, { cwd: repository, stdio: 'inherit' })
}

async function catalog() {
  return pluginCatalogSchema.parse(JSON.parse(await readFile(catalogPath, 'utf8')))
}

export async function releasePlugin(id) {
  if (!id || !/^[a-z][a-z0-9-]{1,39}$/.test(id)) throw new Error('Usage: pnpm release <id>')
  const entry = (await catalog()).plugins.find(
    (plugin) => plugin.publisher === 'gode' && plugin.id === id,
  )
  if (!entry) throw new Error(`Plugin is absent from catalog: gode/${id}`)
  const privateKey = signingKey()
  if (entry.publicKey !== pluginPublicKey(privateKey))
    throw new Error('Catalog Gode key differs from the signing key')
  const archives = []
  for await (const path of glob(join(repository, `plugins/${id}/out/*.tar.gz`))) archives.push(path)
  if (!archives.length) throw new Error(`No archives for gode/${id}`)
  const previousUrl = `${remote}/gode/${id}/releases.json`
  const previousResponse = await fetch(previousUrl)
  if (!previousResponse.ok && previousResponse.status !== 404)
    throw new Error(`Could not read current releases: ${previousResponse.status}`)
  const directory = await mkdtemp(join(tmpdir(), 'gode-plugin-release-'))
  try {
    const previous = previousResponse.status === 404 ? undefined : join(directory, 'previous.json')
    if (previous) await writeFile(previous, await previousResponse.text())
    const releases = await buildPluginRelease(archives, {
      privateKey,
      out: directory,
      previous,
    })
    if (releases.publisher !== 'gode' || releases.id !== id)
      throw new Error(`Archives do not belong to gode/${id}`)
    const plan = releasePlan(
      id,
      directory,
      archives.map((path) => basename(path)),
    )
    const uploadArchives = []
    for (const item of plan.slice(0, -1)) {
      const response = await fetch(`${remote}/${item.file}`)
      if (response.status === 404) {
        uploadArchives.push(item)
      } else if (!response.ok) {
        throw new Error(`Could not compare remote archive: ${response.status}`)
      } else if (
        !archiveMatches(
          await readFile(join(directory, basename(item.file))),
          Buffer.from(await response.arrayBuffer()),
        )
      ) {
        throw new Error(`Remote archive has different bytes: ${item.file}`)
      }
    }
    for (const item of uploadArchives) upload(item)
    upload(plan.at(-1))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function publishCatalog() {
  await catalog()
  upload(catalogPlan(catalogPath))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await releasePlugin(process.argv[2])
