import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Conversation } from "../src/Conversation.ts"
import type { SttEvent, UtteranceTimes } from "../src/Domain.ts"
import { makeTool } from "../src/Module.ts"
import { ToolRegistry } from "../src/ToolRegistry.ts"
import { makeTurnTrace, MAX_TRACE_EVENTS, traceTimeline, TurnTrace } from "../src/TurnTrace.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  interim,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedLlm,
  scripted,
  type Sleep,
  sleep,
  speechStarted,
  testTurnTraceLayer,
  textDelta,
  toolCall,
  turnResumed
} from "../src/testing.ts"

const advance = (millis: number) =>
  Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const run = (options: { readonly llm: Parameters<typeof makeScriptedLlm>[0]; readonly tools?: ReadonlyArray<ReturnType<typeof makeTool>> }, script: ReadonlyArray<SttEvent | Sleep>) => {
  const llm = makeScriptedLlm(options.llm)
  const tts = makeTtsOut()
  const conversation = Conversation.layer({ systemPrompt: "sys" }).pipe(
    Layer.provideMerge(Layer.mergeAll(llm.layer, ToolRegistry.layer([{ name: "test", tools: options.tools ?? [], context: [] }]), testTurnTraceLayer))
  )
  return Effect.gen(function*() {
    const fiber = yield* Effect.flatMap(Effect.service(Conversation), (c) => Effect.forkChild(c.voice(scripted(script))))
    yield* advance(2_000)
    yield* Fiber.join(fiber)
    const traces = yield* Effect.flatMap(Effect.service(TurnTrace), (tt) => tt.recent)
    return traces[traces.length - 1]!
  }).pipe(Effect.provide(Layer.mergeAll(conversation, tts.tts.layer, tts.out.layer)))
}
const makeTtsOut = () => ({ tts: makeMarkerTts({ delayMillis: 20 }), out: makeRecordingAudioOutput({ chunkMillis: 100 }) })

const at = (events: ReadonlyArray<{ readonly name: string; readonly at: number }>, name: string) => events.find((e) => e.name === name)?.at

describe("the turn's time line", () => {
  it.effect("a speculative voice turn: hearing before the end of turn, then the reply", () =>
    Effect.gen(function*() {
      const trace = yield* run(
        { llm: [[textDelta("It is noon.")]] },
        [speechStarted, sleep(50), interim("what"), sleep(100), eagerEndOfTurn("what time is it"), sleep(200), endOfTurn("what time is it.")]
      )
      const line = traceTimeline(trace)
      const names = line.map((e) => e.name)
      const origin = trace.marks.endOfTurn!
      const rel = (name: string) => at(line, name)! - origin
      assert.deepStrictEqual(line.map((e) => e.at), line.map((e) => e.at).sort((a, b) => a - b), "ordered by time")
      assert.isBelow(rel("speechStarted"), rel("firstInterim"))
      assert.isBelow(rel("firstInterim"), rel("eagerEndOfTurn"))
      assert.isBelow(rel("eagerEndOfTurn"), 0)
      assert.strictEqual(rel("endOfTurn"), 0)
      assert.isAtMost(rel("eagerEndOfTurn"), rel("llmRequestSent"))
      assert.isBelow(rel("llmRequestSent"), rel("llmFirstToken") + 1e-9)
      for (const name of ["turnStarted", "llmDone", "firstClause", "ttsFirstAudio", "ttsDone", "audioSent", "playbackStart", "playbackEnd", "turnEnded"]) {
        assert.include(names, name)
      }
      assert.strictEqual(line.find((e) => e.name === "llmRequestSent")!.detail, "round 1")
      assert.strictEqual(line.find((e) => e.name === "turnEnded")!.detail, "completed")
      assert.strictEqual(names.filter((n) => n === "llmRequestSent").length, 1, "the mark and the round event are one entry")
      assert.isBelow(rel("playbackStart"), rel("playbackEnd"))
    }))

  it.effect("a discarded speculative turn still gives the final turn the utterance's speechStarted and the resume", () =>
    Effect.gen(function*() {
      const trace = yield* run(
        { llm: (_, i) => [textDelta(`answer ${i}`)] },
        [eagerEndOfTurn("turn on"), sleep(100), turnResumed, sleep(100), endOfTurn("turn on the light")]
      )
      const line = traceTimeline(trace)
      assert.isFalse(trace.speculative)
      assert.isDefined(at(line, "speechStarted"))
      assert.isDefined(at(line, "turnResumed"))
      assert.isBelow(at(line, "speechStarted")!, at(line, "turnResumed")!)
      assert.isBelow(at(line, "turnResumed")!, at(line, "endOfTurn")!)
    }))

  it.effect("a tool round: a tool span and per-round model events", () =>
    Effect.gen(function*() {
      const lookup = makeTool({
        name: "lookup",
        description: "lookup",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () => Effect.andThen(Effect.sleep(50), Effect.succeed("seen"))
      })
      const trace = yield* run(
        { tools: [lookup], llm: [[toolCall("t1", "lookup", {})], [textDelta("Done.")]] },
        [endOfTurn("look it up")]
      )
      const line = traceTimeline(trace)
      const tool = line.find((e) => e.name === "tool")!
      assert.strictEqual(tool.detail, "lookup")
      assert.isAtLeast(tool.ms!, 50)
      assert.deepStrictEqual(trace.tools.map((t) => t.name), ["lookup"])
      assert.deepStrictEqual(line.filter((e) => e.name === "llmRequestSent").map((e) => e.detail), ["round 1", "round 2"])
      assert.deepStrictEqual(line.filter((e) => e.name === "llmDone").map((e) => e.detail), ["round 1", "round 2"])
      const [r1, r2] = line.filter((e) => e.name === "llmRequestSent")
      assert.isAtLeast(r2!.at, tool.at + tool.ms!, "round 2 asks after the tool finished")
      assert.isAtLeast(tool.at, r1!.at)
    }))
})

describe("the recogniser's own times", () => {
  it.effect("a session's `heard` stamps win over the time the loop handles the events (a gate held them back)", () =>
    Effect.gen(function*() {
      const times: UtteranceTimes = { startedAt: 3, firstInterimAt: 7 }
      const trace = yield* run(
        { llm: [[textDelta("Ok.")]] },
        [{ _tag: "SpeechStarted", heard: times }, sleep(500), endOfTurn("hello there")]
      )
      const line = traceTimeline(trace)
      assert.strictEqual(at(line, "speechStarted"), 3)
      assert.strictEqual(at(line, "firstInterim"), 7)
      assert.strictEqual(at(line, "endOfTurn"), 500)
    }))
})

describe("TurnTrace.event", () => {
  it("is capped and keeps the marks, the start and the end outside the cap", () => {
    let t = 0
    const tt = makeTurnTrace({ now: () => t })
    const trace = tt.begin("voice")
    tt.mark(trace, "endOfTurn")
    for (let i = 0; i < 500; i++) {
      t = i
      tt.event(trace, "tool", { ms: 1, detail: `t${i}` })
    }
    assert.strictEqual(trace.events!.length, MAX_TRACE_EVENTS)
    trace.endedAt = 1000
    trace.outcome = "completed"
    const line = traceTimeline(trace)
    assert.isAtMost(line.length, 200)
    assert.strictEqual(line[line.length - 1]!.name, "turnEnded")
    assert.strictEqual(line[0]!.name, "turnStarted")
  })

  it("leaves a trace without events as it was (no list allocated by begin or mark)", () => {
    const tt = makeTurnTrace({ now: () => 5 })
    const trace = tt.begin("text")
    tt.mark(trace, "llmRequestSent")
    assert.isUndefined(trace.events)
    assert.deepStrictEqual(traceTimeline(trace).map((e) => e.name), ["turnStarted", "llmRequestSent"])
  })
})
