// The pantry ledger (docs/modules/kitchen.md): products, their names, and the bookings whose sum is each product's
// stock. Every change is one booking, written in one transaction with the product's running sum. A product's stock is
// either known or unknown: an approximate booking makes it unknown until someone sets it exactly. Undo is one step:
// the device's last booking, within ten minutes, when nothing else was booked for that product since. The shopping list
// is brought into line with a product after each booking (and every night, `tidy.ts`) through the `Lists` service.
import { type Actor, type ModuleHostApi, type ModuleStore, type Row, StoreError, type StoreFailure, type StoreTx } from "@pva/core"
import { type Language, speakAmount, speakList, type UnitId } from "@pva/language"
import { isLine, Lists, type ListsError, say, useService } from "@pva/module-contracts"
import { Deferred, Effect, Option, Semaphore } from "effect"
import Fuse from "fuse.js"
import { randomUUID } from "node:crypto"
import { type BaseUnit, type Booking, type BookingKind, bookings, forgotten, MAX_AMOUNT, names, type Product, products, scan } from "./data.ts"
import { texts, type TextKey } from "./texts.ts"
import { keyOf } from "./words.ts"

/** The most products one answer reads: 20 pages of 25. A turn never reads further, and says so when it was cut. */
export const PRODUCT_SCAN = 500
export const PRODUCT_PAGE = 25
/** The most low products one answer reads: four pages of 25. */
export const LOW_SCAN = 100
/** An undo reaches the asking device's last booking, made at most this long ago. */
export const UNDO_WINDOW_MS = 10 * 60_000
/** A call to the shopping list waits at most this long: the booking stands whatever the list does. */
export const LISTS_TIMEOUT_MS = 1_500
/** Bookings removed per transaction when a product is forgotten, and the most one forget removes before the night does the rest. */
export const FORGET_BATCH = 100
export const FORGET_NOW = 5_000

/** Grams, millilitres and pieces to three decimals: no float noise in a sum. */
export const round = (x: number): number => Math.round(x * 1000) / 1000

/** Whether a product is low: below its minimum, or none left (on record). */
export const lowOf = (stock: number, min: number | undefined): boolean => stock <= 0 || (min !== undefined && stock < min)

/** The dedupe key of a product's item on the shopping list (the `Lists` contract's keys). */
export const listKey = (productId: string): string => `kitchen:product:${productId}`

/** The settings the pantry acts on, asked at each use. */
export interface PantrySettings {
  readonly lowStockToList: boolean
  readonly listWhenOut: boolean
}

/** Whether a product belongs on the shopping list: below its minimum or, with `listWhenOut`, none left on record. */
export const wanted = (p: Product | undefined, s: PantrySettings): boolean =>
  p !== undefined && s.lowStockToList && ((p.min !== undefined && p.stock < p.min) || (s.listWhenOut && p.stock <= 0))

/** An amount in a base unit as said: rounded for speech, and then "about" (speakAmount never states another amount). */
export const amountText = (amount: number, unit: BaseUnit, approx: boolean, lang: Language, item?: string): string => {
  const r = unit === "piece" || amount < 10 ? Math.round(amount * 100) / 100 : Math.round(amount)
  const said = speakAmount({ amount: r, unit, approx: approx || r !== amount }, lang, item !== undefined ? { item } : {})
  return said ?? `${r} ${unit} ${item ?? ""}`.trim()
}

/** A known stock as said: "950 grams of rice". An unknown one is never said as current: `stockSentence`. */
export const stockText = (p: Product, lang: Language): string => amountText(p.stock, p.unit, false, lang, p.name)

/** The last known amount of an unknown stock, always "about": "last I knew, about 950 grams of rice". */
export const lastKnownText = (p: Product, lang: Language): string => amountText(p.stock, p.unit, true, lang, p.name)

/**
 * What there is now, as a sentence of a confirmation: "You now have 950 grams of rice." when it is known; when it is
 * not, that it is not known, with the last known amount only as that.
 */
export const stockSentence = (p: Product, lang: Language): string => {
  if (p.unknown) return p.stock > 0 ? say(texts, lang, "unsure", { item: p.name, total: lastKnownText(p, lang) }) : say(texts, lang, "unsureNone", { item: p.name })
  return p.stock > 0 ? say(texts, lang, "stockNow", { total: stockText(p, lang) }) : say(texts, lang, "stockNowNone", { item: p.name })
}

/** One product as an overview names it: its known amount, or its name with what was last known. */
export const overviewText = (p: Product, lang: Language): string => {
  if (!p.unknown) return stockText(p, lang)
  return p.stock > 0 ? say(texts, lang, "overviewUnsure", { item: p.name, total: amountText(p.stock, p.unit, true, lang) }) : say(texts, lang, "overviewUnknown", { item: p.name })
}

/** An amount as the person said it ("2 bags of rice"), or in base units when it cannot be said so. */
export const saidText = (q: { readonly amount?: number | undefined; readonly unit?: UnitId | undefined; readonly approx: boolean }, base: number, unit: BaseUnit, lang: Language, item: string): string =>
  (q.amount !== undefined ? speakAmount({ amount: q.amount, unit: q.unit, approx: q.approx }, lang, { item }) : undefined) ?? amountText(base, unit, q.approx, lang, item)

/** A failure of the store as the person hears it: "busy" means nothing was done, so say so. */
export const storeFailureText = (e: StoreFailure | unknown, lang: Language, otherwise: TextKey): string =>
  say(texts, lang, e instanceof StoreError && e.reason === "busy" ? "busy" : otherwise)

/**
 * A list for speech of at most `max` names: "a, b, c and 25 more" when the count is known; "a, b, c and more" when the
 * read was cut, so no count is given that was not made.
 */
export const listText = (items: ReadonlyArray<string>, lang: Language, cut: boolean, max = 6): string => {
  if (!cut && items.length <= max) return speakList(items, lang, { max }) ?? items.join(", ")
  const shown = items.slice(0, max - 1)
  const rest = cut ? say(texts, lang, "andMore") : say(texts, lang, "nMore", { count: items.length - shown.length })
  return speakList([...shown, rest], lang, { max }) ?? [...shown, rest].join(", ")
}

/** What one booking changes. */
export interface Change {
  readonly kind: BookingKind
  /** The change of the amount on record, in the product's unit: the caller keeps the result within 0 and `MAX_AMOUNT`. */
  readonly delta: number
  /** The amount said was approximate, or there was none ("some", a package of unknown size): the stock becomes unknown. */
  readonly approx: boolean
  readonly said?: string
  readonly device?: string
  /** Whether the stock is unknown afterwards, when the change decides it (a correction, an undo, "none left"). */
  readonly unknown?: boolean
}

/** Whether a change is within what is kept: never below 0 (the caller sets "none" instead), never above `MAX_AMOUNT`. */
export const fits = (p: Product, delta: number): boolean => {
  const next = round(p.stock + delta)
  return next >= 0 && next <= MAX_AMOUNT
}

/**
 * Book one change inside a transaction: the booking and the product's sum together, both or neither. The amount is
 * never clamped: a change that does not fit is a bug of the caller, thrown, and the transaction rolls back.
 */
export const book = (tx: StoreTx, row: Row<Product>, change: Change, now: number): { readonly before: Product; readonly after: Product; readonly booking: Row<Booking> } => {
  const p = row.value
  if (!fits(p, change.delta)) throw new Error(`kitchen: a booking of ${change.delta} does not fit a stock of ${p.stock}`)
  // Each product's and each device's bookings are strictly in time order, also within one millisecond: an undo takes
  // the device's last one and checks it is the product's last one; the nightly job folds a product's oldest ones.
  const lastOf = (where: { readonly product: string } | { readonly device: string }) =>
    tx.collection(bookings).list({ where, orderBy: { field: "at", direction: "desc" }, limit: 1 })[0]?.value.at ?? -1
  const at = Math.max(now, lastOf({ product: row.id }) + 1, change.device !== undefined ? lastOf({ device: change.device }) + 1 : -1)
  const stock = round(p.stock + change.delta)
  const unknown = change.unknown ?? (p.unknown || change.approx)
  const after: Product = { ...p, stock, unknown, low: lowOf(stock, p.min) }
  const booking = tx.collection(bookings).insert({
    product: row.id,
    kind: change.kind,
    delta: round(stock - p.stock),
    approx: change.approx,
    unknownBefore: p.unknown,
    at,
    // The words as said, kept only when they are one clean line (they come from the person's sentence).
    ...(change.said !== undefined && isLine(change.said.slice(0, 80), 80) && change.said.trim() !== "" ? { said: change.said.slice(0, 80) } : {}),
    ...(change.device !== undefined ? { device: change.device } : {})
  })
  tx.collection(products).update(row.id, () => after, { expectRev: row.rev })
  return { before: p, after, booking }
}

/** A new product with its name, inside a transaction. The caller checked that no product has the key. */
export const createProduct = (tx: StoreTx, name: string, unit: BaseUnit, extra: Partial<Pick<Product, "min" | "pack">> = {}): Row<Product> => {
  const key = keyOf(name)
  const id = randomUUID()
  const row = tx.collection(products).insert({ name, key, unit, stock: 0, unknown: false, low: true, aliases: [], tidiedAt: 0, listedAt: 0, ...extra }, { id })
  tx.collection(names).insert({ key, product: id })
  return row
}

/** Remove up to `max` bookings of a product, oldest first, inside a transaction; how many it removed. */
export const removeBookings = (tx: StoreTx, product: string, max = FORGET_BATCH, options: { readonly actor?: Actor } = {}): number => {
  let removed = 0
  while (removed < max) {
    const got = tx.collection(bookings).list({ where: { product }, orderBy: { field: "at", direction: "asc" }, limit: Math.min(25, max - removed) })
    for (const r of got) tx.collection(bookings).remove(r.id, options.actor !== undefined ? { actor: options.actor } : {})
    removed += got.length
    if (got.length === 0) break
  }
  return removed
}

/**
 * Take a product out, inside a transaction: the product and its names go at once, its first bookings with them, and a
 * `forgotten` row says the rest of its bookings still have to go (the forget tool goes on in further transactions,
 * and the nightly job takes up whatever a restart left). Returns whether bookings are left.
 */
export const removeProduct = (tx: StoreTx, id: string): boolean => {
  for (let n = 0; n < 20; n++) {
    const got = tx.collection(names).list({ where: { product: id }, limit: 10 })
    for (const r of got) tx.collection(names).remove(r.id)
    if (got.length < 10) break
  }
  tx.collection(products).remove(id)
  removeBookings(tx, id, FORGET_BATCH)
  const left = tx.collection(bookings).list({ where: { product: id }, orderBy: { field: "at", direction: "asc" }, limit: 1 }).length > 0
  if (left && tx.collection(forgotten).get(id) === undefined) tx.collection(forgotten).insert({ product: id }, { id })
  return left
}

/**
 * Remove the bookings of a forgotten product in steps, each its own transaction, until none are left (then its
 * `forgotten` row goes too) or `max` have gone. Returns how many it removed and whether it finished.
 */
export const drainForgotten = (store: ModuleStore, id: string, max: number, actor?: Actor) =>
  Effect.gen(function*() {
    let removed = 0
    while (removed < max) {
      const step = yield* store.transaction((tx) => {
        const n = removeBookings(tx, id, Math.min(FORGET_BATCH, max - removed), actor !== undefined ? { actor } : {})
        const left = tx.collection(bookings).list({ where: { product: id }, orderBy: { field: "at", direction: "asc" }, limit: 1 }).length > 0
        if (!left) tx.collection(forgotten).remove(id, actor !== undefined ? { actor } : {})
        return { n, left }
      })
      removed += step.n
      if (!step.left) return { removed, done: true }
      yield* Effect.yieldNow
    }
    return { removed, done: false }
  })

/** What an undo finds: the booking to reverse with its product, or why there is none. */
export type Undoable =
  | { readonly kind: "ok"; readonly booking: Row<Booking>; readonly product: Row<Product> }
  | { readonly kind: "nothing" }
  | { readonly kind: "tooOld"; readonly product: Row<Product> }
  | { readonly kind: "changedSince"; readonly product: Row<Product> }

/**
 * The asking device's last booking, if it can be undone exactly, read inside the transaction that reverses it: made
 * at most `UNDO_WINDOW_MS` ago, not itself an undo, and the last booking of its product (nobody booked that product
 * since). An undo is the device's last booking afterwards, so a second undo finds nothing.
 */
export const undoable = (tx: StoreTx, device: string, now: number): Undoable => {
  const [last] = tx.collection(bookings).list({ where: { device }, orderBy: { field: "at", direction: "desc" }, limit: 1 })
  if (last === undefined || last.value.kind === "undo" || last.value.kind === "carry") return { kind: "nothing" }
  const product = tx.collection(products).get(last.value.product)
  if (product === undefined) return { kind: "nothing" }
  if (last.value.at < now - UNDO_WINDOW_MS) return { kind: "tooOld", product }
  const [newest] = tx.collection(bookings).list({ where: { product: product.id }, orderBy: { field: "at", direction: "desc" }, limit: 1 })
  if (newest?.id !== last.id) return { kind: "changedSince", product }
  return { kind: "ok", booking: last, product }
}

/** How the shopping list was brought into line with a product, for the answer. */
export type ListOutcome = string | undefined

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

  // One product's list calls at a time, in the order they were asked for (each reads the product as it is then), so
  // a slow "add" can never land after the "tick off" of a later restock. Locks are dropped when nobody holds them.
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>()
  const oneAtATime = <A, E>(id: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const entry = locks.get(id) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
      entry.users++
      locks.set(id, entry)
      return entry.lock.withPermits(1)(effect).pipe(
        Effect.ensuring(Effect.sync(() => {
          entry.users--
          if (entry.users === 0) locks.delete(id)
        }))
      )
    })

  /**
   * After a booking has committed: bring the shopping list into line with the product as it is now. Low: its item is
   * added (one key per product, so one item). No longer low, when it was before this booking: the item kitchen put
   * there is ticked off. When the list is off, fails or is slow, the answer says the list could not be updated, and
   * never whether the item is on it. Waits at most `LISTS_TIMEOUT_MS` per call.
   */
  const followList = (id: string, before: Product | undefined, name: string, settings: PantrySettings, lang: Language): Effect.Effect<ListOutcome> => {
    if (!settings.lowStockToList) return Effect.succeed(undefined)
    const work = Effect.gen(function*() {
      const now = yield* productStore.get(id).pipe(Effect.orElseSucceed(() => undefined))
      if (now === undefined) return undefined
      const p = now.value
      const item = p.name
      const capital = item.charAt(0).toUpperCase() + item.slice(1)
      const failed = () => say(texts, lang, "listFailed", { item })
      if (wanted(p, settings)) {
        return yield* useService(deps.host, Lists, (lists) => lists.addItem({ text: item, dedupeKey: listKey(id) })).pipe(
          Effect.timeoutOption(LISTS_TIMEOUT_MS),
          Effect.map((o): ListOutcome => {
            if (Option.isNone(o)) return failed()
            // Already on the list from an earlier booking, and said then: nothing new to say.
            if (o.value.outcome === "updated" && wanted(before, settings)) return undefined
            return p.min !== undefined && p.stock > 0
              ? say(texts, lang, "listedBelow", { item: capital, min: amountText(p.min, p.unit, false, lang) })
              : say(texts, lang, "listed", { item: capital })
          }),
          Effect.catchTag("ProviderOff", () => Effect.succeed(say(texts, lang, "listOff", { item }))),
          Effect.catchTag("ListsError", (e: ListsError) => Effect.succeed(say(texts, lang, e.reason === "limit" ? "listFull" : "listFailed", { item })))
        )
      }
      if (!wanted(before, settings)) return undefined
      return yield* useService(deps.host, Lists, (lists) => lists.completeByKey(listKey(id))).pipe(
        Effect.timeoutOption(LISTS_TIMEOUT_MS),
        Effect.map((o): ListOutcome => (Option.isNone(o) ? failed() : o.value !== undefined ? say(texts, lang, "ticked", { item }) : undefined)),
        Effect.catchTag("ProviderOff", () => Effect.succeed(say(texts, lang, "listOff", { item }))),
        Effect.catchTag("ListsError", () => Effect.succeed(failed()))
      )
    })
    // Waiting behind another call for the same product counts too: never longer than two calls.
    return oneAtATime(id, work).pipe(
      Effect.timeoutOption(2 * LISTS_TIMEOUT_MS + 500),
      Effect.map((o) => (Option.isSome(o) ? o.value : say(texts, lang, "listFailed", { item: name })))
    )
  }

  /** The low products, in name order, at most `LOW_SCAN` (and whether the read was cut). */
  const low = () => scan(productStore, { where: { low: true }, orderBy: { field: "key", direction: "asc" } }, PRODUCT_PAGE, LOW_SCAN)

  // A phrase heard once acts once, also when two copies overlap: the identity (assistant, conversation, turn, device) is
  // claimed before anything runs, and a second copy waits for the first's outcome and gets it. A claim that has not
  // finished is never dropped; finished ones are kept, a bounded few.
  const claims = new Map<string, { done: boolean; readonly wait: Deferred.Deferred<{ readonly say: string }, unknown> }>()
  const FINISHED = 64
  const once = <E>(identity: string | undefined, run: Effect.Effect<{ readonly say: string }, E>): Effect.Effect<{ readonly say: string }, E> =>
    identity === undefined
      ? run
      : Effect.suspend(() => {
        const held = claims.get(identity)
        if (held !== undefined) return Deferred.await(held.wait) as Effect.Effect<{ readonly say: string }, E>
        const claim = { done: false, wait: Deferred.makeUnsafe<{ readonly say: string }, unknown>() }
        claims.set(identity, claim)
        return run.pipe(Effect.onExit((exit) =>
          Effect.sync(() => {
            claim.done = true
            Deferred.doneUnsafe(claim.wait, exit)
            let finished = 0
            for (const c of claims.values()) if (c.done) finished++
            for (const [key, c] of claims) {
              if (finished <= FINISHED) break
              if (c.done) {
                claims.delete(key)
                finished--
              }
            }
          })
        ))
      })

  return { productStore, nameStore, bookingStore, find, all, suggest, followList, low, once }
}

export type Pantry = ReturnType<typeof makePantry>
