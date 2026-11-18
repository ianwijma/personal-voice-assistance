import { isLine, type Language, LISTS_LIMITS } from "@pva/module-contracts"
import { parseNumber, parseQuantity, speakAmount, type UnitId } from "@pva/language"
import { MAX_PER_REQUEST, MAX_REQUEST_CHARS, type Quantity } from "./data.ts"

/** How a request is split into items (the `splitItems` setting). */
export type SplitMode = "known" | "always" | "never"

/**
 * Names that hold "and" and are one thing (catalogue-aware splitting with a small built-in catalogue): "salt and
 * pepper crisps" stays one item, "salt and pepper" alone is two. Compared on lower-case words.
 */
const COMPOUNDS: ReadonlyArray<string> = [
  "salt and pepper crisps", "salt and vinegar crisps", "salt & vinegar crisps", "mac and cheese", "macaroni and cheese",
  "fish and chips", "sweet and sour sauce", "cookies and cream", "peanut butter and jelly", "bread and butter pickles",
  "oil and vinegar dressing", "zout en peper chips", "salt en peper chips", "zoet en zuur", "zoetzuur en pittig"
]

/** One item as said: its text and, when one was said, its quantity. */
export interface SaidItem {
  readonly text: string
  readonly quantity?: Quantity
}

export type Split =
  | { readonly kind: "ok"; readonly items: ReadonlyArray<SaidItem> }
  | { readonly kind: "empty" }
  | { readonly kind: "too-long" }
  | { readonly kind: "too-many" }

/** Commas and "and" between items, kept by `split` (the capture) so a quantity said across one can be put back together. */
const SEPARATORS = /(\s*[,;]\s*|\s+(?:and|en|plus|&)\s+)/i
/** More pieces than this before any are joined is more than a request may name, whatever joins: refused before parsing. */
const MAX_PIECES = 3 * MAX_PER_REQUEST
const LEADING_AND = /^(?:and|en|plus|&)\s+/i
const LEADING_ARTICLE: Record<Language, RegExp> = { en: /^(?:the|a|an)\s+/i, nl: /^(?:de|het|een)\s+/i }

/** Collapse spaces, trim, and drop the characters a line may not hold. Bounded by `MAX_REQUEST_CHARS`. */
const tidy = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * Split what was said into items: on commas and "and" (unless `mode` says otherwise, and never inside a known
 * compound), each with its quantity read by `@pva/language` ("two litres of oat milk" is oat milk, 2 l). Bounded:
 * at most `MAX_REQUEST_CHARS` characters in and `MAX_PER_REQUEST` items out, checked before the work is done, and the
 * work is linear in the text.
 */
export const splitItems = (raw: string, lang: Language, mode: SplitMode): Split => {
  if (raw.length > MAX_REQUEST_CHARS) return { kind: "too-long" }
  const text = tidy(raw)
  if (text === "") return { kind: "empty" }
  let parts: Array<string>
  if (mode === "never") parts = [text]
  else {
    // Protect the compounds: their "and" becomes a placeholder no separator matches.
    let protectedText = text
    if (mode === "known") {
      const lower = protectedText.toLowerCase()
      for (const c of COMPOUNDS) {
        let at = lower.indexOf(c)
        while (at >= 0) {
          const before = at === 0 || /\s|,/.test(lower[at - 1]!)
          const end = at + c.length
          const after = end === lower.length || /\s|,|;/.test(lower[end]!)
          if (before && after) {
            const segment = protectedText.slice(at, end).replace(/\s(and|en|&)\s/gi, (m) => m.replace(/\s/g, "\u0000"))
            protectedText = protectedText.slice(0, at) + segment + protectedText.slice(end)
          }
          at = lower.indexOf(c, end)
        }
      }
    }
    const pieces = protectedText.split(SEPARATORS).map((p) => p.replace(/\u0000/g, " "))
    if (pieces.length > 2 * MAX_PIECES) return { kind: "too-many" }
    parts = joinAmounts(pieces, lang).map((p) => p.replace(LEADING_AND, "").trim()).filter((p) => p !== "" && !/^(?:and|en|plus|&)$/i.test(p))
  }
  if (parts.length === 0) return { kind: "empty" }
  if (parts.length > MAX_PER_REQUEST) return { kind: "too-many" }
  const out: Array<SaidItem> = []
  for (const part of parts) {
    const item = readItem(part, lang)
    if (item === undefined) return { kind: "too-long" }
    out.push(item)
  }
  return { kind: "ok", items: out }
}

/** The most words of the next piece a quantity said across a separator may reach into ("a half litres of"). */
const JOIN_WORDS = 6

/**
 * Pieces split on commas and "and" (separators at the odd places), joined again where a quantity is said across a
 * separator: "1,5 liter melk" (a decimal comma), "two and a half litres", "one hundred and twenty grams", "twee en een
 * halve kilo". Only a piece that is a number by itself ("two", "one hundred", "1") can be the start of one; it is
 * joined when `@pva/language` reads a quantity in it and the first one to `JOIN_WORDS` words of the next piece
 * together, reaching past the separator. Bounded: at most `2 * MAX_PIECES` pieces, one number parse of a piece and at
 * most `JOIN_WORDS` parses of a short text per separator.
 */
const joinAmounts = (pieces: ReadonlyArray<string>, lang: Language): Array<string> => {
  const out: Array<string> = []
  let current = pieces[0] ?? ""
  for (let i = 1; i < pieces.length; i += 2) {
    const separator = pieces[i]!
    const next = pieces[i + 1] ?? ""
    const head = current.replace(LEADING_AND, "").trim()
    const words = next.trim().split(" ").filter((w) => w !== "")
    let joins = false
    const number = head !== "" && head.length <= 60 && parseNumber(head, lang).kind === "ok"
    for (let k = 1; number && k <= Math.min(JOIN_WORDS, words.length) && !joins; k++) {
      const candidate = head + separator + words.slice(0, k).join(" ")
      const q = parseQuantity(candidate, lang)
      const said = q.kind === "ok" ? q.value.said : ""
      joins = said.length > head.length && candidate.toLowerCase().startsWith(said.toLowerCase())
    }
    if (joins) current = current + separator + next
    else {
      out.push(current)
      current = next
    }
  }
  out.push(current)
  return out
}

/** One part: its quantity when `@pva/language` reads one, else the text without a leading article. */
export const readItem = (part: string, lang: Language): SaidItem | undefined => {
  const q = parseQuantity(part, lang)
  let text = part
  let quantity: Quantity | undefined
  if (q.kind === "ok" && q.value.item !== "" && q.value.rest === false) {
    text = q.value.item
    const amount = q.value.amount
    if (amount !== undefined && amount > 0 && amount <= LISTS_LIMITS.maxAmount) {
      quantity = q.value.unit === undefined || q.value.unit === "piece" ? { amount } : { amount, unit: q.value.unit }
    }
  } else text = part.replace(LEADING_ARTICLE[lang], "")
  text = tidy(text)
  if (text === "" || !isLine(text, LISTS_LIMITS.textChars)) return undefined
  return quantity === undefined ? { text } : { text, quantity }
}

const UNITS: ReadonlySet<string> = new Set<UnitId>([
  "g", "kg", "oz", "lb", "ml", "cl", "dl", "l", "tsp", "tbsp", "cup", "pack", "bag", "bottle", "can", "jar", "bunch", "loaf", "box", "tub", "roll", "piece", "handful",
  "pinch", "splash"
])

/** An item as it is said: "2 litres of oat milk", "3 eggs", "milk"; a unit `@pva/language` does not know is said as given. */
export const sayItem = (text: string, quantity: Quantity | undefined, lang: Language): string => {
  if (quantity === undefined) return text
  const unit = quantity.unit
  if (unit === undefined || UNITS.has(unit)) {
    const spoken = speakAmount({ amount: quantity.amount, ...(unit !== undefined ? { unit: unit as UnitId } : {}) }, lang, { item: text })
    if (spoken !== undefined) return spoken
  }
  const amount = Number.isInteger(quantity.amount) ? String(quantity.amount) : String(Number(quantity.amount.toPrecision(6))).replace(".", lang === "nl" ? "," : ".")
  return unit === undefined ? `${amount} ${text}` : `${amount} ${unit} ${text}`
}

/** What a trailing list name said: the list, whether it was said as the speaker's own ("my", "mijn"), or a list there is not. */
export interface ListSuffix {
  readonly text: string
  readonly list?: string
  /** "to my to-do list": there are no personal lists, so the household's list is meant, and the answer says so. */
  readonly mine?: boolean
  /** "to the camping list" when there is no such list: its name as said, to refuse in the household's language. */
  readonly unknown?: string
}

const ARTICLE_WORDS = new Set(["the", "a", "an", "my", "our", "de", "het", "een", "mijn", "ons", "onze"])

/**
 * The name in words that are said the way a list is named, though no list has it: one to three words and "list"
 * ("the camping list"), "lijst" and one to three words ("de lijst kamperen"), or one word ending in "lijst"
 * ("kampeerlijst"). An article inside ("write the shopping list") is not a list's name. `undefined` otherwise.
 */
const listNameSaid = (words: ReadonlyArray<string>): string | undefined => {
  if (words.length === 0 || words.length > 4 || words.some((w) => ARTICLE_WORDS.has(w.toLowerCase()))) return undefined
  const last = words.at(-1)!.toLowerCase()
  const first = words[0]!.toLowerCase()
  if (words.length >= 2 && (last === "list" || last === "lijst" || last === "lijstje")) return words.slice(0, -1).join(" ")
  if (words.length >= 2 && (first === "lijst" || first === "lijstje")) return words.slice(1).join(" ")
  if (words.length === 1 && /^\p{L}{2,}lijst(je)?$/iu.test(last)) return words[0]
  return undefined
}

/**
 * A trailing "to the shopping list", "on the camping list", "op de boodschappenlijst", "van de lijst af": the list a
 * request named in its own words (the typed path hands the whole rest of the sentence over). `resolve` says whether
 * the words name a list; the first marker from the end that does wins. One that is said the way a list is named but
 * names no list is `unknown`: never item text. Linear in the text.
 */
export const takeListSuffix = (text: string, markers: ReadonlyArray<string>, resolve: (words: string) => string | undefined): ListSuffix => {
  const words = text.split(" ")
  const marks = new Set(markers)
  for (let i = words.length - 2; i >= 1; i--) {
    if (!marks.has(words[i]!.toLowerCase())) continue
    let tail = words.slice(i + 1).join(" ").replace(/\s+(?:toe|af|gezet|zetten)$/i, "")
    const mine = /^(?:my|mijn)\s+/i.test(tail)
    tail = tail.replace(/^(?:the|my|our|de|het|mijn|ons|onze)\s+/i, "")
    const list = resolve(tail)
    const before = words.slice(0, i).join(" ")
    if (list !== undefined) return { text: before, list, ...(mine ? { mine } : {}) }
    const unknown = listNameSaid(tail.split(" ").filter((w) => w !== ""))
    if (unknown !== undefined) return { text: before, unknown }
  }
  return { text }
}

/** Amounts added up to 12 significant digits (no float noise), as `@pva/language` keeps them. */
export const addAmounts = (a: number, b: number) => Number((a + b).toPrecision(12))
