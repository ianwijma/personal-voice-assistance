// The pantry ledger through the test kit: every action and tool on its ordinary path and its refusals, as turns of
// the default household, in the real host, gateway and store, with a programmed stub of the `Lists` service.
import { assert, describe, it } from "@effect/vitest"
import { extractText, type StoreTx } from "@pva/core"
import { fails, provide, startTestModule, stops, stubService } from "@pva/core/testing"
import { Lists, ListsError, type ListItem, type ListsService } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { bookings, forgotten, kitchenModule, names, products } from "../src/index.ts"
import { book, listKey } from "../src/pantry.ts"
import { pantryActions } from "../src/pantryActions.ts"

/** A stub of the shopping list that adds every item and finds nothing to tick off, unless a test programs otherwise. */
const listsStub = () =>
  stubService<ListsService>("lists", {
    addItem: (r) => Effect.succeed({ outcome: "added", item: { id: "item-1", text: r.text, status: "open", ...(r.dedupeKey !== undefined ? { dedupeKey: r.dedupeKey } : {}) } }),
    completeByKey: () => Effect.succeed(undefined)
  })

/**
 * A stub that keeps the items it was given by key, as the contract says the lists module does: so a test can see the
 * list's state after calls that arrive late or out of order.
 */
const statefulLists = () => {
  const items = new Map<string, ListItem>()
  const add = (r: Parameters<ListsService["addItem"]>[0]) =>
    Effect.sync(() => {
      const key = r.dedupeKey!
      const had = items.get(key)
      const item: ListItem = { id: had?.id ?? `item-${items.size + 1}`, text: r.text, status: "open", dedupeKey: key }
      items.set(key, item)
      return { outcome: had === undefined ? "added" as const : had.status === "done" ? "reopened" as const : "updated" as const, item }
    })
  const stub = stubService<ListsService>("lists", {
    addItem: add,
    completeByKey: (key) =>
      Effect.sync(() => {
        const had = items.get(key)
        if (had === undefined || had.status === "done") return undefined
        const done: ListItem = { ...had, status: "done" }
        items.set(key, done)
        return done
      })
  })
  return { stub, items, add }
}

const withLists = (lists: ReturnType<typeof listsStub>, extra: Parameters<typeof startTestModule>[1] = {}) =>
  startTestModule(kitchenModule, { ...extra, provide: [provide("lists", { services: [Lists.of(lists.service)] })] })

const said = (r: { readonly value: unknown }) => r.value as string
/** What an action said, or why it did not run. */
const spoken = (r: { readonly ok: boolean; readonly say?: string | undefined; readonly message?: string }) => (r.ok ? r.say : `not run: ${r.message}`)
const dutch = { household: { home: { HOME_LANGUAGE: "nl-NL" } } }

describe("kitchen: the pantry ledger", () => {
  it.effect("adds, uses and reads back, with the amounts said", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "200 grams of rice" })), "Added 200 grams of rice; rice is new in the pantry.")
      yield* k.advance(1_000)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a kilo of rice to the pantry" })), "Added 1 kilogram of rice. You now have 1.2 kilograms of rice.")
      yield* k.advance(1_000)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "250 grams of rice" })), "Okay, 950 grams of rice left.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice is left" })), "You have 950 grams of rice.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "six eggs" })), "Added 6 eggs; eggs is new in the pantry.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", {})), "In the pantry: 6 eggs and 950 grams of rice.")
      // The ledger: every change is a booking, and their sum is the stock.
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      const ledger = yield* k.moduleStore().collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((b) => [b.value.kind, b.value.delta]), [["add", 200], ["add", 1000], ["use", -250]])
      assert.strictEqual(ledger.reduce((s, b) => s + b.value.delta, 0), rice!.value.stock)
      assert.strictEqual(ledger[0]!.value.device, "kitchen-display")
      assert.deepStrictEqual(lists.calls.addItem ?? [], [])
    }))

  it.effect("never goes below zero: using more than is on record sets it to none and puts it on the shopping list", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists)
      yield* k.tool("kitchen_stock_add", { what: "200 grams of flour" })
      const r = yield* k.tool("kitchen_stock_use", { what: "500 grams of flour" })
      assert.strictEqual(said(r), "I only had 200 grams of flour on record, so I've set flour to none. Flour is on the shopping list.")
      const [flour] = yield* k.moduleStore().collection(products).list({ where: { key: "flour" } })
      assert.strictEqual(flour!.value.stock, 0)
      assert.isTrue(flour!.value.low)
      assert.deepStrictEqual(lists.calls.addItem, [[{ text: "flour", dedupeKey: listKey(flour!.id) }]])
    }))

  it.effect("stock is known or unknown: an approximate booking makes it unknown, and every answer says so (findings 13, 8)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "400 grams of cheese" })
      yield* k.tool("kitchen_stock_add", { what: "six eggs" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "some of the cheese" })), "Okay. I don't know how much cheese is left now; tell me how much when you know.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "cheese" })), "I don't know exactly how much cheese there is; last I knew, about 400 grams of cheese.")
      // The overview says the same as the named query: never the last known amount as stock.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", {})), "In the pantry: cheese (last I knew, about 400 grams) and 6 eggs.")
      // An exact change after it: the confirmation does not announce a current total.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "200 grams of cheese" })), "Added 200 grams of cheese. I don't know exactly how much cheese there is now; last I knew, about 600 grams of cheese.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "100 grams of cheese" })), "Okay. I don't know exactly how much cheese there is now; last I knew, about 500 grams of cheese.")
      // "About" is approximate too.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "about 2 eggs" })), "Okay. I don't know exactly how much eggs there is now; last I knew, about 4 eggs.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_set", { what: "about 150 grams of cheese left" })), "Okay, I've noted about 150 grams of cheese; tell me the exact amount when you know it.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "cheese" })), "I don't know exactly how much cheese there is; last I knew, about 150 grams of cheese.")
      // Set exactly, it is known again.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_set", { what: "150 grams of cheese left" })), "Okay, you have 150 grams of cheese.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "cheese" })), "You have 150 grams of cheese.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "the rest of the cheese" })), "Okay, no cheese left. Cheese is on the shopping list.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "cheese" })), "How much cheese did you use?")
    }))

  it.effect("a package size is exact or not kept; bags of an unknown size make the stock unknown (finding 14)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rice", package: "about 900 grams" })).value, {
        spoken: "I only keep an exact package size; how much does one package of rice hold exactly?"
      })
      const [before] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      assert.isUndefined(before!.value.pack)
      // Two bags of a size not known: booked, and the stock is not known any more.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "two bags of rice" })), "I don't know how much one package of rice holds, so I don't know how much there is now. Tell me how much a package holds, and how much there is.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice" })), "I don't know exactly how much rice there is; last I knew, about 1 kilogram of rice.")
      // The undo of that booking is exact: the kilogram is known again.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone. You now have 1 kilogram of rice.")
      // An exact size: bags are booked exactly, used exactly, and undone exactly.
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rice", package: "900 grams" })).value, { spoken: "Rice: a package holds 900 grams." })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "two bags of rice" })), "Added 2 bags of rice. You now have 2.8 kilograms of rice.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "a bag of rice" })), "Okay, 1.9 kilograms of rice left.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone. You now have 2.8 kilograms of rice.")
    }))

  it.effect("asks instead of guessing: an unknown product, another unit, a package of unknown size, two things at once", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 grams of rise" })), "There's no rise in the pantry. Did you mean rice?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 grams of basmati" })), "There's no basmati in the pantry.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a litre of rice" })), "I keep rice in grams; how much is that in grams?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "two bags of pasta" })), "How much does one package of pasta hold? Tell me and I'll remember it.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "rice and pasta" })), "One thing at a time, please: how much of what?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "pasta" })), "How much pasta?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "2 2 rice" })), "How much of what? Say for example: a kilo of rice.")
      // Nothing was booked by any of those.
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({})).length, 1)
      const set = yield* k.tool("kitchen_product_set", { item: "rice", package: "1 kg" })
      assert.deepStrictEqual(set.value, { spoken: "Rice: a package holds 1 kilogram." })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "rice" })), "Added 1 kilogram of rice. You now have 2 kilograms of rice.")
    }))

  it.effect("an amount that does not fit is refused whole, never cut to fit (finding 3, the upper limit)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_set", { what: "999999 grams of rice" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })), "That is more rice than I can keep track of; nothing was booked.")
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      assert.strictEqual(rice!.value.stock, 999_999)
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" } })).length, 1)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "2000 kilos of flour" })), "That is more flour than I can keep track of; nothing was booked.")
    }))

  it.effect("a booking and its product row are written together: a failure between them leaves neither (finding 20)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      const store = k.moduleStore()
      const [rice] = yield* store.collection(products).list({ where: { key: "rice" } })
      // The product row's write fails after the booking was inserted, as a store failure would.
      const failing = (tx: StoreTx): StoreTx => ({
        ...tx,
        collection: ((c: unknown) => {
          const handle = tx.collection(c as never)
          return c === products ? { ...handle, update: () => { throw new Error("injected store failure") } } : handle
        }) as StoreTx["collection"]
      })
      const result = yield* Effect.exit(store.transaction((tx) => book(failing(tx), rice!, { kind: "use", delta: -100, approx: false }, 0)))
      assert.isTrue(result._tag === "Failure")
      const ledger = yield* store.collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((b) => b.value.delta), [1000])
      assert.strictEqual((yield* store.collection(products).get(rice!.id))?.value.stock, 1000)
    }))

  it.effect("bookings of one product at once, from several devices, are one at a time: the sum is every one of them (finding 20)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "2 kilos of rice" })
      const devices = ["kitchen-display", "robins-phone", "hall-screen"] as const
      const results = yield* Effect.all(
        Array.from({ length: 12 }, (_, n) => k.tool("kitchen_stock_use", { what: "100 grams of rice" }, { device: devices[n % 3]! })),
        { concurrency: "unbounded" }
      )
      assert.isTrue(results.every((r) => r.ok))
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      const ledger = yield* k.moduleStore().collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" }, limit: 31 })
      assert.strictEqual(ledger.length, 13)
      assert.strictEqual(rice!.value.stock, 800)
      assert.strictEqual(ledger.reduce((s, b) => s + b.value.delta, 0), 800)
      // Strictly in time order per product, also within one millisecond.
      assert.strictEqual(new Set(ledger.map((b) => b.value.at)).size, 13)
    }))
})

describe("kitchen: undo is one step", () => {
  it.effect("undoes the device's last booking within ten minutes; after it there is nothing more to undo (findings 4, 12)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      for (let n = 0; n < 10; n++) {
        yield* k.tool("kitchen_stock_add", { what: "100 grams of rice" })
        yield* k.advance(1_000)
      }
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone. You now have 900 grams of rice.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "There's nothing from this device to undo.")
      // A new booking can be undone again; one more than ten minutes old cannot.
      yield* k.tool("kitchen_stock_use", { what: "100 grams of rice" })
      yield* k.advance(10 * 60_000 + 1_000)
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "That was more than ten minutes ago, so I can't undo it; tell me how much rice there is instead.")
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      assert.strictEqual(rice!.value.stock, 800)
      // The public hall screen made nothing, so has nothing to undo.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "hall-screen" })), "There's nothing from this device to undo.")
    }))

  it.effect("refuses when another booking of the product came since: the reversal is always exact, never clamped (finding 3)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "1000 grams of rice" }, { device: "kitchen-display" })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_use", { what: "800 grams of rice" }, { device: "robins-phone" })
      yield* k.advance(1_000)
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "kitchen-display" })), "Rice was changed again since then, so I can't undo that exactly; tell me how much rice there is instead.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "robins-phone" })), "Undone. You now have 1 kilogram of rice.")
      // Robin's undo is now rice's last booking: the display's add is still not the last one.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "kitchen-display" })), "Rice was changed again since then, so I can't undo that exactly; tell me how much rice there is instead.")
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      const ledger = yield* k.moduleStore().collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((b) => [b.value.kind, b.value.delta]), [["add", 1000], ["use", -800], ["undo", 800]])
      assert.strictEqual(rice!.value.stock, 1000)
    }))

  it.effect("puts back whether the stock was known, exactly as it was before the booking (finding 12)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "1000 grams of rice" }, { device: "hall-screen" })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_use", { what: "some rice" }, { device: "kitchen-display" })
      yield* k.advance(1_000)
      // Undoing "some" makes it known again: nothing else was booked since.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "kitchen-display" })), "Undone. You now have 1 kilogram of rice.")
      yield* k.tool("kitchen_stock_use", { what: "some rice" }, { device: "kitchen-display" })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_use", { what: "100 grams of rice" }, { device: "robins-phone" })
      yield* k.advance(1_000)
      // "Some" is no longer rice's last booking: refused, and never a guess at the old state.
      assert.include(said(yield* k.tool("kitchen_undo", {}, { device: "kitchen-display" })), "can't undo that exactly")
      // Robin's undo restores the state before Robin's booking: unknown, last known a kilogram.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "robins-phone" })), "Undone. I don't know exactly how much rice there is now; last I knew, about 1 kilogram of rice.")
    }))

  it.effect("undoing the booking that made a product by mistake takes the product out again", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of ice" })
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone; ice is out of the pantry again.")
      assert.deepStrictEqual(yield* k.moduleStore().collection(products).list({}), [])
      assert.deepStrictEqual(yield* k.moduleStore().collection(names).list({}), [])
      assert.deepStrictEqual(yield* k.moduleStore().collection(bookings).list({ orderBy: { field: "at", direction: "asc" }, where: { device: "kitchen-display" } }), [])
    }))

  it.effect("undo outside a device's turn says it cannot", () =>
    Effect.gen(function*() {
      // A routine run from a job has no turn: the action's own code, outside the kit, with no `CurrentTurn`.
      const undo = kitchenModuleActions.find((a) => a.id === "undo")!
      const run = undo.run as (params: Record<string, never>) => ReturnType<typeof undo.run>
      assert.deepStrictEqual(yield* run({}), { say: "I can only undo a change on the device it was made on." })
    }))
})

describe("kitchen: the shopping list", () => {
  it.effect("a minimum puts a product on the shopping list once it falls below it, and ticks it off when it is back", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists)
      yield* k.tool("kitchen_stock_add", { what: "2.5 kilos of rice" })
      assert.strictEqual(said(yield* k.tool("kitchen_keep_minimum", { what: "two kilos of rice" })), "Okay, I'll keep at least 2 kilograms of rice in stock.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "a kilo of rice" })), "Okay, 1.5 kilograms of rice left. Rice is below your minimum of 2 kilograms, so it's on the shopping list.")
      // Already on the list: the same key updates the one item, and nothing new is said.
      lists.answer("addItem", (r) => Effect.succeed({ outcome: "updated", item: { id: "item-1", text: r.text, status: "open" } }))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "100 grams of rice" })), "Okay, 1.4 kilograms of rice left.")
      lists.answer("completeByKey", (key) => Effect.succeed({ id: "item-1", text: "rice", status: "done", dedupeKey: key }))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })), "Added 1 kilogram of rice. You now have 2.4 kilograms of rice. I've ticked rice off the shopping list.")
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      assert.deepStrictEqual((lists.calls.addItem ?? []).map(([r]) => r.dedupeKey), [listKey(rice!.id), listKey(rice!.id)])
      assert.deepStrictEqual(lists.calls.completeByKey, [[listKey(rice!.id)]])
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rice", noMinimum: true })).value, { spoken: "Rice: no minimum." })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rice", package: "1 kg", minimum: "two bags", alias: "rijst" })).value, {
        spoken: "Rice: keep at least 2 kilograms, a package holds 1 kilogram and also called rijst."
      })
    }))

  it.effect("we're out: none left, and on the list; 'what is running low' reads the low products by one index", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      yield* k.tool("kitchen_stock_add", { what: "six eggs" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), "Nothing is running low.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "milk" })), "Okay, no milk left. Milk is on the shopping list.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "cream" })), "There's no cream in the pantry.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), "Running low: milk.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "milk" })), "You have no milk left.")
    }))

  it.effect("when the list is full, failing, off or slow, the answer says it could not be updated, never that an item is absent (finding 18)", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists)
      yield* k.tool("kitchen_stock_add", { what: "five eggs" })
      yield* k.tool("kitchen_keep_minimum", { what: "six eggs" })
      // First put on the list under kitchen's key; later bookings meet a list that fails in every way.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 4 eggs left. Eggs is below your minimum of 6 pieces, so it's on the shopping list.")
      lists.answer("addItem", fails(new ListsError({ reason: "busy", detail: "locked" })))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 3 eggs left. I couldn't update the shopping list for eggs.")
      lists.answer("addItem", fails(new ListsError({ reason: "limit", detail: "500 open items" })))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 2 eggs left. The shopping list is full, so I couldn't add eggs to it.")
      lists.answer("addItem", stops())
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 1 eggs left. The Lists module is off, so I couldn't update the shopping list for eggs.")
      // A list that does not answer in time (its write may still commit later): the kitchen waits 1.5 s, not 5 s.
      lists.answer("addItem", () => Effect.never)
      const slow = yield* Effect.forkChild(k.tool("kitchen_stock_use", { what: "one egg" }))
      yield* k.advance(2_000)
      assert.strictEqual(said(yield* Fiber.join(slow)), "Okay, no eggs left. I couldn't update the shopping list for eggs.")
      // Back in stock while ticking off fails: said too, since the item may still be open.
      lists.answer("completeByKey", fails(new ListsError({ reason: "busy", detail: "locked" })))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "twelve eggs" })), "Added 12 eggs. You now have 12 eggs. I couldn't update the shopping list for eggs.")
      for (const r of [yield* k.moduleStore().collection(products).list({ where: { key: "egg" } })]) assert.strictEqual(r[0]!.value.stock, 12)
      const all = JSON.stringify(lists.calls)
      assert.notInclude(all, "isn't on")
    }))

  it.effect("a slow add and a later restock from another device: the list ends up right (finding 6)", () =>
    Effect.gen(function*() {
      const { stub, items, add } = statefulLists()
      const k = yield* withLists(stub)
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      const [milk] = yield* k.moduleStore().collection(products).list({ where: { key: "milk" } })
      // The add for "out of milk" takes a second to commit.
      stub.answer("addItem", (r) => Effect.andThen(Effect.sleep(1_000), add(r)))
      const out = yield* Effect.forkChild(k.tool("kitchen_stock_out", { what: "milk" }, { device: "kitchen-display" }))
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      // Robin restocks before that add has committed.
      const restock = yield* Effect.forkChild(k.tool("kitchen_stock_add", { what: "two litres of milk" }, { device: "robins-phone" }))
      yield* k.advance(1_200)
      yield* k.advance(1_200)
      assert.include(said(yield* Fiber.join(out)), "Milk is on the shopping list.")
      assert.include(said(yield* Fiber.join(restock)), "I've ticked milk off the shopping list.")
      // Milk is in stock, and its item is ticked off: the late add did not leave it open.
      assert.strictEqual(items.get(listKey(milk!.id))?.status, "done")
    }))

  it.effect("without the lists module at all, it says so and books anyway", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "milk" })), "Okay, no milk left. The Lists module is off, so I couldn't update the shopping list for milk.")
    }))

  it.effect("with the list settings off, low stock goes nowhere", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists, { settings: { lowStockToList: false } })
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "milk" })), "Okay, no milk left.")
      const out = yield* withLists(lists, { settings: { listWhenOut: false } })
      yield* out.tool("kitchen_stock_add", { what: "a litre of milk" })
      assert.strictEqual(said(yield* out.tool("kitchen_stock_out", { what: "milk" })), "Okay, no milk left.")
      assert.deepStrictEqual(lists.calls.addItem ?? [], [])
    }))
})

describe("kitchen: products", () => {
  it.effect("product settings: another name, names already taken, a product forgotten with its history", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.tool("kitchen_stock_add", { what: "500 grams of pasta" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rice", alias: "rijst" })).value, { spoken: "Rice: also called rijst." })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 gram rijst" })), "Okay, 800 grams of rice left.")
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "pasta", alias: "rijst" })).value, { spoken: "rijst is already the name of something in the pantry." })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "pasta" })).value, { spoken: "What should I change for pasta: a minimum, the package size or another name?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "pasta", minimum: "a litre" })).value, { spoken: "I keep pasta in grams; how much is that in grams?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "noodles", minimum: "1 kg" })).value, { spoken: "There's no noodles in the pantry." })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_forget", { item: "rice" })).value, { spoken: "Rice is no longer in the pantry. The daily backups keep it for up to 14 days." })
      assert.deepStrictEqual((yield* k.moduleStore().collection(names).list({})).map((n) => n.value.key), ["pasta"])
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({ where: { device: "kitchen-display" }, orderBy: { field: "at", direction: "asc" } })).length, 1)
      assert.deepStrictEqual((yield* k.tool("kitchen_product_forget", { item: "rice" })).value, { spoken: "There's no rice in the pantry." })
      // A name must be one line: refused before the module runs.
      assert.isFalse((yield* k.tool("kitchen_product_set", { item: "pasta", alias: "one\ntwo" })).ok)
    }))

  it.effect("forgetting a product with a long history removes every booking, and another product's undo still works (finding 5)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of ice" })
      const store = k.moduleStore()
      const [ice] = yield* store.collection(products).list({ where: { key: "ice" } })
      // 1,008 more bookings of ice, older than the purchase of rice below.
      for (let batch = 0; batch < 12; batch++) {
        yield* store.transaction((tx) => {
          for (let n = 0; n < 84; n++) tx.collection(bookings).insert({ product: ice!.id, kind: "add", delta: 0, approx: false, unknownBefore: false, at: 1_000 + batch * 100 + n, device: "kitchen-display" })
        })
      }
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_forget", { item: "ice" })).value, { spoken: "Ice is no longer in the pantry. The daily backups keep it for up to 14 days." })
      assert.deepStrictEqual(yield* store.collection(bookings).list({ where: { product: ice!.id }, orderBy: { field: "at", direction: "asc" } }), [])
      assert.deepStrictEqual(yield* store.collection(forgotten).list({}), [])
      // The rice purchase is the device's last booking, and rice's last: undone.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone; rice is out of the pantry again.")
    }))

  it.effect("speaks Dutch in a Dutch household: actions, questions, product settings, forgetting and the shopping list (finding 20)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub(), dutch)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "een kilo rijst" })), "1 kilo rijst toegevoegd; rijst is nieuw in de voorraad.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "250 gram rijst" })), "Oké, nog 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rijst" })), "Je hebt 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "rijst" })), "Hoeveel rijst heb je gebruikt?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "rijst" })), "Oké, geen rijst meer. Rijst staat op het boodschappenlijstje.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Ongedaan gemaakt. Je hebt nu 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Er is van dit apparaat niets om ongedaan te maken.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "wat rijst" })), "Oké. Ik weet nu niet hoeveel rijst er over is; zeg hoeveel als je het weet.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rijst" })), "Ik weet niet precies hoeveel rijst er is; het laatste dat ik wist: ongeveer 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 gram kaas" })), "Er is geen kaas in de voorraad.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), "Er is niets bijna op.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "rijst en pasta" })), "Eén ding tegelijk graag: hoeveel van wat?")
      // Product settings and forgetting, their refusals included.
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rijst", package: "500 gram" })).value, { spoken: "Rijst: een verpakking bevat 500 gram." })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rijst", package: "ongeveer 500 gram" })).value, {
        spoken: "Ik onthoud alleen een precieze verpakkingsgrootte; hoeveel zit er precies in één verpakking rijst?"
      })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rijst", minimum: "een liter" })).value, { spoken: "Ik houd rijst bij in gram; hoeveel is dat in gram?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rijst" })).value, { spoken: "Wat moet ik veranderen voor rijst: een minimum, de verpakking of een andere naam?" })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "noedels", minimum: "1 kg" })).value, { spoken: "Er is geen noedels in de voorraad." })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_forget", { item: "rijst" })).value, { spoken: "Rijst staat niet meer in de voorraad. De dagelijkse back-ups bewaren het nog tot 14 dagen." })
      assert.deepStrictEqual((yield* k.tool("kitchen_product_forget", { item: "rijst" })).value, { spoken: "Er is geen rijst in de voorraad." })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "melk" })), "Er is geen melk in de voorraad.")
    }))

  it.effect("Dutch singular and plural name one product: add, use, query and the list (finding 17)", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub(), dutch)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "zes eieren" })), "6 eieren toegevoegd; eieren is nieuw in de voorraad.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "1 ei" })), "Oké, nog 5 eieren.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "ei" })), "Je hebt 5 eieren.")
      yield* k.tool("kitchen_stock_add", { what: "een kilo tomaten" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 gram tomaat" })), "Oké, nog 800 gram tomaten.")
      yield* k.tool("kitchen_stock_add", { what: "drie uien" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "1 ui" })), "Oké, nog 2 uien.")
      assert.strictEqual((yield* k.moduleStore().collection(products).list({})).length, 3)
    }))

  it.effect("the gateway refuses a tool the assistant switched off, and nothing is booked", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, { household: { assistants: [{ id: "jeff", modules: { kitchen: { offTools: ["kitchen_stock_add"] } } }] } })
      assert.notInclude(k.toolNames(), "kitchen_stock_add")
      assert.include(k.toolNames(), "kitchen_stock_use")
      const refused = yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.isFalse(refused.ok)
      assert.deepStrictEqual(yield* k.moduleStore().collection(bookings).list({ where: { device: "kitchen-display" }, orderBy: { field: "at", direction: "asc" } }), [])
    }))
})

describe("kitchen: every advertised example, through the real extraction (finding 16)", () => {
  /** The words an action's text parameter takes from an utterance, as the intent path takes them. */
  const phrase = (utterance: string, id: string): string | undefined => {
    const def = kitchenModuleActions.find((a) => a.id === id)!
    const p = Object.values(def.params as Record<string, { kind: string; after: ReadonlyArray<string>; maxWords?: number }>)[0]
    return p === undefined ? undefined : extractText(utterance, p.after, p.maxWords)
  }
  const run = (k: { readonly action: (id: string, params: Record<string, unknown>) => Effect.Effect<{ readonly ok: boolean; readonly say?: string; readonly message?: string }, never> }, id: string, utterance: string) => {
    const def = kitchenModuleActions.find((a) => a.id === id)!
    const name = Object.keys(def.params as object)[0]
    const value = phrase(utterance, id)
    return k.action(id, name === undefined || value === undefined ? {} : { [name]: value }).pipe(Effect.map(spoken))
  }

  it.effect("English", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      const expected: ReadonlyArray<readonly [string, string, string]> = [
        ["stock_add", "I bought a kilo of rice", "Added 1 kilogram of rice; rice is new in the pantry."],
        ["stock_add", "add two litres of milk to the pantry", "Added 2 litres of milk; milk is new in the pantry."],
        ["stock_add", "we got six eggs", "Added 6 eggs; eggs is new in the pantry."],
        ["stock_use", "I used about 250 grams of rice", "Okay. I don't know exactly how much rice there is now; last I knew, about 750 grams of rice."],
        ["stock_use", "we used two eggs", "Okay, 4 eggs left."],
        ["stock_set", "there is about a kilo of rice left", "Okay, I've noted about 1 kilogram of rice; tell me the exact amount when you know it."],
        ["stock_set", "we have two litres of milk left", "Okay, you have 2 litres of milk."],
        ["stock_query", "how much rice is left", "I don't know exactly how much rice there is; last I knew, about 1 kilogram of rice."],
        ["stock_query", "how much milk do we have", "You have 2 litres of milk."],
        ["stock_query", "what's in the pantry", "In the pantry: 4 eggs, 2 litres of milk and rice (last I knew, about 1 kilogram)."],
        ["stock_low", "what are we running low on", "Nothing is running low."],
        ["stock_low", "what do we need", "Nothing is running low."],
        ["stock_low", "what's running out", "Nothing is running low."],
        ["keep_minimum", "always keep two kilos of rice", "Okay, I'll keep at least 2 kilograms of rice in stock. Rice is below your minimum of 2 kilograms, so it's on the shopping list."],
        ["keep_minimum", "keep at least six eggs in the house", "Okay, I'll keep at least 6 eggs in stock. Eggs is below your minimum of 6 pieces, so it's on the shopping list."],
        ["stock_out", "we're out of rice", "Okay, no rice left. Rice is on the shopping list."],
        ["stock_out", "we ran out of milk", "Okay, no milk left. Milk is on the shopping list."],
        ["stock_out", "there are no eggs left", "Okay, no eggs left. Eggs is on the shopping list."],
        ["undo", "undo that", "Undone. You now have 4 eggs. Eggs is below your minimum of 6 pieces, so it's on the shopping list."],
        ["undo", "undo the last pantry change", "There's nothing from this device to undo."],
        ["undo", "that was wrong, undo it", "There's nothing from this device to undo."]
      ]
      for (const [id, utterance, answer] of expected) assert.strictEqual(yield* run(k, id, utterance), answer, utterance)
      yield* k.tool("kitchen_stock_add", { what: "400 grams of cheese" })
      assert.strictEqual(yield* run(k, "stock_use", "I used some of the cheese"), "Okay. I don't know how much cheese is left now; tell me how much when you know.")
      // Every English example of every pantry action is above.
      for (const a of kitchenModuleActions) for (const e of (a.examples ?? []).filter((x) => !/\b(?:ik|we hebben|er is|de|wat|voeg|houd|zorg|maak|draai|hoeveel)\b/u.test(x))) {
        assert.isTrue(expected.some(([id, u]) => id === a.id && u === e) || e === "I used some of the cheese", `${a.id}: ${e}`)
      }
    }))

  it.effect("Dutch", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub(), dutch)
      const expected: ReadonlyArray<readonly [string, string, string]> = [
        ["stock_add", "ik heb een kilo rijst gekocht", "1 kilo rijst toegevoegd; rijst is nieuw in de voorraad."],
        ["stock_add", "voeg twee liter melk toe aan de voorraad", "2 liter melk toegevoegd; melk is nieuw in de voorraad."],
        ["stock_use", "ik heb ongeveer 250 gram rijst gebruikt", "Oké. Ik weet niet precies hoeveel rijst er nu is; het laatste dat ik wist: ongeveer 750 gram rijst."],
        ["stock_set", "er is nog ongeveer een kilo rijst", "Oké, ik heb ongeveer 1 kilo rijst genoteerd; zeg de precieze hoeveelheid als je die weet."],
        ["stock_set", "we hebben nog twee liter melk", "Oké, je hebt 2 liter melk."],
        ["stock_query", "hoeveel rijst hebben we nog", "Ik weet niet precies hoeveel rijst er is; het laatste dat ik wist: ongeveer 1 kilo rijst."],
        ["stock_query", "wat is er in de voorraad", "In de voorraad: 2 liter melk en rijst (het laatste dat ik wist: ongeveer 1 kilo)."],
        ["stock_low", "wat is er bijna op", "Er is niets bijna op."],
        ["stock_low", "wat moeten we kopen", "Er is niets bijna op."],
        ["keep_minimum", "houd altijd twee kilo rijst in huis", "Oké, ik zorg dat er minstens 2 kilo rijst is. Rijst is onder je minimum van 2 kilo, dus het staat op het boodschappenlijstje."],
        ["stock_add", "ik heb zes eieren gekocht", "6 eieren toegevoegd; eieren is nieuw in de voorraad."],
        ["keep_minimum", "zorg dat er altijd zes eieren zijn", "Oké, ik zorg dat er minstens 6 eieren is."],
        ["stock_use", "we hebben twee eieren gebruikt", "Oké, nog 4 eieren. Eieren is onder je minimum van 6 stuks, dus het staat op het boodschappenlijstje."],
        ["undo", "maak dat ongedaan", "Ongedaan gemaakt. Je hebt nu 6 eieren."],
        ["undo", "draai dat terug", "Er is van dit apparaat niets om ongedaan te maken."],
        ["stock_out", "we hebben geen rijst meer", "Oké, geen rijst meer. Rijst staat op het boodschappenlijstje."],
        ["stock_out", "de melk is op", "Oké, geen melk meer. Melk staat op het boodschappenlijstje."]
      ]
      for (const [id, utterance, answer] of expected) assert.strictEqual(yield* run(k, id, utterance), answer, utterance)
      for (const a of kitchenModuleActions) for (const e of (a.examples ?? []).filter((x) => /\b(?:ik|we hebben|er is|de|wat|voeg|houd|zorg|maak|draai|hoeveel)\b/u.test(x))) {
        assert.isTrue(expected.some(([id, u]) => id === a.id && u === e), `${a.id}: ${e}`)
      }
    }))
})

/** The action definitions, for their parameters' markers (the intent path reads them). */
const kitchenModuleActions = pantryActions({
  host: { view: () => ({ home: {} }) } as never,
  store: undefined as never,
  pantry: undefined as never,
  settings: { lowStockToList: true, listWhenOut: true, cup: "metric" }
})
