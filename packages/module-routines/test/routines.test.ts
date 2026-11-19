// The routines module through the real host, gateway, phrase matcher and notification service of the test kit: a
// routine started by its phrase and by `routines_run`, what the catalogue can tell checked before anything runs, each
// step a gateway call as the person and device that started it, the run stopped (with one true sentence) by a refusal,
// values that do not fit, a failure, the person, a cancel or a restart.
import { assert, describe, it } from "@effect/vitest"
import { ActionError, CurrentTurn, CurrentTurnTrace, defineAction, defineModule, Param, type Trace, type TurnContext } from "@pva/core"
import { checkModule, startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { catalog, routinesModule, routinesOf, texts } from "../src/index.ts"
import { makeRunner } from "../src/run.ts"

vi.setConfig({ testTimeout: 30_000 })

interface Seen {
  readonly action: string
  readonly turn: TurnContext | undefined
  readonly params: unknown
  /** The action ran inside some execution trace (the starting turn's, if the run kept it open). */
  readonly traced: boolean
}

/** Modules a routine's steps call: each records the turn it ran as. */
const helpers = (seen: Array<Seen>) => {
  const record = (action: string, params: unknown) =>
    Effect.flatMap(Effect.all([CurrentTurn, CurrentTurnTrace]), ([turn, trace]) => Effect.sync(() => void seen.push({ action, turn, params, traced: trace !== undefined })))
  const lamp = defineModule({
    apiVersion: 2,
    id: "lamp",
    name: "Lamp",
    description: "A lamp.",
    enabledByDefault: false,
    start: () =>
      Effect.succeed({
        actions: [
          defineAction({
            id: "switch",
            label: "Switch the lamp",
            description: "Switch the lamp on or off.",
            examples: ["lamp on"],
            params: { to: Param.choice({ label: "On or off", options: [{ value: "on", label: "on" }, { value: "off", label: "off" }] }) },
            risk: "change",
            run: ({ to }) => Effect.as(record("lamp.switch", { to }), { say: `The lamp is ${to}.` })
          }),
          defineAction({
            id: "diary",
            label: "Read the diary",
            description: "Today's first appointment: someone's personal content.",
            examples: ["what's in my diary"],
            params: {},
            speculative: true,
            sensitivity: "personal",
            run: () => Effect.as(record("lamp.diary", {}), { say: "Dentist at three." })
          }),
          defineAction({
            id: "agenda",
            label: "Read the agenda",
            description: "The household's or someone's, decided per answer.",
            examples: ["what's on today"],
            params: {},
            speculative: true,
            sensitivity: () => ({ kind: "household" }),
            run: () => Effect.as(record("lamp.agenda", {}), { say: "Bins tonight." })
          }),
          defineAction({
            id: "dim",
            label: "Dim the lamp to a level",
            description: "Dim the lamp to a level from 0 to 100.",
            examples: ["dim the lamp to 40"],
            params: { level: Param.number({ label: "Level", integer: true, min: 0, max: 100 }) },
            risk: "change",
            run: ({ level }) => Effect.as(record("lamp.dim", { level }), {})
          }),
          defineAction({
            id: "timer",
            label: "Lamp off after a while",
            description: "Switch the lamp off after a duration.",
            examples: ["lamp off in ten minutes"],
            params: { after: Param.duration({ label: "After", minMs: 1_000, maxMs: 3_600_000 }) },
            risk: "change",
            run: ({ after }) => Effect.as(record("lamp.timer", { after }), {})
          }),
          defineAction({
            id: "quiet",
            label: "Dim the lamp",
            description: "Dim the lamp without a word.",
            examples: ["dim the lamp"],
            params: {},
            risk: "change",
            run: () => Effect.as(record("lamp.quiet", {}), {})
          })
        ]
      })
  })
  const flaky = defineModule({
    apiVersion: 2,
    id: "flaky",
    name: "Flaky",
    description: "Fails, or takes its time.",
    enabledByDefault: false,
    start: () =>
      Effect.succeed({
        actions: [
          defineAction({
            id: "fail",
            label: "Fail",
            description: "Always fails.",
            examples: ["fail"],
            params: {},
            risk: "change",
            run: () => Effect.andThen(record("flaky.fail", {}), Effect.fail(new ActionError({ message: "It broke." })))
          }),
          defineAction({
            id: "slow",
            label: "Slow",
            description: "Takes three seconds.",
            examples: ["slow"],
            params: {},
            risk: "change",
            run: () => Effect.andThen(record("flaky.slow", {}), Effect.as(Effect.sleep(3_000), { say: "Slow is done." }))
          })
        ]
      })
  })
  const door = defineModule({
    apiVersion: 2,
    id: "door",
    name: "Door",
    description: "A front door.",
    enabledByDefault: false,
    start: () =>
      Effect.succeed({
        actions: [
          defineAction({
            id: "unlock",
            label: "Unlock the door",
            description: "Unlock the front door. Security: the risk policy refuses it.",
            examples: ["unlock the door"],
            params: {},
            risk: "security",
            run: () => Effect.as(record("door.unlock", {}), { say: "Unlocked." })
          }),
          defineAction({
            id: "move",
            label: "Move the garage door",
            description: "Open or close the garage door. Opening is security, which the risk policy refuses.",
            examples: ["close the garage"],
            params: { to: Param.choice({ label: "To", options: [{ value: "open", label: "open" }, { value: "closed", label: "closed" }] }) },
            risk: { classes: ["change", "security"], of: ({ to }) => (to === "open" ? "security" : "change") },
            run: () => Effect.as(record("door.move", {}), { say: "Moved." })
          }),
          defineAction({
            id: "order",
            label: "Order a key",
            description: "Order a spare key; needs the owner's confirmation.",
            examples: ["order a key"],
            params: {},
            risk: "change",
            confirm: true,
            run: () => Effect.as(record("door.order", {}), { say: "Ordered." })
          })
        ]
      })
  })
  return [lamp, flaky, door]
}

const routine = (name: string, steps: ReadonlyArray<unknown>, phrasesEn: ReadonlyArray<string> = [], phrasesNl: ReadonlyArray<string> = []) => ({
  name,
  phrasesEn: [...phrasesEn],
  phrasesNl: [...phrasesNl],
  steps: JSON.stringify(steps)
})

const GOOD_NIGHT = routine("Good night", [{ say: "Sleep well." }, { call: "lamp.switch", params: { to: "off" } }], ["good night"], ["goedenacht"])

const start = (seen: Array<Seen>, routines: ReadonlyArray<unknown>, more: { readonly household?: TestHouseholdInput; readonly goodMorning?: boolean } = {}) =>
  startTestModule(routinesModule, {
    settings: { routines, ...(more.goodMorning === true ? { goodMorning: true } : {}) },
    others: helpers(seen),
    ...(more.household !== undefined ? { household: more.household } : {})
  })

const spoken = (kit: { readonly notify: { readonly announced: ReadonlyArray<{ readonly deviceId: string; readonly text: string }> } }) => kit.notify.announced.map((a) => [a.deviceId, a.text])

/** What was announced, as text. */
const texts_ = (kit: { readonly notify: { readonly announced: ReadonlyArray<{ readonly text: string }> } }) => kit.notify.announced.map((a) => a.text)

/** The gateway's decisions about the module's line action (each `say` step), in order. */
const lineDecisions = (kit: { readonly riskDecisions: () => ReadonlyArray<{ readonly moduleId: string | undefined; readonly name: string; readonly outcome: string; readonly principal: string; readonly kind: string }> }) =>
  kit.riskDecisions().filter((d) => d.moduleId === "routines" && d.name.endsWith("line"))

describe("routines: conformance", () => {
  it.effect("passes the conformance check, off by default, with and without routines, its texts in both languages", () =>
    Effect.gen(function*() {
      for (const definition of catalog) yield* checkModule(definition, { texts })
      yield* checkModule(routinesModule, { texts, settings: { routines: [GOOD_NIGHT], goodMorning: true }, others: helpers([]) })
    }))
})

describe("routines: started by its phrase", () => {
  it.effect("a phrase after the wake phrase runs the steps in order, each one a gateway call as the person and device that started it", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      const said = yield* kit.phrases.say("Good night.", { device: "kitchen-display" })
      assert.isTrue(said.taken && said.by === "command")
      // The command answers nothing itself: the routine speaks for itself, outside the turn.
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [])
      yield* kit.advance(10_000)
      // The lamp's own answer ("The lamp is off.") is not read out: a called action's answer never is.
      assert.deepStrictEqual(spoken(kit), [["kitchen-display", "Sleep well."]])
      assert.strictEqual(seen.length, 1)
      assert.strictEqual(seen[0]?.action, "lamp.switch")
      assert.deepStrictEqual(seen[0]?.params, { to: "off" })
      assert.strictEqual(seen[0]?.turn?.deviceId, "kitchen-display")
      assert.strictEqual(seen[0]?.turn?.person?.id, "p-sam")
      assert.strictEqual(seen[0]?.turn?.source, "routine")
      // The phrase's trace ended with the command: a step after it gets no trace (the host offers none), and never that one.
      assert.isFalse(seen[0]?.traced)
      assert.strictEqual(kit.phrases.traces.length, 1)
    }))

  it.effect("in a Dutch household its Dutch phrase starts it, and the template greets in Dutch", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT], { household: { home: { HOME_LANGUAGE: "nl-NL" } }, goodMorning: true })
      assert.isTrue((yield* kit.phrases.say("goedenacht", { device: "robins-phone" })).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => [s.action, s.turn?.person?.id]), [["lamp.switch", "p-robin"]])
      // The English phrase is not one of the household's language.
      assert.deepStrictEqual(yield* kit.phrases.say("good night", { device: "robins-phone" }), { taken: false })
      assert.isTrue((yield* kit.phrases.say("Goedemorgen!", { device: "robins-phone" })).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(texts_(kit), ["Sleep well.", "Goedemorgen! Een fijne dag."])
    }))

  it.effect("on a public screen with nobody's name the steps run for nobody: no person is lent to them", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      assert.isTrue((yield* kit.phrases.say("good night", { device: "hall-screen" })).taken)
      yield* kit.advance(10_000)
      assert.strictEqual(seen[0]?.turn?.deviceId, "hall-screen")
      assert.strictEqual(seen[0]?.turn?.person, undefined)
    }))
})

describe("routines: refused before anything runs, where the catalogue can tell", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a step the risk policy refuses in every class (security)", { call: "door.unlock" }, "I can't run Check: step 2 is something this assistant can't do here."],
    ["a step that needs a confirmation", { call: "door.order" }, "I can't run Check: step 2 needs a confirmation I can't ask for yet."],
    ["a step whose values are of the wrong kind", { call: "lamp.switch", params: { to: 3 } }, "I can't run Check: the values in step 2 don't fit that action."],
    ["a step missing a required value", { call: "lamp.switch" }, "I can't run Check: the values in step 2 don't fit that action."],
    ["a step naming an action that is not there", { call: "nowhere.thing" }, "I can't run Check: step 2 is something this assistant can't do here."]
  ]
  for (const [what, step, sentence] of cases) {
    it.effect(what, () =>
      Effect.gen(function*() {
        const seen: Array<Seen> = []
        const kit = yield* start(seen, [routine("Check", [{ say: "First." }, step, { call: "lamp.switch", params: { to: "on" } }], ["run the check"])])
        assert.isTrue((yield* kit.phrases.say("run the check")).taken)
        assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [sentence])
        yield* kit.advance(10_000)
        // Nothing ran: no line, no call, no decision for a step.
        assert.deepStrictEqual([spoken(kit), seen, lineDecisions(kit)], [[], [], []])
      }))
  }

  it.effect("a step of a module this assistant does not have on", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT], { household: { assistants: [{ id: "jeff", modules: { lamp: false } }] } })
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["I can't run Good night: step 2 is something this assistant can't do here."])
      yield* kit.advance(10_000)
      assert.deepStrictEqual([spoken(kit), seen], [[], []])
    }))

  it.effect("a step the assistant switched off, refused in Dutch", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT], {
        household: { home: { HOME_LANGUAGE: "nl-NL" }, assistants: [{ id: "jeff", modules: { lamp: { offTools: ["lamp_switch"] } } }] }
      })
      assert.isTrue((yield* kit.phrases.say("goedenacht")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Ik kan Good night niet uitvoeren: stap 2 kan deze assistent hier niet doen."])
      assert.deepStrictEqual(seen, [])
    }))

  it.effect("with `change` refused, the routine's own command is refused by the gateway: nothing runs", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Quiet", [{ call: "lamp.quiet" }], ["lights out"])])
      kit.setRiskPolicy({ change: "deny" })
      const said = yield* kit.phrases.say("lights out")
      assert.strictEqual(said.taken && said.outcome.did, "refused")
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
    }))
})

describe("routines: each step decided when it runs; the run stops where one is refused", () => {
  const ALL_VALUES: ReadonlyArray<readonly [string, unknown]> = [
    ["a choice value the action does not have", { call: "lamp.switch", params: { to: "invalid" } }],
    ["a duration that does not read", { call: "lamp.timer", params: { after: "soonish" } }],
    ["a number outside its bounds", { call: "lamp.dim", params: { level: 150 } }]
  ]
  for (const [what, step] of ALL_VALUES) {
    it.effect(`${what}: the earlier step is done, the run stops there and says so`, () =>
      Effect.gen(function*() {
        const seen: Array<Seen> = []
        const kit = yield* start(seen, [routine("Check", [{ say: "First." }, step, { call: "lamp.quiet" }], ["run the check"])])
        assert.isTrue((yield* kit.phrases.say("run the check")).taken)
        // The catalogue cannot tell: the routine starts.
        assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [])
        yield* kit.advance(10_000)
        assert.deepStrictEqual(seen, [])
        assert.deepStrictEqual(texts_(kit), ["First.", "Check stopped at step 2: its values don't fit that action. Step 1 is done."])
      }))
  }

  it.effect("a step whose class depends on its values: refused for the values it has, allowed for others", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [
        routine("Open up", [{ call: "lamp.quiet" }, { call: "door.move", params: { to: "open" } }, { call: "lamp.switch", params: { to: "on" } }], ["open up"]),
        routine("Close up", [{ call: "door.move", params: { to: "closed" } }], ["close up"])
      ])
      assert.isTrue((yield* kit.phrases.say("open up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet"])
      assert.deepStrictEqual(texts_(kit), ["Open up stopped at step 2: I'm not allowed to do that. Step 1 is done."])
      assert.isTrue(kit.riskDecisions().some((d) => d.moduleId === "door" && d.outcome === "deny"))
      assert.isTrue((yield* kit.phrases.say("close up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet", "door.move"])
      assert.strictEqual(texts_(kit).at(-1), "Close up is done.")
    }))

  it.effect("a policy change during the run refuses the next call on its own; the sentence says what was done, in Dutch too", () =>
    Effect.gen(function*() {
      for (const [language, phrase, line] of [
        ["en-GB", "good night", "Good night stopped at step 2: I'm not allowed to do that. Step 1 is done."],
        ["nl-NL", "goedenacht", "Good night is gestopt bij stap 2: dat mag ik niet doen. Stap 1 is gedaan."]
      ] as const) {
        const seen: Array<Seen> = []
        const kit = yield* start(seen, [GOOD_NIGHT], { household: { home: { HOME_LANGUAGE: language } } })
        assert.isTrue((yield* kit.phrases.say(phrase)).taken)
        yield* kit.advance(500)
        kit.setRiskPolicy({ change: "deny" })
        yield* kit.advance(10_000)
        assert.deepStrictEqual(seen, [])
        assert.deepStrictEqual(texts_(kit), ["Sleep well.", line])
        assert.isTrue(kit.riskDecisions().some((d) => d.outcome === "deny" && d.moduleId === "lamp"))
      }
    }))

  it.effect("each `say` step is a gateway call with its own decision, as the starting device", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [routine("Bookends", [{ say: "First." }, { call: "lamp.quiet" }, { say: "Last." }], ["bookends"])])
      assert.isTrue((yield* kit.phrases.say("bookends", { device: "robins-phone" })).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(texts_(kit), ["First.", "Last."])
      const decisions = lineDecisions(kit)
      assert.deepStrictEqual(decisions.map((d) => d.outcome), ["allow", "allow"])
      // Each decided as a turn's call (the starting device's turn, `source: "routine"`), and spoken there.
      assert.deepStrictEqual(decisions.map((d) => [d.principal, d.kind]), [["turn", "action"], ["turn", "action"]])
      assert.isTrue(kit.notify.announced.every((a) => a.deviceId === "robins-phone"))
    }))

  it.effect("a `say` step refused by the policy when it comes: not said, and the run stops there", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [routine("Twice", [{ say: "One." }, { say: "Two." }], ["say it twice"])])
      assert.isTrue((yield* kit.phrases.say("say it twice")).taken)
      yield* kit.advance(500)
      kit.setRiskPolicy({ change: "deny" })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(texts_(kit), ["One.", "Twice stopped at step 2: I'm not allowed to do that. Step 1 is done."])
      assert.deepStrictEqual(lineDecisions(kit).map((d) => d.outcome), ["allow", "deny"])
    }))

  it.effect("the line action speaks only a running routine's current line on its own device", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [GOOD_NIGHT])
      assert.deepStrictEqual(yield* kit.action("line", { run: 1, step: 1 }), { ok: false, code: "failed", message: "That line belongs to no routine running here." })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(spoken(kit), [])
    }))

  it.effect("a device that left during the run: its next step is refused by the gateway, nothing more is done", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      yield* kit.advance(500)
      yield* kit.notify.disconnect("kitchen-display")
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
    }))

  it.effect("a failed step: the rest runs, and the end says which step it could not confirm", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Tidy", [{ call: "flaky.fail" }, { call: "lamp.quiet" }], ["tidy up"])])
      assert.isTrue((yield* kit.phrases.say("tidy up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.fail", "lamp.quiet"])
      // Another module's failure sentence is not repeated; the step is named by its number.
      assert.deepStrictEqual(texts_(kit), ["Tidy is done, but I couldn't confirm step 1."])
    }))

  it.effect("stop_if_failed after a failed step leaves out the rest, and says what was done before", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Tidy", [{ call: "lamp.quiet" }, { call: "flaky.fail" }, { stop_if_failed: true }, { call: "lamp.quiet" }, { say: "All tidy." }], ["tidy up"])])
      assert.isTrue((yield* kit.phrases.say("tidy up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet", "flaky.fail"])
      assert.deepStrictEqual(texts_(kit), ["Tidy stopped: I couldn't confirm step 2, so I left out the rest. Step 1 is done."])
    }))

  it.effect("stop_if_failed after a call that ran goes on: it is about the action running, not about anything said", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Tidy", [{ call: "lamp.switch", params: { to: "on" } }, { stop_if_failed: true }, { call: "lamp.quiet" }, { say: "All tidy." }], ["tidy up"])])
      assert.isTrue((yield* kit.phrases.say("tidy up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.switch", "lamp.quiet"])
      assert.deepStrictEqual(texts_(kit), ["All tidy."])
    }))

  it.effect("a called action's answer is never read out, the household's nor a personal one, here on the public screen", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Day", [{ call: "lamp.diary" }, { call: "lamp.agenda" }, { call: "lamp.switch", params: { to: "on" } }], ["my day"])])
      assert.isTrue((yield* kit.phrases.say("my day", { device: "hall-screen" })).taken)
      yield* kit.advance(20_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.diary", "lamp.agenda", "lamp.switch"])
      assert.deepStrictEqual(spoken(kit), [["hall-screen", "Day is done."]])
      for (const text of texts_(kit)) for (const answer of ["Dentist", "Bins", "lamp is on"]) assert.notInclude(text, answer)
    }))

  it.effect("a routine that says nothing on its way ends with one line, in both languages", () =>
    Effect.gen(function*() {
      for (const [language, line] of [["en-GB", "Dim is done."], ["nl-NL", "Dim is klaar."]] as const) {
        const kit = yield* start([], [routine("Dim", [{ call: "lamp.quiet" }], ["dim it"], ["dimmen"])], { household: { home: { HOME_LANGUAGE: language } } })
        assert.isTrue((yield* kit.phrases.say(language === "en-GB" ? "dim it" : "dimmen")).taken)
        yield* kit.advance(10_000)
        assert.deepStrictEqual(texts_(kit), [line])
      }
    }))

  it.effect("a `say` that cannot be spoken within two minutes (a reply holds the device) is taken back and counts as failed", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Wait", [{ say: "Behind the reply." }, { call: "lamp.quiet" }], ["wait for it"])])
      yield* kit.notify.replying("kitchen-display", true)
      assert.isTrue((yield* kit.phrases.say("wait for it")).taken)
      yield* kit.advance(119_000)
      assert.deepStrictEqual(seen, [])
      yield* kit.advance(2_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet"])
      yield* kit.notify.replying("kitchen-display", false)
      yield* kit.advance(10_000)
      // The line taken back is never said late; the end says what could not be confirmed.
      assert.deepStrictEqual(texts_(kit), ["Wait is done, but I couldn't confirm step 1."])
    }))
})

describe("routines: steps have decisions, not a trace of their own", () => {
  it.effect("the starting turn's trace holds the start's decision only: no step after it writes into it", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Bookends", [{ say: "First." }, { call: "lamp.quiet" }], ["bookends"])])
      // A model turn's trace, as the conversation provides it around the tool call (the kit's turn id is 1).
      const trace = { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] } as unknown as Trace
      assert.isTrue((yield* kit.tool("routines_run", { name: "bookends" }).pipe(Effect.provideService(CurrentTurnTrace, trace))).ok)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => [s.action, s.traced]), [["lamp.quiet", false]])
      assert.deepStrictEqual((trace.calls ?? []).map((c) => c.name), ["routines_run"])
      // The steps' decisions are recorded by the gateway all the same.
      assert.deepStrictEqual(kit.riskDecisions().filter((d) => d.moduleId === "routines" || d.moduleId === "lamp").map((d) => [d.name, d.outcome]), [
        ["routines_run", "allow"],
        ["routines_line", "allow"],
        ["lamp_quiet", "allow"]
      ])
    }))
})

describe("routines: one at a time, and a phrase heard once starts once", () => {
  it.effect("a second start of the same routine while it runs is refused, not joined; once it ended it starts again", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      assert.isTrue((yield* kit.phrases.say("good night", { device: "robins-phone" })).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Good night is already running."])
      const listed = yield* kit.tool("routines_list", {})
      assert.deepStrictEqual(listed.value, { count: 1, routines: [{ name: "Good night", phrases: ["good night"], steps: 2, running: true }] })
      yield* kit.advance(10_000)
      assert.strictEqual(seen.length, 1)
      assert.isTrue((yield* kit.phrases.say("good night", { device: "robins-phone" })).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.turn?.deviceId), ["kitchen-display", "robins-phone"])
    }))

  it.effect("another routine on a device already running one is refused, naming the one that runs", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [GOOD_NIGHT, routine("Dim", [{ call: "lamp.quiet" }], ["dim it"])])
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      assert.isTrue((yield* kit.phrases.say("dim it")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Good night is still running here."])
      // On another device it runs.
      assert.isTrue((yield* kit.phrases.say("dim it", { device: "robins-phone" })).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Good night is still running here."])
    }))

  it.effect("the same phrase turn replayed after the run ended gets the first answer and runs nothing; a new phrase turn runs", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Check", [{ call: "lamp.quiet" }], ["run the check"])])
      const turn = { ...kit.turn({ device: "kitchen-display" }), source: "phrase" as const, turnId: 41, conversationId: "c-41" }
      assert.deepStrictEqual(yield* kit.action("r_check", {}, turn), { ok: true })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(yield* kit.action("r_check", {}, turn), { ok: true })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet"])
      // While it runs, a replay gets the same first answer (not "already running").
      assert.deepStrictEqual(yield* kit.action("r_check", {}, { ...turn, turnId: 42 }), { ok: true })
      assert.deepStrictEqual(yield* kit.action("r_check", {}, { ...turn, turnId: 42 }), { ok: true })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet", "lamp.quiet"])
    }))

  it.effect("the model's calls are never held back: two calls in one turn after the first run ended both run", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Check", [{ call: "lamp.quiet" }], ["run the check"])])
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "check" })).value, { spoken: "Starting Check." })
      // While it runs, a second call of the same turn is refused: one run at a time.
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "check" })).value, { spoken: "Check is already running." })
      yield* kit.advance(10_000)
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "check" })).value, { spoken: "Starting Check." })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.quiet", "lamp.quiet"])
    }))
})

describe("routines: stopping one", () => {
  const SLOWLY = routine("Slowly", [{ say: "Here we go." }, { call: "flaky.slow" }, { call: "lamp.quiet" }], ["go slowly"])

  it.effect("routines_stop during a slow call: the call may still complete, no further step starts, nothing more is said", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [SLOWLY])
      assert.isTrue((yield* kit.phrases.say("go slowly")).taken)
      yield* kit.advance(2_500)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.slow"])
      const stopped = yield* kit.tool("routines_stop", {})
      assert.strictEqual(stopped.value, "I stopped Slowly during step 2; that step may still complete.")
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.slow"])
      assert.deepStrictEqual(texts_(kit), ["Here we go."])
      // It has ended: it can start again from the beginning.
      assert.isTrue((yield* kit.phrases.say("go slowly")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [])
    }))

  it.effect("\"cancel the routine\" while its line waits behind a reply: the line never starts, and nothing after it runs", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Queued", [{ say: "Queued line." }, { call: "lamp.quiet" }], ["queue it"])])
      yield* kit.notify.replying("kitchen-display", true)
      assert.isTrue((yield* kit.phrases.say("queue it")).taken)
      yield* kit.advance(500)
      assert.isTrue((yield* kit.phrases.say("Cancel the routine.")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["I stopped Queued; it had finished 0 of its 2 steps."])
      yield* kit.notify.replying("kitchen-display", false)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.isFalse(kit.notify.announced.some((a) => a.text === "Queued line." && a.outcome === "spoken"))
    }))

  it.effect("in Dutch, and with nothing running here it says so", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [SLOWLY], { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.isTrue((yield* kit.phrases.say("annuleer de routine")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["Hier loopt geen routine."])
      assert.isTrue((yield* kit.tool("routines_run", { name: "slowly" })).ok)
      yield* kit.advance(500)
      // Another device has nothing running.
      assert.strictEqual((yield* kit.tool("routines_stop", {}, { device: "robins-phone" })).value, "Hier loopt geen routine.")
      assert.strictEqual((yield* kit.tool("routines_stop", {})).value, "Ik heb Slowly gestopt; 0 van de 3 stappen waren klaar.")
    }))

  it.effect("the person's stop on the device while the routine's line plays ends the routine: the rest is not done", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      yield* kit.advance(500)
      assert.isTrue(yield* kit.notify.engine.stopSpeech("kitchen-display"))
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.deepStrictEqual(texts_(kit), ["Sleep well."])
    }))

  it.effect("the limit, as the page states it: the host's \"stop\" during a call gives the module no signal, and the routine goes on", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Slow", [{ call: "flaky.slow" }, { call: "lamp.quiet" }], ["slow down"])])
      assert.isTrue((yield* kit.phrases.say("slow down")).taken)
      yield* kit.advance(500)
      const stop = yield* kit.phrases.say("stop")
      assert.isTrue(stop.taken && stop.by === "control")
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.slow", "lamp.quiet"])
    }))
})

describe("routines: a restart in the middle does not resume", () => {
  it.effect("during a call: told that the step may or may not have been done; nothing more runs, and it can start again", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Slowly", [{ say: "Here we go." }, { call: "flaky.slow" }, { call: "lamp.quiet" }], ["go slowly"])])
      assert.isTrue((yield* kit.phrases.say("go slowly")).taken)
      yield* kit.advance(2_500)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.slow"])
      yield* kit.restart
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.slow"])
      assert.deepStrictEqual(texts_(kit), [
        "Here we go.",
        "Slowly was cut short when the routines module restarted, during step 2, which may or may not have been done."
      ])
      assert.isTrue((yield* kit.phrases.say("go slowly")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [])
    }))

  it.effect("while its line plays: the line is stopped, then the device is told how far it got, in Dutch", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Langzaam", [{ say: "Daar gaan we." }, { call: "lamp.quiet" }], [], ["langzaam aan"])], { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.isTrue((yield* kit.phrases.say("langzaam aan")).taken)
      yield* kit.advance(500)
      yield* kit.restart
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.deepStrictEqual(kit.notify.announced.map((a) => [a.text, a.outcome]), [
        ["Daar gaan we.", "stopped"],
        ["Langzaam is afgebroken doordat de routinemodule opnieuw startte; 0 van de 2 stappen waren klaar.", "spoken"]
      ])
    }))

  it.effect("while its line waits behind a reply: the line never starts; only the sentence about the restart is said", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Check", [{ say: "Old queued line." }, { call: "lamp.quiet" }], ["run the check"])])
      yield* kit.notify.replying("kitchen-display", true)
      assert.isTrue((yield* kit.phrases.say("run the check")).taken)
      yield* kit.advance(500)
      yield* kit.restart
      yield* kit.notify.replying("kitchen-display", false)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.deepStrictEqual(kit.notify.announced.filter((a) => a.outcome === "spoken").map((a) => a.text), [
        "Check was cut short when the routines module restarted; it had finished 0 of its 2 steps."
      ])
    }))
})

describe("routines: the tools", () => {
  const ROUTINES = [
    GOOD_NIGHT,
    routine("Good night kids", [{ say: "Lights out, kids." }], ["kids to bed"]),
    routine("Bedtime", [{ call: "lamp.quiet" }], ["bedtime"])
  ]

  it.effect("routines_run starts one by its name, fillers dropped; an exact name wins over a longer one", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, ROUTINES)
      const r = yield* kit.tool("routines_run", { name: "the bedtime routine" }, { device: "robins-phone" })
      assert.deepStrictEqual(r.value, { spoken: "Starting Bedtime." })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => [s.action, s.turn?.deviceId, s.turn?.source]), [["lamp.quiet", "robins-phone", "routine"]])
      const exact = yield* kit.tool("routines_run", { name: "Good night" })
      assert.deepStrictEqual(exact.value, { spoken: "Starting Good night." })
    }))

  it.effect("a saved name made only of filler words is found exactly, by the tool and by its phrase, in both languages", () =>
    Effect.gen(function*() {
      const names = ["A", "The", "My routine", "De", "Het", "Mijn routine"]
      const seen: Array<Seen> = []
      // No phrases but one: the tool must find each by its saved name alone.
      const kit = yield* start(seen, names.map((n) => routine(n, [{ call: "lamp.quiet" }], n === "My routine" ? ["my routine"] : [])))
      for (const n of names) {
        assert.deepStrictEqual((yield* kit.tool("routines_run", { name: n })).value, { spoken: `Starting ${n}.` }, n)
        yield* kit.advance(10_000)
      }
      assert.isTrue((yield* kit.phrases.say("My routine")).taken)
      yield* kit.advance(10_000)
      assert.strictEqual(seen.length, names.length + 1)
      const dutch = yield* start([], [routine("Mijn routine", [{ call: "lamp.quiet" }])], { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual((yield* dutch.tool("routines_run", { name: "mijn routine" })).value, { spoken: "Ik start Mijn routine." })
    }))

  it.effect("routines_run asks which when a name fits several, and never repeats an unknown name", () =>
    Effect.gen(function*() {
      const kit = yield* start([], ROUTINES)
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "night" })).value, { spoken: "Which one: Good night or Good night kids?" })
      const unknown = yield* kit.tool("routines_run", { name: "secret-word-xyz" })
      assert.deepStrictEqual(unknown.value, { spoken: "I don't know a routine by that name." })
      assert.notInclude(unknown.content, "secret-word-xyz")
      yield* kit.advance(10_000)
      assert.deepStrictEqual(spoken(kit), [])
    }))

  it.effect("routines_run in Dutch, and its refusal is the same sentence as the phrase's", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [...ROUTINES, routine("Deur", [{ call: "door.unlock" }])], { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "night" })).value, { spoken: "Welke: Good night of Good night kids?" })
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "de deur" })).value, { spoken: "Ik kan Deur niet uitvoeren: stap 1 kan deze assistent hier niet doen." })
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "iets anders" })).value, { spoken: "Ik ken geen routine met die naam." })
    }))

  it.effect("a routine whose own command is switched off for the assistant is not run by the tool either", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT], { household: { assistants: [{ id: "jeff", modules: { routines: { offTools: ["routines_r_good_night"] } } }] } })
      assert.deepStrictEqual(yield* kit.phrases.say("good night"), { taken: false })
      assert.deepStrictEqual((yield* kit.tool("routines_run", { name: "good night" })).value, { spoken: "I can't run Good night here." })
      yield* kit.advance(10_000)
      assert.deepStrictEqual([spoken(kit), seen], [[], []])
    }))

  it.effect("a turn without a device: the gateway refuses it in serve mode; with no turn at all (the CLI modes) it says why", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [GOOD_NIGHT])
      const r = yield* kit.tool("routines_run", { name: "good night" }, { turnId: 7, conversationId: "c-7", assistantId: "jeff", source: "text" })
      assert.isFalse(r.ok)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(spoken(kit), [])
      const runner = makeRunner({ host: {} as never, speech: {} as never, scope: yield* Effect.scope, moduleId: "routines" })
      const [good] = routinesOf({ routines: [GOOD_NIGHT], goodMorning: false })
      assert.deepStrictEqual(yield* runner.start(good!, "nl"), { kind: "refused", refusal: { kind: "noDevice" }, text: "Ik kan een routine alleen vanaf een apparaat uitvoeren." })
    }))

  it.effect("routines_list names every routine with its phrases in the household's language; none says so", () =>
    Effect.gen(function*() {
      const kit = yield* start([], ROUTINES, { goodMorning: true })
      const listed = yield* kit.tool("routines_list", {})
      assert.deepStrictEqual(listed.value, {
        count: 4,
        routines: [
          { name: "Good night", phrases: ["good night"], steps: 2 },
          { name: "Good night kids", phrases: ["kids to bed"], steps: 1 },
          { name: "Bedtime", phrases: ["bedtime"], steps: 1 },
          { name: "Good morning", phrases: ["good morning"], steps: 1 }
        ]
      })
      const empty = yield* start([], [])
      assert.deepStrictEqual((yield* empty.tool("routines_list", {})).value, { spoken: "There are no routines yet." })
      assert.deepStrictEqual((yield* empty.tool("routines_run", { name: "anything" })).value, { spoken: "There are no routines yet." })
    }))
})

describe("routines: the Good morning template", () => {
  it.effect("switched on, its phrase greets on the device that asked", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [], { goodMorning: true })
      assert.isTrue((yield* kit.phrases.say("Good morning", { device: "kitchen-display" })).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(spoken(kit), [["kitchen-display", "Good morning! Have a good day."]])
    }))

  it.effect("off by default; left out when a routine of the owner's has its phrase", () =>
    Effect.gen(function*() {
      const off = yield* start([], [])
      assert.deepStrictEqual(yield* off.phrases.say("good morning"), { taken: false })
      const mine = yield* start([], [routine("Morning", [{ say: "Up you get." }], ["good morning"])], { goodMorning: true })
      assert.isTrue((yield* mine.phrases.say("good morning")).taken)
      yield* mine.advance(10_000)
      assert.deepStrictEqual(texts_(mine), ["Up you get."])
      assert.deepStrictEqual(((yield* mine.tool("routines_list", {})).value as { count: number }).count, 1)
    }))
})
