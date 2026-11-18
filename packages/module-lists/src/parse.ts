import { isLine, type Language, LISTS_LIMITS } from "@pva/module-contracts"
import { parseQuantity, speakAmount, type UnitId } from "@pva/language"
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

const SEPARATORS = /\s*[,;]\s*|\s+(?:and|en|plus|&)\s+/i
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
    parts = protectedText.split(SEPARATORS).map((p) => p.replace(LEADING_AND, "").replace(/\u0000/g, " ").trim()).filter((p) => p !== "" && !/^(?:and|en|plus|&)$/i.test(p))
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

/**
 * A trailing "to the shopping list", "on the camping list", "op de boodschappenlijst", "van de lijst af": the list a
 * request named in its own words (the typed path hands the whole rest of the sentence over). `resolve` says whether
 * the words name a list; the first marker from the end that does wins. Linear in the text.
 */
export const takeListSuffix = (
  text: string,
  markers: ReadonlyArray<string>,
  resolve: (words: string) => string | undefined
): { readonly text: string; readonly list?: string } => {
  const words = text.split(" ")
  const marks = new Set(markers)
  for (let i = words.length - 2; i >= 1; i--) {
    if (!marks.has(words[i]!.toLowerCase())) continue
    const tail = words.slice(i + 1).join(" ").replace(/\s+(?:toe|af|gezet|zetten)$/i, "").replace(/^(?:the|my|de|het|mijn)\s+/i, "")
    const list = resolve(tail)
    if (list !== undefined) return { text: words.slice(0, i).join(" "), list }
  }
  return { text }
}

/** Amounts added up to 12 significant digits (no float noise), as `@pva/language` keeps them. */
export const addAmounts = (a: number, b: number) => Number((a + b).toPrecision(12))
