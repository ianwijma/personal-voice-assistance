// Review round 6 in Conversation: a final (or eager) transcript with no utterance open is ignored
// (finding 4: a duplicated final ran its action twice), and end-to-end property cases through the
// real Conversation: an eager and a final transcript one mutation apart, across a hand-off and a
// failure fallback, with and without an armed confirmation, run an action only when the final
// transcript alone would have run it (finding 5: the round-5 property called `sameUtterance`
// directly and could not notice the conversation using a different comparison).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, Param, registerActions } from "../src/Actions.ts"
import type { Agent } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import type { AgentTurnSetup, ConversationEvent, ConversationInput } from "../src/ConversationEvents.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import {
  agentFails,
  agentText,
  eagerEndOfTurn,
  endOfTurn,
  handoff,
  makeAgentSetup,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedAgent,
  scripted,
  scriptedRaw,
  type Sleep,
  sleep,
  speechStarted,
  turnResumed,
  withSpeechStarted
} from "../src/testing.ts"
import { testTurnTraceLayer } from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))
type Step = ConversationInput | Sleep

const one = (value: number): DecisionAnswer => ({ type: "noul", value })

/**
 * A house with `lights_on` (per room, side effect) and `all_off` (confirm: true), an intent agent
 * whose provider gives the most harmful confident answer it can (all_off for anything with "off",
 * else lights_on for the KITCHEN whatever was said; "it answers" and "it is a yes" to anything), and
 * a conversational "main" agent scripted by `main`.
 */
const world = (main: (text: string) => ReadonlyArray<ReturnType<typeof agentText> | ReturnType<typeof agentFails> | ReturnType<typeof handoff>>, routing: Record<string, unknown>) => {
  const runs: Array<string> = []
  const rooms = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:bedroom", label: "Bedroom" }]
  const actions = registerActions("home", [
    defineAction({
      id: "lights_on",
      label: "Turn lights on",
      description: "Switch on the lights in a room.",
      examples: ["turn on the kitchen lights"],
      params: { target: Param.dynamic({ label: "Room", options: () => rooms }) },
      run: (p) => Effect.sync(() => void runs.push(`lights_on ${String(p.target)}`))
    }),
    defineAction({
      id: "all_off",
      label: "Switch everything off",
      description: "Switch off every light in the house at once.",
      examples: ["switch everything off"],
      params: {},
      confirm: true,
      run: () => Effect.sync(() => void runs.push("all_off"))
    })
  ])
  const decider = makeScriptedDecider((request: DecisionRequest) => {
    const text = String(request.state.utterance ?? "")
    const off = /off/i.test(text)
    const answers: Record<string, DecisionAnswer> = {
      action: choiceAnswer(off ? { "home.all_off": 1 } : { "home.lights_on": 1 }),
      fits: one(1),
      compound: one(0),
      "home.lights_on/target": choiceAnswer({ "area:kitchen": 1 })
    }
    if (request.questions["pending/answers"] !== undefined) {
      answers["pending/answers"] = one(1)
      answers["pending/yes"] = one(1)
      answers["pending/answer"] = choiceAnswer({ "area:kitchen": 1 })
    }
    return { answers }
  }, { id: "keywords" })
  const jev: Agent = { id: "jev", name: "Jev", kind: "intent", speculate: true, firstEventTimeoutMs: 5_000, turn: makeIntentAgent({ deciders: ["keywords"] }).turn }
  const mainAgent = makeScriptedAgent({ id: "main" }, (input) => main(input.text))
  const setup: AgentTurnSetup = makeAgentSetup({ agents: [mainAgent.agent, jev], routing, extra: { actions, deciders: new Map([["keywords", decider]]) } })
  return { runs, setup, main: mainAgent }
}

const runScript = (setup: AgentTurnSetup, script: ReadonlyArray<Step>, raw = false, millis = 6_000) => {
  const events: Array<ConversationEvent> = []
  const layer = Conversation.layerWithAgents({ setup: Effect.succeed(setup), confirmActions: "on", onEvent: (e) => void events.push(e) }).pipe(
    Layer.provideMerge(testTurnTraceLayer),
    Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
  )
  return Effect.gen(function*() {
    const c = yield* Conversation
    const fiber = yield* Effect.forkChild(c.voice(raw ? scriptedRaw(script) : scripted(script)))
    yield* advance(millis)
    yield* Fiber.join(fiber)
    return events
  }).pipe(Effect.provide(layer))
}

describe("finding 4: a transcript with no utterance open is a protocol violation and is ignored", () => {
  it.effect("the reviewer's sequence: SpeechStarted, EndOfTurn('turn on the kitchen lights'), the same EndOfTurn again: the action runs once", () => {
    const w = world(() => [agentText("ok")], { defaultAgent: "jev", fallbackAgent: "main" })
    return Effect.gen(function*() {
      const events = yield* runScript(w.setup, [speechStarted, endOfTurn("turn on the kitchen lights"), sleep(1_000), endOfTurn("turn on the kitchen lights"), sleep(1_000)], true)
      assert.deepStrictEqual(w.runs, ["lights_on area:kitchen"])
      assert.strictEqual(events.filter((e) => e._tag === "TurnStarted").length, 1, "the duplicate started no turn")
    })
  })

  it.effect("an eager transcript or TurnResumed with no utterance open starts, discards and interrupts nothing", () => {
    const w = world((text) => [agentText(`(${text})`)], { defaultAgent: "main" })
    return Effect.gen(function*() {
      const events = yield* runScript(w.setup, [
        speechStarted, endOfTurn("tell me a long story"), sleep(10),
        eagerEndOfTurn("again"), turnResumed, sleep(10), endOfTurn("again"), sleep(1_000)
      ], true)
      assert.deepStrictEqual(w.main.probe.inputs.map((i) => i.text), ["tell me a long story"])
      assert.deepStrictEqual(events.filter((e) => e._tag === "TurnEnded").map((e) => (e._tag === "TurnEnded" ? e.outcome : "")), ["completed"])
    })
  })

  it.effect("typed text and Say are not recogniser events: they are never ignored", () => {
    const w = world((text) => [agentText(`(${text})`)], { defaultAgent: "main" })
    return Effect.gen(function*() {
      yield* runScript(w.setup, [
        speechStarted, endOfTurn("one"), sleep(500),
        { _tag: "TextInput", text: "two", speak: false }, sleep(500),
        { _tag: "Say", text: "a sample" }, sleep(500),
        { _tag: "TextInput", text: "three", speak: true }, sleep(500)
      ], true)
      assert.deepStrictEqual(w.main.probe.inputs.map((i) => i.text), ["one", "two", "three"])
    })
  })

  it.effect("every utterance of a contract-keeping recogniser is heard: resumed turns, empty finals, back-to-back utterances", () => {
    const w = world((text) => [agentText(`(${text})`)], { defaultAgent: "main" })
    return Effect.gen(function*() {
      yield* runScript(w.setup, [
        speechStarted, eagerEndOfTurn("set a"), turnResumed, eagerEndOfTurn("set a timer"), sleep(20), endOfTurn("set a timer"), sleep(500),
        speechStarted, endOfTurn(""), sleep(100),
        speechStarted, endOfTurn("first"), sleep(100), speechStarted, endOfTurn("second"), sleep(500)
      ], true)
      assert.deepStrictEqual(w.main.probe.inputs.map((i) => i.text).filter((t) => t !== "set a"), ["set a timer", "first", "second"])
    })
  })

  it("the scripted recogniser fakes keep the contract: a SpeechStarted is sent before a transcript with no utterance open", () => {
    assert.deepStrictEqual(withSpeechStarted([endOfTurn("a"), eagerEndOfTurn("b"), endOfTurn("b"), speechStarted, endOfTurn("c")]).map((e) => (e as ConversationInput)._tag), [
      "SpeechStarted", "EndOfTurn", "SpeechStarted", "EagerEndOfTurn", "EndOfTurn", "SpeechStarted", "EndOfTurn"
    ])
  })
})

// ---------------------------------------------------------------------------
// End-to-end property: eager and final transcripts one mutation apart.

/** A small deterministic PRNG (mulberry32). */
const prng = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6D2B79F5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const BASES = ["turn on the kitchen lights", "turn on the bedroom lights", "yes", "switch everything off", "yes please"]
const INSERTS = ["not", "the", "kitchen", "bedroom", "please", "off", "yes", "-", "?", "5", "don't"]

/** One mutation: insert, delete or substitute a word, change case, add a mark. */
const mutate = (text: string, rand: () => number): string => {
  const ws = text.split(" ")
  const pick = <A>(xs: ReadonlyArray<A>) => xs[Math.floor(rand() * xs.length)]!
  const at = Math.floor(rand() * (ws.length + 1))
  switch (Math.floor(rand() * 6)) {
    case 0:
      return [...ws.slice(0, at), pick(INSERTS), ...ws.slice(at)].join(" ")
    case 1:
      return ws.length > 1 ? ws.filter((_, i) => i !== Math.min(at, ws.length - 1)).join(" ") : `${text}?`
    case 2:
      return ws.map((w, i) => (i === Math.min(at, ws.length - 1) ? pick(INSERTS) : w)).join(" ")
    case 3:
      return text[0]!.toUpperCase() + text.slice(1)
    case 4:
      return `${text}${pick(["?", ".", "!", "-"])}`
    default:
      return text
  }
}

type Route = "direct" | "handoff" | "fallback"
const routeSetup = (route: Route) =>
  route === "direct"
    ? world(() => [agentText("ok")], { defaultAgent: "jev", fallbackAgent: "main" })
    : route === "handoff"
    ? world(() => [handoff("not mine")], { defaultAgent: "main", fallbackAgent: "jev" })
    : world(() => [agentFails("failed")], { defaultAgent: "main", fallbackAgent: "jev" })

/** Arms a confirmation of all_off (jev proposes, the question plays), then hands routing back to the route's default. */
const confirmationPrefix = (route: Route): ReadonlyArray<Step> => [
  speechStarted, endOfTurn("hey jev switch everything off"), sleep(1_000),
  { _tag: "SetActiveAgent", agentId: route === "direct" ? "jev" : "main" }, sleep(10)
]

describe("end-to-end property: an action runs only when the final transcript alone would have run it", () => {
  const rand = prng(20261114)
  const pairs: Array<{ readonly eager: string; readonly final: string }> = []
  for (let i = 0; i < 12; i++) {
    const base = BASES[i % BASES.length]!
    const eager = rand() < 0.5 ? base : mutate(base, rand)
    const final = rand() < 0.3 ? eager : mutate(eager, rand)
    pairs.push({ eager, final })
  }
  for (const route of ["direct", "handoff", "fallback"] as const) {
    for (const pending of [false, true]) {
      it.effect(`${route}, ${pending ? "with" : "without"} an armed confirmation`, () =>
        Effect.gen(function*() {
          const failures: Array<string> = []
          let acted = 0
          for (const { eager, final } of pairs) {
            const prefix = pending ? confirmationPrefix(route) : []
            const alone = routeSetup(route)
            yield* runScript(alone.setup, [...prefix, speechStarted, endOfTurn(final), sleep(1_000)])
            const both = routeSetup(route)
            yield* runScript(both.setup, [...prefix, speechStarted, eagerEndOfTurn(eager), sleep(50), endOfTurn(final), sleep(1_000)])
            if (both.runs.length > 0) acted++
            if (JSON.stringify(both.runs) !== JSON.stringify(alone.runs)) failures.push(`eager ${JSON.stringify(eager)} final ${JSON.stringify(final)}: ${JSON.stringify(both.runs)} vs final alone ${JSON.stringify(alone.runs)}`)
          }
          assert.deepStrictEqual(failures, [])
          assert.isAbove(acted, 0, "some pairs act: the property is not vacuous")
        }))
    }
  }

  it.effect("the property can fail: a conversation that promoted on a looser comparison would differ (sanity check of the oracle)", () =>
    Effect.gen(function*() {
      // With the confirmation armed, eager "yes" and final "yes?" — final alone is no confirmation.
      const alone = routeSetup("handoff")
      yield* runScript(alone.setup, [...confirmationPrefix("handoff"), speechStarted, endOfTurn("yes?"), sleep(1_000)])
      const exact = routeSetup("handoff")
      yield* runScript(exact.setup, [...confirmationPrefix("handoff"), speechStarted, eagerEndOfTurn("yes"), sleep(50), endOfTurn("yes"), sleep(1_000)])
      assert.deepStrictEqual(alone.runs, [])
      assert.deepStrictEqual(exact.runs, ["all_off"])
    }))
})
