import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PluginError } from '@gode/plugin-sdk/plugin'
import type { SourceControlFailureCause } from '@gode/plugin-sdk'

const execute = promisify(execFile)
export type Log = (level: 'error', message: string) => void

function failureCause(output: string): SourceControlFailureCause | null {
  if (
    /could not resolve host|network is unreachable|connection refused|timed out|offline/i.test(
      output,
    )
  )
    return { kind: 'offline' }
  if (/authentication failed|permission denied|invalid credentials/i.test(output))
    return { kind: 'authentication' }
  if (/repository not found|remote not found|no such remote|not found/i.test(output))
    return { kind: 'notFound' }
  if (/non-fast-forward|rejected|refusing to push/i.test(output)) return { kind: 'rejected' }
  if (/conflict/i.test(output)) return { kind: 'conflicts', files: [] }
  return null
}

export async function jj(path: string, args: string[], log: Log): Promise<string> {
  return (await jjBytes(path, args, log)).toString('utf8')
}

export async function jjBytes(path: string, args: string[], log: Log): Promise<Buffer> {
  try {
    const { stdout } = await execute('jj', ['--no-pager', '--color=never', ...args], {
      cwd: path,
      encoding: 'buffer',
      env: {
        ...process.env,
        JJ_EDITOR: 'true',
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
        SSH_ASKPASS: '/usr/bin/false',
      },
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const problem = error as Error & { stderr?: Buffer | string; code?: string | number }
    const message = problem.stderr?.toString().trim() || problem.message
    log('error', `jj ${args[0] ?? ''} failed (${String(problem.code ?? 'unknown')})`)
    throw new PluginError({ message, output: true, cause: failureCause(message) })
  }
}

export async function optional(path: string, args: string[], log: Log): Promise<string | null> {
  try {
    return await jj(path, args, log)
  } catch (error) {
    if (error instanceof PluginError) return null
    throw error
  }
}
