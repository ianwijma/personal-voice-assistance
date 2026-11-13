// Review round 3 in Conversation: promotion of intent turns compares the words strictly
// (finding 5), Stop cancels the open utterance whether or not a turn exists (finding 6),
// and the stored history is bounded (whole turns evicted in batches, big items cut).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Agent, AgentEvent } from "../src/Agent.ts"
import { CANCELLED_UTTERANCE_MS, Conversation, type HistoryLimits, strictTranscript } from "../src/Conversation.ts"
import type { AgentTurnSetup, ConversationInput } from "../src/ConversationEvents.ts"
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
  testTurnTraceLayer,
  turnResumed
} from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const harness = (setup: AgentTurnSetup, history?: HistoryLimits) => {
  const tts = makeMarkerTts()
  const out = makeRecordingAudioOutput({ chunkMillis: 100 })
  const conversation = Conversation.layerWithAgents({ setup: Effect.succeed(setup), ...(history !== undefined ? { history } : {}) })
    .pipe(Layer.provideMerge(testTurnTraceLayer))
  return { out, layer: Layer.mergeAll(conversation, tts.layer, out.layer) }
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

/** One agent that answers every turn with "<text>." after 100 ms. */
const echoing = (kind: Agent["kind"]) => {
  const agent = makeScriptedAgent({ id: "jev", kind }, (input) => [sleep(100), agentText(`Did ${input.text}.`)])
  return { agent, setup: makeAgentSetup({ agents: [agent.agent], routing: { defaultAgent: "jev" } }) }
}

describe("finding 5: an intent turn is promoted only for the very same words", () => {
  it.effect("'dim to five percent' then '-five percent': the speculative turn is discarded and the final words decided afresh", () => {
    const jev = echoing("intent")
    const t = harness(jev.setup)
    return Effect.gen(function*() {
      yield* run([speechStarted, eagerEndOfTurn("dim to five percent"), sleep(50), endOfTurn("dim to -five percent")])
      assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["dim to five percent", "dim to -five percent"])
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["discarded", "completed"])
      assert.deepStrictEqual(t.out.probe.chunks.map((c) => c.text), ["<Did dim to -five percent.>"])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("spacing, final punctuation and commas between words do not matter (round 4: case does)", () => {
    const jev = echoing("intent")
    const t = harness(jev.setup)
    return Effect.gen(function*() {
      yield* run([speechStarted, eagerEndOfTurn("turn on the lights, please"), sleep(50), endOfTurn("turn on the  lights please.")])
      assert.strictEqual(jev.agent.probe.inputs.length, 1)
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["completed"])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("a conversational agent gets the same comparison (round 5)", () => {
    const main = echoing("model")
    const t = harness(main.setup)
    return Effect.gen(function*() {
      yield* run([speechStarted, eagerEndOfTurn("what's up"), sleep(50), endOfTurn("What's up?")])
      assert.strictEqual(main.agent.probe.inputs.length, 2, "decided again on the final words")
    }).pipe(Effect.provide(t.layer))
  })
  // Rule (round 4): the same canonical text (`canonicalUtterance`): collapsing whitespace and dropping
  // the ignorable punctuation only; case, "?", and any mark next to a number count.
  const pairs: ReadonlyArray<readonly [string, string, boolean]> = [
    ["dim to five percent", "dim to -five percent", false],
    ["dim to five percent", "dim to minus five percent", false],
    ["dim to 5 percent", "dim to -5 percent", false],
    ["dim to 5 percent", "dim to − 5 percent", false],
    ["dim to 15 percent", "dim to 1.5 percent", false],
    ["dim to 15 percent", "dim to 1,5 percent", false],
    ["dim to 35 percent", "dim to 3-5 percent", false],
    ["dim to 40 percent", "dim to 40%", false],
    ["dim to forty percent", "dim to fourty percent", false],
    ["turn on the kitchen lights", "turn on the kitchen lights now", false],
    ["turn on the kitchen lights", "turn on kitchen lights", false],
    ["turn on the kitchen lights", "turn off the kitchen lights", false],
    ["turn on the lights", "turn on the light's", false],
    ["zet de keuken op veertig procent", "zet de keuken op vijftig procent", false],
    ["zet de keuken op vijf procent", "zet de keuken op min vijf procent", false],
    ["doe het licht aan", "doe het licht niet aan", false],
    ["Turn on the lights.", "Turn on the lights", true],
    ["Turn on the lights.", "turn on the lights", false],
    ["turn on the lights!", "turn on the lights", true],
    ["turn on the lights!", "turn on the lights?", false],
    ["turn on the lights, please", "turn on the lights please", true],
    ["Doe het licht aan in de keuken.", "Doe het licht aan in de keuken", true],
    ["zet  de keuken op veertig procent", "zet de keuken op veertig procent", true],
    ["dim to 1,5 percent", "dim to 1,5 percent.", true],
    ["hey jev, lights on", "hey jev lights on", true],
    ["lights on…", "lights on", true]
  ]
  for (const [a, b, same] of pairs) {
    it(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: ${same ? "promoted" : "discarded"}`, () => {
      assert.strictEqual(strictTranscript(a) === strictTranscript(b), same)
    })
  }
})

describe("finding 6: Stop cancels the open utterance, with or without a turn", () => {
  it.effect("SpeechStarted, eager, TurnResumed, Stop, final: nothing runs the command", () => {
    const jev = echoing("intent")
    const t = harness(jev.setup)
    return Effect.gen(function*() {
      yield* run([speechStarted, eagerEndOfTurn("turn on the lights"), sleep(20), turnResumed, sleep(20), stop, sleep(20), eagerEndOfTurn("turn on the lights"), sleep(20), endOfTurn("turn on the lights")])
      assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["turn on the lights"], "only the speculative turn before TurnResumed ran")
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["discarded"])
      assert.deepStrictEqual(t.out.probe.chunks, [])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("Stop before the first eager transcript cancels the utterance; the next one after its end works", () => {
    const jev = echoing("intent")
    const t = harness(jev.setup)
    return Effect.gen(function*() {
      yield* run([
        speechStarted, sleep(10), stop, eagerEndOfTurn("turn on the lights"), sleep(20), speechStarted, sleep(20), endOfTurn("turn on the lights"),
        sleep(500), speechStarted, endOfTurn("what time is it")
      ])
      assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["what time is it"])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("Stop with no utterance open and no turn changes nothing", () => {
    const jev = echoing("intent")
    const t = harness(jev.setup)
    return Effect.gen(function*() {
      yield* run([stop, sleep(10), speechStarted, endOfTurn("lights on")])
      assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["lights on"])
    }).pipe(Effect.provide(t.layer))
  })
  it.effect("typed text and Say still begin something new; the cancellation lapses after 20 s", () => {
    const jev = echoing("intent")
    const t = harness(jev.setup)
    return Effect.gen(function*() {
      yield* run([speechStarted, stop, { _tag: "TextInput", text: "typed", speak: false }, sleep(300), endOfTurn("ignored? no: typed text reset it")])
      assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["typed", "ignored? no: typed text reset it"])
      jev.agent.probe.inputs.length = 0
      yield* run([speechStarted, stop, sleep(CANCELLED_UTTERANCE_MS + 10), endOfTurn("after the lapse")], CANCELLED_UTTERANCE_MS + 2_000)
      assert.deepStrictEqual(jev.agent.probe.inputs.map((i) => i.text), ["after the lapse"])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("the history bound", () => {
  const turnsOf = (h: ReadonlyArray<Message>) => h.filter((m) => m.role === "user").map((m) => m.content)
  const textTurn = (text: string) => Effect.flatMap(Effect.service(Conversation), (c) => Stream.runDrain(c.textTurn(text)))

  it.effect("whole turns are evicted 8 at a time past 32 turns, so the start stays the same between evictions", () => {
    const main = makeScriptedAgent({ id: "main" }, (input) => [agentText(`Re ${input.text}.`)])
    const t = harness(makeAgentSetup({ agents: [main.agent], routing: { defaultAgent: "main" } }))
    return Effect.gen(function*() {
      const firsts: Array<string> = []
      const counts: Array<number> = []
      for (let i = 1; i <= 41; i++) {
        yield* textTurn(`t${i}`)
        const h = yield* history
        firsts.push(turnsOf(h)[0]!)
        counts.push(turnsOf(h).length)
      }
      assert.deepStrictEqual(counts.slice(30, 41), [31, 32, 25, 26, 27, 28, 29, 30, 31, 32, 25])
      assert.deepStrictEqual(firsts.slice(32, 40), Array(8).fill("t9"), "a stable prefix for eight turns")
      assert.strictEqual(firsts[40], "t17")
      // Agents are told how many messages were evicted before the history they get.
      assert.strictEqual(main.probe.inputs.at(-1)!.historyStart, 16, "8 turns of 2 messages evicted before turn 41")
      assert.strictEqual(main.probe.inputs[0]!.historyStart, undefined)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a turn with tool rounds and an interrupted reply is evicted whole; a huge tool result is cut, its envelope kept", () => {
    const big = "x".repeat(20_000)
    const main = makeScriptedAgent({ id: "main" }, (input, index) =>
      index === 0
        ? [
          { _tag: "ToolStarted", call: { id: "c1", name: "lookup", input: { key: "k" } } } satisfies AgentEvent,
          { _tag: "ToolFinished", result: { id: "c1", name: "lookup", content: big, isError: false }, ms: 1 } satisfies AgentEvent,
          agentText("Found it.")
        ]
        : [agentText(`Re ${input.text}.`)])
    const t = harness(makeAgentSetup({ agents: [main.agent], routing: { defaultAgent: "main" } }), { maxTurns: 3, evictTurns: 2 })
    return Effect.gen(function*() {
      yield* textTurn("look it up")
      const h = yield* history
      const tool = h.find((m) => m.role === "tool")
      assert.isDefined(tool)
      if (tool?.role !== "tool") return
      assert.strictEqual(tool.results[0]!.id, "c1")
      assert.isBelow(tool.results[0]!.content.length, 8_100)
      assert.match(tool.results[0]!.content, /12000 more characters cut from the history\]$/)
      assert.deepStrictEqual(h.find((m) => m.role === "assistant" && m.toolCalls !== undefined)?.role, "assistant")
      for (const text of ["b", "c", "d"]) yield* textTurn(text)
      const after = yield* history
      assert.deepStrictEqual(turnsOf(after), ["c", "d"], "two turns evicted together, the tool turn whole")
      assert.isUndefined(after.find((m) => m.role === "tool"))
      assert.strictEqual(after[0]!.role, "user")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("the character budget evicts too; the last turn is always kept", () => {
    const main = makeScriptedAgent({ id: "main" }, (input) => [agentText(`Re ${input.text}.`)])
    const t = harness(makeAgentSetup({ agents: [main.agent], routing: { defaultAgent: "main" } }), { maxChars: 1_000, evictTurns: 1, maxItemChars: 5_000 })
    return Effect.gen(function*() {
      // A turn here is the question and "Re <question>.": about 400 characters.
      yield* textTurn("a".repeat(200))
      yield* textTurn("b".repeat(200))
      yield* textTurn("c".repeat(200))
      assert.deepStrictEqual(turnsOf(yield* history).map((s) => s[0]), ["b", "c"])
      yield* textTurn("d".repeat(3_000))
      assert.deepStrictEqual(turnsOf(yield* history).map((s) => s[0]), ["d"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("initialHistory is bounded too", () => {
    const initial: Array<Message> = Array.from({ length: 40 }, (_, i) => [{ role: "user" as const, content: `u${i}` }, { role: "assistant" as const, content: `a${i}` }]).flat()
    const main = makeScriptedAgent({ id: "main" }, () => [agentText("ok")])
    const tts = makeMarkerTts()
    const out = makeRecordingAudioOutput({ chunkMillis: 100 })
    const layer = Layer.mergeAll(
      Conversation.layerWithAgents({ setup: Effect.succeed(makeAgentSetup({ agents: [main.agent], routing: { defaultAgent: "main" } })), initialHistory: initial })
        .pipe(Layer.provideMerge(testTurnTraceLayer)),
      tts.layer,
      out.layer
    )
    return Effect.gen(function*() {
      const h = yield* history
      assert.isAtMost(turnsOf(h).length, 32)
      assert.strictEqual(turnsOf(h).at(-1), "u39")
    }).pipe(Effect.provide(layer))
  })
})
