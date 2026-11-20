// Review round 1 of PR #112: each test here failed on the reviewed commit (4f95c6fb) and passes with its fix.
import { assert, describe, it, vi } from "@effect/vitest"
import { type ModuleNotify, type ModuleServicesV2, type ModuleSpeech, type ModulePresent, PresentError, SpeechError, makeTool } from "@pva/core"
import { KIT_PAGE_CAPABILITIES, startTestModule, type TestDevice } from "@pva/core/testing"
import { Deferred, Effect, Fiber, Schema } from "effect"
import { ANSWER_MAX, broadcastModule, cutName, MAX_CARDS } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })

const PAGE = KIT_PAGE_CAPABILITIES
const dev = (id: string, name: string, room: string, extra: Partial<TestDevice> = {}): TestDevice => ({ id, name, room, capabilities: PAGE, ...extra })
const said = (r: { readonly value: unknown }): string => (r.value as { spoken: string }).spoken
const where = (kit: { notify: { announced: ReadonlyArray<{ deviceId: string }> } }) => kit.notify.announced.map((a) => a.deviceId).sort()

type Services = ModuleServicesV2
interface Parts {
  notify?: ModuleNotify
  jobResults: Array<unknown>
}
interface Hooks {
  readonly speech?: (real: ModuleSpeech) => ModuleSpeech
  readonly present?: (real: ModulePresent) => ModulePresent
  /** Jobs that run a broadcast action as their origin: `from` schedules them from a turn, `none` from the module's start. */
  readonly jobs?: boolean
}

/** The module with seams a test needs: the notify handle, wrapped speech and presentation, and jobs that run its actions. */
const probed = (parts: Parts, hooks: Hooks = {}): typeof broadcastModule => ({
  ...broadcastModule,
  shared: (ctx) =>
    Effect.gen(function*() {
      const shared = yield* (broadcastModule.shared?.(ctx) ?? Effect.succeed({ value: undefined }))
      parts.notify = ctx.notify
      if (hooks.jobs === true) {
        yield* ctx.scheduler.handle("run-action", {
          payload: Schema.Struct({ action: Schema.String, message: Schema.optionalKey(Schema.String) }),
          run: ({ action, message }) =>
            Effect.flatMap(ctx.host.actions.run({ moduleId: "broadcast", actionId: action, params: message === undefined ? {} : { message } }), (r) => Effect.sync(() => void parts.jobResults.push(r)))
        }).pipe(Effect.orDie)
        // A job scheduled in `shared` at start has no origin: nobody to leave out.
        yield* ctx.scheduler.schedule({ handler: "run-action", key: "no-origin", payload: { action: "send", message: "Nobody asked" }, inMs: 500 }).pipe(Effect.orDie)
      }
      return shared
    }),
  start: (ctx) =>
    Effect.map(
      broadcastModule.start({ ...ctx, speech: hooks.speech?.((ctx as unknown as Services).speech) ?? (ctx as unknown as Services).speech, present: hooks.present?.((ctx as unknown as Services).present) ?? (ctx as unknown as Services).present } as never),
      (instance) => ({
        ...instance,
        tools: [
          ...(instance.tools ?? []),
          makeTool({
            name: "probe_schedule",
            description: "Test only: schedule a job that runs a broadcast action, from this turn.",
            parameters: Schema.Struct({ action: Schema.String, message: Schema.optionalKey(Schema.String) }),
            risk: "change",
            execute: ({ action, message }) => Effect.as(Effect.orDie((ctx as unknown as Services).scheduler.schedule({ handler: "run-action", key: `probe-${action}`, payload: { action, ...(message !== undefined ? { message } : {}) }, inMs: 1_000 })), "scheduled")
          })
        ]
      })
    )
})

const HOUSE: ReadonlyArray<TestDevice> = [dev("kitchen-display", "Kitchen display", "Kitchen"), dev("study-tablet", "Study tablet", "Study"), dev("hall-screen", "Hall screen", "Hall", { privacy: "public", defaultPerson: null })]

describe("review round 1", () => {
  it.effect("2: a job's call is left out of its own origin's device, and names it as the sender; with no origin it refuses", () =>
    Effect.gen(function*() {
      const parts: Parts = { jobResults: [] }
      const kit = yield* startTestModule(probed(parts, { jobs: true }), { household: { devices: HOUSE } })
      yield* kit.advance(1_000)
      // The job made in `shared` has no origin: it cannot know whom to leave out, so it says so and announces nothing.
      assert.deepStrictEqual(parts.jobResults, [{ ok: false, code: "failed", message: "I can't tell which device is asking, so I don't know which one to leave out; nothing was announced." }])
      assert.deepStrictEqual(kit.notify.announced, [])
      yield* kit.tool("probe_schedule", { action: "send", message: "Job hello" }, { device: "kitchen-display" })
      yield* kit.tool("probe_schedule", { action: "chime" }, { device: "kitchen-display" })
      yield* kit.advance(3_000)
      assert.deepStrictEqual(where(kit), ["hall-screen", "hall-screen", "study-tablet", "study-tablet"])
      assert.notInclude(where(kit), "kitchen-display")
      yield* kit.present.settle
      const card = kit.present.shown("study-tablet")[0]
      assert.deepStrictEqual(card?.content.kind === "card" ? card.content.facts : undefined, [{ label: "From", value: "Kitchen display" }])
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  it.effect("3: do not disturb is read again before each card: one that came on after the announcement was admitted starts no card", () =>
    Effect.gen(function*() {
      const parts: Parts = { jobResults: [] }
      const kit = yield* startTestModule(
        probed(parts, { speech: (real) => ({ say: (t, x, o) => Effect.tap(real.say(t, x, o), () => parts.notify!.dnd.set().pipe(Effect.orDie)) }) }),
        { household: { devices: HOUSE } }
      )
      const r = yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(said(r), "Announcing on Hall screen. Not announced on Study tablet (do not disturb). Screens that got no card because do not disturb is on: 1.")
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
    }))

  it.effect("3: a card already showing when do not disturb comes on stays until its 30 seconds end, and is gone after", () =>
    Effect.gen(function*() {
      const parts: Parts = { jobResults: [] }
      const kit = yield* startTestModule(probed(parts), { household: { devices: HOUSE } })
      yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      yield* parts.notify!.dnd.set()
      yield* kit.advance(20_000)
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      // No new card while it is on.
      const again = yield* kit.tool("broadcast_send", { message: "Later" }, { device: "kitchen-display" })
      assert.strictEqual(said(again), "Do not disturb is on, so nothing was announced.")
      yield* kit.advance(11_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      assert.deepStrictEqual(kit.present.shown("hall-screen"), [])
    }))

  it.effect("4: two broadcasts at once go one after the other: the older one's card never replaces the newer one's", () =>
    Effect.gen(function*() {
      const parts: Parts = { jobResults: [] }
      const gate = yield* Deferred.make<void>()
      let held = false
      const kit = yield* startTestModule(
        probed(parts, {
          present: (real) => ({
            ...real,
            show: (target, p, o) =>
              !held && p.kind === "card" && p.text === "First" ? Effect.andThen(Effect.sync(() => void (held = true)), Effect.andThen(Deferred.await(gate), real.show(target, p, o))) : real.show(target, p, o)
          })
        }),
        { household: { devices: [...HOUSE, dev("garage-screen", "Garage screen", "Garage")] } }
      )
      const first = yield* Effect.forkChild(kit.tool("broadcast_send", { message: "First" }, { device: "kitchen-display" }))
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      const second = yield* Effect.forkChild(kit.tool("broadcast_send", { message: "Second" }, { device: "study-tablet" }))
      for (let i = 0; i < 20; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      yield* kit.advance(10_000)
      yield* kit.present.settle
      // Sound and screen in the same order: First then Second on the hall, and the card of the last broadcast.
      assert.deepStrictEqual(kit.notify.announced.filter((a) => a.deviceId === "hall-screen").map((a) => a.text), ["First", "Second"])
      const card = kit.present.shown("hall-screen")[0]
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "Second")
    }))

  it.effect("5: screens beyond the card cap are counted and said", () =>
    Effect.gen(function*() {
      const many = [dev("kitchen-display", "Kitchen display", "Kitchen")]
      for (let i = 0; i < 10; i++) many.push(dev(`screen-${i}`, `Screen ${i}`, `Room ${i}`))
      const kit = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: many } })
      const r = yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      assert.strictEqual(said(r), `Announcing on Screen 0, Screen 1 and 8 more. Also showing it on Screen 0, Screen 1 and ${MAX_CARDS - 2} more. Screens that could have shown it beyond the 8 cards of one broadcast: 2.`)
      const nl = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: many, home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.include(said(yield* nl.tool("broadcast_send", { message: "Eten" }, { device: "kitchen-display" })), "Schermen die het hadden kunnen tonen buiten de 8 kaarten van één omroep: 2.")
    }))

  it.effect("6: a phrase's answer fits 300 characters, in both languages, and keeps every group", () =>
    Effect.gen(function*() {
      for (const nl of [false, true]) {
        const home = nl ? { HOME_LANGUAGE: "nl-NL" } : {}
        const long = (n: number) => `${String(n).padStart(2, "0")}${"x".repeat(38)}`
        const six: Array<TestDevice> = [dev("kitchen-display", "Kitchen display", "Kitchen")]
        for (let i = 0; i < 3; i++) six.push(dev(`on-${i}`, long(i), `R${i}`))
        for (let i = 3; i < 6; i++) six.push(dev(`off-${i}`, long(i), `R${i}`, { connected: false }))
        const kit = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: six, home } })
        yield* kit.phrases.say(nl ? "zeg tegen iedereen dat het eten klaar is" : "tell everyone dinner is ready", { device: "kitchen-display" })
        const first = kit.phrases.spoken.at(-1)!.text
        assert.isAtMost(first.length, ANSWER_MAX)
        assert.include(first, nl ? "Ik roep het om op" : "Announcing on")
        assert.include(first, nl ? "Niet omgeroepen" : "Not announced")
        assert.include(first, nl ? "niet verbonden" : "not connected")
        assert.include(first, nl ? "Ik toon het ook op" : "Also showing it on")
        // The most there can be: 64 devices of every reason, names at their bound, more screens than cards.
        const big: Array<TestDevice> = [dev("kitchen-display", "Kitchen display", "Kitchen")]
        for (let i = 0; i < 80; i++) {
          const extra: Partial<TestDevice> = i % 5 === 0 ? { connected: false } : i % 5 === 1 ? { capabilities: { v: 1, display: PAGE.display! } } : {}
          big.push(dev(`d-${String(i).padStart(2, "0")}`, long(i), `Room ${i}`, extra))
        }
        const huge = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: big, home } })
        yield* huge.phrases.say(nl ? "zeg tegen iedereen dat het eten klaar is" : "tell everyone dinner is ready", { device: "kitchen-display" })
        const text = huge.phrases.spoken.at(-1)!.text
        assert.isAtMost(text.length, ANSWER_MAX)
        assert.include(text, nl ? "Niet omgeroepen" : "Not announced")
        assert.include(text, nl ? "Ik toon het ook op" : "Also showing it on")
        assert.isAtMost(said(yield* huge.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })).length, ANSWER_MAX)
        // A question about rooms is held to the same bound.
        const rooms: Array<TestDevice> = [dev("kitchen-display", "Kitchen display", "Kitchen")]
        for (let i = 0; i < 12; i++) rooms.push(dev(`room-${i}`, `Tablet ${i}`, `${"Bedroom upstairs".padEnd(37, "-")}${String(i).padStart(3, "0")}`))
        const asked = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: rooms, home } })
        const q = said(yield* asked.tool("broadcast_send", { message: "Hello", room: "bedroom" }, { device: "kitchen-display" }))
        assert.isAtMost(q.length, ANSWER_MAX)
        assert.include(q, nl ? "Welke kamer bedoel je" : "Which room do you mean")
        const none = said(yield* asked.tool("broadcast_send", { message: "Hello", room: "Garden" }, { device: "kitchen-display" }))
        assert.isAtMost(none.length, ANSWER_MAX)
      }
    }))

  it.effect("7: a name is cut at a code point boundary, so a sender or room with an emoji at the cut still gets its card", () =>
    Effect.gen(function*() {
      assert.strictEqual(cutName("K".repeat(38) + "🏡 kitchen"), `${"K".repeat(38)}…`)
      assert.strictEqual(cutName("short"), "short")
      assert.isAtMost(cutName("🏡".repeat(30)).length, 40)
      const sender = "K".repeat(38) + "🏡 kitchen"
      const roomLabel = "Alpha " + "R".repeat(32) + "🏡xxxx"
      const kit = yield* startTestModule(probed({ jobResults: [] }), {
        household: { devices: [dev("kitchen-display", sender, "Kitchen"), dev("study-tablet", "Study tablet", roomLabel)] }
      })
      const r = yield* kit.tool("broadcast_send", { message: "Dinner", room: "alpha" }, { device: "kitchen-display" })
      assert.strictEqual(said(r), "Announcing on Study tablet. Also showing it on Study tablet.")
      yield* kit.present.settle
      const card = kit.present.shown("study-tablet")[0]
      assert.strictEqual(card?.content.kind === "card" ? card.content.facts?.[0]?.value : "", `${"K".repeat(38)}…`)
      assert.strictEqual(card?.content.kind === "card" ? card.content.title : "", `Announcement for Alpha ${"R".repeat(32)}…`)
    }))

  it.effect("8: a restart with speech waiting and a card showing; the card goes after 30 seconds and when the module stops", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: HOUSE } })
      yield* kit.notify.replying("study-tablet", true)
      yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      yield* kit.restart
      yield* kit.present.settle
      // The part that made the card closed with the restart: a transient card is withdrawn, nothing stale is left.
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      // The announcement waiting behind the reply is the notification service's: it is said once, after the reply, not twice.
      yield* kit.notify.replying("study-tablet", false)
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.filter((a) => a.deviceId === "study-tablet").map((a) => a.text), ["Dinner"])
      // After 30 seconds a card is gone; and when the module stops it is withdrawn at once.
      yield* kit.tool("broadcast_send", { message: "Again" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      yield* kit.advance(29_000)
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      yield* kit.advance(2_000)
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      yield* kit.tool("broadcast_send", { message: "Third" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      yield* kit.stop
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
    }))

  it.effect("8: a fan-out where some calls fail and some succeed: it goes on, and says each group", () =>
    Effect.gen(function*() {
      const house = [dev("kitchen-display", "Kitchen display", "Kitchen"), dev("a-tablet", "A tablet", "A"), dev("b-tablet", "B tablet", "B"), dev("c-tablet", "C tablet", "C"), dev("d-tablet", "D tablet", "D")]
      const kit = yield* startTestModule(
        probed({ jobResults: [] }, {
          speech: (real) => ({ say: (t, x, o) => ((t as { device: string }).device === "b-tablet" ? Effect.fail(new SpeechError({ reason: "no-device", message: "gone" })) : real.say(t, x, o)) }),
          present: (real) => ({
            ...real,
            show: (t, p, o) => ((t as { device: string }).device === "c-tablet" ? Effect.fail(new PresentError({ reason: "busy", message: "busy" })) : real.show(t, p, o))
          })
        }),
        { household: { devices: house } }
      )
      const r = yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      yield* kit.advance(5_000)
      assert.deepStrictEqual(where(kit), ["a-tablet", "c-tablet", "d-tablet"])
      assert.strictEqual(said(r), "Announcing on A tablet, C tablet and 1 more. Not announced on B tablet (failed). Also showing it on A tablet and D tablet. I could not put it on 1 of the screens.")
    }))

  it.effect("after the base's fix round: a room broadcast asks the speech service to leave the origin out, and the chime is a cue with no text", () =>
    Effect.gen(function*() {
      const targets: Array<unknown> = []
      const texts: Array<string> = []
      const kit = yield* startTestModule(
        probed({ jobResults: [] }, { speech: (real) => ({ say: (t, x, o) => (targets.push(t), texts.push(x), real.say(t, x, o)) }) }),
        { household: { devices: [dev("kitchen-display", "Kitchen display", "Kitchen"), dev("kitchen-speaker", "Kitchen speaker", "Kitchen"), dev("study-tablet", "Study tablet", "Study")] } }
      )
      const r = yield* kit.tool("broadcast_send", { message: "Coming", room: "kitchen" }, { device: "kitchen-display" })
      assert.deepStrictEqual(targets, [{ room: "Kitchen", except: "kitchen-display" }])
      assert.strictEqual(said(r), "Announcing on Kitchen speaker. Also showing it on Kitchen speaker.")
      yield* kit.advance(5_000)
      assert.deepStrictEqual(where(kit), ["kitchen-speaker"])
      targets.length = 0
      yield* kit.tool("broadcast_chime", {}, { device: "kitchen-display" })
      yield* kit.tool("broadcast_chime", { room: "study" }, { device: "kitchen-display" })
      assert.deepStrictEqual(texts.slice(-2), ["", ""])
      yield* kit.advance(5_000)
      assert.deepStrictEqual(kit.notify.announced.filter((a) => a.text === "").map((a) => [a.deviceId, a.cue]), [["kitchen-speaker", true], ["study-tablet", true], ["study-tablet", true]])
    }))

  it.effect("after the base's fix round: a page that lost its connection is not given an ended card back, and gets what applies after its welcome", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(probed({ jobResults: [] }), { household: { devices: HOUSE } })
      yield* kit.tool("broadcast_send", { message: "Dinner" }, { device: "kitchen-display" })
      yield* kit.present.settle
      assert.strictEqual(kit.present.shown("study-tablet").length, 1)
      // The page loses its connection: it holds nothing; the card ends while it is away.
      yield* kit.notify.disconnect("study-tablet")
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      yield* kit.advance(31_000)
      yield* kit.notify.connect("study-tablet")
      yield* kit.present.settle
      assert.deepStrictEqual(kit.present.shown("study-tablet"), [])
      // A card that still applies at the next welcome is given.
      yield* kit.tool("broadcast_send", { message: "Later" }, { device: "kitchen-display" })
      yield* kit.present.settle
      yield* kit.notify.disconnect("study-tablet")
      yield* kit.notify.connect("study-tablet")
      yield* kit.present.settle
      const card = kit.present.shown("study-tablet")[0]
      assert.strictEqual(card?.content.kind === "card" ? card.content.text : "", "Later")
    }))
})
