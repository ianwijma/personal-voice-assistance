// The nightly job: it keeps the ledger bounded and checks it. For each product, bookings older than `keepDays` are
// folded into one `carry` booking with their sum (so the sum, and so the stock, is unchanged); the product's running
// sum is compared with its ledger and, should they ever differ, set to the ledger's (the ledger is the truth);
// bookings of a product that no longer exists are removed; and every low product is put on the shopping list again
// (same key: one item), which catches what a booking could not put there while the Lists module was off.
// Each product is one small transaction; the job yields between them.
import { type Actor, type ModuleHostApi, type ModuleStore, type Row } from "@pva/core"
import { Lists, useService } from "@pva/module-contracts"
import { Effect } from "effect"
import { type Booking, bookings, type Product, products, scan } from "./data.ts"
import { listKey, LISTS_TIMEOUT_MS, lowOf, round, type PantrySettings } from "./pantry.ts"

/** The most products and bookings one night looks at, and the most bookings read or folded in one transaction. */
export const TIDY_PRODUCTS = 5_000
const BOOKINGS_PER_PRODUCT = 400
const FOLD_PER_TX = 100
const BOOKING_PAGE = 16
const ORPHAN_SCAN = 400

export interface TidyReport {
  readonly folded: number
  readonly repaired: number
  readonly orphans: number
  readonly listed: number
}

export const tidy = (deps: {
  readonly store: ModuleStore
  readonly host: ModuleHostApi
  readonly settings: PantrySettings & { readonly keepDays: number }
  readonly now: number
  readonly actor: Actor
}) =>
  Effect.gen(function*() {
    const { store, settings, actor } = deps
    const cutoff = deps.now - settings.keepDays * 86_400_000
    let folded = 0
    let repaired = 0
    let orphans = 0
    let listed = 0
    let after: Row<Product> | undefined
    const exists = new Set<string>()
    for (let page = 0; page < TIDY_PRODUCTS / 25; page++) {
      const got: ReadonlyArray<Row<Product>> = yield* store.collection(products).list({ orderBy: { field: "key", direction: "asc" }, limit: 25, ...(after !== undefined ? { after } : {}) })
      for (const product of got) {
        exists.add(product.id)
        const outcome = yield* store.transaction((tx) => {
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
              approxBefore: old[0]!.value.approxBefore,
              uncertainBefore: old[0]!.value.uncertainBefore,
              at: old.at(-1)!.value.at
            }, { actor })
            didFold = old.length
          }
          let didRepair = false
          if (complete) {
            const sum = Math.max(0, round(rows.reduce((s, r) => s + r.value.delta, 0)))
            const current = tx.collection(products).get(product.id)
            if (current !== undefined && Math.abs(current.value.stock - sum) > 0.0005) {
              tx.collection(products).update(product.id, (p) => ({ ...p, stock: sum, low: lowOf(sum, p.min) }), { actor })
              didRepair = true
            }
          }
          return { didFold, didRepair }
        })
        folded += outcome.didFold
        if (outcome.didRepair) repaired++
        yield* Effect.yieldNow
      }
      if (got.length < 25) break
      after = got.at(-1)
    }

    // Bookings of products that are gone (a product forgotten with more history than one transaction removes).
    const oldest = yield* scan(store.collection(bookings), { orderBy: { field: "at", direction: "asc" } }, BOOKING_PAGE, ORPHAN_SCAN)
    const stray = oldest.rows.filter((r) => !exists.has(r.value.product))
    for (let i = 0; i < stray.length; i += FOLD_PER_TX) {
      const batch = stray.slice(i, i + FOLD_PER_TX)
      yield* store.transaction((tx) => {
        for (const r of batch) if (tx.collection(products).get(r.value.product) === undefined) tx.collection(bookings).remove(r.id, { actor })
      })
      orphans += batch.length
      yield* Effect.yieldNow
    }

    // Low products on the shopping list again: the same key keeps one item. Stops at the first refusal or absence.
    if (settings.lowStockToList) {
      const low = yield* scan(store.collection(products), { where: { low: true }, orderBy: { field: "key", direction: "asc" } }, 25, 500)
      for (const row of low.rows) {
        const p = row.value
        if (!((p.min !== undefined && p.stock < p.min) || (settings.listWhenOut && p.stock <= 0))) continue
        const ok = yield* useService(deps.host, Lists, (lists) => lists.addItem({ text: p.name, dedupeKey: listKey(row.id) })).pipe(
          Effect.timeoutOption(LISTS_TIMEOUT_MS),
          Effect.map((o) => o._tag === "Some"),
          Effect.catchTag("ProviderOff", () => Effect.succeed(false)),
          Effect.catchTag("ListsError", () => Effect.succeed(false))
        )
        if (!ok) break
        listed++
      }
    }
    return { folded, repaired, orphans, listed } satisfies TidyReport
  })
