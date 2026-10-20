const stopwords = new Set(
  `a about above across after again against all almost along already also although always am among an and another any anyone anything are around as at away back be because been before being below between both but by call came can cannot come could day did do does doing done down during each either else end enough even ever every everyone everything far few find first for found from full get give go good got great had has have he help her here hers herself him himself his how however i if in into is it its itself just keep kind know last later least left less let like little long look made make many may me might more most much must my myself near need never new next no nobody none nor not nothing now of off often old on once one only or other our ours ourselves out over own part people perhaps place please put quite rather really right said same say see seem seen several she should show since so some someone something sometimes still such take than thank that the their theirs them themselves then there these they thing think this those though through time to today together too took toward try two under until up upon us use used using very want was way we well went were what when where whether which while who whom whose why will with within without work world would yes yet you young your yours yourself yourselves hello okay ok sure actually basically literally probably simply really maybe thanks please test tests word words thing things`.split(
    /\s+/u,
  ),
)

export function extractTerms(text: string, vocabulary: readonly string[]): string[] {
  const normalized = text.normalize('NFC')
  const existing = new Set(vocabulary.map((word) => word.normalize('NFC').trim().toLowerCase()))
  const mixed = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
    normalized,
  )
  const terms: string[] = []
  for (const match of normalized.matchAll(
    /[\p{Script=Latin}\d][\p{Script=Latin}\p{M}\d]*(?:[_.-][\p{Script=Latin}\d][\p{Script=Latin}\p{M}\d]*)*/gu,
  )) {
    const word = match[0]
    const key = word.toLowerCase()
    if (
      word.length > 200 ||
      !/\p{Script=Latin}/u.test(word) ||
      stopwords.has(key) ||
      existing.has(key)
    )
      continue
    const identifier = /[_.-]|\p{Ll}\p{Lu}|\p{Lu}{2}\p{Ll}/u.test(word) || /\d/u.test(word)
    const acronym = /^\p{Lu}{2,}$/u.test(word)
    const latinWord = /^[\p{Script=Latin}\p{M}]+$/u.test(word)
    if (
      identifier ||
      acronym ||
      (mixed && latinWord && (word.match(/\p{Script=Latin}/gu)?.length ?? 0) >= 3)
    )
      terms.push(word)
  }
  return terms
}
