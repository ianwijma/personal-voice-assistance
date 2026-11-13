// The offline keyword decider through the real request assembly and interpretation.
import { assert, describe, it } from "@effect/vitest"
import { buildDecisionPlan, defineAction, interpretDecision, Param, parseValues, type PendingIntent, registerActions } from "@pva/core"
import { Effect } from "effect"
import { clockActions, demoHomeContributions, makeDemoHouse, makeWeatherParts } from "@pva/modules-builtin"
import { decideByKeywords } from "../src/keywords.ts"

const actions = [
  ...registerActions("demo-home", demoHomeContributions(makeDemoHouse()).actions),
  ...registerActions("clock", clockActions({ timeZone: "Europe/Amsterdam" })),
  ...registerActions("weather", [makeWeatherParts({ fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch }).today])
]

const decide = (utterance: string, pending?: PendingIntent) => {
  const plan = buildDecisionPlan({ utterance, actions, pending, parse: parseValues })
  const response = decideByKeywords(plan.request)
  return { outcome: interpretDecision(plan, response), response }
}

/** "Act demo-home.lights_on target=area:kitchen" etc. */
const summary = (utterance: string, pending?: PendingIntent): string => {
  const { outcome } = decide(utterance, pending)
  switch (outcome._tag) {
    case "Act":
      return [`Act ${outcome.action.id}`, ...Object.entries(outcome.params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`)].join(" ")
    case "Ask":
    case "Confirm":
      return `${outcome._tag} ${outcome.pending.action.id} "${outcome.question}"`
    case "Cancelled":
      return `Cancelled ${outcome.action.id}`
    case "Fallback":
      return `Fallback ${outcome.reason}`
  }
}

describe("keyword decider", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Turn on the lights in the living room.", "Act demo-home.lights_on target=area:living_room"],
    ["turn off the kitchen lights", "Act demo-home.lights_off target=area:kitchen"],
    ["switch on the desk lamp", "Act demo-home.lights_on target=light:desk_lamp"],
    ["lights off in the lounge", "Act demo-home.lights_off target=area:living_room"],
    ["doe het licht aan in de keuken", "Act demo-home.lights_on target=area:kitchen"],
    ["doe het licht uit in de slaapkamer", "Act demo-home.lights_off target=area:bedroom"],
    ["dim the living room to 40 percent", "Act demo-home.set_brightness target=area:living_room level=40"],
    ["zet de woonkamer op veertig procent", "Act demo-home.set_brightness target=area:living_room level=40"],
    ["which lights are on?", "Act demo-home.lights_status"],
    ["what time is it", "Act clock.time_now"],
    ["what's the time in Tokyo", "Act clock.time_now zone=Asia/Tokyo"],
    ["hoe laat is het in New York", "Act clock.time_now zone=America/New_York"],
    ["what's the weather like in Paris", "Act weather.today place=Paris"],
    ["hoe is het weer", "Act weather.today"],
    ["wat voor weer is het in Utrecht", "Act weather.today place=Utrecht"],
    ["switch everything off", "Confirm demo-home.all_off \"Switch everything off?\""],
    ["turn on the lights", "Ask demo-home.lights_on \"Which room or light?\""],
    ["Lights on.", "Ask demo-home.lights_on \"Which room or light?\""],
    ["are any lights on", "Act demo-home.lights_status"],
    ["What is a quark?", "Fallback no_match"],
    ["Tell me a joke about penguins", "Fallback no_match"],
    ["turn on the kitchen lights and tell me the weather", "Fallback compound"]
  ]
  for (const [utterance, expected] of cases) {
    it(utterance, () => {
      assert.strictEqual(summary(utterance), expected)
    })
  }

  it("answers a pending question with a short reply, and a confirmation with yes or no", () => {
    const asked = decide("turn on the lights").outcome
    assert.strictEqual(asked._tag, "Ask")
    if (asked._tag !== "Ask") return
    assert.strictEqual(summary("the kitchen", asked.pending), "Act demo-home.lights_on target=area:kitchen")
    assert.strictEqual(summary("de woonkamer", asked.pending), "Act demo-home.lights_on target=area:living_room")
    const confirm = decide("switch everything off").outcome
    if (confirm._tag !== "Confirm") return assert.fail("expected a confirmation")
    assert.strictEqual(summary("yes please", confirm.pending), "Act demo-home.all_off")
    assert.strictEqual(summary("ja, doe maar", confirm.pending), "Act demo-home.all_off")
    assert.strictEqual(summary("no", confirm.pending), "Cancelled demo-home.all_off")
    assert.strictEqual(summary("nee", confirm.pending), "Cancelled demo-home.all_off")
  })

  it("is fast: well under a millisecond per decision", () => {
    const plan = buildDecisionPlan({ utterance: "Turn on the lights in the living room.", actions, parse: parseValues })
    for (let i = 0; i < 200; i++) decideByKeywords(plan.request)
    const n = 2_000
    const start = performance.now()
    for (let i = 0; i < n; i++) decideByKeywords(plan.request)
    const each = (performance.now() - start) / n
    console.log(`keyword decision: ${(each * 1000).toFixed(0)} µs (${actions.length} actions)`)
    assert.isBelow(each, 1)
  })
})

describe("keyword decider: negated commands are not acted on (review finding 1)", () => {
  const negated = [
    "do not turn on the kitchen lights",
    "don't turn on the kitchen lights",
    "never turn off the kitchen lights",
    "please don't switch off the lights in the bedroom",
    "don't turn on the kitchen lights, turn off the bedroom lights",
    "not the kitchen lights, the bedroom lights on",
    "doe het licht niet aan in de keuken",
    "zet de lampen in de keuken niet uit",
    "doe nooit het licht uit in de slaapkamer",
    "don't dim the living room to 40 percent"
  ]
  for (const utterance of negated) {
    it(utterance, () => {
      assert.match(summary(utterance), /^Fallback/)
    })
  }
  it("still acts on the same commands without the negation", () => {
    assert.strictEqual(summary("turn on the kitchen lights"), "Act demo-home.lights_on target=area:kitchen")
    assert.strictEqual(summary("turn off the kitchen lights"), "Act demo-home.lights_off target=area:kitchen")
    assert.strictEqual(summary("doe het licht aan in de keuken"), "Act demo-home.lights_on target=area:kitchen")
  })
  it("a negated answer to a pending question does not choose the option it names", () => {
    const asked = decide("turn on the lights").outcome
    if (asked._tag !== "Ask") return assert.fail("expected a question")
    assert.match(summary("not the kitchen", asked.pending), /^Fallback/)
    assert.match(summary("niet de keuken", asked.pending), /^Fallback/)
    assert.strictEqual(summary("the kitchen", asked.pending), "Act demo-home.lights_on target=area:kitchen")
  })
})

describe("keyword decider: a pending confirmation needs a real answer (review finding 2)", () => {
  const pendingConfirm = () => {
    const confirm = decide("switch everything off").outcome
    if (confirm._tag !== "Confirm") throw new Error("expected a confirmation")
    return confirm.pending
  }
  it("a new polite command is a new request, not a yes", () => {
    const pending = pendingConfirm()
    assert.strictEqual(summary("turn on the kitchen lights please", pending), "Act demo-home.lights_on target=area:kitchen")
    assert.strictEqual(summary("please turn on the kitchen lights", pending), "Act demo-home.lights_on target=area:kitchen")
    assert.strictEqual(summary("doe het licht aan in de keuken graag", pending), "Act demo-home.lights_on target=area:kitchen")
    assert.notStrictEqual(summary("do you know what time it is right now", pending), "Act demo-home.all_off")
    assert.notStrictEqual(summary("right, what's the weather in Paris", pending), "Act demo-home.all_off")
  })
  it("bounded confirmations still confirm; refusals still cancel", () => {
    const pending = pendingConfirm()
    for (const yes of ["yes", "yes please", "yeah sure", "ok", "ja", "ja graag", "doe maar", "ja, doe maar", "please do", "go ahead", "that's right"]) {
      assert.strictEqual(summary(yes, pending), "Act demo-home.all_off", yes)
    }
    for (const no of ["no", "nee", "no thanks", "cancel", "don't", "niet doen", "laat maar"]) {
      assert.strictEqual(summary(no, pending), "Cancelled demo-home.all_off", no)
    }
  })
  it("an unclear reply neither acts nor confirms", () => {
    const pending = pendingConfirm()
    const unclear = summary("hmm what about the cat", pending)
    assert.notStrictEqual(unclear, "Act demo-home.all_off")
  })
})

describe("keyword decider: numbers the action cannot take are asked for (review findings 6, 7)", () => {
  it("dim 3 lights in kitchen to 140 percent never uses 3: the extra number is unexplained, so it is handed on (round 3)", () => {
    assert.strictEqual(summary("dim 3 lights in kitchen to 140 percent"), "Fallback unexplained")
    assert.strictEqual(summary("dim the kitchen to 140 percent"), 'Ask demo-home.set_brightness "I can\'t use 140 percent. What brightness?"')
  })
  it("a negative brightness is asked for rather than made positive", () => {
    assert.strictEqual(summary("dim the kitchen to -5 percent"), 'Ask demo-home.set_brightness "I can\'t use -5 percent. What brightness?"')
    assert.strictEqual(summary("dim the kitchen to minus five percent"), 'Ask demo-home.set_brightness "I can\'t use minus five percent. What brightness?"')
    assert.notMatch(summary("zet de keuken op min vijf procent"), /^Act/)
  })
})

// Rule: while a question is pending, a reply that is a command of its own is planned afresh,
// with all its parameters; a terse answer (a value, with or without the question's own words) answers.
describe("keyword decider: a command while a question is pending (review round 2, finding A)", () => {
  const pendingOf = (utterance: string) => {
    const asked = decide(utterance).outcome
    if (asked._tag !== "Ask") throw new Error(`expected a question for ${utterance}, got ${asked._tag}`)
    return asked.pending
  }
  it("after 'Which room or light?': commands are new requests", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["turn off the kitchen lights please", "Act demo-home.lights_off target=area:kitchen"],
      ["doe het licht uit in de keuken", "Act demo-home.lights_off target=area:kitchen"],
      ["dim the kitchen to 40 percent", "Act demo-home.set_brightness target=area:kitchen level=40"],
      ["zet de woonkamer op veertig procent", "Act demo-home.set_brightness target=area:living_room level=40"]
    ]
    for (const [reply, expected] of cases) assert.strictEqual(summary(reply, pendingOf("turn on the lights")), expected, reply)
    // Whatever a command decides on its own, it decides while the question is pending, and never the pending action.
    for (const reply of ["switch off the bedroom lights", "lights off in the bedroom", "zet het licht in de slaapkamer uit"]) {
      const fresh = summary(reply)
      assert.strictEqual(summary(reply, pendingOf("turn on the lights")), fresh, reply)
      assert.notMatch(fresh, /lights_on/, reply)
    }
  })
  it("after 'Which room or light?': terse answers answer", () => {
    for (const reply of ["the kitchen", "kitchen please", "the kitchen lights", "in de keuken graag", "de keuken", "keuken"]) {
      assert.strictEqual(summary(reply, pendingOf("turn on the lights")), "Act demo-home.lights_on target=area:kitchen", reply)
    }
  })
  it("after 'What brightness?' for the kitchen: commands are new requests", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["dim the bedroom to 40 percent", "Act demo-home.set_brightness target=area:bedroom level=40"],
      ["zet de slaapkamer op veertig procent", "Act demo-home.set_brightness target=area:bedroom level=40"],
      ["turn off the kitchen lights", "Act demo-home.lights_off target=area:kitchen"]
    ]
    for (const [reply, expected] of cases) assert.strictEqual(summary(reply, pendingOf("dim the kitchen to 140 percent")), expected, reply)
    for (const reply of ["dim bedroom 40", "dim bedroom forty", "slaapkamer dimmen naar 40"]) {
      const fresh = summary(reply)
      assert.strictEqual(summary(reply, pendingOf("dim the kitchen to 140 percent")), fresh, reply)
      assert.notMatch(fresh, /kitchen/, reply)
    }
  })
  it("after 'What brightness?' for the kitchen: terse answers answer", () => {
    for (const reply of ["40 percent", "40", "forty", "veertig procent", "make it 40 percent", "40%"]) {
      assert.strictEqual(summary(reply, pendingOf("dim the kitchen to 140 percent")), "Act demo-home.set_brightness target=area:kitchen level=40", reply)
    }
  })
})

describe("keyword decider: spoken numbers too large are asked for, never split (review round 2, findings D, I)", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["dim the kitchen to one hundred forty percent", "one hundred forty percent"],
    ["dim the kitchen to two hundred percent", "two hundred percent"],
    ["dim the kitchen to one hundred and forty percent", "one hundred and forty percent"],
    ["zet de keuken op honderdveertig procent", "honderdveertig procent"],
    ["zet de keuken op tweehonderd procent", "tweehonderd procent"],
    ["zet de keuken op honderd veertig procent", "honderd veertig procent"],
    ["dim the kitchen to 1,000 percent", "1,000 percent"],
    ["dim the kitchen to - 5 percent", "- 5 percent"],
    ["dim the kitchen to anderhalf procent", "anderhalf procent"] // not an integer
  ]
  for (const [utterance, said] of cases) {
    it(utterance, () => {
      assert.strictEqual(summary(utterance), `Ask demo-home.set_brightness "I can't use ${said}. What brightness?"`)
    })
  }
  it("numbers it can take still act", () => {
    assert.strictEqual(summary("dim the kitchen to one hundred percent"), "Act demo-home.set_brightness target=area:kitchen level=100")
    assert.strictEqual(summary("zet de keuken op vijf en twintig procent"), "Act demo-home.set_brightness target=area:kitchen level=25")
  })
})

// Rule: a value named but not offered is never replaced by the only option or a default.
describe("keyword decider: a value named but not offered (review round 2, finding E)", () => {
  const kitchenOnly = registerActions("home", [defineAction({
    id: "lights_on",
    label: "Turn lights on",
    description: "Switch on the lights in a room.",
    examples: ["turn on the lights", "lights on", "doe het licht aan", "licht aan"],
    params: { target: Param.dynamic({ label: "Room or light", options: () => [{ value: "area:kitchen", label: "Kitchen", aliases: ["keuken"] }] }) },
    run: () => Effect.void
  })])
  const one = (utterance: string) => {
    const plan = buildDecisionPlan({ utterance, actions: kitchenOnly, parse: parseValues })
    const outcome = interpretDecision(plan, decideByKeywords(plan.request))
    return outcome._tag === "Act" ? `Act ${String(outcome.params["target"])}` : outcome._tag
  }
  it("a single room: named and offered → it; named and not offered → asked; nothing named → it", () => {
    assert.strictEqual(one("turn on the kitchen lights"), "Act area:kitchen")
    assert.strictEqual(one("doe het licht aan in de keuken"), "Act area:kitchen")
    // Round 3: a word nothing explains ("bedroom" is no option here) is handed on rather than asked about.
    assert.strictEqual(one("turn on the bedroom lights"), "Fallback")
    assert.strictEqual(one("doe het licht aan in de slaapkamer"), "Fallback")
    assert.strictEqual(one("turn on the lights"), "Act area:kitchen")
    assert.strictEqual(one("doe het licht aan"), "Act area:kitchen")
  })
  it("an optional place named but not offered is asked about, not taken as here", () => {
    // The keyword decider does not even recognise these as commands: handed on, never the time here.
    assert.notMatch(summary("what's the time in Utrecht"), /^Act/)
    assert.notMatch(summary("hoe laat is het in Utrecht"), /^Act/)
    assert.strictEqual(summary("what time is it"), "Act clock.time_now")
    assert.strictEqual(summary("what's the time in Tokyo"), "Act clock.time_now zone=Asia/Tokyo")
  })
})
