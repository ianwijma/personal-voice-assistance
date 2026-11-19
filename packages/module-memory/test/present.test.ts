// What the memory module shows (docs/modules/memory.md, "On a screen"): the card after something was remembered, with
// one button, Undo, and the list of a recall or a notes read. Through the real host and Presenter, as the test kit runs
// them: each on the shared, private and public devices of the household and on a device without a screen; an update and
// a withdrawal; Undo pressed twice, from a device that does not hold it, and across a restart of the module.
import { assert, describe, it } from "@effect/vitest"
import { PresentError, StoreError } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { Deferred, Effect, Fiber } from "effect"
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
      // The Remembered card is taken down with the row; the confirmation is a new card, without a button.
      assert.notStrictEqual(after?.id, card.id)
      assert.isUndefined(kit.present.shown("kitchen-display").find((p) => p.id === card.id))
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

// --- Review round 1 --------------------------------------------------------------------------------------------------

/** The module with its shared part's store and presenter wrapped, to fail or pause what the shared part calls. */
interface Hooks {
  readonly failGet?: { on: boolean }
  readonly failShow?: { on: boolean }
  /** Called after the shared part's `memories.get` returns, before it answers (the first call only, then cleared). */
  gateGet?: Effect.Effect<void>
  readonly handlers?: Map<string, (press: any) => Effect.Effect<any, any>>
}
const withShared = (hooks: Hooks): typeof memoryModule => ({
  ...memoryModule,
  shared: (ctx: any) =>
    memoryModule.shared!({
      ...ctx,
      store: {
        ...ctx.store,
        collection: (c: any) => {
          const h = ctx.store.collection(c)
          return {
            ...h,
            get: (...a: Array<any>) =>
              hooks.failGet?.on === true
                ? Effect.fail(new StoreError({ reason: "busy", message: "busy (test)" }))
                : Effect.flatMap(h.get(...a), (row: unknown) => {
                  const gate = hooks.gateGet
                  hooks.gateGet = undefined
                  return gate === undefined ? Effect.succeed(row) : Effect.as(gate, row)
                })
          }
        }
      },
      present: {
        ...ctx.present,
        show: (...a: Array<any>) => (hooks.failShow?.on === true ? Effect.fail(new PresentError({ reason: "busy", message: "busy (test)" })) : ctx.present.show(...a)),
        handle: (name: string, handler: any) => {
          hooks.handlers?.set(name, handler.run)
          return ctx.present.handle(name, handler)
        }
      }
    })
}) as typeof memoryModule

describe("memory: review round 1", () => {
  it.effect("1. the handles follow what is on screens: churn on one device never loses another device's list", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      const rows = kit.moduleStore().collection(memories)
      const plumber = yield* rows.insert(memory("The plumber is called Joost", now - 1_000))
      yield* kit.tool("memory_recall", { query: "plumber" }, as(kitchen))
      yield* kit.present.settle
      assert.isDefined(listOf(kit, "kitchen-display"))
      // Eight cards on Robin's phone, each replacing the one before, with no time passing: two presentations are live.
      for (let i = 0; i < 8; i++) yield* kit.tool("memory_remember", { text: `Churn fact number ${i}` }, as(robin))
      yield* kit.present.settle
      assert.strictEqual(kit.present.engine.live().length, 2)
      // Forgetting from the phone takes the kitchen's list down.
      assert.include((yield* kit.tool("memory_forget", { id: plumber.id }, as(robin))).content, "Forgotten")
      yield* kit.present.settle
      assert.isUndefined(listOf(kit, "kitchen-display"))
      // And an empty answer takes a list down after the same churn.
      yield* kit.tool("memory_recall", { query: "churn" }, as(kitchen))
      yield* kit.present.settle
      assert.isDefined(listOf(kit, "kitchen-display"))
      for (let i = 8; i < 16; i++) yield* kit.tool("memory_remember", { text: `Churn fact number ${i}` }, as(robin))
      yield* kit.tool("memory_recall", { query: "zebra" }, as(kitchen))
      yield* kit.present.settle
      assert.isUndefined(listOf(kit, "kitchen-display"))
    }))

  it.effect("2a. a recall that a forget overtakes shows nothing of the forgotten item", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      const store = kit.moduleStore().collection(memories)
      const plumber = yield* store.insert(memory("The plumber is called Joost", now))
      for (let i = 0; i < 34; i++) yield* store.insert(memory(`filler ${i}`, now - 100_000 + i))
      yield* Effect.all([kit.tool("memory_recall", { query: "plumber" }, as(kitchen)), kit.tool("memory_forget", { id: plumber.id }, as(robin))], { concurrency: "unbounded" })
      yield* kit.present.settle
      assert.notInclude(JSON.stringify(kit.present.shown("kitchen-display")), "Joost")
      assert.notInclude(yield* memoriesNow(kit), "The plumber is called Joost")
    }))

  it.effect("2b. a notes read that a forget overtakes shows nothing of the forgotten note", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      const store = kit.moduleStore().collection(notes)
      const first = yield* store.insert(note("Valve note", now))
      yield* Effect.all([kit.tool("memory_read_notes", {}, as(kitchen)), kit.tool("memory_forget", { id: first.id }, as(robin))], { concurrency: "unbounded" })
      yield* kit.present.settle
      assert.notInclude(JSON.stringify(kit.present.shown("kitchen-display")), "Valve")
    }))

  it.effect("2c. an Undo pressed while a recall reads leaves no list with the undone memory", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      const store = kit.moduleStore().collection(memories)
      for (let i = 0; i < 34; i++) yield* store.insert(memory(`filler ${i}`, now - 100_000 + i))
      yield* kit.tool("memory_remember", { text: "The plumber is called Joost" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      yield* Effect.all([kit.present.press(card.id, "undo", as(kitchen)), kit.tool("memory_recall", { query: "plumber" }, as(robin))], { concurrency: "unbounded" })
      yield* kit.present.settle
      assert.notInclude(JSON.stringify(kit.present.shown("robins-phone")), "Joost")
      assert.notInclude(JSON.stringify(kit.present.shown("kitchen-display")), "Joost")
      assert.notInclude(yield* memoriesNow(kit), "The plumber is called Joost")
    }))

  it.effect("2d. a card whose memory was forgotten between its storing and its showing is not shown", () =>
    Effect.gen(function*() {
      const hooks: Hooks = {}
      const kit = yield* startTestModule(withShared(hooks), house)
      const at = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      hooks.gateGet = Effect.andThen(Deferred.succeed(at, undefined), Deferred.await(go))
      const remembering = yield* Effect.forkChild(kit.tool("memory_remember", { text: "The plumber is called Joost" }, as(kitchen)))
      yield* Deferred.await(at)
      // The memory is stored and the card is about to be shown: forget it now.
      yield* kit.tool("memory_forget", { query: "plumber" }, as(robin))
      yield* Deferred.succeed(go, undefined)
      yield* Fiber.join(remembering)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
      assert.deepStrictEqual(yield* memoriesNow(kit), [])
    }))

  for (const [name, options, unreadable, forgotten] of [["English", house, "I can't read my notes right now. Try again in a moment.", "Forgotten:"], ["Dutch", dutch, "Ik kan mijn notities nu niet lezen. Probeer het zo nog eens.", "Vergeten:"]] as const) {
    it.effect(`3. an Undo whose read fails says it could not read (${name}), records nothing, and works when pressed again`, () =>
      Effect.gen(function*() {
        const hooks: Hooks = { failGet: { on: false } }
        const kit = yield* startTestModule(withShared(hooks), options)
        yield* kit.tool("memory_remember", { text: "The boiler is in the cellar" }, as(kitchen))
        yield* kit.present.settle
        const card = cardOf(kit, "kitchen-display")!
        hooks.failGet!.on = true
        assert.deepStrictEqual(yield* kit.present.press(card.id, "undo", as(kitchen)), { ok: true, say: unreadable })
        assert.deepStrictEqual(yield* memoriesNow(kit), ["The boiler is in the cellar"])
        assert.strictEqual(cardOf(kit, "kitchen-display")?.buttons.length, 1)
        hooks.failGet!.on = false
        const again = yield* kit.present.press(card.id, "undo", as(kitchen))
        assert.isTrue(again.ok)
        assert.include(again.say, forgotten)
        assert.deepStrictEqual(yield* memoriesNow(kit), [])
      }))
  }

  it.effect("4. an Undo whose confirmation cannot be shown still leaves neither the text nor the button on the screen", () =>
    Effect.gen(function*() {
      const hooks: Hooks = { failShow: { on: false } }
      const kit = yield* startTestModule(withShared(hooks), house)
      yield* kit.tool("memory_remember", { text: "The boiler is in the cellar" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      hooks.failShow!.on = true
      const answer = yield* kit.present.press(card.id, "undo", as(kitchen))
      assert.isTrue(answer.ok)
      assert.include(answer.say, "Forgotten")
      assert.deepStrictEqual(yield* memoriesNow(kit), [])
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("the module's record makes the same presentation id act once (the handler called twice, as the host would not)", () =>
    Effect.gen(function*() {
      const hooks: Hooks = { handlers: new Map() }
      const kit = yield* startTestModule(withShared(hooks), house)
      yield* kit.tool("memory_remember", { text: "The boiler is in the cellar" }, as(kitchen))
      yield* kit.present.settle
      const card = cardOf(kit, "kitchen-display")!
      const key = kit.present.engine.live()[0]!.key
      const run = hooks.handlers!.get("memory_undo")!
      const press = { presentationId: card.id, key, deviceId: "kitchen-display", action: "undo" }
      const first = yield* run(press)
      yield* kit.tool("memory_remember", { text: "The boiler is in the cellar" }, as(kitchen))
      const second = yield* run(press)
      assert.deepStrictEqual(second, first)
      assert.deepStrictEqual(yield* memoriesNow(kit), ["The boiler is in the cellar"])
    }))

  for (const [name, options] of [["English", house], ["Dutch", dutch]] as const) {
    it.effect(`5. a note whose text has an emoji at the spoken helper's cut still gets its list, in recall and in a notes read (${name})`, () =>
      Effect.gen(function*() {
        const kit = yield* start(options)
        const now = yield* kit.now
        const text = `${"a".repeat(118)}😀 trailing note`
        yield* kit.moduleStore().collection(notes).insert(note(text, now))
        yield* kit.tool("memory_read_notes", {}, as(kitchen))
        yield* kit.present.settle
        assert.isDefined(listOf(kit, "kitchen-display"), "notes read")
        yield* kit.tool("memory_recall", { query: "trailing" }, as(kitchen))
        yield* kit.present.settle
        assert.isDefined(listOf(kit, "kitchen-display"), "recall")
        // The answer to the model is what it was: the stored text, whole.
        const read = yield* kit.tool("memory_read_notes", {}, as(kitchen))
        assert.include(read.content, "trailing note")
      }))
  }

  it.effect("a public device where the asker's own default person is Sam: Sam's personal memory is not shown there, nor its text", () =>
    Effect.gen(function*() {
      const kit = yield* start()
      const now = yield* kit.now
      yield* kit.moduleStore().collection(memories).insert(memory("Sam keeps spare keys under the pot", now - 500, { scopeKey: "p:p-sam", owner: "p-sam" }))
      yield* kit.moduleStore().collection(memories).insert(memory("The spare room is blue", now - 1_000))
      yield* kit.tool("memory_recall", { query: "spare" }, as(hall))
      yield* kit.present.settle
      assert.deepStrictEqual(itemTexts(kit, "hall-screen"), ["The spare room is blue", "Personal items are kept for their owner's devices."])
      assert.notInclude(JSON.stringify(kit.present.messages), "keys under")
      yield* kit.tool("memory_recall", { query: "spare" }, as(kitchen))
      yield* kit.present.settle
      assert.include(itemTexts(kit, "kitchen-display")!.join("|"), "keys under the pot")
    }))
})
