import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pluginPlatforms } from '@gode/plugin-sdk'
import type { PluginPort } from '@gode/plugin-sdk/plugin'
import { expect, test } from 'vitest'

const platform = `${process.platform}-${process.arch}`
const root = resolve(import.meta.dirname, '..')
const archive = join(root, 'out', `astro-0.0.1-${platform}.tar.gz`)

if (
  !pluginPlatforms.includes(platform as (typeof pluginPlatforms)[number]) ||
  !existsSync(archive)
) {
  test.skip(`LSP initialize requires a built ${platform} Astro plugin archive`, () => {})
} else {
  test('the unpacked Astro script answers LSP initialize over a pipe with the launch options', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gode-astro-lsp-'))
    const socketPath = join(directory, 'lsp.sock')
    const listener = createServer()
    let child: ReturnType<typeof spawn> | undefined
    try {
      const unpacked = join(directory, 'plugin')
      const project = join(directory, 'project')
      await mkdir(unpacked)
      await mkdir(project)
      const { execFileSync } = await import('node:child_process')
      execFileSync('tar', ['-xzf', archive, '-C', unpacked])
      const host = process as NodeJS.Process & { parentPort?: PluginPort }
      const previous = host.parentPort
      host.parentPort = { on() {}, off() {}, postMessage() {} }
      let launch
      try {
        const { astroLaunch } = await import('./main')
        launch = astroLaunch({ plugin: unpacked })
      } finally {
        if (previous) host.parentPort = previous
        else delete host.parentPort
      }
      expect(launch.kind).toBe('script')
      expect(existsSync(launch.path)).toBe(true)
      expect(
        existsSync(
          (launch.initializationOptions as { typescript: { tsdk: string } }).typescript.tsdk,
        ),
      ).toBe(true)
      await new Promise<void>((accept) => listener.listen(socketPath, accept))
      child = spawn(process.execPath, [launch.path, ...launch.args, `--pipe=${socketPath}`], {
        cwd: project,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const processHandle = child
      const socket = await new Promise<import('node:net').Socket>((accept, reject) => {
        listener.once('connection', accept)
        processHandle.once('error', reject)
        processHandle.once('exit', (code, signal) =>
          reject(new Error(`Astro server exited before connecting: ${code ?? signal}`)),
        )
      })
      const response = new Promise<Record<string, unknown>>((accept, reject) => {
        let stderr = ''
        processHandle.stderr!.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        processHandle.once('error', reject)
        processHandle.once('exit', (code, signal) =>
          reject(new Error(`Astro server exited before initialize: ${code ?? signal}; ${stderr}`)),
        )
        let buffer = Buffer.alloc(0)
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
        const uri = pathToFileURL(project).href
        const request = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            processId: null,
            rootUri: uri,
            capabilities: {},
            workspaceFolders: [{ uri, name: 'project' }],
            initializationOptions: launch.initializationOptions,
          },
        })
        socket.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`)
      })
      const initialized = await response
      expect(initialized.error).toBeUndefined()
      expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
    } finally {
      child?.kill('SIGTERM')
      listener.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}
