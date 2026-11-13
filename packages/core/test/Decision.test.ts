import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { defineAction, Param, type ParamOption, registerActions } from "../src/Actions.ts"
import { parseValues } from "../src/ValueParsing.ts"
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
      none: "None of these: the utterance names something else, or nothing",
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
    expect(dim.params.get("demo-home.set_brightness")?.get("level")).toMatchObject({ kind: "fixed", value: 40, label: "40" })
    const two = buildDecisionPlan({ utterance: "Set light 2 to 40", actions, parse: digits })
    expect(two.request.questions["demo-home.set_brightness/level"]).toMatchObject({
      type: "choice",
      options: { c0: "2", c1: "40", none: "None of these" }
    })
    expect(buildDecisionPlan({ utterance: "Set it to 140", actions, parse: digits }).params.get("demo-home.set_brightness")?.get("level"))
      .toMatchObject({ kind: "missing", invalid: "140" }) // out of range: asked for again
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

describe("a number out of range is never replaced by another number (review finding 6)", () => {
  const brightnessIs = (choice: string, utterance: string, pending?: Parameters<typeof buildDecisionPlan>[0]["pending"]) => {
    const plan = buildDecisionPlan({ utterance, actions, parse: parseValues, pending })
    const options = Object.keys((plan.request.questions["demo-home.set_brightness/level"] as { options?: Record<string, unknown> } | undefined)?.options ?? {})
    const answers: Record<string, DecisionAnswer> = {
      [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.95, "demo-home.lights_on": 0.05 }),
      [Q.fits]: noul(0.95),
      [Q.compound]: noul(0.02),
      "demo-home.set_brightness/target": choiceAnswer({ "area:kitchen": 0.95, "area:living_room": 0.05 }),
      ...(options.length > 0 ? { "demo-home.set_brightness/level": choiceAnswer(Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)]))) } : {})
    }
    return { plan, outcome: interpretDecision(plan, { answers }) }
  }

  it("dim the kitchen to 140 percent: the decider picks 140, which is asked for again", () => {
    const { outcome } = brightnessIs("", "dim the kitchen to 140 percent")
    expect(outcome._tag).toBe("Ask")
    if (outcome._tag !== "Ask") return
    expect(outcome.pending.awaiting).toMatchObject({ kind: "param", param: "level" })
    expect(outcome.question).toBe("I can't use 140 percent. What brightness?")
    expect(outcome.pending.params).not.toHaveProperty("level")
  })
  it("dim 3 lights in kitchen to 140 percent: two numbers, one parameter — the other number is unexplained (round 3)", () => {
    const { plan, outcome } = brightnessIs("c0", "dim 3 lights in kitchen to 140 percent")
    expect(plan.request.questions["demo-home.set_brightness/level"]).toMatchObject({ type: "choice", options: { c0: "140 percent", c1: "3" } })
    expect(outcome).toMatchObject({ _tag: "Fallback", reason: "unexplained" })
  })

  it("the only number said is out of range: asked for, not taken", () => {
    const { outcome } = brightnessIs("", "dim the kitchen to -5 percent")
    expect(outcome._tag).toBe("Ask")
    if (outcome._tag === "Ask") expect(outcome.question).toBe("I can't use -5 percent. What brightness?")
  })

  it("an answer out of range keeps the action pending and asks again", () => {
    const { outcome } = brightnessIs("", "dim the kitchen")
    if (outcome._tag !== "Ask") return assert.fail("expected a question")
    const twice = interpretDecision(
      buildDecisionPlan({ utterance: "140 percent", actions, parse: parseValues, pending: outcome.pending }),
      { answers: { [Q.pendingAnswers]: noul(0.9), [Q.fits]: noul(0.1) } }
    )
    expect(twice).toMatchObject({ _tag: "Ask", question: "I can't use 140 percent. What brightness?" })
    const valid = interpretDecision(
      buildDecisionPlan({ utterance: "40 percent", actions, parse: parseValues, pending: outcome.pending }),
      { answers: { [Q.pendingAnswers]: noul(0.9), [Q.fits]: noul(0.1) } }
    )
    expect(valid).toMatchObject({ _tag: "Act", params: { target: "area:kitchen", level: 40 } })
  })

  it("a valid number among several is not acted on: the other number is unexplained (round 3)", () => {
    const { outcome } = brightnessIs("c0", "dim 3 lights in kitchen to 40 percent")
    expect(outcome).toMatchObject({ _tag: "Fallback", reason: "unexplained" })
  })
})

// ---------------------------------------------------------------------------
// Review round 2. The answers below are scripted: they stand for any provider,
// a hosted one included, that answers too confidently.

describe("a value named but not offered is never replaced (review round 2, finding E)", () => {
  // Rule: "only available" is not "requested". A single value is used only when the utterance
  // names none; a named value that matches no option is asked about, never replaced by the
  // only option, a default, or the best of a bad set.
  const kitchenOnly = [{ value: "area:kitchen", label: "Kitchen" }]
  const single = registerActions("home", [defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room.",
    params: { target: Param.dynamic({ label: "Room or light", options: () => kitchenOnly }) },
    run: () => Effect.void
  })])
  const base = { [Q.action]: choiceAnswer({ "home.lights_on": 0.97 }), [Q.fits]: noul(0.95), [Q.compound]: noul(0.02) }

  it("a single value is offered as a choice with none of these, and a 'does it say which' question", () => {
    const p = buildDecisionPlan({ utterance: "turn on the bedroom lights", actions: single })
    const question = p.request.questions["home.lights_on/target"]
    expect(question?.type === "choice" ? Object.keys(question.options) : []).toEqual(["area:kitchen", "none"])
    expect(p.request.questions["home.lights_on/target?"]).toMatchObject({ type: "noul", role: { kind: "stated" } })
  })
  it("named and not offered: handed on (an unexplained word, round 3), never switched in the kitchen", () => {
    const p = buildDecisionPlan({ utterance: "turn on the bedroom lights", actions: single })
    for (const answer of [choiceAnswer({ "area:kitchen": 0.1, none: 0.9 }), choiceAnswer({ "area:kitchen": 0.5, none: 0.5 }), choiceAnswer({ "area:kitchen": 0.99 })]) {
      const outcome = interpretDecision(p, respond({ ...base, "home.lights_on/target?": noul(0.9), "home.lights_on/target": answer }))
      expect(outcome).toMatchObject({ _tag: "Fallback", reason: "unexplained" })
    }
  })
  it("nothing named: the only value is used", () => {
    const p = buildDecisionPlan({ utterance: "turn on the lights", actions: single })
    expect(interpretDecision(p, respond({ ...base, "home.lights_on/target?": noul(0.1) }))).toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
  })
  it("the only value named: used", () => {
    const p = buildDecisionPlan({ utterance: "turn on the kitchen lights", actions: single })
    expect(interpretDecision(p, respond({ ...base, "home.lights_on/target?": noul(0.9), "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.9, none: 0.1 }) })))
      .toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
  })
  it("several values: 'none of these' is asked about; an optional value named but unknown is asked about, not defaulted", () => {
    const p = buildDecisionPlan({ utterance: "turn on the lights in the bedroom", actions, parse: digits })
    const lightsOnBase = { [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.96 }), [Q.fits]: noul(0.95), [Q.compound]: noul(0.02) }
    expect(interpretDecision(p, respond({ ...lightsOnBase, "demo-home.lights_on/target": choiceAnswer({ "area:kitchen": 0.05, none: 0.95 }) })))
      .toMatchObject({ _tag: "Fallback", reason: "unexplained" })
    const tz = buildDecisionPlan({ utterance: "what time is it in Utrecht", actions, parse: digits })
    expect(interpretDecision(tz, respond({
      [Q.action]: choiceAnswer({ "clock.time_now": 0.96 }),
      [Q.fits]: noul(0.95),
      [Q.compound]: noul(0.02),
      "clock.time_now/zone?": noul(0.9),
      "clock.time_now/zone": choiceAnswer({ "Europe/Amsterdam": 0.1, "Asia/Tokyo": 0.1, none: 0.8 })
    }))).toMatchObject({ _tag: "Ask", question: "Which place?" })
  })
  it("a reply to the question that names something not offered is not taken", () => {
    const p = buildDecisionPlan({ utterance: "turn on the lights", actions: single })
    const asked = interpretDecision(p, respond({ ...base, "home.lights_on/target?": noul(0.9), "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.1, none: 0.9 }) }))
    if (asked._tag !== "Ask") return assert.fail("expected Ask")
    const reply = buildDecisionPlan({ utterance: "the bedroom", actions: single, pending: asked.pending })
    expect(interpretDecision(reply, respond({ [Q.pendingAnswers]: noul(0.95), [Q.pendingAnswer]: choiceAnswer({ "area:kitchen": 0.2, none: 0.8 }) })))
      .toMatchObject({ _tag: "Fallback" })
  })
})

describe("one broken option list does not stop the others (review round 2, finding H)", () => {
  // Rule: a module's option list that fails leaves out only the actions that need it (reported);
  // every list is read once per plan; with nothing left, the result is a normal hand-off.
  let calls = 0
  const broken = Param.dynamic({ label: "Speaker", options: (): ReadonlyArray<ParamOption> => {
    throw new Error("speaker list down")
  } })
  const counted = Param.dynamic({ label: "Room or light", options: () => {
    calls++
    return targets
  } })
  const mixed = [
    ...registerActions("music", [defineAction({ id: "play", label: "Play music", description: "Play music on a speaker.", params: { speaker: broken }, run: () => Effect.void })]),
    ...registerActions("home", [
      defineAction({ id: "lights_on", label: "Turn lights on", description: "Switch on the lights.", params: { target: counted }, run: () => Effect.void }),
      defineAction({ id: "lights_off", label: "Turn lights off", description: "Switch off the lights.", params: { target: counted }, run: () => Effect.void })
    ])
  ]
  it("the other actions are offered and decided; the failure is reported", () => {
    calls = 0
    const p = buildDecisionPlan({ utterance: "turn on the kitchen lights", actions: mixed })
    expect(p.actions.map((a) => a.id)).toEqual(["home.lights_on", "home.lights_off"])
    expect(p.unavailable.map((u) => u.actionId)).toEqual(["music.play"])
    expect(p.warnings.some((w) => /speaker list down/.test(w))).toBe(true)
    expect(calls).toBe(1)
    const outcome = interpretDecision(p, respond({
      [Q.action]: choiceAnswer({ "home.lights_on": 0.95 }),
      [Q.fits]: noul(0.95),
      [Q.compound]: noul(0.02),
      "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.95 })
    }))
    expect(outcome).toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
  })
  it("nothing usable left: no action is offered, and the outcome is a plain hand-off", () => {
    const p = buildDecisionPlan({ utterance: "play some music", actions: mixed.slice(0, 1) })
    expect(p.actions).toEqual([])
    expect(interpretDecision(p, respond({}))).toMatchObject({ _tag: "Fallback", reason: "no_match" })
  })
})

describe("core's safeguard, whatever the provider says (review round 2)", () => {
  const confirmPending = () => {
    const p = buildDecisionPlan({ utterance: "Switch everything off", actions })
    const outcome = interpretDecision(p, respond({ [Q.action]: choiceAnswer({ "demo-home.all_off": 0.9 }), [Q.fits]: noul(0.9), [Q.compound]: noul(0) }))
    if (outcome._tag !== "Confirm") throw new Error("expected Confirm")
    return outcome.pending
  }
  const sureYes = { [Q.pendingAnswers]: noul(0.95), [Q.pendingYes]: noul(0.99) }

  it("a confirmation is accepted only on a bounded affirmative, English and Dutch", () => {
    const pending = confirmPending()
    for (const yes of ["yes", "Yes please.", "go ahead", "that's right", "ja", "ja, doe maar", "prima"]) {
      expect(interpretDecision(buildDecisionPlan({ utterance: yes, actions, pending }), respond(sureYes)), yes).toMatchObject({ _tag: "Act" })
    }
    for (const notYes of ["turn on the kitchen lights please", "yes, but not the bedroom", "doe het licht aan in de keuken graag", "right, what's the weather", "sure, no"]) {
      const outcome = interpretDecision(buildDecisionPlan({ utterance: notYes, actions, pending }), respond(sureYes))
      expect(outcome._tag === "Act" && outcome.action.id === "demo-home.all_off", notYes).toBe(false)
    }
  })
  it("a negated request for an action with side effects is handed on, English and Dutch; a read-only action is not vetoed", () => {
    const lightsOnAnswers = {
      [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.97 }),
      [Q.fits]: noul(0.97),
      [Q.compound]: noul(0.01),
      "demo-home.lights_on/target": choiceAnswer({ "area:kitchen": 0.95 })
    }
    for (const utterance of ["don't turn on the kitchen lights", "do not turn on the kitchen lights", "never turn on the kitchen lights", "doe het licht niet aan in de keuken", "nooit het licht aan in de keuken"]) {
      expect(interpretDecision(buildDecisionPlan({ utterance, actions }), respond(lightsOnAnswers)), utterance).toEqual({ _tag: "Fallback", reason: "negated" })
    }
    // Asking or confirming is also an action of the path: not from a negated sentence.
    expect(interpretDecision(buildDecisionPlan({ utterance: "don't switch everything off", actions }), respond({ [Q.action]: choiceAnswer({ "demo-home.all_off": 0.9 }), [Q.fits]: noul(0.9), [Q.compound]: noul(0) })))
      .toEqual({ _tag: "Fallback", reason: "negated" })
    expect(interpretDecision(buildDecisionPlan({ utterance: "isn't it time yet", actions }), respond({ [Q.action]: choiceAnswer({ "clock.time_now": 0.9 }), [Q.fits]: noul(0.9), [Q.compound]: noul(0), "clock.time_now/zone?": noul(0.1) })))
      .toMatchObject({ _tag: "Act" })
    expect(interpretDecision(buildDecisionPlan({ utterance: "turn on the kitchen lights", actions }), respond(lightsOnAnswers))).toMatchObject({ _tag: "Act" })
  })
  it("a negated answer to a pending question is handed on", () => {
    const vague = buildDecisionPlan({ utterance: "Turn on the lights", actions })
    const asked = interpretDecision(vague, respond({ [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.97 }), [Q.fits]: noul(0.97), [Q.compound]: noul(0), "demo-home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, all: 0.5 }) }))
    if (asked._tag !== "Ask") return assert.fail("expected Ask")
    for (const utterance of ["not the kitchen", "niet de keuken"]) {
      const reply = buildDecisionPlan({ utterance, actions, pending: asked.pending })
      expect(interpretDecision(reply, respond({ [Q.pendingAnswers]: noul(0.95), [Q.pendingAnswer]: choiceAnswer({ "area:kitchen": 0.95 }) })), utterance)
        .toEqual({ _tag: "Fallback", reason: "negated" })
    }
  })
})

describe("a reply that is a command of its own is planned afresh (review round 2, finding A, core's part)", () => {
  // Rule: while a question is pending, an utterance that confidently asks for another action,
  // or for the same action with another value for something already decided, is a new request
  // with all its parameters; terse answers still answer.
  const askRoom = () => {
    const vague = buildDecisionPlan({ utterance: "turn on the lights", actions, parse: digits })
    const asked = interpretDecision(vague, respond({ [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.97 }), [Q.fits]: noul(0.97), [Q.compound]: noul(0), "demo-home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, all: 0.5 }) }))
    if (asked._tag !== "Ask") throw new Error("expected Ask")
    return asked.pending
  }
  const askLevel = () => {
    const p = buildDecisionPlan({ utterance: "dim the kitchen to 140 percent", actions, parse: digits })
    const asked = interpretDecision(p, respond({ [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.97 }), [Q.fits]: noul(0.97), [Q.compound]: noul(0), "demo-home.set_brightness/target": choiceAnswer({ "area:kitchen": 0.95 }) }))
    if (asked._tag !== "Ask") throw new Error("expected Ask")
    return asked.pending
  }
  it("'turn off the kitchen lights please' after 'Which room or light?' switches off, even if the provider calls it an answer", () => {
    const reply = buildDecisionPlan({ utterance: "turn off the kitchen lights please", actions, pending: askRoom(), parse: digits })
    const outcome = interpretDecision(reply, respond({
      [Q.pendingAnswers]: noul(0.9),
      [Q.pendingAnswer]: choiceAnswer({ "area:kitchen": 0.95 }),
      [Q.action]: choiceAnswer({ "demo-home.lights_off": 0.95 }),
      [Q.fits]: noul(0.95),
      [Q.compound]: noul(0.02),
      "demo-home.lights_off/target": choiceAnswer({ "area:kitchen": 0.95 })
    }))
    expect(outcome).toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
    if (outcome._tag === "Act") expect(outcome.action.id).toBe("demo-home.lights_off")
  })
  it("'dim bedroom 40' after 'What brightness?' (for the kitchen) dims the bedroom", () => {
    const reply = buildDecisionPlan({ utterance: "dim the living room 40", actions, pending: askLevel(), parse: digits })
    const outcome = interpretDecision(reply, respond({
      [Q.pendingAnswers]: noul(0.9),
      [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.95 }),
      [Q.fits]: noul(0.95),
      [Q.compound]: noul(0.02),
      "demo-home.set_brightness/target": choiceAnswer({ "area:living_room": 0.95 })
    }))
    expect(outcome).toMatchObject({ _tag: "Act", params: { target: "area:living_room", level: 40 } })
  })
  it("terse answers still answer", () => {
    const room = buildDecisionPlan({ utterance: "the kitchen", actions, pending: askRoom(), parse: digits })
    expect(interpretDecision(room, respond({ [Q.pendingAnswers]: noul(0.95), [Q.pendingAnswer]: choiceAnswer({ "area:kitchen": 0.95 }), [Q.fits]: noul(0.2) })))
      .toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
    const level = buildDecisionPlan({ utterance: "40 percent", actions, pending: askLevel(), parse: digits })
    expect(interpretDecision(level, respond({ [Q.pendingAnswers]: noul(0.95), [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.9 }), [Q.fits]: noul(0.9), [Q.compound]: noul(0) })))
      .toMatchObject({ _tag: "Act", params: { target: "area:kitchen", level: 40 } })
    // The same action again, nothing contradicted: still the answer.
    const same = buildDecisionPlan({ utterance: "turn on the kitchen lights", actions, pending: askRoom(), parse: digits })
    expect(interpretDecision(same, respond({ [Q.pendingAnswers]: noul(0.95), [Q.pendingAnswer]: choiceAnswer({ "area:kitchen": 0.95 }), [Q.action]: choiceAnswer({ "demo-home.lights_on": 0.95 }), [Q.fits]: noul(0.95), [Q.compound]: noul(0) })))
      .toMatchObject({ _tag: "Act", params: { target: "area:kitchen" } })
  })
})

describe("a reply that changes a value already decided is not the answer (review round 2, finding A, core's part)", () => {
  it("'the living room, 40' after 'What brightness?' for the kitchen: not the kitchen, even when the provider is unsure it is a command", () => {
    const p = buildDecisionPlan({ utterance: "dim the kitchen to 140 percent", actions, parse: digits })
    const asked = interpretDecision(p, respond({ [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.97 }), [Q.fits]: noul(0.97), [Q.compound]: noul(0), "demo-home.set_brightness/target": choiceAnswer({ "area:kitchen": 0.95 }) }))
    if (asked._tag !== "Ask") return assert.fail("expected Ask")
    const reply = buildDecisionPlan({ utterance: "living room 40", actions, pending: asked.pending, parse: digits })
    const outcome = interpretDecision(reply, respond({
      [Q.pendingAnswers]: noul(0.95),
      [Q.action]: choiceAnswer({ "demo-home.set_brightness": 0.6 }),
      [Q.fits]: noul(0.4),
      [Q.compound]: noul(0),
      "demo-home.set_brightness/target": choiceAnswer({ "area:living_room": 0.9 })
    }))
    expect(outcome._tag === "Act" && outcome.params["target"] === "area:kitchen").toBe(false)
  })
})
