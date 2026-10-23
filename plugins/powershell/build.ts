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
    await exec('unzip', [
      '-q',
      archive,
      'PowerShellEditorServices/*',
      'LICENSE',
      'NOTICE.txt',
      '-d',
      staging,
    ])
    await mkdir(join(stage.directory, 'server'))
    await cp(
      join(staging, 'PowerShellEditorServices'),
      join(stage.directory, 'server', 'PowerShellEditorServices'),
      {
        recursive: true,
      },
    )
    for (const name of ['LICENSE', 'NOTICE.txt'])
      await cp(join(staging, name), join(stage.directory, name))
    const bin = join(stage.directory, 'bin')
    await mkdir(bin)
    const launcher = join(bin, 'powershell-editor-services')
    await writeFile(
      launcher,
      '#!/bin/sh\nscript_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)\nexec pwsh -NoLogo -NoProfile -File "$script_dir/../server/PowerShellEditorServices/Start-EditorServices.ps1" "$@"\n',
    )
    await chmod(launcher, 0o755)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
