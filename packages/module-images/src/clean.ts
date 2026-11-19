// Text from the network as one short plain line. Pure and free of dependencies.

const TAG = /<[^>]*>/g
const ENTITY = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp);/gi
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
// Control characters, lone surrogates, line and paragraph separators and bidirectional controls: never kept.
const UNWANTED = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ud800-\\udfff]", "gu")

const decodeEntities = (s: string): string =>
  s.replace(ENTITY, (_, e: string) => {
    if (e.startsWith("#")) {
      const code = e[1]!.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isInteger(code) && code > 31 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " "
    }
    return NAMED[e.toLowerCase()] ?? " "
  })

/**
 * A string of at most `max` UTF-16 units, cut with an ellipsis at a code-point boundary: a surrogate pair is never split, so
 * the result is always well-formed text.
 */
export const cutAt = (text: string, max: number): string => {
  if (text.length <= max) return text
  let end = Math.max(0, max - 1)
  const before = text.charCodeAt(end - 1)
  const after = text.charCodeAt(end)
  if (end > 0 && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--
  return `${text.slice(0, end).trimEnd()}\u2026`
}

/** Plain text and whether it was cut. */
export interface Cleaned {
  readonly text: string
  readonly cut: boolean
}

/**
 * The one function every string from the two sites passes: markup and control characters gone, spaces collapsed, one line, cut
 * at `max` code units with an ellipsis (never inside a character), and whether it was cut. The work is bounded first: nothing
 * here costs more than a few thousand characters.
 */
export const cleanLine = (value: unknown, max: number): Cleaned => {
  if (typeof value !== "string") return { text: "", cut: false }
  const bounded = value.slice(0, max * 6 + 200)
  const plain = decodeEntities(bounded.replace(TAG, " ")).replace(UNWANTED, " ").replace(/\s+/g, " ").trim()
  // Longer than the bound before cleaning: cut, even if what is left is short.
  const cutBefore = value.length > bounded.length
  if (plain.length > max) return { text: cutAt(plain, max), cut: true }
  if (!cutBefore) return { text: plain, cut: false }
  return { text: plain.length < max ? `${plain}\u2026` : cutAt(`${plain}\u2026`, max), cut: true }
}

export const cleanText = (value: unknown, max: number): string => cleanLine(value, max).text

/** Characters MediaWiki titles cannot hold, and the ones this module never passes on: an identifier with one is not a name. */
const NOT_A_NAME = /[<>\[\]{}|#\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u

/**
 * A page title or file name as the API gave it, unchanged, to be used in the next request: the string itself when it is a
 * plausible name (1 to `max` characters, trimmed, no markup or control characters), else `undefined`. Never cut, never cleaned:
 * a name that cannot be used as it is, is not used.
 */
export const identityOf = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length >= 1 && value.length <= max && value === value.trim() && !NOT_A_NAME.test(value) ? value : undefined
