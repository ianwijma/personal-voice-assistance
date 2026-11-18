// What the kitchen keeps, through the test kit: rows with every indexed field at its largest, reads past one list page
// and past the bound of one answer, the nightly job across a restart, and settings the form refuses.
import { assert, describe, it } from "@effect/vitest"
import { provide, startTestModule, stubService } from "@pva/core/testing"
import { Lists, type ListsService } from "@pva/module-contracts"
import { Effect } from "effect"
import { bookings, kitchenModule, names, products, recipes, TIDY_CRON } from "../src/index.ts"
import { listKey, PRODUCT_SCAN } from "../src/pantry.ts"

const DAY = 86_400_000
const said = (r: { readonly value: unknown }) => r.value as string
const product = (name: string, stock: number, extra: { readonly min?: number; readonly low?: boolean } = {}) => ({
  name,
  key: name,
  unit: "g" as const,
  stock,
  approx: false,
  uncertain: false,
  low: extra.low ?? stock <= 0,
  aliases: [],
  ...(extra.min !== undefined ? { min: extra.min } : {})
})

describe("kitchen: what it stores", () => {
  it.effect("stores a row of each collection with every indexed field at its largest", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      const id = "i".repeat(40)
      yield* k.moduleStore().transaction((tx) => {
        tx.collection(products).insert({ ...product("k".repeat(40), 1_000_000), low: true }, { id })
        tx.collection(names).insert({ key: "k".repeat(40), product: id })
        tx.collection(bookings).insert({ product: id, kind: "add", delta: 1_000_000, approx: true, approxBefore: false, uncertainBefore: false, at: 8_640_000_000_000_000, device: "d".repeat(64) })
        tx.collection(recipes).insert({ title: "T".repeat(60), titleKey: "t".repeat(60), servings: 50, minutes: 1_440, ingredients: [{ key: "x".repeat(40), amount: 1_000_000, unit: "piece" }], allergens: [], diets: [], source: "assistant" })
      })
      assert.strictEqual((yield* k.moduleStore().collection(products).list({ where: { low: true }, orderBy: { field: "key", direction: "asc" } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(names).list({ where: { key: "k".repeat(40) } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({ where: { device: "d".repeat(64) }, orderBy: { field: "at", direction: "desc" } })).length, 1)
      assert.strictEqual((yield* k.moduleStore().collection(recipes).list({ orderBy: { field: "minutes", direction: "desc" } }))[0]?.value.minutes, 1_440)
    }))

  it.effect("reads more products than one list returns, and says so when one answer's bound cuts it short", () =>
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
      // Thirty in stock, after the thirty empty ones in name order: the overview reads past the first page to find them.
      yield* write(30, 60, 100)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", {})), "In the pantry: 100 grams of item 030, 100 grams of item 031, 100 grams of item 032, 100 grams of item 033, 100 grams of item 034 and 25 more.")
      // Past the bound of one answer.
      yield* write(60, PRODUCT_SCAN + 10, 100)
      assert.include(said(yield* k.tool("kitchen_stock_query", {})), `I read the first ${PRODUCT_SCAN} products; there are more.`)
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
      const refused = yield* k.configure({ keepDays: 2_000 })
      assert.isFalse(refused.ok)
      assert.isFalse((yield* k.configure({ cup: "imperial" })).ok)
      assert.isFalse((yield* k.configure({ assumed: ["x".repeat(41)] })).ok)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a cup of milk" })), "Added 1 cup of milk; milk is new in the pantry.")
      // A US cup, saved properly.
      assert.isTrue((yield* k.configure({ cup: "us" })).ok)
      yield* k.tool("kitchen_stock_add", { what: "a cup of milk" })
      const [milk] = yield* k.moduleStore().collection(products).list({ where: { key: "milk" } })
      assert.strictEqual(milk!.value.stock, 486.588)
    }))
})

describe("kitchen: the nightly job", () => {
  it.effect("folds old bookings into one, keeps the sum, repairs a sum that differs, removes strays, and lists low stock; across a restart", () =>
    Effect.gen(function*() {
      const lists = stubService<ListsService>("lists", {
        addItem: (r) => Effect.succeed({ outcome: "updated", item: { id: "item-1", text: r.text, status: "open" } })
      })
      const k = yield* startTestModule(kitchenModule, { settings: { keepDays: 30 }, provide: [provide("lists", { services: [Lists.of(lists.service)] })] })
      const job = (yield* k.jobs).find((j) => j.handler === "tidy")!
      assert.strictEqual(job.cron, TIDY_CRON)
      const now = yield* k.now
      const store = k.moduleStore()
      // Rice: three old bookings and one recent; flour: a sum on its row that is not its ledger's; a stray booking.
      const ids = yield* store.transaction((tx) => {
        const rice = tx.collection(products).insert(product("rice", 1_100))
        tx.collection(names).insert({ key: "rice", product: rice.id })
        const at = (days: number) => now - days * DAY
        const b = (delta: number, days: number) => tx.collection(bookings).insert({ product: rice.id, kind: delta > 0 ? "add" : "use", delta, approx: false, approxBefore: false, uncertainBefore: false, at: at(days) })
        b(1_000, 60)
        b(-200, 50)
        b(500, 40)
        b(-200, 1)
        const flour = tx.collection(products).insert(product("flour", 999, { min: 500 }))
        tx.collection(names).insert({ key: "flour", product: flour.id })
        tx.collection(bookings).insert({ product: flour.id, kind: "add", delta: 300, approx: false, approxBefore: false, uncertainBefore: false, at: at(2) })
        tx.collection(bookings).insert({ product: "gone-product", kind: "add", delta: 5, approx: false, approxBefore: false, uncertainBefore: false, at: at(90) })
        return { rice: rice.id, flour: flour.id }
      })
      // The job's row survives a restart of the module (the start keeps it, it does not replace it), and then runs.
      yield* k.restart
      assert.deepStrictEqual((yield* k.jobs).filter((j) => j.state === "scheduled").map((j) => j.id), [job.id])
      yield* k.runJob(job.id)
      const ledger = yield* store.collection(bookings).list({ where: { product: ids.rice }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((r) => [r.value.kind, r.value.delta]), [["carry", 1_300], ["use", -200]])
      assert.strictEqual((yield* store.collection(products).get(ids.rice))?.value.stock, 1_100)
      // Flour's row said 999 while its ledger sums to 300: the ledger wins, and it is below its minimum now.
      const flour = (yield* store.collection(products).get(ids.flour))!.value
      assert.strictEqual(flour.stock, 300)
      assert.isTrue(flour.low)
      assert.deepStrictEqual(lists.calls.addItem, [[{ text: "flour", dedupeKey: listKey(ids.flour) }]])
      assert.deepStrictEqual(yield* store.collection(bookings).list({ where: { product: "gone-product" }, orderBy: { field: "at", direction: "asc" } }), [])
      // Run again (it is idempotent): nothing more to fold, nothing to repair, flour listed again under the same key.
      yield* k.runJob(job.id)
      assert.strictEqual((yield* store.collection(bookings).list({ where: { product: ids.rice }, orderBy: { field: "at", direction: "asc" } })).length, 2)
      assert.strictEqual(lists.calls.addItem?.length, 2)
      const runs = (yield* k.jobs).find((j) => j.id === job.id)
      assert.strictEqual(runs?.state, "scheduled")
      // A change the job folds away still reads the same.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice" })), "You have 1.1 kilograms of rice.")
    }))

  it.effect("runs at 03:30 by itself, and without the lists module it books what it can and lists nothing", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      yield* k.tool("kitchen_stock_out", { what: "milk" })
      // 10:00 in Amsterdam now: the next 03:30 is seventeen and a half hours away.
      const before = (yield* k.jobs).find((j) => j.handler === "tidy")!
      assert.strictEqual(before.dueAt - (yield* k.now), 17.5 * 3_600_000)
      yield* k.advance(17.5 * 3_600_000 + 60_000)
      const after = (yield* k.jobs).find((j) => j.handler === "tidy")!
      assert.strictEqual(after.dueAt, before.dueAt + DAY)
      assert.strictEqual(after.state, "scheduled")
      assert.isUndefined(after.lastError)
    }))
})
