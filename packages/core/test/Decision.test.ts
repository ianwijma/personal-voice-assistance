import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { defineAction, Param, type ParamOption, registerActions } from "../src/Actions.ts"
import {
  buildDecisionPlan,
  choiceAnswer,
  type DecisionAnswer,
  DecisionError,
  type DecisionResponse,
  extractText,
  interpretDecision,
  makeScriptedDecider,
  Q,
  type ValueParser
} from "../src/Decision.ts"

// The demonstration home: rooms and lights the module knows at run time.
const targets: Array<ParamOption> = [
  { value: "area:living_room", label: "Living room", aliases: ["lounge", "woonkamer"] },
  { value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] },
  { value: "light:desk_lamp", label: "Desk lamp" },
  { value: "all", label: "All lights", aliases: ["everywhere", "the whole house"] }
]
const ran: Array<unknown> = []
const target = Param.dynamic({ label: "Room or light", options: () => targets })

const lightsOn = defineAction({
  id: "lights_on",
  label: "Turn lights on",
  description: "Switch on the lights in a room, one light, or every light. Not for dimming: that is set_brightness.",
  examples: ["turn on the kitchen lights", "doe het licht aan in de woonkamer"],
  params: { target },
  announce: (p) => `${targets.find((t) => t.value === p.target)?.label} on.`,
  run: (p) => Effect.sync(() => void ran.push(["on", p.target]))
})
const lightsOff = defineAction({
  id: "lights_off",
  label: "Turn lights off",
  description: "Switch off the lights in a room, one light, or every light.",
  params: { target },
  run: () => Effect.void
})
const setBrightness = defineAction({
  id: "set_brightness",
  label: "Set brightness",
  description: "Dim or brighten lights to a percentage.",
  params: { target, level: Param.number({ label: "Brightness", min: 0, max: 100, unit: "percent" }) },
  run: () => Effect.void
})
const allOff = defineAction({
  id: "all_off",
  label: "Switch everything off",
  description: "Switch off every light and device in the house.",
  params: {},
  confirm: true,
  run: () => Effect.void
})
const weatherToday = defineAction({
  id: "today",
  label: "Today's weather",
  description: "The weather now and today's forecast.",
  params: { place: Param.text({ label: "Place", after: ["in", "for"], optional: true, maxWords: 3 }) },
  speculative: true,
  offerAsTool: false,
  run: (p) => Effect.succeed({ say: `Sunny in ${p.place ?? "Amsterdam"}.` })
})
const timeNow = defineAction({
  id: "time_now",
  label: "Tell the time",
  description: "The current local time.",
  params: { zone: Param.choice({ label: "Place", options: [{ value: "Europe/Amsterdam", label: "Amsterdam" }, { value: "Asia/Tokyo", label: "Tokyo" }], optional: true }) },
  speculative: true,
  run: () => Effect.succeed({ say: "It's 14:32." })
})

const actions = [
  ...registerActions("demo-home", [lightsOn, lightsOff, setBrightness, allOff]),
  ...registerActions("weather", [weatherToday]),
  ...registerActions("clock", [timeNow])
]

/** A tiny parser: digits only (the real English + Dutch one is build plan piece C). */
const digits: ValueParser = (kind, text) =>
  kind === "number" ? [...text.matchAll(/\d+/g)].map((m) => ({ text: m[0], value: Number(m[0]) })) : []

const noul = (value: number): DecisionAnswer => ({ type: "noul", value })
const respond = (answers: Record<string, DecisionAnswer>): DecisionResponse => ({ answers })

describe("buildDecisionPlan", () => {
  const plan = buildDecisionPlan({ utterance: "Turn on the lights in the living room.", actions, parse: digits })
  const q = plan.request.questions

  it("asks which action, whether any fits, and whether several are meant", () => {
    expect(q[Q.action]).toMatchObject({ type: "choice" })
    const actionQuestion = q[Q.action]
    const options = actionQuestion?.type === "choice" ? actionQuestion.options : {}
    expect(Object.keys(options)).toEqual([
      "demo-home.lights_on",
      "demo-home.lights_off",
      "demo-home.set_brightness",
      "demo-home.all_off",
      "weather.today",
      "clock.time_now"
    ])
    expect(options["demo-home.lights_on"]).toBe(
      "Turn lights on. Switch on the lights in a room, one light, or every light. Not for dimming: that is set_brightness. " +
        "For example: \"turn on the kitchen lights\"; \"doe het licht aan in de woonkamer\"."
    )
    expect(q[Q.fits]).toMatchObject({ type: "noul", instructions: "Does the utterance ask the assistant to do one of the available_actions?" })
    expect(q[Q.compound]).toMatchObject({ type: "noul" })
    expect(plan.request.state).toEqual({
      utterance: "Turn on the lights in the living room.",
      available_actions: {
        "demo-home.lights_on": "Turn lights on",
        "demo-home.lights_off": "Turn lights off",
        "demo-home.set_brightness": "Set brightness",
        "demo-home.all_off": "Switch everything off",
        "weather.today": "Today's weather",
        "clock.time_now": "Tell the time"
      }
    })
  })

  it("asks every choice parameter of every action in the same request, with aliases", () => {
    expect(q["demo-home.lights_on/target"]).toEqual({
      type: "choice",
      instructions: "Which room or light does the utterance refer to?",
      options: {
        "area:living_room": "Living room (also called: lounge, woonkamer)",
        "area:kitchen": "Kitchen (also called: keuken)",
        "light:desk_lamp": "Desk lamp",
        all: "All lights (also called: everywhere, the whole house)"
      },
      role: { kind: "param", action: "demo-home.lights_on", param: "target" }
    })
    expect(q["demo-home.lights_off/target"]).toBeDefined()
    // an optional choice also gets "does it say which?"
    expect(q["clock.time_now/zone"]).toMatchObject({ type: "choice" })
    expect(q["clock.time_now/zone?"]).toMatchObject({ type: "noul", role: { kind: "stated" } })
  })

  it("fills numbers and text locally and asks nothing about them when unambiguous", () => {
    expect(q["demo-home.set_brightness/level"]).toBeUndefined() // no number in the sentence: missing
    expect(q["weather.today/place"]).toBeUndefined() // text is never asked
    const dim = buildDecisionPlan({ utterance: "Dim the kitchen to 40 percent", actions, parse: digits })
    expect(dim.params.get("demo-home.set_brightness")?.get("level")).toEqual({ kind: "fixed", value: 40, label: "40" })
    const two = buildDecisionPlan({ utterance: "Set light 2 to 40", actions, parse: digits })
    expect(two.request.questions["demo-home.set_brightness/level"]).toMatchObject({
      type: "choice",
      options: { c0: "2", c1: "40", none: "None of these" }
    })
    expect(buildDecisionPlan({ utterance: "Set it to 140", actions, parse: digits }).params.get("demo-home.set_brightness")?.get("level"))
      .toEqual({ kind: "missing" }) // out of range
  })

  it("has no questions when no module offers an action", () => {
    expect(buildDecisionPlan({ utterance: "lights on", actions: [] }).request.questions).toEqual({})
  })

  it("caps the action list at 255 with a warning", () => {
    const many = Array.from({ length: 300 }, (_, i) => defineAction({ id: `a${i}`, label: `A${i}`, description: "x", params: {}, run: () => Effect.void }))
    const big = buildDecisionPlan({ utterance: "x", actions: registerActions("big", many) })
    expect(big.actions).toHaveLength(255)
    expect(big.warnings).toEqual(["300 actions are enabled; only the first 255 are offered"])
  })
})

describe("interpretDecision", () => {
  const utterance = "Turn on the lights in the living room."
  const plan = buildDecisionPlan({ utterance, actions, parse: digits })
  const confident = {
    [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.96, "demo-home.lights_off": 0.02, "demo-home.set_brightness": 0.02 }),
    [Q.fits]: noul(0.98),
    [Q.compound]: noul(0.03),
    "demo-home.lights_on/target": choiceAnswer({ "area:living_room": 0.93, "area:kitchen": 0.04, "light:desk_lamp": 0.01, all: 0.02 }),
    "demo-home.lights_off/target": choiceAnswer({ "area:living_room": 0.9, "area:kitchen": 0.1 })
  }

  it("acts on the lights example", () => {
    const outcome = interpretDecision(plan, respond(confident))
    assert.strictEqual(outcome._tag, "Act")
    if (outcome._tag !== "Act") return
    expect(outcome.action.id).toBe("demo-home.lights_on")
    expect(outcome.params).toEqual({ target: "area:living_room" })
    expect(outcome.details).toEqual([{ name: "target", label: "Room or light", value: "Living room", probability: 0.93 }])
    expect(outcome.probability).toBe(0.93) // the least certain judgement
    expect(outcome.action.definition.announce?.(outcome.params as never)).toBe("Living room on.")
  })

  it("passes on what is not a command, or not surely one, or several at once", () => {
    expect(interpretDecision(plan, respond({ ...confident, [Q.fits]: noul(0.1) }))).toMatchObject({ _tag: "Fallback", reason: "no_match" })
    expect(interpretDecision(plan, respond({ ...confident, [Q.fits]: noul(0.5) }))).toMatchObject({ _tag: "Fallback", reason: "uncertain" })
    expect(interpretDecision(plan, respond({ ...confident, [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.55, "demo-home.lights_off": 0.45 }) })))
      .toMatchObject({ _tag: "Fallback", reason: "uncertain" })
    expect(interpretDecision(plan, respond({ ...confident, [Q.compound]: noul(0.8) }))).toMatchObject({ _tag: "Fallback", reason: "compound" })
    expect(interpretDecision(plan, respond({}))).toMatchObject({ _tag: "Fallback", reason: "no_match" }) // nothing answered
  })

  it("asks for an unclear room, then completes with the answer", () => {
    const vague = buildDecisionPlan({ utterance: "Turn on the lights", actions, parse: digits })
    const asked = interpretDecision(vague, respond({
      ...confident,
      "demo-home.lights_on/target": choiceAnswer({ "area:living_room": 0.3, "area:kitchen": 0.3, "light:desk_lamp": 0.1, all: 0.3 })
    }))
    assert.strictEqual(asked._tag, "Ask")
    if (asked._tag !== "Ask") return
    expect(asked.question).toBe("Which room or light?")
    expect(asked.pending.awaiting).toEqual({ kind: "param", param: "target", question: "Which room or light?" })

    const reply = buildDecisionPlan({ utterance: "The kitchen", actions, pending: asked.pending, parse: digits })
    expect(reply.request.state.question_asked).toBe("Which room or light?")
    expect(reply.request.questions[Q.pendingAnswer]).toMatchObject({ type: "choice" })
    expect(reply.request.questions[Q.pendingAnswers]).toMatchObject({ type: "noul", role: { kind: "answers" } })
    const done = interpretDecision(reply, respond({
      [Q.pendingAnswers]: noul(0.95),
      [Q.pendingAnswer]: choiceAnswer({ "area:living_room": 0.02, "area:kitchen": 0.95, "light:desk_lamp": 0.01, all: 0.02 })
    }))
    expect(done).toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
  })

  it("treats a reply that does not answer the question as a new request", () => {
    const vague = buildDecisionPlan({ utterance: "Turn on the lights", actions })
    const asked = interpretDecision(vague, respond({ ...confident, "demo-home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, all: 0.5 }) }))
    if (asked._tag !== "Ask") return assert.fail("expected Ask")
    const other = buildDecisionPlan({ utterance: "What time is it?", actions, pending: asked.pending })
    const outcome = interpretDecision(other, respond({
      [Q.pendingAnswers]: noul(0.05),
      [Q.action]: choiceAnswer({ "clock.time_now": 0.97 }),
      [Q.fits]: noul(0.95),
      [Q.compound]: noul(0.01),
      "clock.time_now/zone?": noul(0.1)
    }))
    expect(outcome).toMatchObject({ _tag: "Act", params: { zone: undefined } })
    if (outcome._tag === "Act") expect(outcome.action.id).toBe("clock.time_now")
  })

  it("asks for a yes before a confirm action, and cancels on anything else", () => {
    const p = buildDecisionPlan({ utterance: "Switch everything off", actions })
    const outcome = interpretDecision(p, respond({ [Q.action]: choiceAnswer({ "demo-home.all_off": 0.9 }), [Q.fits]: noul(0.9), [Q.compound]: noul(0) }))
    if (outcome._tag !== "Confirm") return assert.fail("expected Confirm")
    expect(outcome.question).toBe("Switch everything off?")
    const yes = buildDecisionPlan({ utterance: "Yes please", actions, pending: outcome.pending })
    expect(interpretDecision(yes, respond({ [Q.pendingAnswers]: noul(0.9), [Q.pendingYes]: noul(0.95) }))).toMatchObject({ _tag: "Act", params: {} })
    expect(interpretDecision(yes, respond({ [Q.pendingAnswers]: noul(0.9), [Q.pendingYes]: noul(0.4) }))).toMatchObject({ _tag: "Cancelled" })
  })

  it("uses defaults for unstated optional values and text taken from the sentence", () => {
    const p = buildDecisionPlan({ utterance: "What's the weather in Paris?", actions })
    const outcome = interpretDecision(p, respond({ [Q.action]: choiceAnswer({ "weather.today": 0.95 }), [Q.fits]: noul(0.95), [Q.compound]: noul(0) }))
    expect(outcome).toMatchObject({ _tag: "Act", params: { place: "Paris" } })
    const home = buildDecisionPlan({ utterance: "What's the weather like?", actions })
    expect(interpretDecision(home, respond({ [Q.action]: choiceAnswer({ "weather.today": 0.95 }), [Q.fits]: noul(0.95), [Q.compound]: noul(0) })))
      .toMatchObject({ _tag: "Act", params: { place: undefined } })
  })

  it("asks for a required number that was not said", () => {
    const p = buildDecisionPlan({ utterance: "Dim the kitchen", actions, parse: digits })
    const outcome = interpretDecision(p, respond({
      [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.9 }),
      [Q.fits]: noul(0.9),
      [Q.compound]: noul(0),
      "demo-home.set_brightness/target": choiceAnswer({ "area:kitchen": 0.9, all: 0.1 })
    }))
    expect(outcome).toMatchObject({ _tag: "Ask", question: "What brightness?" })
  })
})

describe("extractText", () => {
  it("takes the words after the first marker", () => {
    expect(extractText("What's the weather in Paris, France?", ["in", "for"])).toBe("Paris, France")
    expect(extractText("Remind me to call mum", ["to"], 8)).toBe("call mum")
    expect(extractText("What's the weather?", ["in"])).toBeUndefined()
    expect(extractText("call mum", [])).toBe("call mum")
  })
})

describe("makeScriptedDecider", () => {
  it.effect("answers from a function and records the requests", () =>
    Effect.gen(function*() {
      const decider = makeScriptedDecider(() => respond({ [Q.fits]: noul(0.2) }))
      const plan = buildDecisionPlan({ utterance: "hello", actions })
      const response = yield* decider.decide(plan.request)
      expect(interpretDecision(plan, response)).toMatchObject({ _tag: "Fallback", reason: "no_match" })
      expect(decider.requests).toHaveLength(1)
      const failing = makeScriptedDecider(() => new DecisionError({ message: "no key", reason: "unavailable" }))
      const exit = yield* Effect.exit(failing.decide(plan.request))
      assert.isTrue(Exit.isFailure(exit))
    }))
})
