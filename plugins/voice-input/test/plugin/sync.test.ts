import { afterEach, dictate, expect, startPlugin, test, vi } from '@gode/plugin-sdk/test'
import type { RunningPlugin } from '@gode/plugin-sdk/test'
import plugin from '../../src/main.ts'
import type { Names } from '../../src/names.ts'
import { pcm } from '../fixtures/index.ts'

afterEach(() => vi.unstubAllGlobals())

async function start(stores?: {
  vocabulary?: Readonly<Record<string, string>>
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
  expect(second.views.memory).toMatchObject({ total: 0 })
  expect(second.views.suggestions).toMatchObject({ total: 1 })
  expect((await second.query('suggestions')).items[0]?.text).toBe('useComposerText')
  expect(second.views.history).toMatchObject({ total: 0 })
  await second.remote('terms', first.stores.terms)
  await first.action('forgetTerm', 'usecomposertext')
  expect(first.stores.terms).toEqual({})
  expect(first.stores.forgotten).toEqual(['usecomposertext'])
  await second.remote('terms', first.stores.terms)
  expect(second.views.suggestions).toMatchObject({ total: 0 })
  await second.remote('forgotten', first.stores.forgotten)
  expect(second.stores.forgotten).toEqual(['usecomposertext'])
  await first.action('clearMemory')
  expect(first.stores).toEqual({ vocabulary: {}, terms: {}, forgotten: [] })
  expect(first.views.history).toMatchObject({ total: 2 })
})

test('remote forgotten words remove local learning and cannot be restored by terms', async () => {
  const running = await start()
  await say(running, 'useComposerText')
  await say(running, 'useComposerText')
  await running.remote('terms', running.stores.terms)
  await running.remote('forgotten', ['usecomposertext'])
  expect(running.views.suggestions).toMatchObject({ total: 0 })
  expect(running.stores.terms).toEqual({})
  await running.remote('terms', { usecomposertext: 'useComposerText' })
  expect(running.views.suggestions).toMatchObject({ total: 0 })
  expect(running.stores.terms).toEqual({})
})

test('a locally forgotten word stays out when another computer sends it back', async () => {
  const running = await start()
  await say(running, 'useComposerText')
  await say(running, 'useComposerText')
  await running.remote('terms', running.stores.terms)
  await running.action('forgetTerm', 'usecomposertext')
  await running.remote('terms', { usecomposertext: 'useComposerText' })
  expect(running.views.suggestions).toMatchObject({ total: 0 })
  expect(running.stores).toEqual({ vocabulary: {}, terms: {}, forgotten: ['usecomposertext'] })
})

test('remote spelling changes update suggestions without entering recognition vocabulary', async () => {
  const running = await start({ terms: { usecomposertext: 'useComposerText' } })
  await running.remote('terms', running.stores.terms)
  await running.remote('terms', { usecomposertext: 'USECOMPOSERTEXT' })
  expect((await running.query('suggestions')).items[0]?.text).toBe('USECOMPOSERTEXT')
  answer('nothing learned')
  await dictate(running, pcm(1))
  const body = vi.mocked(fetch).mock.calls[0]![1]!.body as FormData
  expect(body.has('prompt')).toBe(false)
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
  expect(running.views.suggestions).toMatchObject({ total: 1 })
  expect((await running.query('suggestions')).items[0]?.text).toBe('ValidTerm')
  await running.remote('terms', running.stores.terms)
  await running.remote('terms', {
    Upper: 'Upper',
    mismatch: 'Other',
    ['x'.repeat(201)]: 'x'.repeat(201),
  })
  expect(running.views.suggestions).toMatchObject({ total: 0 })
})

test('person words sync to another computer and remain separate from learned words', async () => {
  const first = await start()
  await first.action('addTerm', undefined, '  UseComposerText  ')
  await first.action('addTerm', undefined, 'usecomposertext')
  expect(first.stores.vocabulary).toEqual({ usecomposertext: 'UseComposerText' })
  expect(first.views.memory).toMatchObject({
    items: [{ id: 'usecomposertext', text: 'UseComposerText' }],
    total: 1,
  })
  const second = await start(first.stores)
  expect((await second.query('memory')).items).toEqual([
    { id: 'usecomposertext', text: 'UseComposerText' },
  ])
  await second.remote('vocabulary', first.stores.vocabulary)
  await say(second, 'useComposerText')
  await say(second, 'useComposerText')
  expect(second.stores.terms).toEqual({})
  expect(second.views.memory).toMatchObject({ total: 1 })
  await first.action('forgetTerm', 'usecomposertext')
  expect(first.stores.forgotten).toEqual(['usecomposertext'])
  await second.remote('vocabulary', first.stores.vocabulary)
  await second.remote('forgotten', first.stores.forgotten)
  expect(second.views.memory).toMatchObject({ total: 0 })
  await second.remote('terms', { usecomposertext: 'useComposerText' })
  expect(second.views.memory).toMatchObject({ total: 0 })
  await second.action('addTerm', undefined, 'UseComposerText')
  expect(second.stores.forgotten).toEqual([])
  expect(second.stores.terms).toEqual({})
  expect(second.stores.vocabulary).toEqual({ usecomposertext: 'UseComposerText' })
})

test('adopts earlier Gode vocabulary without needing a ready dictation engine', async () => {
  const running = await start()
  expect(
    await running.call('dictation.adoptVocabulary', {
      vocabulary: ['  Gode  ', 'gode', 'SwiftUI'],
    }),
  ).toBeNull()
  expect(running.stores.vocabulary).toEqual({ gode: 'Gode', swiftui: 'SwiftUI' })
  expect((await running.query('memory')).items).toEqual([
    { id: 'swiftui', text: 'SwiftUI' },
    { id: 'gode', text: 'Gode' },
  ])
  await running.action('clearMemory')
  expect(running.stores).toEqual({ vocabulary: {}, terms: {}, forgotten: [] })
})
