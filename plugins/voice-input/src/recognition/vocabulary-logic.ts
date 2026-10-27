const word = /[\p{Script=Latin}\p{N}]+/gu

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    previous = current
  }
  return previous[b.length]!
}

/** Whether `heard` reads as a mishearing of `meant`, as `cloud` of `claude`. */
function soundsLike(heard: string, meant: string): boolean {
  return (
    Math.min(heard.length, meant.length) >= 3 &&
    heard[0] === meant[0] &&
    distance(heard, meant) <= Math.floor(Math.max(heard.length, meant.length) / 2)
  )
}

/** A vocabulary word the model spelled out, split or joined differently, such as `G O D E`, `Agent Doc` or
 * `assistant UI` for `Gode`, `agentdoc` or `assistant-ui`, becomes the word; one that differs only in case stays
 * as said. */
function joinSpelled(text: string, term: string): string {
  const letters = Array.from(term.matchAll(/[\p{L}\p{N}]/gu), (match) => match[0])
  if (letters.length < 3) return text
  const escaped = letters.map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped.join('[\\s\\-_.]*')}(?![\\p{L}\\p{N}])`,
    'giu',
  )
  return text.replace(pattern, (found) =>
    found.toLowerCase() === term.toLowerCase() ? found : term,
  )
}

/** A vocabulary term of several words heard with some of them as similar words, such as `Cloud Code` for
 * `Claude Code`, becomes the term when at least one of its words was heard as written, so that a word said on its
 * own, such as `cloud`, stays. */
function restoreSoundAlikes(text: string, term: string): string {
  const meant = term.trim().split(/\s+/u)
  if (meant.length < 2 || meant.some((part) => !new RegExp(`^${word.source}$`, 'u').test(part)))
    return text
  const wanted = meant.map((part) => part.toLowerCase())
  const heard = Array.from(text.matchAll(word), (match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
  let result = ''
  let offset = 0
  for (let index = 0; index + meant.length <= heard.length; index++) {
    const window = heard.slice(index, index + meant.length)
    if (window[0]!.start < offset) continue
    const spaced = window
      .slice(1)
      .every((part, position) => /^[ \t]+$/u.test(text.slice(window[position]!.end, part.start)))
    if (!spaced) continue
    const said = window.map((part) => part.text.toLowerCase())
    const exact = said.filter((part, position) => part === wanted[position]).length
    const similar = said.filter(
      (part, position) => part !== wanted[position] && soundsLike(part, wanted[position]!),
    ).length
    if (exact === 0 || similar === 0 || exact + similar < meant.length) continue
    result += text.slice(offset, window[0]!.start) + meant.join(' ')
    offset = window.at(-1)!.end
  }
  return result + text.slice(offset)
}

/** Writes the person's vocabulary as given where recognition spelled a term out, split it or heard part of a
 * longer term as a similar word. */
export function applyVocabulary(text: string, vocabulary: readonly string[]): string {
  let result = text
  for (const term of vocabulary) result = restoreSoundAlikes(joinSpelled(result, term), term)
  return result
}
