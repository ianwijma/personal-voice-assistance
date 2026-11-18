// The pantry ledger (docs/modules/kitchen.md): products, their names, and the bookings whose sum is each product's
// stock. Every change is one booking, written in one transaction with the product's running sum; an undo is a
// reversing booking. Low stock goes to the household's shopping list through the `Lists` service, after the booking
// has committed.
import { type ModuleHostApi, type ModuleStore, type Row, StoreError, type StoreFailure, type StoreTx } from "@pva/core"
import { type Language, speakAmount, type UnitId } from "@pva/language"
import { isLine, Lists, ListsError, say, useService } from "@pva/module-contracts"
import { Effect, Option } from "effect"
import Fuse from "fuse.js"
import { randomUUID } from "node:crypto"
import { type BaseUnit, type Booking, type BookingKind, bookings, MAX_AMOUNT, names, type Product, products, scan } from "./data.ts"
import { texts, type TextKey } from "./texts.ts"
import { keyOf } from "./words.ts"

/** The most products one answer reads: 20 pages of 25. A turn never reads further, and says so when it was cut. */
export const PRODUCT_SCAN = 500
export const PRODUCT_PAGE = 25
/** An undo reaches the asking device's bookings of the last day, newest first, one page of them. */
export const UNDO_WINDOW_MS = 86_400_000
const UNDO_PAGE = 16
/** A call to the shopping list waits at most this long: the booking stands whatever the list does. */
export const LISTS_TIMEOUT_MS = 1_500

/** Grams, millilitres and pieces to three decimals: no float noise in a sum. */
export const round = (x: number): number => Math.round(x * 1000) / 1000
const clamp = (x: number): number => Math.min(MAX_AMOUNT, Math.max(0, round(x)))

/** Whether a product is low: below its minimum, or none left. */
export const lowOf = (stock: number, min: number | undefined): boolean => stock <= 0 || (min !== undefined && stock < min)

/** The dedupe key of a product's item on the shopping list (the `Lists` contract's keys). */
export const listKey = (productId: string): string => `kitchen:product:${productId}`

/** The settings the pantry acts on, asked at each use. */
export interface PantrySettings {
  readonly lowStockToList: boolean
  readonly listWhenOut: boolean
}

/** An amount in a base unit as said: rounded for speech, and then "about" (speakAmount never states another amount). */
export const amountText = (amount: number, unit: BaseUnit, approx: boolean, lang: Language, item?: string): string => {
  const r = unit === "piece" || amount < 10 ? Math.round(amount * 100) / 100 : Math.round(amount)
  const said = speakAmount({ amount: r, unit, approx: approx || r !== amount }, lang, item !== undefined ? { item } : {})
  return said ?? `${r} ${unit} ${item ?? ""}`.trim()
}

/** The product's stock as said: "about 950 grams of rice". */
export const stockText = (p: Product, lang: Language): string => amountText(p.stock, p.unit, p.approx, lang, p.name)

/** An amount as the person said it ("2 bags of rice"), or in base units when it cannot be said so. */
export const saidText = (q: { readonly amount?: number | undefined; readonly unit?: UnitId | undefined; readonly approx: boolean }, base: number, unit: BaseUnit, lang: Language, item: string): string =>
  (q.amount !== undefined ? speakAmount({ amount: q.amount, unit: q.unit, approx: q.approx }, lang, { item }) : undefined) ?? amountText(base, unit, q.approx, lang, item)

/** A failure of the store as the person hears it: "busy" means nothing was done, so say so. */
export const storeFailureText = (e: StoreFailure | unknown, lang: Language, otherwise: TextKey): string =>
  say(texts, lang, e instanceof StoreError && e.reason === "busy" ? "busy" : otherwise)

/** What one booking changes. */
export interface Change {
  readonly kind: BookingKind
  readonly delta: number
  readonly approx: boolean
  /** "some": no amount moved, so the stock is no longer known. */
  readonly uncertain?: boolean
  readonly said?: string
  readonly device?: string
  readonly undoes?: string
  /** For a correction (`set`) and an undo: the product's flags afterwards, instead of being worked out. */
  readonly flags?: { readonly approx: boolean; readonly uncertain: boolean }
}

/** Book one change inside a transaction: the booking and the product's sum together. Returns the product before and after. */
export const book = (tx: StoreTx, row: Row<Product>, change: Change, now: number): { readonly before: Product; readonly after: Product; readonly booking: Row<Booking> } => {
  const p = row.value
  // Each product's and each device's bookings are strictly in time order, also within one millisecond: an undo takes
  // the device's last one, and the nightly job folds a product's oldest ones.
  const lastOf = (where: { readonly product: string } | { readonly device: string }) =>
    tx.collection(bookings).list({ where, orderBy: { field: "at", direction: "desc" }, limit: 1 })[0]?.value.at ?? -1
  const at = Math.max(now, lastOf({ product: row.id }) + 1, change.device !== undefined ? lastOf({ device: change.device }) + 1 : -1)
  const stock = clamp(p.stock + change.delta)
  const delta = round(stock - p.stock)
  const flags = change.flags ?? { approx: p.approx || change.approx, uncertain: p.uncertain || change.uncertain === true }
  const after: Product = { ...p, stock, approx: flags.approx, uncertain: flags.uncertain, low: lowOf(stock, p.min) }
  const booking = tx.collection(bookings).insert({
    product: row.id,
    kind: change.kind,
    delta,
    approx: change.approx,
    ...(change.uncertain === true ? { uncertain: true } : {}),
    approxBefore: p.approx,
    uncertainBefore: p.uncertain,
    at,
    // The words as said, kept only when they are one clean line (they come from the person's sentence).
    ...(change.said !== undefined && isLine(change.said.slice(0, 80), 80) && change.said.trim() !== "" ? { said: change.said.slice(0, 80) } : {}),
    ...(change.device !== undefined ? { device: change.device } : {}),
    ...(change.undoes !== undefined ? { undoes: change.undoes } : {})
  })
  tx.collection(products).update(row.id, () => after, { expectRev: row.rev })
  return { before: p, after, booking }
}

/** A new product with its name, inside a transaction. The caller checked that no product has the key. */
export const createProduct = (tx: StoreTx, name: string, unit: BaseUnit, extra: Partial<Pick<Product, "min" | "pack">> = {}): Row<Product> => {
  const key = keyOf(name)
  const id = randomUUID()
  const row = tx.collection(products).insert({ name, key, unit, stock: 0, approx: false, uncertain: false, low: true, aliases: [], ...extra }, { id })
  tx.collection(names).insert({ key, product: id })
  return row
}

/** Remove a product, its names and (up to `max`) its bookings, inside a transaction. The nightly job removes any left. */
export const removeProduct = (tx: StoreTx, id: string, max = 1_000): void => {
  for (let n = 0; n < 20; n++) {
    const got = tx.collection(names).list({ where: { product: id }, limit: 10 })
    for (const r of got) tx.collection(names).remove(r.id)
    if (got.length < 10) break
  }
  let removed = 0
  while (removed < max) {
    const got = tx.collection(bookings).list({ where: { product: id }, orderBy: { field: "at", direction: "asc" }, limit: UNDO_PAGE })
    for (const r of got) tx.collection(bookings).remove(r.id)
    removed += got.length
    if (got.length < UNDO_PAGE) break
  }
  tx.collection(products).remove(id)
}

/**
 * The newest booking of `device` within the undo window that is neither an undo nor undone already, read inside the
 * transaction that reverses it, so two undos at once never reverse one booking twice.
 */
export const lastUndoable = (tx: StoreTx, device: string, now: number): Row<Booking> | undefined => {
  const recent = tx.collection(bookings).list({ where: { device }, orderBy: { field: "at", direction: "desc" }, limit: UNDO_PAGE })
  const undone = new Set(recent.flatMap((r) => (r.value.undoes !== undefined ? [r.value.undoes] : [])))
  return recent.find((r) => r.value.kind !== "undo" && r.value.kind !== "carry" && !undone.has(r.id) && r.value.at >= now - UNDO_WINDOW_MS)
}

export const makePantry = (deps: { readonly store: ModuleStore; readonly host: ModuleHostApi }) => {
  const productStore = deps.store.collection(products)
  const nameStore = deps.store.collection(names)
  const bookingStore = deps.store.collection(bookings)

  /** The product a name means: one indexed read of its key, then the row. */
  const find = (name: string) =>
    Effect.gen(function*() {
      const key = keyOf(name)
      if (key === "") return undefined
      const [hit] = yield* nameStore.list({ where: { key }, limit: 1 })
      return hit === undefined ? undefined : yield* productStore.get(hit.value.product)
    })

  /** Every product in name order, bounded. */
  const all = (max = PRODUCT_SCAN) => scan(productStore, { orderBy: { field: "key", direction: "asc" } }, PRODUCT_PAGE, max)

  /** The nearest product name for one that was not found ("rijst" for "rice"), from a bounded read; on a miss only. */
  const suggest = (name: string) =>
    Effect.gen(function*() {
      const { rows } = yield* all()
      if (rows.length === 0) return undefined
      const entries = rows.flatMap((r) => [{ name: r.value.name, key: r.value.key }, ...r.value.aliases.map((a) => ({ name: r.value.name, key: a }))])
      const fuse = new Fuse(entries, { keys: ["key"], threshold: 0.4, ignoreLocation: true })
      return fuse.search(keyOf(name), { limit: 1 })[0]?.item.name
    }).pipe(Effect.orElseSucceed(() => undefined))

  /**
   * After a booking has committed: put a low product on the shopping list (the same key each time, so one item), or
   * tick it off when its stock is back. Returns the sentence to add, or nothing. Waits at most `LISTS_TIMEOUT_MS`.
   */
  const followList = (id: string, before: Product | undefined, after: Product, settings: PantrySettings, lang: Language): Effect.Effect<string | undefined> => {
    const wanted = (p: Product | undefined) => p !== undefined && settings.lowStockToList && ((p.min !== undefined && p.stock < p.min) || (settings.listWhenOut && p.stock <= 0))
    const item = after.name
    const capital = item.charAt(0).toUpperCase() + item.slice(1)
    if (wanted(after)) {
      return useService(deps.host, Lists, (lists) => lists.addItem({ text: item, dedupeKey: listKey(id) })).pipe(
        Effect.timeoutOption(LISTS_TIMEOUT_MS),
        Effect.map((o) => {
          if (Option.isNone(o)) return say(texts, lang, "listFailed", { item })
          // Already on the list from an earlier booking, and said then: nothing new to say.
          if (o.value.outcome === "updated" && wanted(before)) return undefined
          return after.min !== undefined && after.stock > 0
            ? say(texts, lang, "listedBelow", { item: capital, min: amountText(after.min, after.unit, false, lang) })
            : say(texts, lang, "listed", { item: capital })
        }),
        Effect.catchTag("ProviderOff", () => Effect.succeed(say(texts, lang, "listOff", { item }))),
        Effect.catchTag("ListsError", (e: ListsError) => Effect.succeed(say(texts, lang, e.reason === "limit" ? "listFull" : "listFailed", { item })))
      )
    }
    // Back in stock: tick off the item kitchen put there. Nothing to say when it was not there or the list is away.
    if (wanted(before)) {
      return useService(deps.host, Lists, (lists) => lists.completeByKey(listKey(id))).pipe(
        Effect.timeoutOption(LISTS_TIMEOUT_MS),
        Effect.map((o) => (Option.isSome(o) && o.value !== undefined ? say(texts, lang, "ticked", { item }) : undefined)),
        Effect.catchTag("ProviderOff", () => Effect.succeed(undefined)),
        Effect.catchTag("ListsError", () => Effect.succeed(undefined))
      )
    }
    return Effect.succeed(undefined)
  }

  return { productStore, nameStore, bookingStore, find, all, suggest, followList }
}

export type Pantry = ReturnType<typeof makePantry>
