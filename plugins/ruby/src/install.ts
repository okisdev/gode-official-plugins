import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { findProgram, PluginError } from '@gode/plugin-sdk/plugin'

export const rubyLspVersion = '0.26.11'

const run = promisify(execFile)
const installs = new Map<string, Promise<Install>>()

interface Install {
  directory: string
  executable: string
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function install(gem: string, data: string): Promise<Install> {
  const parent = join(data, 'ruby-lsp')
  const directory = join(parent, rubyLspVersion)
  const result = { directory, executable: join(directory, 'bin', 'ruby-lsp') }
  if (await executable(result.executable)) return result

  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(join(parent, '.install-'))
  try {
    await run(
      gem,
      [
        'install',
        'ruby-lsp',
        '--version',
        rubyLspVersion,
        '--install-dir',
        temporary,
        '--bindir',
        join(temporary, 'bin'),
        '--no-document',
        '--no-user-install',
      ],
      {
        env: {
          ...process.env,
          GEM_HOME: temporary,
          GEM_PATH: temporary,
          GEM_SPEC_CACHE: join(temporary, 'spec-cache'),
        },
      },
    )
    if (!(await executable(join(temporary, 'bin', 'ruby-lsp'))))
      throw new Error('RubyGems did not install an executable ruby-lsp')
    try {
      await rename(temporary, directory)
    } catch (error) {
      if (!(await executable(result.executable))) throw error
    }
    return result
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/** ruby-lsp's own `required_ruby_version`. */
const minimumRuby = [3, 0]

export async function supportedRuby(ruby: string): Promise<boolean> {
  const { stdout } = await run(ruby, ['-e', 'print RUBY_VERSION'])
  const [major = 0, minor = 0] = stdout.trim().split('.').map(Number)
  return major > minimumRuby[0]! || (major === minimumRuby[0] && minor >= minimumRuby[1]!)
}

export async function installRubyLsp(data: string): Promise<Install> {
  const ruby = findProgram('ruby')
  if (!ruby) throw new PluginError({ message: 'missing' })
  if (!(await supportedRuby(ruby))) throw new PluginError({ message: 'tooOld' })
  const gem = findProgram('gem')
  if (!gem) throw new PluginError({ message: 'missing' })
  const pending = installs.get(data)
  if (pending) return pending
  const promise = install(gem, data)
  installs.set(data, promise)
  try {
    return await promise
  } finally {
    installs.delete(data)
  }
}
