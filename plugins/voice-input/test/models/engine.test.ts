import { EventEmitter } from 'node:events'
import type { PluginContext } from '@gode/plugin-sdk/plugin'
import { afterEach, expect, test, vi } from '@gode/plugin-sdk/test'

const harness = { children: [] as unknown[], spawn: vi.fn() }
vi.doMock('node:net', () => ({
  createServer: () => ({
    once: vi.fn(),
    listen: (_port: number, _host: string, done: () => void) => done(),
    address: () => ({ port: 12345 }),
    close: (done: () => void) => done(),
  }),
}))
vi.doMock('node:child_process', () => ({ spawn: harness.spawn }))
const { LocalEngine } = await import('../../src/models/engine.ts')

function setup() {
  vi.useFakeTimers()
  const log = vi.fn<PluginContext['log']>()
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
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
    name: 'recognition',
    log,
    executable: '/plugin/bin/llama-server',
    model: '/data/models/model.gguf',
    projector: '/data/models/projector.gguf',
    idleMs: 1000,
    startupMs: 1000,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  )
  return {
    engine,
    log,
    stderr,
    child: () => harness.children.at(-1) as ReturnType<typeof harness.spawn>,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  harness.children.length = 0
  harness.spawn.mockReset()
})

test('concurrent prepare and transcribe share startup; idle shutdown restarts on demand', async () => {
  const { engine, child, log } = setup()
  const bases = await Promise.all([
    engine.use(async (base) => base),
    engine.use(async (base) => base),
  ])
  expect(bases).toEqual(['http://127.0.0.1:12345/v1', 'http://127.0.0.1:12345/v1'])
  expect(harness.spawn).toHaveBeenCalledTimes(1)
  const key = harness.spawn.mock.calls[0]![1][8] as string
  expect(key).toMatch(/^[a-f0-9]{64}$/)
  expect(fetch).toHaveBeenCalledWith(
    'http://127.0.0.1:12345/health',
    expect.objectContaining({
      headers: { Authorization: `Bearer ${key}` },
    }),
  )
  expect(log.mock.calls).toEqual([
    ['info', 'Recognition engine starting: model.gguf, projector.gguf'],
    ['info', expect.stringMatching(/^Recognition engine ready in \d+\.\d{2} s$/)],
  ])
  expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
    '-m',
    '/data/models/model.gguf',
    '--mmproj',
    '/data/models/projector.gguf',
    '--jinja',
    '--log-verbosity',
    '2',
    '--api-key',
    expect.any(String),
    '--host',
    '127.0.0.1',
    '--port',
    '12345',
    '-c',
    '4096',
  ])
  await vi.advanceTimersByTimeAsync(1001)
  expect(child().kill).toHaveBeenCalledWith('SIGTERM')
  expect(log).toHaveBeenLastCalledWith('info', 'Recognition engine stopped')
  const nextKey = await engine.use(async (_base, apiKey) => apiKey)
  expect(harness.spawn).toHaveBeenCalledTimes(2)
  expect(nextKey).not.toBe(key)
  expect(harness.spawn.mock.calls[1]![1]).toContain(nextKey)
  expect(JSON.stringify(log.mock.calls)).not.toContain(key)
  expect(JSON.stringify(log.mock.calls)).not.toContain(nextKey)
  await engine.stop()
})

test('text model starts without a projector', async () => {
  const { stderr, child } = setup()
  const log = vi.fn<PluginContext['log']>()
  const engine = new LocalEngine({
    name: 'polish',
    log,
    executable: '/plugin/bin/llama-server',
    model: '/data/models/polish.gguf',
    context: 8192,
  })
  await engine.use(async () => null)
  expect(harness.spawn.mock.calls[0]?.[1]).toEqual([
    '-m',
    '/data/models/polish.gguf',
    '--jinja',
    '--log-verbosity',
    '2',
    '--api-key',
    expect.any(String),
    '--host',
    '127.0.0.1',
    '--port',
    '12345',
    '-c',
    '8192',
  ])
  child().stderr.emit('data', Buffer.from('warning\n'))
  expect(stderr).toHaveBeenCalledWith('[polish] warning\n')
  await engine.stop()
  expect(log.mock.calls).toEqual([
    ['info', 'Polish engine starting: polish.gguf'],
    ['info', expect.stringMatching(/^Polish engine ready in \d+\.\d{2} s$/)],
    ['info', 'Polish engine stopped'],
  ])
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

test.each([
  [23, null, 'code 23'],
  [null, 'SIGABRT', 'signal SIGABRT'],
])(
  'unexpected exits report %s and %s at error level and allow a fresh start',
  async (code, signal, detail) => {
    const { engine, child, log } = setup()
    await engine.use(async () => null)
    child().emit('exit', code, signal)
    expect(log).toHaveBeenLastCalledWith(
      'error',
      `Recognition engine exited unexpectedly (${detail})`,
    )
    await engine.use(async () => null)
    expect(harness.spawn).toHaveBeenCalledTimes(2)
    engine.kill()
    expect(log).toHaveBeenLastCalledWith('info', 'Recognition engine stopped')
  },
)

test('stderr forwards complete and final partial lines with an engine prefix and no key', async () => {
  const { engine, child, stderr, log } = setup()
  const key = await engine.use(async (_base, apiKey) => apiKey)
  const warning = Buffer.from('warning: 模型\n')
  child().stderr.emit('data', warning.subarray(0, 11))
  child().stderr.emit('data', warning.subarray(11))
  child().stderr.emit('data', Buffer.from(`first\r\nsecond\nkey ${key.slice(0, 20)}`))
  child().stderr.emit('data', Buffer.from(`${key.slice(20)}\nlast`))
  child().stderr.emit('end')
  expect(stderr.mock.calls.map(([line]) => line)).toEqual([
    '[recognition] warning: 模型\n',
    '[recognition] first\n',
    '[recognition] second\n',
    '[recognition] key [redacted]\n',
    '[recognition] last\n',
  ])
  expect(JSON.stringify([...stderr.mock.calls, ...log.mock.calls])).not.toContain(key)
  await engine.stop()
})

test('spawn failures log a diagnostic code without command arguments', async () => {
  const { engine, child, log } = setup()
  vi.mocked(fetch).mockImplementationOnce(async () => {
    child().emit('error', Object.assign(new Error('private command arguments'), { code: 'ENOENT' }))
    throw new Error('connection closed')
  })
  await expect(engine.use(async () => null)).rejects.toThrow('private command arguments')
  expect(log).toHaveBeenCalledWith('error', 'Recognition engine failed to start: ENOENT')
  expect(JSON.stringify(log.mock.calls)).not.toContain('private command arguments')
})
