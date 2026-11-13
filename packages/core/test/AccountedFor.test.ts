// Review round 3: "Act only on what is fully accounted for" (docs/AGENTS-AND-INTENTS.md,
// "Review fixes, third round"). Every test here drives core with a scripted decision provider
// that answers too confidently, often wrongly: core's rule must hold whatever it says.
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { defineAction, Param, type ParamOption, registerActions } from "../src/Actions.ts"
import {
  buildDecisionPlan,
  choiceAnswer,
  type DecisionAnswer,
  type DecisionPlan,
  type DecisionRequest,
  type DecisionResponse,
  type IntentOutcome,
  interpretDecision,
  type PendingIntent,
  Q
} from "../src/Decision.ts"
import { isConfirmation, isNegated, replyWords } from "../src/IntentWords.ts"
import { parseValues } from "../src/ValueParsing.ts"

const rooms: Array<ParamOption> = [
  { value: "area:living_room", label: "Living room", aliases: ["lounge", "woonkamer"] },
  { value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] },
  { value: "area:bedroom", label: "Bedroom", aliases: ["slaapkamer"] },
  { value: "light:desk_lamp", label: "Desk lamp", aliases: ["bureaulamp"] },
  { value: "all", label: "All lights", aliases: ["every light", "everything", "alle lampen", "alles"] }
]
let reads = 0
const target = Param.dynamic({ label: "Room or light", options: () => (reads++, rooms) })
const actions = registerActions("home", [
  defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room, one lamp, or every light. Not for dimming: that is set_brightness.",
    examples: ["turn on the kitchen lights", "lights on in the bedroom", "switch on the desk lamp", "doe het licht aan in de woonkamer"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "lights_off",
    label: "Turn lights off",
    description: "Switch off the lights in a room, one lamp, or every light.",
    examples: ["turn off the kitchen lights", "lights off in the bedroom", "doe het licht uit in de keuken"],
    params: { target },
    run: () => Effect.void
  }),
  defineAction({
    id: "set_brightness",
    label: "Set brightness",
    description: "Dim or brighten the lights in a room or one lamp to a level in percent.",
    examples: ["dim the living room to 40 percent", "set the desk lamp to 70%", "zet de woonkamer op veertig procent"],
    params: { target, level: Param.number({ label: "Brightness", min: 0, max: 100, integer: true, unit: "percent" }) },
    run: () => Effect.void
  }),
  defineAction({
    id: "all_off",
    label: "Switch everything off",
    description: "Switch off every light in the house at once.",
    examples: ["switch everything off", "all off", "alles uit"],
    params: {},
    confirm: true,
    run: () => Effect.void
  }),
  defineAction({
    id: "time_now",
    label: "Tell the time",
    description: "Say what time it is now.",
    examples: ["what time is it", "hoe laat is het"],
    params: {},
    speculative: true,
    run: () => Effect.succeed({ say: "It's 14:32." })
  })
])

const noul = (value: number): DecisionAnswer => ({ type: "noul", value })

/**
 * A provider that is sure of everything: the action named, every value it is told (else the
 * first option), "yes, it fits", "yes, it answers", "yes, it is a yes", "yes, it says which".
 */
const yesMan = (action: string, values: Readonly<Record<string, string>> = {}) => (request: DecisionRequest): DecisionResponse => {
  const answers: Record<string, DecisionAnswer> = {}
  for (const [name, q] of Object.entries(request.questions)) {
    if (q.type === "choice") {
      const ids = Object.keys(q.options)
      const role = q.role
      const wanted = role.kind === "action" ? `home.${action}` : role.kind === "param" ? values[role.param] : undefined
      const pick = wanted !== undefined && ids.includes(wanted) ? wanted : ids.find((id) => id !== "none") ?? ids[0]!
      answers[name] = choiceAnswer(Object.fromEntries(ids.map((id) => [id, id === pick ? 0.99 : 0.01 / ids.length])))
    } else {
      answers[name] = noul(q.role.kind === "compound" ? 0.01 : 0.99)
    }
  }
  return { answers }
}

const decide = (utterance: string, provider: (r: DecisionRequest) => DecisionResponse, pending?: PendingIntent) => {
  const plan = buildDecisionPlan({ utterance, actions, pending, parse: parseValues })
  return interpretDecision(plan, provider(plan.request))
}

const summary = (outcome: IntentOutcome): string => {
  switch (outcome._tag) {
    case "Act":
      return [`Act ${outcome.action.id.slice(5)}`, ...Object.entries(outcome.params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`)].join(" ")
    case "Ask":
    case "Confirm":
      return `${outcome._tag} ${outcome.pending.action.id.slice(5)}`
    case "Cancelled":
      return "Cancelled"
    case "Fallback":
      return `Fallback ${outcome.reason}`
  }
}

/** The pending question "What brightness?" for the kitchen. */
const askLevel = (): PendingIntent => {
  const outcome = decide("dim the kitchen lights", yesMan("set_brightness", { target: "area:kitchen" }))
  if (outcome._tag !== "Ask") throw new Error(`expected Ask, got ${summary(outcome)}`)
  expect(outcome.question).toBe("What brightness?")
  return outcome.pending
}
/** The pending question "Which room or light?" for lights_on. */
const askRoom = (): PendingIntent => {
  const plan = buildDecisionPlan({ utterance: "turn on the lights", actions, parse: parseValues })
  const response = yesMan("lights_on")(plan.request)
  const outcome = interpretDecision(plan, { answers: { ...response.answers, "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.4, "area:bedroom": 0.4, none: 0.2 }) } })
  if (outcome._tag !== "Ask") throw new Error(`expected Ask, got ${summary(outcome)}`)
  return outcome.pending
}
/** The pending confirmation "Switch everything off?". */
const confirmAllOff = (): PendingIntent => {
  const outcome = decide("switch everything off", yesMan("all_off"))
  if (outcome._tag !== "Confirm") throw new Error(`expected Confirm, got ${summary(outcome)}`)
  return outcome.pending
}

describe("the seven findings of review round 3, with a provider that is sure of the wrong answer", () => {
  it("1: 'the attic 40' after 'What brightness?' for the kitchen is not the kitchen at 40", () => {
    const pending = askLevel()
    const outcome = decide("the attic 40", yesMan("set_brightness", { target: "area:kitchen", level: "c0" }), pending)
    assert.notStrictEqual(summary(outcome), "Act set_brightness target=area:kitchen level=40")
    assert.strictEqual(outcome._tag, "Fallback")
    // A pure answer still answers.
    assert.strictEqual(summary(decide("40 percent", yesMan("set_brightness"), askLevel())), "Act set_brightness target=area:kitchen level=40")
  })
  it("2: prohibitions and modal negatives never switch the lights", () => {
    for (const utterance of ["stop turning on the kitchen lights", "wouldn't turn on the kitchen lights", "wouldnt turn on the kitchen lights"]) {
      assert.match(summary(decide(utterance, yesMan("lights_on", { target: "area:kitchen" }))), /^Fallback/, utterance)
    }
  })
  it("3: questions are not confirmations", () => {
    for (const reply of ["is that right?", "is that okay?", "do you?", "is that right", "do you"]) {
      assert.notStrictEqual(summary(decide(reply, yesMan("all_off"), confirmAllOff())), "Act all_off", reply)
    }
  })
  it("4: incomplete numeric phrases are asked for again, never a smaller value", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["dim the kitchen to one hundred 40 percent", "one hundred 40 percent"],
      ["dim the kitchen to one point twenty five percent", "one point twenty five percent"],
      ["dim the kitchen to 1.234,5 percent", "1.234,5 percent"]
    ]
    for (const [utterance, said] of cases) {
      const outcome = decide(utterance, yesMan("set_brightness", { target: "area:kitchen", level: "c0" }))
      assert.strictEqual(outcome._tag === "Ask" ? outcome.question : summary(outcome), `I can't use ${said}. What brightness?`, utterance)
    }
  })
  it("7: a pending target's options are read once per plan, a failing list drops the question, and an excluded action never runs", () => {
    const pending = askRoom()
    reads = 0
    buildDecisionPlan({ utterance: "the kitchen", actions, pending, parse: parseValues })
    assert.strictEqual(reads, 1, "one read per plan, pending answer included")

    // A list that works once and then throws: the plan never reads it twice, so it cannot crash.
    let calls = 0
    const flaky = Param.dynamic({ label: "Room or light", options: () => {
      calls++
      if (calls > 1) throw new Error("second read")
      return rooms
    } })
    const flakyActions = registerActions("flaky", [defineAction({ id: "on", label: "Turn lights on", description: "Switch on the lights.", params: { target: flaky }, run: () => Effect.void })])
    const flakyPending: PendingIntent = { action: flakyActions[0]!, params: {}, missing: ["target"], awaiting: { kind: "param", param: "target", question: "Which room or light?" }, probability: 0.9 }
    const plan = buildDecisionPlan({ utterance: "the kitchen", actions: flakyActions, pending: flakyPending, parse: parseValues })
    assert.strictEqual(calls, 1)
    assert.isDefined(plan.pending)

    // A list that throws: the action is excluded, and its pending question is dropped (never run).
    const broken = Param.dynamic({ label: "Room or light", options: (): ReadonlyArray<ParamOption> => {
      throw new Error("down")
    } })
    const brokenActions = registerActions("broken", [defineAction({ id: "on", label: "Turn lights on", description: "Switch on the lights.", params: { target: broken, level: Param.number({ label: "Brightness" }) }, run: () => Effect.void })])
    const brokenPending: PendingIntent = { action: brokenActions[0]!, params: { target: "area:kitchen" }, missing: ["level"], awaiting: { kind: "param", param: "level", question: "What brightness?" }, probability: 0.9 }
    const p2 = buildDecisionPlan({ utterance: "40", actions: brokenActions, pending: brokenPending, parse: parseValues })
    assert.deepStrictEqual(p2.unavailable.map((u) => u.actionId), ["broken.on"])
    assert.isUndefined(p2.pending)
    assert.notStrictEqual(interpretDecision(p2, yesMan("on")(p2.request))._tag, "Act")
  })
})

// ---------------------------------------------------------------------------
// Mechanism tables. Each row: input → required outcome. "Fallback …" = handed to the
// conversational agent; "Ask …" = a short question; "Act …" = run with these values.

describe("mechanism: numbers in a request (a span is one value or invalid as a whole)", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["dim the kitchen to 40 percent", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to forty percent", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to one hundred percent", "Act set_brightness target=area:kitchen level=100"],
    ["dim the kitchen to 40%", "Act set_brightness target=area:kitchen level=40"],
    ["zet de keuken op veertig procent", "Act set_brightness target=area:kitchen level=40"],
    ["zet de keuken op vijfenveertig procent", "Act set_brightness target=area:kitchen level=45"],
    ["zet de keuken op vijf en twintig procent", "Act set_brightness target=area:kitchen level=25"],
    ["dim the kitchen to one hundred 40 percent", "Ask set_brightness"],
    ["dim the kitchen to one point twenty five percent", "Ask set_brightness"],
    ["dim the kitchen to 1.234,5 percent", "Ask set_brightness"],
    ["dim the kitchen to forty 5 percent", "Ask set_brightness"],
    ["dim the kitchen to 40 5 percent", "Ask set_brightness"],
    ["dim the kitchen to 3-5 percent", "Ask set_brightness"],
    ["dim the kitchen to -five percent", "Ask set_brightness"],
    ["dim the kitchen to minus 40 percent", "Ask set_brightness"],
    ["dim the kitchen to 1,000 percent", "Ask set_brightness"],
    ["dim the kitchen to 21.5 percent", "Ask set_brightness"],
    ["zet de keuken op honderd 40 procent", "Ask set_brightness"],
    ["zet de keuken op min vijf procent", "Ask set_brightness"],
    ["zet de keuken op twee komma vijf procent", "Ask set_brightness"],
    ["dim 3 lights in the kitchen to 40 percent", "Fallback unexplained"],
    ["dim the kitchen to 40 percent in 10 minutes", "Fallback unexplained"],
    ["turn on the kitchen lights 40", "Fallback unexplained"],
    ["dim the kitchen lights", "Ask set_brightness"]
  ]
  for (const [utterance, expected] of rows) {
    it(utterance, () => {
      assert.strictEqual(summary(decide(utterance, yesMan(utterance.includes("turn on") ? "lights_on" : "set_brightness", { target: "area:kitchen", level: "c0" }))), expected)
    })
  }
})

describe("mechanism: a reply to a pending question is an answer only if it is nothing but one", () => {
  // The provider says every reply answers the question and picks the kitchen: core decides.
  const level: ReadonlyArray<readonly [string, string]> = [
    ["40 percent", "Act set_brightness target=area:kitchen level=40"],
    ["40", "Act set_brightness target=area:kitchen level=40"],
    ["forty", "Act set_brightness target=area:kitchen level=40"],
    ["40%", "Act set_brightness target=area:kitchen level=40"],
    ["veertig procent", "Act set_brightness target=area:kitchen level=40"],
    ["make it 40 percent please", "Act set_brightness target=area:kitchen level=40"],
    ["set it to 40", "Act set_brightness target=area:kitchen level=40"],
    ["brightness 40", "Act set_brightness target=area:kitchen level=40"],
    ["the kitchen 40", "Act set_brightness target=area:kitchen level=40"],
    ["dim the kitchen to 40 percent", "Act set_brightness target=area:kitchen level=40"],
    ["op veertig graag", "Act set_brightness target=area:kitchen level=40"],
    ["140 percent", "Ask set_brightness"],
    ["one hundred 40", "Ask set_brightness"],
    // Not purely an answer: planned afresh, so the provider's kitchen is used only if the words say kitchen.
    ["the attic 40", "Fallback unexplained"],
    ["de zolder 40", "Fallback unexplained"],
    ["the bedroom 40", "Fallback unexplained"], // round 4: a fresh request that names no action word
    ["40 and 50", "Ask set_brightness"],
    ["40 in ten minutes", "Fallback unexplained"],
    ["40 percent quickly", "Act set_brightness target=area:kitchen level=40"], // round 4: a trailing manner word
    ["not 40", "Fallback negated"],
    ["niet veertig", "Fallback negated"],
    ["turn off the kitchen lights", "Act set_brightness target=area:kitchen"],
    ["what", "Fallback unexplained"]
  ]
  for (const [reply, expected] of level) {
    it(`What brightness? → ${reply}`, () => {
      const provider = yesMan(reply.includes("turn off") ? "lights_off" : "set_brightness", { target: reply.includes("bedroom") ? "area:bedroom" : "area:kitchen", level: "c0" })
      const got = summary(decide(reply, provider, askLevel()))
      if (reply === "turn off the kitchen lights") assert.strictEqual(got, "Act lights_off target=area:kitchen")
      else assert.strictEqual(got, expected)
    })
  }
  const room: ReadonlyArray<readonly [string, string]> = [
    ["the kitchen", "Act lights_on target=area:kitchen"],
    ["kitchen please", "Act lights_on target=area:kitchen"],
    ["the kitchen lights", "Act lights_on target=area:kitchen"],
    ["in de keuken graag", "Act lights_on target=area:kitchen"],
    ["de keuken", "Act lights_on target=area:kitchen"],
    ["keuken", "Act lights_on target=area:kitchen"],
    ["the lounge", "Act lights_on target=area:living_room"],
    ["the desk lamp", "Act lights_on target=light:desk_lamp"],
    ["turn on the kitchen", "Act lights_on target=area:kitchen"],
    ["the kitchen and the bedroom", "Fallback unexplained"],
    ["the kitchen or the bedroom", "Fallback unexplained"],
    ["the attic", "Fallback unexplained"],
    ["the kitchen quickly", "Act lights_on target=area:kitchen"], // round 4: a trailing manner word
    ["the kitchen at 40 percent", "Fallback unexplained"],
    ["not the kitchen", "Fallback negated"],
    ["stop, the kitchen", "Fallback negated"],
    ["the kitchen, two", "Fallback unexplained"]
  ]
  for (const [reply, expected] of room) {
    it(`Which room or light? → ${reply}`, () => {
      // The provider is sure the reply is the kitchen, whatever was said.
      const named = rooms.find((r) => [r.label, ...(r.aliases ?? [])].some((n) => reply.toLowerCase().includes(n.toLowerCase())))
      assert.strictEqual(summary(decide(reply, yesMan("lights_on", { target: named?.value ?? "area:kitchen" }), askRoom())), expected)
    })
  }
  it("the provider can confirm core's reading, never replace it: a different option is not the answer", () => {
    assert.notStrictEqual(summary(decide("the kitchen", yesMan("lights_on", { target: "area:bedroom" }), askRoom())), "Act lights_on target=area:bedroom")
  })
  it("a reply that is not purely an answer is planned with no memory of the pending action's values", () => {
    // "dim the bedroom to 40" after "What brightness?" for the kitchen: a fresh request for the bedroom; the kitchen never appears.
    const outcome = decide("dim the bedroom to 40", yesMan("set_brightness", { target: "area:bedroom", level: "c0" }), askLevel())
    assert.strictEqual(summary(outcome), "Act set_brightness target=area:bedroom level=40")
    // Round 4: "the bedroom 40" names no action, so as a fresh request it is handed on.
    assert.strictEqual(summary(decide("the bedroom 40", yesMan("set_brightness", { target: "area:bedroom", level: "c0" }), askLevel())), "Fallback unexplained")
  })
})

describe("mechanism: confirmations are a closed phrase grammar", () => {
  const confirm: ReadonlyArray<string> = [
    "yes", "Yes.", "yes please", "yeah sure", "ok", "okay then", "sure, go ahead", "go ahead", "do it", "please do", "that's right",
    "thats right", "yes, thank you", "ja", "ja graag", "graag", "doe maar", "ja, doe maar", "prima", "is goed", "dat klopt", "ga je gang"
  ]
  const not: ReadonlyArray<string> = [
    "is that right?", "is that okay?", "do you?", "is that right", "is that okay", "do you", "shall I", "zal ik", "klopt dat?", "okay?",
    "yes?", "ja?", "yes, but not the bedroom", "yes turn on the kitchen", "sure, no", "right", "right, what's the weather", "please",
    "thank you", "ja maar", "doe het licht aan", "is dat goed", "yes don't", "go", "do"
  ]
  for (const reply of confirm) {
    it(`confirms: ${reply}`, () => {
      assert.isTrue(isConfirmation(reply), reply)
      assert.strictEqual(summary(decide(reply, yesMan("all_off"), confirmAllOff())), "Act all_off")
    })
  }
  for (const reply of not) {
    it(`does not confirm: ${reply}`, () => {
      assert.isFalse(isConfirmation(reply), reply)
      // The provider says "yes" with 0.99: core does not run the confirmation on it.
      assert.notStrictEqual(summary(decide(reply, yesMan("all_off"), confirmAllOff())), "Act all_off", reply)
    })
  }
  it("a provider's no still cancels", () => {
    const plan = buildDecisionPlan({ utterance: "yes", actions, pending: confirmAllOff(), parse: parseValues })
    expect(interpretDecision(plan, { answers: { [Q.pendingAnswers]: noul(0.9), [Q.pendingYes]: noul(0.1) } })).toMatchObject({ _tag: "Cancelled" })
  })
})

describe("mechanism: negation and prohibition veto a side effect", () => {
  const vetoed: ReadonlyArray<string> = [
    "don't turn on the kitchen lights", "dont turn on the kitchen lights", "don t turn on the kitchen lights", "do not turn on the kitchen lights",
    "never turn on the kitchen lights", "wouldn't turn on the kitchen lights", "shouldnt turn on the kitchen lights", "you mustn't turn on the kitchen lights",
    "can't turn on the kitchen lights", "won't you turn on the kitchen lights", "stop turning on the kitchen lights", "quit turning on the kitchen lights",
    "avoid turning on the kitchen lights", "refrain from turning on the kitchen lights", "cancel turning on the kitchen lights",
    "doe het licht niet aan in de keuken", "doe het licht nooit aan in de keuken", "stop met het licht aan doen in de keuken",
    "hou op met het licht aan doen in de keuken", "doe het licht in de keuken niet meer aan", "turn on all lights except the kitchen",
    "turn on the lights without the kitchen"
  ]
  for (const utterance of vetoed) {
    it(`handed on: ${utterance}`, () => {
      assert.match(summary(decide(utterance, yesMan("lights_on", { target: "area:kitchen" }))), /^Fallback (negated|unexplained)$/)
    })
  }
  it("a negation word that is in no list still fails, as an unexplained word", () => {
    for (const utterance of ["nimmer turn on the kitchen lights", "ne'er turn on the kitchen lights", "doe het licht nimmer aan in de keuken"]) {
      assert.isFalse(isNegated(replyWords(utterance)), "not in the lists on purpose")
      assert.strictEqual(summary(decide(utterance, yesMan("lights_on", { target: "area:kitchen" }))), "Fallback unexplained", utterance)
    }
  })
  it("read-only actions are not vetoed; the same command without the negation acts", () => {
    assert.strictEqual(summary(decide("isn't it time yet", yesMan("time_now"))), "Act time_now")
    assert.strictEqual(summary(decide("turn on the kitchen lights", yesMan("lights_on", { target: "area:kitchen" }))), "Act lights_on target=area:kitchen")
    assert.strictEqual(summary(decide("doe het licht aan in de keuken", yesMan("lights_on", { target: "area:kitchen" }))), "Act lights_on target=area:kitchen")
  })
  it("a prohibition verb that is the action's own word does not veto it", () => {
    const stopTimer = registerActions("timer", [defineAction({ id: "stop", label: "Stop the timer", description: "Stop the running timer.", examples: ["stop the timer"], params: {}, run: () => Effect.void })])
    const plan = buildDecisionPlan({ utterance: "stop the timer", actions: stopTimer })
    expect(interpretDecision(plan, { answers: { [Q.action]: choiceAnswer({ "timer.stop": 0.99 }), [Q.fits]: noul(0.99), [Q.compound]: noul(0) } })).toMatchObject({ _tag: "Act" })
  })
})

describe("mechanism: a fresh request is acted on only when every word is explained (whatever the provider says)", () => {
  const rows: ReadonlyArray<readonly [string, string, Readonly<Record<string, string>>, string]> = [
    ["turn on the kitchen lights", "lights_on", { target: "area:kitchen" }, "Act lights_on target=area:kitchen"],
    ["Turn on the lights in the living room.", "lights_on", { target: "area:living_room" }, "Act lights_on target=area:living_room"],
    ["please switch on the desk lamp", "lights_on", { target: "light:desk_lamp" }, "Act lights_on target=light:desk_lamp"],
    ["can you turn on the lounge lights", "lights_on", { target: "area:living_room" }, "Act lights_on target=area:living_room"],
    ["doe het licht aan in de keuken", "lights_on", { target: "area:kitchen" }, "Act lights_on target=area:kitchen"],
    ["lights off in the bedroom", "lights_off", { target: "area:bedroom" }, "Act lights_off target=area:bedroom"],
    ["doe het licht uit in de slaapkamer", "lights_off", { target: "area:bedroom" }, "Act lights_off target=area:bedroom"],
    ["switch everything off", "all_off", {}, "Confirm all_off"],
    ["alles uit", "all_off", {}, "Confirm all_off"],
    ["turn on the lights", "lights_on", {}, "Ask lights_on"],
    // The provider picks the kitchen; the words say something else or more.
    // A value is one that was said: the provider's kitchen is a guess, so the room is asked for.
    ["turn on the bedroom lights", "lights_on", { target: "area:kitchen" }, "Ask lights_on"],
    ["turn on the lights", "lights_off", { target: "area:kitchen" }, "Fallback unexplained"],
    ["turn on the attic lights", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["turn on the kitchen lights quickly", "lights_on", { target: "area:kitchen" }, "Act lights_on target=area:kitchen"], // round 4
    ["turn on the kitchen lights in an hour", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["turn on the kitchen and the bedroom lights", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["turn on the kitchen lights for my mother", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["the kitchen lights are on", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["are the kitchen lights on", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["turn on the kitchen lights again tomorrow", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["dim the kitchen", "lights_off", { target: "area:kitchen" }, "Fallback unexplained"],
    ["switch off the kitchen lights", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["zet de keuken op veertig procent", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["doe het licht aan in de keuken en de slaapkamer", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["doe het licht aan op zolder", "lights_on", { target: "area:kitchen" }, "Fallback unexplained"],
    ["switch everything off except the bedroom", "all_off", {}, "Fallback negated"],
    ["what time is it in the kitchen", "time_now", {}, "Act time_now"] // read-only: the conversational check does not apply
  ]
  for (const [utterance, action, values, expected] of rows) {
    it(`${utterance} (provider: ${action})`, () => {
      assert.strictEqual(summary(decide(utterance, yesMan(action, values))), expected)
    })
  }
})

describe("cost of core's rule", () => {
  it("planning and interpreting one sentence stays well under a millisecond", () => {
    const pending = askLevel()
    const sentences = ["turn on the lights in the living room please", "dim the kitchen to one hundred and forty percent", "the attic 40", "zet de woonkamer op veertig procent"]
    const run = (utterance: string, p?: PendingIntent) => {
      const plan: DecisionPlan = buildDecisionPlan({ utterance, actions, pending: p, parse: parseValues })
      interpretDecision(plan, yesMan("lights_on")(plan.request))
    }
    for (let i = 0; i < 200; i++) for (const s of sentences) run(s, pending)
    const n = 1_000
    const start = performance.now()
    for (let i = 0; i < n; i++) for (const s of sentences) run(s, i % 2 === 0 ? pending : undefined)
    const each = (performance.now() - start) / (n * sentences.length)
    console.log(`plan + interpret (core's accounting included): ${(each * 1000).toFixed(0)} µs per sentence (${actions.length} actions)`)
    assert.isBelow(each, 1)
  })
})
