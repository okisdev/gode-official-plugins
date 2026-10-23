import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const run = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const asset = resources.platforms[stage.platform]
  const archive = await stage.pinned(asset)
  const destination = join(stage.directory, 'server')
  await mkdir(destination, { recursive: true })
  if (stage.platform.startsWith('darwin')) {
    await run('unzip', ['-q', archive, '-d', destination])
  } else {
    await run('tar', ['-xzf', archive, '-C', destination])
  }
}
