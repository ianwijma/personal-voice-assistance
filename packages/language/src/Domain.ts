import type { Language } from "./Result.ts"

/**
 * The domain every exported function checks before it does anything else (review round 3, decision 1). Outside it a parser answers
 * `not-understood`, a speaker `undefined` ("cannot say this"), a rule reader `invalid` or `unsupported`; nothing throws. The README's
 * domain table lists these per function.
 */

/** The two languages. */
export const languages: ReadonlyArray<Language> = ["en", "nl"]
export const isLanguage = (x: unknown): x is Language => x === "en" || x === "nl"

/** The longest phrase a parser reads, in characters, and its most words. */
export const maxTextLength = 200
export const maxWords = 40

/**
 * The supported years: every date this package reads, computes or returns is a local date in these years, and `now` must be an
 * instant whose local date is in them. A result that would fall outside is refused, never moved into them (decision 2).
 */
export const minYear = 2000
export const maxYear = 2199

/**
 * Numbers read and said: whole part at most this, at most `numberDecimals` decimals (0.01 is the finest step). Two, not three: in
 * digits, one separator followed by three digits is the other language's thousands ("1.000" is a thousand in Dutch), so it is no
 * number in this one rather than a misread one.
 */
export const maxNumber = 999_999
export const numberDecimals = 2

/** The longest duration `parseDuration` reads and `speakDuration` says: 365 days. */
export const maxDurationMs = 365 * 86_400_000

/** A text argument: a string of at most `maxTextLength` characters. */
export const isText = (x: unknown): x is string => typeof x === "string" && x.length <= maxTextLength

/** An options argument: absent, or an object (not null, not an array). */
export const isOptions = (x: unknown): boolean =>
  x === undefined || (typeof x === "object" && x !== null && !Array.isArray(x))


/**
 * Exported functions run behind this net as well as their own checks: an exception that escapes a check is a bug, so it is counted
 * (the domain fuzz test asserts the count stays 0) and the function answers its failure value instead of throwing.
 */
export const escaped = { count: 0, last: undefined as unknown }
export const guarded = <A extends ReadonlyArray<unknown>, R>(f: (...args: A) => R, failure: R): ((...args: A) => R) =>
  (...args: A): R => {
    try {
      return f(...args)
    } catch (e) {
      escaped.count++
      escaped.last = e
      return failure
    }
  }
