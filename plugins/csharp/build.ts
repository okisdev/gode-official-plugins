import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const run = promisify(execFile)

export default async function build(stage: PluginStage): Promise<void> {
  const archive = await stage.pinned(resources.platforms[stage.platform])
  await run('unzip', ['-qq', archive, 'tools/net10.0/any/*', '-d', stage.directory])
  const bin = join(stage.directory, 'bin')
  await mkdir(bin)
  await rename(join(stage.directory, 'tools', 'net10.0', 'any'), join(bin, 'server'))
  await rm(join(stage.directory, 'tools'), { recursive: true })
  await copyFile(join(stage.root, 'LICENSE'), join(bin, 'server', 'LICENSE'))
  const launcher = join(bin, 'csharp-ls')
  await writeFile(
    launcher,
    '#!/bin/sh\nexec dotnet "${0%/*}/server/CSharpLanguageServer.dll" "$@"\n',
  )
  await chmod(launcher, 0o755)
}
