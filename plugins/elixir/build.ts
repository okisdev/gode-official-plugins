import { copyFile, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

export default async function build(stage: PluginStage): Promise<void> {
  const executable = join(stage.directory, 'bin', 'expert')
  await mkdir(join(stage.directory, 'bin'), { recursive: true })
  await copyFile(await stage.pinned(resources.platforms[stage.platform]), executable)
  await chmod(executable, 0o755)
}
