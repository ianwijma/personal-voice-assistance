/**
 * Phone-lexicon encoder for the bilingual phone model (`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`), whose
 * English tokens are CMUdict ARPAbet phones with stress (`HH EY1 JH EH1 F`), looked up in the model's `en.phone`
 * (`WORD PH1 PH2 …` per line, 126 k words). Words that are not in it can be given in `overrides`; "jev" is built in.
 */

/** Words this project needs that CMUdict lacks. "Jev" (/dʒɛv/) is the assistant's name. */
export const builtinOverrides: Readonly<Record<string, ReadonlyArray<string>>> = { JEV: ["JH", "EH1", "V"] }

export type Lexicon = ReadonlyMap<string, ReadonlyArray<string>>

/** Parse `en.phone`. The first pronunciation of a word wins. */
export const parseLexicon = (text: string): Lexicon => {
  const map = new Map<string, ReadonlyArray<string>>()
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    const word = parts[0]
    if (word === undefined || word === "" || parts.length < 2) continue
    const key = word.toUpperCase()
    if (!map.has(key)) map.set(key, parts.slice(1))
  }
  return map
}

export class OovError extends Error {
  readonly words: ReadonlyArray<string>
  constructor(words: ReadonlyArray<string>) {
    super(`Not in the lexicon: ${words.join(", ")} (give their phones as an override)`)
    this.words = words
  }
}

/** Words → phones. Throws `OovError` naming every word it cannot find. */
export const phones = (
  lexicon: Lexicon,
  words: ReadonlyArray<string>,
  overrides: Readonly<Record<string, ReadonlyArray<string>>> = {}
): Array<string> => {
  const upperOverrides = new Map(Object.entries({ ...builtinOverrides, ...overrides }).map(([k, v]) => [k.toUpperCase(), v]))
  const out: Array<string> = []
  const missing: Array<string> = []
  for (const w of words) {
    const p = upperOverrides.get(w) ?? lexicon.get(w)
    if (p === undefined) missing.push(w)
    else out.push(...p)
  }
  if (missing.length > 0) throw new OovError(missing)
  return out
}
