// What the kitchen added after its first version: the phrase "we're out of …" (the existing action `stock_out`, said
// without the model) and the checklist of what is low or missing, shown on a screen with ticks. Through the kit, in
// the real host, gateway, phrase matcher and Presenter, with a stateful stub of the shopping list.
import { assert, describe, it, vi } from "@effect/vitest"
import { provide, startTestModule, stubService } from "@pva/core/testing"
import { Lists, type ListItem, type ListsService } from "@pva/module-contracts"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { kitchenModule, bookings, names, products } from "../src/index.ts"
import { cutText } from "../src/lowScreen.ts"
import { listKey } from "../src/pantry.ts"

vi.setConfig({ testTimeout: 30_000 })

/** The shopping list as the lists module keeps it, by dedupe key, so a test sees what a tick did to it. */
const statefulLists = (slow = false) => {
  const items = new Map<string, ListItem>()
  const stub = stubService<ListsService>("lists", {
    addItem: (r) =>
      Effect.andThen(slow ? Effect.yieldNow : Effect.void, Effect.sync(() => {
        const key = r.dedupeKey!
        const had = items.get(key)
        const item: ListItem = { id: had?.id ?? `item-${items.size + 1}`, text: r.text, status: "open", dedupeKey: key }
        items.set(key, item)
        return { outcome: had === undefined ? "added" as const : had.status === "done" ? "reopened" as const : "updated" as const, item }
      })),
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
/** What the tool answered, without the host's note of what it did with the screen (which follows on its own line). */
const answerOf = (r: { readonly value: unknown }) => said(r).split("\n[Screen:")[0]!
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

  it.effect("two copies of one phrase that overlap book once, say the same, and undo restores the stock exactly", () =>
    Effect.gen(function*() {
      // A shopping list that takes a moment to answer, so both copies are in flight together.
      const lists = statefulLists(true)
      const k = yield* start(lists)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.advance(1_000)
      const asPhrase = { source: "phrase" as const, turnId: 77, device: "kitchen-display" }
      const [a, b] = yield* Effect.all([k.action("stock_out", { what: "rice" }, asPhrase), k.action("stock_out", { what: "rice" }, asPhrase)], { concurrency: 2 })
      assert.deepStrictEqual(a, b)
      const rows = yield* k.moduleStore().collection(bookings).list({ where: { device: "kitchen-display" }, orderBy: { field: "at", direction: "asc" } })
      assert.deepStrictEqual(rows.map((r) => [r.value.kind, r.value.delta]), [["add", 1000], ["set", -1000]])
      yield* k.advance(1_000)
      assert.match(said(yield* k.tool("kitchen_undo", {}, { turnId: 2 })), /^Undone\./u)
      assert.strictEqual((yield* stockOf(k, "rice")), 1000)
    }))

  it.effect("two calls of the model in one turn both book: only a spoken phrase is held to its identity", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" }, { turnId: 5 })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" }, { turnId: 5 })
      assert.strictEqual((yield* stockOf(k, "rice")), 2000)
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_out", { what: "rice" }, { turnId: 5 })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" }, { turnId: 5 })
      yield* k.advance(1_000)
      yield* k.tool("kitchen_stock_out", { what: "rice" }, { turnId: 5 })
      const ledger = yield* k.moduleStore().collection(bookings).list({ where: { device: "kitchen-display" }, orderBy: { field: "at", direction: "asc" } })
      assert.strictEqual(ledger.length, 5)
      assert.strictEqual((yield* stockOf(k, "rice")), 0)
    }))
})

const NAME = /(?:item|ding) \d{3}/gu
const namesIn = (text: string) => text.match(NAME) ?? []

describe("kitchen: what is low, on a screen, is exactly what the answer says", () => {
  for (const lang of ["en", "nl"] as const) {
    for (const n of [7, 12, 30, 130]) {
      it.effect(`${lang}: ${n} low products — the list names what the answer names, in its order, with its own "more" lines`, () =>
        Effect.gen(function*() {
          const k = yield* start(statefulLists(), lang === "nl" ? dutch : {})
          const prefix = lang === "nl" ? "ding" : "item"
          yield* lowProducts(k, n, prefix)
          const answer = answerOf(yield* k.tool("kitchen_stock_low", {}))
          yield* k.present.settle
          const { content } = listOf(k)
          assert.strictEqual(content?.kind, "list")
          assert.strictEqual(content?.style, "bullets")
          assert.strictEqual(content?.title, lang === "nl" ? "Bijna op" : "Running low")
          const items = content!.items.map((i) => i.text)
          // The names on the screen are the names in the answer, in the same order, and no others.
          assert.deepStrictEqual(items.flatMap(namesIn), namesIn(answer))
          assert.strictEqual(namesIn(answer).length, 5)
          // What the answer says of the rest, the screen says: the count, "more", and the cut's own line.
          const cut = n > 100
          const more = cut ? (lang === "nl" ? "en meer" : "and more") : lang === "nl" ? `en nog ${n - 5}` : `and ${n - 5} more`
          assert.strictEqual(items[5], more)
          assert.strictEqual(items.length, cut ? 7 : 6)
          if (cut) assert.isTrue(answer.endsWith(items[6]!), `${answer} / ${items[6]}`)
          else assert.strictEqual(answer.includes("Ik heb er") || answer.includes("I read the first"), false)
          assert.isTrue(answer.includes(lang === "nl" ? (cut ? "en meer" : `nog ${n - 5}`) : cut ? "and more" : `${n - 5} more`))
        }))
    }

    it.effect(`${lang}: up to six products are all named, with no "more" line`, () =>
      Effect.gen(function*() {
        const k = yield* start(statefulLists(), lang === "nl" ? dutch : {})
        const prefix = lang === "nl" ? "ding" : "item"
        for (const n of [1, 6]) {
          yield* k.moduleStore().transaction((tx) => {
            for (const r of tx.collection(products).list({})) tx.collection(products).remove(r.id)
            for (const r of tx.collection(names).list({})) tx.collection(names).remove(r.id)
          })
          yield* lowProducts(k, n, prefix)
          const answer = answerOf(yield* k.tool("kitchen_stock_low", {}, { turnId: 10 + n }))
          yield* k.present.settle
          const items = listOf(k).content!.items.map((i) => i.text)
          assert.deepStrictEqual(items.flatMap(namesIn), namesIn(answer))
          assert.strictEqual(items.length, n)
          yield* k.advance(40_000)
        }
      }))
  }

  it.effect("is shown on the shared, the private and the public screen, and on a device without a display nothing changes", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.tool("kitchen_stock_add", { what: "a kilo of rice" })
      yield* k.tool("kitchen_stock_out", { what: "rice" })
      let plain: string | undefined
      for (const device of ["kitchen-display", "robins-phone", "hall-screen", "office-speaker"]) {
        const r = yield* k.tool("kitchen_stock_low", {}, { device })
        yield* k.present.settle
        plain ??= answerOf(r)
        assert.strictEqual(answerOf(r), plain)
        if (device === "office-speaker") {
          assert.deepStrictEqual(k.present.shown(device), [])
          assert.isTrue(k.present.decisions.some((d) => d.deviceId === device && !d.decision.show))
          continue
        }
        assert.deepStrictEqual(listOf(k, device).content?.items.map((i) => i.text), ["rice"], device)
        assert.strictEqual(listOf(k, device).wire?.lifetime, "transient", device)
      }
      assert.strictEqual(plain, "Running low: rice.")
    }))

  it.effect("an empty answer shows nothing; the list ends by its lifetime and nothing else manages it", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      assert.strictEqual(answerOf(yield* k.tool("kitchen_stock_low", {})), "Nothing is running low.")
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(), [])
      yield* lowProducts(k, 2)
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      assert.strictEqual(k.present.shown().length, 1)
      yield* k.advance(40_000)
      yield* k.present.settle
      assert.deepStrictEqual(k.present.shown(), [])
    }))

  it.effect("a long name cut at a character boundary still makes a valid list", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* k.moduleStore().transaction((tx) => {
        for (let i = 0; i < 12; i++) {
          const name = `${String(i).padStart(2, "0")}${"x".repeat(36)}😀`.slice(0, 40)
          tx.collection(products).insert({ name, key: name, unit: "g", stock: 0, unknown: false, low: true, aliases: [], tidiedAt: 0, listedAt: 0 })
        }
      })
      yield* k.tool("kitchen_stock_low", {})
      yield* k.present.settle
      assert.strictEqual(listOf(k).content?.items.length, 6)
      assert.strictEqual(cutText(`${"a".repeat(79)}😀`, 80), "a".repeat(79))
      assert.strictEqual(cutText("😀😀", 3), "😀")
    }))
})

describe("kitchen: the list on the turn's path", () => {
  it.effect("the answer with its list, at the largest read, stops the event loop for less than the shared bound", () =>
    Effect.gen(function*() {
      const k = yield* start(statefulLists())
      yield* lowProducts(k, 130)
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
        yield* k.tool("kitchen_stock_low", {}, { turnId: 50 + run })
        clearInterval(timer)
        worst = Math.max(worst, stop, performance.now() - last)
      }
      console.log(`kitchen_stock_low with its list, 130 low products: longest event-loop stop ${worst.toFixed(2)} ms`)
      assert.isBelow(worst, bound(10))
    }))
})
