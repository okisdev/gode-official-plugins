import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { PluginError, findProgram } from '@gode/plugin-sdk/plugin'

export const goplsVersion = 'v0.24.0'

const run = promisify(execFile)
const installs = new Map<string, Promise<string>>()

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function install(go: string, directory: string): Promise<string> {
  const parent = join(directory, 'gopls')
  const target = join(parent, goplsVersion)
  const binary = join(target, 'gopls')
  if (await executable(binary)) return binary

  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(join(parent, '.install-'))
  try {
    await run(go, ['install', `golang.org/x/tools/gopls@${goplsVersion}`], {
      env: { ...process.env, GOBIN: temporary },
    })
    if (!(await executable(join(temporary, 'gopls'))))
      throw new Error('Go did not install an executable gopls')
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!(await executable(binary))) throw error
    }
    return binary
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function installGopls(directory: string): Promise<string> {
  const go = findProgram('go')
  if (!go) throw new PluginError({ message: 'missing' })
  const pending = installs.get(directory)
  if (pending) return pending
  const promise = install(go, directory)
  installs.set(directory, promise)
  try {
    return await promise
  } finally {
    installs.delete(directory)
  }
}
