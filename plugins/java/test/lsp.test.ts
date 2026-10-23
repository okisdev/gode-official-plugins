import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

test('uses JAVA_HOME before PATH and keeps workspace data per root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-java-launch-'))
  const previousHome = process.env.JAVA_HOME
  const previousPath = process.env.PATH
  try {
    const home = join(directory, 'home')
    const path = join(directory, 'path')
    await mkdir(join(home, 'bin'), { recursive: true })
    await mkdir(path)
    await writeFile(join(home, 'bin', 'java'), '')
    await writeFile(join(path, 'java'), '')
    await chmod(join(home, 'bin', 'java'), 0o755)
    await chmod(join(path, 'java'), 0o755)
    for (const configuration of [
      'config_mac',
      'config_mac_arm',
      'config_linux',
      'config_linux_arm',
    ]) {
      await mkdir(join(directory, 'server', configuration), { recursive: true })
      await writeFile(join(directory, 'server', configuration, 'config.ini'), '')
    }
    process.env.JAVA_HOME = home
    process.env.PATH = path
    const paths = { plugin: directory, data: join(directory, 'data') }
    const first = await plugin.launch(paths, { root: join(directory, 'first'), language: 'java' })
    const second = await plugin.launch(paths, { root: join(directory, 'second'), language: 'java' })
    expect(first.env?.GODE_JAVA).toBe(join(home, 'bin', 'java'))
    expect(first.args.at(-1)).not.toBe(second.args.at(-1))
    expect(
      existsSync(join(first.args[first.args.indexOf('-configuration') + 1]!, 'config.ini')),
    ).toBe(true)
    process.env.JAVA_HOME = ''
    process.env.PATH = ''
    await expect(plugin.launch(paths, { root: directory, language: 'java' })).rejects.toMatchObject(
      {
        text: { message: 'missing' },
      },
    )
  } finally {
    if (previousHome === undefined) delete process.env.JAVA_HOME
    else process.env.JAVA_HOME = previousHome
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(directory, { recursive: true, force: true })
  }
})

const java =
  (process.env.JAVA_HOME && findProgram('java', join(process.env.JAVA_HOME, 'bin'))) ||
  findProgram('java')
const javaVersion = java ? spawnSync(java, ['-version'], { encoding: 'utf8' }) : null
const javaMajor = Number(javaVersion?.stderr.match(/version "(\d+)/)?.[1])

test.skipIf(!built() || javaVersion?.status !== 0 || !(javaMajor >= 21))(
  'the unpacked Eclipse JDT LS answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'java' })
    expect(session.launch.kind).toBe('program')
    expect(existsSync(session.launch.path)).toBe(true)
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  120_000,
)
