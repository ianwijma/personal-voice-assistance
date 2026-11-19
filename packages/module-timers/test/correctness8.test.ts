// Round 8: actual typed extraction and gateway calls; a miss must not mutate a sole row.
import { assert, it } from "@effect/vitest"
import { buildDecisionPlan, choiceAnswer, interpretDecision, offeredActions, parseValues, Q } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { decideByKeywords } from "../../agent-intent/src/keywords.ts"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"

const MIN = 60_000
const dutch = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }
const spoken = (kit: ModuleHarness, utterance: string, action: string, stock = true) => Effect.gen(function*() {
  const actions = offeredActions(kit.host.snapshot().assistantParts.get(kit.turn().assistantId!)!.map((p) => p.module), kit.host.gateway)
  const plan = buildDecisionPlan({ utterance, actions, parse: parseValues })
  const outcome = interpretDecision(plan, stock ? decideByKeywords(plan.request) : { answers: {
    [Q.action]: choiceAnswer({ [action]: 1 }),
    [Q.fits]: { type: "noul", value: 1 },
    [Q.compound]: { type: "noul", value: 0 },
    [Q.param(action, "all")]: { type: "noul", value: 0 },
    [Q.stated(action, "scope")]: { type: "noul", value: 0 },
    [Q.param(action, "scope")]: choiceAnswer({ none: 1 }),
    [Q.param(action, "change")]: choiceAnswer({ [utterance.startsWith("take") ? "remove" : "add"]: 1 })
  } })
  if (outcome._tag === "Act") {
    assert.strictEqual(outcome.action.id, action)
    const result = yield* kit.asTurn(kit.host.gateway.action(outcome.action, outcome.params))
    assert.isDefined(result)
    return { outcome, reply: result!.say }
  }
  assert.oneOf(outcome._tag, ["Ask", "Fallback"])
  if (outcome._tag === "Fallback") assert.oneOf(outcome.reason, stock ? ["unexplained", "negated", "no_match"] : ["unexplained", "negated"])
  return { outcome, reply: undefined }
})
const timerRows = (kit: ModuleHarness) => kit.moduleStore().collection(timers).list({ limit: 10 })
const alarmRows = (kit: ModuleHarness) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })

for (const stock of [true, false]) for (const [utterance, nl] of [["cancel alarms for tomorrow", false], ["annuleer wekkers voor morgen", true], ["cancel alarms tomorrow", false], ["annuleer wekkers morgen", true]] as const) it.effect(`1: a terminal date qualifier keeps today's alarm (${stock ? "stock" : "controlled"}): ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "11:55" })
  const before = yield* alarmRows(kit)
  const result = yield* spoken(kit, utterance, "alarms.cancel", stock)
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  if (result.outcome._tag === "Act") assert.isNotEmpty(result.reply)
}))
for (const [utterance, nl] of [["set a weekday alarm at noon", false], ["zet een werkdag wekker om twaalf uur", true]] as const) it.effect(`2: a qualifier before the noun never becomes a one-off: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* spoken(kit, utterance, "alarms.set")
  const rows = yield* alarmRows(kit)
  // A question/model handoff is allowed; if accepted, the rule must be retained.
  assert.isTrue(rows.length === 0 || rows.length === 1 && rows[0]!.value.rrule !== undefined)
}))
for (const stock of [true, false]) for (const utterance of ["add five minutes to pasta", "take a minute off pasta"]) it.effect(`3: an adjustment preposition preserves the missing target (${stock ? "stock" : "controlled"}): ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  const before = yield* timerRows(kit)
  yield* spoken(kit, utterance, "timers.adjust", stock)
  assert.deepStrictEqual(yield* timerRows(kit), before)
}))
for (const stock of [true, false]) for (const [utterance, nl] of [["set the pasta timer for eight minutes", false], ["zet de pasta timer op acht minuten", true], ["set pasta timer for eight minutes", false]] as const) it.effect(`4: a definite or bare named start never loses its name (${stock ? "stock" : "controlled"}): ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  yield* spoken(kit, utterance, "timers.start", stock)
  const rows = yield* timerRows(kit)
  assert.isTrue(rows.length === 0 || rows.length === 1 && rows[0]!.value.name === "pasta")
}))
for (const [utterance, nl, name] of [["cancel the alarm named Noon", false, "Noon"], ["cancel the alarm called Noon", false, "Noon"], ["cancel the alarm named alarm at noon", false, "alarm at noon"], ["annuleer de wekker genaamd Twaalf", true, "Twaalf"]] as const) it.effect(`5: an explicit name bypasses time parsing: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "11:55", name })
  yield* kit.action("set", { when: "12:00", name: "Lunch" })
  const result = yield* spoken(kit, utterance, "alarms.cancel", false)
  assert.strictEqual(result.outcome._tag, "Act")
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Lunch"])
}))
for (const [utterance, nl] of [["cancel eggs timer", false], ["annuleer eieren timer", true]] as const) it.effect(`6: a bare singular target never cancels the sole other timer: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  const before = yield* timerRows(kit)
  yield* spoken(kit, utterance, "timers.cancel", false)
  assert.deepStrictEqual(yield* timerRows(kit), before)
}))
for (const inlineName of ["unrecognised", "timer tomorrow", "some timer for ten minutes except rice"]) it.effect(`safety: unconsumed creation text asks: ${inlineName}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  const reply = yield* kit.action("start", { duration: "10 minutes", inlineName })
  assert.isTrue(reply.ok)
  assert.include(reply.ok ? reply.say! : "", "Which timer")
  assert.strictEqual((yield* timerRows(kit)).length, 0)
}))
for (const utterance of ["set a mysterious alarm at noon", "set a tomorrow alarm at noon"]) it.effect(`safety: a prefix qualifier is retained or asked about: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* spoken(kit, utterance, "alarms.set", false)
  const rows = yield* alarmRows(kit)
  assert.isTrue(rows.length === 0 || rows.length === 1 && rows[0]!.value.next?.date === "2026-11-19")
}))
it.effect("control: genuinely unqualified subtraction still changes the sole timer", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  assert.strictEqual((yield* spoken(kit, "take a minute off", "timers.adjust")).outcome._tag, "Act")
  assert.strictEqual((yield* timerRows(kit))[0]!.value.dueAt - (yield* kit.now), 2 * MIN)
}))
