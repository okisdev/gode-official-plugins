import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import manifest from '../plugin.json'
import resources from '../resources.json'
import build, { runtimeFiles, verifySetupBytes } from '../build.ts'

test('archive selection retains runtime dependencies, not tools', () => {
  const entries = [
    'llama-server',
    'LICENSE',
    'libllama-server-impl.dylib',
    'libggml-metal.0.dylib',
    'libllama-common.0.7.0.dylib',
    'libmtmd.0.dylib',
    'libllama-quantize-impl.dylib',
    'llama-cli',
    '../escape',
  ].map((name) => `llama-b11724/${name}`)
  expect(runtimeFiles(entries, 'llama-b11724', 'darwin-arm64')).toEqual(entries.slice(0, 6).sort())
  expect(() => runtimeFiles([], 'llama-b11724', 'linux-x64')).toThrow('llama-server')
  expect(
    runtimeFiles(
      ['llama-server', 'LICENSE', 'libggml-cpu-armv9.2_2.so'].map((file) => `llama-b11724/${file}`),
      'llama-b11724',
      'linux-arm64',
    ),
  ).toContain('llama-b11724/libggml-cpu-armv9.2_2.so')
})

test('both model sets have pinned files and the default total matches setupBytes', () => {
  expect(resources.models.map((set) => set.id)).toEqual(['qwen3-asr-1.7b', 'qwen3-asr-0.6b'])
  expect(resources.models.map((set) => set.files.map((file) => file.size))).toEqual([
    [2165034944, 355709344],
    [804749248, 214392480],
  ])
  expect(resources.models[1]?.files.map((file) => file.sha256)).toEqual([
    'bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971',
    '41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d',
  ])
  for (const set of resources.models) {
    expect(set.files).toHaveLength(2)
    for (const file of set.files) {
      expect(file.url).toContain(
        `/resolve/${set.id === 'qwen3-asr-1.7b' ? '36a678687ba7d07a74ca70ccb0e36902e005fb80' : '928ab958557df9aa2ef1c93e0e83c7ad0933fae2'}/`,
      )
      expect(file.url).toMatch(new RegExp(`/${file.file}$`))
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  }
  expect(() => verifySetupBytes(manifest, resources.models)).not.toThrow()
  expect(() => verifySetupBytes({ ...manifest, setupBytes: 100 }, resources.models)).toThrow(
    'setupBytes',
  )
  expect(() => verifySetupBytes(manifest, resources.models.slice(1))).toThrow('missing')
})

test('stage copies only the pinned runtime files and keeps links and executable mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-voice-build-'))
  try {
    const runtime = join(root, resources.runtime.directory)
    const output = join(root, 'plugin')
    const archive = join(root, 'runtime.tar.gz')
    await mkdir(runtime)
    await mkdir(output)
    for (const name of [
      'llama-server',
      'LICENSE',
      'llama-cli',
      'libggml-base.so.0.27.0',
      'libggml-cpu-zen4.so',
      'libllama-server-impl.so',
      'libllama-quantize-impl.so',
    ])
      await writeFile(join(runtime, name), name, { mode: 0o755 })
    await symlink('libggml-base.so.0.27.0', join(runtime, 'libggml-base.so.0'))
    execFileSync('tar', ['-czf', archive, '-C', root, resources.runtime.directory])
    const pinned = vi.fn(async () => archive)
    await build({ root, platform: 'linux-x64', directory: output, cache: root, pinned })
    const asset = resources.runtime.platforms['linux-x64']
    expect(pinned).toHaveBeenCalledWith(
      {
        ...asset,
        url: `https://github.com/${resources.runtime.repository}/releases/download/${resources.runtime.release}/${asset.file}`,
      },
      expect.any(Function),
    )
    expect((await readdir(join(output, 'bin'))).sort()).toEqual(
      [
        'LICENSE',
        'llama-server',
        'libggml-base.so.0',
        'libggml-base.so.0.27.0',
        'libggml-cpu-zen4.so',
        'libllama-server-impl.so',
      ].sort(),
    )
    expect((await lstat(join(output, 'bin/libggml-base.so.0'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(output, 'bin/libggml-base.so.0'), 'utf8')).toBe(
      'libggml-base.so.0.27.0',
    )
    expect((await stat(join(output, 'bin/llama-server'))).mode & 0o111).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
