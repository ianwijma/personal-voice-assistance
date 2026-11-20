// The list of what is low or missing, shown with the answer of `stock_low` (docs/modules/kitchen.md, "On a screen").
// It shows exactly what the answer says and nothing more: the products the answer names, in its order, and its
// "and N more" and "I read the first 100" lines. It is plain (no ticks), transient and returned with the answer, so
// the host shows it when the turn is promoted and it ends by its lifetime; the module manages nothing afterwards.
// Household data, like the spoken answer; no recipe is ever shown, so the allergy rules have nothing to leave out.
import type { Presentation, Row } from "@pva/core"
import type { Language } from "@pva/language"
import { say } from "@pva/module-contracts"
import type { Product } from "./data.ts"
import { listText, LOW_SCAN } from "./pantry.ts"
import { texts } from "./texts.ts"

/** The most names the spoken answer lists (`listText`'s default): more than that, it names five and says how many more. */
export const ANSWER_NAMES = 6
const ITEM_CHARS = 80
const SPOKEN_CHARS = 300

/** At most `max` UTF-16 units of `text`, cut between characters (never inside a surrogate pair). */
export const cutText = (text: string, max: number): string => {
  if (text.length <= max) return text
  let out = ""
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

/** What the stock answer says of the low products: the same sentence whether it is spoken or only shown. */
export const lowSay = (rows: ReadonlyArray<Row<Product>>, cut: boolean, l: Language, max = ANSWER_NAMES): string => {
  const main = say(texts, l, "low", { list: listText(rows.map((r) => r.value.name), l, cut, max) })
  return cut ? `${main} ${say(texts, l, "lowCut", { count: LOW_SCAN })}` : main
}

/** The names the answer gives (all of them up to six; else the first five) and what it says of the rest. */
export const answerNames = (rows: ReadonlyArray<Row<Product>>, cut: boolean): { readonly shown: ReadonlyArray<Row<Product>>; readonly more: boolean } =>
  !cut && rows.length <= ANSWER_NAMES ? { shown: rows, more: false } : { shown: rows.slice(0, ANSWER_NAMES - 1), more: true }

/** The sentence the model says where nothing can be shown: the answer itself, with fewer names when it would be too long. */
const spokenOf = (rows: ReadonlyArray<Row<Product>>, cut: boolean, l: Language): string => {
  for (const max of [ANSWER_NAMES, 4, 2, 1]) {
    const s = lowSay(rows, cut, l, max)
    if (s.length <= SPOKEN_CHARS) return s
  }
  return cutText(lowSay(rows, cut, l, 1), SPOKEN_CHARS)
}

/**
 * The plain list for an answer that named these low products: the names the answer gave, in its order, then "and 25
 * more" (or "and more" when the read was cut) and the cut's own line, as the answer says them.
 */
export const lowPresentation = (rows: ReadonlyArray<Row<Product>>, cut: boolean, l: Language): Presentation => {
  const { shown, more } = answerNames(rows, cut)
  const items = shown.map((r, n) => ({ id: `p${n}`, text: cutText(r.value.name, ITEM_CHARS) }))
  if (more) {
    items.push({ id: "more", text: say(texts, l, cut ? "lowMoreCut" : "lowMore", { count: rows.length - shown.length }) })
  }
  if (cut) items.push({ id: "cut", text: say(texts, l, "lowCut", { count: LOW_SCAN }) })
  return { kind: "list", title: say(texts, l, "lowScreen"), style: "bullets", items, spoken: spokenOf(rows, cut, l) }
}
