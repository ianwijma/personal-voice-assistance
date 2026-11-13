// Review round 3 through the real path: the offline keyword decider, core's plan and
// interpretation, the built-in modules. "Act only on what is fully accounted for".
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
  return interpretDecision(plan, decideByKeywords(plan.request))
}
const summary = (utterance: string, pending?: PendingIntent): string => {
  const outcome = decide(utterance, pending)
  switch (outcome._tag) {
    case "Act":
      return [`Act ${outcome.action.id}`, ...Object.entries(outcome.params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`)].join(" ")
    case "Ask":
    case "Confirm":
      return `${outcome._tag} ${outcome.pending.action.id}`
    case "Cancelled":
      return `Cancelled ${outcome.action.id}`
    case "Fallback":
      return "Fallback"
  }
}
const pendingOf = (utterance: string): PendingIntent => {
  const outcome = decide(utterance)
  if (outcome._tag !== "Ask" && outcome._tag !== "Confirm") throw new Error(`expected a question for ${utterance}, got ${outcome._tag}`)
  return outcome.pending
}

describe("finding 1 with the keyword decider: 'the attic 40' after 'What brightness?'", () => {
  it("is not the kitchen at 40", () => {
    const pending = pendingOf("dim the kitchen lights")
    assert.strictEqual(pending.awaiting.question, "What brightness?")
    assert.notMatch(summary("the attic 40", pending), /^Act/)
    assert.strictEqual(summary("40", pending), "Act demo-home.set_brightness target=area:kitchen level=40")
  })
})

describe("keyword decider, mechanism: numbers", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["dim the kitchen to 40 percent", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["dim the living room to forty percent", "Act demo-home.set_brightness target=area:living_room level=40"],
    ["set the desk lamp to 70%", "Act demo-home.set_brightness target=light:desk_lamp level=70"],
    ["zet de woonkamer op veertig procent", "Act demo-home.set_brightness target=area:living_room level=40"],
    ["zet de keuken op vijfenzeventig procent", "Act demo-home.set_brightness target=area:kitchen level=75"],
    ["dim the kitchen to one hundred percent", "Act demo-home.set_brightness target=area:kitchen level=100"],
    ["dim the kitchen to one hundred 40 percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to one point twenty five percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to 1.234,5 percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to forty 5 percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to -five percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to minus forty percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to 3-5 percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to 40 and 50 percent", "Ask demo-home.set_brightness"],
    ["zet de keuken op honderd 40 procent", "Ask demo-home.set_brightness"],
    ["zet de keuken op min vijf procent", "Ask demo-home.set_brightness"],
    ["zet de keuken op twee komma vijf procent", "Ask demo-home.set_brightness"],
    ["zet de keuken op 1.000 procent", "Ask demo-home.set_brightness"],
    ["dim 3 lights in the kitchen to 40 percent", "Fallback"],
    ["dim the kitchen to 40 percent in ten minutes", "Fallback"],
    ["turn on the kitchen lights 40", "Fallback"]
  ]
  for (const [utterance, expected] of rows) it(utterance, () => assert.strictEqual(summary(utterance), expected))
})

describe("keyword decider, mechanism: replies to a pending question", () => {
  const brightness: ReadonlyArray<readonly [string, string]> = [
    ["40 percent", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["forty", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["veertig procent", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["make it 40 percent", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["set it to 40 please", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["the kitchen 40", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["op veertig graag", "Act demo-home.set_brightness target=area:kitchen level=40"],
    ["140 percent", "Ask demo-home.set_brightness"],
    ["one hundred 40", "Ask demo-home.set_brightness"],
    ["the attic 40", "Fallback"],
    ["de zolder op veertig", "Fallback"],
    ["40 in ten minutes", "Fallback"],
    ["not 40", "Fallback"],
    ["dim the bedroom to 40 percent", "Act demo-home.set_brightness target=area:bedroom level=40"],
    ["turn off the kitchen lights", "Act demo-home.lights_off target=area:kitchen"]
  ]
  for (const [reply, expected] of brightness) {
    it(`What brightness? (kitchen) → ${reply}`, () => assert.strictEqual(summary(reply, pendingOf("dim the kitchen lights")), expected))
  }
  const room: ReadonlyArray<readonly [string, string]> = [
    ["the kitchen", "Act demo-home.lights_on target=area:kitchen"],
    ["de slaapkamer", "Act demo-home.lights_on target=area:bedroom"],
    ["the reading lamp please", "Act demo-home.lights_on target=light:reading_lamp"],
    ["alle lampen", "Act demo-home.lights_on target=all"],
    ["the kitchen and the bedroom", "Fallback"],
    ["the attic", "Fallback"],
    ["de zolder", "Fallback"],
    ["the kitchen at 40 percent", "Fallback"],
    ["niet de keuken", "Fallback"]
  ]
  for (const [reply, expected] of room) {
    it(`Which room or light? → ${reply}`, () => assert.strictEqual(summary(reply, pendingOf("turn on the lights")), expected))
  }
})

describe("keyword decider, mechanism: confirmations", () => {
  const yes = ["yes", "yes please", "sure, go ahead", "do it", "ja", "ja graag", "doe maar", "prima", "dat klopt", "ok"]
  const no = ["no", "nee", "no thanks", "laat maar"]
  const neither = ["is that right?", "is that okay?", "do you?", "is that right", "zal ik", "klopt dat?", "okay?", "right", "please", "yes, but not the bedroom"]
  for (const reply of yes) it(`confirms: ${reply}`, () => assert.strictEqual(summary(reply, pendingOf("switch everything off")), "Act demo-home.all_off"))
  for (const reply of no) it(`cancels: ${reply}`, () => assert.strictEqual(summary(reply, pendingOf("switch everything off")), "Cancelled demo-home.all_off"))
  for (const reply of neither) it(`does not confirm: ${reply}`, () => assert.notStrictEqual(summary(reply, pendingOf("switch everything off")), "Act demo-home.all_off"))
})

describe("keyword decider, mechanism: negation and prohibition", () => {
  const vetoed = [
    "stop turning on the kitchen lights", "wouldn't turn on the kitchen lights", "wouldnt turn on the kitchen lights", "don t turn on the kitchen lights",
    "shouldn't switch off the bedroom lights", "can't turn on the kitchen lights", "quit turning on the kitchen lights", "avoid turning off the lights in the bedroom",
    "refrain from turning on the kitchen lights", "never dim the living room to 40 percent", "stop met het licht aan doen in de keuken", "hou op met het licht uit doen in de keuken",
    "doe het licht in de keuken niet meer aan", "doe nooit het licht uit in de slaapkamer", "zet de keuken niet op veertig procent", "switch everything off except the bedroom",
    // In no list on purpose: fails as an unexplained word.
    "nimmer turn on the kitchen lights", "doe het licht nimmer aan in de keuken", "ne'er turn on the kitchen lights"
  ]
  for (const utterance of vetoed) it(utterance, () => assert.strictEqual(summary(utterance), "Fallback"))
  it("the same commands without the negation act", () => {
    assert.strictEqual(summary("turn on the kitchen lights"), "Act demo-home.lights_on target=area:kitchen")
    assert.strictEqual(summary("doe het licht uit in de slaapkamer"), "Act demo-home.lights_off target=area:bedroom")
  })
})

describe("keyword decider, mechanism: a fresh request fits only when every word is explained", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["turn on the kitchen lights", "Act demo-home.lights_on target=area:kitchen"],
    ["please turn on the lights in the living room", "Act demo-home.lights_on target=area:living_room"],
    ["can you switch on the desk lamp", "Act demo-home.lights_on target=light:desk_lamp"],
    ["lights off in the lounge", "Act demo-home.lights_off target=area:living_room"],
    ["doe het licht aan in de keuken", "Act demo-home.lights_on target=area:kitchen"],
    ["doe het licht uit in de slaapkamer", "Act demo-home.lights_off target=area:bedroom"],
    ["which lights are on", "Act demo-home.lights_status"],
    ["what time is it", "Act clock.time_now"],
    ["hoe laat is het in Tokyo", "Act clock.time_now zone=Asia/Tokyo"],
    ["what's the weather like in Paris", "Act weather.today place=Paris"],
    ["switch everything off", "Confirm demo-home.all_off"],
    ["turn on the lights", "Ask demo-home.lights_on"],
    ["turn on the kitchen lights quickly", "Act demo-home.lights_on target=area:kitchen"], // round 4: a trailing manner word
    ["turn on the kitchen lights thank you", "Act demo-home.lights_on target=area:kitchen"], // round 4: trailing politeness
    ["doe het licht aan in de keuken, dank je", "Act demo-home.lights_on target=area:kitchen"],
    ["can you turn on the kitchen lights?", "Act demo-home.lights_on target=area:kitchen"],
    ["I like the kitchen lights on", "Fallback"], // round 4: a statement is not a request
    ["will the kitchen lights turn on", "Fallback"],
    ["the kitchen lights turn on", "Fallback"],
    ["dim the kitchen to 40 degrees", "Fallback"], // round 4: degrees are not percent
    ["dim the kitchen to .5 percent", "Ask demo-home.set_brightness"],
    ["dim the kitchen to –5 percent", "Ask demo-home.set_brightness"],
    ["turn on the kitchen lights?", "Fallback"],
    ["turn on the attic lights", "Fallback"],
    ["turn on the kitchen lights for my mother", "Fallback"],
    ["turn on the kitchen and the bedroom lights", "Fallback"],
    ["the kitchen lights are on", "Fallback"],
    ["turn on the kitchen lights tomorrow morning", "Fallback"],
    ["doe het licht aan op zolder", "Fallback"],
    ["doe het licht aan in de keuken en de slaapkamer", "Fallback"],
    ["what time is it in Utrecht", "Fallback"],
    ["What is a quark?", "Fallback"]
  ]
  for (const [utterance, expected] of rows) it(utterance, () => assert.strictEqual(summary(utterance), expected))
})
