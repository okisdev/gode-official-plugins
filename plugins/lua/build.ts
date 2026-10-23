import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const archive = await stage.pinned(resources.platforms[stage.platform])
  await exec('tar', ['-xzf', archive, '-C', stage.directory])
}
