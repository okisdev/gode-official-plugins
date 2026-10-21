import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

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
  private starting?: Promise<string>
  private controller?: AbortController
  private idle?: NodeJS.Timeout
  private active = 0
  private stopping?: Promise<void>

  constructor(
    private readonly options: {
      executable: string
      model: string
      projector?: string
      idleMs?: number
      startupMs?: number
    },
  ) {}

  async use<T>(work: (base: string) => Promise<T>): Promise<T> {
    await this.stopping
    clearTimeout(this.idle)
    this.active++
    try {
      this.starting ??= this.start()
      return await work(await this.starting)
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

  private async start(): Promise<string> {
    const controller = new AbortController()
    this.controller = controller
    try {
      const port = await freePort()
      controller.signal.throwIfAborted()
      const bin = dirname(this.options.executable)
      const child = spawn(
        this.options.executable,
        [
          '-m',
          this.options.model,
          ...(this.options.projector ? ['--mmproj', this.options.projector] : []),
          '--jinja',
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '-c',
          '4096',
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
      let failure: Error | undefined
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000)
      })
      child.once('error', (error) => {
        failure = error
      })
      child.once('exit', (code, signal) => {
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
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
          })
          await response.body?.cancel()
          if (response.ok) {
            if (failure) throw failure
            return base
          }
        } catch {
          controller.signal.throwIfAborted()
          if (failure) throw failure
        }
        await delay(100, undefined, { signal: controller.signal })
      }
      throw new Error(stderr.trim() || 'Speech engine startup timed out')
    } catch (error) {
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
