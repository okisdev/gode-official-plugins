import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export function runtimeFiles(entries: string[]): string[] {
  const files = entries.filter(
    (entry) =>
      entry === 'package/LICENSE' ||
      entry === 'package/NOTICE.txt' ||
      entry === 'package/lib/tsc' ||
      /^package\/lib\/lib(?:\.[a-z0-9.]+)?\.d\.ts$/.test(entry),
  )
  for (const required of [
    'package/LICENSE',
    'package/NOTICE.txt',
    'package/lib/tsc',
    'package/lib/lib.d.ts',
    'package/lib/lib.es5.d.ts',
    'package/lib/lib.dom.d.ts',
    'package/lib/lib.esnext.d.ts',
  ])
    if (!files.includes(required)) throw new Error(`Runtime archive lacks ${required}`)
  return files.sort()
}

export default async function build(stage: PluginStage): Promise<void> {
  const runtime = await stage.pinned(resources.platforms[stage.platform])
  const { stdout } = await exec('tar', ['-tzf', runtime])
  const members = runtimeFiles(stdout.trim().split('\n'))
  const staging = await mkdtemp(join(stage.cache, '.extract-'))
  try {
    await exec('tar', ['-xzf', runtime, '-C', staging, ...members])
    await mkdir(stage.directory, { recursive: true })
    await cp(join(staging, 'package/lib'), join(stage.directory, 'bin'), { recursive: true })
    for (const name of ['LICENSE', 'NOTICE.txt'])
      await cp(join(staging, 'package', name), join(stage.directory, name))
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
