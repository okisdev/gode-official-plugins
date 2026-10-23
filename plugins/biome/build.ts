import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

export default async function build(stage: PluginStage): Promise<void> {
  const runtime = await stage.pinned(resources.platforms[stage.platform])
  const bin = join(stage.directory, 'bin')
  await mkdir(bin, { recursive: true })
  const executable = join(bin, 'biome')
  await copyFile(runtime, executable)
  await chmod(executable, 0o755)
}
