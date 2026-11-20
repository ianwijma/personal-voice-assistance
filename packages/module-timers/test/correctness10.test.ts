// Final round: captured temporal intent must not fall through to a coincidental name.
import { assert, it } from "@effect/vitest"
import { buildDecisionPlan, choiceAnswer, interpretDecision, offeredActions, parseValues, Q } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { parseDateTime } from "@pva/language"
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
  if (stock && outcome._tag === "Ask") return { say: outcome.question }
  assert.strictEqual(outcome._tag, "Act")
  if (outcome._tag !== "Act") throw new Error("expected the real extracted cancellation to execute")
  assert.strictEqual(outcome.action.id, action)
  return yield* kit.asTurn(kit.host.gateway.action(outcome.action, outcome.params))
})
const alarmRows = (kit: ModuleHarness) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })

for (const stock of [true, false]) it.effect(`1: weekend cancellation asks instead of cancelling today's named alarm (${stock ? "stock" : "controlled"})`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "This Weekend" })
  yield* kit.action("set", { when: "November 21 at noon", name: "Lunch" })
  const before = yield* alarmRows(kit)
  assert.strictEqual(before.length, 2)
  const reply = yield* spokenCancel(kit, "cancel alarms this weekend", stock)
  assert.include(reply!.say!, "?")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
}))

for (const [nl, selectors] of [[false, ["this weekend", "next week", "November 21", "in two days"]], [true, ["dit weekend", "volgende week", "21 november", "overmorgen"]]] as const) {
  for (const selector of selectors) it.effect(`1: a day, date or calendar span takes precedence over a name: ${selector}`, () => Effect.gen(function*() {
    const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
    // The language reader handles dates; unsupported calendar spans must ask too.
    if (!/week/u.test(selector)) assert.notStrictEqual(parseDateTime(selector, nl ? "nl" : "en", { now: yield* kit.now, timeZone: "Europe/Amsterdam" }).kind, "not-understood")
    yield* kit.action("set", { when: "13:15", name: selector })
    yield* kit.action("set", { when: nl ? "morgen om twaalf uur" : "tomorrow at noon", name: "Lunch" })
    const before = yield* alarmRows(kit)
    assert.strictEqual(before.length, 2)
    const reply = yield* kit.action("cancel", { which: selector })
    assert.isTrue(reply.ok)
    assert.include(reply.say!, "?")
    assert.deepStrictEqual(yield* alarmRows(kit), before)
    const named = yield* kit.action("cancel", { which: `${nl ? "wekker genaamd" : "alarm named"} ${selector}` })
    assert.isTrue(named.ok)
    assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Lunch"])
  }))
}

it.effect("1: a clock-like suffix cannot turn Half Past Noon into an implicit name", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "Half Past Noon" })
  yield* kit.action("set", { when: "12:30", name: "Lunch" })
  const before = yield* alarmRows(kit)
  const reply = yield* spokenCancel(kit, "cancel the half past noon alarm", false)
  assert.include(reply!.say!, "?")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  const control = yield* spokenCancel(kit, "cancel the alarm at 12:30", false)
  assert.include(control!.say!, "cancelled")
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Half Past Noon"])
}))

for (const selector of ["next fortnight", "tea alarm", "unknown"]) it.effect(`1: an unresolved selector asks without falling back to a normalized or sole name: ${selector}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "Tea" })
  const before = yield* alarmRows(kit)
  const reply = yield* kit.action("cancel", { which: selector })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "?")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  yield* kit.action("cancel", { which: "tea" })
  assert.deepStrictEqual(yield* alarmRows(kit), [])
}))

for (const [nl, names] of [[false, ["repeating tea", "tea recurring", "every tea", "tea daily", "weekly tea", "monthly", "tea monthly"]], [true, ["herhalende thee", "terugkerende thee", "elke thee", "thee dagelijks", "wekelijks thee", "maandelijkse", "thee maandelijks"]]] as const) {
  for (const name of names) it.effect(`2: repetition anywhere in a prospective timer name refuses: ${name}`, () => Effect.gen(function*() {
    const kit = yield* startTestModule(timersModule, nl ? dutch : {})
    const clause = nl ? `${name} timer op vijf minuten` : `${name} timer for five minutes`
    const phrase = yield* kit.phrases.say(nl ? `zet een ${clause}` : `set a ${clause}`)
    assert.isTrue(phrase.taken)
    const said = kit.phrases.spoken.at(-1)!.text
    assert.include(said, nl ? "niet" : "don't repeat")
    assert.include(said, nl ? "herhalende wekker" : "repeating alarm")
    assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({ limit: 10 }), [])
    const typed = yield* kit.action("start", { duration: "5 minutes", inlineName: clause })
    assert.isTrue(typed.ok)
    assert.strictEqual(typed.say, said)
    assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({ limit: 10 }), [])
  }))
}

for (const [nl, name] of [[false, "tea"], [true, "thee"]] as const) it.effect(`2: ordinary ${name} still starts and rings once`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  assert.isTrue((yield* kit.phrases.say(nl ? `zet een ${name} timer op vijf minuten` : `set a ${name} timer for five minutes`)).taken)
  const rows = yield* kit.moduleStore().collection(timers).list({ limit: 10 })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0]!.value.name, name)
  yield* kit.advance(300_000)
  assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 1)
  assert.strictEqual((yield* kit.moduleStore().collection(timers).list({ limit: 10 }))[0]!.value.state, "done")
}))
