// The routines module through the real host, gateway, phrase matcher and notification service of the test kit: a
// routine started by its phrase and by `routines_run`, refused as a whole before anything runs, its steps run as the
// person and device that started it, stopped by a refusal, a failure, the person or a restart.
import { assert, describe, it } from "@effect/vitest"
import { ActionError, CurrentTurn, defineAction, defineModule, Param, type TurnContext } from "@pva/core"
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
}

/** Modules a routine's steps call: each records the turn it ran as. */
const helpers = (seen: Array<Seen>) => {
  const record = (action: string, params: unknown) => Effect.flatMap(CurrentTurn, (turn) => Effect.sync(() => void seen.push({ action, turn, params })))
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
  // Stand-ins for the clock and weather the template calls.
  const clock = defineModule({
    apiVersion: 2,
    id: "clock",
    name: "Clock",
    description: "The time.",
    enabledByDefault: false,
    start: () =>
      Effect.succeed({
        actions: [defineAction({ id: "time_now", label: "Tell the time", description: "The time.", examples: ["what time is it"], params: {}, speculative: true, run: () => Effect.as(record("clock.time_now", {}), { say: "It's ten o'clock." }) })]
      })
  })
  const weather = defineModule({
    apiVersion: 2,
    id: "weather",
    name: "Weather",
    description: "The weather.",
    enabledByDefault: false,
    start: () =>
      Effect.succeed({
        actions: [defineAction({ id: "today", label: "Tell the weather", description: "The weather.", examples: ["weather"], params: {}, speculative: true, run: () => Effect.as(record("weather.today", {}), { say: "Dry, 8 degrees." }) })]
      })
  })
  return [lamp, flaky, door, clock, weather]
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

describe("routines: conformance", () => {
  it.effect("passes the conformance check, off by default, with and without routines, its texts in both languages", () =>
    Effect.gen(function*() {
      for (const definition of catalog) yield* checkModule(definition, { texts })
      yield* checkModule(routinesModule, { texts, settings: { routines: [GOOD_NIGHT], goodMorning: true }, others: helpers([]) })
    }))
})

describe("routines: started by its phrase", () => {
  it.effect("a phrase after the wake phrase runs the steps in order, each call as the person and device that started it", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      const said = yield* kit.phrases.say("Good night.", { device: "kitchen-display" })
      assert.isTrue(said.taken && said.by === "command")
      // The command answers nothing itself: the routine speaks for itself, outside the turn.
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [])
      yield* kit.advance(10_000)
      yield* kit.notify.settle
      assert.deepStrictEqual(spoken(kit), [["kitchen-display", "Sleep well."], ["kitchen-display", "The lamp is off."]])
      // The call ran through the gateway as a turn of that device, its default person, with the source "routine".
      assert.strictEqual(seen.length, 1)
      assert.strictEqual(seen[0]?.action, "lamp.switch")
      assert.deepStrictEqual(seen[0]?.params, { to: "off" })
      assert.strictEqual(seen[0]?.turn?.deviceId, "kitchen-display")
      assert.strictEqual(seen[0]?.turn?.person?.id, "p-sam")
      assert.strictEqual(seen[0]?.turn?.source, "routine")
      assert.isTrue(kit.riskDecisions().some((d) => d.name === "lamp_switch" || d.name.includes("lamp")))
    }))

  it.effect("in a Dutch household its Dutch phrase starts it, and the template speaks Dutch", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT], { household: { home: { HOME_LANGUAGE: "nl-NL" } }, goodMorning: true })
      assert.isTrue((yield* kit.phrases.say("goedenacht", { device: "robins-phone" })).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => [s.action, s.turn?.person?.id]), [["lamp.switch", "p-robin"]])
      // The English phrase is not one of the household's language.
      assert.deepStrictEqual(yield* kit.phrases.say("good night", { device: "robins-phone" }), { taken: false })
      assert.isTrue((yield* kit.phrases.say("Goedemorgen!", { device: "robins-phone" })).taken)
      yield* kit.advance(20_000)
      assert.deepStrictEqual(spoken(kit).slice(2).map(([, t]) => t), ["Goedemorgen!", "It's ten o'clock.", "Dry, 8 degrees."])
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

describe("routines: refused as a whole before anything runs", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a step the risk policy refuses (security)", { call: "door.unlock" }, "I can't run Check: step 2 is something this assistant can't do here."],
    ["a step whose class depends on its values", { call: "door.move", params: { to: "closed" } }, "I can't run Check: whether step 2 is allowed depends on its values, which I can't check before it runs."],
    ["a step that needs a confirmation", { call: "door.order" }, "I can't run Check: step 2 needs a confirmation I can't ask for yet."],
    ["a step whose values don't fit", { call: "lamp.switch", params: { to: 3 } }, "I can't run Check: the values in step 2 don't fit that action."],
    ["a step missing a required value", { call: "lamp.switch" }, "I can't run Check: the values in step 2 don't fit that action."],
    ["a step naming an action that is not there", { call: "nowhere.thing" }, "I can't run Check: step 2 is something this assistant can't do here."]
  ]
  for (const [what, step, sentence] of cases) {
    it.effect(what, () =>
      Effect.gen(function*() {
        const seen: Array<Seen> = []
        const kit = yield* start(seen, [routine("Check", [{ say: "First." }, step, { call: "lamp.switch", params: { to: "on" } }], ["run the check"])])
        const said = yield* kit.phrases.say("run the check")
        assert.isTrue(said.taken)
        assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [sentence])
        yield* kit.advance(10_000)
        // Nothing ran: no announcement, no call.
        assert.deepStrictEqual(spoken(kit), [])
        assert.deepStrictEqual(seen, [])
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

  it.effect("the policy as saved now: a `change` step refused after the save is refused at the next start", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Quiet", [{ call: "lamp.quiet" }], ["lights out"])])
      // Refusing `change` refuses the routine's own command too (it speaks and changes things): the gateway says so.
      kit.setRiskPolicy({ change: "deny" })
      const said = yield* kit.phrases.say("lights out")
      assert.isTrue(said.taken)
      assert.strictEqual(said.taken && said.outcome.did, "refused")
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
    }))
})

describe("routines: while it runs", () => {
  it.effect("a policy change during the run refuses the next step on its own, and the run stops there", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      yield* kit.advance(500)
      kit.setRiskPolicy({ change: "deny" })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["Sleep well.", "Good night stopped at step 2: that isn't allowed here any more, so I left out the rest."])
      assert.isTrue(kit.riskDecisions().some((d) => d.outcome === "deny" && d.moduleId === "lamp"))
    }))

  it.effect("a `say` step is checked on its own too: once the routine is no longer allowed here, it is not said", () =>
    Effect.gen(function*() {
      const kit = yield* start([], [routine("Twice", [{ say: "One." }, { say: "Two." }], ["say it twice"])])
      assert.isTrue((yield* kit.phrases.say("say it twice")).taken)
      yield* kit.advance(500)
      kit.setRiskPolicy({ change: "deny" })
      yield* kit.advance(10_000)
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["One.", "Twice stopped at step 2: that isn't allowed here any more, so I left out the rest."])
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

  it.effect("a failed step: the rest runs, and the end says which step it could not confirm", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Tidy", [{ call: "flaky.fail" }, { call: "lamp.quiet" }], ["tidy up"])])
      assert.isTrue((yield* kit.phrases.say("tidy up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.fail", "lamp.quiet"])
      // Another module's failure sentence is not repeated; the step is named by its number.
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["Tidy is done, but I couldn't confirm step 1."])
    }))

  it.effect("stop_if_failed after a failed step leaves out the rest, and says so", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Tidy", [{ call: "flaky.fail" }, { stop_if_failed: true }, { call: "lamp.quiet" }, { say: "All tidy." }], ["tidy up"])])
      assert.isTrue((yield* kit.phrases.say("tidy up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen.map((s) => s.action), ["flaky.fail"])
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["Tidy stopped: I couldn't confirm step 1, so I left out the rest."])
    }))

  it.effect("stop_if_failed after a step that worked goes on", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Tidy", [{ call: "lamp.quiet" }, { stop_if_failed: true }, { say: "All tidy." }], ["tidy up"])])
      assert.isTrue((yield* kit.phrases.say("tidy up")).taken)
      yield* kit.advance(10_000)
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["All tidy."])
    }))

  it.effect("an answer that may be personal is not read out by a routine; the household's is", () =>
    Effect.gen(function*() {
      for (const [language, line] of [["en-GB", "I don't read out the answer to step 1 in a routine: it may be personal."], ["nl-NL", "Het antwoord op stap 1 lees ik in een routine niet voor: het kan persoonlijk zijn."]] as const) {
        const seen: Array<Seen> = []
        const kit = yield* start(seen, [routine("Day", [{ call: "lamp.diary" }, { call: "lamp.agenda" }, { call: "lamp.switch", params: { to: "on" } }], ["my day"], ["mijn dag"])], {
          household: { home: { HOME_LANGUAGE: language } }
        })
        assert.isTrue((yield* kit.phrases.say(language === "en-GB" ? "my day" : "mijn dag", { device: "robins-phone" })).taken)
        yield* kit.advance(20_000)
        assert.deepStrictEqual(seen.map((s) => s.action), ["lamp.diary", "lamp.agenda", "lamp.switch"])
        // A personal answer and one decided per answer are both kept back: the run has no owner to ask about.
        assert.deepStrictEqual(spoken(kit).map(([, t]) => t), [line, line.replace("1", "2"), "The lamp is on."])
      }
    }))

  it.effect("a routine that says nothing on its way ends with one line, in both languages", () =>
    Effect.gen(function*() {
      for (const [language, line] of [["en-GB", "Dim is done."], ["nl-NL", "Dim is klaar."]] as const) {
        const seen: Array<Seen> = []
        const kit = yield* start(seen, [routine("Dim", [{ call: "lamp.quiet" }], ["dim it"], ["dimmen"])], { household: { home: { HOME_LANGUAGE: language } } })
        assert.isTrue((yield* kit.phrases.say(language === "en-GB" ? "dim it" : "dimmen")).taken)
        yield* kit.advance(10_000)
        assert.deepStrictEqual(spoken(kit).map(([, t]) => t), [line])
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
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["Wait is done, but I couldn't confirm step 1."])
    }))

  it.effect("the person's stop on the device ends the routine: the rest is not done and nothing more is said", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [GOOD_NIGHT])
      assert.isTrue((yield* kit.phrases.say("good night")).taken)
      yield* kit.advance(500)
      assert.isTrue(yield* kit.notify.engine.stopSpeech("kitchen-display"))
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["Sleep well."])
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
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), [
        "Here we go.",
        "Slowly was cut short when the routines module restarted, during step 2, which may or may not have been done."
      ])
      // Nothing is left running: a new start runs it from the beginning.
      assert.isTrue((yield* kit.phrases.say("go slowly")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), [])
    }))

  it.effect("between steps: told how far it got, in Dutch", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [routine("Langzaam", [{ say: "Daar gaan we." }, { call: "lamp.quiet" }], [], ["langzaam aan"])], { household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      assert.isTrue((yield* kit.phrases.say("langzaam aan")).taken)
      yield* kit.advance(500)
      yield* kit.restart
      yield* kit.advance(10_000)
      assert.deepStrictEqual(seen, [])
      assert.strictEqual(spoken(kit).at(-1)?.[1], "Langzaam is afgebroken doordat de routinemodule opnieuw startte; 0 van de 2 stappen waren klaar.")
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
      // Its phrase is not in the assistant's set any more: it goes on to the assistant.
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
      // The runner itself, with no turn: refused before it looks at anything.
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
          { name: "Good morning", phrases: ["good morning"], steps: 3 }
        ]
      })
      const empty = yield* start([], [])
      assert.deepStrictEqual((yield* empty.tool("routines_list", {})).value, { spoken: "There are no routines yet." })
      assert.deepStrictEqual((yield* empty.tool("routines_run", { name: "anything" })).value, { spoken: "There are no routines yet." })
    }))
})

describe("routines: the Good morning template", () => {
  it.effect("switched on, its phrase greets, tells the time and the weather on the device that asked", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [], { goodMorning: true })
      assert.isTrue((yield* kit.phrases.say("Good morning", { device: "kitchen-display" })).taken)
      yield* kit.advance(20_000)
      assert.deepStrictEqual(spoken(kit).map(([, t]) => t), ["Good morning!", "It's ten o'clock.", "Dry, 8 degrees."])
      assert.deepStrictEqual(seen.map((s) => s.action), ["clock.time_now", "weather.today"])
    }))

  it.effect("off by default; left out when a routine of the owner's has its phrase", () =>
    Effect.gen(function*() {
      const off = yield* start([], [])
      assert.deepStrictEqual(yield* off.phrases.say("good morning"), { taken: false })
      const mine = yield* start([], [routine("Morning", [{ say: "Up you get." }], ["good morning"])], { goodMorning: true })
      assert.isTrue((yield* mine.phrases.say("good morning")).taken)
      yield* mine.advance(10_000)
      assert.deepStrictEqual(spoken(mine).map(([, t]) => t), ["Up you get."])
      assert.deepStrictEqual(((yield* mine.tool("routines_list", {})).value as { count: number }).count, 1)
    }))

  it.effect("refused as a whole when the weather is not on for the assistant", () =>
    Effect.gen(function*() {
      const seen: Array<Seen> = []
      const kit = yield* start(seen, [], { goodMorning: true, household: { assistants: [{ id: "jeff", modules: { weather: false } }] } })
      assert.isTrue((yield* kit.phrases.say("good morning")).taken)
      assert.deepStrictEqual(kit.phrases.spoken.map((s) => s.text), ["I can't run Good morning: step 3 is something this assistant can't do here."])
      yield* kit.advance(10_000)
      assert.deepStrictEqual([spoken(kit), seen], [[], []])
    }))
})
