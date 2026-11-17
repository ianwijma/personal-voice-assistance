// A small context-free grammar engine for the tests (review round 3, decision 6): a grammar is written here, in the tests, from the
// README, as data — rules of terminals and non-terminals with a semantic action each — and the engine both generates phrases from it
// (with the value each must mean, computed by the actions) and recognises a phrase (every value it can mean). It shares nothing with
// the package's parsers: they are combinators over the package's tokenizer, this is a table of productions over words split at
// spaces. A mutant of a generated phrase is "a phrase the generator could have produced" exactly when `recognise` finds it.
import type { Rng } from "./Rng.ts"

/**
 * A word as the README says words compare: no accents, lower case; an apostrophe inside a word is kept ("o'clock" is not "oclock", and
 * "tw'o" is not "two"), one at its start is the gap before Dutch "s" ("'s avonds").
 */
export const norm = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/’/g, "'").replace(/^'+/, "")

/** A terminal: reads one word (normalised) to a value, and writes one word. */
export interface Term {
  readonly read: (word: string) => unknown
  readonly write: (r: Rng) => string
}
/** A symbol that reads several words at once (a number), and writes them. */
export interface Multi {
  readonly readMany: (words: ReadonlyArray<string>, at: number) => ReadonlyArray<{ readonly value: unknown; readonly next: number }>
  readonly writeMany: (r: Rng) => ReadonlyArray<string>
}
/** A non-terminal's name, a terminal, or a several-word symbol. */
export type Sym = string | Term | Multi
const isMulti = (s: Sym): s is Multi => typeof s === "object" && "readMany" in s
export interface Rule {
  readonly rhs: ReadonlyArray<Sym>
  /** The value of the rule from the values of its symbols (a terminal's value is what `read` gave); `undefined` rejects the reading. */
  readonly act?: (v: ReadonlyArray<any>) => unknown
  /** How often generation picks it (default 1). */
  readonly weight?: number
}
export type Grammar = Readonly<Record<string, ReadonlyArray<Rule>>>

/** One word, as written. */
export const lit = (surface: string, value: unknown = surface): Term => {
  const n = norm(surface)
  return { read: (w) => (w === n ? value : undefined), write: () => surface }
}
/** One of several words: each reads as its value. */
export const oneOf = (table: Readonly<Record<string, unknown>>): Term => {
  const byNorm = new Map(Object.entries(table).map(([k, v]) => [norm(k), v]))
  const keys = Object.keys(table)
  return { read: (w) => byNorm.get(w), write: (r) => r.pick(keys) }
}
/** A run of words as one symbol each: `words("in the morning")`. */
export const words = (phrase: string): Array<Term> => phrase.split(" ").map((w) => lit(w))
/** A rule whose value is a constant. */
export const fixed = (rhs: ReadonlyArray<Sym>, value: unknown, weight?: number): Rule => ({ rhs, act: () => value, ...(weight !== undefined ? { weight } : {}) })

interface Hit {
  readonly value: unknown
  readonly next: number
}

/** Every value of a whole phrase (its words, normalised) read from `start`, each once. */
export const recognise = (g: Grammar, start: string, phrase: ReadonlyArray<string>): Array<unknown> => {
  const ws = phrase.map(norm)
  const seen = new Map<string, unknown>()
  for (const h of readFrom(g, start, ws, 0)) if (h.next === ws.length) seen.set(stable(h.value), h.value)
  return [...seen.values()]
}

const memos = new WeakMap<ReadonlyArray<string>, WeakMap<Grammar, Map<string, Array<Hit>>>>()
/** Every reading of `start` from word `at` of the (normalised) words, whatever its length; memoised per word list. */
export const readFrom = (g: Grammar, start: string, ws: ReadonlyArray<string>, at: number): ReadonlyArray<Hit> => {
  let byGrammar = memos.get(ws)
  if (byGrammar === undefined) { byGrammar = new WeakMap(); memos.set(ws, byGrammar) }
  let memo = byGrammar.get(g)
  if (memo === undefined) { memo = new Map(); byGrammar.set(g, memo) }
  const table = memo
  const parse = (name: string, at: number): Array<Hit> => {
    const key = `${name}@${at}`
    const cached = table.get(key)
    if (cached !== undefined) return cached
    table.set(key, [])
    const out: Array<Hit> = []
    for (const rule of g[name] ?? []) {
      let partial: Array<{ values: Array<unknown>; next: number }> = [{ values: [], next: at }]
      for (const sym of rule.rhs) {
        const grown: Array<{ values: Array<unknown>; next: number }> = []
        for (const p of partial) {
          if (typeof sym === "string") {
            for (const h of parse(sym, p.next)) grown.push({ values: [...p.values, h.value], next: h.next })
          } else if (isMulti(sym)) {
            for (const h of sym.readMany(ws, p.next)) grown.push({ values: [...p.values, h.value], next: h.next })
          } else if (p.next < ws.length) {
            const v = sym.read(ws[p.next]!)
            if (v !== undefined) grown.push({ values: [...p.values, v], next: p.next + 1 })
          }
        }
        partial = grown
        if (partial.length === 0) break
      }
      for (const p of partial) {
        const v = rule.act === undefined ? p.values[0] : rule.act(p.values)
        if (v !== undefined) out.push({ value: v, next: p.next })
      }
    }
    table.set(key, out)
    return out
  }
  return parse(start, at)
}

/** A phrase generated from `start`, with its value; `undefined` when no attempt produced one. */
export const generate = (g: Grammar, start: string, r: Rng, depth = 0): { words: Array<string>; value: unknown } | undefined => {
  const rules = g[start]
  if (rules === undefined || depth > 20) return undefined
  for (let attempt = 0; attempt < 30; attempt++) {
    const total = rules.reduce((n, x) => n + (x.weight ?? 1), 0)
    let pick = r.next() * total
    let rule = rules[0]!
    for (const x of rules) { pick -= x.weight ?? 1; if (pick <= 0) { rule = x; break } }
    const out: Array<string> = []
    const values: Array<unknown> = []
    let ok = true
    for (const sym of rule.rhs) {
      if (typeof sym === "string") {
        const sub = generate(g, sym, r, depth + 1)
        if (sub === undefined) { ok = false; break }
        out.push(...sub.words)
        values.push(sub.value)
      } else if (isMulti(sym)) {
        const ws = sym.writeMany(r)
        const hit = sym.readMany(ws.map(norm), 0).find((h) => h.next === ws.length)
        if (hit === undefined) throw new Error(`a symbol wrote words it does not read: ${ws.join(" ")}`)
        out.push(...ws)
        values.push(hit.value)
      } else {
        const w = sym.write(r)
        const v = sym.read(norm(w))
        if (v === undefined) throw new Error(`a terminal wrote a word it does not read: ${w}`)
        out.push(w)
        values.push(v)
      }
    }
    if (!ok) continue
    const value = rule.act === undefined ? values[0] : rule.act(values)
    if (value !== undefined) return { words: out, value }
  }
  return undefined
}

/** JSON with sorted keys: equal values give equal strings. */
export const stable = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x)

/** The words every mutation inserts (review round 3, decision 6): negations, bounds, conjunctions, other units, weekdays, numbers, other parsers' fillers, JavaScript property names. */
export const mutationWords: ReadonlyArray<string> = [
  "not", "no", "never", "niet", "geen", "before", "after", "until", "less", "than", "more", "least", "most", "over", "voor", "na", "tot", "minder", "dan", "meer",
  "and", "or", "en", "of", "but", "maar",
  "kg", "grams", "litre", "liter", "hours", "minutes", "days", "weeks", "uur", "minuten", "dagen", "cups", "x",
  "Monday", "Friday", "maandag", "vrijdag",
  "one", "two", "five", "5", "12", "twenty", "hundred", "een", "twee", "vijf", "twintig", "honderd", "half", "quarter", "kwart",
  "the", "a", "an", "on", "in", "at", "every", "de", "het", "op", "om", "elke", "please", "tomorrow", "morgen", "next", "volgende", "this", "deze", "van", "pm", "o'clock",
  "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype"
]

/**
 * Every mutant of a phrase: each word of `insert` at each position, each word deleted, each pair of neighbours swapped, and each word
 * of two or more letters with an apostrophe after its first letter and before its last ("tw'o", "tw'o" → refused unless the grammar has
 * that spelling: review round 4, finding 14).
 */
export const mutants = (phrase: ReadonlyArray<string>, insert: ReadonlyArray<string> = mutationWords): Array<Array<string>> => {
  const out: Array<Array<string>> = []
  for (let k = 0; k <= phrase.length; k++) for (const w of insert) out.push([...phrase.slice(0, k), w, ...phrase.slice(k)])
  for (let k = 0; k < phrase.length; k++) out.push([...phrase.slice(0, k), ...phrase.slice(k + 1)])
  for (let k = 0; k + 1 < phrase.length; k++) out.push([...phrase.slice(0, k), phrase[k + 1]!, phrase[k]!, ...phrase.slice(k + 2)])
  for (let k = 0; k < phrase.length; k++) {
    const w = phrase[k]!
    if (!/^\p{L}{2,}$/u.test(w)) continue
    for (const at of new Set([1, w.length - 1])) out.push([...phrase.slice(0, k), `${w.slice(0, at)}'${w.slice(at)}`, ...phrase.slice(k + 1)])
  }
  return out
}
