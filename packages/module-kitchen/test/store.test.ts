// What the kitchen keeps, through the test kit: rows with every indexed field at its largest, reads past one list page
// and past the bound of one answer, the nightly job (across a restart, cut short in the middle, and bounded nights that
// carry on), the migration from data version 1, and settings the form refuses.
import { assert, describe, it } from "@effect/vitest"
import { fails, provide, startTestModule, stubService } from "@pva/core/testing"
import { Lists, ListsError, type ListItem, type ListsService } from "@pva/module-contracts"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { bookings, forgotten, kitchenModule, names, products, recipes, TIDY_CRON } from "../src/index.ts"
import { Booking, Product, Recipe } from "../src/data.ts"
import { listKey, PRODUCT_SCAN } from "../src/pantry.ts"
import { LOW_SCAN } from "../src/pantryActions.ts"
import { tidy } from "../src/tidy.ts"

const DAY = 86_400_000
// The tool's answer without the host's note of what it did with the screen (a line after it, only for `stock_low`).
const said = (r: { readonly value: unknown }) => (r.value as string).split("\n[Screen:")[0]!
const product = (name: string, stock: number, extra: { readonly min?: number; readonly low?: boolean; readonly unknown?: boolean } = {}) => ({
  name,
  key: name,
  unit: "g" as const,
  stock,
  unknown: extra.unknown ?? false,
  low: extra.low ?? (stock <= 0 || (extra.min !== undefined && stock < extra.min)),
  aliases: [],
  tidiedAt: 0,
  listedAt: 0,
  ...(extra.min !== undefined ? { min: extra.min } : {})
})
const booking = (productId: string, delta: number, at: number) => ({ product: productId, kind: delta > 0 ? "add" as const : "use" as const, delta, approx: false, unknownBefore: false, at })

/** A stub that keeps items by key, as the lists module does, so a test sees the list's state. */
const statefulLists = () => {
  const items = new Map<string, ListItem>()
  const add = (r: Parameters<ListsService["addItem"]>[0]) =>
    Effect.sync(() => {
      const had = items.get(r.dedupeKey!)
      const item: ListItem = { id: had?.id ?? `item-${items.size + 1}`, text: r.text, status: "open", dedupeKey: r.dedupeKey! }
      items.set(r.dedupeKey!, item)
      return { outcome: had === undefined ? "added" as const : had.status === "done" ? "reopened" as const : "updated" as const, item }
    })
  const complete = (key: string) =>
    Effect.sync(() => {
      const had = items.get(key)
      if (had === undefined || had.status === "done") return undefined
      const done: ListItem = { ...had, status: "done" }
      items.set(key, done)
      return done
    })
  const stub = stubService<ListsService>("lists", { addItem: add, completeByKey: complete })
  return { stub, items, add, complete }
}

describe("kitchen: what it stores", () => {
  it.effect("stores a row of each collection with every indexed field at its largest", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      const id = "i".repeat(40)
      const max = 8_640_000_000_000_000
      yield* k.moduleStore().transaction((tx) => {
        tx.collection(products).insert({ ...product("k".repeat(40), 1_000_000), low: true, tidiedAt: max, listedAt: max }, { id })
        tx.collection(names).insert({ key: "k".repeat(40), product: id })
        tx.collection(bookings).insert({ product: id, kind: "add", delta: 1_000_000, approx: true, unknownBefore: false, at: max, device: "d".repeat(64) })
        tx.collection(recipes).insert({ title: "T".repeat(60), titleKey: "t".repeat(60), servings: 50, minutes: 1_440, ingredients: [{ key: "x".repeat(40), amount: 1_000_000, unit: "piece" }], allergens: ["gluten", "crustaceans", "eggs", "fish", "peanuts", "soybeans", "milk", "nuts", "celery", "mustard", "sesame", "sulphites", "lupin", "molluscs"], declared: true, diets: [], source: "assistant" })
        tx.collection(forgotten).insert({ product: id }, { id })
      })
      assert.strictEqual((yield* k.moduleStore().collection(products).list({ where: { low: true }, orderBy: { field: "key", direction: "asc" } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(products).list({ orderBy: { field: "tidiedAt", direction: "desc" } }))[0]?.value.tidiedAt, max)
      assert.strictEqual((yield* k.moduleStore().collection(products).list({ orderBy: { field: "listedAt", direction: "desc" } }))[0]?.value.listedAt, max)
      assert.strictEqual((yield* k.moduleStore().collection(names).list({ where: { key: "k".repeat(40) } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({ where: { device: "d".repeat(64) }, orderBy: { field: "at", direction: "desc" } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({ where: { product: id }, orderBy: { field: "at", direction: "desc" } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(recipes).list({ orderBy: { field: "minutes", direction: "desc" } }))[0]?.value.minutes, 1_440)
    }))

  it.effect("reads more products than one list returns, and says so whenever a bound cut a read short (finding 10)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      const write = (from: number, to: number, stock: number) =>
        k.moduleStore().transaction((tx) => {
          for (let n = from; n < to; n++) {
            const name = `item ${String(n).padStart(3, "0")}`
            const row = tx.collection(products).insert(product(name, stock))
            tx.collection(names).insert({ key: name, product: row.id })
          }
        })
      // Thirty low products: more than one page (25) of the low index.
      yield* write(0, 30, 0)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), "Running low: item 000, item 001, item 002, item 003, item 004 and 25 more.")
      yield* write(30, 60, 100)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", {})), "In the pantry: 100 grams of item 030, 100 grams of item 031, 100 grams of item 032, 100 grams of item 033, 100 grams of item 034 and 25 more.")
      // More low products than one answer reads: no count of the rest, and said.
      yield* write(60, 60 + LOW_SCAN, 0)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), `Running low: item 000, item 001, item 002, item 003, item 004 and more. I read the first ${LOW_SCAN} of them; there are more.`)
    }))

  it.effect("an overview whose read was cut never says the pantry is empty (finding 10)", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.moduleStore().transaction((tx) => {
        for (let n = 0; n < PRODUCT_SCAN; n++) {
          const name = `item ${String(n).padStart(3, "0")}`
          const row = tx.collection(products).insert(product(name, 0))
          tx.collection(names).insert({ key: name, product: row.id })
        }
      })
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", {})), `None of the first ${PRODUCT_SCAN} products I read is in stock; there are more I didn't read.`)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice" })), "You have 1 kilogram of rice.")
    }))

  it.effect("the pantry outlives a restart and a stop and a start; the tools are gone while it is off", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.restart
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice" })), "You have 1 kilogram of rice.")
      yield* k.stop
      assert.notInclude(k.toolNames(), "kitchen_stock_query")
      yield* k.start
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone; rice is out of the pantry again.")
    }))

  it.effect("settings the form refuses: the module does not start with them, and a running one keeps its own", () =>
    Effect.gen(function*() {
      const bad = yield* startTestModule(kitchenModule, { settings: { keepDays: 3 } })
      assert.notInclude(bad.toolNames(), "kitchen_stock_add")
      assert.isTrue(bad.issues().length > 0)
      const k = yield* startTestModule(kitchenModule)
      assert.isFalse((yield* k.configure({ keepDays: 2_000 })).ok)
      assert.isFalse((yield* k.configure({ cup: "imperial" })).ok)
      assert.isFalse((yield* k.configure({ assumed: ["x".repeat(41)] })).ok)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a cup of milk" })), "Added 1 cup of milk; milk is new in the pantry.")
      assert.isTrue((yield* k.configure({ cup: "us" })).ok)
      yield* k.tool("kitchen_stock_add", { what: "a cup of milk" })
      const [milk] = yield* k.moduleStore().collection(products).list({ where: { key: "milk" } })
      assert.strictEqual(milk!.value.stock, 486.588)
    }))

  it.effect("data version 1 is migrated: unknown stock, Dutch keys, flags, and a declaration that was never complete", () =>
    Effect.sync(() => {
      const product1 = { name: "tomaten", key: "tomaten", unit: "g", stock: 400, approx: true, uncertain: false, low: false, aliases: ["tomatoes"] }
      const p = Schema.decodeUnknownSync(Product)(products.migrate[1]!(product1))
      assert.deepStrictEqual(p, { name: "tomaten", key: "tomaat", unit: "g", stock: 400, unknown: true, low: false, aliases: ["tomato"], tidiedAt: 0, listedAt: 0 })
      const b = Schema.decodeUnknownSync(Booking)(bookings.migrate[1]!({ product: "x", kind: "use", delta: 0, approx: true, uncertain: true, approxBefore: false, uncertainBefore: true, at: 5, undoes: "y" }))
      assert.deepStrictEqual(b, { product: "x", kind: "use", delta: 0, approx: true, unknownBefore: true, at: 5 })
      const r = Schema.decodeUnknownSync(Recipe)(recipes.migrate[1]!({ title: "Eieren", titleKey: "eieren", servings: 2, minutes: 5, ingredients: [{ key: "eieren", amount: 2, unit: "piece" }], allergens: ["ei", "kiwi"], diets: [], source: "own" }))
      assert.deepStrictEqual(r, { title: "Eieren", titleKey: "ei", servings: 2, minutes: 5, ingredients: [{ key: "ei", amount: 2, unit: "piece" }], allergens: ["eggs"], declared: false, diets: [], source: "own" })
      assert.deepStrictEqual(names.migrate[1]!({ key: "uien", product: "x" }), { key: "ui", product: "x" })
    }))
})

describe("kitchen: the nightly job", () => {
  it.effect("folds old bookings into one, keeps the sum, repairs a sum that differs, finishes forgetting, and lists low stock; across a restart", () =>
    Effect.gen(function*() {
      const { stub, items } = statefulLists()
      const k = yield* startTestModule(kitchenModule, { settings: { keepDays: 30 }, provide: [provide("lists", { services: [Lists.of(stub.service)] })] })
      const job = (yield* k.jobs).find((j) => j.handler === "tidy")!
      assert.strictEqual(job.cron, TIDY_CRON)
      const now = yield* k.now
      const store = k.moduleStore()
      const ids = yield* store.transaction((tx) => {
        const rice = tx.collection(products).insert(product("rice", 1_100))
        tx.collection(names).insert({ key: "rice", product: rice.id })
        const at = (days: number) => now - days * DAY
        for (const [delta, days] of [[1_000, 60], [-200, 50], [500, 40], [-200, 1]] as const) tx.collection(bookings).insert(booking(rice.id, delta, at(days)))
        const flour = tx.collection(products).insert(product("flour", 999, { min: 500 }))
        tx.collection(names).insert({ key: "flour", product: flour.id })
        tx.collection(bookings).insert(booking(flour.id, 300, at(2)))
        // A product forgotten while a restart cut its forgetting short: its row is gone, 150 bookings are left.
        for (let n = 0; n < 150; n++) tx.collection(bookings).insert(booking("gone-product", 5, at(90) + n))
        tx.collection(forgotten).insert({ product: "gone-product" }, { id: "gone-product" })
        return { rice: rice.id, flour: flour.id }
      })
      yield* k.restart
      assert.deepStrictEqual((yield* k.jobs).filter((j) => j.state === "scheduled").map((j) => j.id), [job.id])
      yield* k.runJob(job.id)
      const ledger = yield* store.collection(bookings).list({ where: { product: ids.rice }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((r) => [r.value.kind, r.value.delta]), [["carry", 1_300], ["use", -200]])
      assert.strictEqual((yield* store.collection(products).get(ids.rice))?.value.stock, 1_100)
      const flour = (yield* store.collection(products).get(ids.flour))!.value
      assert.strictEqual(flour.stock, 300)
      assert.isTrue(flour.low)
      assert.strictEqual(items.get(listKey(ids.flour))?.status, "open")
      assert.deepStrictEqual(yield* store.collection(bookings).list({ where: { product: "gone-product" }, orderBy: { field: "at", direction: "asc" } }), [])
      assert.deepStrictEqual(yield* store.collection(forgotten).list({}), [])
      // Run again (it is idempotent): nothing more to fold, nothing to repair, flour's one item kept.
      yield* k.advance(DAY)
      yield* k.runJob(job.id)
      assert.strictEqual((yield* store.collection(bookings).list({ where: { product: ids.rice }, orderBy: { field: "at", direction: "asc" } })).length, 2)
      assert.strictEqual(items.size, 1)
      assert.strictEqual((yield* k.jobs).find((j) => j.id === job.id)?.state, "scheduled")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice" })), "You have 1.1 kilograms of rice.")
    }))

  it.effect("cut short in the middle by a restart, the next run carries on: nothing folded twice, every list item right (finding 20)", () =>
    Effect.gen(function*() {
      const { stub, items, add } = statefulLists()
      const k = yield* startTestModule(kitchenModule, { settings: { keepDays: 30 }, provide: [provide("lists", { services: [Lists.of(stub.service)] })] })
      const now = yield* k.now
      const store = k.moduleStore()
      const ids = yield* store.transaction((tx) =>
        ["apple", "bread", "cheese"].map((name) => {
          const row = tx.collection(products).insert(product(name, 0))
          tx.collection(names).insert({ key: name, product: row.id })
          tx.collection(bookings).insert(booking(row.id, 100, now - 60 * DAY))
          tx.collection(bookings).insert(booking(row.id, -100, now - 50 * DAY))
          return row.id
        })
      )
      // The list hangs on the second product: the run is cut off there, as a restart would.
      const hung = yield* Deferred.make<void>()
      let calls = 0
      stub.answer("addItem", (r) => (++calls === 2 ? Effect.andThen(Deferred.succeed(hung, undefined), Effect.never) : add(r)))
      const settings = { lowStockToList: true, listWhenOut: true, keepDays: 30 }
      const host = { service: () => stub.service } as never
      const run = yield* Effect.forkChild(tidy({ store, host, settings, now, actor: { kind: "job", jobId: "j" } }))
      yield* Deferred.await(hung)
      yield* Fiber.interrupt(run)
      assert.strictEqual([...items.values()].length, 1)
      // The real job, after the restart: everything folded once, every product's item there.
      stub.answer("addItem", add)
      yield* k.restart
      const job = (yield* k.jobs).find((j) => j.handler === "tidy")!
      yield* k.runJob(job.id)
      for (const id of ids) {
        const ledger = yield* store.collection(bookings).list({ where: { product: id }, orderBy: { field: "at", direction: "asc" } })
        assert.deepStrictEqual(ledger.map((b) => [b.value.kind, b.value.delta]), [["carry", 0]])
        assert.strictEqual(items.get(listKey(id))?.status, "open")
      }
    }))

  it.effect("a bounded night carries on where the last one stopped: a prefix of skipped products never starves the rest (finding 11)", () =>
    Effect.gen(function*() {
      const { stub, items } = statefulLists()
      const k = yield* startTestModule(kitchenModule, { settings: { listWhenOut: false }, provide: [provide("lists", { services: [Lists.of(stub.service)] })] })
      const store = k.moduleStore()
      // 500 products with none left and no minimum (not for the list with `listWhenOut` off), then one below its minimum.
      const low = yield* store.transaction((tx) => {
        for (let n = 0; n < 500; n++) tx.collection(products).insert(product(`item ${String(n).padStart(3, "0")}`, 0))
        return tx.collection(products).insert(product("zucchini", 1, { min: 10 })).id
      })
      const job = (yield* k.jobs).find((j) => j.handler === "tidy")!
      yield* k.runJob(job.id)
      yield* k.advance(DAY)
      yield* k.runJob(job.id)
      assert.strictEqual(items.get(listKey(low))?.status, "open")
      // The same with a small night, run directly: three nights of two products reach all five.
      const t = yield* startTestModule(kitchenModule)
      const ts = t.moduleStore()
      const five = yield* ts.transaction((tx) => Array.from({ length: 5 }, (_, n) => tx.collection(products).insert(product(`p${n}`, 1)).id))
      const settings = { lowStockToList: false, listWhenOut: true, keepDays: 90 }
      for (let night = 1; night <= 3; night++) {
        yield* tidy({ store: ts, host: undefined as never, settings, now: night * DAY, actor: { kind: "job", jobId: "j" }, bounds: { products: 2 } })
      }
      for (const id of five) assert.isAbove((yield* ts.collection(products).get(id))!.value.tidiedAt, 0)
    }))

  it.effect("brings the list back in line after a failed tick-off and after an item another device added late (finding 6)", () =>
    Effect.gen(function*() {
      const { stub, items, add, complete } = statefulLists()
      const k = yield* startTestModule(kitchenModule, { provide: [provide("lists", { services: [Lists.of(stub.service)] })] })
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      yield* k.tool("kitchen_stock_out", { what: "milk" })
      const [milk] = yield* k.moduleStore().collection(products).list({ where: { key: "milk" } })
      assert.strictEqual(items.get(listKey(milk!.id))?.status, "open")
      // Restocked while ticking off fails: said, and the item stays open for now.
      stub.answer("completeByKey", fails(new ListsError({ reason: "busy", detail: "locked" })))
      assert.include(said(yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })), "I couldn't update the shopping list for milk.")
      assert.strictEqual(items.get(listKey(milk!.id))?.status, "open")
      // The night, with the list back: ticked off.
      stub.answer("completeByKey", complete)
      const job = (yield* k.jobs).find((j) => j.handler === "tidy")!
      yield* k.runJob(job.id)
      assert.strictEqual(items.get(listKey(milk!.id))?.status, "done")
      // An item for stocked milk that arrived late (an add that committed after its time limit): the night ticks it off.
      yield* add({ text: "milk", dedupeKey: listKey(milk!.id) })
      yield* k.advance(DAY)
      yield* k.runJob(job.id)
      assert.strictEqual(items.get(listKey(milk!.id))?.status, "done")
    }))

  it.effect("runs at 03:30 by itself, and without the lists module it books what it can and lists nothing", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      yield* k.tool("kitchen_stock_out", { what: "milk" })
      const before = (yield* k.jobs).find((j) => j.handler === "tidy")!
      assert.strictEqual(before.dueAt - (yield* k.now), 17.5 * 3_600_000)
      yield* k.advance(17.5 * 3_600_000 + 60_000)
      const after = (yield* k.jobs).find((j) => j.handler === "tidy")!
      assert.strictEqual(after.dueAt, before.dueAt + DAY)
      assert.strictEqual(after.state, "scheduled")
      assert.isUndefined(after.lastError)
    }))
})
