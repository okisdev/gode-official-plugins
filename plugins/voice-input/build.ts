import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import manifest from './plugin.json' with { type: 'json' }
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export function verifySetupBytes(
  manifest: { setupBytes?: number },
  models: readonly { id: string; files: readonly { size: number }[] }[],
): void {
  const selected = models.find((model) => model.id === 'qwen3-asr-1.7b')
  if (!selected) throw new Error('Default model set is missing')
  const total = selected.files.reduce((sum, file) => sum + file.size, 0)
  if (manifest.setupBytes !== total)
    throw new Error('Manifest setupBytes does not match default model set')
}

export function runtimeFiles(entries: string[], directory: string, platform: string): string[] {
  const library = platform.startsWith('darwin-')
    ? /^lib(?:ggml(?:-[a-z0-9-]+)?|llama(?:-common|-server-impl)?|mtmd)(?:\.\d+)*\.dylib$/
    : /^lib(?:ggml(?:-[a-z0-9_.-]+)?|llama(?:-common|-server-impl)?|mtmd)\.so(?:\.\d+)*$/
  const files = entries
    .filter((entry) => {
      if (!entry.startsWith(`${directory}/`) || entry.slice(directory.length + 1).includes('/'))
        return false
      const name = basename(entry)
      return name === 'llama-server' || name === 'LICENSE' || library.test(name)
    })
    .sort()
  for (const file of ['llama-server', 'LICENSE'])
    if (!files.includes(`${directory}/${file}`)) throw new Error(`Runtime archive lacks ${file}`)
  if (!files.some((file) => library.test(basename(file))))
    throw new Error('Runtime archive lacks shared libraries')
  return files
}

export default async function build(stage: PluginStage): Promise<void> {
  verifySetupBytes(manifest, resources.models)
  const runtime = resources.runtime
  const asset = runtime.platforms[stage.platform]
  const archive = await stage.pinned(
    {
      ...asset,
      url: `https://github.com/${runtime.repository}/releases/download/${runtime.release}/${asset.file}`,
    },
    async (file, destination) => {
      await exec('gh', [
        'release',
        'download',
        runtime.release,
        '--repo',
        runtime.repository,
        '--pattern',
        file.file,
        '--output',
        destination,
        '--clobber',
      ])
    },
  )
  const { stdout } = await exec('tar', ['-tzf', archive])
  const members = runtimeFiles(stdout.trim().split('\n'), runtime.directory, stage.platform)
  const staging = await mkdtemp(join(stage.cache, '.extract-'))
  try {
    await exec('tar', ['-xzf', archive, '-C', staging, ...members])
    await cp(join(staging, runtime.directory), join(stage.directory, 'bin'), {
      recursive: true,
      verbatimSymlinks: true,
    })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
