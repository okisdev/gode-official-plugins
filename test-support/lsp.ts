import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  pluginPlatforms,
  type LanguageServerLaunch,
  type LanguageServerRequest,
} from '@gode/plugin-sdk'
import { archiveName } from '@gode/plugin-sdk/pack'
import { test } from 'vitest'

type Message = Record<string, unknown>

export interface LspSession {
  readonly project: string
  readonly launch: LanguageServerLaunch
  send(message: Message): void
  receive(match: (message: Message) => boolean): Promise<Message>
  request(id: number, method: string, params: Message): Promise<Message>
  initialize(params?: Message): Promise<Message>
}

export function lspTest(
  title: string,
  root: string,
  manifest: { id: string; version: string },
  language: LanguageServerRequest['language'],
  load: () => Promise<{
    default: {
      launch: (
        paths: { plugin: string; data: string },
        request: LanguageServerRequest,
      ) => LanguageServerLaunch | Promise<LanguageServerLaunch>
    }
  }>,
  assertions: (session: LspSession) => Promise<void>,
): void {
  const platform = `${process.platform}-${process.arch}`
  const archive = pluginPlatforms.includes(platform as (typeof pluginPlatforms)[number])
    ? join(root, 'out', archiveName(manifest, platform as (typeof pluginPlatforms)[number]))
    : ''
  if (!archive || !existsSync(archive)) {
    test.skip(`${title} requires a built ${platform} archive`, () => {})
    return
  }
  test(
    title,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), `gode-${manifest.id}-lsp-`))
      const unpacked = join(directory, 'plugin')
      const project = join(directory, 'project')
      let listener: Server | undefined
      let socket: Socket | undefined
      let child: ChildProcess | undefined
      try {
        await mkdir(unpacked)
        await mkdir(project)
        execFileSync('tar', ['-xzf', archive, '-C', unpacked])
        const launch = await (
          await load()
        ).default.launch({ plugin: unpacked, data: directory }, { root: project, language })
        let stream: NodeJS.ReadableStream
        let output: NodeJS.WritableStream
        if (launch.kind === 'script') {
          const socketPath = join(directory, 'lsp.sock')
          listener = createServer()
          const connected = new Promise<Socket>((accept, reject) => {
            listener!.once('connection', accept)
            listener!.once('error', reject)
          })
          await new Promise<void>((accept, reject) => {
            listener!.once('error', reject)
            listener!.listen(socketPath, accept)
          })
          child = spawn(process.execPath, [launch.path, ...launch.args, `--pipe=${socketPath}`], {
            cwd: project,
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env, ...launch.env },
          })
          const exited = new Promise<never>((_, reject) => {
            child!.once('error', reject)
            child!.once('exit', (code, signal) =>
              reject(new Error(`Server exited before connecting: ${code ?? signal}`)),
            )
          })
          socket = await Promise.race([connected, exited])
          stream = socket
          output = socket
        } else {
          child = spawn(launch.path, [...launch.args], {
            cwd: project,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ...launch.env },
          })
          stream = child.stdout!
          output = child.stdin!
        }
        let stderr = ''
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })
        const exited = new Promise<never>((_, reject) => {
          child!.once('error', reject)
          child!.once('exit', (code, signal) =>
            reject(new Error(`Server exited: ${code ?? signal}; ${stderr}`)),
          )
        })
        let buffer = Buffer.alloc(0)
        const messages: Message[] = []
        const waiters: {
          match: (message: Message) => boolean
          accept: (message: Message) => void
        }[] = []
        stream.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk])
          while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n')
            if (headerEnd < 0) break
            const header = buffer.subarray(0, headerEnd).toString('ascii')
            const length = /^Content-Length:\s*(\d+)$/im.exec(header)?.[1]
            if (!length) throw new Error(`LSP message lacks Content-Length: ${header}`)
            const end = headerEnd + 4 + Number(length)
            if (buffer.length < end) break
            const message = JSON.parse(
              buffer.subarray(headerEnd + 4, end).toString('utf8'),
            ) as Message
            buffer = buffer.subarray(end)
            const index = waiters.findIndex((waiter) => waiter.match(message))
            if (index < 0) messages.push(message)
            else waiters.splice(index, 1)[0]!.accept(message)
          }
        })
        const send = (message: Message) => {
          const body = JSON.stringify({ jsonrpc: '2.0', ...message })
          output.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        }
        const receive = (match: (message: Message) => boolean): Promise<Message> => {
          const index = messages.findIndex(match)
          if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!)
          return Promise.race([
            new Promise<Message>((accept) => waiters.push({ match, accept })),
            exited,
          ])
        }
        const request = (id: number, method: string, params: Message): Promise<Message> => {
          send({ id, method, params })
          return receive((message) => message.id === id)
        }
        const initialize = (params: Message = {}): Promise<Message> => {
          const uri = pathToFileURL(project).href
          return request(1, 'initialize', {
            processId: null,
            rootUri: uri,
            capabilities: {},
            workspaceFolders: [{ uri, name: 'project' }],
            initializationOptions: launch.initializationOptions,
            ...params,
          })
        }
        await assertions({
          project,
          launch,
          send,
          receive,
          request,
          initialize,
        })
      } finally {
        socket?.destroy()
        child?.kill('SIGTERM')
        listener?.close()
        await rm(directory, { recursive: true, force: true })
      }
    },
    30_000,
  )
}
