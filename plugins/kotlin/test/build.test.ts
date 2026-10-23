import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json'
import build from '../build.ts'

test('pins the four standalone kotlin-lsp archives', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  const archives = {
    'darwin-arm64': 'kotlin-server-263.7084.0-aarch64.sit',
    'darwin-x64': 'kotlin-server-263.7084.0.sit',
    'linux-x64': 'kotlin-server-263.7084.0.tar.gz',
    'linux-arm64': 'kotlin-server-263.7084.0-aarch64.tar.gz',
  }
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://download.jetbrains.com/language-server/kotlin-server/263.7084.0/${archives[platform as keyof typeof archives]}`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test.each(['darwin-arm64', 'linux-x64'] as const)(
  'stages the pinned %s archive with its executable',
  async (platform) => {
    const directory = await mkdtemp(join(tmpdir(), 'gode-kotlin-build-'))
    try {
      const source = join(directory, 'source')
      const server = join(source, 'kotlin-server-263.7084.0', 'bin')
      const output = join(directory, 'plugin')
      const archive = join(
        directory,
        platform.startsWith('darwin') ? 'server.sit' : 'server.tar.gz',
      )
      await mkdir(server, { recursive: true })
      await mkdir(output)
      await writeFile(join(server, 'intellij-server'), 'server executable', { mode: 0o755 })
      if (platform.startsWith('darwin')) {
        execFileSync('zip', ['-qr', archive, 'kotlin-server-263.7084.0'], { cwd: source })
      } else {
        execFileSync('tar', ['-czf', archive, 'kotlin-server-263.7084.0'], { cwd: source })
      }
      const pinned = vi.fn(async () => archive)
      await build({ root: directory, platform, directory: output, cache: directory, pinned })
      expect(pinned).toHaveBeenCalledWith(resources.platforms[platform])
      const staged = join(output, 'server', 'kotlin-server-263.7084.0', 'bin', 'intellij-server')
      expect(await readFile(staged, 'utf8')).toBe('server executable')
      expect((await stat(staged)).mode & 0o111).not.toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
