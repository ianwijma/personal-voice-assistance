// What the kitchen added after its first version: the phrase "we're out of …" (the existing action `stock_out`, said
// without the model) and the checklist of what is low or missing, shown on a screen with ticks. Through the kit, in
// the real host, gateway, phrase matcher and Presenter, with a stateful stub of the shopping list.
import { assert, describe, it, vi } from "@effect/vitest"
import { provide, startTestModule, stubService } from "@pva/core/testing"
import { Lists, type ListItem, type ListsService } from "@pva/module-contracts"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { kitchenModule, bookings, names, products } from "../src/index.ts"
import { cutText, screenKey } from "../src/lowScreen.ts"
import { listKey } from "../src/pantry.ts"

vi.setConfig({ testTimeout: 30_000 })

/** The shopping list as the lists module keeps it, by dedupe key, so a test sees what a tick did to it. */
const statefulLists = () => {
  const items = new Map<string, ListItem>()
  const stub = stubService<ListsService>("lists", {
    addItem: (r) =>
      Effect.sync(() => {
        const key = r.dedupeKey!
        const had = items.get(key)
        const item: ListItem = { id: had?.id ?? `item-${items.size + 1}`, text: r.text, status: "open", dedupeKey: key }
        items.set(key, item)
        return { outcome: had === undefined ? "added" as const : had.status === "done" ? "reopened" as const : "updated" as const, item }
      }),
    completeByKey: (key) =>
      Effect.sync(() => {
        const had = items.get(key)
        if (had === undefined || had.status === "done") return undefined
        const done: ListItem = { ...had, status: "done" }
        items.set(key, done)
        return done
      })
  })
  return { stub, items }
}

/** The default household's three screens (shared, private, public) and a speaker with no display. */
const household = {
  devices: [
    { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-sam" },
    { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" },
    { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: null },
    { id: "office-speaker", name: "Office speaker", room: "Office", capabilities: { v: 1 as const, speaker: { media: ["speech" as const] } } }
  ]
}
const dutch = { household: { ...household, home: { HOME_LANGUAGE: "nl-NL" } } }

const start = (lists: ReturnType<typeof statefulLists> | undefined, extra: Parameters<typeof startTestModule>[1] = {}) =>
  startTestModule(kitchenModule, {
    household,
    ...extra,
    ...(lists !== undefined ? { provide: [provide("lists", { services: [Lists.of(lists.stub.service)] })] } : {})
  })

type Kit = Effect.Success<ReturnType<typeof start>>
const said = (r: { readonly value: unknown }) => r.value as string
const spokenLast = (k: Kit) => k.phrases.spoken.at(-1)?.text
const stockOf = (k: Kit, key: string) =>
  Effect.map(k.moduleStore().collection(products).list({ where: { key } }), (rows) => rows[0]?.value.stock)
/** `n` products with no stock left, named "item 000", … */
const lowProducts = (k: Kit, n: number, prefix = "item") =>
  k.moduleStore().transaction((tx) => {
    for (let i = 0; i < n; i++) {
      const name = `${prefix} ${String(i).padStart(3, "0")}`
      const row = tx.collection(products).insert({ name, key: name, unit: "g", stock: 0, unknown: false, low: true, aliases: [], tidiedAt: 0, listedAt: 0 })
      tx.collection(names).insert({ key: name, product: row.id })
    }
  })
const listOf = (k: Kit, device = "kitchen-display") => {
  const p = k.present.shown(device)[0]
  return { wire: p, content: p?.content.kind === "list" ? p.content : undefined }
}

describe("kitchen: the phrase \"we're out of …\" runs stock_out", () => {
  it.effect("each English phrase books the product as out, as the tool does, and puts it on the shopping list", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists)
      for (const [n, phrase] of ["we're out of rice", "we are out of rice", "we ran out of rice", "we've run out of rice", "we have run out of rice"].entries()) {
        yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" }, { turnId: 100 + n })
        yield* k.advance(1_000)
        assert.strictEqual((yield* stockOf(k, "rice")), 1000)
        const r = yield* k.phrases.say(`${phrase}.`, { device: "kitchen-display" })
        assert.isTrue(r.taken && r.by === "command", phrase)
        assert.strictEqual(spokenLast(k), "Okay, no rice left. Rice is on the shopping list.", phrase)
        assert.strictEqual((yield* stockOf(k, "rice")), 0, phrase)
        yield* k.advance(1_000)
      }
      // The same item the tool puts on the list, by the same key.
      assert.deepStrictEqual([...lists.items.values()].map((i) => i.dedupeKey), [listKey((yield* k.moduleStore().collection(products).list({ where: { key: "rice" } }))[0]!.id)])
    }))

  it.effect("each Dutch phrase, in a Dutch household; the English ones are not taken there", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists, dutch)
      for (const [n, phrase] of ["we hebben geen rijst meer", "de rijst is op", "het rijst is op"].entries()) {
        yield* k.tool("kitchen_stock_add", { what: "een kilo rijst" }, { turnId: 200 + n })
        yield* k.advance(1_000)
        const r = yield* k.phrases.say(phrase, { device: "kitchen-display" })
        assert.isTrue(r.taken && r.by === "command", phrase)
        assert.strictEqual(spokenLast(k), "Oké, geen rijst meer. Rijst staat op het boodschappenlijstje.", phrase)
        assert.strictEqual((yield* stockOf(k, "rijst")), 0, phrase)
        yield* k.advance(1_000)
      }
      assert.deepStrictEqual(yield* k.phrases.say("we're out of rijst"), { taken: false })
    }))

  it.effect("near misses are not taken, and nothing is booked", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      for (const near of ["we're out of", "we are almost out of rice", "the rice is gone", "out of rice", "we're not out of rice"]) {
        assert.deepStrictEqual(yield* k.phrases.say(near), { taken: false }, near)
      }
      assert.strictEqual((yield* stockOf(k, "rice")), 1000)
      const nl = yield* start(statefulLists(), dutch)
      for (const near of ["we hebben geen rijst", "wij hebben geen rijst meer", "rijst is op", "is de rijst op"]) {
        assert.deepStrictEqual(yield* nl.phrases.say(near), { taken: false }, near)
      }
    }))

  it.effect("the action's own refusals are reached through the phrase, in the action's words", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.phrases.say("we're out of basmati")
      assert.strictEqual(spokenLast(k), "There's no basmati in the pantry.")
      yield* k.phrases.say("we're out of rice and milk")
      assert.strictEqual(spokenLast(k), "One thing at a time, please: how much of what?")
      yield* k.phrases.say("we're out of 2 2 rice")
      assert.strictEqual(spokenLast(k), "How much of what? Say for example: a kilo of rice.")
      assert.strictEqual((yield* stockOf(k, "rice")), 1000)
    }))

  it.effect("the same phrase invocation twice acts once; two utterances act twice; a model's call is not keyed", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" }, { turnId: 1 })
      yield* k.advance(1_000)
      const count = Effect.map(k.moduleStore().collection(bookings).list({ where: { device: "kitchen-display" }, orderBy: { field: "at", direction: "asc" } }), (rows) => rows.length)
      const asPhrase = (turnId: number) => ({ source: "phrase" as const, turnId, device: "kitchen-display" })
      const first = yield* k.action("stock_out", { what: "rice" }, asPhrase(7))
      yield* k.advance(1_000)
      assert.strictEqual(yield* count, 2)
      // The same identity again (a replay of the same utterance): the first answer comes back, nothing is booked.
      const again = yield* k.action("stock_out", { what: "rice" }, asPhrase(7))
      assert.deepStrictEqual(again, first)
      assert.strictEqual(yield* count, 2)
      // A new utterance is a new invocation: it acts again.
      yield* k.advance(1_000)
      yield* k.action("stock_out", { what: "rice" }, asPhrase(8))
      assert.strictEqual(yield* count, 3)
      // Not a phrase (the model's call, a routine): never held back by an earlier phrase's identity.
      yield* k.advance(1_000)
      yield* k.action("stock_out", { what: "rice" }, { turnId: 7, device: "kitchen-display" })
      assert.strictEqual(yield* count, 4)
    }))
})

describe("kitchen: what is low, on a screen", () => {
  it.effect("is shown on the shared, the private and the public screen, as the answer says it, and on a device without a display nothing changes", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.tool("kitchen_stock_add", { what: "two litres of milk" })
      yield* k.tool("kitchen_stock_out", { what: "rice" })
      yield* k.tool("kitchen_product_set", { item: "milk", minimum: "3 litres" })
      let plain: string | undefined
      for (const device of ["kitchen-display", "robins-phone", "hall-screen", "office-speaker"]) {
        const r = yield* k.tool("kitchen_stock_low", {}, { device })
        yield* k.present.settle
        // The answer is the same everywhere (and the same as before the screen existed).
        plain ??= said(r)
        assert.strictEqual(said(r), plain)
        const { content, wire } = listOf(k, device)
        if (device === "office-speaker") {
          assert.deepStrictEqual(k.present.shown(device), [])
          assert.isTrue(k.present.decisions.some((d) => d.deviceId === device && !d.decision.show))
          continue
        }
        // Household data, like the answer: shown on every device that has a screen, the public one too.
        assert.strictEqual(content?.style, "checklist", device)
        assert.deepStrictEqual(content?.items.map((i) => [i.text, i.done]), [["milk", false], ["rice", false]], device)
        assert.strictEqual(content?.title, "Running low", device)
        assert.strictEqual(wire?.lifetime, "transient", device)
      }
      assert.strictEqual(plain, "Running low: milk and rice.")
      // Nothing was put on the list by showing it.
      assert.strictEqual(lists.items.size, 2)
    }))

  it.effect("one list per device: a second device's request does not replace the first's", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* lowProducts(k, 2)
      yield* k.tool("kitchen_stock_low", {}, { device: "kitchen-display" })
      yield* k.tool("kitchen_stock_low", {}, { device: "hall-screen" })
      yield* k.present.settle
      assert.strictEqual(k.present.shown("kitchen-display").length, 1)
      assert.strictEqual(k.present.shown("hall-screen").length, 1)
      assert.notStrictEqual(screenKey("kitchen-display"), screenKey("hall-screen"))
    }))

  it.effect("says when the screen shows only part: more than twelve, and a read that was cut", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* lowProducts(k, 30)
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      let { content } = listOf(k)
      assert.strictEqual(content?.items.length, 12)
      assert.strictEqual(content?.title, "Running low: the first 12 of 30")
      yield* lowProducts(k, 80, "more")
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      ;({ content } = listOf(k))
      assert.strictEqual(content?.title, "Running low: the first 12 of at least 100")
    }))

  it.effect("a long name cut at a character boundary still makes a valid screen, and a long answer keeps a sentence the model can say", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      // 39 letters and an emoji (two units) at the product name's bound, twelve times.
      yield* k.moduleStore().transaction((tx) => {
        for (let i = 0; i < 12; i++) {
          const name = `${String(i).padStart(2, "0")}${"x".repeat(36)}😀`.slice(0, 40)
          tx.collection(products).insert({ name, key: name, unit: "g", stock: 0, unknown: false, low: true, aliases: [], tidiedAt: 0, listedAt: 0 })
        }
      })
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      assert.strictEqual(listOf(k).content?.items.length, 12)
      assert.strictEqual(cutText(`${"a".repeat(79)}😀`, 80), "a".repeat(79))
      assert.strictEqual(cutText("😀😀", 3), "😀")
      assert.strictEqual(cutText("abc", 3), "abc")
    }))

  it.effect("follows the stock: an item that is not low any more leaves it, and the last one takes the whole list down", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.tool("kitchen_stock_add", { what: "two litres of milk" })
      yield* k.tool("kitchen_stock_out", { what: "rice" })
      yield* k.tool("kitchen_stock_out", { what: "milk" })
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      const id = listOf(k).wire!.id
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.present.settle
      assert.deepStrictEqual(listOf(k).content?.items.map((i) => i.text), ["milk"])
      // The same list, replaced in place.
      assert.strictEqual(listOf(k).wire?.id, id)
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_add", { what: "two litres of milk" })
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(), [])
    }))

  it.effect("an empty answer takes down a list that no longer applies; a list that ended is not brought back by a booking", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* lowProducts(k, 1)
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      assert.strictEqual(k.present.shown().length, 1)
      // Nothing is low any more, by a change the screen was not told of (the store, not a booking).
      yield* k.moduleStore().transaction((tx) => {
        for (const r of tx.collection(products).list({})) tx.collection(products).update(r.id, (p) => ({ ...p, stock: 500, low: false }))
      })
      assert.strictEqual(said(yield* k.tool("kitchen_stock_low", {})), "Nothing is running low.")
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(), [])
      // A transient list ends by itself; a booking afterwards does not show it again.
      yield* k.moduleStore().transaction((tx) => {
        for (const r of tx.collection(products).list({})) tx.collection(products).update(r.id, (p) => ({ ...p, stock: 0, low: true }))
      })
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      assert.strictEqual(k.present.shown().length, 1)
      yield* k.advance(40_000)
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(), [])
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(), [])
    }))

  it.effect("keep_low keeps it (pinned) until it is dismissed; a page that comes back is given it again", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* lowProducts(k, 2)
      yield* k.tool("kitchen_keep_low", {})
      yield* k.present.settle
      assert.strictEqual(listOf(k).wire?.lifetime, "pinned")
      yield* k.advance(60_000)
      assert.strictEqual(k.present.shown().length, 1)
      yield* k.notify.disconnect("kitchen-display")
      yield* k.notify.connect("kitchen-display")
      assert.strictEqual(k.present.shown().length, 1)
    }))
})

describe("kitchen: a tick on the checklist", () => {
  const shownLow = (k: Kit, tool = "kitchen_stock_low") =>
    Effect.gen(function*() {
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.tool("kitchen_stock_out", { what: "rice" })
      yield* k.tool(tool, {})
      yield* k.present.settle
      const { wire, content } = listOf(k)
      const rice = (yield* k.moduleStore().collection(products).list({ where: { key: "rice" } }))[0]!
      return { id: wire!.id, item: content!.items[0]!.id, rice }
    })

  it.effect("puts the product on the shopping list, once: pressed twice, the second finds it there", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists)
      const { id, item, rice } = yield* shownLow(k)
      assert.strictEqual(item, rice.id)
      // Taking the stock out put it on the list already (the setting is on); take that away to see the tick alone.
      lists.items.clear()
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { item, done: true }), { ok: true, say: "Rice is on the shopping list." })
      assert.deepStrictEqual([...lists.items.values()].map((i) => [i.text, i.dedupeKey, i.status]), [["rice", listKey(rice.id), "open"]])
      assert.deepStrictEqual(listOf(k).content?.items.map((i) => i.done), [true])
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { item, done: true }), { ok: true, say: "Rice was already on the shopping list." })
      assert.strictEqual(lists.items.size, 1)
      // Unticking leaves the list as it is, and says so.
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { item, done: false }), { ok: true, say: "I can't take it off the shopping list from here; do that on the list itself." })
      assert.strictEqual([...lists.items.values()][0]?.status, "open")
    }))

  it.effect("from a device that does not hold the list: refused, and nothing is added", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists)
      const { id, item } = yield* shownLow(k)
      lists.items.clear()
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { device: "hall-screen", item, done: true }), { ok: false, say: "I can't do that right now.", code: "unknown" })
      assert.strictEqual(lists.items.size, 0)
    }))

  it.effect("with the module restarted in between: a pinned list's tick still works, and says it was on the list already", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists)
      const { id, item } = yield* shownLow(k, "kitchen_keep_low")
      lists.items.clear()
      assert.strictEqual((yield* k.present.press(id, "tick", { item, done: true })).say, "Rice is on the shopping list.")
      yield* k.restart
      assert.strictEqual(k.present.shown().length, 1)
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { item, done: true }), { ok: true, say: "Rice was already on the shopping list." })
      assert.strictEqual(lists.items.size, 1)
      // The list was shown again by its key after the restart: the same list, still there.
      assert.strictEqual(listOf(k).wire?.id, id)
      assert.deepStrictEqual(listOf(k).content?.items.map((i) => i.done), [true])
    }))

  it.effect("says what it could not do, and never claims the item is on the list then", () =>
    Effect.gen(function*() {
      const k = yield* start(undefined)
      const { id, item } = yield* shownLow(k)
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { item, done: true }), { ok: true, say: "The Lists module is off, so I couldn't update the shopping list for rice." })
      assert.deepStrictEqual(listOf(k).content?.items.map((i) => i.done), [false])
    }))

  it.effect("a product forgotten since is said so, and leaves the list", () =>
    Effect.gen(function*() {
      const lists = statefulLists()
      const k = yield* start(lists)
      const { id, item } = yield* shownLow(k)
      lists.items.clear()
      yield* k.moduleStore().transaction((tx) => {
        tx.collection(products).remove(item)
      })
      assert.deepStrictEqual(yield* k.present.press(id, "tick", { item, done: true }), { ok: true, say: "That product isn't in the pantry any more, so I left the shopping list alone." })
      assert.strictEqual(lists.items.size, 0)
      assert.deepStrictEqual(k.present.shown(), [])
    }))
})

describe("kitchen: the screen on the turn's path", () => {
  it.effect("the answer with its screen, at the largest list, stops the event loop for less than the shared bound", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* lowProducts(k, 100)
      yield* k.tool("kitchen_stock_low", {})
      let worst = 0
      for (let run = 0; run < 3; run++) {
        let last = performance.now()
        let stop = 0
        const timer = setInterval(() => {
          const now = performance.now()
          stop = Math.max(stop, now - last)
          last = now
        }, 1)
        yield* k.tool("kitchen_stock_low", {})
        clearInterval(timer)
        worst = Math.max(worst, stop, performance.now() - last)
      }
      console.log(`kitchen_stock_low with its checklist, 100 low products: longest event-loop stop ${worst.toFixed(2)} ms`)
      assert.isBelow(worst, bound(10))
    }))
})
