import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pluginManifestSchema, pluginPlatforms } from '@gode/plugin-sdk'
import { packPlugin } from '@gode/plugin-sdk/pack'
import { build } from 'esbuild'
import { selectedPlatforms, verifyLockfile } from './build-logic.mjs'

const exec = promisify(execFile)
const plugin = fileURLToPath(new URL('..', import.meta.url))
const upstreamEntrySHA256 = '8a443ea5f74b175785a3d3bdf45e85c4c2055e910864e0bd44ae48f9d887c402'

async function installServer(server, cache) {
  await exec('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: server,
    env: { ...process.env, npm_config_cache: cache },
  })
}

export async function buildPlugin(requested, overrides = {}) {
  const source = overrides.source ?? plugin
  const destination = overrides.output ?? join(plugin, 'out')
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')),
  )
  const serverSource = join(source, 'server')
  const serverPackage = JSON.parse(await readFile(join(serverSource, 'package.json'), 'utf8'))
  const version = serverPackage.dependencies?.['svelte-language-server']
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Server package must pin an exact Svelte language server version')
  const lock = JSON.parse(await readFile(join(serverSource, 'package-lock.json'), 'utf8'))
  verifyLockfile(lock, version)
  const platforms = selectedPlatforms(requested, pluginPlatforms)
  await mkdir(destination, { recursive: true })
  const staging = await mkdtemp(join(destination, '.build-'))
  try {
    const server = join(staging, 'server')
    await mkdir(server)
    for (const name of ['package.json', 'package-lock.json'])
      await cp(join(serverSource, name), join(server, name))
    await (overrides.install ?? installServer)(server, join(destination, '.cache', 'npm'))
    const entry = join(server, 'node_modules', 'svelte-language-server', 'bin', 'server.js')
    await access(entry)
    const actual = createHash('sha256')
      .update(await readFile(entry))
      .digest('hex')
    if (actual !== upstreamEntrySHA256)
      throw new Error('Svelte server entry does not match the pinned version')
    await cp(join(source, 'scripts', 'pipe-entry.cjs'), entry)
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    await build({
      entryPoints: [join(source, 'src/main.ts')],
      outfile: join(staging, manifest.main),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      logLevel: 'warning',
    })
    const archives = []
    for (const platform of platforms)
      archives.push((await packPlugin(staging, platform, destination)).path)
    return archives
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2)
  if (requested[0] === '--') requested.shift()
  for (const archive of await buildPlugin(requested)) console.log(archive)
}
