// Review round 5 in Conversation: every promotion compares canonical texts, whatever agent kind
// planned the turn (finding 1: a model agent hands "yes" to the intent agent, final "yes?"), and an
// empty EagerEndOfTurn neither closes the utterance nor lifts a Stop (finding 4).
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
const stop: ConversationInput = { _tag: "Interrupt" }

/** `home.all_off` needs a confirmation; the provider says "it answers" and "it is a yes" to anything. */
const house = (mainScript: (text: string) => ReadonlyArray<ReturnType<typeof agentText> | ReturnType<typeof agentFails>>) => {
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
  const main = makeScriptedAgent({ id: "main" }, (input) => mainScript(input.text))
  const setup = makeAgentSetup({
    agents: [main.agent, jev],
    routing: { defaultAgent: "main", fallbackAgent: "jev" },
    extra: { actions, deciders: new Map([["keywords", decider]]) }
  })
  return { runs, setup, main }
}

describe("finding 1: a turn that reaches the intent agent by hand-off or fallback is promoted only for the same canonical text", () => {
  const sequence = (final: string): ReadonlyArray<ConversationInput | Sleep> => [
    speechStarted, endOfTurn("hey jev switch everything off"), sleep(1_000),
    { _tag: "SetActiveAgent", agentId: "main" }, sleep(10),
    speechStarted, eagerEndOfTurn("yes"), sleep(50), endOfTurn(final), sleep(1_000)
  ]
  it.effect("hand-off: main hands eager 'yes' to jev, final 'yes?': nothing is switched off", () => {
    const h = house(() => [handoff("not mine")])
    const t = harness(h.setup)
    return Effect.gen(function*() {
      yield* run(sequence("yes?"))
      assert.deepStrictEqual(h.runs, [], "nothing was switched off")
      assert.include((yield* traces).map((tr) => tr.outcome), "discarded")
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("failure fallback: main fails on eager 'yes', jev takes it, final 'yes?': nothing is switched off", () => {
    const h = house(() => [agentFails("failed")])
    const t = harness(h.setup)
    return Effect.gen(function*() {
      yield* run(sequence("yes?"))
      assert.deepStrictEqual(h.runs, [], "nothing was switched off")
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("hand-off: final 'Yes.' is the same canonical text: promoted, confirmed", () => {
    const h = house(() => [handoff("not mine")])
    const t = harness(h.setup)
    return Effect.gen(function*() {
      yield* run(sequence("Yes."))
      assert.deepStrictEqual(h.runs, ["all_off"])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("a model turn is promoted only for the same canonical text too ('five' vs 'five?')", () => {
    const main = makeScriptedAgent({ id: "main" }, (input) => [agentText(`(${input.text})`)])
    const t = harness(makeAgentSetup({ agents: [main.agent], routing: { defaultAgent: "main" } }))
    return Effect.gen(function*() {
      yield* run([speechStarted, eagerEndOfTurn("set it to five"), sleep(50), endOfTurn("set it to five?"), sleep(500)])
      assert.deepStrictEqual(main.probe.inputs.map((i) => i.text), ["set it to five", "set it to five?"])
      yield* run([speechStarted, eagerEndOfTurn("set it to five"), sleep(50), endOfTurn("Set it to five."), sleep(500)])
      // Case differs: not the same canonical text either.
      assert.strictEqual(main.probe.inputs.length, 4)
      yield* run([speechStarted, eagerEndOfTurn("set it to five"), sleep(50), endOfTurn("set it to five."), sleep(500)])
      assert.strictEqual(main.probe.inputs.length, 5, "a final '.' is ignorable: promoted")
    }).pipe(Effect.provide(t.layer))
  })
})

describe("finding 4: an empty EagerEndOfTurn neither ends the utterance nor lifts a Stop", () => {
  const kinds: ReadonlyArray<Agent["kind"]> = ["model", "harness", "intent"]
  for (const kind of kinds) {
    it.effect(`${kind}: Stop, empty EagerEndOfTurn, then the rest of the stopped utterance starts nothing`, () => {
      const agent = makeScriptedAgent({ id: "jev", kind }, (input) => [agentText(`Did ${input.text}.`)])
      const t = harness(makeAgentSetup({ agents: [agent.agent], routing: { defaultAgent: "jev" } }))
      return Effect.gen(function*() {
        yield* run([
          speechStarted, eagerEndOfTurn("turn on"), sleep(20), stop, sleep(10),
          eagerEndOfTurn(""), sleep(20), eagerEndOfTurn("turn on the kitchen lights"), sleep(20), endOfTurn("turn on the kitchen lights"), sleep(500)
        ])
        assert.deepStrictEqual(agent.probe.inputs.map((i) => i.text).filter((x) => x !== "turn on"), [], "nothing after Stop ran")
        assert.deepStrictEqual(t.out.probe.chunks, [])
        // The utterance ended with its EndOfTurn: the next one runs.
        yield* run([speechStarted, endOfTurn("lights on"), sleep(500)])
        assert.include(agent.probe.inputs.map((i) => i.text), "lights on")
      }).pipe(Effect.provide(t.layer))
    })
  }
})
