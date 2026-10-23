import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginStage } from '@gode/plugin-sdk/build'
import resources from './resources.json' with { type: 'json' }

const exec = promisify(execFile)

export function runtimeRoot(entries: string[]): string {
  const roots = entries.flatMap((entry) => {
    const match = /^([^/]+)\/bin\/clangd$/.exec(entry)
    return match ? [match[1]!] : []
  })
  if (
    roots.length !== 1 ||
    !entries.includes(`${roots[0]}/LICENSE.TXT`) ||
    !entries.some(
      (entry) => /^([^/]+)\/lib\/clang\/[^/]+\/include\/.+$/.exec(entry)?.[1] === roots[0],
    )
  )
    throw new Error('Runtime archive lacks clangd, its license or its clang headers')
  return roots[0]!
}

export default async function build(stage: PluginStage): Promise<void> {
  const asset = resources.platforms[stage.platform as keyof typeof resources.platforms]
  const archive = await stage.pinned(asset)
  const { stdout } = await exec('unzip', ['-Z', '-1', archive], { maxBuffer: 1024 * 1024 })
  const root = runtimeRoot(stdout.trim().split('\n'))
  const staging = await mkdtemp(join(stage.cache, '.extract-'))
  try {
    await exec('unzip', [
      '-q',
      archive,
      `${root}/LICENSE.TXT`,
      `${root}/bin/clangd`,
      `${root}/lib/clang/*/include/*`,
      '-d',
      staging,
    ])
    const source = join(staging, root)
    await cp(join(source, 'LICENSE.TXT'), join(stage.directory, 'LICENSE.TXT'))
    const bin = join(stage.directory, 'bin')
    await mkdir(bin, { recursive: true })
    await cp(join(source, 'bin/clangd'), join(bin, 'clangd'))
    await chmod(join(bin, 'clangd'), 0o755)
    await cp(join(source, 'lib/clang'), join(stage.directory, 'lib/clang'), { recursive: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
