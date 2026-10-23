import { execFile } from 'node:child_process'
import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const archive = await stage.pinned(resources.platforms[stage.platform])
  const bin = join(stage.directory, 'bin')
  await mkdir(bin, { recursive: true })
  await exec('unzip', ['-j', archive, 'clojure-lsp', '-d', bin])
  await chmod(join(bin, 'clojure-lsp'), 0o755)
}
