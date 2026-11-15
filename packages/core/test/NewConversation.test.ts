// docs/VOICE-SESSIONS.md §1: a new conversation on request (`newConversation`) and after being idle
// (`idleResetMs`), the conversation id, `ConversationStarted`, and the id carried across a reload.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Conversation, type ConversationOptions } from "../src/Conversation.ts"
import type { ConversationEvent, ConversationInput } from "../src/ConversationEvents.ts"
import type { Message } from "../src/Domain.ts"
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

/** Let freshly forked fibers run before the clock moves (docs/ARCHITECTURE.md, Testing). */
const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const harness = (
  responses: Parameters<typeof makeScriptedAgent>[1],
  options: Partial<Pick<ConversationOptions, "idleResetMs" | "initialHistory" | "initialConversationId" | "initialLastTurnAt">> = {}
) => {
  const events: Array<ConversationEvent> = []
  const main = makeScriptedAgent({ id: "main", name: "Main" }, responses)
  const tts = makeMarkerTts()
  const out = makeRecordingAudioOutput({ chunkMillis: 100 })
  const conversation = Conversation.layerWithAgents({
    setup: Effect.succeed(makeAgentSetup({ agents: [main.agent], routing: { defaultAgent: "main" } })),
    onEvent: (e) => events.push(e),
    ...options
  }).pipe(Layer.provideMerge(testTurnTraceLayer))
  return { events, main, out, layer: Layer.mergeAll(conversation, tts.layer, out.layer) }
}

const conversation = Effect.service(Conversation)
const history = Effect.flatMap(conversation, (c) => c.history)
const conversationId = Effect.flatMap(conversation, (c) => c.conversationId)
const newConversation = (reason?: "new" | "idle") => Effect.flatMap(conversation, (c) => c.newConversation(reason))
const textTurn = (text: string) => Effect.flatMap(conversation, (c) => Stream.runDrain(c.textTurn(text)))
const outcomes = Effect.flatMap(Effect.service(TurnTrace), (t) => t.recent).pipe(Effect.map((ts) => ts.map((t) => t.outcome)))
const started = (events: ReadonlyArray<ConversationEvent>) =>
  events.flatMap((e) => (e._tag === "ConversationStarted" ? [e.reason] : []))
const userTexts = (messages: ReadonlyArray<Message>) => messages.flatMap((m) => (m.role === "user" ? [m.content] : []))

const startVoice = (script: ReadonlyArray<ConversationInput | Sleep>) =>
  Effect.flatMap(conversation, (c) => Effect.forkChild(c.voice(scripted(script))))

describe("Conversation: newConversation", () => {
  it.effect("without a voice loop: drops the history, gives a new id, emits ConversationStarted", () => {
    const t = harness([[agentText("One.")], [agentText("Two.")]])
    return Effect.gen(function*() {
      const first = yield* conversationId
      yield* textTurn("first")
      assert.deepStrictEqual(userTexts(yield* history), ["first"])
      assert.isDefined(yield* Effect.flatMap(conversation, (c) => c.lastTurnAt))
      const id = yield* newConversation()
      assert.notStrictEqual(id, first)
      assert.strictEqual(yield* conversationId, id)
      assert.deepStrictEqual(yield* history, [])
      assert.isUndefined(yield* Effect.flatMap(conversation, (c) => c.lastTurnAt))
      assert.deepStrictEqual(t.events.filter((e) => e._tag === "ConversationStarted"), [{ _tag: "ConversationStarted", conversationId: id, reason: "new" }])
      // The next turn starts from nothing, under the new id.
      yield* textTurn("second")
      assert.deepStrictEqual(t.main.probe.inputs[1]!.history, [])
      assert.strictEqual(t.main.probe.inputs[0]!.conversationId, first)
      assert.strictEqual(t.main.probe.inputs[1]!.conversationId, id)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("while a voice turn runs: stops it as Stop does, and nothing of it lands in the new conversation", () => {
    const t = harness([[sleep(500), agentText("A slow answer.")], [agentText("Fresh.")]])
    return Effect.gen(function*() {
      const fiber = yield* startVoice([endOfTurn("old question"), sleep(2_000), endOfTurn("new question")])
      yield* advance(100)
      const reset = yield* Effect.forkChild(newConversation())
      yield* advance(10)
      const id = yield* Fiber.join(reset)
      assert.deepStrictEqual(yield* history, [], "the stopped turn was committed to the old conversation, then dropped")
      yield* advance(3_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(yield* outcomes, ["interrupted", "completed"])
      assert.deepStrictEqual(userTexts(yield* history), ["new question"])
      assert.strictEqual(t.main.probe.inputs[1]!.conversationId, id)
      assert.deepStrictEqual(t.main.probe.inputs[1]!.history, [])
      assert.deepStrictEqual(started(t.events), ["new"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("the rest of the utterance being spoken starts nothing (as after Stop)", () => {
    const t = harness([[agentText("Speculative.")], [agentText("Later.")]])
    return Effect.gen(function*() {
      const fiber = yield* startVoice([
        speechStarted,
        eagerEndOfTurn("half a sentence"),
        sleep(200),
        endOfTurn("half a sentence and more"),
        sleep(500),
        endOfTurn("a new one")
      ])
      yield* advance(100)
      const reset = yield* Effect.forkChild(newConversation())
      yield* advance(10)
      yield* Fiber.join(reset)
      yield* advance(2_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(userTexts(yield* history), ["a new one"])
      assert.deepStrictEqual(t.main.probe.inputs.map((i) => i.text), ["half a sentence", "a new one"])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("Conversation: idle reset", () => {
  it.effect("no committed turn for idleResetMs: the next turn starts a new conversation first", () => {
    const t = harness([[agentText("One.")], [agentText("Two.")], [agentText("Three.")]], { idleResetMs: 60_000 })
    return Effect.gen(function*() {
      const first = yield* conversationId
      const fiber = yield* startVoice([
        endOfTurn("one"),
        sleep(30_000),
        endOfTurn("two"), // 30 s later: same conversation
        sleep(61_000),
        endOfTurn("three") // 61 s after the last committed turn: a new one
      ])
      yield* advance(100_000)
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(userTexts(t.main.probe.inputs[1]!.history), ["one"])
      assert.deepStrictEqual(t.main.probe.inputs[2]!.history, [])
      assert.strictEqual(t.main.probe.inputs[1]!.conversationId, first)
      const second = yield* conversationId
      assert.notStrictEqual(second, first)
      assert.strictEqual(t.main.probe.inputs[2]!.conversationId, second)
      assert.deepStrictEqual(started(t.events), ["idle"])
      // Emitted before the turn that it started for.
      const i = t.events.findIndex((e) => e._tag === "ConversationStarted")
      assert.strictEqual(t.events.slice(i + 1).find((e) => e._tag === "TurnStarted")?._tag, "TurnStarted")
      assert.deepStrictEqual(userTexts(yield* history), ["three"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("decided at a speculative turn's start: its promotion sees the same (new) history", () => {
    const t = harness([[sleep(50), agentText("Hello again.")]], {
      idleResetMs: 10_000,
      initialHistory: [{ role: "user", content: "old" }, { role: "assistant", content: "Old." }],
      initialLastTurnAt: 0
    })
    return Effect.gen(function*() {
      const fiber = yield* startVoice([sleep(20_000), speechStarted, eagerEndOfTurn("hi"), sleep(300), endOfTurn("hi")])
      yield* advance(25_000)
      yield* Fiber.join(fiber)
      assert.strictEqual(t.main.probe.inputs.length, 1, "the speculative turn was promoted, not run again")
      assert.deepStrictEqual(t.main.probe.inputs[0]!.history, [])
      assert.deepStrictEqual(started(t.events), ["idle"])
      assert.deepStrictEqual(userTexts(yield* history), ["hi"])
      assert.deepStrictEqual(yield* outcomes, ["completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("the idle time is read at every turn start (it can change at runtime); 0 means never", () => {
    let idle: number | undefined = 0
    const t = harness([[agentText("One.")], [agentText("Two.")], [agentText("Three.")]], { idleResetMs: () => idle })
    return Effect.gen(function*() {
      yield* textTurn("one")
      yield* TestClock.adjust(120_000)
      yield* textTurn("two") // never: still the same conversation
      assert.deepStrictEqual(userTexts(t.main.probe.inputs[1]!.history), ["one"])
      idle = 60_000
      yield* TestClock.adjust(60_000)
      yield* textTurn("three") // the profile now forgets after a minute
      assert.deepStrictEqual(t.main.probe.inputs[2]!.history, [])
      assert.deepStrictEqual(started(t.events), ["idle"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a fresh conversation with nothing committed is not reset (no event)", () => {
    const t = harness([[agentText("One.")]], { idleResetMs: 1_000 })
    return Effect.gen(function*() {
      yield* TestClock.adjust(60_000)
      yield* textTurn("one")
      assert.deepStrictEqual(started(t.events), [])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("Conversation: initial history and id (engine reload)", () => {
  it.effect("initialConversationId is the conversation's id and reaches the agent with the initial history", () => {
    const initial: ReadonlyArray<Message> = [{ role: "user", content: "before" }, { role: "assistant", content: "Before." }]
    const t = harness([[agentText("After.")]], { initialHistory: initial, initialConversationId: "conv-1" })
    return Effect.gen(function*() {
      assert.strictEqual(yield* conversationId, "conv-1")
      yield* textTurn("after")
      assert.strictEqual(t.main.probe.inputs[0]!.conversationId, "conv-1")
      assert.deepStrictEqual(t.main.probe.inputs[0]!.history, initial)
    }).pipe(Effect.provide(t.layer))
  })
})

describe("Conversation: agents are told when a conversation ends", () => {
  it.effect("newConversation and the idle reset call endConversation with the old id on the setup's agents", () => {
    const ended: Array<string> = []
    const main = makeScriptedAgent({ id: "main", name: "Main" }, [[agentText("One.")], [agentText("Two.")], [agentText("Three.")]])
    const agent = { ...main.agent, endConversation: (id: string) => Effect.sync(() => void ended.push(id)) }
    const layer = Conversation.layerWithAgents({
      setup: Effect.succeed(makeAgentSetup({ agents: [agent], routing: { defaultAgent: "main" } })),
      idleResetMs: 60_000,
      initialConversationId: "first"
    }).pipe(Layer.provideMerge(testTurnTraceLayer))
    return Effect.gen(function*() {
      yield* textTurn("one")
      const second = yield* newConversation()
      assert.deepStrictEqual(ended, ["first"])
      yield* textTurn("two")
      yield* TestClock.adjust(61_000)
      yield* textTurn("three")
      assert.deepStrictEqual(ended, ["first", second])
    }).pipe(Effect.provide(layer))
  })
})
