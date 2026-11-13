// The serve-mode additions to Conversation (docs/UI-AND-MODULES.md §4.3): events,
// playback reports, typed input and Stop, the per-turn setup snapshot, initial history.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Conversation } from "../src/Conversation.ts"
import type { ConversationEvent, ConversationInput, TurnSetup } from "../src/ConversationEvents.ts"
import type { LlmRequest, Message } from "../src/Domain.ts"
import { makeTool } from "../src/Module.ts"
import { AudioOutput } from "../src/Services.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurnTrace, type Trace, TurnTrace } from "../src/TurnTrace.ts"
import { makeVoiceRouter } from "../src/VoiceRouter.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  type LlmScript,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeReportingAudioOutput,
  makeScriptedLlm,
  makeToneTts,
  scripted,
  type Sleep,
  sleep,
  speechStarted,
  testTurnTraceLayer,
  textDelta,
  toolCall,
  turnResumed
} from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const lookup = makeTool({
  name: "lookup",
  description: "lookup",
  parameters: Schema.Struct({ key: Schema.String }),
  speculative: true,
  execute: ({ key }) => Effect.as(Effect.sleep(50), `value of ${key}`)
})

interface Options {
  readonly llm: ReadonlyArray<LlmScript> | ((request: LlmRequest, index: number) => LlmScript)
  readonly output?: "recording" | "reporting"
  readonly reporting?: Parameters<typeof makeReportingAudioOutput>[0]
  readonly bargeIn?: boolean
  readonly setup?: Effect.Effect<TurnSetup>
  readonly initialHistory?: ReadonlyArray<Message>
}

const setup = (options: Options) => {
  const events: Array<ConversationEvent> = []
  const llm = makeScriptedLlm(options.llm)
  const tts = makeMarkerTts()
  const recording = makeRecordingAudioOutput({ chunkMillis: 100 })
  const reporting = makeReportingAudioOutput(options.reporting ?? { chunkMillis: 100 })
  const output = options.output === "reporting" ? reporting.layer : recording.layer
  const conversation = Conversation.layerWithSetup({
    setup: options.setup ?? Effect.succeed({ system: "sys", registry: makeToolRegistry([{ name: "t", tools: [lookup] }]) }),
    onEvent: (event) => events.push(event),
    ...(options.bargeIn !== undefined ? { bargeIn: options.bargeIn } : {}),
    ...(options.initialHistory !== undefined ? { initialHistory: options.initialHistory } : {})
  }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)))
  return { events, llm, recording, reporting, layer: Layer.mergeAll(conversation, tts.layer, output) }
}

const startVoice = (script: ReadonlyArray<ConversationInput | Sleep>) =>
  Effect.flatMap(Effect.service(Conversation), (c) => Effect.forkChild(c.voice(scripted(script))))
const history = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const traces = Effect.flatMap(Effect.service(TurnTrace), (t) => t.recent)
const tags = (events: ReadonlyArray<ConversationEvent>) => events.map((e) => e._tag)
const textInput = (text: string, speak: boolean): ConversationInput => ({ _tag: "TextInput", text, speak })
const stop: ConversationInput = { _tag: "Interrupt" }

describe("Conversation with playback reports", () => {
  it.effect("counts a clause as played from progress, not from being pulled; an interruption keeps only played clauses", () => {
    const t = setup({ llm: [[textDelta("One. "), textDelta("Two.")]], output: "reporting" })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hi"), sleep(50), speechStarted])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.reporting.probe.pulled, ["<One.>", "<Two.>"], "both clauses were sent")
      assert.deepStrictEqual(t.reporting.probe.chunks.map((c) => c.text), ["<One.>"], "only the first reached the device")
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "One.", interrupted: true }
      ])
      const playing = t.events.flatMap((e) => (e._tag === "ClausePlaying" ? [e.index] : []))
      assert.deepStrictEqual(playing, [0])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a clause that starts after the last progress report does not count; a later report counts it", () => {
    const t = setup({ llm: [[textDelta("One. "), textDelta("Two.")]], output: "reporting" })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hi"), sleep(150), speechStarted])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "One. Two.", interrupted: true }
      ])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("playback failing after a disconnect fails the turn and keeps what was reported played", () => {
    const t = setup({ llm: [[textDelta("One. "), textDelta("Two. "), textDelta("Three.")]], output: "reporting", reporting: { failAfterChunks: 1 } })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hi")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "One.", interrupted: true }
      ])
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["failed"])
      assert.strictEqual(t.events.at(-1)?._tag, "TurnEnded")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("playbackStart is marked when the output reports started, not when the first chunk is pulled", () => {
    const t = setup({ llm: [[textDelta("Hello.")]], output: "reporting", reporting: { chunkMillis: 100, startDelayMillis: 70 } })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hi")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      const [trace] = yield* traces
      assert.strictEqual(trace!.outcome, "completed")
      assert.strictEqual(trace!.marks.playbackStart! - trace!.marks.ttsFirstAudio!, 70)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("CurrentTurnTrace is provided around play (the web output reads the turn id from it)", () => {
    const seen: Array<number | undefined> = []
    const llm = makeScriptedLlm([[textDelta("Hi.")]])
    const out = Layer.succeed(AudioOutput, AudioOutput.of({
      play: (audio) =>
        Effect.gen(function*() {
          const trace: Trace | undefined = yield* CurrentTurnTrace
          seen.push(trace?.id)
          yield* Stream.runDrain(audio)
        })
    }))
    const layer = Layer.mergeAll(
      Conversation.layerWithSetup({ setup: Effect.succeed({ system: "s", registry: makeToolRegistry([]) }) }).pipe(
        Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer))
      ),
      makeMarkerTts().layer,
      out
    )
    return Effect.gen(function*() {
      const conversation = yield* Conversation
      yield* conversation.voice(scripted([endOfTurn("x")]))
      assert.deepStrictEqual(seen, [1])
    }).pipe(Effect.provide(layer))
  })
})

describe("Conversation events", () => {
  it.effect("a voice turn: started, deltas, clauses queued and playing, ended", () => {
    const t = setup({ llm: [[textDelta("Hello there. "), textDelta("How are you?")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("hi")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      const e = t.events
      assert.deepStrictEqual(e[0], { _tag: "TurnStarted", turnId: 1, source: "voice", text: "hi", speculative: false, spoken: true })
      const last = e.at(-1)!
      assert.strictEqual(last._tag, "TurnEnded")
      assert.strictEqual(last._tag === "TurnEnded" ? last.outcome : "", "completed")
      assert.strictEqual(e.flatMap((x) => (x._tag === "TextDelta" ? [x.text] : [])).join(""), "Hello there. How are you?")
      assert.deepStrictEqual(e.flatMap((x) => (x._tag === "ClauseQueued" ? [[x.index, x.text]] : [])), [[0, "Hello there."], [1, "How are you?"]])
      assert.deepStrictEqual(e.flatMap((x) => (x._tag === "ClausePlaying" ? [x.index] : [])), [0, 1])
      // The history was committed before TurnEnded is emitted.
      assert.strictEqual((yield* history).length, 2)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a tool turn: tool started and finished with its result and duration", () => {
    const t = setup({ llm: [[textDelta("Let me check. "), toolCall("c1", "lookup", { key: "k" })], [textDelta("Found it.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("look")])
      yield* advance(2_000)
      yield* Fiber.join(fiber)
      const started = t.events.find((x) => x._tag === "ToolStarted")
      const finished = t.events.find((x) => x._tag === "ToolFinished")
      assert.deepStrictEqual(started, { _tag: "ToolStarted", turnId: 1, call: { id: "c1", name: "lookup", input: { key: "k" } } })
      assert.deepStrictEqual(finished, {
        _tag: "ToolFinished",
        turnId: 1,
        result: { id: "c1", name: "lookup", content: "value of k", isError: false },
        ms: 50
      })
      const deltas = t.events.flatMap((x) => (x._tag === "TextDelta" ? [x.text] : [])).join("")
      assert.strictEqual(deltas, "Let me check. \nFound it.", "rounds are separated by a newline")
      assert.isTrue(tags(t.events).indexOf("ToolFinished") < tags(t.events).indexOf("TurnEnded"))
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a speculative turn is announced as speculative and promoted", () => {
    const t = setup({ llm: [[sleep(50), textDelta("Noon.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("what time"), sleep(200), endOfTurn("What time?")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.events[0], { _tag: "TurnStarted", turnId: 1, source: "voice", text: "what time", speculative: true, spoken: true })
      const promotedAt = tags(t.events).indexOf("TurnPromoted")
      const firstPlaying = tags(t.events).indexOf("ClausePlaying")
      assert.isTrue(promotedAt > 0 && promotedAt < firstPlaying, "nothing plays before the promotion")
      assert.isTrue(tags(t.events).indexOf("ClauseQueued") < promotedAt, "the clause was synthesised early")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a discarded speculative turn ends with outcome discarded", () => {
    const t = setup({ llm: [[sleep(500), textDelta("Noon.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([eagerEndOfTurn("what"), sleep(100), turnResumed])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(tags(t.events), ["TurnStarted", "TurnEnded"])
      const ended = t.events[1]!
      assert.strictEqual(ended._tag === "TurnEnded" ? ended.outcome : "", "discarded")
      assert.deepStrictEqual(yield* history, [])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("Conversation input: typed text and Stop", () => {
  it.effect("TextInput with speak: a spoken turn with source text", () => {
    const t = setup({ llm: [[textDelta("Spoken reply.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([textInput("typed", true)])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.events[0], { _tag: "TurnStarted", turnId: 1, source: "text", text: "typed", speculative: false, spoken: true })
      assert.deepStrictEqual(t.recording.probe.chunks.map((c) => c.text), ["<Spoken reply.>"])
      assert.deepStrictEqual(yield* history, [{ role: "user", content: "typed" }, { role: "assistant", content: "Spoken reply." }])
      assert.strictEqual((yield* traces)[0]!.mode, "text")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("TextInput without speak: nothing is synthesised or played, deltas are events, the whole reply is history", () => {
    const t = setup({ llm: [[textDelta("Only "), textDelta("text.")]] })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([textInput("typed", false)])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.strictEqual(t.recording.probe.started, 0)
      assert.isFalse(tags(t.events).includes("ClauseQueued"))
      assert.strictEqual(t.events.flatMap((x) => (x._tag === "TextDelta" ? [x.text] : [])).join(""), "Only text.")
      assert.deepStrictEqual(yield* history, [{ role: "user", content: "typed" }, { role: "assistant", content: "Only text." }])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("TextInput interrupts a running turn even with barge-in disabled", () => {
    const t = setup({ llm: [[textDelta("One. "), textDelta("Two. "), textDelta("Three.")], [textDelta("Second.")]], bargeIn: false })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("first"), sleep(150), textInput("second", false)])
      yield* advance(2_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "first" },
        { role: "assistant", content: "One. Two.", interrupted: true },
        { role: "user", content: "second" },
        { role: "assistant", content: "Second." }
      ])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("Interrupt stops the committed turn even with barge-in disabled; a pending speculative turn is left alone", () => {
    const t = setup({ llm: [[textDelta("One. "), textDelta("Two. "), textDelta("Three.")], [sleep(100), textDelta("Spec.")]], bargeIn: false })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("first"), sleep(150), stop, sleep(500), eagerEndOfTurn("next"), sleep(10), stop, sleep(200), endOfTurn("next")])
      yield* advance(3_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "first" },
        { role: "assistant", content: "One. Two.", interrupted: true },
        { role: "user", content: "next" },
        { role: "assistant", content: "Spec." }
      ])
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["interrupted", "completed"])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("Conversation setup and history", () => {
  it.effect("each turn uses the setup taken at its start; a change mid-turn applies from the next turn", () => {
    let system = "A"
    const t = setup({
      llm: [[toolCall("c1", "lookup", { key: "k" })], [textDelta("Done.")], [textDelta("Again.")]],
      setup: Effect.sync(() => ({ system, registry: makeToolRegistry([{ name: "t", tools: [lookup] }]) }))
    })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("one")])
      yield* advance(10)
      system = "B" // while the tool of turn 1 runs
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      const second = yield* startVoice([endOfTurn("two")])
      yield* advance(1_000)
      yield* Fiber.join(second)
      assert.deepStrictEqual(t.llm.probe.requests.map((r) => r.system), ["A", "A", "B"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("initialHistory is the start of the conversation", () => {
    const initial: ReadonlyArray<Message> = [{ role: "user", content: "earlier" }, { role: "assistant", content: "Yes." }]
    const t = setup({ llm: [[textDelta("Now.")]], initialHistory: initial })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("now")])
      yield* advance(1_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(t.llm.probe.requests[0]!.messages, [...initial, { role: "user", content: "now" }])
      assert.deepStrictEqual((yield* history).length, 4)
    }).pipe(Effect.provide(t.layer))
  })
})

describe("VoiceRouter sampleRate", () => {
  it.effect("a fixed output rate resamples the default voice too", () =>
    Effect.gen(function*() {
      const tone = makeToneTts({ sampleRate: 24_000, millisPerClause: 100, chunks: 1 })
      const router = makeVoiceRouter({ voices: [{ name: "a", description: "a", tts: tone.service }], defaultVoice: "a", sampleRate: 48_000 })
      assert.strictEqual(router.sampleRate, 48_000)
      const chunks = yield* Stream.runCollect(router.synthesize(Stream.make("Hello.")))
      const samples = chunks.reduce((n, c) => n + c.audio.length / 2, 0)
      assert.isTrue(Math.abs(samples - 4_800) <= 2, `got ${samples} samples`)
    }))
})
