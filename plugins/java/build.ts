import { execFile } from 'node:child_process'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const archive = await stage.pinned(resources.server)
  const server = join(stage.directory, 'server')
  const bin = join(stage.directory, 'bin')
  await mkdir(server, { recursive: true })
  await mkdir(bin, { recursive: true })
  await exec('tar', [
    '-xzf',
    archive,
    '-C',
    server,
    'plugins',
    'config_mac',
    'config_mac_arm',
    'config_linux',
    'config_linux_arm',
  ])
  const launcher = join(bin, 'jdtls')
  await writeFile(launcher, '#!/bin/sh\nexec "$GODE_JAVA" "$@"\n')
  await chmod(launcher, 0o755)
}
