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

test('pins LuaLS for every plugin platform', () => {
  expect(Object.keys(resources.platforms).sort()).toEqual([...pluginPlatforms].sort())
  for (const [platform, asset] of Object.entries(resources.platforms)) {
    expect(asset.url).toBe(
      `https://github.com/LuaLS/lua-language-server/releases/download/3.19.2/lua-language-server-3.19.2-${platform}.tar.gz`,
    )
    expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
  }
})

test('stages the LuaLS executable and support tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-lua-build-'))
  try {
    const input = join(root, 'input')
    const output = join(root, 'plugin')
    const archive = join(root, 'lua.tar.gz')
    await mkdir(output)
    for (const path of ['bin', 'meta', 'script', 'locale'])
      await mkdir(join(input, path), { recursive: true })
    await writeFile(join(input, 'bin/lua-language-server'), 'LuaLS executable', { mode: 0o755 })
    for (const path of ['bin/main.lua', 'meta/builtin.lua', 'script/core.lua', 'locale/en.lua'])
      await writeFile(join(input, path), path)
    await exec('tar', ['-czf', archive, '-C', input, '.'])
    const pinned = vi.fn(async () => archive)
    await build({ root, platform: 'darwin-arm64', directory: output, cache: root, pinned })
    expect(pinned).toHaveBeenCalledWith(resources.platforms['darwin-arm64'])
    expect((await stat(join(output, 'bin/lua-language-server'))).mode & 0o111).not.toBe(0)
    for (const path of ['bin/main.lua', 'meta/builtin.lua', 'script/core.lua', 'locale/en.lua'])
      expect(await readFile(join(output, path), 'utf8')).toBe(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
