import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const runtime = await stage.pinned(resources.platforms[stage.platform])
  const staging = await mkdtemp(join(stage.cache, '.extract-'))
  try {
    const member = resources.platforms[stage.platform].url
      .split('/')
      .at(-1)!
      .replace(/\.tar\.gz$/, '')
    await exec('tar', ['-xzf', runtime, '-C', staging, member])
    const bin = join(stage.directory, 'bin')
    await mkdir(bin, { recursive: true })
    const executable = join(bin, 'oxlint')
    await rename(join(staging, member), executable)
    await chmod(executable, 0o755)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
