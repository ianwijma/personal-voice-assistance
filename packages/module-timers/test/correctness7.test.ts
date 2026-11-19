// Round 7: exercise extraction and gateway invocation, including the reviewer's uncertain all/change answers.
import { assert, it } from "@effect/vitest"
import { buildDecisionPlan, choiceAnswer, interpretDecision, offeredActions, parseValues, Q } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { decideByKeywords } from "../../agent-intent/src/keywords.ts"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"

const MIN = 60_000
const spoken = (kit: ModuleHarness, utterance: string, action: string, stock = false, all = false) => Effect.gen(function*() {
  const actions = offeredActions(kit.host.snapshot().assistantParts.get(kit.turn().assistantId!)!.map((p) => p.module), kit.host.gateway)
  const plan = buildDecisionPlan({ utterance, actions, parse: parseValues })
  const outcome = interpretDecision(plan, stock ? decideByKeywords(plan.request) : { answers: {
    [Q.action]: choiceAnswer({ [action]: 1 }),
    [Q.fits]: { type: "noul", value: 1 },
    [Q.compound]: { type: "noul", value: 0 },
    [Q.param(action, "all")]: { type: "noul", value: all ? 1 : 0 },
    [Q.stated(action, "scope")]: { type: "noul", value: 0 },
    [Q.param(action, "scope")]: choiceAnswer({ none: 1 }),
    [Q.stated(action, "change")]: { type: "noul", value: 0 },
    [Q.param(action, "change")]: choiceAnswer({ [utterance.startsWith("take") ? "remove" : "add"]: 1 })
  } })
  if (outcome._tag !== "Act") {
    assert.oneOf(outcome._tag, ["Ask", "Fallback"])
    if (outcome._tag === "Fallback") assert.oneOf(outcome.reason, ["negated", "unexplained"])
    return undefined
  }
  assert.strictEqual(outcome.action.id, action)
  return (yield* kit.asTurn(kit.host.gateway.action(outcome.action, outcome.params)))?.say
})
const timerRows = (kit: ModuleHarness) => kit.moduleStore().collection(timers).list({ limit: 10 })
const alarmRows = (kit: ModuleHarness) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })
const dutch = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }

for (const utterance of ["cancel my eggs timer", "cancel the timer named eggs"]) it.effect(`1: an uncertain all flag keeps the named target: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "5 minutes", name: "Eggs" })
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  const reply = yield* spoken(kit, utterance, "timers.cancel", true)
  assert.include(reply!, "cancelled")
  assert.deepStrictEqual((yield* timerRows(kit)).map((r) => [r.value.name, r.value.state]).sort(), [["Eggs", "cancelled"], ["Rice", "running"]])
}))
for (const [utterance, bulk] of [["cancel all timers", true], ["cancel all timers except eggs", false], ["annuleer alle timers", true], ["annuleer alle timers behalve eieren", false]] as const) it.effect(`1: bulk cancellation requires only an explicit bulk target: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, utterance.startsWith("annuleer") ? dutch : {})
  yield* kit.action("start", { duration: "5 minutes", name: "Eggs" })
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  yield* spoken(kit, utterance, "timers.cancel", false, true)
  assert.strictEqual((yield* timerRows(kit)).filter((r) => r.value.state === "cancelled").length, bulk ? 2 : 0)
}))

it.effect("2: tomorrow-only cancellation never falls back to today's sole alarm", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "11:55", name: "Tea" })
  yield* spoken(kit, "cancel tomorrow's alarm only", "alarms.cancel", true)
  assert.strictEqual((yield* alarmRows(kit)).length, 1)
}))
it.effect("2: a genuinely unqualified cancellation still finds the only alarm", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "11:55", name: "Tea" })
  yield* spoken(kit, "cancel the alarm", "alarms.cancel")
  assert.strictEqual((yield* alarmRows(kit)).length, 0)
}))
for (const [utterance, date, repeat] of [
  ["set an alarm every weekday at noon", "2026-11-18", true],
  ["set an alarm for every weekday at noon", "2026-11-18", true],
  ["set an alarm tomorrow at noon", "2026-11-19", false],
  ["set an alarm for tomorrow at noon", "2026-11-19", false]
] as const) it.effect(`3: the temporal clause remains complete: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* spoken(kit, utterance, "alarms.set", utterance === "set an alarm every weekday at noon")
  const rows = yield* alarmRows(kit)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0]!.value.next?.date, date)
  assert.strictEqual(rows[0]!.value.next?.time, "12:00")
  assert.strictEqual(rows[0]!.value.rrule !== undefined, repeat)
}))
for (const utterance of ["cancel the noon alarm", "cancel the alarm at 12:00", "cancel my noon alarm"]) it.effect(`4: the alarm noun never turns a time into a name: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "11:55", name: "Noon" })
  yield* kit.action("set", { when: "noon", name: "Lunch" })
  yield* spoken(kit, utterance, "alarms.cancel")
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.next?.time), ["11:55"])
}))
for (const [op, utterance, nl, stock] of [
  ["pause", "pause my pasta timer", false, true], ["pause", "pause pasta", false, true], ["pause", "pauzeer de pasta timer", true, true],
  ["resume", "resume my pasta timer", false, true], ["resume", "resume pasta", false, false], ["resume", "hervat mijn pasta timer", true, false],
  ["cancel", "cancel my eggs timer", false, false], ["cancel", "annuleer mijn eieren timer", true, false]
] as const) it.effect(`5: an unmatched named target never changes the only timer: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  if (op === "resume") yield* kit.action("pause", { name: "Rice" })
  yield* spoken(kit, utterance, `timers.${op}`, stock)
  assert.strictEqual((yield* timerRows(kit))[0]!.value.state, op === "resume" ? "paused" : "running")
}))
for (const [op, utterance, nl] of [["pause", "pause my rice timer", false], ["resume", "resume my rice timer", false], ["cancel", "annuleer mijn rijst timer", true]] as const) it.effect(`5: a matching named target remains usable: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  yield* kit.action("start", { duration: "3 minutes", name: nl ? "rijst" : "Rice" })
  if (op === "resume") yield* kit.action("pause", { name: "timer" })
  yield* spoken(kit, utterance, `timers.${op}`)
  assert.strictEqual((yield* timerRows(kit))[0]!.value.state, op === "pause" ? "paused" : op === "resume" ? "running" : "cancelled")
}))
for (const [utterance, left, stock] of [["take a minute off", 2, true], ["take a minute off my rice timer", 2, false], ["change the rice timer by one minute", 3, false]] as const) it.effect(`6: adjustment keeps its direction or asks: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  yield* spoken(kit, utterance, "timers.adjust", stock)
  assert.strictEqual((yield* timerRows(kit))[0]!.value.dueAt - (yield* kit.now), left * MIN)
}))
for (const [utterance, nl] of [["start a pasta timer for ten minutes", false], ["set a pasta timer for ten minutes", false], ["zet een pasta timer op tien minuten", true]] as const) it.effect(`7: the typed start keeps the whole name or hands off: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  yield* spoken(kit, utterance, "timers.start")
  const rows = yield* timerRows(kit)
  // Core hands overlapping text/duration spans to the conversational agent; it must never commit a missing or shortened name.
  assert.isAtMost(rows.length, 1)
  if (rows.length === 1) {
    assert.strictEqual(rows[0]!.value.name, "pasta")
    assert.strictEqual(rows[0]!.value.durationMs, 10 * MIN)
  }
}))
it.effect("7: the parallel named start phrase keeps the name", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  assert.isTrue((yield* kit.phrases.say("start a pasta timer for ten minutes")).taken)
  assert.strictEqual((yield* timerRows(kit))[0]!.value.name, "pasta")
}))

for (const [clause, name] of [["pasta timer for ten minutes", "pasta"], ["red hot pasta timer for ten minutes", "red hot pasta"]]) it.effect(`7: the action reads the full inline clause: ${clause}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "10 minutes", inlineName: clause })
  assert.strictEqual((yield* timerRows(kit))[0]!.value.name, name)
}))

it.effect("1: all true without spoken bulk wording asks and keeps the sole timer", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  const reply = yield* kit.action("cancel", { all: true })
  assert.include(reply.ok ? reply.say! : reply.message, "Which timer")
  assert.strictEqual((yield* timerRows(kit))[0]!.value.state, "running")
}))
it.effect("1: an explicit bulk target with a conflicting name asks without changing either timer", () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule)
  yield* kit.action("start", { duration: "3 minutes", name: "Rice" })
  yield* kit.action("start", { duration: "5 minutes", name: "Eggs" })
  yield* kit.action("cancel", { name: "Eggs", all: true, bulk: "timers" })
  assert.strictEqual((yield* timerRows(kit)).filter((r) => r.value.state === "running").length, 2)
}))
for (const [utterance, date, repeat] of [["zet een wekker elke werkdag om twaalf uur", "2026-11-18", true], ["zet een wekker morgen om twaalf uur", "2026-11-19", false]] as const) it.effect(`3: Dutch temporal clause remains complete: ${utterance}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, dutch)
  yield* spoken(kit, utterance, "alarms.set")
  const rows = yield* alarmRows(kit)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0]!.value.next?.date, date)
  assert.strictEqual(rows[0]!.value.rrule !== undefined, repeat)
}))
