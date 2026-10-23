import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { basename, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import type { PluginContext } from '@gode/plugin-sdk/plugin'

async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        return server.close(() => reject(new Error('No loopback port')))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

export class LocalEngine {
  private child?: ChildProcess
  private starting?: Promise<{ base: string; apiKey: string }>
  private controller?: AbortController
  private idle?: NodeJS.Timeout
  private active = 0
  private stopping?: Promise<void>

  constructor(
    private readonly options: {
      executable: string
      model: string
      projector?: string
      name: 'recognition' | 'polish'
      log: PluginContext['log']
      idleMs?: number
      startupMs?: number
      context?: number
    },
  ) {}

  async use<T>(work: (base: string, apiKey: string) => Promise<T>): Promise<T> {
    await this.stopping
    clearTimeout(this.idle)
    this.active++
    try {
      this.starting ??= this.start()
      const { base, apiKey } = await this.starting
      return await work(base, apiKey)
    } finally {
      this.active--
      if (!this.active) {
        this.idle = setTimeout(
          () => {
            void this.stop()
          },
          this.options.idleMs ?? 5 * 60_000,
        )
        this.idle.unref()
      }
    }
  }

  private async start(): Promise<{ base: string; apiKey: string }> {
    const controller = new AbortController()
    this.controller = controller
    const started = performance.now()
    const label = this.options.name === 'recognition' ? 'Recognition engine' : 'Polish engine'
    this.options.log(
      'info',
      `${label} starting: ${[this.options.model, this.options.projector]
        .filter((file) => file !== undefined)
        .map((file) => basename(file))
        .join(', ')}`,
    )
    let exited = false
    let startupFailure = 'Could not reserve a loopback port'
    try {
      const port = await freePort()
      controller.signal.throwIfAborted()
      const bin = dirname(this.options.executable)
      const apiKey = randomBytes(32).toString('hex')
      startupFailure = 'Could not start llama-server'
      const child = spawn(
        this.options.executable,
        [
          '-m',
          this.options.model,
          ...(this.options.projector ? ['--mmproj', this.options.projector] : []),
          '--jinja',
          '--log-verbosity',
          '2',
          '--api-key',
          apiKey,
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '-c',
          String(this.options.context ?? 4096),
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            ...(process.platform === 'linux'
              ? {
                  LD_LIBRARY_PATH: [bin, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
                }
              : {}),
          },
        },
      )
      this.child = child
      let stderr = ''
      let pending = ''
      const decoder = new StringDecoder('utf8')
      let failure: Error | undefined
      const forward = (text: string): void => {
        process.stderr.write(`[${this.options.name}] ${text.replaceAll(apiKey, '[redacted]')}\n`)
      }
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = decoder.write(chunk)
        stderr = (stderr + text).slice(-8000)
        pending += text
        const lines = pending.split(/\r?\n/)
        pending = lines.pop()!
        for (const line of lines) forward(line)
      })
      child.stderr?.once('end', () => {
        pending += decoder.end()
        if (pending) forward(pending)
        pending = ''
      })
      child.once('error', (error) => {
        failure = error
      })
      child.once('exit', (code, signal) => {
        exited = true
        this.options.log(
          controller.signal.aborted ? 'info' : 'error',
          controller.signal.aborted
            ? `${label} stopped`
            : `${label} exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`,
        )
        failure ??= new Error(stderr.trim() || `Speech engine exited (${signal ?? code})`)
        if (this.child === child) {
          this.child = undefined
          this.starting = undefined
        }
      })
      const base = `http://127.0.0.1:${port}/v1`
      const deadline = Date.now() + (this.options.startupMs ?? 180_000)
      while (Date.now() < deadline) {
        controller.signal.throwIfAborted()
        if (failure) throw failure
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
          })
          await response.body?.cancel()
          if (response.ok) {
            if (failure) throw failure
            this.options.log(
              'info',
              `${label} ready in ${((performance.now() - started) / 1000).toFixed(2)} s`,
            )
            return { base, apiKey }
          }
        } catch {
          controller.signal.throwIfAborted()
          if (failure) throw failure
        }
        await delay(100, undefined, { signal: controller.signal })
      }
      startupFailure = 'Startup timed out'
      throw new Error(stderr.trim() || 'Speech engine startup timed out')
    } catch (error) {
      if (!controller.signal.aborted && !exited) {
        const code = (error as NodeJS.ErrnoException).code
        if (code && /^[A-Z][A-Z0-9_]+$/.test(code)) startupFailure = code
        this.options.log('error', `${label} failed to start: ${startupFailure}`)
      }
      if (this.controller === controller) this.kill()
      throw error
    }
  }

  kill(): void {
    clearTimeout(this.idle)
    this.controller?.abort()
    this.controller = undefined
    this.child?.kill('SIGKILL')
    this.child = undefined
    this.starting = undefined
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    clearTimeout(this.idle)
    this.controller?.abort()
    const starting = this.starting
    this.starting = undefined
    const child = this.child
    const closed = new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return resolve()
      const force = setTimeout(() => child.kill('SIGKILL'), 2000)
      force.unref()
      const done = (): void => {
        clearTimeout(force)
        if (this.child === child) this.child = undefined
        resolve()
      }
      child.once('exit', done)
      child.once('error', done)
      child.kill('SIGTERM')
    })
    this.stopping = Promise.all([closed, starting?.catch(() => {})])
      .then(() => {})
      .finally(() => {
        this.stopping = undefined
      })
    return this.stopping
  }
}
