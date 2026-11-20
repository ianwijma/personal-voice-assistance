// Round 12: order/position words cannot silently select a matching alarm name.
import { assert, it } from "@effect/vitest"
import { buildDecisionPlan, choiceAnswer, interpretDecision, offeredActions, parseValues, Q } from "@pva/core"
import { type ModuleHarness, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { alarms, alarmsModule } from "../src/index.ts"

const dutch = { household: { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } } }
const spokenCancel = (kit: ModuleHarness, utterance: string) => Effect.gen(function*() {
  const actions = offeredActions(kit.host.snapshot().assistantParts.get(kit.turn().assistantId!)!.map((p) => p.module), kit.host.gateway)
  const plan = buildDecisionPlan({ utterance, actions, parse: parseValues })
  const action = "alarms.cancel"
  const outcome = interpretDecision(plan, { answers: {
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

for (const [nl, name, word, otherTime] of [
  [false, "First Alarm", "first", "11:30"],
  [false, "Last Alarm", "last", "16:30"],
  [true, "Eerste Wekker", "eerste", "11:30"],
  [true, "Laatste Wekker", "laatste", "16:30"]
] as const) it.effect(`1: extracted ${word} cancellation asks and explicit naming still cancels`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "13:15", name })
  yield* kit.action("set", { when: otherTime, name: "Lunch" })
  const before = yield* alarmRows(kit)
  assert.strictEqual(before.length, 2)
  const reply = yield* spokenCancel(kit, nl ? `annuleer de ${word} wekker` : `cancel the ${word} alarm`)
  assert.include(reply!.say!, "?")
  assert.include(reply!.say!, name)
  assert.include(reply!.say!, nl ? "kwart over een" : "quarter past one")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
  yield* spokenCancel(kit, nl ? `annuleer de wekker genaamd ${name}` : `cancel the alarm named ${name}`)
  assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name), ["Lunch"])
}))

for (const [nl, words] of [
  [false, ["first", "second", "third", "fourth", "twelfth", "twenty-first", "thirty-first", "fortieth", "hundredth", "thousandth", "last", "next", "previous", "earliest", "latest", "soonest", "newest", "oldest", "other"]],
  [true, ["eerste", "tweede", "derde", "vierde", "twaalfde", "eenentwintigste", "eenendertigste", "veertigste", "honderdste", "duizendste", "laatste", "volgende", "vorige", "vroegste", "spoedigste", "snelste", "nieuwste", "oudste", "andere", "eerstvolgende"]]
] as const) for (const word of words) it.effect(`1: order word anywhere in an exact name asks: ${word}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  const name = `${nl ? "Thee" : "Tea"} ${word}`
  yield* kit.action("set", { when: "13:15", name })
  const before = yield* alarmRows(kit)
  const reply = yield* kit.action("cancel", { which: name })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "?")
  assert.include(reply.say!, name)
  assert.deepStrictEqual(yield* alarmRows(kit), before)
}))

for (const [nl, words] of [[false, "earliest alarm"], [true, "vroegste wekker"]] as const) it.effect(`1: unsupported order without a name match asks: ${words}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "13:15", name: "Lunch" })
  const before = yield* alarmRows(kit)
  const reply = yield* kit.action("cancel", { which: words })
  assert.isTrue(reply.ok)
  assert.include(reply.say!, "?")
  assert.deepStrictEqual(yield* alarmRows(kit), before)
}))

for (const [nl, name] of [[false, "Faith"], [true, "Jade"]] as const) it.effect(`1: a name without a time, day, relation or order word still cancels: ${name}`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "13:15", name })
  yield* kit.action("cancel", { which: name })
  assert.deepStrictEqual(yield* alarmRows(kit), [])
}))

for (const [nl, words] of [
  [false, ["final", "middle", "penultimate", "upcoming", "following", "coming", "remaining", "only", "sole"]],
  [true, ["eerstkomende", "eerstvolgende", "volgende", "vorige", "laatste", "voorlaatste", "middelste", "komende", "resterende", "enige"]]
] as const) it.effect(`13: position-word requests preserve all alarms until explicitly named (${nl ? "Dutch" : "English"})`, () => Effect.gen(function*() {
  const kit = yield* startTestModule(alarmsModule, nl ? dutch : {})
  yield* kit.action("set", { when: "11:30", name: "Breakfast" })
  yield* kit.action("set", { when: "16:30", name: "Lunch" })
  for (const word of words) {
    const name = `${word[0]!.toUpperCase()}${word.slice(1)} ${nl ? "Wekker" : "Alarm"}`
    yield* kit.action("set", { when: "13:15", name })
    const before = yield* alarmRows(kit)
    assert.strictEqual(before.length, 3)
    const reply = yield* spokenCancel(kit, nl ? `annuleer de ${word} wekker` : `cancel the ${word} alarm`)
    assert.include(reply!.say!, "?")
    assert.include(reply!.say!, name)
    assert.deepStrictEqual(yield* alarmRows(kit), before)
    yield* spokenCancel(kit, nl ? `annuleer de wekker genaamd ${name}` : `cancel the alarm named ${name}`)
    assert.deepStrictEqual((yield* alarmRows(kit)).map((r) => r.value.name).sort(), ["Breakfast", "Lunch"])
  }
}))
