import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pluginManifestSchema, pluginPlatforms } from '@gode/plugin-sdk'
import { packPlugin } from '@gode/plugin-sdk/pack'
import { build } from 'esbuild'
import { selectedPlatforms, verifyLock } from './build-logic.mjs'

const exec = promisify(execFile)
const plugin = fileURLToPath(new URL('..', import.meta.url))

export async function buildPlugin(requested, overrides = {}) {
  const source = overrides.source ?? plugin
  const destination = overrides.output ?? join(plugin, 'out')
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')),
  )
  const server = JSON.parse(await readFile(join(source, 'server/package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(source, 'server/package-lock.json'), 'utf8'))
  verifyLock(lock, server)
  const platforms = selectedPlatforms(requested, pluginPlatforms)
  await mkdir(destination, { recursive: true })
  const archives = []
  for (const platform of platforms) {
    const staging = await mkdtemp(join(destination, '.build-'))
    try {
      const packageDir = join(staging, 'plugin')
      const serverDir = join(packageDir, 'server')
      await mkdir(serverDir, { recursive: true })
      for (const name of ['package.json', 'package-lock.json'])
        await cp(join(source, 'server', name), join(serverDir, name))
      await (overrides.install ?? exec)(
        'npm',
        [
          'ci',
          '--omit=dev',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--cache',
          join(destination, '.cache'),
        ],
        { cwd: serverDir },
      )
      await cp(join(source, 'manifest.json'), join(packageDir, 'manifest.json'))
      await build({
        entryPoints: [join(source, 'src/main.ts')],
        outfile: join(packageDir, manifest.main),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        logLevel: 'warning',
      })
      archives.push((await packPlugin(packageDir, platform, destination)).path)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  return archives
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2)
  if (requested[0] === '--') requested.shift()
  for (const archive of await buildPlugin(requested)) console.log(archive)
}
