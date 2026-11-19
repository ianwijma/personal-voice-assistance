// The lists module's phrase commands and its checklist presentation (docs/modules/lists.md "Phrase commands" and
// "Checklists"), through the real host, gateway, Presenter and phrase matcher (the test kit).
import { assert, describe, it } from "@effect/vitest"
import { startTestModule, type TestDevice } from "@pva/core/testing"
import { Lists } from "@pva/module-contracts"
import { Effect } from "effect"
import { items, lists, matchOf, MAX_OPEN, pins, placeOf, SHOPPING, withStatus } from "../src/data.ts"
import { listsModule } from "../src/index.ts"
import { cutAt, oneLine, PIN_MS } from "../src/checklist.ts"
import { vi } from "vitest"

vi.setConfig({ testTimeout: 30_000 })

const DEVICES: ReadonlyArray<TestDevice> = [
  { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
  { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
  { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null },
  { id: "office-speaker", name: "Office speaker", room: "Office", capabilities: { v: 1, speaker: { media: ["speech"] } } }
]
const HOUSEHOLD = { devices: DEVICES }
const DUTCH = { devices: DEVICES, home: { HOME_LANGUAGE: "nl-NL" } }

const said = (r: { readonly ok: boolean; readonly say?: string; readonly message?: string }) => (r.ok ? r.say : r.message)

/** The texts of the open items a device's checklist holds, or `undefined` when it holds none. */
const checklistOf = (kit: { readonly present: { readonly shown: (d: string) => ReadonlyArray<{ readonly content: unknown }> } }, device: string) => {
  const found = kit.present.shown(device)[0]?.content as { readonly kind: string; readonly style?: string; readonly title?: string; readonly items?: ReadonlyArray<{ readonly id: string; readonly text: string; readonly done: boolean }> } | undefined
  return found
}
const textsOf = (c: ReturnType<typeof checklistOf>) => c?.items?.map((i) => i.text)

describe("phrase commands: add to and read the shopping list", () => {
  it.effect("every English phrase adds to the shopping list through the action: same sentence, same list", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      const phrases = [
        ["Add milk to the shopping list.", "Added milk to the shopping list."],
        ["Put eggs on the shopping list.", "Added eggs to the shopping list."],
        ["Add to the shopping list rice.", "Added rice to the shopping list."],
        ["Put on the shopping list bread and butter", "Added bread and butter to the shopping list."]
      ] as const
      for (const [said, sentence] of phrases) {
        const r = yield* kit.phrases.say(said, { device: "kitchen-display" })
        assert.isTrue(r.taken, said)
        assert.strictEqual(kit.phrases.spoken.at(-1)?.text, sentence)
      }
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 5 things: milk, eggs, rice, bread and butter.")
      // The same words as the typed action, so the same answer: what the action says to the same text.
      const typed = yield* kit.action("add", { items: "milk" })
      assert.strictEqual(said(typed), "The shopping list already has milk.")
      yield* kit.phrases.say("add milk to the shopping list")
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "The shopping list already has milk.")
    }))

  it.effect("every Dutch phrase adds to the boodschappenlijst, and the answers are Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: DUTCH })
      const phrases = [
        ["Zet melk op de boodschappenlijst", "Melk op de boodschappenlijst gezet."],
        ["Doe eieren op de boodschappenlijst", "Eieren op de boodschappenlijst gezet."],
        ["Voeg rijst toe aan de boodschappenlijst", "Rijst op de boodschappenlijst gezet."],
        ["Zet op de boodschappenlijst brood", "Brood op de boodschappenlijst gezet."]
      ] as const
      for (const [text, sentence] of phrases) {
        assert.isTrue((yield* kit.phrases.say(text, { device: "kitchen-display" })).taken, text)
        assert.strictEqual(kit.phrases.spoken.at(-1)?.text, sentence)
      }
      assert.strictEqual(said(yield* kit.action("read", {})), "Op de boodschappenlijst staan 4 dingen: melk, eieren, rijst en brood.")
    }))

  it.effect("near misses are not taken: another list, filler words, the other language, a typed sentence's shape", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      for (const text of ["add milk to the to-do list", "please add milk to the shopping list", "add milk to the shopping lists", "add milk", "zet melk op de boodschappenlijst", "read the to-do list", "what's on the list", "read shopping list"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(text, { device: "kitchen-display" }), { taken: false }, text)
      }
      // More than eight words in the slot is no phrase: it goes on to the assistant (nothing was written).
      assert.deepStrictEqual(yield* kit.phrases.say("add a b c d e f g h i to the shopping list"), { taken: false })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list is empty.")
      const nl = yield* startTestModule(listsModule, { household: DUTCH })
      for (const text of ["add milk to the shopping list", "zet melk op de takenlijst", "zet melk op het lijstje"]) assert.deepStrictEqual(yield* nl.phrases.say(text), { taken: false }, text)
    }))

  it.effect("the action's refusals are reached through the phrase: an item too long, a list that is full, in both languages", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      const long = "a".repeat(201)
      const r = yield* kit.phrases.say(`add ${long} to the shopping list`)
      assert.isTrue(r.taken)
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "That's too long for a list item; say it shorter.")
      // Full: the list's count is at its bound (set directly, as the module's own rows hold it).
      yield* kit.moduleStore().transaction((tx) => void tx.collection(lists).update(SHOPPING, (v) => ({ ...v, open: MAX_OPEN })))
      yield* kit.phrases.say("add milk to the shopping list")
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "The shopping list is full: it has 500 things on it. Tick some off first.")
      const nl = yield* startTestModule(listsModule, { household: DUTCH })
      yield* nl.phrases.say(`zet ${long} op de boodschappenlijst`)
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Dat is te lang voor één ding op de lijst; zeg het korter.")
      yield* nl.moduleStore().transaction((tx) => void tx.collection(lists).update(SHOPPING, (v) => ({ ...v, open: MAX_OPEN })))
      yield* nl.phrases.say("zet melk op de boodschappenlijst")
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "De boodschappenlijst is vol: er staan 500 dingen op. Vink er eerst wat af.")
    }))

  it.effect("every English and Dutch phrase reads the shopping list, as the read action says it", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.phrases.say("read the shopping list")
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "The shopping list is empty.")
      yield* kit.action("add", { items: "milk, eggs, rice, bread, butter and jam" })
      const expected = said(yield* kit.action("read", {}))
      assert.strictEqual(expected, "The shopping list has 6 things: milk, eggs, rice, bread, butter and 1 more.")
      for (const text of ["Read the shopping list.", "Read me the shopping list", "What is on the shopping list?", "What's on the shopping list", "what is on my shopping list"]) {
        assert.isTrue((yield* kit.phrases.say(text, { device: "kitchen-display" })).taken, text)
        assert.strictEqual(kit.phrases.spoken.at(-1)?.text, expected, text)
      }
      const nl = yield* startTestModule(listsModule, { household: DUTCH })
      yield* nl.action("add", { items: "melk en eieren" })
      for (const text of ["Lees de boodschappenlijst voor", "lees de boodschappenlijst", "Wat staat er op de boodschappenlijst?", "wat staat er op mijn boodschappenlijst"]) {
        assert.isTrue((yield* nl.phrases.say(text)).taken, text)
        assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Op de boodschappenlijst staan 2 dingen: melk en eieren.", text)
      }
    }))

  it.effect("the same phrase invocation twice acts once; a new invocation acts again", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { settings: { mergeDuplicates: false } })
      const first = yield* kit.action("add", { items: "milk" }, { source: "phrase", turnId: 77 })
      const repeat = yield* kit.action("add", { items: "milk" }, { source: "phrase", turnId: 77 })
      assert.deepStrictEqual(repeat, first)
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: milk.")
      // A new invocation has a new turn: it acts, so with merging off the list has milk twice.
      yield* kit.action("add", { items: "milk" }, { source: "phrase", turnId: 78 })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: milk and milk.")
      // Another device, conversation or request is another invocation too.
      yield* kit.action("add", { items: "milk" }, { source: "phrase", turnId: 77, device: "hall-screen" })
      yield* kit.action("add", { items: "eggs" }, { source: "phrase", turnId: 77 })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 4 things: milk, milk, milk and eggs.")
      // A typed or spoken call is the caller's own business: the same turn twice acts twice (as before).
      yield* kit.action("add", { items: "rice" }, { turnId: 90 })
      yield* kit.action("add", { items: "rice" }, { turnId: 90 })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 6 things: milk, milk, milk, eggs, rice and 1 more.")
    }))
})

describe("the examples of the page", () => {
  it.effect("work exactly as written, in English and in Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.phrases.say("Add milk, eggs and bread to the shopping list")
      assert.strictEqual(kit.phrases.spoken.at(-1)?.text, "Added milk, eggs and bread to the shopping list.")
      assert.deepStrictEqual(yield* kit.action("show", {}, { device: "kitchen-display" }), { ok: true, say: "Showing the shopping list on this screen." })
      assert.deepStrictEqual(yield* kit.action("hide", { list: "groceries" }, { device: "kitchen-display" }), { ok: true, say: "Closed the shopping list on this screen." })
      const nl = yield* startTestModule(listsModule, { household: DUTCH })
      yield* nl.phrases.say("zet melk, eieren en brood op de boodschappenlijst")
      yield* nl.phrases.say("wat staat er op de boodschappenlijst")
      assert.strictEqual(nl.phrases.spoken.at(-1)?.text, "Op de boodschappenlijst staan 3 dingen: melk, eieren en brood.")
      assert.deepStrictEqual(yield* nl.action("show", {}, { device: "kitchen-display" }), { ok: true, say: "De boodschappenlijst staat op dit scherm." })
      assert.deepStrictEqual(yield* nl.action("hide", {}, { device: "kitchen-display" }), { ok: true, say: "Wat ik op dit scherm liet zien is gesloten." })
    }))
})

describe("the checklist", () => {
  it.effect("shows a list's open items with ticks on the device that asked: shared, private and public devices alike; not on the others", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk, eggs and two litres of oat milk" })
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        const r = yield* kit.action("show", {}, { device })
        assert.deepStrictEqual(r, { ok: true, say: "Showing the shopping list on this screen." })
        yield* kit.present.settle
        const c = checklistOf(kit, device)
        assert.strictEqual(c?.kind, "list")
        assert.strictEqual(c?.style, "checklist")
        assert.strictEqual(c?.title, "Shopping list")
        assert.deepStrictEqual(textsOf(c), ["milk", "eggs", "2 litres of oat milk"])
        assert.isTrue(c?.items?.every((i) => !i.done))
      }
      // The tool the model has is the same action; a device that was not asked shows nothing.
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      const tool = yield* kit.tool("lists_show", {}, { device: "kitchen-display" })
      assert.isTrue(tool.ok)
      // Asked again on the same device: replaced in place, not a second one.
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      assert.strictEqual((yield* kit.moduleStore().collection(pins).list({})).length, 3)
    }))

  it.effect("the Dutch checklist is in Dutch, and the to-do list is its own", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: DUTCH })
      yield* kit.action("add", { items: "bel de loodgieter", list: "to do" })
      assert.deepStrictEqual(yield* kit.action("show", { list: "to do" }, { device: "kitchen-display" }), { ok: true, say: "De takenlijst staat op dit scherm." })
      yield* kit.present.settle
      const c = checklistOf(kit, "kitchen-display")
      assert.strictEqual(c?.title, "Takenlijst")
      assert.deepStrictEqual(textsOf(c), ["bel de loodgieter"])
    }))

  it.effect("follows the list: an add, a tick, a removal from any device, the service, a tool and the model's update", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), [])
      // Added by voice on another device.
      yield* kit.action("add", { items: "milk and eggs" }, { device: "hall-screen" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk", "eggs"])
      // Added by another module through the service.
      const service = kit.service(Lists)!
      yield* kit.asTurn(service.addItem({ text: "Rice", dedupeKey: "kitchen:product:rice" }), { device: "hall-screen" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk", "eggs", "Rice"])
      yield* kit.asTurn(service.completeByKey("kitchen:product:rice"))
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk", "eggs"])
      // Ticked off and removed by the tools, changed by the model's tool, and undone.
      yield* kit.tool("lists_complete", { item: "milk" }, { device: "robins-phone" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["eggs"])
      yield* kit.tool("lists_update", { item: "eggs", amount: 6 }, { device: "robins-phone" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["6 eggs"])
      yield* kit.action("remove", { item: "eggs" }, { device: "robins-phone", conversationId: "c-2" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), [])
      yield* kit.action("undo", {}, { device: "robins-phone", conversationId: "c-2" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["6 eggs"])
      // The same page, never a second one.
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
    }))

  it.effect("more than twelve open items: twelve are shown and the title and the spoken text say how many are not", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: Array.from({ length: 12 }, (_, i) => `item ${String.fromCharCode(97 + i)}`).join(", ") })
      yield* kit.action("add", { items: "item m, item n, item o" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      const c = checklistOf(kit, "kitchen-display")
      assert.strictEqual(c?.items?.length, 12)
      assert.strictEqual(c?.title, "Shopping list (+3 more)")
      // Where nothing can be shown, the answer is the spoken fallback: it counts all of them.
      const said = yield* kit.action("show", {}, { device: "office-speaker" })
      assert.match(said.ok ? said.say! : "", /15 things: item a, item b, item c, item d, item e and 10 more\./)
    }))

  it.effect("outside text is bounded and never markup: one line, cut at a character, an emoji at the limit stays whole", () =>
    Effect.gen(function*() {
      assert.strictEqual(oneLine("a\u0007b‮c\nd  e f"), "a b c d e f")
      assert.strictEqual(oneLine("lone\ud800 half"), "lone half")
      const cut = cutAt(`${"x".repeat(79)}😀 and more`, 80)
      assert.isTrue(cut.length <= 80)
      assert.isFalse(/[\ud800-\udbff](?![\udc00-\udfff])/.test(cut))
      assert.strictEqual(cut, `${"x".repeat(79)}…`)
      assert.strictEqual(cutAt("short", 80), "short")
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      // A long item with an emoji at the limit.
      const long = `${"y".repeat(78)}😀😀 end`
      yield* kit.action("add", { items: long })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      const c = checklistOf(kit, "kitchen-display")
      assert.isDefined(c)
      assert.isTrue(c!.items!.every((i) => i.text.length <= 80 && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(i.text)))
      // The page's text is what the host received, as text: markup in an item is shown as it is.
      yield* kit.action("add", { items: "<b>bold</b> <script>x</script>" })
      yield* kit.present.settle
      assert.include(textsOf(checklistOf(kit, "kitchen-display"))!.join("|"), "<b>bold</b>")
    }))

  it.effect("a device without a screen is answered in words, nothing is kept for it, and the list is unchanged", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk and eggs" })
      const r = yield* kit.action("show", {}, { device: "office-speaker" })
      assert.deepStrictEqual(r, { ok: true, say: "This device can't show it. The shopping list has 2 things: milk and eggs." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.deepStrictEqual(yield* kit.moduleStore().collection(pins).list({}), [])
      // The model's tool answers the same, and a Dutch household in Dutch.
      const tool = yield* kit.tool("lists_show", {}, { device: "office-speaker" })
      assert.include(tool.content, "The shopping list has 2 things")
      const nl = yield* startTestModule(listsModule, { household: DUTCH })
      yield* nl.action("add", { items: "melk" })
      assert.deepStrictEqual(yield* nl.action("show", {}, { device: "office-speaker" }), { ok: true, say: "Dit apparaat kan het niet tonen. Op de boodschappenlijst staat één ding: melk." })
      // Closing what is not shown says so.
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "office-speaker" }), { ok: true, say: "I'm not showing any list on this screen." })
    }))

  it.effect("is closed on request, and when its list is deleted; the list itself stays", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.action("show", {}, { device: "hall-screen" })
      yield* kit.present.settle
      assert.deepStrictEqual(yield* kit.action("hide", { list: "groceries" }, { device: "kitchen-display" }), { ok: true, say: "Closed the shopping list on this screen." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.strictEqual(kit.present.shown("hall-screen").length, 1)
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "kitchen-display" }), { ok: true, say: "I'm not showing any list on this screen." })
      assert.deepStrictEqual(yield* kit.action("hide", { list: "groceries" }, { device: "kitchen-display" }), { ok: true, say: "The shopping list isn't on this screen." })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has one thing: milk.")
      // Another list, shown and then deleted: the screen follows.
      yield* kit.tool("lists_create", { name: "camping", items: "tent" })
      yield* kit.action("show", { list: "camping" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["tent"])
      yield* kit.tool("lists_delete", { list: "camping" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.strictEqual((yield* kit.moduleStore().collection(pins).list({})).length, 1)
      // Without a name, everything on this screen closes.
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "kitchen-display" }), { ok: true, say: "Closed what I showed on this screen." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("after a restart it still follows its list, and is closed by the same key; when it ends, its pin is forgotten", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.restart
      yield* kit.present.settle
      // The restart forgot the handle, not the pin: the next change shows it again.
      yield* kit.action("add", { items: "milk" })
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk"])
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      yield* kit.restart
      yield* kit.present.settle
      // Closed after a restart: replaced by an empty one that the host ends within seconds.
      assert.deepStrictEqual(yield* kit.action("hide", {}, { device: "kitchen-display" }), { ok: true, say: "Closed what I showed on this screen." })
      yield* kit.present.settle
      assert.deepStrictEqual(yield* kit.moduleStore().collection(pins).list({}), [])
      yield* kit.advance(4_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      // A pin whose time has passed is forgotten by the next change, and not shown again.
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.advance(PIN_MS + 1_000)
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      yield* kit.action("add", { items: "eggs" })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(yield* kit.moduleStore().collection(pins).list({}), [])
    }))

  it.effect("what changed while the module was stopped is on the screen when it starts again", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "milk" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.stop
      // An item arrives while it is stopped (its row, and its list's count).
      yield* kit.moduleStore().transaction((tx) => {
        tx.collection(items).insert({ list: SHOPPING, text: "bread", status: "open", place: placeOf(SHOPPING, "open"), since: 9_000_000_000_000, match: matchOf(SHOPPING, "bread", "open") })
        tx.collection(lists).update(SHOPPING, (v) => ({ ...v, open: v.open + 1 }))
      })
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk"])
      yield* kit.start
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk", "bread"])
    }))

  it.effect("a device shows one checklist: another list there replaces it, and the answer says so", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.tool("lists_create", { name: "camping", items: "tent" })
      yield* kit.action("show", {}, { device: "kitchen-display" })
      const r = yield* kit.action("show", { list: "camping" }, { device: "kitchen-display" })
      assert.deepStrictEqual(r, { ok: true, say: "Showing the camping list on this screen, instead of the shopping list." })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("kitchen-display").length, 1)
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["tent"])
      const rows = yield* kit.moduleStore().collection(pins).list({})
      assert.deepStrictEqual(rows.map((row) => row.id), ["pin.kitchen-display"])
      assert.notStrictEqual(rows[0]!.value.list, SHOPPING)
      // The same list again says nothing about a replacement; the replaced list is not on this screen any more.
      assert.deepStrictEqual(yield* kit.action("show", { list: "camping" }, { device: "kitchen-display" }), { ok: true, say: "Showing the camping list on this screen." })
      assert.deepStrictEqual(yield* kit.action("hide", { list: "groceries" }, { device: "kitchen-display" }), { ok: true, say: "The shopping list isn't on this screen." })
      // In Dutch too.
      const nl = yield* startTestModule(listsModule, { household: DUTCH })
      yield* nl.action("show", {}, { device: "kitchen-display" })
      assert.deepStrictEqual(yield* nl.action("show", { list: "to do" }, { device: "kitchen-display" }), { ok: true, say: "De takenlijst staat nu op dit scherm, in plaats van de boodschappenlijst." })
    }))

  it.effect("no more than eight screens hold one at once (the host's bound for a module), and a ninth says so", () =>
    Effect.gen(function*() {
      const screens: ReadonlyArray<TestDevice> = Array.from({ length: 9 }, (_, i) => ({ id: `screen-${i + 1}`, name: `Screen ${i + 1}`, room: `Room ${i + 1}`, privacy: "shared" }))
      const kit = yield* startTestModule(listsModule, { household: { devices: screens } })
      for (const screen of screens.slice(0, 8)) assert.isTrue((yield* kit.action("show", {}, { device: screen.id })).ok)
      yield* kit.present.settle
      const refused = yield* kit.action("show", {}, { device: "screen-9" })
      assert.isFalse(refused.ok)
      assert.strictEqual(refused.message, "Too many lists are on screens already; close one first.")
      assert.deepStrictEqual(kit.present.shown("screen-9"), [])
      assert.strictEqual((yield* kit.moduleStore().collection(pins).list({})).length, 8)
    }))
})

describe("a tick on the checklist", () => {
  const setup = Effect.gen(function*() {
    const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
    yield* kit.action("add", { items: "milk, eggs and bread" })
    yield* kit.action("show", {}, { device: "kitchen-display" })
    yield* kit.present.settle
    const shown = kit.present.shown("kitchen-display")[0]!
    const content = shown.content as { readonly items: ReadonlyArray<{ readonly id: string; readonly text: string }> }
    const id = (text: string) => content.items.find((i) => i.text === text)!.id
    return { kit, presentation: shown.id, id }
  })

  it.effect("ticks that item off as the tool does, shows the list again and answers; pressed twice it changes nothing more", () =>
    Effect.gen(function*() {
      const { kit, presentation, id } = yield* setup
      const first = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("eggs"), done: true })
      assert.deepStrictEqual(first, { ok: true, say: "Ticked off eggs on the shopping list." })
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk", "bread"])
      // The tool says the same thing; what was ticked off is readable as ticked off.
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Ticked off on the shopping list: eggs.")
      // Pressed again: the page no longer holds the item, so the host refuses it and nothing changes.
      const again = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("eggs"), done: true })
      assert.isFalse(again.ok)
      assert.strictEqual(said(yield* kit.action("read", { show: "done" })), "Ticked off on the shopping list: eggs.")
      // The press is a state change of that item only: another item is untouched.
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: milk and bread.")
    }))

  it.effect("the handler itself is idempotent: an item already ticked off elsewhere is not ticked again", () =>
    Effect.gen(function*() {
      const { kit, presentation, id } = yield* setup
      const eggs = (yield* kit.moduleStore().collection(items).list({})).find((r) => r.value.text === "eggs")!
      // Ticked off behind the module's back (no change signal): the page still holds the item, so the press reaches the handler.
      yield* kit.moduleStore().transaction((tx) => void tx.collection(items).update(eggs.id, (v) => withStatus(v, "done", 5)))
      const rev = (yield* kit.moduleStore().collection(items).get(eggs.id))!.rev
      const r = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("eggs"), done: true })
      assert.deepStrictEqual(r, { ok: true, say: "Already ticked off: eggs." })
      assert.strictEqual((yield* kit.moduleStore().collection(items).get(eggs.id))!.rev, rev)
    }))

  it.effect("from a device that does not hold it: refused, nothing changes; and an untick is not a thing this list does", () =>
    Effect.gen(function*() {
      const { kit, presentation, id } = yield* setup
      const other = yield* kit.present.press(presentation, "tick", { device: "hall-screen", item: id("milk"), done: true })
      assert.deepStrictEqual(other, { ok: false, say: "I can't do that right now.", code: "unknown" })
      const untick = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("milk"), done: false })
      assert.deepStrictEqual(untick, { ok: true, say: "Here I can only tick things off." })
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 3 things: milk, eggs and bread.")
    }))

  it.effect("with the module restarted in between it still ticks off, and while it is stopped says it cannot", () =>
    Effect.gen(function*() {
      const { kit, presentation, id } = yield* setup
      yield* kit.restart
      yield* kit.present.settle
      const r = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("bread"), done: true })
      assert.strictEqual(r.ok, true)
      assert.strictEqual(said(yield* kit.action("read", {})), "The shopping list has 2 things: milk and eggs.")
      yield* kit.present.settle
      assert.deepStrictEqual(textsOf(checklistOf(kit, "kitchen-display")), ["milk", "eggs"])
      yield* kit.stop
      const stopped = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("milk"), done: true })
      assert.deepStrictEqual(stopped, { ok: false, say: "I can't do that right now.", code: "not_running" })
    }))

  it.effect("an item removed meanwhile is said to be gone, and the checklist is shown again without it", () =>
    Effect.gen(function*() {
      const { kit, presentation, id } = yield* setup
      const milk = (yield* kit.moduleStore().collection(items).list({})).find((r) => r.value.text === "milk")!
      yield* kit.moduleStore().transaction((tx) => void tx.collection(items).update(milk.id, (v) => withStatus(v, "removed", 5)))
      const r = yield* kit.present.press(presentation, "tick", { device: "kitchen-display", item: id("milk"), done: true })
      assert.deepStrictEqual(r, { ok: true, say: "That isn't on the list any more." })
    }))
})

describe("the pin and what it stores", () => {
  it.effect("a pin row names a list and a device, and holds no person and none of the list's content", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(listsModule, { household: HOUSEHOLD })
      yield* kit.action("add", { items: "secret milk" })
      yield* kit.action("show", {}, { device: "robins-phone" })
      const rows = yield* kit.moduleStore().collection(pins).list({})
      assert.strictEqual(rows.length, 1)
      assert.deepStrictEqual(Object.keys(rows[0]!.value).sort(), ["device", "key", "list", "shown", "until"])
      assert.strictEqual(rows[0]!.value.device, "robins-phone")
      // The row's value (the store's own change record, `updatedBy`, is the store's).
      assert.notInclude(JSON.stringify(rows.map((r) => r.value)), "milk")
      assert.notInclude(JSON.stringify(rows.map((r) => r.value)), "p-robin")
    }))
})
