import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test } from 'vitest'

const platform = `${process.platform}-${process.arch}`
const root = resolve(import.meta.dirname, '..')
const archive = join(root, 'out', `svelte-0.0.1-${platform}.tar.gz`)

if (
  !pluginPlatforms.includes(platform as (typeof pluginPlatforms)[number]) ||
  !existsSync(archive)
) {
  test.skip(`LSP initialize requires a built ${platform} Svelte plugin archive`, () => {})
} else {
  test('the unpacked server answers LSP initialize over a pipe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gode-svelte-lsp-'))
    const socketPath = join(directory, 'server.sock')
    const listener = createServer()
    let child: ReturnType<typeof spawn> | undefined
    let connection: Socket | undefined
    try {
      const unpacked = join(directory, 'plugin')
      await mkdir(unpacked)
      const { execFileSync } = await import('node:child_process')
      execFileSync('tar', ['-xzf', archive, '-C', unpacked])
      await new Promise<void>((accept, reject) => {
        listener.once('error', reject)
        listener.listen(socketPath, accept)
      })
      let rejectResponse: (reason: Error) => void = () => {}
      const response = new Promise<Record<string, unknown>>((accept, reject) => {
        rejectResponse = reject
        listener.once('connection', (socket) => {
          connection = socket
          let buffer = Buffer.alloc(0)
          socket.once('error', reject)
          socket.on('data', (chunk: Buffer) => {
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
          const request = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { processId: null, rootUri: null, capabilities: {}, workspaceFolders: null },
          })
          socket.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`)
        })
      })
      child = spawn(
        process.execPath,
        [
          join(unpacked, 'server', 'node_modules', 'svelte-language-server', 'bin', 'server.js'),
          `--pipe=${socketPath}`,
        ],
        { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', rejectResponse)
      child.once('exit', (code, signal) =>
        rejectResponse(
          new Error(`Svelte server exited before initialize: ${code ?? signal}\n${stderr}`),
        ),
      )
      const initialized = await response
      expect(initialized.error).toBeUndefined()
      expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
    } finally {
      connection?.destroy()
      child?.kill('SIGTERM')
      listener.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}
