// The contracts' rules a consumer relies on, on their fakes; `useService`; the two authoring helpers. Each fake is what a
// consumer's tests give it through the test kit (`provide`), so its behaviour is checked here once.
import { assert, describe, it } from "@effect/vitest"
import { CurrentTurn, defineModule, makeTool, ModuleStopped } from "@pva/core"
import { makeTestTurn, provide, STORED_TEXT_PATTERN_SOURCE, startTestModule } from "@pva/core/testing"
import { Effect, Fiber, Schema, Stream } from "effect"
import {
  BriefingSections,
  CalendarProviders,
  defineTexts,
  HomeAssistant,
  homeLanguage,
  Lists,
  type ListsService,
  ProviderOff,
  say,
  STORED_TEXT_PATTERN,
  StoredText,
  useService
} from "../src/index.ts"
import {
  haEntity,
  makeFakeBriefingSection,
  makeFakeCalendarProvider,
  makeFakeHomeAssistant,
  makeFakeLists,
  makeFakeMcp,
  makeFakePlayback,
  makeFakeTimers
} from "../src/fakes.ts"

describe("Lists (fake)", () => {
  it.effect("a dedupe key names one item: added, updated, completed, reopened, removed", () =>
    Effect.gen(function*() {
      const { service, items } = makeFakeLists()
      const source = { module: "kitchen", ref: "product:rice" }
      const add = (text: string) => service.addItem({ list: { kind: "shopping" }, text, source, dedupeKey: "kitchen:product:rice" })
      assert.strictEqual((yield* add("Rice")).outcome, "added")
      assert.strictEqual((yield* add("Rice, 1 kg")).outcome, "updated")
      assert.strictEqual(items.length, 1)
      assert.strictEqual((yield* service.completeByKey("kitchen:product:rice"))?.status, "done")
      assert.strictEqual((yield* add("Rice")).outcome, "reopened")
      assert.isTrue(yield* service.removeByKey("kitchen:product:rice"))
      assert.isUndefined(yield* service.completeByKey("kitchen:product:rice"))
      // A key must begin with the source module's id.
      const bad = yield* Effect.flip(service.addItem({ list: { kind: "shopping" }, text: "x", source, dedupeKey: "lists:x" }))
      assert.strictEqual(bad.reason, "invalid")
      assert.strictEqual((yield* service.find({ name: "shopping" }))?.openItems, 0)
    }))
})

describe("Timers (fake)", () => {
  it.effect("rings on the turn's device unless told otherwise; no device at all is no_device", () =>
    Effect.gen(function*() {
      const { service } = makeFakeTimers({ now: () => 0 })
      const timer = yield* service.start({ durationMs: 60_000, label: "eggs", source: { module: "routines" } }).pipe(Effect.provideService(CurrentTurn, makeTestTurn({ device: "kitchen-display" })))
      assert.deepStrictEqual(timer.ringOn, { deviceId: "kitchen-display" })
      const none = yield* Effect.flip(service.start({ durationMs: 60_000, source: { module: "routines" } }))
      assert.strictEqual(none.reason, "no_device")
      const short = yield* Effect.flip(service.start({ durationMs: 10, ringOn: { deviceId: "x" }, source: { module: "routines" } }))
      assert.strictEqual(short.reason, "invalid")
    }))
})

describe("HomeAssistant (fake)", () => {
  it.effect("a subscriber gets a snapshot first, then changes; a reconnect is a fresh snapshot, not news", () =>
    Effect.gen(function*() {
      const ha = makeFakeHomeAssistant({ entities: [haEntity("media_player.kitchen", "idle")] })
      const seen: Array<string> = []
      const fiber = yield* Effect.forkChild(Stream.runForEach(Stream.take(ha.service.changes, 4), (c) => Effect.sync(() => void seen.push(c._tag === "snapshot" ? `snapshot:${c.reason}` : c._tag))))
      yield* Effect.repeat(Effect.yieldNow, { times: 5 })
      ha.set(haEntity("media_player.kitchen", "playing"))
      ha.setConnection("connected")
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(seen, ["snapshot:subscribed", "changed", "connection", "snapshot:reconnected"])
    }))

  it.effect("refuses what the transport refuses for everyone, and unexposed entities", () =>
    Effect.gen(function*() {
      const ha = makeFakeHomeAssistant({ entities: [haEntity("cover.garage", "closed", { deviceClass: "garage" }), haEntity("media_player.kitchen", "idle")] })
      assert.strictEqual((yield* Effect.flip(ha.service.callService({ domain: "lock", service: "unlock", target: { entityIds: ["lock.front"] } }))).reason, "refused")
      assert.strictEqual((yield* Effect.flip(ha.service.callService({ domain: "cover", service: "open_cover", target: { entityIds: ["cover.garage"] } }))).reason, "refused")
      assert.strictEqual((yield* Effect.flip(ha.service.callService({ domain: "light", service: "turn_on", target: { entityIds: ["light.hidden"] } }))).reason, "unknown_entity")
      yield* ha.service.callService({ domain: "media_player", service: "media_pause", target: { entityIds: ["media_player.kitchen"] } })
      ha.setConnection("reconnecting")
      assert.strictEqual((yield* Effect.flip(ha.service.callService({ domain: "media_player", service: "media_play", target: { entityIds: ["media_player.kitchen"] } }))).reason, "not_connected")
    }))
})

describe("Playback, Mcp, calendar providers and briefing sections (fakes)", () => {
  it.effect("their recorded behaviour", () =>
    Effect.gen(function*() {
      const playback = makeFakePlayback({ Kitchen: { state: "playing", player: "Kitchen speakers", volume: 0.5 } })
      assert.strictEqual(playback.service.inRoom("kitchen")?.state, "playing")
      assert.isTrue(yield* playback.service.pause("Kitchen"))
      assert.isFalse(yield* playback.service.pause("Kitchen"))
      assert.strictEqual(yield* playback.service.changeVolume("Kitchen", { by: 0.1 }), 0.6)

      const mcp = makeFakeMcp({ "https://t3.lan/mcp": { tools: [{ name: "overview", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }], call: () => ({ isError: false, text: "2 threads", truncated: false }) } })
      const text = yield* Effect.scoped(Effect.gen(function*() {
        const client = yield* mcp.service.open({ name: "T3", url: "https://t3.lan/mcp" })
        return (yield* client.callTool("overview", {})).text
      }))
      assert.strictEqual(text, "2 threads")
      assert.isTrue(mcp.opened[0]?.closed)

      const cal = makeFakeCalendarProvider({
        id: "ics",
        sources: [{ id: "ics:school", label: "School", owner: "household", writable: false }],
        events: [{ sourceId: "ics:school", uid: "u1", title: "Sports day", start: { date: "2026-11-20" }, end: { date: "2026-11-21" }, status: "confirmed", owner: "household", repeats: false }]
      })
      const read = yield* cal.provider.events("ics:school", { from: Date.UTC(2026, 10, 18), to: Date.UTC(2026, 10, 25) })
      assert.deepStrictEqual(read.events.map((e) => e.title), ["Sports day"])
      assert.strictEqual((yield* Effect.flip(cal.provider.add!("ics:school", { title: "x", start: { at: 0 }, end: { at: 1 } }))).reason, "read_only")

      const section = makeFakeBriefingSection({ id: "weather", result: { _tag: "section", sentences: ["Rain from three."], priority: "lead", withheld: 0 } })
      const result = yield* section.section.gather({ turn: makeTestTurn(), kind: "morning", length: "short", maxSentences: 1, language: "en", now: 0 })
      assert.strictEqual(result._tag, "section")
      assert.strictEqual(section.requests[0]?.turn.deviceId, "kitchen-display")
    }))
})

describe("useService", () => {
  // #region consumer
  /** A consumer: asks the lists module through useService and says so when it is off. */
  const consumer = defineModule({
    apiVersion: 2,
    id: "consumer",
    name: "Consumer",
    description: "Adds rice.",
    enabledByDefault: false,
    start: (ctx) =>
      Effect.succeed({
        tools: [makeTool({
          name: "consumer_add",
          description: "Add rice to the shopping list.",
          parameters: Schema.Struct({}),
          risk: "change",
          execute: () =>
            useService(ctx.host, Lists, "lists", (lists) => lists.addItem({ list: { kind: "shopping" }, text: "Rice", source: { module: "consumer" }, dedupeKey: "consumer:rice" })).pipe(
              Effect.map((r) => r.outcome),
              Effect.catchTag("ProviderOff", (off) => Effect.succeed(off.message)),
              Effect.catchTag("ListsError", (e) => Effect.succeed(e.message))
            )
        })]
      })
  })
  // #endregion consumer

  it.effect("the provider on, off, and stopping mid-call", () =>
    Effect.gen(function*() {
      // #region consumer-test
      const fake = makeFakeLists()
      const on = yield* startTestModule(consumer, { provide: [provide("lists", { services: [Lists.of(fake.service)] })] })
      assert.strictEqual((yield* on.tool("consumer_add", {})).value, "added")
      const off = yield* startTestModule(consumer)
      assert.strictEqual((yield* off.tool("consumer_add", {})).value, "The lists module is off.")
      // #endregion consumer-test
      // A provider whose part closed during the call dies with ModuleStopped: the consumer sees ProviderOff.
      const stopping: ListsService = { ...fake.service, addItem: () => Effect.die(new ModuleStopped({ message: "stopped" })) }
      const r = yield* Effect.flip(useService({ service: () => stopping as never }, Lists, "lists", (l) => l.addItem({ list: { kind: "shopping" }, text: "x", source: { module: "c" } })))
      assert.instanceOf(r, ProviderOff)
    }))
})

describe("the contribution keys and the authoring helpers", () => {
  it("keys have the ids the plan names", () => {
    assert.deepStrictEqual([Lists.id, HomeAssistant.id, BriefingSections.id, CalendarProviders.id], ["lists", "home-assistant", "briefing.sections", "calendar.providers"])
  })

  it("StoredText keeps text whose JSON is at most twice as long, and the kit knows its pattern", () => {
    assert.strictEqual(STORED_TEXT_PATTERN.source, STORED_TEXT_PATTERN_SOURCE)
    const ok = Schema.is(StoredText(30))
    assert.isTrue(ok("Quote \" and \\ and\nnewline"))
    assert.isFalse(ok("bell \u0007"))
    assert.isFalse(ok("lone \ud800"))
    assert.isTrue(ok("emoji 🍚"))
    assert.isFalse(ok("x".repeat(31)))
  })

  it("texts in two languages, the household's language", () => {
    const texts = defineTexts({ en: { added: "Added {item}." }, nl: { added: "{item} staat erop." } })
    assert.strictEqual(say(texts, homeLanguage({ home: { HOME_LANGUAGE: "nl-NL" } }), "added", { item: "rijst" }), "rijst staat erop.")
    assert.strictEqual(say(texts, homeLanguage({ home: { HOME_LANGUAGE: "de-DE" } }), "added", { item: "rice" }), "Added rice.")
  })
})
