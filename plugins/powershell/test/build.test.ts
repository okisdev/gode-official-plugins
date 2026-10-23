import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import build from '../build.ts'
import resources from '../resources.json'

const exec = promisify(execFile)

test('pins the PowerShell Editor Services 4.7.0 release for every platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const asset of Object.values(resources.platforms)) {
    expect(asset.url).toBe(
      'https://github.com/PowerShell/PowerShellEditorServices/releases/download/v4.7.0/PowerShellEditorServices.zip',
    )
    expect(asset.sha256).toBe('5084f0326cc88539e9d880b08f6c52ce5be4672bb8ecee8921e35f8895a6b9d7')
  }
})

test('stages the pinned PowerShell module and executable launcher', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gode-powershell-build-'))
  try {
    const payload = join(directory, 'PowerShellEditorServices')
    await mkdir(payload)
    await writeFile(join(payload, 'Start-EditorServices.ps1'), 'start')
    await writeFile(join(directory, 'LICENSE'), 'license')
    await writeFile(join(directory, 'NOTICE.txt'), 'notice')
    const archive = join(directory, 'server.zip')
    await exec('zip', ['-q', '-r', archive, 'PowerShellEditorServices', 'LICENSE', 'NOTICE.txt'], {
      cwd: directory,
    })
    const output = join(directory, 'plugin')
    await mkdir(output)
    const pinned = vi.fn(async () => archive)
    await build({
      root: directory,
      platform: 'darwin-arm64',
      directory: output,
      cache: directory,
      pinned,
    })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect(
      await readFile(
        join(output, 'server/PowerShellEditorServices/Start-EditorServices.ps1'),
        'utf8',
      ),
    ).toBe('start')
    expect(await readFile(join(output, 'LICENSE'), 'utf8')).toBe('license')
    expect(await readFile(join(output, 'NOTICE.txt'), 'utf8')).toBe('notice')
    const launcher = join(output, 'bin/powershell-editor-services')
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
    expect(await readFile(launcher, 'utf8')).toContain('exec pwsh')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
