// Round 11: temporal vocabulary and recurrence word forms close the two matching families.
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
  if (stock && outcome._tag === "Ask") return { say: outcome.question }
  assert.strictEqual(outcome._tag, "Act")
  if (outcome._tag !== "Act") throw new Error("expected the real extracted cancellation to execute")
  assert.strictEqual(outcome.action.id, action)
  return yield* kit.asTurn(kit.host.gateway.action(outcome.action, outcome.params))
})
const alarmRows = (kit: ModuleHarness) => kit.moduleStore().collection(alarms).list({ where: { phase: "set" }, limit: 10 })

for (const stock of [true, false]) it.effect(`1: before-noon cancellation asks with candidates instead of cancelling 13:15 (${stock ? "stock" : "controlled"})`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "Before Noon" })
  yield* kit.action("set", { when: "11:30", name: "Lunch" })
  const before = yield* alarmRows(kit)
  assert.strictEqual(before.length, 2)
  const reply = yield* spokenCancel(kit, "cancel alarms before noon", stock)
  assert.include(reply!.say!, "?")
  if (!stock) {
    assert.include(reply!.say!, "Before Noon")
    assert.include(reply!.say!, "quarter past one")
    assert.include(reply!.say!, "before noon")
  }
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  yield* spokenCancel(kit, "cancel the alarm at 11:30", false)
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Before Noon"])
  yield* spokenCancel(kit, "cancel the alarm named Before Noon", false)
  assert.deepStrictEqual(yield* alarmRows(kit), [])
}))

for (const [nl, names] of [
  [false, ["Before Tea", "After Tea", "Until Tea", "By Tea", "From Tea", "Between Tea", "This Tea", "Next Tea", "Coming Tea", "Tea Noon", "Tea Midnight", "Tea Monday", "Tea November", "Tea Morning", "Tea Hour", "Tea Weekends", "Tea 42", "Tea Twelve", "Tea Thousand", "Tea Quarter", "Tea O'clock", "Tea PM"]],
  [true, ["Voor Thee", "Na Thee", "Tot Thee", "Tegen Thee", "Vanaf Thee", "Tussen Thee", "Deze Thee", "Dit Thee", "Volgende Thee", "Komende Thee", "Aanstaande Thee", "Thee Middernacht", "Thee Maandag", "Thee November", "Thee Ochtend", "Thee Uur", "Thee Weekenden", "Thee 42", "Thee Tweeëntwintig", "Thee Kwartier", "Thee Avonds"]]
] as const) for (const name of names) it.effect(`1: a temporal word anywhere in an otherwise exact name asks: ${name}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "13:15", name })
  yield* kit.action("set", { when: "11:30", name: "Lunch" })
  const before = yield* alarmRows(kit)
  const reply = yield* kit.action("cancel", { which: name })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "?")
  assert.include(reply.say!, name)
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  yield* kit.action("cancel", { which: `${nl ? "genaamd" : "named"} ${name}` })
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Lunch"])
}))

it.effect("1: temporal candidate clarification preserves device privacy", () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule)
  yield* kit.action("set", { when: "13:15", name: "Before Noon" })
  const before = yield* alarmRows(kit)
  const reply = yield* kit.action("cancel", { which: "before noon" }, { device: "hall-screen", conversationId: "c-hall" })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "?")
  assert.notInclude(reply.say!, "Before Noon")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
}))

for (const [nl, name] of [[false, "Tea"], [false, "A"], [true, "Thee"]] as const) it.effect(`1: a name with no temporal word still cancels: ${name}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "13:15", name })
  yield* kit.action("cancel", { which: name })
  assert.deepStrictEqual(yield* alarmRows(kit), [])
}))

for (const [nl, names] of [
  [false, ["repeat", "repeated tea", "repeatable tea", "recurrence tea", "recurrent tea", "each tea", "interval tea", "periodic tea", "periodically tea", "hourly", "half-hourly", "bihourly", "bi-hourly", "twice-hourly", "twiceyearly", "secondly", "minutely", "daily", "weekly", "monthly", "yearly"]],
  [true, ["herhaal", "herhaalde thee", "herhaling thee", "terugkerend thee", "elke thee", "ieder thee", "uurlijkse", "uurlijks", "half-uurlijkse", "tweewekelijks", "driemaandelijks", "jaarlijks", "jaarlijkse", "dagelijks"]]
] as const) for (const name of names) it.effect(`2: a recurrence word form refuses through phrases and typed clauses: ${name}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  const clause = nl ? `${name} timer op vijf minuten` : `${name} timer for five minutes`
  assert.isTrue((yield* kit.phrases.say(nl ? `zet een ${clause}` : `set a ${clause}`)).taken)
  const reply = kit.phrases.spoken.at(-1)!.text
  assert.include(reply, nl ? "herhalende wekker" : "repeating alarm")
  assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({ limit: 10 }), [])
  const typed = yield* kit.action("start", { duration: "5 minutes", inlineName: clause })
  assert.isTrue(typed.ok)
  assert.strictEqual(typed.say, reply)
  yield* kit.advance(35 * 60_000)
  assert.deepStrictEqual(yield* kit.moduleStore().collection(timers).list({ limit: 10 }), [])
  assert.strictEqual(kit.notify.engine.ringingOn("kitchen-display").length, 0)
  assert.isFalse((yield* kit.jobs).some((j) => j.handler === "due" && (j.state === "scheduled" || j.state === "running")))
}))

for (const [nl, name] of [[false, "tea"], [false, "family"], [false, "alternating"], [true, "thee"], [true, "nauwelijks"], [true, "afwisselend"]] as const) it.effect(`2: a name outside the decided forms is confirmed with its duration: ${name}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(timersModule, nl ? dutch : {})
  assert.isTrue((yield* kit.phrases.say(nl ? `zet een ${name} timer op vijf minuten` : `set a ${name} timer for five minutes`)).taken)
  const reply = kit.phrases.spoken.at(-1)!.text
  assert.include(reply.toLowerCase(), name)
  assert.include(reply, nl ? "5 minuten" : "5 minutes")
  const rows = yield* kit.moduleStore().collection(timers).list({ limit: 10 })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0]!.value.name, name)
  assert.strictEqual(rows[0]!.value.durationMs, 300_000)
}))
