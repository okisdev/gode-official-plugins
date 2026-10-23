import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStage } from '@gode/plugin-sdk/build'

export default async function build(stage: PluginStage): Promise<void> {
  const bin = join(stage.directory, 'bin')
  await mkdir(bin, { recursive: true })
  const launcher = join(bin, 'nixd')
  await writeFile(launcher, '#!/bin/sh\nexec nixd "$@"\n')
  await chmod(launcher, 0o755)
}
