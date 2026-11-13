// The offline keyword decider through the real request assembly and interpretation.
import { assert, describe, it } from "@effect/vitest"
import { buildDecisionPlan, interpretDecision, parseValues, type PendingIntent, registerActions } from "@pva/core"
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
