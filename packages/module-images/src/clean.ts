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

/** Whether `cleanText` cut the text: the plain text was longer than `max`. */
export interface Cleaned {
  readonly text: string
  readonly cut: boolean
}

/**
 * Text from outside as one short plain line: markup and control characters gone, spaces collapsed, cut at `max` with an
 * ellipsis, and whether it was cut. The work is bounded first: nothing here costs more than a few thousand characters.
 */
export const cleanLine = (value: unknown, max: number): Cleaned => {
  if (typeof value !== "string") return { text: "", cut: false }
  const bounded = value.slice(0, max * 6 + 200)
  const plain = decodeEntities(bounded.replace(TAG, " ")).replace(UNWANTED, " ").replace(/\s+/g, " ").trim()
  // Text that was longer than the bound before cleaning may be short after it; it is cut when either happened.
  const cutBefore = value.length > bounded.length
  if (plain.length <= max) return { text: cutBefore ? `${plain.slice(0, Math.max(0, max - 1)).trimEnd()}…` : plain, cut: cutBefore }
  return { text: `${plain.slice(0, Math.max(0, max - 1)).trimEnd()}…`, cut: true }
}

export const cleanText = (value: unknown, max: number): string => cleanLine(value, max).text

/** A string of at most `max` characters, cut with an ellipsis (already plain). */
export const cutAt = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`)
