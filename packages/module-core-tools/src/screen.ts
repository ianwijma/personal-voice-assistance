// What the two modules that show something share: one text cut for the screen. Limits of a presentation are in UTF-16
// units (`docs/PRESENTING.md`), so the cut is made inside the limit and never between the halves of a pair (an emoji).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** `text` within `max` units: when it is longer, it ends with "…" at a code point boundary inside the limit. */
/** The first `n` units of `text`, ending before a pair's first half rather than between its halves. */
export const sliceAt = (text: string, n: number): string => {
  if (text.length <= n) return text
  const last = text.charCodeAt(n - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n)
}

export const cutFor = (text: string, max: number): string => {
  if (text.length <= max) return text
  return `${sliceAt(text, max - 1).replace(LONE_SURROGATE, "").trimEnd()}…`
}

/** The bounds of a presentation this package fills (docs/PRESENTING.md, "The kinds and their bounds"). */
export const SCREEN = { title: 60, cardText: 300, factValue: 60, listItem: 80, spoken: 300 } as const
