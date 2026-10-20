import { glob, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginCatalogSchema } from '@gode/plugin-sdk'
import { readPluginArchive } from '@gode/plugin-sdk/pack'
import { buildPluginRelease } from '@gode/plugin-sdk/release'
import { generatePluginSigningKey } from '@gode/plugin-sdk/sign'
import { localCatalog } from './index-logic.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
export const feed = join(repository, 'out/plugins')
const catalogPath = join(repository, 'catalog.json')

export async function buildIndex(paths, directory = feed) {
  const archives = []
  for await (const path of paths ?? glob(join(repository, 'plugins/*/out/*.tar.gz')))
    archives.push(await readPluginArchive(resolve(path)))
  pluginCatalogSchema.parse(JSON.parse(await readFile(catalogPath, 'utf8')))
  const key = generatePluginSigningKey()
  const catalog = localCatalog(archives, key.publicKey)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, '.dev-key.pem'), key.privateKey, { mode: 0o600 })
  for (const plugin of catalog.plugins) {
    const selected = archives.filter(
      (archive) =>
        archive.manifest.publisher === plugin.publisher && archive.manifest.id === plugin.id,
    )
    await buildPluginRelease(
      selected.map((archive) => archive.path),
      {
        privateKey: key.privateKey,
        out: join(directory, plugin.publisher, plugin.id),
      },
    )
  }
  await writeFile(join(directory, 'index.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  return catalog
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2)
  await buildIndex(paths.length ? paths : undefined)
  console.log(join(feed, 'index.json'))
}
