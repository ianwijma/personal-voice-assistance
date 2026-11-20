// What the module shows on a screen (docs/PRESENTING.md): a card after something was remembered, with one button, and
// a list of what a recall or a notes list found. Pure builders: every text is cut at a code point boundary, by one
// function, and the module's own sentences come from `texts`. Nothing here decides who may see what: the module asks
// `Privacy.mayReveal` for the asking device when it answers, and the Presenter decides again for each device it shows on.
import type { Presentation } from "@pva/core"
import { isLine, say, StoredText } from "@pva/module-contracts"
import { Schema } from "effect"
import { texts } from "./texts.ts"
import { tidy } from "./words.ts"

type Lang = "en" | "nl"

/** The most items a list carries: the answer's own items, "and N more", the cut note and the withheld note fit 12. */
export const LIST_ITEM_CHARS = 80
export const CARD_TEXT_CHARS = 300
export const SPOKEN_CHARS = 300
/** The handler's name, and the card's button. */
export const UNDO_HANDLER = "memory_undo"
export const UNDO_BUTTON = "undo"
const CARD_KEY = "remembered:"

/** `text` cut to at most `max` UTF-16 units between whole code points, with "…" where it was cut. The one cut of this file. */
export const cutPoints = (text: string, max: number): string => {
  if (text.length <= max) return text
  let out = ""
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

/** Controls, line and paragraph separators and the bidirectional controls: what a one-line text refuses. */
const BIDI = [0x200e, 0x200f, ...Array.from({ length: 5 }, (_, i) => 0x202a + i), ...Array.from({ length: 4 }, (_, i) => 0x2066 + i)].map((c) => String.fromCodePoint(c)).join("")
const NOT_LINE = new RegExp(`[\\p{Cc}\\p{Zl}\\p{Zp}${BIDI}]`, "gu")

/** One line of at most `max`: separators and controls made spaces, then cut; `…` when nothing usable is left. */
export const lineText = (text: string, max: number): string => {
  const cleaned = tidy(text.replace(NOT_LINE, " "))
  const cut = cutPoints(cleaned, max)
  return cut !== "" && isLine(cut, max) ? cut : "…"
}

/** A card's text: line breaks stay; cut between code points. */
const blockText = (text: string, max: number): string => cutPoints(text, max)

/** The key of the card of one memory; `undefined` when the memory's id cannot be a key. */
export const cardKeyOf = (memoryId: string): string | undefined => {
  const key = `${CARD_KEY}${memoryId}`
  return /^[A-Za-z0-9_.:@/-]{1,64}$/.test(key) ? key : undefined
}
/** The memory a card key names. */
export const memoryOfKey = (key: string | undefined): string | undefined => (key !== undefined && key.startsWith(CARD_KEY) ? key.slice(CARD_KEY.length) : undefined)

const sensitivity = (owner: string | undefined) => (owner === undefined ? {} : { sensitivity: { personal: owner } })

/** "Remembered: …" with one button, Undo. `text` is the memory's own text. */
export const rememberedCard = (l: Lang, text: string, owner: string | undefined): Presentation => ({
  kind: "card",
  title: say(texts, l, "cardRemembered"),
  text: blockText(text, CARD_TEXT_CHARS),
  spoken: cutSpoken(say(texts, l, "cardRememberedSpoken", { text: lineText(text, 200) })),
  buttons: [{ id: UNDO_BUTTON, label: say(texts, l, "undo") }],
  handler: UNDO_HANDLER,
  ...sensitivity(owner)
})

/** What the card says after Undo: no button, and nothing of the text. */
export const forgottenCard = (l: Lang, owner: string | undefined): Presentation => ({
  kind: "card",
  title: say(texts, l, "cardForgotten"),
  text: say(texts, l, "cardBackups"),
  spoken: say(texts, l, "cardForgottenSpoken"),
  ...sensitivity(owner)
})

/** A spoken fallback is a whole sentence of at most 300: one that is longer is replaced by the short one, never sliced. */
const cutSpoken = (spoken: string): string => (spoken.length <= SPOKEN_CHARS && spoken.trim() !== "" ? spoken : "…")

const validSpoken = Schema.is(StoredText(SPOKEN_CHARS))
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
/**
 * The first candidate that is well-formed text within the Presenter's bound; failing that, the first one repaired (a split
 * character dropped, cut between code points); failing that, the last (a fixed sentence). The tool's own sentences are
 * never changed: only what the presentation says in their place.
 */
const spokenOf = (candidates: ReadonlyArray<string>): string => {
  const whole = candidates.find((c) => c.trim() !== "" && validSpoken(c))
  if (whole !== undefined) return whole
  for (const c of candidates) {
    const repaired = cutPoints(c.replace(LONE_SURROGATE, "").trim(), SPOKEN_CHARS)
    if (repaired.trim() !== "" && validSpoken(repaired)) return repaired
  }
  return candidates.at(-1)!
}

export interface ListInput {
  readonly title: "listFound" | "listNotes"
  /** The items the answer carries, newest first (at most `MAX_ITEMS`). */
  readonly items: ReadonlyArray<string>
  /** How many more matched than are listed. */
  readonly more: number
  /** A notes read: there are older notes than the list holds (never how many). */
  readonly olderNotes?: boolean
  /** The number of entries a cut scan read; absent when the scan was not cut. */
  readonly cutAt?: number
  /** Personal items were left out of this answer, for this device. */
  readonly withheld: boolean
  /** The owner, when an item is personal. */
  readonly owner?: string
  /** Candidate spoken fallbacks, the best first: the first that fits 300 is used. */
  readonly spokenCandidates: ReadonlyArray<string>
  readonly total: number
}

/** The list a recall or a notes read shows: what the answer said, its honest notes, and the sentence for a screenless device. */
export const listPresentation = (l: Lang, input: ListInput): Presentation => {
  const rows: Array<string> = input.items.map((t) => lineText(t, LIST_ITEM_CHARS))
  if (input.more > 0) rows.push(lineText(say(texts, l, "listMore", { count: input.more }), LIST_ITEM_CHARS))
  if (input.olderNotes === true) rows.push(lineText(say(texts, l, "olderNotes"), LIST_ITEM_CHARS))
  if (input.cutAt !== undefined) rows.push(lineText(say(texts, l, "listCut", { count: input.cutAt }), LIST_ITEM_CHARS))
  if (input.withheld) rows.push(lineText(say(texts, l, "listWithheld"), LIST_ITEM_CHARS))
  const spoken = spokenOf([...input.spokenCandidates, say(texts, l, "listSpoken", { count: input.total })])
  return {
    kind: "list",
    title: say(texts, l, input.title),
    style: "bullets",
    items: rows.slice(0, 12).map((text, i) => ({ id: `i${i + 1}`, text })),
    spoken,
    ...sensitivity(input.owner)
  }
}
