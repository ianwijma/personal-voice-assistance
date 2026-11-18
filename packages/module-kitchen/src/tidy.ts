// The nightly job: it keeps the ledger bounded and checked, finishes forgetting products, and brings the shopping list
// into line with every product. Each part is bounded per night and carries on the next night where it stopped: the
// products are taken in order of when the job last saw them (`tidiedAt`, `listedAt`), oldest first, so nothing is
// starved by a prefix it keeps reading. Each step is one small transaction; the job yields between them. Running it
// twice does no harm (the scheduler retries it after a restart in the middle).
//
// - Folding: for each product, bookings older than `keepDays` are folded into one `carry` booking with their sum, so
//   the sum, and so the stock, is unchanged; the product's running sum is compared with its ledger and, should they
//   ever differ, set to the ledger's (the ledger is the truth).
// - Forgotten products: their bookings are removed in steps until none are left.
// - The shopping list: a low product gets its open item (one key per product, so one item); a product that is not
//   low has the item kitchen put there ticked off. When the list is off, failing or slow, the night stops asking it
//   and those products are first the next night.
import { type Actor, type ModuleHostApi, type ModuleStore, type Row } from "@pva/core"
import { Lists, ListsError, useService } from "@pva/module-contracts"
import { Effect, Option } from "effect"
import { type Booking, bookings, forgotten, type Product, products } from "./data.ts"
import { drainForgotten, listKey, LISTS_TIMEOUT_MS, lowOf, type PantrySettings, round, wanted } from "./pantry.ts"

/** The most products folded and checked per night, and the most whose list item is brought into line. */
export const TIDY_PRODUCTS = 2_000
export const LIST_PRODUCTS = 500
/** The most bookings of forgotten products removed per night. */
export const FORGET_PER_NIGHT = 20_000
/** The list part stops after this much real time in one night: the rest is first the next night. */
const LIST_BUDGET_MS = 60_000
const BOOKINGS_PER_PRODUCT = 400
const FOLD_PER_TX = 100
const BOOKING_PAGE = 16
const PAGE = 25

export interface TidyReport {
  readonly folded: number
  readonly repaired: number
  readonly forgotten: number
  readonly listed: number
  readonly ticked: number
  /** The list part stopped early (the list was off, failing or slow). */
  readonly listStopped: boolean
}

/**
 * Products in order of a "last seen" field, oldest first, at most `max`, page by page, until one seen at `now` (this
 * night) comes up: each product handled moves to the end of that order.
 */
const oldestFirst = (store: ModuleStore, field: "tidiedAt" | "listedAt", now: number, max: number, each: (row: Row<Product>) => Effect.Effect<boolean, unknown>) =>
  Effect.gen(function*() {
    let after: Row<Product> | undefined
    let seen = 0
    while (seen < max) {
      const got: ReadonlyArray<Row<Product>> = yield* store.collection(products).list({ orderBy: { field, direction: "asc" }, limit: PAGE, ...(after !== undefined ? { after } : {}) })
      for (const row of got) {
        if (row.value[field] >= now) return
        seen++
        if (!(yield* each(row))) return
        yield* Effect.yieldNow
        if (seen >= max) return
      }
      if (got.length < PAGE) return
      after = got.at(-1)
    }
  })

export const tidy = (deps: {
  readonly store: ModuleStore
  readonly host: ModuleHostApi
  readonly settings: PantrySettings & { readonly keepDays: number }
  readonly now: number
  readonly actor: Actor
  /** Smaller per-night bounds, for tests that show a bounded night carrying on (the defaults otherwise). */
  readonly bounds?: { readonly products?: number; readonly list?: number; readonly forget?: number }
}) =>
  Effect.gen(function*() {
    const { store, settings, actor, now } = deps
    const cutoff = now - settings.keepDays * 86_400_000
    const maxProducts = deps.bounds?.products ?? TIDY_PRODUCTS
    const maxList = deps.bounds?.list ?? LIST_PRODUCTS
    const maxForget = deps.bounds?.forget ?? FORGET_PER_NIGHT
    let folded = 0
    let repaired = 0
    let forgottenRemoved = 0
    let listed = 0
    let ticked = 0
    let listStopped = false

    // 1. Fold and check, the products seen longest ago first.
    yield* oldestFirst(store, "tidiedAt", now, maxProducts, (product) =>
      Effect.gen(function*() {
        const outcome = yield* store.transaction((tx) => {
          const current = tx.collection(products).get(product.id)
          if (current === undefined) return { didFold: 0, didRepair: false }
          const rows: Array<Row<Booking>> = []
          let last: Row<Booking> | undefined
          while (rows.length < BOOKINGS_PER_PRODUCT) {
            const page = tx.collection(bookings).list({ where: { product: product.id }, orderBy: { field: "at", direction: "asc" }, limit: BOOKING_PAGE, ...(last !== undefined ? { after: last } : {}) })
            rows.push(...page)
            if (page.length < BOOKING_PAGE) break
            last = page.at(-1)
          }
          const complete = rows.length < BOOKINGS_PER_PRODUCT
          const old = rows.filter((r) => r.value.at < cutoff).slice(0, FOLD_PER_TX)
          let didFold = 0
          // A prefix of the ledger in time order: its sum is the stock at that moment, so the carry stays within bounds.
          if (old.length >= 2) {
            const sum = round(old.reduce((s, r) => s + r.value.delta, 0))
            for (const r of old) tx.collection(bookings).remove(r.id, { actor })
            tx.collection(bookings).insert({
              product: product.id,
              kind: "carry",
              delta: sum,
              approx: old.some((r) => r.value.approx),
              unknownBefore: old[0]!.value.unknownBefore,
              at: old.at(-1)!.value.at
            }, { actor })
            didFold = old.length
          }
          let didRepair = false
          let next: Product = { ...current.value, tidiedAt: now }
          if (complete) {
            const sum = Math.max(0, round(rows.reduce((s, r) => s + r.value.delta, 0)))
            if (Math.abs(current.value.stock - sum) > 0.0005) {
              next = { ...next, stock: sum, low: lowOf(sum, next.min) }
              didRepair = true
            }
          }
          tx.collection(products).update(product.id, () => next, { actor, expectRev: current.rev })
          return { didFold, didRepair }
        })
        folded += outcome.didFold
        if (outcome.didRepair) repaired++
        return true
      }))

    // 2. Forgotten products: remove their bookings in steps until none are left (bounded per night; the next night
    // goes on with what is left).
    for (let page = 0; page < 40 && forgottenRemoved < maxForget; page++) {
      const rows = yield* store.collection(forgotten).list({ limit: PAGE })
      if (rows.length === 0) break
      let finished = 0
      for (const row of rows) {
        const step = yield* drainForgotten(store, row.id, maxForget - forgottenRemoved, actor)
        forgottenRemoved += step.removed
        if (step.done) finished++
        if (forgottenRemoved >= maxForget) break
      }
      if (finished === 0) break
    }

    // 3. The shopping list, brought into line with every product in turn, the products seen longest ago first.
    if (settings.lowStockToList) {
      const startedReal = performance.now()
      yield* oldestFirst(store, "listedAt", now, maxList, (row) =>
        Effect.gen(function*() {
          if (performance.now() - startedReal > LIST_BUDGET_MS) {
            listStopped = true
            return false
          }
          const current = yield* store.collection(products).get(row.id)
          if (current === undefined) return true
          const p = current.value
          const call = wanted(p, settings)
            ? useService(deps.host, Lists, (lists) => lists.addItem({ text: p.name, dedupeKey: listKey(row.id) })).pipe(Effect.map(() => "listed" as const))
            : useService(deps.host, Lists, (lists) => lists.completeByKey(listKey(row.id))).pipe(Effect.map((item) => (item === undefined ? "clear" as const : "ticked" as const)))
          const result = yield* call.pipe(
            Effect.timeoutOption(LISTS_TIMEOUT_MS),
            Effect.map((o) => (Option.isNone(o) ? "stop" as const : o.value)),
            Effect.catchTag("ProviderOff", () => Effect.succeed("stop" as const)),
            // A refusal of this one item (the list is full, the request does not fit) is its answer for tonight; a
            // busy or failing list stops the night, and this product is first the next one.
            Effect.catchTag("ListsError", (e: ListsError) => Effect.succeed(e.reason === "limit" || e.reason === "invalid" ? "refused" as const : "stop" as const))
          )
          if (result === "stop") {
            listStopped = true
            return false
          }
          if (result === "listed") listed++
          if (result === "ticked") ticked++
          yield* store.collection(products).update(row.id, (v) => ({ ...v, listedAt: now }), { actor }).pipe(Effect.ignore)
          return true
        }))
    }
    return { folded, repaired, forgotten: forgottenRemoved, listed, ticked, listStopped } satisfies TidyReport
  })
