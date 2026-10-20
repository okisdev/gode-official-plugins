import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pluginManifestSchema, pluginPlatforms } from '@gode/plugin-sdk'
import { packPlugin } from '@gode/plugin-sdk/pack'
import { build } from 'esbuild'
import { runtimeFiles, selectedPlatforms, verifySHA256 } from './build-logic.mjs'

const exec = promisify(execFile)
const plugin = fileURLToPath(new URL('..', import.meta.url))

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadRuntime(asset, destination) {
  const response = await fetch(asset.url)
  if (!response.ok || !response.body)
    throw new Error(`Failed to download ${asset.url}: HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function cachedRuntime(asset, cache, download) {
  const target = join(cache, asset.file)
  try {
    verifySHA256(await sha256(target), asset.sha256, asset.file)
    return target
  } catch (error) {
    if (error.code !== 'ENOENT' && !error.message.startsWith('SHA-256 mismatch')) throw error
    await rm(target, { force: true })
  }
  const partial = `${target}.partial`
  try {
    await download(asset, partial)
    verifySHA256(await sha256(partial), asset.sha256, asset.file)
    await rename(partial, target)
    return target
  } finally {
    await rm(partial, { force: true })
  }
}

export async function buildPlugin(requested, overrides = {}) {
  const source = overrides.source ?? plugin
  const destination = overrides.output ?? join(plugin, 'out')
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')),
  )
  const resources = JSON.parse(await readFile(join(source, 'resources.json'), 'utf8'))
  const platforms = selectedPlatforms(requested, pluginPlatforms)
  const cache = join(destination, '.cache')
  await mkdir(cache, { recursive: true })
  const archives = []
  for (const platform of platforms) {
    const asset = resources.platforms[platform]
    if (!asset) throw new Error(`No runtime for ${platform}`)
    const runtime = await cachedRuntime(asset, cache, overrides.download ?? downloadRuntime)
    const staging = await mkdtemp(join(destination, '.build-'))
    try {
      const { stdout } = await exec('tar', ['-tzf', runtime])
      const members = runtimeFiles(stdout.trim().split('\n'))
      await exec('tar', ['-xzf', runtime, '-C', staging, ...members])
      const packageDir = join(staging, 'plugin')
      await mkdir(packageDir)
      await cp(join(staging, 'package/lib'), join(packageDir, 'bin'), { recursive: true })
      for (const name of ['LICENSE', 'NOTICE.txt'])
        await cp(join(staging, 'package', name), join(packageDir, name))
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requested = process.argv.slice(2)
  if (requested[0] === '--') requested.shift()
  for (const archive of await buildPlugin(requested)) console.log(archive)
}
