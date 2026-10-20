import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  pluginPlatforms,
  type HostMessage,
  type LanguageServerLaunch,
  type PluginMessage,
} from '@gode/plugin-sdk'
import type { PluginPort } from '@gode/plugin-sdk/plugin'
import { expect, test } from 'vitest'

const platform = `${process.platform}-${process.arch}`
const root = resolve(import.meta.dirname, '..')
const archive = join(root, 'out', `vue-0.0.1-${platform}.tar.gz`)

if (
  !pluginPlatforms.includes(platform as (typeof pluginPlatforms)[number]) ||
  !existsSync(archive)
) {
  test.skip(`Vue LSP pipe integration requires a built ${platform} archive`, () => {})
} else {
  test('the unpacked Vue server answers plain LSP in script and template', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gode-vue-lsp-'))
    const unpacked = join(directory, 'plugin')
    const socketPath = join(directory, 'lsp.sock')
    const listener = createServer()
    let child: ReturnType<typeof spawn> | undefined
    let socket: Socket | undefined
    try {
      await mkdir(unpacked)
      const { execFileSync } = await import('node:child_process')
      execFileSync('tar', ['-xzf', archive, '-C', unpacked])
      const launch = await pluginLaunch(unpacked, directory)
      expect(launch.kind).toBe('script')
      const connected = new Promise<Socket>((accept) => listener.once('connection', accept))
      await new Promise<void>((accept, reject) =>
        listener.listen(socketPath, (error?: Error) => (error ? reject(error) : accept())),
      )
      child = spawn(process.execPath, [launch.path, ...launch.args, `--pipe=${socketPath}`], {
        cwd: directory,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      const exited = new Promise<never>((_, reject) => {
        child!.once('error', reject)
        child!.once('exit', (code, signal) =>
          reject(new Error(`Vue server exited: ${code ?? signal}`)),
        )
      })
      socket = await Promise.race([connected, exited])
      let buffer = Buffer.alloc(0)
      const messages: Record<string, unknown>[] = []
      const waiters: {
        match: (message: Record<string, unknown>) => boolean
        accept: (message: Record<string, unknown>) => void
      }[] = []
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        while (true) {
          const headerEnd = buffer.indexOf('\r\n\r\n')
          if (headerEnd < 0) break
          const length = /^Content-Length:\s*(\d+)$/im.exec(
            buffer.subarray(0, headerEnd).toString('ascii'),
          )?.[1]
          if (!length) throw new Error('LSP message lacks Content-Length')
          const end = headerEnd + 4 + Number(length)
          if (buffer.length < end) break
          const message = JSON.parse(
            buffer.subarray(headerEnd + 4, end).toString('utf8'),
          ) as Record<string, unknown>
          buffer = buffer.subarray(end)
          const index = waiters.findIndex((waiter) => waiter.match(message))
          if (index < 0) messages.push(message)
          else waiters.splice(index, 1)[0]!.accept(message)
        }
      })
      const send = (message: Record<string, unknown>) => {
        const body = JSON.stringify({ jsonrpc: '2.0', ...message })
        socket!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      }
      const receive = (match: (message: Record<string, unknown>) => boolean) => {
        const index = messages.findIndex(match)
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!)
        return new Promise<Record<string, unknown>>((accept) => waiters.push({ match, accept }))
      }
      const request = async (id: number, method: string, params: Record<string, unknown>) => {
        send({ id, method, params })
        return Promise.race([receive((message) => message.id === id), exited])
      }
      const uri = pathToFileURL(join(directory, 'App.vue')).href
      const source = [
        '<script setup lang="ts">',
        "const greeting = 'Hello Vue'",
        'greeting',
        'greeting.to',
        '</script>',
        '<template>',
        '  <div>{{ greeting }}</div>',
        '</template>',
      ].join('\n')
      await writeFile(join(directory, 'App.vue'), source)
      const initialized = await request(1, 'initialize', {
        processId: null,
        rootUri: pathToFileURL(directory).href,
        capabilities: {
          textDocument: { hover: {}, completion: {}, definition: {}, publishDiagnostics: {} },
        },
        workspaceFolders: [{ uri: pathToFileURL(directory).href, name: 'project' }],
        initializationOptions: launch.initializationOptions,
      })
      expect(initialized.error).toBeUndefined()
      expect(initialized.result).toMatchObject({ capabilities: expect.any(Object) })
      send({ method: 'initialized', params: {} })
      send({
        method: 'textDocument/didOpen',
        params: { textDocument: { uri, languageId: 'vue', version: 1, text: source } },
      })
      const scriptHover = await request(2, 'textDocument/hover', {
        textDocument: { uri },
        position: { line: 2, character: 3 },
      })
      expect(scriptHover.error).toBeUndefined()
      expect(scriptHover.result).toBeTruthy()
      const templateHover = await request(3, 'textDocument/hover', {
        textDocument: { uri },
        position: { line: 6, character: 12 },
      })
      expect(templateHover.error).toBeUndefined()
      expect(templateHover.result).toBeTruthy()
      const completion = await request(4, 'textDocument/completion', {
        textDocument: { uri },
        position: { line: 3, character: 11 },
        context: { triggerKind: 1 },
      })
      expect(completion.error).toBeUndefined()
      expect(JSON.stringify(completion.result)).toContain('toString')
      const definition = await request(5, 'textDocument/definition', {
        textDocument: { uri },
        position: { line: 2, character: 3 },
      })
      expect(definition.error).toBeUndefined()
      expect(JSON.stringify(definition.result)).toContain(uri)
      expect(JSON.stringify(definition.result)).toContain('"line":1')
      const broken = source
        .replace("const greeting = 'Hello Vue'", "const greeting: number = 'Hello Vue'")
        .replace('{{ greeting }}', '{{ unknownValue }}')
      send({
        method: 'textDocument/didChange',
        params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: broken }] },
      })
      const diagnostics = await Promise.race([
        receive(
          (message) =>
            message.method === 'textDocument/publishDiagnostics' &&
            JSON.stringify(message.params).includes('unknownValue'),
        ),
        exited,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`No diagnostics: ${JSON.stringify(messages).slice(0, 200)}`)),
            5000,
          ),
        ),
      ])
      expect(JSON.stringify(diagnostics.params)).toContain('unknownValue')
      expect(JSON.stringify(diagnostics.params)).toContain('number')
    } finally {
      socket?.destroy()
      listener.close()
      child?.kill('SIGTERM')
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
}

async function pluginLaunch(plugin: string, data: string): Promise<LanguageServerLaunch> {
  let listener: ((event: { data: HostMessage }) => void) | undefined
  const posted: PluginMessage[] = []
  const port: PluginPort = {
    on(_event, callback) {
      listener = callback
    },
    off() {
      listener = undefined
    },
    postMessage(message) {
      posted.push(message)
    },
  }
  const host = process as NodeJS.Process & { parentPort?: PluginPort }
  const previous = host.parentPort
  host.parentPort = port
  try {
    await import('./main')
    listener?.({
      data: { type: 'start', settings: {}, secrets: {}, paths: { plugin, data }, locale: 'en' },
    })
    listener?.({
      data: {
        type: 'call',
        id: 1,
        method: 'languageServer.launch',
        params: { root: data, language: 'vue' },
      },
    })
    await new Promise<void>((accept) => setImmediate(accept))
    const reply = posted.find((message) => message.type === 'reply' && message.id === 1)
    if (!reply || reply.type !== 'reply' || !('result' in reply) || !reply.result)
      throw new Error('Vue plugin did not return a launch')
    return reply.result as LanguageServerLaunch
  } finally {
    if (previous) host.parentPort = previous
    else delete host.parentPort
  }
}
