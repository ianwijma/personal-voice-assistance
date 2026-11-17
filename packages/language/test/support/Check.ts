// The two grammar-driven checks every parser gets (review round 3, decision 6).
import { generate, mutants, recognise, stable, type Grammar } from "./Cfg.ts"
import { rng } from "./Rng.ts"

export interface GrammarCheck {
  readonly grammar: Grammar
  readonly start: string
  /** What the grammar's values of a phrase mean, as one comparable answer ("not-understood" for none). */
  readonly expected: (values: ReadonlyArray<unknown>, words: ReadonlyArray<string>) => unknown
  /** What the parser answers for the text, in the same form. */
  readonly actual: (text: string) => unknown
}

const fail = (what: string, words: ReadonlyArray<string>, want: unknown, got: unknown): never => {
  throw new Error(`${what} "${words.join(" ")}": the grammar says ${stable(want)}, the parser ${stable(got)}`)
}

/** `count` phrases generated from the grammar parse to the value the grammar gives them. Returns how many were checked. */
export const generatedParse = (c: GrammarCheck, count: number, seed: number): number => {
  const r = rng(seed)
  let n = 0
  for (let k = 0; k < count; k++) {
    const p = generate(c.grammar, c.start, r)
    if (p === undefined) continue
    const want = c.expected(recognise(c.grammar, c.start, p.words), p.words)
    const got = c.actual(p.words.join(" "))
    if (stable(want) !== stable(got)) fail("generated", p.words, want, got)
    n++
  }
  return n
}

/**
 * Every mutant of `count` generated phrases (each word of the list inserted at every position, each word deleted, each pair of
 * neighbours swapped; `sample` of the insertions when given, deterministically) is refused, or is a phrase of the grammar and parses
 * to its value. Returns the number of mutants checked.
 */
export const mutantsParse = (c: GrammarCheck, count: number, seed: number, sample = 1): number => {
  const r = rng(seed)
  let n = 0
  for (let k = 0; k < count; k++) {
    const p = generate(c.grammar, c.start, r)
    if (p === undefined) continue
    for (const m of mutants(p.words)) {
      if (sample < 1 && m.length > p.words.length && !r.chance(sample)) continue
      const want = c.expected(recognise(c.grammar, c.start, m), m)
      const got = c.actual(m.join(" "))
      if (stable(want) !== stable(got)) fail("mutant", m, want, got)
      n++
    }
  }
  return n
}
