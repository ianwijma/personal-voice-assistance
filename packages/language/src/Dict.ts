/**
 * Word tables. Every table that is looked up with a word from the text is a null-prototype object, so a word that happens to
 * be the name of an inherited property ("constructor", "toString", "__proto__") is simply not in it: indexing returns
 * `undefined` and `in` is false (review round 1, finding 6). Build every such table with `dict`.
 */
export type Dict<T> = Readonly<Record<string, T | undefined>>

export const dict = <T>(entries: Readonly<Record<string, T>>): Dict<T> => {
  const out = Object.create(null) as Record<string, T>
  for (const key of Object.keys(entries)) out[key] = entries[key]!
  return Object.freeze(out)
}

/** A table per language, each built with `dict`. */
export const dicts = <L extends string, T>(byLanguage: Readonly<Record<L, Readonly<Record<string, T>>>>): Readonly<Record<L, Dict<T>>> => {
  const out = {} as Record<L, Dict<T>>
  for (const key of Object.keys(byLanguage) as Array<L>) out[key] = dict(byLanguage[key])
  return out
}
