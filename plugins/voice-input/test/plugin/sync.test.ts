import { afterEach, dictate, expect, startPlugin, test, vi } from '@gode/plugin-sdk/test'
import type { RunningPlugin } from '@gode/plugin-sdk/test'
import plugin from '../../src/main.ts'
import type { Names } from '../../src/names.ts'
import { pcm } from '../fixtures/index.ts'

afterEach(() => vi.unstubAllGlobals())

async function start(stores?: {
  terms?: Readonly<Record<string, string>>
  forgotten?: readonly string[]
}) {
  const running = await startPlugin(plugin, {
    settings: { engine: 'server', serverURL: 'http://localhost/v1' },
    stores,
  })
  return running
}

function answer(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ text }))),
  )
}

async function say(running: RunningPlugin<Names>, text: string) {
  answer(text)
  await dictate(running, pcm(1))
}

test('learned words move through the stores, while history stays local', async () => {
  const first = await start()
  await say(first, 'useComposerText')
  expect(first.stores.terms).toEqual({})
  await say(first, 'useComposerText')
  expect(first.stores.terms).toEqual({ usecomposertext: 'useComposerText' })
  expect(first.stores.forgotten).toEqual([])
  expect(first.views.history).toMatchObject({ total: 2 })
  expect(JSON.stringify(first.stores)).not.toContain('history')
  const second = await start(first.stores)
  expect(second.views.memory).toMatchObject({ total: 1 })
  expect((await second.query('memory')).items[0]?.text).toBe('useComposerText')
  expect(second.views.history).toMatchObject({ total: 0 })
  await second.remote('terms', first.stores.terms)
  await first.action('forgetTerm', 'usecomposertext')
  expect(first.stores.terms).toEqual({})
  expect(first.stores.forgotten).toEqual(['usecomposertext'])
  await second.remote('terms', first.stores.terms)
  expect(second.views.memory).toMatchObject({ total: 0 })
  await second.remote('forgotten', first.stores.forgotten)
  expect(second.stores.forgotten).toEqual(['usecomposertext'])
  await first.action('clearMemory')
  expect(first.stores).toEqual({ terms: {}, forgotten: [] })
  expect(first.views.history).toMatchObject({ total: 2 })
})

test('remote forgotten words remove local learning and cannot be restored by terms', async () => {
  const running = await start()
  await say(running, 'useComposerText')
  await say(running, 'useComposerText')
  await running.remote('terms', running.stores.terms)
  await running.remote('forgotten', ['usecomposertext'])
  expect(running.views.memory).toMatchObject({ total: 0 })
  expect(running.stores.terms).toEqual({})
  await running.remote('terms', { usecomposertext: 'useComposerText' })
  expect(running.views.memory).toMatchObject({ total: 0 })
  expect(running.stores.terms).toEqual({})
})

test('a locally forgotten word stays out when another computer sends it back', async () => {
  const running = await start()
  await say(running, 'useComposerText')
  await say(running, 'useComposerText')
  await running.remote('terms', running.stores.terms)
  await running.action('forgetTerm', 'usecomposertext')
  await running.remote('terms', { usecomposertext: 'useComposerText' })
  expect(running.views.memory).toMatchObject({ total: 0 })
  expect(running.stores).toEqual({ terms: {}, forgotten: ['usecomposertext'] })
})

test('remote spelling changes update the vocabulary', async () => {
  const running = await start({ terms: { usecomposertext: 'useComposerText' } })
  await running.remote('terms', running.stores.terms)
  await running.remote('terms', { usecomposertext: 'USECOMPOSERTEXT' })
  expect((await running.query('memory')).items[0]?.text).toBe('USECOMPOSERTEXT')
  answer('nothing learned')
  await dictate(running, pcm(1))
  const body = vi.mocked(fetch).mock.calls[0]![1]!.body as FormData
  expect(body.get('prompt')).toBe('USECOMPOSERTEXT')
})

test('remote deletions unlearn words and untrusted entries are skipped', async () => {
  const running = await start({
    terms: {
      validterm: 'ValidTerm',
      Upper: 'Upper',
      mismatch: 'Other',
      ['x'.repeat(201)]: 'x'.repeat(201),
    },
    forgotten: ['INVALID', 'z'.repeat(201)],
  })
  expect(running.views.memory).toMatchObject({ total: 1 })
  expect((await running.query('memory')).items[0]?.text).toBe('ValidTerm')
  await running.remote('terms', running.stores.terms)
  await running.remote('terms', {
    Upper: 'Upper',
    mismatch: 'Other',
    ['x'.repeat(201)]: 'x'.repeat(201),
  })
  expect(running.views.memory).toMatchObject({ total: 0 })
})
