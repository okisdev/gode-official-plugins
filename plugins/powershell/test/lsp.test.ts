import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginError, findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test, vi } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
  encoding: 'utf8',
})

test('requires PowerShell and keeps session output in data', async () => {
  vi.stubEnv('PATH', '/__gode_missing_pwsh__')
  try {
    expect(() =>
      plugin.launch(
        { plugin: '/plugin', data: '/data' },
        { root: '/project', language: 'powershell' },
      ),
    ).toThrow(PluginError)
  } finally {
    vi.unstubAllEnvs()
  }
  const directory = await mkdtemp(join(tmpdir(), 'gode-pwsh-path-'))
  try {
    const command = join(directory, 'pwsh')
    await writeFile(command, '#!/bin/sh\n')
    await chmod(command, 0o755)
    vi.stubEnv('PATH', directory)
    const launch = await plugin.launch(
      { plugin: '/plugin', data: '/data' },
      { root: '/project', language: 'powershell' },
    )
    expect(launch.args[launch.args.indexOf('-LogPath') + 1]).toMatch(/^\/data\/logs\//)
    expect(launch.args[launch.args.indexOf('-SessionDetailsPath') + 1]).toMatch(/^\/data\/session-/)
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(!built() || !findProgram('pwsh') || pwsh.status !== 0)(
  'the unpacked PowerShell Editor Services server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'powershell' })
    expect(session.launch.kind).toBe('program')
    expect(session.launch.args).toContain('-Stdio')
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  60_000,
)
