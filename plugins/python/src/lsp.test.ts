import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { pluginPlatforms } from '@gode/plugin-sdk'
import { expect, test } from 'vitest'

const platform = `${process.platform}-${process.arch}`
const root = resolve(import.meta.dirname, '..')
const archive = join(root, 'out', `python-0.0.1-${platform}.tar.gz`)

if (
  !pluginPlatforms.includes(platform as (typeof pluginPlatforms)[number]) ||
  !existsSync(archive)
) {
  test.skip(`LSP initialize requires a built ${platform} Python plugin archive`, () => {})
} else {
  test('the unpacked Node server answers LSP initialize over a pipe', async () => {
    const directory = await mkdtemp(join('/tmp', 'gode-python-lsp-'))
    const socketPath = join(directory, 'lsp.sock')
    const listener: Server = createServer()
    let socket: Socket | undefined
    let server: ReturnType<typeof spawn> | undefined
    try {
      const unpacked = join(directory, 'plugin')
      await mkdir(unpacked)
      execFileSync('tar', ['-xzf', archive, '-C', unpacked])
      const connected = new Promise<Socket>((accept, reject) => {
        listener.once('connection', accept)
        listener.once('error', reject)
      })
      await new Promise<void>((accept, reject) => {
        listener.once('error', reject)
        listener.listen(socketPath, accept)
      })
      server = spawn(
        process.execPath,
        [
          join(unpacked, 'server', 'node_modules', 'basedpyright', 'langserver.index.js'),
          `--pipe=${socketPath}`,
        ],
        { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] },
      )
      const processHandle = server
      processHandle.once('error', (error) => listener.emit('error', error))
      processHandle.once('exit', (code, signal) =>
        listener.emit(
          'error',
          new Error(`Python server exited before initialize: ${code ?? signal}`),
        ),
      )
      socket = await connected
      const connection = socket
      const initialized = new Promise<Record<string, unknown>>((accept, reject) => {
        let buffer = Buffer.alloc(0)
        connection.once('error', reject)
        connection.once('close', () => reject(new Error('Python server closed before initialize')))
        connection.on('data', (chunk: Buffer) => {
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
      connection.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`)
      const response = await initialized
      expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({ capabilities: expect.any(Object) })
    } finally {
      socket?.destroy()
      server?.kill('SIGTERM')
      listener.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}
