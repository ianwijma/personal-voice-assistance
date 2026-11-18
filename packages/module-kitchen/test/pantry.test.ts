// The pantry ledger through the test kit: every action and tool on its ordinary path and its refusals, as turns of
// the default household, in the real host, gateway and store, with a programmed stub of the `Lists` service.
import { assert, describe, it } from "@effect/vitest"
import { extractText } from "@pva/core"
import { fails, provide, startTestModule, stops, stubService } from "@pva/core/testing"
import { Lists, ListsError, type ListsService } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { bookings, kitchenModule, names, products } from "../src/index.ts"
import { listKey } from "../src/pantry.ts"
import { pantryActions } from "../src/pantryActions.ts"

/** A stub of the shopping list that adds every item and finds nothing to tick off, unless a test programs otherwise. */
const listsStub = () =>
  stubService<ListsService>("lists", {
    addItem: (r) => Effect.succeed({ outcome: "added", item: { id: "item-1", text: r.text, status: "open", ...(r.dedupeKey !== undefined ? { dedupeKey: r.dedupeKey } : {}) } }),
    completeByKey: () => Effect.succeed(undefined)
  })

const withLists = (lists: ReturnType<typeof listsStub>, extra: Parameters<typeof startTestModule>[1] = {}) =>
  startTestModule(kitchenModule, { ...extra, provide: [provide("lists", { services: [Lists.of(lists.service)] })] })

const said = (r: { readonly value: unknown }) => r.value as string
/** What an action said, or why it did not run. */
const spoken = (r: { readonly ok: boolean; readonly say?: string | undefined; readonly message?: string }) => (r.ok ? r.say : `not run: ${r.message}`)

describe("kitchen: the pantry ledger", () => {
  it.effect("adds, uses and reads back, with the amounts said and 'about' where it is approximate", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "about 200 grams of rice" })), "Added about 200 grams of rice; rice is new in the pantry.")
      yield* k.advance(1_000)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a kilo of rice to the pantry" })), "Added 1 kilogram of rice. You now have about 1.2 kilograms of rice.")
      yield* k.advance(1_000)
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "about 250 grams of rice" })), "Okay, about 950 grams of rice left.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rice is left" })), "You have about 950 grams of rice.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "six eggs" })), "Added 6 eggs; eggs is new in the pantry.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", {})), "In the pantry: 6 eggs and about 950 grams of rice.")
      // The ledger: every change is a booking, and their sum is the stock.
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      const ledger = yield* k.moduleStore().collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((b) => [b.value.kind, b.value.delta, b.value.approx]), [["add", 200, true], ["add", 1000, false], ["use", -250, true]])
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

  it.effect("'some' moves no amount and marks it uncertain; 'the rest' uses it all; a bare name is asked about", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "400 grams of cheese" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "some of the cheese" })), "Okay. I've marked cheese as uncertain; tell me roughly how much is left when you know.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "cheese" })), "I'm not sure how much cheese is left; the last I knew was about 400 grams of cheese.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "cheese" })), "How much cheese did you use?")
      // A correction makes it known again.
      assert.strictEqual(said(yield* k.tool("kitchen_stock_set", { what: "about 150 grams of cheese left" })), "Okay, you have about 150 grams of cheese.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "cheese" })), "You have about 150 grams of cheese.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "the rest of the cheese" })), "Okay, no cheese left. Cheese is on the shopping list.")
    }))

  it.effect("asks instead of guessing: an unknown product, another unit, a package of unknown size, two things at once", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 grams of rise" })), "There's no rise in the pantry. Did you mean rice?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 grams of basmati" })), "There's no basmati in the pantry.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "a litre of rice" })), "I keep rice in grams; how much is that in grams?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "two bags of rice" })), "How much does one package of rice hold? Tell me and I'll remember it.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "rice and pasta" })), "One thing at a time, please: how much of what?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "pasta" })), "How much pasta?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "2 2 rice" })), "How much of what? Say for example: a kilo of rice.")
      // Nothing was booked by any of those.
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({})).length, 1)
      // Once the package is known, bags are booked, and a bare name books one package.
      const set = yield* k.tool("kitchen_product_set", { item: "rice", package: "1 kg" })
      assert.deepStrictEqual(set.value, { spoken: "Rice: a package holds 1 kilogram." })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "two bags of rice" })), "Added 2 bags of rice. You now have 3 kilograms of rice.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "rice" })), "Added 1 kilogram of rice. You now have 4 kilograms of rice.")
    }))

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
      // The minimum, through the model's tool: removed, and the product stays where it is.
      assert.deepStrictEqual((yield* k.tool("kitchen_product_set", { item: "rice", noMinimum: true })).value, { spoken: "Rice: no minimum." })
      // Several at once, said in one order; a minimum in packages uses the package size given with it.
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

  it.effect("the shopping list: off, stopping, full, failing and too slow; the booking stands every time", () =>
    Effect.gen(function*() {
      const lists = listsStub()
      const k = yield* withLists(lists)
      yield* k.tool("kitchen_stock_add", { what: "five eggs" })
      lists.answer("addItem", fails(new ListsError({ reason: "limit", detail: "500 open items" })))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 4 eggs left.")
      yield* k.tool("kitchen_keep_minimum", { what: "six eggs" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 3 eggs left. The shopping list is full, so eggs isn't on it.")
      lists.answer("addItem", fails(new ListsError({ reason: "busy", detail: "locked" })))
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 2 eggs left. I couldn't reach the shopping list, so eggs isn't on it yet.")
      lists.answer("addItem", stops())
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "one egg" })), "Okay, 1 eggs left. The Lists module is off, so eggs isn't on the shopping list.")
      // A list that does not answer in time: the kitchen waits 1.5 s, not the action's 5 s.
      lists.answer("addItem", () => Effect.never)
      const slow = yield* Effect.forkChild(k.tool("kitchen_stock_use", { what: "one egg" }))
      yield* k.advance(2_000)
      assert.strictEqual(said(yield* Fiber.join(slow)), "Okay, no eggs left. I couldn't reach the shopping list, so eggs isn't on it yet.")
      const [eggs] = yield* k.moduleStore().collection(products).list({ where: { key: "egg" } })
      assert.strictEqual(eggs!.value.stock, 0)
    }))

  it.effect("without the lists module at all, it says so and books anyway", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule)
      yield* k.tool("kitchen_stock_add", { what: "a litre of milk" })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "milk" })), "Okay, no milk left. The Lists module is off, so milk isn't on the shopping list.")
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

  it.effect("undo reverses the asking device's own last booking with a reversing booking, one at a time", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" }, { device: "kitchen-display" })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_use", { what: "about 250 grams of rice" }, { device: "kitchen-display" })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_use", { what: "100 grams of rice" }, { device: "robins-phone" })
      yield* k.advance(1_000)
      // Robin's phone undoes Robin's booking, not Sam's later ones.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "robins-phone" })), "Undone. You now have about 750 grams of rice.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "robins-phone" })), "There's nothing from this device in the last day to undo.")
      // The kitchen display: its use, then its add (the stock is exact again: the 'about' came from the use).
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "kitchen-display" })), "Undone. You now have 1 kilogram of rice.")
      const [rice] = yield* k.moduleStore().collection(products).list({ where: { key: "rice" } })
      const ledger = yield* k.moduleStore().collection(bookings).list({ where: { product: rice!.id }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(ledger.map((b) => b.value.kind), ["add", "use", "use", "undo", "undo"])
      assert.strictEqual(ledger.reduce((s, b) => s + b.value.delta, 0), 1000)
      assert.isFalse(rice!.value.approx)
      // The public hall screen made nothing, so has nothing to undo.
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "hall-screen" })), "There's nothing from this device in the last day to undo.")
      // After a day the add is out of reach.
      yield* k.advance(86_400_000)
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {}, { device: "kitchen-display" })), "There's nothing from this device in the last day to undo.")
    }))

  it.effect("undoing the booking that made a product by mistake takes the product out again", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of ice" })
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Undone; ice is out of the pantry again.")
      assert.deepStrictEqual(yield* k.moduleStore().collection(products).list({}), [])
      assert.deepStrictEqual(yield* k.moduleStore().collection(names).list({}), [])
      assert.deepStrictEqual(yield* k.moduleStore().collection(bookings).list({}), [])
    }))

  it.effect("undo outside a device's turn says it cannot", () =>
    Effect.gen(function*() {
      // A routine run from a job has no turn: the action's own code, outside the kit, with no `CurrentTurn`.
      const undo = kitchenModuleActions.find((a) => a.id === "undo")!
      const run = undo.run as (params: Record<string, never>) => ReturnType<typeof undo.run>
      assert.deepStrictEqual(yield* run({}), { say: "I can only undo a change on the device it was made on." })
    }))

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
      assert.strictEqual((yield* k.moduleStore().collection(bookings).list({})).length, 1)
      assert.deepStrictEqual((yield* k.tool("kitchen_product_forget", { item: "rice" })).value, { spoken: "There's no rice in the pantry." })
      // A name must be one line: refused before the module runs.
      assert.isFalse((yield* k.tool("kitchen_product_set", { item: "pasta", alias: "one\ntwo" })).ok)
    }))

  it.effect("speaks Dutch in a Dutch household, its questions and the shopping list too", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub(), { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "een kilo rijst" })), "1 kilo rijst toegevoegd; rijst is nieuw in de voorraad.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "ongeveer 250 gram rijst" })), "Oké, nog ongeveer 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_query", { item: "rijst" })), "Je hebt ongeveer 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "rijst" })), "Hoeveel rijst heb je gebruikt?")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_out", { what: "rijst" })), "Oké, geen rijst meer. Rijst staat op het boodschappenlijstje.")
      assert.strictEqual(said(yield* k.tool("kitchen_undo", {})), "Ongedaan gemaakt. Je hebt nu ongeveer 750 gram rijst.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_use", { what: "200 gram kaas" })), "Er is geen kaas in de voorraad.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), "Er is niets bijna op.")
      assert.strictEqual(said(yield* k.tool("kitchen_stock_add", { what: "rijst en pasta" })), "Eén ding tegelijk graag: hoeveel van wat?")
    }))

  it.effect("the actions' examples run without the model: the words after the marker are the phrase the action reads", () =>
    Effect.gen(function*() {
      const k = yield* withLists(listsStub())
      const phrase = (utterance: string, id: string) => {
        const def = kitchenModuleActions.find((a) => a.id === id)!
        const p = Object.values(def.params as Record<string, { kind: string; after: ReadonlyArray<string>; maxWords?: number }>)[0]!
        return extractText(utterance, p.after, p.maxWords)!
      }
      const add = yield* k.action("stock_add", { what: phrase("I bought a kilo of rice", "stock_add") })
      assert.deepStrictEqual(add, { ok: true, say: "Added 1 kilogram of rice; rice is new in the pantry." })
      assert.strictEqual(spoken(yield* k.action("stock_add", { what: phrase("add two litres of milk to the pantry", "stock_add") })), "Added 2 litres of milk; milk is new in the pantry.")
      assert.strictEqual(spoken(yield* k.action("stock_use", { what: phrase("I used about 250 grams of rice", "stock_use") })), "Okay, about 750 grams of rice left.")
      assert.strictEqual(spoken(yield* k.action("stock_query", { item: phrase("how much rice is left", "stock_query") })), "You have about 750 grams of rice.")
      assert.strictEqual(spoken(yield* k.action("stock_query", { item: phrase("how much milk do we have", "stock_query") })), "You have 2 litres of milk.")
      assert.strictEqual(spoken(yield* k.action("stock_out", { what: phrase("we're out of rice", "stock_out") })), "Okay, no rice left. Rice is on the shopping list.")
      assert.strictEqual(spoken(yield* k.action("stock_set", { what: phrase("there is about a kilo of rice left", "stock_set") })), "Okay, you have about 1 kilogram of rice.")
      assert.strictEqual(spoken(yield* k.action("keep_minimum", { what: phrase("always keep two kilos of rice", "keep_minimum") })), "Okay, I'll keep at least 2 kilograms of rice in stock. Rice is below your minimum of 2 kilograms, so it's on the shopping list.")
      // The action runs as a turn of the kitchen display, so the same device undoes its own last booking (the correction).
      assert.strictEqual(spoken(yield* k.action("undo", {})), "Undone. You now have no rice. Rice is on the shopping list.")
      // Dutch, said in a Dutch household.
      const nl = yield* withLists(listsStub(), { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.strictEqual(spoken(yield* nl.action("stock_add", { what: phrase("ik heb een kilo rijst gekocht", "stock_add") })), "1 kilo rijst toegevoegd; rijst is nieuw in de voorraad.")
      assert.strictEqual(spoken(yield* nl.action("stock_use", { what: phrase("ik heb ongeveer 250 gram rijst gebruikt", "stock_use") })), "Oké, nog ongeveer 750 gram rijst.")
      assert.strictEqual(spoken(yield* nl.action("stock_query", { item: phrase("hoeveel rijst hebben we nog", "stock_query") })), "Je hebt ongeveer 750 gram rijst.")
      assert.strictEqual(spoken(yield* nl.action("stock_out", { what: phrase("we hebben geen rijst meer", "stock_out") })), "Oké, geen rijst meer. Rijst staat op het boodschappenlijstje.")
    }))

  it.effect("the gateway refuses a tool the assistant switched off, and nothing is booked", () =>
    Effect.gen(function*() {
      const k = yield* startTestModule(kitchenModule, { household: { assistants: [{ id: "jeff", modules: { kitchen: { offTools: ["kitchen_stock_add"] } } }] } })
      assert.notInclude(k.toolNames(), "kitchen_stock_add")
      assert.include(k.toolNames(), "kitchen_stock_use")
      const refused = yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      assert.isFalse(refused.ok)
      assert.deepStrictEqual(yield* k.moduleStore().collection(bookings).list({}), [])
    }))
})

/** The action definitions, for their parameters' markers (the intent path reads them). */
const kitchenModuleActions = pantryActions({
  host: { view: () => ({ home: {} }) } as never,
  store: undefined as never,
  pantry: undefined as never,
  settings: { lowStockToList: true, listWhenOut: true, cup: "metric" }
})
