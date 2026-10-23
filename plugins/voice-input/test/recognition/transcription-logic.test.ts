import { expect, test } from '@gode/plugin-sdk/test'
import {
  apiURL,
  applyVocabulary,
  cleanTranscript,
  continuedText,
  formatBytes,
  joinTranscript,
  responseJSON,
  transcriptionRequest,
} from '../../src/recognition/transcription-logic.ts'

test.each([
  ['', '', ''],
  ['', ' Hello ', 'Hello'],
  [' Hello ', '', 'Hello'],
  [' Hello  ', '  world. ', 'Hello world.'],
  ['Hello.', 'More words.', 'Hello. More words.'],
  ['你好', '世界', '你好世界'],
  ['明日', 'の予定', '明日の予定'],
  ['カタ', 'カナ', 'カタカナ'],
  ['𠀀', '中文', '𠀀中文'],
  ['使用', 'Gode', '使用 Gode'],
  ['Gode', '很好用', 'Gode 很好用'],
  ['中文 API', '可以使用', '中文 API 可以使用'],
  ['Hello', ', world.', 'Hello, world.'],
  ['你好', '，世界。', '你好，世界。'],
  ['你好', '。', '你好。'],
  ['先说一段话。', '这个插件', '先说一段话。这个插件'],
  ['你好，', 'Gode', '你好，Gode'],
  ['做完了。', 'Next step', '做完了。Next step'],
  ['等等', '……', '等等……'],
  ['Hello', '!', 'Hello!'],
  ['Hello', '?', 'Hello?'],
  ['Hello', '; next', 'Hello; next'],
  ['Hello', ': next', 'Hello: next'],
  ['「你好', '」', '「你好」'],
  ['(Hello', ')', '(Hello)'],
  ['“Hello', '”', '“Hello”'],
])('joins %s and %s', (committed, window, expected) =>
  expect(joinTranscript(committed, window)).toBe(expected),
)

test.each([
  ['变成。', '变成，'],
  ['变成。 \n', '变成， \n'],
  ['变成。后面', '变成。后面'],
  ['变成！', '变成！'],
  ['', ''],
])('continues a trailing full stop in %j', (text, expected) =>
  expect(continuedText(text)).toBe(expected),
)

test.each([
  ['language Chinese<asr_text>把 hook 抽出来', true, '把 hook 抽出来'],
  ['language English<asr_text>Um, run make test.', true, 'Run make test.'],
  ['嗯，把 hook 抽出来，呃，然后跑 make test。', true, '把 hook 抽出来，然后跑 make test。'],
  ['嗯 呃 额 啊', true, ''],
  ['嗯哼，啊哈，余额，语气啊。', true, '嗯哼，啊哈，余额，语气啊。'],
  ['Um, run, uh, make test. Erm, hmm.', true, 'Run, make test.'],
  ['album thumb summer rhythm uh_huh umami', true, 'album thumb summer rhythm uh_huh umami'],
  ['language English<asr_text>um, keep this.', false, 'um, keep this.'],
  ['Wait... really?!', true, 'Wait... really?!'],
  ['我们呃来测试一下', true, '我们来测试一下'],
  ['我我我想说的是，哈哈哈，谢谢谢谢', true, '我想说的是，哈哈哈，谢谢谢谢'],
  ['Um, so I think, uh, we should ship it.', true, 'So I think, we should ship it.'],
  ['so the the API is er broken', true, 'so the API is broken'],
  [
    'what it is is fine and that that works, I had had enough',
    true,
    'what it is is fine and that that works, I had had enough',
  ],
  ['えーと、あの、明日の会議は明後日です。', true, 'あの、明日の会議は明後日です。'],
  ['えっとテストします。あのー、もう一度', true, 'テストします。もう一度'],
  ['음, 내일 회의는 어 모레입니다', true, '내일 회의는 모레입니다'],
  ['あの人は 어머니 errand ermine', true, 'あの人は 어머니 errand ermine'],
])('cleans %s', (text, remove, expected) => expect(cleanTranscript(text, remove)).toBe(expected))

test('multipart carries WAV, vocabulary, language and secret without setting a boundary', async () => {
  const init = transcriptionRequest(
    { audio: new Uint8Array([82, 73, 70, 70]), vocabulary: ['useComposerText', 'make test'] },
    { model: 'asr', language: 'zh', apiKey: 'secret' },
  )
  const request = new Request('http://127.0.0.1/v1/audio/transcriptions', init)
  const body = init.body as FormData
  const file = body.get('file') as File
  expect(file.name).toBe('audio.wav')
  expect(file.type).toBe('audio/wav')
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([82, 73, 70, 70])
  expect(body.get('model')).toBe('asr')
  expect(body.get('prompt')).toBe('useComposerText, make test')
  expect(body.get('language')).toBe('zh')
  expect(request.headers.get('authorization')).toBe('Bearer secret')
  const automatic = transcriptionRequest(
    { audio: new Uint8Array(), vocabulary: [] },
    { model: 'asr', language: 'auto' },
  )
  expect((automatic.body as FormData).has('language')).toBe(false)
  expect((automatic.body as FormData).has('prompt')).toBe(false)
  expect(automatic.headers).toEqual({})
})

test('API paths preserve the base and errors preserve the server message', async () => {
  expect(apiURL('https://api.example/v1/', 'audio/transcriptions')).toBe(
    'https://api.example/v1/audio/transcriptions',
  )
  expect(() => apiURL('file:///tmp', 'models')).toThrow()
  await expect(
    responseJSON(
      new Response(JSON.stringify({ error: { message: 'Bad API key' } }), { status: 401 }),
    ),
  ).rejects.toThrow('Bad API key')
  expect(formatBytes(2520744288, 'en')).toBe('2.5 GB')
  expect(formatBytes(2520744288, 'de')).toContain('2,5')
})

test.each([
  ['我们有一个 G O D E One，这个 GODE One', ['Gode One'], '我们有一个 Gode One，这个 GODE One'],
  ['还有 Agent Doc 这个东西', ['agentdoc'], '还有 agentdoc 这个东西'],
  ['重新部署一些 Relay', ['relay'], '重新部署一些 Relay'],
  ['把 use composer text 抽出来', ['useComposerText'], '把 useComposerText 抽出来'],
  ['agent documentation', ['agentdoc'], 'agent documentation'],
  ['a b', ['ab'], 'a b'],
])('applies vocabulary to %s', (text, vocabulary, expected) =>
  expect(applyVocabulary(text, vocabulary)).toBe(expected),
)
