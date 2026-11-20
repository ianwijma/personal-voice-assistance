/**
 * Text that goes on a screen (docs/PRESENTING.md, "The kinds and their bounds"): cut at a code point boundary inside
 * the limit, one function for every presentation of this module, so a title ending in an emoji at the limit is still a
 * valid presentation (limits count UTF-16 units, as the presentation checks do).
 */

const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/gu
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** One line of text from outside: control characters, line breaks and bidirectional overrides become spaces, runs of spaces one. */
export const oneLine = (text: string): string => text.replace(NOT_ONE_LINE, " ").replace(LONE_SURROGATE, "�").replace(/ {2,}/g, " ").trim()

/**
 * At most `max` UTF-16 units, cut between whole code points. With `mark`, a cut text ends in "…" (inside the limit);
 * otherwise it is cut as it is. Text that fits is returned as it is.
 */
export const cutPoints = (text: string, max: number, mark = false): string => {
  if (text.length <= max) return text
  const budget = mark ? max - 1 : max
  let out = ""
  for (const point of text) {
    if (out.length + point.length > budget) break
    out += point
  }
  return mark ? `${out.trimEnd()}…` : out
}
