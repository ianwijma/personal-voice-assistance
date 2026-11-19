// Round 9: temporal alarm selectors and recurrence modifiers must not become names.
import { assert, it } from "@effect/vitest"
import { buildDecisionPlan, choiceAnswer, interpretDecision, offeredActions, parseValues, Q } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { decideByKeywords } from "../../agent-intent/src/keywords.ts"
import { alarms, alarmsModule, timers, timersModule } from "../src/index.ts"

const dutch = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }
const spokenCancel = (kit: ModuleHarness, utterance: string, stock: boolean) => Effect.gen(function*() {
  const actions = offeredActions(kit.host.snapshot().assistantParts.get(kit.turn().assistantId!)!.map((p) => p.module), kit.host.gateway)
  const plan = buildDecisionPlan({ utterance, actions, parse: parseValues })
  const action = "alarms.cancel"
  const outcome = interpretDecision(plan, stock ? decideByKeywords(plan.request) : { answers: {
    [Q.action]: choiceAnswer({ [action]: 1 }),
    [Q.fits]: { type: "noul", value: 1 },
    [Q.compound]: { type: "noul", value: 0 },
    [Q.stated(action, "scope")]: { type: "noul", value: 0 },
    [Q.param(action, "scope")]: choiceAnswer({ none: 1 })
  } })
  assert.strictEqual(outcome._tag, "Act")
  if (outcome._tag !== "Act") throw new Error("expected the real extracted cancellation to execute")
  assert.strictEqual(outcome.action.id, action)
  return yield* kit.asTurn(kit.host.gateway.action(outcome.action, outcome.params))
})
const alarmRows = (kit: ModuleHarness) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })

for (const stock of [true, false]) it.effect(`1: tomorrow as a day and a different alarm's name asks without cancelling (${stock ? "stock" : "controlled"})`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "Tomorrow" })
  yield* kit.action("set", { when: "tomorrow at noon", name: "Lunch" })
  const before = yield* alarmRows(kit)
  const reply = yield* spokenCancel(kit, "cancel alarms tomorrow", stock)
  assert.include(reply!.say!, "?")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
}))

for (const [nl, days] of [[false, ["today", "tonight", "tomorrow", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]], [true, ["vandaag", "vanavond", "vannacht", "morgen", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag", "zondag"]]] as const) {
  for (const day of days) it.effect(`1: a day word asks, while an explicit name still cancels: ${day}`, () => Effect.gen(function*() {
    const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
    yield* kit.action("set", { when: "13:15", name: day })
    yield* kit.action("set", { when: nl ? "morgen om twaalf uur" : "tomorrow at noon", name: "Lunch" })
    const before = yield* alarmRows(kit)
    const reply = yield* kit.action("cancel", { which: day })
    assert.isTrue(reply.ok)
    assert.include(reply.say!, "?")
    assert.deepStrictEqual(yield* alarmRows(kit), before)
    const named = yield* kit.action("cancel", { which: `${nl ? "wekker genaamd" : "alarm named"} ${day}` })
    assert.isTrue(named.ok)
    assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Lunch"])
  }))
}

it.effect("1: an unparsed explicit clock asks instead of matching Half Past Noon by name", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "Half Past Noon" })
  yield* kit.action("set", { when: "12:30", name: "Lunch" })
  const before = yield* alarmRows(kit)
  const reply = yield* spokenCancel(kit, "cancel the alarm at half past noon", false)
  assert.include(reply!.say!, "?")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  const control = yield* spokenCancel(kit, "cancel the alarm at 12:30", false)
  assert.include(control!.say!, "cancelled")
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Half Past Noon"])
}))

for (const [nl, modifiers] of [[false, ["repeating", "recurring", "daily", "weekly"]], [true, ["herhalende", "terugkerende", "dagelijkse", "wekelijkse"]]] as const) {
  for (const modifier of modifiers) it.effect(`2: a recurrence modifier before timer refuses instead of becoming a name: ${modifier}`, () => Effect.gen(function*() {
    const kit = yield* startTestModule(timersModule, nl ? dutch : {})
    const phrase = yield* kit.phrases.say(nl ? `zet een ${modifier} timer op vijf minuten` : `set a ${modifier} timer for five minutes`)
    assert.isTrue(phrase.taken)
    const said = kit.phrases.spoken.at(-1)!.text
    assert.include(said, nl ? "niet" : "don't repeat")
    assert.include(said, nl ? "herhalende wekker" : "repeating alarm")
    assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({ limit: 10 }), [])
    // The typed path supplies the whole named-timer clause rather than the phrase's name slot.
    const typed = yield* kit.action("start", { duration: "5 minutes", inlineName: `${modifier} timer ${nl ? "op vijf minuten" : "for five minutes"}` })
    assert.isTrue(typed.ok)
    assert.strictEqual(typed.say, said)
    assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({ limit: 10 }), [])
  }))
}

for (const [nl, name] of [[false, undefined], [false, "tea"], [true, undefined], [true, "thee"]] as const) it.effect(`2: ordinary ${nl ? "Dutch" : "English"} ${name ?? "unnamed"} timer still starts`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  const phrase = yield* kit.phrases.say(nl ? `zet een ${name === undefined ? "" : `${name} `}timer op vijf minuten` : `set a ${name === undefined ? "" : `${name} `}timer for five minutes`)
  assert.isTrue(phrase.taken)
  const rows = yield* kit.moduleStore().collection(timers).list({ limit: 10 })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0]!.value.name, name)
  assert.strictEqual(rows[0]!.value.dueAt - (yield* kit.now), 300_000)
}))
