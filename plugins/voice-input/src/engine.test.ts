import { EventEmitter } from 'node:events'
import { afterEach, expect, test, vi } from 'vitest'

const harness = vi.hoisted(() => ({ children: [] as unknown[], spawn: vi.fn() }))
vi.mock('node:net', () => ({
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 12345 }),
    close: (done: () => void) => done(),
  }),
}))
vi.mock('node:child_process', () => ({ spawn: harness.spawn }))
import { LocalEngine } from './engine'

function setup() {
  vi.useFakeTimers()
  const engines: LocalEngine[] = []
  harness.spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      kill: ReturnType<typeof vi.fn>
      exitCode: number | null
      signalCode: string | null
    }
    child.stderr = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.kill = vi.fn((signal: string) => {
      child.signalCode = signal
      child.emit('exit', null, signal)
      return true
    })
    harness.children.push(child)
    return child
  })
  const engine = new LocalEngine({
    executable: '/plugin/bin/llama-server',
    model: '/data/models/model.gguf',
    projector: '/data/models/projector.gguf',
    idleMs: 1000,
    startupMs: 1000,
  })
  engines.push(engine)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  )
  return { engine, child: () => harness.children.at(-1) as ReturnType<typeof harness.spawn> }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  harness.children.length = 0
  harness.spawn.mockReset()
})

test('concurrent prepare and transcribe share startup; idle shutdown restarts on demand', async () => {
  const { engine, child } = setup()
  const bases = await Promise.all([
    engine.use(async (base) => base),
    engine.use(async (base) => base),
  ])
  expect(bases).toEqual(['http://127.0.0.1:12345/v1', 'http://127.0.0.1:12345/v1'])
  expect(harness.spawn).toHaveBeenCalledTimes(1)
  expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
    '-m',
    '/data/models/model.gguf',
    '--mmproj',
    '/data/models/projector.gguf',
    '--host',
    '127.0.0.1',
    '--port',
    '12345',
    '-c',
    '4096',
  ])
  await vi.advanceTimersByTimeAsync(1001)
  expect(child().kill).toHaveBeenCalledWith('SIGTERM')
  await engine.use(async () => null)
  expect(harness.spawn).toHaveBeenCalledTimes(2)
  await engine.stop()
})

test('active requests retain the server past the idle deadline', async () => {
  const { engine, child } = setup()
  let finish!: () => void
  const work = engine.use(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await vi.advanceTimersByTimeAsync(3000)
  expect(child().kill).not.toHaveBeenCalled()
  finish()
  await work
  await vi.advanceTimersByTimeAsync(1001)
  expect(child().kill).toHaveBeenCalledWith('SIGTERM')
})

test('startup failures are retryable and process exit kills the child synchronously', async () => {
  const { engine, child } = setup()
  vi.mocked(fetch).mockImplementationOnce(async () => {
    child().stderr.emit('data', Buffer.from('bad model'))
    child().emit('exit', 1, null)
    throw new Error('connection closed')
  })
  await expect(engine.use(async () => null)).rejects.toThrow('bad model')
  await engine.use(async () => null)
  expect(harness.spawn).toHaveBeenCalledTimes(2)
  engine.kill()
  expect(child().kill).toHaveBeenCalledWith('SIGKILL')
})

test('stopping startup settles it before a new request can start another child', async () => {
  const { engine } = setup()
  vi.mocked(fetch).mockImplementationOnce(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  )
  const first = engine.use(async () => null)
  const failure = expect(first).rejects.toThrow('aborted')
  await vi.advanceTimersByTimeAsync(0)
  const stopped = engine.stop()
  const next = engine.use(async (base) => base)
  await failure
  await stopped
  await expect(next).resolves.toBe('http://127.0.0.1:12345/v1')
  expect(harness.spawn).toHaveBeenCalledTimes(2)
  await engine.stop()
})

test('Linux prepends the bundled libraries to the dynamic loader path', async () => {
  const original = process.platform
  const { engine } = setup()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    await engine.use(async () => null)
    expect(harness.spawn.mock.calls[0]?.[2].env.LD_LIBRARY_PATH.split(':')[0]).toBe('/plugin/bin')
  } finally {
    Object.defineProperty(process, 'platform', { value: original })
    await engine.stop()
  }
})
