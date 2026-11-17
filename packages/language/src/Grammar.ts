import type { Tok } from "./Tokens.ts"

/**
 * The parsers' grammar core: every production returns every way it can read the tokens from a position (an all-parses parser), and a
 * phrase is read only by the readings that end exactly at its last token (`whole`). So a parser is a closed grammar by construction:
 * a word no production reads is never skipped, and nothing is answered from part of the phrase (review round 2 and 3, the closed
 * grammar rule). The grammars are small and the phrases short (at most `maxWords`), so plain backtracking is fast enough.
 */
export interface Input {
  readonly text: string
  readonly toks: ReadonlyArray<Tok>
  readonly norms: ReadonlyArray<string>
}
export interface Hit<T> {
  readonly value: T
  readonly next: number
}
export type P<T> = (input: Input, at: number) => ReadonlyArray<Hit<T>>

export const none: P<never> = () => []

/** The empty reading. */
export const empty = <T>(value: T): P<T> => (_input, at) => [{ value, next: at }]

/** One token, read by `f` (its normalised form, and the token itself). */
export const tok = <T>(f: (norm: string, t: Tok) => T | undefined): P<T> => (input, at) => {
  const t = input.toks[at]
  if (t === undefined) return []
  const v = f(t.norm, t)
  return v === undefined ? [] : [{ value: v, next: at + 1 }]
}

/** One token from a table (a null-prototype `Dict`, so "constructor" is in none). */
export const from = <T>(table: Readonly<Record<string, T | undefined>>): P<T> => tok((w) => (Object.prototype.hasOwnProperty.call(table, w) ? table[w] : undefined))

/** The words, in this order, as one: `words("in", "the", "morning")`. */
export const words = (...ws: ReadonlyArray<string>): P<string> => (input, at) => {
  for (let k = 0; k < ws.length; k++) if (input.norms[at + k] !== ws[k]) return []
  return [{ value: ws.join(" "), next: at + ws.length }]
}

/** One of the words. */
export const oneOf = (...ws: ReadonlyArray<string>): P<string> => {
  const set = new Set(ws)
  return tok((w) => (set.has(w) ? w : undefined))
}

export const map = <A, B>(p: P<A>, f: (a: A, input: Input, from: number, next: number) => B | undefined): P<B> => (input, at) => {
  const out: Array<Hit<B>> = []
  for (const h of p(input, at)) {
    const v = f(h.value, input, at, h.next)
    if (v !== undefined) out.push({ value: v, next: h.next })
  }
  return out
}

export const alt = <T>(...ps: ReadonlyArray<P<T>>): P<T> => (input, at) => ps.flatMap((p) => p(input, at))

export const opt = <T>(p: P<T>): P<T | undefined> => (input, at) => [{ value: undefined, next: at }, ...p(input, at)]

export const seq = <A extends ReadonlyArray<unknown>>(...ps: { readonly [K in keyof A]: P<A[K]> }): P<A> => (input, at) => {
  let partial: Array<{ values: Array<unknown>; next: number }> = [{ values: [], next: at }]
  for (const p of ps as ReadonlyArray<P<unknown>>) {
    const grown: Array<{ values: Array<unknown>; next: number }> = []
    for (const s of partial) for (const h of p(input, s.next)) grown.push({ values: [...s.values, h.value], next: h.next })
    if (grown.length === 0) return []
    partial = grown
  }
  return partial.map((s) => ({ value: s.values as unknown as A, next: s.next }))
}

/** One or more of `p`, `sep` between them, at most `max`: every length. */
export const many1 = <T>(p: P<T>, sep: P<unknown> = empty(undefined), max = 10): P<ReadonlyArray<T>> => (input, at) => {
  const out: Array<Hit<ReadonlyArray<T>>> = []
  let frontier: Array<Hit<ReadonlyArray<T>>> = p(input, at).map((h) => ({ value: [h.value], next: h.next }))
  while (frontier.length > 0) {
    out.push(...frontier)
    const grown: Array<Hit<ReadonlyArray<T>>> = []
    for (const f of frontier) {
      if (f.value.length >= max) continue
      for (const s of sep(input, f.next)) for (const h of p(input, s.next)) grown.push({ value: [...f.value, h.value], next: h.next })
    }
    frontier = grown
  }
  return out
}

export const lazy = <T>(f: () => P<T>): P<T> => {
  let p: P<T> | undefined
  return (input, at) => (p ??= f())(input, at)
}

/** The values of the readings of the whole input, each once (by `key`, default JSON). */
export const whole = <T>(p: P<T>, input: Input, key: (v: T) => string = (v) => JSON.stringify(v)): Array<T> => {
  const seen = new Map<string, T>()
  for (const h of p(input, 0)) if (h.next === input.toks.length && !seen.has(key(h.value))) seen.set(key(h.value), h.value)
  return [...seen.values()]
}
