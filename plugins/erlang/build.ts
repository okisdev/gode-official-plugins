import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const archive = await stage.pinned(resources.platforms[stage.platform])
  const staging = await mkdtemp(join(stage.cache, '.elp-'))
  try {
    await exec('tar', ['-xzf', archive, '-C', staging, 'elp'])
    const bin = join(stage.directory, 'bin')
    await mkdir(bin, { recursive: true })
    const partial = join(bin, 'elp.partial')
    try {
      await copyFile(join(staging, 'elp'), partial)
      await chmod(partial, 0o755)
      await rename(partial, join(bin, 'elp'))
    } finally {
      await rm(partial, { force: true })
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
