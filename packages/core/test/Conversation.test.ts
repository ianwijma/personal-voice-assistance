import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Conversation, runVoice } from "../src/Conversation.ts"
import type { LlmRequest, Message, SttEvent } from "../src/Domain.ts"
import { type ContextProvider, makeTool, type Tool } from "../src/Module.ts"
import { ToolRegistry } from "../src/ToolRegistry.ts"
import { Tts } from "../src/Services.ts"
import { TurnTrace } from "../src/TurnTrace.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  type LlmScript,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedAudioInput,
  makeScriptedLlm,
  makeScriptedStt,
  scripted,
  type Sleep,
  sleep,
  speechStarted,
  textDelta,
  toolCall,
  turnResumed,
  testTurnTraceLayer
} from "../src/testing.ts"

interface Setup {
  readonly llm: ReadonlyArray<LlmScript> | ((request: LlmRequest, index: number) => LlmScript)
  readonly tools?: ReadonlyArray<Tool>
  readonly context?: ReadonlyArray<ContextProvider>
  readonly bargeIn?: boolean
  readonly maxToolRounds?: number
  readonly ttsDelay?: number
  readonly chunkMillis?: number
}

const setup = (options: Setup) => {
  const llm = makeScriptedLlm(options.llm)
  const tts = makeMarkerTts({ delayMillis: options.ttsDelay ?? 0 })
  const out = makeRecordingAudioOutput({ chunkMillis: options.chunkMillis ?? 100 })
  const conversation = Conversation.layer({
    systemPrompt: "sys",
    ...(options.bargeIn !== undefined ? { bargeIn: options.bargeIn } : {}),
    ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {})
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(
      llm.layer,
      ToolRegistry.layer([{ name: "test", tools: options.tools ?? [], context: options.context ?? [] }]),
      testTurnTraceLayer
    ))
  )
  return { llm, tts, out, conversation, layer: Layer.mergeAll(conversation, tts.layer, out.layer) }
}

/**
 * `TestClock.adjust` waits only one scheduler hop before advancing time, so a
 * freshly forked chain of fibers may not have registered its first sleep yet.
 * Let them run first. (Fibers woken by the clock are tracked and settle.)
 */
const advance = (millis: number) =>
  Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

/** Fork the voice loop over a scripted event stream. */
const startVoice = (script: ReadonlyArray<SttEvent | Sleep>) =>
  Effect.flatMap(Effect.service(Conversation), (c) => Effect.forkChild(c.voice(scripted(script))))

const history = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const played = (out: ReturnType<typeof makeRecordingAudioOutput>) => out.probe.chunks.map((c) => c.text)
const outcomes = Effect.flatMap(Effect.service(TurnTrace), (t) => t.recent).pipe(
  Effect.map((traces) => traces.map((t) => t.outcome))
)

/** A tool that records the (clock) time each call started, then sleeps. */
const recordingTool = (name: string, speculative: boolean, millis = 0) => {
  const calls: Array<{ readonly at: number; readonly input: unknown }> = []
  const tool = makeTool({
    name,
    description: name,
    parameters: Schema.Struct({ key: Schema.optional(Schema.String) }),
    speculative,
    execute: (input) =>
      Effect.gen(function*() {
        calls.push({ at: yield* Clock.currentTimeMillis, input })
        if (millis > 0) yield* Effect.sleep(millis)
        return { key: input.key ?? null, value: 42 }
      })
  })
  return { tool, calls }
}

describe("Conversation", () => {
  it.effect("EndOfTurn without speculation: LLM → chunker → TTS → speaker, and history", () => {
    const t = setup({ llm: [[textDelta("Hello there. "), textDelta("How are you?")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hi")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)

      assert.deepStrictEqual(played(t.out), ["<Hello there.>", "<How are you?>"])
      assert.deepStrictEqual(t.out.probe.sampleRates, [24_000])
      assert.strictEqual(t.llm.probe.requests[0]!.system, "sys")
      assert.isFalse("context" in t.llm.probe.requests[0]!, "no context providers: no context field")
      assert.deepStrictEqual(t.llm.probe.requests[0]!.messages, [{ role: "user", content: "hi" }])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello there. How are you?" }
      ])
      assert.deepStrictEqual(yield* outcomes, ["completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("EagerEndOfTurn starts a speculative turn that buffers audio; EndOfTurn with the same text promotes it", () => {
    const t = setup({ llm: [[sleep(100), textDelta("It is noon.")]], ttsDelay: 50 })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("what time is it"), sleep(300), endOfTurn("what time is it.")])
      yield* advance(250)
      // LLM and TTS already ran, but nothing played and nothing committed.
      assert.deepStrictEqual(t.tts.probe.clauses, ["It is noon."])
      assert.deepStrictEqual(played(t.out), [])
      assert.deepStrictEqual(yield* history, [])

      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<It is noon.>", at: 300 }])
      assert.strictEqual(t.llm.probe.requests.length, 1)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "what time is it" },
        { role: "assistant", content: "It is noon." }
      ])
      const [trace] = yield* Effect.flatMap(Effect.service(TurnTrace), (tt) => tt.recent)
      assert.isTrue(trace!.speculative)
      assert.strictEqual(trace!.marks.endOfTurn, 300)
      assert.strictEqual(trace!.marks.llmFirstToken, 100)
      assert.strictEqual(trace!.marks.playbackStart, 300)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("TurnResumed interrupts and discards the speculative turn", () => {
    const t = setup({ llm: [[sleep(200), textDelta("Discarded.")], [textDelta("Done.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([
        eagerEndOfTurn("turn off"),
        sleep(50),
        turnResumed,
        sleep(100),
        endOfTurn("turn off the lights")
      ])
      yield* advance(1_000)
      yield* Fiber.join(fiber)

      assert.strictEqual(t.llm.probe.interrupted, 1)
      assert.strictEqual(t.llm.probe.requests.length, 2)
      assert.deepStrictEqual(played(t.out), ["<Done.>"])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "turn off the lights" },
        { role: "assistant", content: "Done." }
      ])
      assert.deepStrictEqual(yield* outcomes, ["discarded", "completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("EndOfTurn with different text discards the speculative turn and starts a normal one", () => {
    const t = setup({ llm: [[sleep(200), textDelta("Wrong.")], [textDelta("Timer set.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("set a timer"), sleep(50), endOfTurn("set a timer for ten minutes")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)

      assert.strictEqual(t.llm.probe.interrupted, 1)
      assert.deepStrictEqual(t.llm.probe.requests[1]!.messages, [{ role: "user", content: "set a timer for ten minutes" }])
      assert.deepStrictEqual(played(t.out), ["<Timer set.>"])
      assert.deepStrictEqual(yield* outcomes, ["discarded", "completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("barge-in interrupts the LLM stream, TTS and playback; history keeps only what was played", () => {
    const t = setup({ llm: [[textDelta("One. Two. "), sleep(10_000), textDelta("Three.")]], ttsDelay: 100 })
    return Effect.gen(function*() {
      // TTS "One." 0–100, plays 100–200; TTS "Two." 100–200; LLM sleeping. Barge in at 150.
      const fiber = yield* startVoice([endOfTurn("count"), sleep(150), speechStarted])
      yield* advance(20_000)
      yield* Fiber.join(fiber)

      assert.deepStrictEqual(played(t.out), ["<One.>"])
      assert.strictEqual(t.llm.probe.interrupted, 1)
      // One synthesis stream for the turn, cancelled by the barge-in.
      assert.deepStrictEqual([t.tts.probe.started, t.tts.probe.completed, t.tts.probe.interrupted], [1, 0, 1])
      assert.deepStrictEqual([t.out.probe.completed, t.out.probe.interrupted], [0, 1])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "count" },
        { role: "assistant", content: "One.", interrupted: true }
      ] satisfies Array<Message>)
      assert.deepStrictEqual(yield* outcomes, ["interrupted"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("barge-in when TTS ran far ahead of playback: history keeps only the clauses that started playing", () => {
    // A fast local engine synthesises every clause before the first one has finished playing,
    // so the audio of all three clauses is already queued when playback starts.
    const t = setup({ llm: [[textDelta("One. Two. Three.")]], ttsDelay: 0 })
    return Effect.gen(function*() {
      // Each clause is one 100 ms chunk: "One." plays 0–100, "Two." 100–200. Barge in at 150.
      const fiber = yield* startVoice([endOfTurn("count"), sleep(150), speechStarted])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(played(t.out), ["<One.>", "<Two.>"])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "count" },
        { role: "assistant", content: "One. Two.", interrupted: true }
      ] satisfies Array<Message>)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("SpeechStarted after EndOfTurn but before any audio interrupts the committed turn", () => {
    const t = setup({ llm: [[sleep(100), textDelta("Stale.")], [textDelta("Fresh.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([
        endOfTurn("hello"),
        sleep(10),
        speechStarted,
        sleep(50),
        endOfTurn("wait, actually")
      ])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(played(t.out), ["<Fresh.>"])
      assert.strictEqual(t.llm.probe.interrupted, 1)
      assert.deepStrictEqual([t.tts.probe.started, t.tts.probe.interrupted, t.tts.probe.completed], [2, 1, 1])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hello" },
        { role: "user", content: "wait, actually" },
        { role: "assistant", content: "Fresh." }
      ])
      assert.deepStrictEqual(yield* outcomes, ["interrupted", "completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("with barge-in disabled, SpeechStarted before any audio does not interrupt", () => {
    const t = setup({ llm: [[sleep(100), textDelta("Still here.")]], bargeIn: false })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hello"), sleep(10), speechStarted])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(played(t.out), ["<Still here.>"])
      assert.deepStrictEqual(yield* outcomes, ["completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("SpeechStarted leaves a pending speculative turn alone; EndOfTurn still promotes it", () => {
    const t = setup({ llm: [[sleep(100), textDelta("Hello.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("hi"), sleep(10), speechStarted, sleep(50), endOfTurn("hi")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.strictEqual(t.llm.probe.requests.length, 1)
      assert.strictEqual(t.llm.probe.interrupted, 0)
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<Hello.>", at: 100 }])
      assert.deepStrictEqual(yield* outcomes, ["completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("one TTS stream per turn, fed each clause as soon as the chunker emits it", () => {
    const t = setup({ llm: [[textDelta("One. Two. "), sleep(1_000), textDelta("Three.")]], ttsDelay: 100 })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("count")])
      yield* advance(50)
      // Both clauses reached the TTS at once, while the LLM stream is still open.
      assert.deepStrictEqual(t.tts.probe.arrivals, [{ text: "One.", at: 0 }, { text: "Two.", at: 0 }])

      yield* advance(2_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.tts.probe.arrivals.at(-1), { text: "Three.", at: 1_000 })
      assert.deepStrictEqual([t.tts.probe.started, t.tts.probe.completed], [1, 1])
      assert.deepStrictEqual(t.out.probe.chunks, [
        { text: "<One.>", at: 100 },
        { text: "<Two.>", at: 200 },
        { text: "<Three.>", at: 1_100 }
      ])
      const [trace] = yield* Effect.flatMap(Effect.service(TurnTrace), (tt) => tt.recent)
      assert.strictEqual(trace!.marks.firstClause, 0)
      assert.strictEqual(trace!.marks.ttsFirstAudio, 100)
      assert.strictEqual(trace!.marks.playbackStart, 100)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("context-provider output goes in LlmRequest.context, not in the system prompt", () => {
    const t = setup({
      llm: [[textDelta("Noon.")], [textDelta("Still noon.")]],
      context: [{ name: "clock", get: Effect.succeed("It is noon.") }]
    })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("time?")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      yield* Stream.runDrain((yield* Conversation).textTurn("and now?"))
      for (const request of t.llm.probe.requests) {
        assert.strictEqual(request.system, "sys")
        assert.strictEqual(request.context, "## clock\nIt is noon.")
      }
      assert.strictEqual(t.llm.probe.requests.length, 2)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("an LLM failure mid-turn plays what was already synthesised and commits it like an interruption", () => {
    const lookup = recordingTool("lookup", true)
    // No second response: the request after the tool round fails.
    const t = setup({ tools: [lookup.tool], llm: [[textDelta("Checking."), toolCall("1", "lookup", {})]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("check")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(played(t.out), ["<Checking.>"])
      assert.deepStrictEqual([t.tts.probe.started, t.tts.probe.completed], [1, 1])
      const committed = yield* history
      assert.deepStrictEqual(committed.map((m) => m.role), ["user", "assistant", "tool"])
      assert.deepStrictEqual(committed[1], {
        role: "assistant",
        content: "Checking.",
        toolCalls: [{ id: "1", name: "lookup", input: {} }]
      })
      assert.deepStrictEqual(yield* outcomes, ["failed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("with barge-in disabled, SpeechStarted while speaking is ignored", () => {
    const t = setup({ llm: [[textDelta("One. Two. "), sleep(1_000), textDelta("Three.")]], ttsDelay: 100, bargeIn: false })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("count"), sleep(150), speechStarted])
      yield* advance(20_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(played(t.out), ["<One.>", "<Two.>", "<Three.>"])
      assert.strictEqual(t.llm.probe.interrupted, 0)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "count" },
        { role: "assistant", content: "One. Two. Three." }
      ])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("tool loop: calls in one response run concurrently, results go back to the model", () => {
    const lookup = recordingTool("lookup", false, 100)
    const t = setup({
      tools: [lookup.tool],
      llm: [
        [textDelta("Let me check."), toolCall("t1", "lookup", { key: "a" }), toolCall("t2", "lookup", { key: "b" })],
        [textDelta("Both are 42.")]
      ]
    })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("look up a and b")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)

      assert.deepStrictEqual(lookup.calls.map((c) => c.at), [0, 0])
      // Text from both rounds goes through one synthesis stream.
      assert.deepStrictEqual(t.tts.probe.clauses, ["Let me check.", "Both are 42."])
      assert.strictEqual(t.tts.probe.started, 1)
      // What was said before the tool call plays while the tools run.
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<Let me check.>", at: 0 }, { text: "<Both are 42.>", at: 100 }])
      const toolCalls = [
        { id: "t1", name: "lookup", input: { key: "a" } },
        { id: "t2", name: "lookup", input: { key: "b" } }
      ]
      const results = [
        { id: "t1", name: "lookup", content: "{\"key\":\"a\",\"value\":42}", isError: false },
        { id: "t2", name: "lookup", content: "{\"key\":\"b\",\"value\":42}", isError: false }
      ]
      assert.deepStrictEqual(t.llm.probe.requests[1]!.messages, [
        { role: "user", content: "look up a and b" },
        { role: "assistant", content: "Let me check.", toolCalls },
        { role: "tool", results }
      ])
      assert.deepStrictEqual(t.llm.probe.requests[0]!.tools.map((s) => s.name), ["lookup"])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "look up a and b" },
        { role: "assistant", content: "Let me check.", toolCalls },
        { role: "tool", results },
        { role: "assistant", content: "Both are 42." }
      ])
      const [trace] = yield* Effect.flatMap(Effect.service(TurnTrace), (tt) => tt.recent)
      assert.deepStrictEqual(trace!.tools, [{ name: "lookup", ms: 100 }, { name: "lookup", ms: 100 }])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("tool loop stops at the round cap", () => {
    const lookup = recordingTool("lookup", true)
    const t = setup({
      tools: [lookup.tool],
      maxToolRounds: 2,
      llm: (_, index) => [toolCall(`t${index}`, "lookup", {})]
    })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("loop forever")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)

      assert.strictEqual(t.llm.probe.requests.length, 3)
      assert.strictEqual(lookup.calls.length, 2)
      const committed = yield* history
      assert.deepStrictEqual(committed.map((m) => m.role), ["user", "assistant", "tool", "assistant", "tool"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a speculative turn runs speculative tools but pauses at a non-speculative tool until promoted", () => {
    const lookup = recordingTool("lookup", true)
    const act = recordingTool("act", false)
    const t = setup({
      tools: [lookup.tool, act.tool],
      llm: [[toolCall("1", "lookup", {})], [toolCall("2", "act", {})], [textDelta("Done.")]]
    })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("do it"), sleep(500), endOfTurn("do it")])
      yield* advance(400)
      assert.deepStrictEqual(lookup.calls.map((c) => c.at), [0])
      assert.deepStrictEqual(act.calls, [])
      assert.strictEqual(t.llm.probe.requests.length, 2)

      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(act.calls.map((c) => c.at), [500])
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<Done.>", at: 500 }])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("discarding a speculative turn paused at a non-speculative tool never runs the tool", () => {
    const act = recordingTool("act", false)
    const t = setup({ tools: [act.tool], llm: [[toolCall("1", "act", {})]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("do it"), sleep(100), turnResumed])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(act.calls, [])
      assert.deepStrictEqual(played(t.out), [])
      assert.deepStrictEqual(yield* history, [])
      assert.deepStrictEqual(yield* outcomes, ["discarded"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a pending speculative turn at the end of the event stream is discarded", () => {
    const t = setup({ llm: [[textDelta("Never played.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("maybe")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(played(t.out), [])
      assert.deepStrictEqual(yield* outcomes, ["discarded"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("textTurn shares the LLM/tool-loop path and history, with no audio services", () => {
    const lookup = recordingTool("lookup", false)
    const t = setup({
      tools: [lookup.tool],
      llm: [
        [textDelta("Checking."), toolCall("1", "lookup", { key: "x" })],
        [textDelta("It is "), textDelta("42.")],
        [textDelta("You're welcome.")]
      ]
    })
    return Effect.gen(function*() {
      const c = yield* Conversation
      const first = yield* Stream.runCollect(c.textTurn("what is x"))
      assert.deepStrictEqual(first, ["Checking.", "\n", "It is ", "42."])
      yield* Stream.runCollect(c.textTurn("thanks"))
      assert.deepStrictEqual(t.llm.probe.requests[2]!.messages.map((m) => m.role), [
        "user",
        "assistant",
        "tool",
        "assistant",
        "user"
      ])
      const committed = yield* c.history
      assert.deepStrictEqual(committed.at(-1), { role: "assistant", content: "You're welcome." })
      assert.deepStrictEqual(committed[3], { role: "assistant", content: "It is 42." })
    }).pipe(Effect.provide(t.conversation)) // no Tts / AudioOutput in the context
  })

  it.effect("runVoice wires AudioInput → Stt → Conversation → Tts → AudioOutput", () => {
    const t = setup({ llm: [[textDelta("Hi!")]] })
    const stt = makeScriptedStt([sleep(100), endOfTurn("hello")])
    const mic = makeScriptedAudioInput([new Uint8Array(640)])
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(runVoice)
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<Hi!>", at: 100 }])
      assert.strictEqual(stt.probe.completed, 1)
    }).pipe(Effect.provide(Layer.mergeAll(t.layer, stt.layer, mic.layer)))
  })
})
