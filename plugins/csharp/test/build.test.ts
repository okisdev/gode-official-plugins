import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import build from '../build.ts'
import resources from '../resources.json'

const run = promisify(execFile)

test('pins one platform-neutral csharp-ls NuGet package for every platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const asset of Object.values(resources.platforms)) {
    expect(asset).toEqual({
      url: 'https://api.nuget.org/v3-flatcontainer/csharp-ls/0.28.0/csharp-ls.0.28.0.nupkg',
      file: 'csharp-ls-0.28.0.nupkg',
      sha256: '8f815e4f22674106a8244beba07e4b4b062e31528e404aa8489312effb8c0e0c',
    })
  }
})

test('stages the pinned tool and an executable dotnet launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-csharp-build-'))
  try {
    const source = join(directory, 'source')
    const output = join(directory, 'plugin')
    const archive = join(directory, 'server.nupkg')
    await mkdir(join(source, 'tools/net10.0/any'), { recursive: true })
    await mkdir(output)
    await writeFile(join(source, 'tools/net10.0/any/CSharpLanguageServer.dll'), 'server')
    await run('zip', ['-q', '-r', archive, 'tools'], { cwd: source })
    const pinned = vi.fn(async () => archive)
    await build({
      root: join(import.meta.dirname, '..'),
      platform: 'linux-x64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['linux-x64'])
    expect(await readFile(join(output, 'bin/server/CSharpLanguageServer.dll'), 'utf8')).toBe(
      'server',
    )
    expect(await readFile(join(output, 'bin/server/LICENSE'), 'utf8')).toContain('MIT')
    expect(await readFile(join(output, 'bin/csharp-ls'), 'utf8')).toContain(
      'exec dotnet "${0%/*}/server/CSharpLanguageServer.dll" "$@"',
    )
    expect((await stat(join(output, 'bin/csharp-ls'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
