// P8 (review round 1, H1): what the risk policy costs on the turn path with serve mode's production reader: the record
// the real `Sections` publish with every committed save (`servePolicyReader`), over a real settings store on disk.
// docs/ARCHITECTURE.md quotes the printed numbers.
// - a read of the policy, also the first one after a committed save;
// - a gateway tool call with that reader against the same call through a gateway without a policy;
// - the same scripted turn (the real Conversation, a tool round through the registry and its gateway) with nothing saved
//   and with a saved policy, end of turn -> playbackStart with TurnTrace, counterbalanced, the difference under the
//   shared `bound(2)`.
import { Conversation, type ConversationEvent, makeExecutionGateway, makeTool, makeToolRegistry, type Trace, TurnTrace } from "@pva/core"
import { done, endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta, toolCall } from "@pva/core/testing"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bound, latencyDir } from "../../../packages/store-sqlite/test/latencyBound.ts"
import { servePolicyReader } from "../src/serve/riskPolicy.ts"
import { makeSections } from "../src/serve/sections.ts"
import { openStore } from "./support/store.ts"

const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

const lamp = makeTool({ name: "lamp", description: "Switch the lamp.", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") })

const sectionsOn = async (saved: boolean) => {
  const sections = makeSections(await Effect.runPromise(openStore(mkdtempSync(join(latencyDir("pva-risk"), "settings-")))), {})
  if (saved) await Effect.runPromise(sections.update("risk", { values: { RISK_MESSAGE: "allow", RISK_READ: "allow", RISK_CHANGE: "allow" }, secrets: {} }))
  return sections
}

describe("the risk policy's cost with serve's production reader", () => {
  it("a read of the policy (also right after a save) and a gateway call with it, against one without a policy", async () => {
    const sections = await sectionsOn(false)
    const read = servePolicyReader(sections)
    // A read right after each of 50 committed saves (what the next call after a save does).
    const afterSave: Array<number> = []
    for (let i = 0; i < 50; i++) {
      await Effect.runPromise(sections.update("risk", { values: { RISK_CHANGE: i % 2 === 0 ? "deny" : "allow" }, secrets: {} }))
      const t = performance.now()
      read()
      afterSave.push((performance.now() - t) * 1000)
    }
    const N = 1_000_000
    let t = performance.now()
    for (let i = 0; i < N; i++) read()
    const readNs = ((performance.now() - t) * 1e6) / N
    const withPolicy = makeExecutionGateway({ policy: read })
    const without = makeExecutionGateway()
    const CALLS = 20_000
    const per = (gateway: ReturnType<typeof makeExecutionGateway>) =>
      Effect.runPromise(Effect.gen(function*() {
        const start = performance.now()
        for (let i = 0; i < CALLS; i++) yield* gateway.tool("home", lamp, {})
        return ((performance.now() - start) * 1000) / CALLS
      }))
    const a: Array<number> = []
    const b: Array<number> = []
    for (const order of [[true, false], [false, true], [true, false], [false, true], [true, false], [false, true]] as const) {
      for (const w of order) (w ? a : b).push(await per(w ? withPolicy : without))
    }
    const added = median(a) - median(b)
    console.log(
      `serve's policy read: ${readNs.toFixed(1)} ns; the first read after a committed save: median ${median(afterSave).toFixed(2)} µs (worst ${Math.max(...afterSave).toFixed(2)} µs); ` +
        `a gateway tool call: ${median(b).toFixed(2)} µs without a policy, ${median(a).toFixed(2)} µs with serve's reader and the decision (${added.toFixed(2)} µs added per call, median of 6 counterbalanced runs of ${CALLS} calls)`
    )
    expect(readNs / 1e6).toBeLessThan(bound(0.0005))
    expect(median(afterSave) / 1000).toBeLessThan(bound(0.01))
    expect(added / 1000).toBeLessThan(bound(0.01))
  }, 120_000)

  it("a turn has the same timings with nothing saved and with a saved policy (TurnTrace, counterbalanced)", async () => {
    const TURNS = 100
    const WARM = 20
    const measure = (saved: boolean) =>
      Effect.gen(function*() {
        const sections = yield* Effect.promise(() => sectionsOn(saved))
        const gateway = makeExecutionGateway({ policy: servePolicyReader(sections), language: () => "en" })
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
              const tr = yield* Queue.take(ended)
              audible.push(tr.marks.playbackStart! - tr.marks.endOfTurn!)
              decisions += tr.calls?.length ?? 0
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
      for (const w of order) (w ? saved : unsaved).push(await Effect.runPromise(measure(w)))
    }
    const m = (xs: ReadonlyArray<Run>, k: "audible" | "p95") => median(xs.map((x) => x[k]))
    console.log(
      `TurnTrace with serve's reader, end of turn -> playbackStart, median of ${TURNS - WARM} turns x 4 counterbalanced runs (a tool round; the model's tokens 5 ms after each request): ` +
        `nothing saved ${m(unsaved, "audible").toFixed(3)} ms (p95 ${m(unsaved, "p95").toFixed(3)}), a saved policy ${m(saved, "audible").toFixed(3)} ms (p95 ${m(saved, "p95").toFixed(3)})`
    )
    for (const run of [...unsaved, ...saved]) expect(run.decisions).toBe(TURNS)
    expect(Math.abs(m(saved, "audible") - m(unsaved, "audible"))).toBeLessThan(bound(2))
  }, 240_000)
})

