// Review round 4 in Conversation: a speculative intent decision is promoted only for the same
// canonical text (finding 1: eager "yes", final "yes?"), and an utterance that ends with no words
// closes the open utterance and starts nothing (finding 6), for every agent kind.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, registerActions } from "../src/Actions.ts"
import type { Agent } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import type { AgentTurnSetup, ConversationEvent, ConversationInput } from "../src/ConversationEvents.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { TurnTrace } from "../src/TurnTrace.ts"
import {
  agentText,
  eagerEndOfTurn,
  endOfTurn,
  makeAgentSetup,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedAgent,
  scripted,
  type Sleep,
  sleep,
  speechStarted,
  testTurnTraceLayer
} from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const harness = (setup: AgentTurnSetup) => {
  const events: Array<ConversationEvent> = []
  const tts = makeMarkerTts()
  const out = makeRecordingAudioOutput({ chunkMillis: 100 })
  const conversation = Conversation.layerWithAgents({ setup: Effect.succeed(setup), confirmActions: "on", onEvent: (e) => events.push(e) })
    .pipe(Layer.provideMerge(testTurnTraceLayer))
  return { events, out, layer: Layer.mergeAll(conversation, tts.layer, out.layer) }
}
const run = (script: ReadonlyArray<ConversationInput | Sleep>, millis = 5_000) =>
  Effect.gen(function*() {
    const c = yield* Conversation
    const fiber = yield* Effect.forkChild(c.voice(scripted(script)))
    yield* advance(millis)
    yield* Fiber.join(fiber)
  })
const traces = Effect.flatMap(Effect.service(TurnTrace), (t) => t.recent)
const history = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const stop: ConversationInput = { _tag: "Interrupt" }
const started = (events: ReadonlyArray<ConversationEvent>) => events.filter((e) => e._tag === "TurnStarted").length

describe("finding 1: a final 'yes?' never confirms through a promoted eager 'yes'", () => {
  /** "switch everything off" needs a confirmation; the provider says "it answers" and "it is a yes" to anything. */
  const house = () => {
    const runs: Array<string> = []
    const actions = registerActions("home", [defineAction({
      id: "all_off",
      label: "Switch everything off",
      description: "Switch off every light in the house at once.",
      examples: ["switch everything off"],
      params: {},
      confirm: true,
      run: () => Effect.sync(() => void runs.push("all_off"))
    })])
    const one = (value: number): DecisionAnswer => ({ type: "noul", value })
    const decider = makeScriptedDecider((request: DecisionRequest) => {
      const answers: Record<string, DecisionAnswer> = { action: choiceAnswer({ "home.all_off": 1 }), fits: one(1), compound: one(0) }
      if (request.questions["pending/answers"] !== undefined) {
        answers["pending/answers"] = one(1)
        answers["pending/yes"] = one(1)
      }
      return { answers }
    }, { id: "keywords" })
    const intent = makeIntentAgent({ deciders: ["keywords"] })
    const jev: Agent = { id: "jev", name: "Jev", kind: "intent", speculate: true, firstEventTimeoutMs: 5_000, turn: intent.turn }
    const main = makeScriptedAgent({ id: "main" }, (input) => [agentText(`(answer to ${input.text})`)])
    const setup = makeAgentSetup({ agents: [main.agent, jev], routing: { defaultAgent: "main" }, extra: { actions, deciders: new Map([["keywords", decider]]) } })
    return { runs, setup, main, intent }
  }
  it.effect("eager 'yes', final 'yes?': the speculative turn is discarded, 'yes?' is decided afresh, nothing is switched off", () => {
    const h = house()
    const t = harness(h.setup)
    return Effect.gen(function*() {
      yield* run([
        speechStarted, endOfTurn("hey jev switch everything off"), sleep(1_000),
        speechStarted, eagerEndOfTurn("yes"), sleep(50), endOfTurn("yes?"), sleep(1_000)
      ])
      assert.deepStrictEqual(h.runs, [], "nothing was switched off")
      const outcomes = (yield* traces).map((tr) => tr.outcome)
      assert.include(outcomes, "discarded", "the speculative 'yes' turn was discarded")
      assert.deepStrictEqual((yield* history).filter((m) => m.role === "user").map((m) => m.content), ["Switch everything off", "yes?"])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("eager 'yes', final 'Yes.': the same canonical text, promoted, confirmed", () => {
    const h = house()
    const t = harness(h.setup)
    return Effect.gen(function*() {
      yield* run([
        speechStarted, endOfTurn("hey jev switch everything off"), sleep(1_000),
        speechStarted, eagerEndOfTurn("yes"), sleep(50), endOfTurn("yes."), sleep(1_000)
      ])
      assert.deepStrictEqual(h.runs, ["all_off"])
      assert.notInclude((yield* traces).map((tr) => tr.outcome), "discarded")
    }).pipe(Effect.provide(t.layer))
  })
})

describe("finding 6: an utterance that ends with no words starts nothing and closes the utterance", () => {
  const kinds: ReadonlyArray<Agent["kind"]> = ["model", "harness", "intent"]
  const echoing = (kind: Agent["kind"]) => {
    const agent = makeScriptedAgent({ id: "jev", kind }, (input) => [sleep(100), agentText(`Did ${input.text}.`)])
    return { agent, setup: makeAgentSetup({ agents: [agent.agent], routing: { defaultAgent: "jev" } }) }
  }
  for (const kind of kinds) {
    it.effect(`${kind}: Stop, then an empty EndOfTurn, then the next utterance runs (it is not swallowed)`, () => {
      const jev = echoing(kind)
      const t = harness(jev.setup)
      return Effect.gen(function*() {
        yield* run([speechStarted, sleep(10), stop, sleep(10), endOfTurn(""), sleep(500), speechStarted, endOfTurn("turn on the kitchen lights")])
        assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["turn on the kitchen lights"])
      }).pipe(Effect.provide(t.layer))
    })
    it.effect(`${kind}: an empty or blank EndOfTurn starts no turn, no history, no audio`, () => {
      const jev = echoing(kind)
      const t = harness(jev.setup)
      return Effect.gen(function*() {
        yield* run([speechStarted, endOfTurn(""), sleep(200), speechStarted, endOfTurn("   "), sleep(200), speechStarted, endOfTurn(" ? ")])
        assert.deepStrictEqual(jev.agent.probe.inputs, [])
        assert.strictEqual(started(t.events), 0)
        assert.deepStrictEqual(yield* history, [])
        assert.deepStrictEqual(t.out.probe.chunks, [])
      }).pipe(Effect.provide(t.layer))
    })
    it.effect(`${kind}: an empty EagerEndOfTurn starts nothing; one after real words discards their speculative turn`, () => {
      const jev = echoing(kind)
      const t = harness(jev.setup)
      return Effect.gen(function*() {
        yield* run([speechStarted, eagerEndOfTurn(""), sleep(100), eagerEndOfTurn("turn on"), sleep(20), eagerEndOfTurn(" "), sleep(20), endOfTurn("")])
        assert.strictEqual(t.out.probe.chunks.length, 0, "nothing played")
        assert.deepStrictEqual(yield* history, [], "nothing committed")
        assert.isTrue((yield* traces).every((tr) => tr.outcome === "discarded"), "any speculative turn was discarded")
        // The utterance is closed: the next one runs normally.
        yield* run([speechStarted, endOfTurn("lights on")])
        assert.include(jev.agent.probe.inputs.map((i) => i.text), "lights on")
      }).pipe(Effect.provide(t.layer))
    })
  }
  it.effect("no agent at all: an empty EndOfTurn speaks no canned reply", () => {
    const t = harness(makeAgentSetup({ agents: [], routing: { defaultAgent: "main" } }))
    return Effect.gen(function*() {
      yield* run([speechStarted, endOfTurn(""), sleep(500)])
      assert.deepStrictEqual(t.out.probe.chunks, [])
      assert.strictEqual(started(t.events), 0)
      // A real request still gets the canned reply.
      yield* run([speechStarted, endOfTurn("hello")])
      assert.isAbove(t.out.probe.chunks.length, 0)
    }).pipe(Effect.provide(t.layer))
  })
})
