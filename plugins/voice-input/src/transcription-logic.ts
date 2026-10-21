export function formatBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const
  const index = Math.min(3, Math.max(0, Math.floor(Math.log10(Math.max(1, bytes)) / 3)))
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[index]!,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(bytes / 1000 ** index)
}

const latinFillers = /(?<![\p{L}\p{N}_'’])(?:um+|uh+|uhm|erm|er|hmm+|mm+)(?![\p{L}\p{N}_'’])/giu
const standaloneFillers =
  /(?<=^|[\s\p{P}])(?:[嗯呃额啊]|えー+と|えっと|ええと|えー+っと|えー+|あのー+|うー+ん|음+|어+|으+음)(?=$|[\s\p{P}])/gu
const leadingJapaneseFillers =
  /(?<=^|[\s\p{P}])(?:えー+と|えっと|ええと|えー+っと|あのー+|うー+ん)/gu
const repeatedWord = /\b([\p{L}'’]+)(?:\s+\1\b)+/giu

export function cleanTranscript(text: string, removeFillers: boolean): string {
  const stripped = text.replace(/^\s*language\s+[^<>\r\n]+<asr_text>\s*/i, '').trim()
  if (!removeFillers) return stripped
  const marked = stripped
    .replace(/(?<=\p{Script=Han})呃+(?=\p{Script=Han})/gu, '')
    .replace(/((?![哈呵嘿嘻谢])\p{Script=Han})\1{2,}/gu, '$1')
    .replace(repeatedWord, (whole: string, word: string) =>
      /^(?:had|that|is)$/i.test(word) ? whole : word,
    )
    .replace(latinFillers, '\0')
    .replace(standaloneFillers, '\0')
    .replace(leadingJapaneseFillers, '\0')
  if (marked === stripped) return stripped
  const cleaned = marked
    .replace(
      /([,，、。.!！?？;；:：])?[ \t]*\0(?:[ \t,，、;；:：]*\0)*[ \t]*([,，、。.!！?？;；:：])?/gu,
      (whole: string, before: string | undefined, after: string | undefined) => {
        const punctuation = before && /[。.!！?？]/u.test(before) ? before : (after ?? before)
        return punctuation ? punctuation + (/\s$/u.test(whole) ? ' ' : '') : ' '
      },
    )
    .replace(/^[\s,，、。.!！?？;；:：]+/u, '')
    .replace(/[,，、;；:：]\s*$/u, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(
      /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
      '',
    )
    .trim()
  return /^\p{Lu}/u.test(stripped)
    ? cleaned.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase())
    : cleaned
}

const separators = (text: string) => text.match(/[\s\-_.]/gu)?.length ?? 0

/** A vocabulary word the model spelled out or split, such as `G O D E` or `Agent Doc` for `Gode` or `agentdoc`,
 * becomes the word; one that differs only in case stays as said. */
export function applyVocabulary(text: string, vocabulary: readonly string[]): string {
  let result = text
  for (const word of vocabulary) {
    const letters = Array.from(word.matchAll(/[\p{L}\p{N}]/gu), (match) => match[0])
    if (letters.length < 3) continue
    const escaped = letters.map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escaped.join('[\\s\\-_.]*')}(?![\\p{L}\\p{N}])`,
      'giu',
    )
    result = result.replace(pattern, (found) =>
      separators(found) > separators(word) ? word : found,
    )
  }
  return result
}

export function transcriptionRequest(
  request: { audio: Uint8Array; vocabulary: readonly string[] },
  options: { model: string; language: string; apiKey?: string },
): RequestInit {
  const body = new FormData()
  body.set('file', new Blob([new Uint8Array(request.audio)], { type: 'audio/wav' }), 'audio.wav')
  body.set('model', options.model)
  if (options.language !== 'auto') body.set('language', options.language)
  if (request.vocabulary.length) body.set('prompt', request.vocabulary.join(', '))
  return {
    method: 'POST',
    body,
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
  }
}

export function apiURL(base: string, endpoint: string): string {
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Expected an HTTP or HTTPS API address')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`
  url.hash = ''
  url.search = ''
  return url.href
}

export async function responseJSON(response: Response): Promise<unknown> {
  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = null
  }
  if (!response.ok) {
    const data = value as { error?: { message?: string } | string; message?: string } | null
    const message =
      typeof data?.error === 'string' ? data.error : (data?.error?.message ?? data?.message)
    throw new Error(message || text.slice(0, 1000) || `HTTP ${response.status}`)
  }
  return value
}
