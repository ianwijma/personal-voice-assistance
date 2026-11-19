// P8: what the risk policy costs on the turn path (docs/MODULES.md §4 quotes the printed numbers). Nothing runs on the
// turn path but one pure decision per call and one per tool of a list read after a change:
// - `decideRisk` alone, and a gateway call with the policy read (serve mode's reader: a decoder over map lookups) against
//   the same call through a gateway without a policy;
// - reading a turn's tool list: after the policy changed (one decision per tool, 64 tools) and when it did not (a key
//   comparison);
// - the same scripted turn (the real Conversation, a tool round through the registry and its gateway) with no saved
//   policy and with a saved one: end of turn -> playbackStart with TurnTrace, counterbalanced, the difference under the
//   shared `bound(2)`.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { Conversation } from "../src/Conversation.ts"
import type { ConversationEvent } from "../src/ConversationEvents.ts"
import { makeExecutionGateway } from "../src/Gateway.ts"
import { makeTool } from "../src/Module.ts"
import { decideRisk, decodeRiskPolicy, DEFAULT_RISK_POLICY, type RiskPolicy } from "../src/RiskPolicy.ts"
import { done, endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta, toolCall } from "../src/testing.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { type Trace, TurnTrace } from "../src/TurnTrace.ts"
import { bound } from "../../store-sqlite/test/latencyBound.ts"

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

/** Serve mode's reader: the effective values of the flat keys (a cached map read), through the decoder, at every call. */
const readerOver = (values: ReadonlyMap<string, unknown>) => () => decodeRiskPolicy((key) => values.get(key))
const UNSAVED = new Map<string, unknown>([["HOME_LANGUAGE", "en-GB"]])
const SAVED = new Map<string, unknown>([["HOME_LANGUAGE", "en-GB"], ["RISK_READ", "allow"], ["RISK_CHANGE", "allow"], ["RISK_MESSAGE", "allow"]])

const lamp = makeTool({ name: "lamp", description: "Switch the lamp.", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") })

describe("the risk policy's cost on the turn path", () => {
  it.effect("one decision, and a gateway call with the policy against one without", () =>
    Effect.gen(function*() {
      // decideRisk alone.
      const N = 1_000_000
      const declared = ["change", "security"] as const
      let allowed = 0
      const t0 = performance.now()
      for (let i = 0; i < N; i++) if (decideRisk(DEFAULT_RISK_POLICY, declared, i & 1 ? "change" : "security").outcome === "allow") allowed++
      const decideNs = ((performance.now() - t0) * 1e6) / N
      assert.strictEqual(allowed, N / 2)
      // A whole gateway call (validation, the principal, the decision with serve mode's reader, execute), with and without.
      const withPolicy = makeExecutionGateway({ policy: readerOver(SAVED) })
      const without = makeExecutionGateway()
      const CALLS = 20_000
      const per = (gateway: ReturnType<typeof makeExecutionGateway>) =>
        Effect.gen(function*() {
          const t = performance.now()
          for (let i = 0; i < CALLS; i++) yield* gateway.tool("home", lamp, {})
          return ((performance.now() - t) * 1000) / CALLS
        })
      const a: Array<number> = []
      const b: Array<number> = []
      for (const order of [[true, false], [false, true], [true, false], [false, true], [true, false], [false, true]] as const) {
        for (const w of order) (w ? a : b).push(yield* per(w ? withPolicy : without))
      }
      const added = median(a) - median(b)
      console.log(
        `decideRisk: ${decideNs.toFixed(1)} ns per decision; a gateway tool call: ${median(b).toFixed(2)} µs without a policy, ${median(a).toFixed(2)} µs with the saved policy read and decided ` +
          `(${added.toFixed(2)} µs added per call, median of 6 counterbalanced runs of ${CALLS} calls)`
      )
      assert.isBelow(decideNs / 1e6, bound(0.001)) // under 1 µs per decision
      assert.isBelow(added / 1000, bound(0.01)) // under 10 µs added per call
    }))

  it("a turn's tool list: one decision per tool after a change, a key comparison otherwise (64 tools)", () => {
    let policy: RiskPolicy = DEFAULT_RISK_POLICY
    const gateway = makeExecutionGateway({ policy: () => policy })
    const tools = Array.from({ length: 64 }, (_, i) =>
      makeTool({ name: `t${i}`, description: "", parameters: Schema.Struct({}), risk: i % 2 === 0 ? "change" : { classes: ["change", "security"], of: () => "change" }, execute: () => Effect.succeed("") }))
    const registry = makeToolRegistry([{ name: "m", tools }], { gateway })
    const ROUNDS = 2_000
    const changed: Array<number> = []
    const steady: Array<number> = []
    for (let i = 0; i < ROUNDS; i++) {
      policy = i % 2 === 0 ? { ...DEFAULT_RISK_POLICY, change: "deny" } : DEFAULT_RISK_POLICY
      let t = performance.now()
      const list = registry.specs
      changed.push(performance.now() - t)
      assert.strictEqual(list.length, i % 2 === 0 ? 0 : 64)
      t = performance.now()
      void registry.specs
      steady.push(performance.now() - t)
    }
    console.log(
      `a tool list of 64 tools read: after a change ${(median(changed) * 1000).toFixed(1)} µs (p95 ${(p95(changed) * 1000).toFixed(1)} µs), ` +
        `unchanged ${(median(steady) * 1000).toFixed(2)} µs (p95 ${(p95(steady) * 1000).toFixed(2)} µs)`
    )
    assert.isBelow(median(changed), bound(0.2))
    assert.isBelow(median(steady), bound(0.02))
  })

  it.live("a turn has the same timings with and without a saved policy (TurnTrace, counterbalanced)", () =>
    Effect.gen(function*() {
      const TURNS = 100
      const WARM = 20
      const measure = (values: ReadonlyMap<string, unknown>) =>
        Effect.gen(function*() {
          const gateway = makeExecutionGateway({ policy: readerOver(values), language: () => "en" })
          const registry = makeToolRegistry([{ name: "home", tools: [lamp] }], { gateway })
          const ended = yield* Queue.unbounded<Trace>()
          const onEvent = (e: ConversationEvent) => {
            if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
          }
          const audible: Array<number> = []
          let decisions = 0
          const events = Stream.range(1, TURNS).pipe(
            Stream.flatMap((i) =>
              Stream.make(speechStarted, endOfTurn(`Turn ${i}`)).pipe(Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
                const t = yield* Queue.take(ended)
                audible.push(t.marks.playbackStart! - t.marks.endOfTurn!)
                decisions += t.calls?.length ?? 0
              })))), { concurrency: 1 })
          )
          const llm = makeScriptedLlm((request) => {
            const last = request.messages[request.messages.length - 1]
            if (last?.role === "tool") return [sleep(5), textDelta("The lamp is on.")]
            return [sleep(5), toolCall(`t${audible.length}`, "lamp", {}), done("tool_use")]
          })
          const layer = Conversation.layerWithSetup({
            onEvent,
            setup: Effect.sync(() => ({ system: "Benchmark.", registry, turnContext: { deviceId: "d-kitchen-0001", assistantId: "jeff" } }))
          }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, TurnTrace.layer())))
          yield* Effect.gen(function*() {
            const c = yield* Conversation
            yield* c.voice(events)
          }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
          return { audible: median(audible.slice(WARM)), p95: p95(audible.slice(WARM)), decisions }
        })
      type Run = { audible: number; p95: number; decisions: number }
      const unsaved: Array<Run> = []
      const saved: Array<Run> = []
      for (const order of [[false, true], [true, false], [false, true], [true, false]] as const) {
        for (const w of order) (w ? saved : unsaved).push(yield* measure(w ? SAVED : UNSAVED))
      }
      const m = (xs: ReadonlyArray<Run>, k: "audible" | "p95") => median(xs.map((x) => x[k]))
      console.log(
        `TurnTrace, end of turn -> playbackStart, median of ${TURNS - WARM} turns x 4 counterbalanced runs (a tool round; the model's tokens 5 ms after each request): ` +
          `no saved policy ${m(unsaved, "audible").toFixed(3)} ms (p95 ${m(unsaved, "p95").toFixed(3)}), ` +
          `a saved policy ${m(saved, "audible").toFixed(3)} ms (p95 ${m(saved, "p95").toFixed(3)})`
      )
      // Every turn's call was decided and recorded on its trace, in both.
      for (const run of [...unsaved, ...saved]) assert.strictEqual(run.decisions, TURNS)
      assert.isBelow(Math.abs(m(saved, "audible") - m(unsaved, "audible")), bound(2))
    }), 240_000)
})
