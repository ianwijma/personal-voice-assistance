// What the memory module shows (docs/modules/memory.md, "On a screen"): the card after something was remembered, with
// one button, Undo, and the list of a recall or a notes read. Through the real host and Presenter, as the test kit runs
// them: each on the shared, private and public devices of the household and on a device without a screen; an update and
// a withdrawal; Undo pressed twice, from a device that does not hold it, and across a restart of the module.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { memories, memoryModule, notes, SCAN_ROWS, type Memory, type Note } from "../src/index.ts"
import { cutPoints, lineText } from "../src/present.ts"

vi.setConfig({ testTimeout: 30_000 })

const kitchen = { device: "kitchen-display" } // shared, Sam's
const robin = { device: "robins-phone" } // private, Robin's
const hall = { device: "hall-screen" } // public, nobody's (Sam is its default person but a public screen reveals no one's)
const speaker = { device: "office-speaker" } // a speaker: no display
const house = {
  household: {
    devices: [
      { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-sam" },
      { id: "robins-phone", name: "Robin's phone", privacy: "private" as const, defaultPerson: "p-robin" },
      { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: "p-sam" },
      { id: "office-speaker", name: "Office speaker", room: "Office", privacy: "shared" as const, defaultPerson: "p-sam", capabilities: { v: 1, speaker: { media: ["speech"] } } }
    ]
  }
}
const dutch = { household: { ...house.household, home: { HOME_LANGUAGE: "nl-NL" } } }

const memory = (text: string, at: number, extra: Partial<Memory> = {}): Memory => ({ text, kind: "fact", scopeKey: "household", at, pinnedAt: 0, ...extra })
const note = (text: string, at: number, extra: Partial<Note> = {}): Note => ({ text, notebook: "notes", shelf: "household/notes", scopeKey: "household", at, ...extra })
const robins = { scopeKey: "p:p-robin", owner: "p-robin" }

/** Each call has its own turn id: the kit gives every call the same one unless told otherwise. */
let turn = 1_000
const as = (where: { readonly device: string }) => ({ ...where, turnId: ++turn })

const start = (options: object = house) => startTestModule(memoryModule, options)
type Kit = Effect.Success<ReturnType<typeof start>>

const cardOf = (kit: Kit, device: string) => kit.present.shown(device).find((p) => p.content.kind === "card")
const listOf = (kit: Kit, device: string) => kit.present.shown(device).find((p) => p.content.kind === "list")
const itemTexts = (kit: Kit, device: string) => {
  const l = listOf(kit, device)
  return l?.content.kind === "list" ? l.content.items.map((i) => i.text) : undefined
}
const memoriesNow = (kit: Kit) => Effect.map(kit.moduleStore().collection(memories).list({}), (rows) => rows.map((r) => r.value.text))

describe("memory: the card after something was remembered", () => {
  it.effect("shows 'Remembered' with one Undo button on the device that asked, and the answer is what it was", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const r = yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      // The answer is untouched by the card.
      assert.deepStrictEqual(r.value, { spoken: "Got it: Sam is allergic to nuts." })
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")
      assert.strictEqual(card?.content.kind === "card" ? card.content.title : "", "Remembered")
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "Sam is allergic to nuts")
      assert.deepStrictEqual(card?.buttons.map((b) => [b.id, b.label]), [["undo", "Undo"]])
      assert.strictEqual(card?.lifetime, "transient")
      assert.isTrue(card?.interactive)
      // Only the device that asked shows it.
      for (const other of ["robins-phone", "hall-screen", "office-speaker"]) assert.deepStrictEqual(kit.present.shown(other), [], other)
    }))

  it.effect("the typed action shows it too; a memory it already knew shows nothing", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      assert.strictEqual((yield* kit.action("remember", { text: "The boiler is in the cellar", mine: false }, as(kitchen))).ok, true)
      yield* kit.present.settle
      assert.strictEqual(cardOf(kit, "kitchen-display")?.buttons.length, 1)
      // Dismiss what is there by pressing Undo on another memory's card later; here: the same text again is "already known".
      const before = kit.present.shown("kitchen-display").map((p) => p.id)
      yield* kit.action("remember", { text: "the boiler is in the cellar", mine: false }, as(kitchen))
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), before)
      assert.deepStrictEqual(yield* memoriesNow(kit), ["The boiler is in the cellar"])
    }))

  it.effect("in Dutch the card and its button are Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* start(dutch)
      yield* kit.tool("memory_remember", { text: "Sam is allergisch voor noten" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")
      assert.strictEqual(card?.content.kind === "card" ? card.content.title : "", "Onthouden")
      assert.deepStrictEqual(card?.buttons.map((b) => b.label), ["Ongedaan maken"])
      const undone = yield* kit.present.press(card!.id, "undo", kitchen)
      assert.deepStrictEqual(undone, { ok: true, say: "Vergeten: Sam is allergisch voor noten. In back-ups blijft het tot 14 dagen bewaard." })
    }))

  it.effect("a device without a screen shows nothing, and the answer is the same", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const r = yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(speaker))
      assert.deepStrictEqual(r.value, { spoken: "Got it: Sam is allergic to nuts." })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === "office-speaker" && !d.decision.show))
      assert.deepStrictEqual(yield* memoriesNow(kit), ["Sam is allergic to nuts"])
    }))

  it.effect("a household memory is shown on the public screen; a personal one is not shown there, nor is its text anywhere on it", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "The boiler is in the cellar" }, as(hall))
      yield* kit.present.settle
      assert.strictEqual(cardOf(kit, "hall-screen")?.buttons.length, 1)
      const quiet = yield* kit.tool("memory_remember", { text: "I dislike coriander", forMe: true }, as(hall))
      assert.deepStrictEqual(quiet.value, { spoken: "Got it, only for you." })
      yield* kit.present.settle
      // The household card was replaced by nothing personal: the hall shows no card with the personal text.
      assert.notInclude(JSON.stringify(kit.present.shown("hall-screen")), "coriander")
      assert.notInclude(JSON.stringify(kit.present.messages), "coriander")
      assert.sameMembers(yield* memoriesNow(kit), ["The boiler is in the cellar", "I dislike coriander"])
    }))

  it.effect("a personal memory is shown on the private phone and on a shared screen of its owner, not elsewhere", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "I take my tea with honey", forMe: true }, as(robin))
      yield* kit.present.settle
      const card = cardOf(kit, "robins-phone")
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "I take my tea with honey")
      // It is the owner's: the Presenter decides again for every device it could show on.
      assert.deepStrictEqual(kit.present.engine.live().map((v) => v.owner), ["p-robin"])
      for (const other of ["kitchen-display", "hall-screen", "office-speaker"]) assert.deepStrictEqual(kit.present.shown(other), [], other)
      yield* kit.tool("memory_remember", { text: "I take my coffee black", forMe: true }, as(kitchen))
      yield* kit.present.settle
      const mine = cardOf(kit, "kitchen-display")
      assert.strictEqual(mine?.content.kind === "card" ? mine.content.text : "", "I take my coffee black")
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
    }))

  it.effect("a text with an emoji at the limit is still a valid card, cut between code points", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      // 298 letters, then emoji: the card's limit (300 units, one for the cut mark) falls inside the first emoji.
      const text = `${"a".repeat(298)}${"😀".repeat(40)}`
      yield* kit.tool("memory_remember", { text }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")
      assert.isDefined(card)
      const shown = card?.content.kind === "card" ? card.content.text ?? "" : ""
      assert.isAtMost(shown.length, 300)
      assert.match(shown, /^a{298}…$/)
      // The cut itself: never a lone surrogate, always inside the limit.
      for (let max = 2; max < 12; max++) {
        const cut = cutPoints("a😀b😀c😀d😀e😀", max)
        assert.isAtMost(cut.length, max)
        assert.notMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
      }
      assert.strictEqual(lineText("a b‮c", 80), "a b c")
    }))
})

describe("memory: Undo", () => {
  it.effect("forgets what the card showed, replaces the card by 'Forgotten' without a button, and pressed again does nothing", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      assert.deepStrictEqual(yield* kit.present.press(card.id, "undo", as(kitchen)), { ok: true, say: "Forgotten: Sam is allergic to nuts. Backups keep it for up to 14 days." })
      assert.deepStrictEqual(yield* memoriesNow(kit), [])
      const after = cardOf(kit, "kitchen-display")
      assert.strictEqual(after?.id, card.id)
      assert.deepStrictEqual(after?.buttons, [])
      assert.strictEqual(after?.content.kind === "card" ? after.content.title : "", "Forgotten")
      assert.notInclude(JSON.stringify(after), "nuts")
      // The same text remembered again is a new memory; the old card's Undo must not take it away.
      yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      yield* kit.present.settle
      const second = yield* kit.present.press(card.id, "undo", as(kitchen))
      assert.strictEqual(second.ok, false)
      assert.deepStrictEqual(yield* memoriesNow(kit), ["Sam is allergic to nuts"])
    }))

  it.effect("two presses at once act once", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      const both = yield* Effect.all([kit.present.press(card.id, "undo", as(kitchen)), kit.present.press(card.id, "undo", as(kitchen))], { concurrency: "unbounded" })
      assert.strictEqual(both.filter((r) => r.ok).length, 1)
      assert.deepStrictEqual(yield* memoriesNow(kit), [])
    }))

  it.effect("pressed from a device that does not hold the card, it does nothing", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      for (const device of ["hall-screen", "robins-phone", "office-speaker"]) {
        assert.deepStrictEqual(yield* kit.present.press(card.id, "undo", as({ device })), { ok: false, say: "I can't do that right now.", code: "unknown" }, device)
      }
      assert.deepStrictEqual(yield* memoriesNow(kit), ["Sam is allergic to nuts"])
    }))

  it.effect("with the module restarted in between, the card is gone and the press changes nothing", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.strictEqual((yield* kit.present.press(card.id, "undo", as(kitchen))).ok, false)
      assert.deepStrictEqual(yield* memoriesNow(kit), ["Sam is allergic to nuts"])
      // A new card after the restart works.
      yield* kit.tool("memory_remember", { text: "Robin likes tea" }, as(kitchen))
      yield* kit.present.settle
      assert.strictEqual((yield* kit.present.press(cardOf(kit, "kitchen-display")!.id, "undo", as(kitchen))).ok, true)
      assert.deepStrictEqual(yield* memoriesNow(kit), ["Sam is allergic to nuts"])
    }))

  it.effect("while the module is stopped it answers 'I can't do that right now'", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "Sam is allergic to nuts" }, as(kitchen))
      yield* kit.present.settle
      const id = cardOf(kit, "kitchen-display")!.id
      yield* kit.stop
      const r = yield* kit.present.press(id, "undo", as(kitchen))
      assert.strictEqual(r.ok, false)
    }))

  it.effect("a memory already forgotten by another way takes its card down; the press cannot then act", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "The plumber is called Joost" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      yield* kit.tool("memory_forget", { query: "plumber" }, as(kitchen))
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.strictEqual((yield* kit.present.press(card.id, "undo", as(kitchen))).ok, false)
    }))

  it.effect("a personal memory is undone from the private phone it was shown on", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      yield* kit.tool("memory_remember", { text: "I take my tea with honey", forMe: true }, as(robin))
      yield* kit.present.settle
      const card = cardOf(kit, "robins-phone")!
      assert.strictEqual((yield* kit.present.press(card.id, "undo", as(robin))).ok, true)
      assert.deepStrictEqual(yield* memoriesNow(kit), [])
      const after = cardOf(kit, "robins-phone")
      assert.notInclude(JSON.stringify(after), "honey")
      assert.deepStrictEqual(after?.buttons, [])
    }))
})

describe("memory: the list of a recall and of a notes read", () => {
  it.effect("shows what the answer said on the device that asked, on the shared, private and public devices, and not on a speaker", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      yield* kit.moduleStore().collection(memories).insert(memory("The plumber is called Joost", now - 1_000))
      yield* kit.moduleStore().collection(notes).insert(note("The plumber said the valve needs replacing", now - 500))
      for (const where of [kitchen, robin, hall]) {
        yield* kit.tool("memory_recall", { query: "plumber" }, as(where))
        yield* kit.present.settle
        // Where a person is asking but the device may not tell their things (the public hall), the answer says that something
        // is kept, and so does the list; nothing personal exists in this household, and neither says otherwise.
        const withheld = where.device === "hall-screen" ? ["Personal items are kept for their owner's devices."] : []
        assert.deepStrictEqual(itemTexts(kit, where.device), ["The plumber said the valve needs replacing", "The plumber is called Joost", ...withheld], where.device)
      }
      yield* kit.tool("memory_recall", { query: "plumber" }, as(speaker))
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("office-speaker"), [])
      // The typed action shows the same.
      yield* kit.action("recall", { query: "joost" }, as(kitchen))
      yield* kit.present.settle
      assert.deepStrictEqual(itemTexts(kit, "kitchen-display"), ["The plumber is called Joost"])
    }))

  it.effect("a second answer replaces the list in place, an empty answer takes it down, and forgetting takes it down", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      yield* kit.moduleStore().collection(memories).insert(memory("The plumber is called Joost", now - 1_000))
      yield* kit.moduleStore().collection(memories).insert(memory("The boiler is in the cellar", now - 900))
      yield* kit.tool("memory_recall", { query: "plumber" }, as(kitchen))
      yield* kit.present.settle
      const first = listOf(kit, "kitchen-display")!
      yield* kit.tool("memory_recall", { query: "boiler" }, as(kitchen))
      yield* kit.present.settle
      const second = listOf(kit, "kitchen-display")!
      assert.strictEqual(second.id, first.id)
      assert.deepStrictEqual(itemTexts(kit, "kitchen-display"), ["The boiler is in the cellar"])
      // An answer that found nothing: what was on the screen no longer holds.
      yield* kit.tool("memory_recall", { query: "zebra" }, as(kitchen))
      yield* kit.present.settle
      assert.isUndefined(listOf(kit, "kitchen-display"))
      // A list, then the item it shows is forgotten: the list goes.
      yield* kit.tool("memory_recall", { query: "boiler" }, as(kitchen))
      yield* kit.present.settle
      assert.isDefined(listOf(kit, "kitchen-display"))
      yield* kit.tool("memory_forget", { query: "boiler" }, as(kitchen))
      yield* kit.present.settle
      assert.isUndefined(listOf(kit, "kitchen-display"))
    }))

  it.effect("says 'and N more' and where the scan was cut; never claims everything", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      for (let i = 0; i < 10; i++) yield* kit.moduleStore().collection(memories).insert(memory(`Plumber fact ${i}`, now - 1_000 + i))
      yield* kit.tool("memory_recall", { query: "plumber" }, as(kitchen))
      yield* kit.present.settle
      const texts = itemTexts(kit, "kitchen-display")!
      assert.strictEqual(texts.length, 9)
      assert.strictEqual(texts[0], "Plumber fact 9")
      assert.strictEqual(texts[8], "and 2 more")
    }))

  it.effect("where the scan was cut, the list says so", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      const store = kit.moduleStore().collection(notes)
      yield* store.insert(note("The plumber came", now))
      for (let i = 0; i < SCAN_ROWS; i++) yield* store.insert(note(`filler ${i}`, now - 10_000 + i))
      yield* kit.tool("memory_recall", { query: "plumber" }, as(kitchen))
      yield* kit.present.settle
      const texts = itemTexts(kit, "kitchen-display")!
      assert.strictEqual(texts[0], "The plumber came")
      assert.match(texts.at(-1)!, /^Only the newest \d+ entries were searched; there may be more\.$/)
    }), 120_000)

  it.effect("on a public screen the personal items are left out, and the list says something is kept without naming it", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      yield* kit.moduleStore().collection(memories).insert(memory("The plumber is called Joost", now - 1_000))
      yield* kit.moduleStore().collection(memories).insert(memory("Robin's plumber is Piet", now - 500, robins))
      yield* kit.tool("memory_recall", { query: "plumber" }, as(hall))
      yield* kit.present.settle
      // Sam is the hall's default person but the screen is public: Robin's thing is not for it.
      assert.deepStrictEqual(itemTexts(kit, "hall-screen"), ["The plumber is called Joost", "Personal items are kept for their owner's devices."])
      assert.notInclude(JSON.stringify(kit.present.messages), "Piet")
      // Robin's phone shows both, the card personal to Robin.
      yield* kit.tool("memory_recall", { query: "plumber" }, as(robin))
      yield* kit.present.settle
      assert.deepStrictEqual(itemTexts(kit, "robins-phone"), ["Robin's plumber is Piet", "The plumber is called Joost"])
      assert.deepStrictEqual(kit.present.engine.live().filter((v) => v.kind === "list").map((v) => v.owner).sort(), [undefined, "p-robin"].sort())
      // A shared screen whose person is Sam does not show Robin's.
      yield* kit.tool("memory_recall", { query: "plumber" }, as(kitchen))
      yield* kit.present.settle
      assert.notInclude(JSON.stringify(kit.present.shown("kitchen-display")), "Piet")
    }))

  it.effect("a notes read shows the newest notes, newline-free, and says there are older ones", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      for (let i = 0; i < 7; i++) yield* kit.moduleStore().collection(notes).insert(note(`Note ${i}\nsecond line`, now - 1_000 + i))
      yield* kit.tool("memory_read_notes", { limit: 5 }, as(kitchen))
      yield* kit.present.settle
      const texts = itemTexts(kit, "kitchen-display")!
      assert.deepStrictEqual(texts, ["Note 6 second line", "Note 5 second line", "Note 4 second line", "Note 3 second line", "Note 2 second line", "There are older notes too."])
      yield* kit.action("read_notes", {}, as(kitchen))
      yield* kit.present.settle
      assert.strictEqual(itemTexts(kit, "kitchen-display")?.length, 6)
    }))

  it.effect("a note with an emoji at the item limit is a valid item", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      yield* kit.moduleStore().collection(notes).insert(note(`${"a".repeat(78)}${"😀".repeat(5)}`, now))
      yield* kit.tool("memory_read_notes", {}, as(kitchen))
      yield* kit.present.settle
      const [text] = itemTexts(kit, "kitchen-display") ?? []
      assert.isDefined(text)
      assert.isAtMost(text!.length, 80)
      assert.match(text!, /^a{78}…$/)
    }))

  it.effect("in Dutch the list and its notes are Dutch", () =>
    Effect.gen(function*() {
      const kit = yield* start(dutch)
      const now = yield* kit.now
      for (let i = 0; i < 10; i++) yield* kit.moduleStore().collection(memories).insert(memory(`Loodgieter feit ${i}`, now - 1_000 + i))
      yield* kit.tool("memory_recall", { query: "loodgieter" }, as(kitchen))
      yield* kit.present.settle
      const l = listOf(kit, "kitchen-display")
      assert.strictEqual(l?.content.kind === "list" ? l.content.title : "", "Wat ik vond")
      assert.strictEqual(itemTexts(kit, "kitchen-display")?.at(-1), "en nog 2")
    }))
})
