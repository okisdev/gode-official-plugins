import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

export default async function build(stage: PluginStage): Promise<void> {
  const source = await stage.pinned(resources.platforms[stage.platform])
  const bin = join(stage.directory, 'bin')
  await mkdir(bin, { recursive: true })
  const executable = join(bin, 'coursier')
  await pipeline(createReadStream(source), createGunzip(), createWriteStream(executable))
  await chmod(executable, 0o755)
}
