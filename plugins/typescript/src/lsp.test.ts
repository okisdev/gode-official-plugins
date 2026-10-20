import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test } from 'vitest'
import { buildPlugin } from '../scripts/build.mjs'

const platform = `${process.platform}-${process.arch}`
const root = resolve(import.meta.dirname, '..')
const cached = join(root, 'out', '.cache', `typescript-${platform}-7.0.2.tgz`)

if (
  !pluginPlatforms.includes(platform as (typeof pluginPlatforms)[number]) ||
  !existsSync(cached)
) {
  test.skip(`LSP initialize requires a cached ${platform} native TypeScript build`, () => {})
} else {
  test('the unpacked native server answers LSP initialize over stdio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gode-typescript-lsp-'))
    let server: ReturnType<typeof spawn> | undefined
    try {
      const [archive = ''] = await buildPlugin([platform])
      const unpacked = join(directory, 'plugin')
      await mkdir(unpacked)
      const { execFileSync } = await import('node:child_process')
      execFileSync('tar', ['-xzf', archive, '-C', unpacked])
      server = spawn(join(unpacked, 'bin', 'tsc'), ['--lsp', '--stdio'], {
        cwd: directory,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const processHandle = server
      const initialized = new Promise<Record<string, unknown>>((accept, reject) => {
        let buffer = Buffer.alloc(0)
        processHandle.once('error', reject)
        processHandle.once('exit', (code, signal) =>
          reject(new Error(`TypeScript server exited before initialize: ${code ?? signal}`)),
        )
        processHandle.stdout!.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk])
          while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n')
            if (headerEnd < 0) return
            const header = buffer.subarray(0, headerEnd).toString('ascii')
            const length = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1]
            if (!length) return reject(new Error(`LSP response lacks Content-Length: ${header}`))
            const end = headerEnd + 4 + Number(length)
            if (buffer.length < end) return
            const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString('utf8'))
            buffer = buffer.subarray(end)
            if (message.id === 1) return accept(message)
          }
        })
      })
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { processId: null, rootUri: null, capabilities: {}, workspaceFolders: null },
      })
      processHandle.stdin!.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`)
      const response = await initialized
      expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({ capabilities: expect.any(Object) })
    } finally {
      server?.kill('SIGTERM')
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}
