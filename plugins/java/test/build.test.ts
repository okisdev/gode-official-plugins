import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, vi } from '@gode/plugin-sdk/test'
import resources from '../resources.json' with { type: 'json' }
import build from '../build.ts'

const exec = promisify(execFile)

test('pins the Eclipse JDT LS milestone tarball', () => {
  expect(resources.server.url).toBe(
    'https://download.eclipse.org/jdtls/milestones/1.58.0/jdt-language-server-1.58.0-202604151538.tar.gz',
  )
  expect(resources.server.sha256).toMatch(/^[a-f0-9]{64}$/)
})

test('stages the server configurations and executable launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gode-java-build-'))
  try {
    const source = join(root, 'source')
    const output = join(root, 'plugin')
    const archive = join(root, 'server.tar.gz')
    const folders = ['plugins', 'config_mac', 'config_mac_arm', 'config_linux', 'config_linux_arm']
    for (const folder of folders) {
      await mkdir(join(source, folder), { recursive: true })
      await writeFile(join(source, folder, 'sentinel'), folder)
    }
    await mkdir(output)
    await exec('tar', ['-czf', archive, '-C', source, ...folders])
    const pinned = vi.fn(async () => archive)
    await build({ root, platform: 'darwin-arm64', directory: output, cache: root, pinned })
    expect(pinned).toHaveBeenCalledWith(resources.server)
    for (const folder of folders)
      expect(await readFile(join(output, 'server', folder, 'sentinel'), 'utf8')).toBe(folder)
    const launcher = join(output, 'bin', 'jdtls')
    expect(await readFile(launcher, 'utf8')).toBe('#!/bin/sh\nexec "$GODE_JAVA" "$@"\n')
    expect((await stat(launcher)).mode & 0o111).not.toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
