// Latency guard for piece A: with scripted zero-delay fakes on the real clock, a
// turn through the agent path (router + agent + first-event timer) must be no
// slower than the single-model path it replaces. Prints both medians.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Stream } from "effect"
import type { Agent } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import type { ConversationEvent } from "../src/ConversationEvents.ts"
import type { LlmRequest } from "../src/Domain.ts"
import { makeModelAgent } from "../src/ModelAgent.ts"
import { defaultRoutingConfig, makeTriggerRouter } from "../src/Routing.ts"
import { Llm } from "../src/Services.ts"
import { makeToolRegistry, ToolRegistry } from "../src/ToolRegistry.ts"
import { type Trace, TurnTrace } from "../src/TurnTrace.ts"
import { endOfTurn, speechStarted, makeAgentSetup, makeMarkerTts, makeRecordingAudioOutput, makeScriptedAgent, makeScriptedLlm, textDelta } from "../src/testing.ts"

const TURNS = 150
const reply = (_: LlmRequest) => [textDelta("Hi! "), textDelta("What can I do for you today?")]

const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

/** Run `TURNS` voice turns, each after the previous one ended; end of turn → playback start of each. */
const measure = (layer: (onEvent: (e: ConversationEvent) => void) => Layer.Layer<Conversation | TurnTrace>) =>
  Effect.gen(function*() {
    const ended = yield* Queue.unbounded<Trace>()
    const onEvent = (e: ConversationEvent) => {
      if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
    }
    const deltas: Array<number> = []
    const events = Stream.range(1, TURNS).pipe(
      Stream.flatMap((i) =>
        Stream.make(speechStarted, endOfTurn(`Hello number ${i}.`)).pipe(Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
          const trace = yield* Queue.take(ended)
          deltas.push(trace.marks.playbackStart! - trace.marks.endOfTurn!)
        })))), { concurrency: 1 })
    )
    yield* Effect.gen(function*() {
      const c = yield* Conversation
      yield* c.voice(events)
    }).pipe(Effect.provide(Layer.mergeAll(layer(onEvent), makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
    return median(deltas.slice(20)) // the first turns warm up the JIT
  })

const legacy = (onEvent: (e: ConversationEvent) => void) =>
  Conversation.layer({ systemPrompt: "Benchmark.", onEvent }).pipe(
    Layer.provideMerge(Layer.mergeAll(makeScriptedLlm(reply).layer, ToolRegistry.layer([]), TurnTrace.layer()))
  )

const agents = (onEvent: (e: ConversationEvent) => void) =>
  Layer.unwrap(Effect.gen(function*() {
    const llm = yield* Effect.provide(Effect.service(Llm), makeScriptedLlm(reply).layer)
    const main: Agent = { id: "anthropic", name: "Claude", kind: "model", speculate: true, firstEventTimeoutMs: 5_000, turn: makeModelAgent({ llm }).turn }
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, []).agent
    const setup = makeAgentSetup({ agents: [main, jev], routing: { defaultAgent: "anthropic" }, registry: makeToolRegistry([]), system: "Benchmark." })
    return Conversation.layerWithAgents({ setup: Effect.sync(() => setup), onEvent }).pipe(Layer.provideMerge(TurnTrace.layer()))
  }))

describe("agent path latency", () => {
  it.live("a turn through router + model agent is no slower than the single-model path", () =>
    Effect.gen(function*() {
      const legacyRuns: Array<number> = []
      const agentRuns: Array<number> = []
      for (let i = 0; i < 3; i++) {
        legacyRuns.push(yield* measure(legacy))
        agentRuns.push(yield* measure(agents))
      }
      const before = median(legacyRuns)
      const after = median(agentRuns)
      console.log(`end of turn -> playback start, zero-delay fakes, median of ${TURNS - 20} turns x 3: single-model ${before.toFixed(3)} ms, agents ${after.toFixed(3)} ms`)
      assert.isBelow(after, before * 1.25 + 0.25, `agent path ${after.toFixed(3)} ms vs single-model ${before.toFixed(3)} ms`)
    }), 60_000)

  it("routing an utterance costs microseconds", () => {
    const router = makeTriggerRouter(defaultRoutingConfig)
    const isAvailable = () => true
    const utterances = ["Hey Jeff, turn on the lights in the living room.", "What is the weather like in Amsterdam tomorrow?", "hey claude tell me a joke"]
    for (let i = 0; i < 2_000; i++) router.route({ text: utterances[i % 3]!, source: "voice", state: {}, now: i, isAvailable })
    const n = 20_000
    const start = performance.now()
    for (let i = 0; i < n; i++) router.route({ text: utterances[i % 3]!, source: "voice", state: {}, now: i, isAvailable })
    const perRoute = ((performance.now() - start) / n) * 1000
    console.log(`routing: ${perRoute.toFixed(1)} µs per utterance (default rules)`)
    assert.isBelow(perRoute, 200)
  })
})
