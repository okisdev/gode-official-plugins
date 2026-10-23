import { spawnSync } from 'node:child_process'
import { PluginError, findProgram } from '@gode/plugin-sdk/plugin'
import { built, expect, startLanguageServer, test, vi } from '@gode/plugin-sdk/test'
import plugin from '../src/main.ts'

const dotnet = spawnSync('dotnet', ['--list-runtimes'], { encoding: 'utf8' })
const available = dotnet.status === 0 && /Microsoft\.NETCore\.App (?:8|9|10)\./.test(dotnet.stdout)

test('reports a missing .NET installation', () => {
  vi.stubEnv('PATH', '/__gode_missing_dotnet__')
  try {
    expect(() =>
      plugin.launch({ plugin: '/plugin', data: '/data' }, { root: '/project', language: 'fsharp' }),
    ).toThrow(PluginError)
  } finally {
    vi.unstubAllEnvs()
  }
})

test.skipIf(!built() || !findProgram('dotnet') || !available)(
  'the unpacked FsAutoComplete server answers LSP initialize',
  async () => {
    const session = await startLanguageServer(plugin, { language: 'fsharp' })
    expect(session.launch.kind).toBe('program')
    const initialized = await session.initialize()
    expect(initialized.error).toBeUndefined()
    expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
  },
  60_000,
)
