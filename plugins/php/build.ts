import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

export default async function build(stage: PluginStage): Promise<void> {
  const runtime = await stage.pinned(resources.phar)
  const bin = join(stage.directory, 'bin')
  await mkdir(bin, { recursive: true })
  await copyFile(runtime, join(bin, 'phpactor.phar'))
  await writeFile(
    join(bin, 'phpactor'),
    '#!/bin/sh\nexec php "$(dirname "$0")/phpactor.phar" language-server "$@"\n',
    { mode: 0o755 },
  )
}
