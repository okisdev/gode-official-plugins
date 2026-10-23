import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findProgram, PluginError } from '@gode/plugin-sdk/plugin'

export const languageServerVersion = '6.0.1'

const run = promisify(execFile)
const installs = new Map<string, Promise<string>>()

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

async function installed(target: string): Promise<boolean> {
  try {
    await access(join(target, 'language-server'), constants.X_OK)
    return exists(join(target, 'environment', 'Manifest.toml'))
  } catch {
    return false
  }
}

async function install(directory: string, julia: string): Promise<string> {
  const parent = join(directory, 'LanguageServer.jl')
  const target = join(parent, languageServerVersion)
  const launcher = join(target, 'language-server')
  if (await installed(target)) return launcher

  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(join(parent, '.install-'))
  try {
    const environment = join(temporary, 'environment')
    const depot = join(temporary, 'depot')
    await mkdir(environment)
    await mkdir(depot)
    await run(
      julia,
      [
        '--startup-file=no',
        '--history-file=no',
        `--project=${environment}`,
        '-e',
        `using Pkg; Pkg.add(PackageSpec(name="LanguageServer", version="${languageServerVersion}"))`,
      ],
      {
        env: {
          ...process.env,
          JULIA_DEPOT_PATH: depot,
          JULIA_LOAD_PATH: `${environment}:@stdlib`,
          JULIA_PKG_PRECOMPILE_AUTO: '0',
        },
      },
    )
    if (!(await exists(join(environment, 'Manifest.toml'))))
      throw new Error('Julia did not install LanguageServer.jl')
    await writeFile(
      join(temporary, 'language-server'),
      '#!/bin/sh\nexec "$GODE_JULIA" --startup-file=no --history-file=no --project="$GODE_JULIA_ENV" -e "using LanguageServer; runserver()"\n',
      { mode: 0o755 },
    )
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!(await installed(target))) throw error
    }
    return launcher
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function installLanguageServer(
  directory: string,
  julia = findProgram('julia'),
): Promise<{ path: string; env: Record<string, string> }> {
  if (!julia) throw new PluginError({ message: 'missing' })
  const pending = installs.get(directory)
  const promise = pending ?? install(directory, julia)
  if (!pending) installs.set(directory, promise)
  try {
    const path = await promise
    const target = join(directory, 'LanguageServer.jl', languageServerVersion)
    return {
      path,
      env: {
        GODE_JULIA: julia,
        GODE_JULIA_ENV: join(target, 'environment'),
        JULIA_DEPOT_PATH: join(target, 'depot'),
        JULIA_LOAD_PATH: `${join(target, 'environment')}:@stdlib`,
      },
    }
  } finally {
    if (!pending) installs.delete(directory)
  }
}
