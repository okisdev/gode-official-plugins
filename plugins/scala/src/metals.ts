import { execFile } from 'node:child_process'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
let pending: Promise<string> | undefined

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

export function prepareMetals(
  paths: { plugin: string; data: string },
  java: string,
): Promise<string> {
  pending ??= prepare(paths, java).finally(() => {
    pending = undefined
  })
  return pending
}

async function prepare(paths: { plugin: string; data: string }, java: string): Promise<string> {
  const cache = join(paths.data, 'coursier')
  const config = join(paths.data, 'config')
  await Promise.all([mkdir(cache, { recursive: true }), mkdir(config, { recursive: true })])
  const { stdout } = await run(
    join(paths.plugin, 'bin', 'coursier'),
    [
      'fetch',
      '--classpath',
      '--no-default',
      '--repository',
      'https://repo.maven.apache.org/maven2',
      'org.scalameta:metals_2.13:1.6.9',
    ],
    {
      env: {
        ...process.env,
        HOME: paths.data,
        XDG_CONFIG_HOME: config,
        COURSIER_CACHE: cache,
        COURSIER_REPOSITORIES: 'https://repo.maven.apache.org/maven2',
      },
      maxBuffer: 1024 * 1024,
      timeout: 600_000,
    },
  )
  const classpath = stdout.trim()
  if (!classpath) throw new Error('Metals resolved an empty classpath')
  const launcher = join(paths.data, 'metals')
  const temporary = join(
    paths.data,
    `metals-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`,
  )
  try {
    await writeFile(
      temporary,
      `#!/bin/sh\nexec ${quote(java)} -Duser.home=${quote(paths.data)} -Xss4m -cp ${quote(classpath)} scala.meta.metals.Main "$@"\n`,
    )
    await chmod(temporary, 0o755)
    await rename(temporary, launcher)
  } finally {
    await rm(temporary, { force: true })
  }
  return launcher
}
