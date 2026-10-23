import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const archive = await stage.pinned(resources.platforms[stage.platform])
  const staging = await mkdtemp(join(stage.cache, '.extract-'))
  try {
    await exec('unzip', ['-q', archive, 'tools/net8.0/any/*', '-d', staging])
    const server = join(stage.directory, 'server')
    await cp(join(staging, 'tools/net8.0/any'), server, { recursive: true })
    const bin = join(stage.directory, 'bin')
    await mkdir(bin)
    const launcher = join(bin, 'fsautocomplete')
    await writeFile(
      launcher,
      '#!/bin/sh\nscript_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\nDOTNET_ROLL_FORWARD=Major exec dotnet "$script_dir/../server/fsautocomplete.dll" "$@"\n',
    )
    await chmod(launcher, 0o755)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
