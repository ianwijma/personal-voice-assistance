/** One word of spoken or typed text: lower case, no accents, no apostrophes, with its place in the original. */
export interface Tok {
  readonly norm: string
  readonly start: number
  readonly end: number
}

const pattern = /\d+(?:[:.,]\d+)*|\p{L}+(?:['’]\p{L}+)*|%/gu

export const stripMarks = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "")

/** Split text into tokens. "7:30", "2,5" and "250" stay whole; "7pm" is "7" "pm"; "p.m." is "pm"; "'s avonds" is "s" "avonds". */
export const tokenize = (text: string): Array<Tok> => {
  const out: Array<Tok> = []
  for (const m of text.matchAll(pattern)) {
    const norm = stripMarks(m[0]).toLowerCase().replace(/['’]/g, "")
    if (norm.length === 0) continue
    out.push({ norm, start: m.index, end: m.index + m[0].length })
  }
  // "a.m." / "p.m." → "am" / "pm"
  const merged: Array<Tok> = []
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!
    const n = out[i + 1]
    if ((t.norm === "a" || t.norm === "p") && n !== undefined && n.norm === "m" && /^\.\s?$/.test(text.slice(t.end, n.start)) && text[t.start + 1] === ".") {
      merged.push({ norm: t.norm + "m", start: t.start, end: n.end })
      i++
    } else if (/^\d{1,2}$/.test(t.norm) && n !== undefined && n.start === t.end && /^(st|nd|rd|th|e|de|ste)$/.test(n.norm)) {
      // "3rd", "3e"
      merged.push({ norm: t.norm + n.norm, start: t.start, end: n.end })
      i++
    } else merged.push(t)
  }
  return merged
}

/** The words `[from, to)` as they were written. */
export const sliceText = (text: string, toks: ReadonlyArray<Tok>, from: number, to: number): string =>
  to > from ? text.slice(toks[from]!.start, toks[to - 1]!.end) : ""

export const isDigits = (s: string): boolean => /^\d+$/.test(s)
