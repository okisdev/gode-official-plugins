import { expect, test } from 'vitest'
import { countWords } from './stats'

test.each([
  ['今天用 Gode 写了 3 个 tests.', 9],
  ['你好世界', 4],
  ['ひらがな カタカナ', 8],
  ['こんにちは世界 Gode123', 8],
  ['안녕하세요 Gode', 6],
  ['한글'.normalize('NFD'), 2],
  ["don't l’esprit 'quoted' foo''bar", 5],
  ['café cafe\u0301 Привет мир العربية 123abc', 6],
  ['one-two_three.four / 42', 5],
  ['𠀀𠮷かな한abc123', 6],
  ['カレー・パン', 5],
  ['「」、。，！？… \t\n🙂', 0],
  ['', 0],
])('counts words in %j', (text, expected) => {
  expect(countWords(text)).toBe(expected)
})
