import { defineCollection, maxListRows, type Row } from "@pva/core"
import { type Language, LISTS_LIMITS, type ListItem, say, StoredText } from "@pva/module-contracts"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { texts } from "./texts.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Bounds

/** The ids of the two lists every household has (their rows are made when the module starts). */
export const SHOPPING = "shopping"
export const TODO = "todo"

/** Open items per list: the contract's bound for the shopping list, kept for every list. */
export const MAX_OPEN = LISTS_LIMITS.openItems
/**
 * List rows that may exist at once, the two default ones included (they exist from the module's start); deleted lists
 * waiting for their undo window count too. One read of the `lists` collection takes them all.
 */
export const MAX_LISTS = 50
/** Lists that are not deleted, the two default ones included. */
export const MAX_LIVE_LISTS = 30
/** A list's own name. */
export const NAME_CHARS = 40
/** The most items one request names ("milk, eggs and rice" is three). */
export const MAX_PER_REQUEST = 12
/** The longest text one request may hand in for splitting; a longer one is refused before any work is done. */
export const MAX_REQUEST_CHARS = 2_000
/** The most ticked-off items one "clear" takes off (one undo entry); saying it again takes the next ones. */
export const MAX_CLEAR = 40
/** How long a change can be undone, and so how long removed items and deleted lists are kept. */
export const UNDO_WINDOW_MS = 24 * 3_600_000

const EPOCH_MS = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
/** A row id: the store's (a UUID) or one of the default lists' ids. */
export const ROW_ID = StoredText(40).check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,40}$/))

/** An amount with a unit (a `@pva/language` unit id, or a word from another module), or a count without one. */
export const Quantity = Schema.Struct({
  amount: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(LISTS_LIMITS.maxAmount)),
  unit: Schema.optionalKey(StoredText(LISTS_LIMITS.unitChars))
})
export type Quantity = typeof Quantity.Type

// ---------------------------------------------------------------------------------------------------------------------
// Lists

/** One list. Its open and ticked-off counts are kept on it, in the same transaction as every change of its items. */
export const ListRow = Schema.Struct({
  /** Absent for the two default lists, whose names are said in the household's language ("the shopping list"). */
  name: Schema.optionalKey(StoredText(NAME_CHARS)),
  kind: Schema.Literals(["shopping", "todo", "generic"]),
  open: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_OPEN })),
  done: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 })),
  /** Set when it was deleted: hidden, and removed with its items once the undo window has passed. */
  deletedAt: Schema.optionalKey(EPOCH_MS)
})
export type ListRow = typeof ListRow.Type

export const lists = defineCollection({
  name: "lists",
  scope: "household",
  schema: ListRow,
  // The worst legal list is 167 characters of JSON (checkModule computes it): one read takes all MAX_LISTS.
  maxChars: 200
})

// ---------------------------------------------------------------------------------------------------------------------
// Items

export const ItemStatus = Schema.Literals(["open", "done", "removed"])
export type ItemStatus = typeof ItemStatus.Type

/**
 * One item of one list. Household data: lists are seen on every device, and nothing in a row names a person.
 * `removed` items are kept for the undo window and then removed for good by the daily job.
 */
export const Item = Schema.Struct({
  list: ROW_ID,
  text: StoredText(LISTS_LIMITS.textChars),
  quantity: Schema.optionalKey(Quantity),
  note: Schema.optionalKey(StoredText(LISTS_LIMITS.noteChars)),
  status: ItemStatus,
  /** `<list>:<status>`, indexed with `since`: one list's open (or ticked-off, or removed) items in order. */
  place: StoredText(48),
  /** When it entered its status (added, ticked off, removed): epoch ms. */
  since: EPOCH_MS,
  /**
   * `<hash>:<status>`: a hash of the list and the normalised text, and the status, indexed with `since`. "Milk" said
   * again finds the open milk first as one indexed read, however many ticked-off ones there are.
   */
  match: StoredText(40),
  /** The key another module gave it (`Lists.addItem`); at most one item that is not removed has it. */
  dedupeKey: Schema.optionalKey(StoredText(LISTS_LIMITS.keyChars))
})
export type Item = typeof Item.Type

export const items = defineCollection({
  name: "items",
  scope: "household",
  schema: Item,
  // The worst legal item is 1,450 characters of JSON (checkModule computes it), so one list read takes 16 rows:
  // every read of a list pages with `after`.
  maxChars: 1_500,
  indexes: [["place", "since"], ["match", "since"], "dedupeKey"],
  // Version 1 kept the hash alone in `match`; version 2 adds the status, so the index finds open items first.
  migrate: { 1: (v: { readonly match: string; readonly status: string }) => ({ ...v, match: `${v.match}:${v.status}` }) }
})

/** The most rows one list read of items takes (`maxListRows`: 16). */
export const ITEM_PAGE = maxListRows(items)

export const placeOf = (list: string, status: ItemStatus) => `${list}:${status}`

// ---------------------------------------------------------------------------------------------------------------------
// Undo

/** One item an operation changed: what it was before (`absent`: the operation made it) and the rev it left. */
export const UndoStep = Schema.Struct({
  id: ROW_ID,
  rev: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  from: Schema.Literals(["absent", "open", "done", "removed"]),
  since: Schema.optionalKey(EPOCH_MS)
})
export type UndoStep = typeof UndoStep.Type

/** An item whose amount or note an add changed in place (a merge): its values before. */
export const UndoMerge = Schema.Struct({
  id: ROW_ID,
  rev: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  quantity: Schema.optionalKey(Quantity),
  note: Schema.optionalKey(StoredText(LISTS_LIMITS.noteChars))
})
export type UndoMerge = typeof UndoMerge.Type

/**
 * The last change made in one conversation, so "undo" can reverse it (one level). The row's id is a hash of the
 * conversation id; nothing in it names a person or a device.
 */
export const UndoEntry = Schema.Struct({
  at: EPOCH_MS,
  op: Schema.Literals(["add", "complete", "remove", "clear", "update", "create", "delete"]),
  list: ROW_ID,
  /** The list's rev after a `create` or `delete`: undone only while nothing else changed it. */
  listRev: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
  steps: Schema.Array(UndoStep).check(Schema.isMaxLength(MAX_CLEAR)),
  merged: Schema.optionalKey(Schema.Array(UndoMerge).check(Schema.isMaxLength(MAX_PER_REQUEST))),
  /** An `update`'s item before it. */
  before: Schema.optionalKey(Schema.Struct({
    text: StoredText(LISTS_LIMITS.textChars),
    quantity: Schema.optionalKey(Quantity),
    note: Schema.optionalKey(StoredText(LISTS_LIMITS.noteChars))
  }))
})
export type UndoEntry = typeof UndoEntry.Type

export const undo = defineCollection({
  name: "undo",
  scope: "household",
  schema: UndoEntry,
  // The worst legal entry is 14,758 characters (40 steps, 12 merges, one item before): one read takes one row,
  // which is all "undo" reads (by id); the daily clean-up pages by `at`, one row at a time.
  maxChars: 16_000,
  indexes: ["at"]
})

/** The undo row of a conversation: a hash, so the id says nothing about who or where. */
export const undoIdOf = (conversationId: string) => `u-${createHash("sha256").update(conversationId).digest("hex").slice(0, 32)}`

// ---------------------------------------------------------------------------------------------------------------------
// Matching

const ARTICLES = new Set(["the", "a", "an", "some", "de", "het", "een", "wat", "my", "mijn"])

/** An English plural said as its singular ("eggs" → "egg", "tomatoes" → "tomato"); Dutch plurals in -s too. */
const singular = (w: string): string => {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2)
  if (w.length > 4 && /(ss|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1)
  return w
}

/**
 * The text as it is compared: lower case, without accents and punctuation, single spaces, without a leading article,
 * its last word singular. "The Eggs" and "egg" are the same item; "oat milk" and "milk" are not. Bounded: the text is
 * at most `LISTS_LIMITS.textChars`.
 */
export const normalise = (text: string): string => {
  const words = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((w) => w !== "")
  while (words.length > 1 && ARTICLES.has(words[0]!)) words.shift()
  if (words.length > 0) words[words.length - 1] = singular(words[words.length - 1]!)
  return words.join(" ")
}

/** The `match` of an item in a status: a hash of its list and its normalised text (the same for "Eggs" and "egg"), and the status. */
export const matchOf = (list: string, text: string, status: ItemStatus) => `${createHash("sha256").update(`${list}\n${normalise(text)}`).digest("hex").slice(0, 32)}:${status}`

// ---------------------------------------------------------------------------------------------------------------------
// Saying

/** A list as it is said: "the shopping list", "the camping list", "de lijst camping". */
export const listPhrase = (id: string, row: ListRow | undefined, lang: Language): string => {
  if (id === SHOPPING) return say(texts, lang, "shoppingList")
  if (id === TODO) return say(texts, lang, "todoList")
  const name = row?.name ?? id
  if (lang === "en" && /\blist$/i.test(name)) return say(texts, lang, "namedListPlain", { name })
  if (lang === "nl" && /lijst(je)?$/i.test(name)) return say(texts, lang, "namedListPlain", { name })
  return say(texts, lang, "namedList", { name })
}

/** A list with its first letter in capitals, to start a sentence. */
export const capital = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1))

/** The contract's view of a row. */
export const itemOf = (row: Row<Item>): ListItem => ({
  id: row.id,
  text: row.value.text,
  status: row.value.status === "done" ? "done" : "open",
  ...(row.value.quantity !== undefined ? { quantity: row.value.quantity } : {}),
  ...(row.value.note !== undefined ? { note: row.value.note } : {}),
  ...(row.value.dedupeKey !== undefined ? { dedupeKey: row.value.dedupeKey } : {})
})

/** The fields of an item that change with its status. */
export const withStatus = (value: Item, status: ItemStatus, since: number): Item => ({
  ...value,
  status,
  place: placeOf(value.list, status),
  match: `${value.match.slice(0, 32)}:${status}`,
  since
})

/** An item with another text (its `match` follows it). */
export const withText = (value: Item, text: string): Item => ({ ...value, text, match: matchOf(value.list, text, value.status) })
