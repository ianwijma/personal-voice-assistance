// The briefing's phrase commands and its list presentation, through the kit: the real host, matcher, gateway and
// Presenter (docs/PHRASES.md, docs/PRESENTING.md). The sections are stand-ins of the modules that contribute them.
import { assert, describe, it, vi } from "@effect/vitest"
import { checkModule, provide, startTestModule } from "@pva/core/testing"
import { type BriefingRequest, type BriefingSection, BriefingSections, type BriefingSectionResult } from "@pva/module-contracts"
import { Effect } from "effect"
import { briefingModule, texts } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })

type Gather = (request: BriefingRequest) => Effect.Effect<BriefingSectionResult, never>
const section = (id: string, title: string, gather: Gather): BriefingSection => ({ id, title, gather })
const said = (id: string, title: string, sentences: ReadonlyArray<string>, priority: "lead" | "normal" | "filler" = "normal", owner?: string): BriefingSection =>
  section(id, title, () => Effect.succeed({ _tag: "section", sentences, priority, withheld: 0, ...(owner !== undefined ? { owner } : {}) }))
const providing = (...sections: ReadonlyArray<BriefingSection>) =>
  sections.map((s, i) => provide(`source${i}`, { contributions: [BriefingSections.of(s)] }))

const weather = said("weather", "Weather", ["It is eight degrees and dry."])
const calendar = said("calendar", "Calendar", ["Standup at nine thirty."])
const news = said("news", "News", ["The big story."])

const KITCHEN = "kitchen-display"
const PHONE = "robins-phone"
const HALL = "hall-screen"
const SPEAKER = "office-speaker"

const household = (extra: { readonly home?: Record<string, string>; readonly publicPerson?: string | null } = {}) => ({
  devices: [
    { id: KITCHEN, name: "Kitchen display", room: "Kitchen", privacy: "shared" as const, defaultPerson: "p-sam" },
    { id: PHONE, name: "Robin's phone", room: "Bedroom", privacy: "private" as const, defaultPerson: "p-robin" },
    { id: HALL, name: "Hall screen", room: "Hall", privacy: "public" as const, defaultPerson: extra.publicPerson ?? null },
    { id: SPEAKER, name: "Office speaker", room: "Office", privacy: "shared" as const, defaultPerson: "p-sam", capabilities: { v: 1 as const, speaker: { media: ["speech" as const] } } }
  ],
  ...(extra.home !== undefined ? { home: extra.home } : {})
})
const DUTCH = household({ home: { HOME_LANGUAGE: "nl-NL" } })

const items = (kit: { readonly present: { readonly shown: (d?: string) => ReadonlyArray<{ readonly content: { readonly kind: string } }> } }, device: string): ReadonlyArray<string> => {
  const [list] = kit.present.shown(device)
  const content = list?.content as { kind: string; items?: ReadonlyArray<{ text: string }> } | undefined
  return content?.items?.map((i) => i.text) ?? []
}
const spokenTexts = (kit: { readonly phrases: { readonly spoken: ReadonlyArray<{ readonly text: string }> } }) => kit.phrases.spoken.map((s) => s.text)

describe("phrase commands", () => {
  it.effect("conformant, with its texts in both languages", () => checkModule(briefingModule, { texts }))

  it.effect("English: good morning / good evening / brief me / give me my briefing run the action with no model", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar), household: household() })
      for (const [phrase, greeting] of [["Good morning.", "Good morning. "], ["good evening", "Good evening. "], ["Brief me!", ""], ["give me my briefing", ""]] as const) {
        const before = kit.phrases.spoken.length
        const r = yield* kit.phrases.say(phrase, { device: KITCHEN })
        assert.isTrue(r.taken && r.by === "command", phrase)
        assert.strictEqual(kit.phrases.spoken.length, before + 1)
        assert.strictEqual(kit.phrases.spoken.at(-1)!.text, `${greeting}Standup at nine thirty. It is eight degrees and dry.`)
      }
    }))

  it.effect("English near misses are not taken: they go on to the assistant", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather), household: household() })
      for (const text of ["good night", "good morning please", "brief", "briefing", "give me the weather", "brief me about the news", "goedemorgen"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(text, { device: KITCHEN }), { taken: false }, text)
      }
      assert.deepStrictEqual(spokenTexts(kit), [])
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
    }))

  it.effect("Dutch: goedemorgen / goedenavond / geef me mijn briefing; English words are not taken in a Dutch household", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar), household: DUTCH })
      for (const phrase of ["Goedemorgen!", "goedenavond", "geef me mijn briefing"]) {
        const before = kit.phrases.spoken.length
        const r = yield* kit.phrases.say(phrase, { device: KITCHEN })
        assert.isTrue(r.taken && r.by === "command", phrase)
        assert.strictEqual(kit.phrases.spoken.length, before + 1)
        assert.strictEqual(kit.phrases.spoken.at(-1)!.text, "Standup at nine thirty. It is eight degrees and dry.")
      }
      for (const text of ["goede morgen", "goedemiddag", "geef me de briefing van vandaag", "good morning", "brief me"]) {
        assert.deepStrictEqual(yield* kit.phrases.say(text, { device: KITCHEN }), { taken: false }, text)
      }
    }))

  it.effect("the action's refusals are reached through the phrase: nothing to say, no sources, an assistant without the module", () =>
    Effect.gen(function*() {
      const none = yield* startTestModule(briefingModule, { household: household() })
      yield* none.phrases.say("brief me", { device: KITCHEN })
      assert.deepStrictEqual(spokenTexts(none), [texts.en.noSources])
      assert.deepStrictEqual(none.present.shown(KITCHEN), [])
      const quiet = yield* startTestModule(briefingModule, { provide: providing(section("news", "News", () => Effect.succeed({ _tag: "empty" }))), household: household() })
      yield* quiet.phrases.say("good morning", { device: KITCHEN })
      assert.deepStrictEqual(spokenTexts(quiet), [`Good morning. ${texts.en.nothing}`])
      yield* quiet.present.settle
      assert.deepStrictEqual(quiet.present.shown(KITCHEN), [])
      const without = yield* startTestModule(briefingModule, { provide: providing(weather), household: { ...household(), assistants: [{ id: "jeff", modules: { briefing: false } }] } })
      assert.deepStrictEqual(yield* without.phrases.say("brief me", { device: KITCHEN }), { taken: false })
    }))
})

describe("the list of what the briefing covers", () => {
  it.effect("is shown on the asking device when it can show it, one bullet per section in the briefing's order", () =>
    Effect.gen(function*() {
      const rain = said("weather.rain", "Rain", ["Rain from three, so take a coat."], "lead")
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar, rain, section("news", "News", () => Effect.succeed({ _tag: "empty" }))), household: household() })
      yield* kit.phrases.say("good morning", { device: KITCHEN })
      yield* kit.present.settle
      const [list] = kit.present.shown(KITCHEN)
      assert.strictEqual(list?.content.kind, "list")
      assert.strictEqual(list?.lifetime, "transient")
      // Rain leads; the empty news section is left out without a word.
      assert.deepStrictEqual(items(kit, KITCHEN), ["Rain from three, so take a coat.", "Standup at nine thirty.", "It is eight degrees and dry."])
      // Other devices show nothing: it is the asking device's.
      assert.deepStrictEqual(kit.present.shown(PHONE), [])
      assert.deepStrictEqual(kit.present.shown(HALL), [])
      assert.deepStrictEqual(spokenTexts(kit), ["Good morning. Rain from three, so take a coat. Standup at nine thirty. It is eight degrees and dry."])
    }))

  it.effect("is in the household's language", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(said("weather", "Weer", ["Het is acht graden."])), household: DUTCH })
      yield* kit.phrases.say("goedemorgen", { device: KITCHEN })
      yield* kit.present.settle
      const [list] = kit.present.shown(KITCHEN)
      assert.strictEqual((list?.content as { title: string }).title, "Je briefing")
    }))

  it.effect("on shared, private, public and screenless devices: a household briefing shows where there is a screen, never on a speaker, and the spoken answer is the same", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather), household: household() })
      for (const device of [KITCHEN, PHONE, HALL, SPEAKER]) {
        yield* kit.phrases.say("brief me", { device })
        yield* kit.present.settle
      }
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), Array(4).fill("It is eight degrees and dry."))
      assert.deepStrictEqual([KITCHEN, PHONE, HALL].map((d) => items(kit, d)), Array(3).fill(["It is eight degrees and dry."]))
      assert.deepStrictEqual(kit.present.shown(SPEAKER), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === SPEAKER && !d.decision.show))
    }))

  it.effect("privacy: Robin's personal line is on Robin's private phone, and not on the shared or public screens, which still show the household's", () =>
    Effect.gen(function*() {
      // A section as the contract asks: personal content only on the owner's own device, else nothing of it.
      const dentist = section("dentist", "Dentist", (r) =>
        Effect.succeed(r.turn.deviceId === PHONE ? { _tag: "section", sentences: ["Dentist at two."], priority: "normal", withheld: 0, owner: "p-robin" } : { _tag: "empty" }))
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, dentist), household: household({ publicPerson: "p-robin" }) })
      for (const device of [PHONE, HALL, KITCHEN]) {
        yield* kit.phrases.say("brief me", { device })
        yield* kit.present.settle
      }
      assert.deepStrictEqual(items(kit, PHONE), ["Dentist at two.", "It is eight degrees and dry."])
      assert.deepStrictEqual(items(kit, HALL), ["It is eight degrees and dry."])
      assert.deepStrictEqual(items(kit, KITCHEN), ["It is eight degrees and dry."])
    }))

  it.effect("privacy at the moment of showing: a personal list is withheld from a public screen that is a real candidate, and the shared screen follows its own rule", () =>
    Effect.gen(function*() {
      // A careless section (it returns the owner's line on any device): the briefing's list is personal, so the
      // Presenter asks the privacy rule for the device that would show it, whatever the section decided.
      const careless = said("dentist", "Dentist", ["Dentist at two."], "normal", "p-robin")
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, careless), household: household({ publicPerson: "p-robin" }) })
      yield* kit.phrases.say("brief me", { device: PHONE })
      yield* kit.phrases.say("brief me", { device: HALL })
      yield* kit.present.settle
      assert.deepStrictEqual(items(kit, PHONE), ["Dentist at two.", "It is eight degrees and dry."])
      assert.deepStrictEqual(kit.present.shown(HALL), [])
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === HALL && !d.decision.show))
      assert.isTrue(kit.present.decisions.some((d) => d.deviceId === PHONE && d.decision.show))
    }))

  it.effect("a later briefing replaces the list; one with nothing to list takes it down; the same invocation twice leaves one list", () =>
    Effect.gen(function*() {
      let sections: ReadonlyArray<string> = ["It is eight degrees and dry."]
      const changing = section("weather", "Weather", () => Effect.sync(() => sections.length === 0 ? { _tag: "empty" as const } : { _tag: "section" as const, sentences: sections, priority: "normal" as const, withheld: 0 }))
      const kit = yield* startTestModule(briefingModule, { provide: providing(changing), household: household() })
      yield* kit.phrases.say("brief me", { device: KITCHEN })
      yield* kit.present.settle
      assert.deepStrictEqual(items(kit, KITCHEN), ["It is eight degrees and dry."])
      // The same invocation twice (one turn id): the answer is the same and one list is on the screen.
      for (let i = 0; i < 2; i++) yield* kit.action("brief", {}, { device: KITCHEN, turnId: 77 })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
      sections = ["It is nine degrees and raining."]
      yield* kit.phrases.say("good morning", { device: KITCHEN })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
      assert.deepStrictEqual(items(kit, KITCHEN), ["It is nine degrees and raining."])
      // Nothing to tell: spoken, and what the earlier briefing showed no longer applies.
      sections = []
      yield* kit.phrases.say("good morning", { device: KITCHEN })
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
      // Another device's list is not touched by this one's withdrawal.
      sections = ["Back again."]
      yield* kit.phrases.say("brief me", { device: PHONE })
      sections = []
      yield* kit.phrases.say("brief me", { device: KITCHEN })
      yield* kit.present.settle
      assert.deepStrictEqual(items(kit, PHONE), ["Back again."])
    }))

  it.effect("a restarted module has no list left of the old run and withdraws nothing it never showed", () =>
    Effect.gen(function*() {
      let empty = false
      const changing = section("weather", "Weather", () => Effect.succeed(empty ? { _tag: "empty" as const } : { _tag: "section" as const, sentences: ["Dry."], priority: "normal" as const, withheld: 0 }))
      const kit = yield* startTestModule(briefingModule, { provide: providing(changing), household: household() })
      yield* kit.phrases.say("brief me", { device: KITCHEN })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown(KITCHEN).length, 1)
      yield* kit.restart
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
      empty = true
      const r = yield* kit.phrases.say("brief me", { device: KITCHEN })
      assert.isTrue(r.taken)
      assert.deepStrictEqual(kit.present.shown(KITCHEN), [])
    }))

  it.effect("what the list says is honest: failed sources, left-out sections and kept-back items are noted, and more than fit are counted", () =>
    Effect.gen(function*() {
      const failing = section("calendar", "Calendar", () => Effect.succeed({ _tag: "bogus" } as never))
      const held = section("tasks", "Tasks", () => Effect.succeed({ _tag: "section", sentences: ["One task is open."], priority: "normal", withheld: 2 }))
      const many = Array.from({ length: 15 }, (_, i) => said(`s${String(i).padStart(2, "0")}`, `Source ${i}`, [`Item ${i}.`]))
      const kit = yield* startTestModule(briefingModule, { provide: providing(failing, held, ...many), household: household() })
      yield* kit.phrases.say("brief me", { device: KITCHEN })
      yield* kit.present.settle
      const shown = items(kit, KITCHEN)
      assert.isAtMost(shown.length, 12)
      // 16 sections spoke; with the two notes below, ten fit and the rest are counted, never cut.
      assert.strictEqual(shown.filter((t) => t.startsWith("Item ") || t === "One task is open.").length, 9)
      assert.include(shown, "And seven more.")
      assert.include(shown, "Couldn't get one source.")
      assert.include(shown, "Some personal items are not shown here.")
      assert.isTrue(shown.every((t) => t.length <= 80))
    }))

  it.effect("text limits: a sentence that fits an item whole is the bullet, even with an emoji at the limit; a longer one is the section's title, never cut", () =>
    Effect.gen(function*() {
      const atLimit = `${"a".repeat(78)}😀`
      const over = `${"b".repeat(79)}😀`
      assert.strictEqual(atLimit.length, 80)
      assert.strictEqual(over.length, 81)
      const kit = yield* startTestModule(briefingModule, { provide: providing(said("one", "One", [atLimit]), said("two", "Two", [over, "Another."])), household: household() })
      yield* kit.phrases.say("brief me", { device: KITCHEN })
      yield* kit.present.settle
      assert.deepStrictEqual(items(kit, KITCHEN), [atLimit, "Two"])
    }))

  it.effect("outside text is data on the list: markup stays text and the list stays valid", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(said("news", "News", ["<b>Big</b> story & more."])), household: household() })
      yield* kit.phrases.say("brief me", { device: KITCHEN })
      yield* kit.present.settle
      assert.deepStrictEqual(items(kit, KITCHEN), ["<b>Big</b> story & more."])
    }))

  it.effect("the tool and typed action keep their answers: the action's result and a model call are as before", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather), household: household() })
      const r = yield* kit.action("brief", { kind: "morning" }, { device: KITCHEN })
      assert.isTrue(r.ok)
      const t = yield* kit.tool("briefing", {}, { device: KITCHEN })
      assert.isTrue(t.ok)
    }))
})
