import { execFile } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const asset = resources.platforms[stage.platform]
  const runtime = await stage.pinned(asset)
  const bin = join(stage.directory, 'bin')
  await mkdir(bin, { recursive: true })
  const directory = asset.url
    .split('/')
    .at(-1)
    ?.replace(/\.tar\.gz$/, '')
  if (!directory) throw new Error('Tinymist archive name is missing')
  await exec('tar', ['-xzf', runtime, '-C', bin, '--strip-components=1', `${directory}/tinymist`])
  await chmod(join(bin, 'tinymist'), 0o755)
}
