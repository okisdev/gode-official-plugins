import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pluginManifestSchema, pluginPlatforms } from '@gode/plugin-sdk'
import { packPlugin } from '@gode/plugin-sdk/pack'
import { build } from 'esbuild'
import { selectedPlatforms, verifyServerLock } from './build-logic.mjs'

const exec = promisify(execFile)
const plugin = fileURLToPath(new URL('..', import.meta.url))

export async function buildPlugin(requested, overrides = {}) {
  const source = overrides.source ?? plugin
  const destination = overrides.output ?? join(plugin, 'out')
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')),
  )
  const server = join(source, 'server')
  const serverManifest = JSON.parse(await readFile(join(server, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(server, 'package-lock.json'), 'utf8'))
  verifyServerLock(serverManifest, lock)
  const platforms = selectedPlatforms(requested, pluginPlatforms)
  await mkdir(destination, { recursive: true })
  const archives = []
  for (const platform of platforms) {
    const staging = await mkdtemp(join(destination, '.build-'))
    try {
      const packageDir = join(staging, 'plugin')
      const serverDir = join(packageDir, 'server')
      await mkdir(serverDir, { recursive: true })
      await cp(join(server, 'package.json'), join(serverDir, 'package.json'))
      await cp(join(server, 'package-lock.json'), join(serverDir, 'package-lock.json'))
      await (overrides.install ?? installServer)(serverDir, destination)
      await writeFile(join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
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

async function installServer(server, destination) {
  await exec(
    'npm',
    ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', server],
    {
      env: { ...process.env, npm_config_cache: join(destination, '.cache', 'npm') },
      maxBuffer: 16 * 1024 * 1024,
    },
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2)
  if (requested[0] === '--') requested.shift()
  for (const archive of await buildPlugin(requested)) console.log(archive)
}
