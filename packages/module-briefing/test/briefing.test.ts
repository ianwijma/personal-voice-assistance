// The briefing module through the test kit: the real host and gateway, sections from stand-ins of the modules that
// contribute them (the contract is `BriefingSections`; the weather, calendar, news modules write theirs elsewhere).
import { assert, describe, it } from "@effect/vitest"
import { ModuleStopped } from "@pva/core"
import { checkModule, expectOffByDefault, provide, startTestModule } from "@pva/core/testing"
import { BRIEFING_LIMITS, type BriefingRequest, type BriefingSection, BriefingSections, type BriefingSectionResult, BriefingSectionError } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { briefingModule, catalog, MAX_SECTIONS, MAX_SKIPPED, preferences, texts } from "../src/index.ts"

type Gather = (request: BriefingRequest) => Effect.Effect<BriefingSectionResult, BriefingSectionError>

const section = (id: string, title: string, gather: Gather): BriefingSection => ({ id, title, gather })
const said = (id: string, title: string, sentences: ReadonlyArray<string>, priority: "lead" | "normal" | "filler" = "normal"): BriefingSection =>
  section(id, title, () => Effect.succeed({ _tag: "section", sentences, priority, withheld: 0 }))
/** One stand-in module per section id's module part ("weather" holds weather and weather.rain). */
const providing = (...sections: ReadonlyArray<BriefingSection>) => {
  const byModule = new Map<string, Array<BriefingSection>>()
  for (const s of sections) byModule.set(s.id.split(".")[0]!, [...(byModule.get(s.id.split(".")[0]!) ?? []), s])
  return [...byModule].map(([moduleId, own]) => provide(moduleId, { contributions: own.map((s) => BriefingSections.of(s)) }))
}

const weather = said("weather", "Weather", ["It is eight degrees and dry."])
const rain = said("weather.rain", "Rain", ["Rain from three, so take a coat."], "lead")
const calendar = said("calendar", "Calendar", ["Standup at nine thirty."])
const empty = section("news", "News", () => Effect.succeed({ _tag: "empty" }))

const KITCHEN = { device: "kitchen-display" }
const PHONE = { device: "robins-phone" }
const HALL = { device: "hall-screen" }

describe("conformance", () => {
  it.effect("accepted by the host, off by default, conformant, texts in both languages", () =>
    Effect.gen(function*() {
      yield* expectOffByDefault(catalog)
      yield* checkModule(briefingModule, { texts })
    }))

  it.effect("the module does nothing for an installation that did not switch it on: no tools, no actions", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather) })
      assert.deepStrictEqual(kit.toolNames().sort(), ["briefing", "briefing_brief", "briefing_prefs"])
    }))
})

describe("the briefing tool", () => {
  it.effect("returns the sections in order, lead items first, an empty section dropped without a word", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar, rain, empty) })
      const r = yield* kit.tool("briefing", { kind: "morning" }, KITCHEN)
      assert.isTrue(r.ok)
      assert.deepStrictEqual(r.value, {
        kind: "morning",
        length: "normal",
        sections: [
          { id: "weather.rain", title: "Rain", sentences: ["Rain from three, so take a coat."] },
          { id: "calendar", title: "Calendar", sentences: ["Standup at nine thirty."] },
          { id: "weather", title: "Weather", sentences: ["It is eight degrees and dry."] }
        ]
      })
    }))

  it.effect("each section gets the asking turn, the length's sentence budget, the household language and one shared now", () =>
    Effect.gen(function*() {
      const seen: Array<BriefingRequest> = []
      const spy = section("calendar", "Calendar", (request) => Effect.sync(() => void seen.push(request)).pipe(Effect.as({ _tag: "empty" } as const)))
      const kit = yield* startTestModule(briefingModule, { provide: providing(spy, weather), household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      yield* kit.tool("briefing", { kind: "evening", length: "long" }, PHONE)
      assert.strictEqual(seen.length, 1)
      const request = seen[0]!
      assert.strictEqual(request.turn.deviceId, "robins-phone")
      assert.strictEqual(request.turn.assistantId, "jeff")
      assert.strictEqual(request.turn.person?.id, "p-robin")
      assert.strictEqual(request.kind, "evening")
      assert.strictEqual(request.maxSentences, 4)
      assert.strictEqual(request.language, "nl")
      assert.strictEqual(request.now, yield* kit.now)
    }))

  it.effect("lengths: short is lead items only (the first section when none leads), filler stays out of short and normal", () =>
    Effect.gen(function*() {
      const filler = said("fun", "Fun fact", ["Today is also an odd day."], "filler")
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar, rain, filler) })
      const ids = (value: unknown) => (value as { sections: Array<{ id: string }> }).sections.map((s) => s.id)
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "short" })).value), ["weather.rain"])
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "normal" })).value), ["weather.rain", "calendar", "weather"])
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "long" })).value), ["weather.rain", "calendar", "weather", "fun"])
      const none = yield* startTestModule(briefingModule, { provide: providing(weather, calendar) })
      assert.deepStrictEqual(ids((yield* none.tool("briefing", { length: "short" })).value), ["calendar"])
    }))

  it.effect("the owner's order and skip list are settings; skipping a module skips its sections; `only` narrows", () =>
    Effect.gen(function*() {
      const news = said("news", "News", ["The big story."])
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar, news), settings: { order: ["news", "calendar"], skip: ["Weather"] } })
      const ids = (value: unknown) => (value as { sections: Array<{ id: string }> }).sections.map((s) => s.id)
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", {})).value), ["news", "calendar"])
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { only: ["calendar"] })).value), ["calendar"])
      const rainy = yield* startTestModule(briefingModule, { provide: providing(weather, rain, calendar), settings: { skip: ["weather"] } })
      assert.deepStrictEqual(ids((yield* rainy.tool("briefing", {})).value), ["calendar"])
    }))

  it.effect("no sources at all, or every section empty: one sentence each, in both languages", () =>
    Effect.gen(function*() {
      const bare = yield* startTestModule(briefingModule)
      assert.deepStrictEqual((yield* bare.tool("briefing", {})).value, { spoken: "I have no briefing sources yet: switch on weather, calendar or news for me." })
      const nl = yield* startTestModule(briefingModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual((yield* nl.tool("briefing", {})).value, { spoken: "Ik heb nog geen bronnen voor een briefing: zet het weer, de agenda of het nieuws voor me aan." })
      const quiet = yield* startTestModule(briefingModule, { provide: providing(empty) })
      assert.deepStrictEqual((yield* quiet.tool("briefing", {})).value, { spoken: "There is nothing to tell you right now." })
    }))

  it.effect("parameters are validated: an unknown kind or length is refused before anything runs", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather) })
      assert.isFalse((yield* kit.tool("briefing", { kind: "noon" })).ok)
      assert.isFalse((yield* kit.tool("briefing", { length: "epic" })).ok)
      assert.isFalse((yield* kit.tool("briefing", { only: Array.from({ length: 11 }, () => "weather") })).ok)
    }))
})

describe("the typed action", () => {
  it.effect("joins the sentences with no model: greeting, sections, nothing invented", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar, rain) })
      const morning = yield* kit.action("brief", { kind: "morning" }, KITCHEN)
      assert.deepStrictEqual(morning, { ok: true, say: "Good morning. Rain from three, so take a coat. Standup at nine thirty. It is eight degrees and dry." })
      const short = yield* kit.action("brief", { length: "short" }, KITCHEN)
      assert.deepStrictEqual(short, { ok: true, say: "Rain from three, so take a coat." })
      // The same through its generated tool, as the model is offered it.
      assert.deepStrictEqual((yield* kit.tool("briefing_brief", { kind: "evening" })).value, "Good evening. Rain from three, so take a coat. Standup at nine thirty. It is eight degrees and dry.")
    }))

  it.effect("in Dutch, and with no sources", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(calendar), household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual(yield* kit.action("brief", { kind: "morning" }), { ok: true, say: "Goedemorgen. Standup at nine thirty." })
      const bare = yield* startTestModule(briefingModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual(yield* bare.action("brief", {}), { ok: true, say: "Ik heb nog geen bronnen voor een briefing: zet het weer, de agenda of het nieuws voor me aan." })
    }))
})

describe("sections that fail", () => {
  it.effect("one that fails, one that is late, one that dies with ModuleStopped, one that breaks the bounds: each named once, the rest spoken", () =>
    Effect.gen(function*() {
      const broken = section("news", "News", () => Effect.fail(new BriefingSectionError({ reason: "unavailable", detail: "feed not fetched" })))
      const slow = section("bins", "Bins", () => Effect.sleep(5_000).pipe(Effect.as({ _tag: "empty" } as const)))
      const stopped = section("mail", "Mail", () => Effect.die(new ModuleStopped({ message: "mail stopped" })))
      const rubbish = section("tasks", "Tasks", () => Effect.succeed({ _tag: "section", sentences: ["one", "two", "three"], priority: "normal", withheld: 0 }))
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, broken, slow, stopped, rubbish) })
      const call = yield* Effect.forkChild(kit.action("brief", {}, KITCHEN))
      yield* kit.advance(BRIEFING_LIMITS.gatherMs)
      const r = yield* Fiber.join(call)
      const spoken = r.ok ? (r.say ?? "") : ""
      const lead = "It is eight degrees and dry. I couldn't get the "
      assert.isTrue(spoken.startsWith(lead))
      // The four that failed are named once, in one sentence, and none of their details is spoken.
      for (const title of ["news", "bins", "mail", "tasks"]) assert.strictEqual(spoken.split(title).length, 2)
      assert.notInclude(spoken, "feed not fetched")
    }))

  it.effect("a failed section is named in Dutch too, with the list worded as the language does", () =>
    Effect.gen(function*() {
      const broken = (id: string, title: string) => section(id, title, () => Effect.fail(new BriefingSectionError({ reason: "failed", detail: "boom" })))
      const kit = yield* startTestModule(briefingModule, { provide: providing(calendar, broken("news", "Nieuws"), broken("weather", "Weer")), household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      const r = yield* kit.action("brief", {})
      assert.deepStrictEqual(r, { ok: true, say: "Standup at nine thirty. Ik kon nieuws en weer niet ophalen." })
    }))

  it.effect("sections are gathered at once, so slow ones cost the limit once, not their sum", () =>
    Effect.gen(function*() {
      const slow = (id: string) => section(id, id, () => Effect.sleep(700).pipe(Effect.as({ _tag: "section", sentences: [`${id} done.`], priority: "normal", withheld: 0 } as const)))
      const kit = yield* startTestModule(briefingModule, { provide: providing(slow("a"), slow("b"), slow("c"), slow("d")) })
      const before = yield* kit.now
      const call = yield* Effect.forkChild(kit.action("brief", {}))
      yield* kit.advance(700)
      const r = yield* Fiber.join(call)
      assert.strictEqual(yield* kit.now, before + 700)
      assert.deepStrictEqual(r, { ok: true, say: "a done. b done. c done. d done." })
    }))

  it.effect("answers outside the contract's bounds fail the section: long or multi-line sentences, a bad owner, a bad withheld count", () =>
    Effect.gen(function*() {
      const bad = (id: string, result: BriefingSectionResult) => section(id, id, () => Effect.succeed(result))
      const kit = yield* startTestModule(briefingModule, {
        provide: providing(
          bad("long", { _tag: "section", sentences: ["x".repeat(BRIEFING_LIMITS.sentenceChars + 1)], priority: "normal", withheld: 0 }),
          bad("lines", { _tag: "section", sentences: ["two\nlines"], priority: "normal", withheld: 0 }),
          bad("owner", { _tag: "section", sentences: ["Hello."], priority: "normal", owner: "Not An Id", withheld: 0 }),
          bad("count", { _tag: "section", sentences: ["Hello."], priority: "normal", withheld: -1 }),
          bad("fraction", { _tag: "section", sentences: ["Hello."], priority: "normal", withheld: 1.5 }),
          bad("huge", { _tag: "section", sentences: ["Hello."], priority: "normal", withheld: BRIEFING_LIMITS.maxWithheld + 1 }),
          bad("priority", { _tag: "section", sentences: ["Hello."], priority: "urgent" as never, withheld: 0 }),
          bad("tag", { _tag: "mystery" } as never),
          said("ok", "Fine", ["All fine."])
        )
      })
      const r = yield* kit.tool("briefing", {})
      const value = r.value as { sections: Array<{ id: string }>; couldntGet: Array<string> }
      assert.deepStrictEqual(value.sections.map((s) => s.id), ["ok"])
      assert.sameMembers(value.couldntGet, ["long", "lines", "owner", "count", "fraction", "huge", "priority", "tag"])
    }))

  it.effect("at most MAX_SECTIONS are asked, and a repeated id is asked once", () =>
    Effect.gen(function*() {
      const asked: Array<string> = []
      const spy = (id: string) => section(id, id, () => Effect.sync(() => void asked.push(id)).pipe(Effect.as({ _tag: "empty" } as const)))
      const many = Array.from({ length: MAX_SECTIONS + 5 }, (_, n) => spy(`m${String(n).padStart(2, "0")}`))
      const kit = yield* startTestModule(briefingModule, { provide: [...providing(...many), provide("dup", { contributions: [BriefingSections.of(spy("m00"))] })] })
      yield* kit.tool("briefing", {})
      assert.strictEqual(asked.length, MAX_SECTIONS)
      assert.strictEqual(new Set(asked).size, MAX_SECTIONS)
    }))

  it.effect("a briefing with a provider that is off: its section is simply not there", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(calendar), household: { assistants: [{ id: "jeff", modules: { calendar: false } }] } })
      assert.deepStrictEqual((yield* kit.tool("briefing", {})).value, { spoken: "I have no briefing sources yet: switch on weather, calendar or news for me." })
    }))
})

describe("privacy", () => {
  const sams = (seen: Array<string>) =>
    section("calendar", "Calendar", (request) =>
      Effect.sync(() => void seen.push(request.turn.deviceId ?? "")).pipe(
        Effect.as({ _tag: "section", sentences: ["Sam has two things today."], priority: "normal", owner: "p-sam", withheld: 1 } as const)
      ))

  it.effect("a section holding the turn's person's items is spoken with its owner; another person's, or one with no person asking, is never spoken and only counted", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []
      const kit = yield* startTestModule(briefingModule, { provide: providing(sams(seen), weather) })
      // Sam at the shared kitchen display, which is Sam's: the section is the turn's person's.
      const kitchen = yield* kit.tool("briefing", {}, KITCHEN)
      assert.deepStrictEqual((kitchen.value as { owner: string; withheld: string }).owner, "p-sam")
      assert.include(kitchen.content, "Sam has two things today.")
      assert.include(kitchen.content, "Some personal items are not read out here.")
      // Robin's private phone asks: the section answered with Sam's content for Robin's turn: left out, counted.
      const phone = yield* kit.tool("briefing", {}, PHONE)
      assert.notInclude(phone.content, "Sam")
      assert.notInclude(phone.content, "owner")
      assert.include(phone.content, "Some personal items are not read out here.")
      assert.include(phone.content, "It is eight degrees and dry.")
      // The public hall screen has no person: the same.
      const hall = yield* kit.tool("briefing", {}, HALL)
      assert.notInclude(hall.content, "Sam")
      assert.include(hall.content, "Some personal items are not read out here.")
      // The device the section saw is the asking one (it decides privacy there, at that moment).
      assert.deepStrictEqual(seen, ["kitchen-display", "robins-phone", "hall-screen"])
    }))

  it.effect("the sensitivity of a result with personal content names its owner; the action with only a withheld count speaks no name", () =>
    Effect.gen(function*() {
      const onlyCount = section("calendar", "Calendar", () => Effect.succeed({ _tag: "section", sentences: [], priority: "normal", withheld: 3 }))
      const kit = yield* startTestModule(briefingModule, { provide: providing(onlyCount) })
      const hall = yield* kit.action("brief", {}, HALL)
      assert.deepStrictEqual(hall, { ok: true, say: "Some personal items are not read out here." })
      const nl = yield* startTestModule(briefingModule, { provide: providing(onlyCount), household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual(yield* nl.action("brief", {}, HALL), { ok: true, say: "Sommige persoonlijke items lees ik hier niet voor." })
    }))
})

describe("preferences", () => {
  it.effect("a person's length and skips are theirs: remembered per person, used by the next briefing, across a restart", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule, { provide: providing(weather, calendar, rain) })
      const ids = (value: unknown) => (value as { sections: Array<{ id: string }> }).sections.map((s) => s.id)
      assert.deepStrictEqual((yield* kit.tool("briefing_prefs", { length: "short", skip: ["Calendar"] }, KITCHEN)).value, { spoken: "Okay, your briefing will be short. Okay, I'll leave out calendar." })
      // Sam: short, and no calendar. Robin: untouched defaults.
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", {}, KITCHEN)).value), ["weather.rain"])
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", {}, PHONE)).value), ["weather.rain", "calendar", "weather"])
      // What was asked for this once wins over the preference.
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "normal" }, KITCHEN)).value), ["weather.rain", "weather"])
      yield* kit.restart
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", {}, KITCHEN)).value), ["weather.rain"])
      // Bring it back.
      assert.deepStrictEqual((yield* kit.tool("briefing_prefs", { unskip: ["calendar"] }, KITCHEN)).value, { spoken: "Okay, calendar is back in your briefing." })
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "normal" }, KITCHEN)).value), ["weather.rain", "calendar", "weather"])
      // Robin's row is Robin's: Sam's change did not touch it.
      yield* kit.tool("briefing_prefs", { skip: ["weather"] }, PHONE)
      // (Leaving out "weather" leaves out the module's sections, weather.rain too.)
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "normal" }, PHONE)).value), ["calendar"])
      assert.deepStrictEqual(ids((yield* kit.tool("briefing", { length: "normal" }, KITCHEN)).value), ["weather.rain", "calendar", "weather"])
    }))

  it.effect("with nobody known asking it asks whose, and writes nothing; Dutch too", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule)
      assert.deepStrictEqual((yield* kit.tool("briefing_prefs", { length: "short" }, HALL)).value, { spoken: "Whose preference is that? I can't tell who is asking here." })
      assert.deepStrictEqual(yield* kit.moduleStore().collection(preferences).list({ scope: { kind: "person", id: "p-sam" } }), [])
      const nl = yield* startTestModule(briefingModule, { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual((yield* nl.tool("briefing_prefs", { length: "short" }, HALL)).value, { spoken: "Van wie is die voorkeur? Ik weet hier niet wie het vraagt." })
      assert.deepStrictEqual((yield* nl.tool("briefing_prefs", { length: "long", skip: ["nieuws"] }, KITCHEN)).value, { spoken: "Oké, je briefing wordt uitgebreid. Oké, ik laat nieuws weg uit je briefing." })
    }))

  it.effect("refusals: nothing to set, a name that is no section id, too many skips, a row at its largest", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(briefingModule)
      assert.deepStrictEqual((yield* kit.tool("briefing_prefs", {}, KITCHEN)).value, { spoken: "Tell me how long your briefing should be, or which section to leave out or bring back." })
      assert.deepStrictEqual((yield* kit.tool("briefing_prefs", { skip: ["the news, please"] }, KITCHEN)).value, { spoken: "I don't know a section called that. Use its name, like weather or news." })
      for (let n = 0; n < 2; n++) yield* kit.tool("briefing_prefs", { skip: [`s${n * 5}`, `s${n * 5 + 1}`, `s${n * 5 + 2}`, `s${n * 5 + 3}`, `s${n * 5 + 4}`] }, KITCHEN)
      assert.deepStrictEqual((yield* kit.tool("briefing_prefs", { skip: ["one-more"] }, KITCHEN)).value, { spoken: `I can leave out at most ${MAX_SKIPPED} sections.` })
      const rows = yield* kit.moduleStore().collection(preferences).list({ scope: { kind: "person", id: "p-sam" } })
      assert.strictEqual(rows[0]?.value.skip.length, MAX_SKIPPED)
      // The largest legal row (ten 60-character ids and a length) is stored: the store judges it only when written.
      const id = "a".repeat(60)
      const biggest = yield* kit.moduleStore().collection(preferences).insert({ length: "normal", skip: Array.from({ length: MAX_SKIPPED }, () => id) }, { id: "prefs-p-robin", scope: { kind: "person", id: "p-robin" } })
      assert.strictEqual(biggest.value.skip.length, MAX_SKIPPED)
    }))
})

describe("settings", () => {
  it.effect("an invalid length setting takes the module down with a reason; a valid one is the household's default, and an assistant may own its own", () =>
    Effect.gen(function*() {
      const bad = yield* startTestModule(briefingModule, { provide: providing(weather), settings: { length: "epic" } })
      assert.strictEqual(bad.info()?.state, "error")
      const short = yield* startTestModule(briefingModule, { provide: providing(rain, calendar), settings: { length: "short" } })
      assert.deepStrictEqual(((yield* short.tool("briefing", {})).value as { length: string }).length, "short")
      const own = yield* startTestModule(briefingModule, {
        provide: providing(rain, calendar),
        household: { assistants: [{ id: "jeff", modules: { briefing: { own: { length: "long" } } } }] }
      })
      assert.deepStrictEqual(((yield* own.tool("briefing", {})).value as { length: string }).length, "long")
      const tooMany = yield* startTestModule(briefingModule, { settings: { order: Array.from({ length: 21 }, (_, n) => `s${n}`) } })
      assert.strictEqual(tooMany.info()?.state, "error")
    }))
})
