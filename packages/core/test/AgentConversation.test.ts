// Piece A of docs/AGENTS-AND-INTENTS.md: agents behind Conversation, routing at
// turn start, router state on commit, canned turns, notices, hand-off and failure
// fallback, Say, SetActiveAgent, the new events.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import type { AgentTurnSetup, ConversationEvent, ConversationInput } from "../src/ConversationEvents.ts"
import { makeTool } from "../src/Module.ts"
import { makeModelAgent } from "../src/ModelAgent.ts"
import type { RoutingConfig } from "../src/Routing.ts"
import { Llm } from "../src/Services.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { TurnTrace } from "../src/TurnTrace.ts"
import {
  agentFails,
  agentText,
  type AgentScript,
  eagerEndOfTurn,
  endOfTurn,
  expectReply,
  handoff,
  makeAgentSetup,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedAgent,
  makeScriptedLlm,
  scripted,
  type Sleep,
  sleep,
  speechStarted,
  testTurnTraceLayer,
  toolCall,
  turnResumed
} from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const routing = (overrides: Partial<RoutingConfig> = {}): Partial<RoutingConfig> => ({ defaultAgent: "main", ...overrides })

const harness = (options: {
  readonly setup: AgentTurnSetup | (() => AgentTurnSetup)
  readonly maxToolRounds?: number
}) => {
  const events: Array<ConversationEvent> = []
  const tts = makeMarkerTts()
  const out = makeRecordingAudioOutput({ chunkMillis: 100 })
  const setup = options.setup
  const conversation = Conversation.layerWithAgents({
    setup: Effect.sync(() => (typeof setup === "function" ? setup() : setup)),
    onEvent: (e) => events.push(e),
    ...(options.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {})
  }).pipe(Layer.provideMerge(testTurnTraceLayer))
  return { events, out, tts, layer: Layer.mergeAll(conversation, tts.layer, out.layer) }
}

const run = (script: ReadonlyArray<ConversationInput | Sleep>, millis = 5_000) =>
  Effect.gen(function*() {
    const c = yield* Conversation
    const fiber = yield* Effect.forkChild(c.voice(scripted(script)))
    yield* advance(millis)
    yield* Fiber.join(fiber)
  })

const history = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const routerState = Effect.flatMap(Effect.service(Conversation), (c) => c.routerState)
const traces = Effect.flatMap(Effect.service(TurnTrace), (t) => t.recent)
const played = (out: ReturnType<typeof makeRecordingAudioOutput>) => out.probe.chunks.map((c) => c.text)
const ofTag = <T extends ConversationEvent["_tag"]>(events: ReadonlyArray<ConversationEvent>, tag: T) =>
  events.filter((e): e is Extract<ConversationEvent, { _tag: T }> => e._tag === tag)
const say = (text: string): AgentScript => [agentText(text)]

describe("routing at turn start", () => {
  it.effect("no trigger: the default agent answers; history records who said it", () => {
    const main = makeScriptedAgent({ id: "main", name: "Main" }, [say("Hello.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hi there")])
      assert.deepStrictEqual(played(t.out), ["<Hello.>"])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hi there" },
        { role: "assistant", content: "Hello.", agentId: "main" }
      ])
      const started = ofTag(t.events, "TurnStarted")[0]!
      assert.deepStrictEqual(started, {
        _tag: "TurnStarted",
        turnId: 1,
        source: "voice",
        text: "hi there",
        speculative: false,
        spoken: true,
        agentId: "main",
        routedBy: "default",
        agentText: "hi there"
      })
      const [trace] = yield* traces
      assert.deepStrictEqual(trace!.agent, { id: "main", kind: "model", routedBy: "default" })
      assert.deepStrictEqual(ofTag(t.events, "RoutingChanged"), [], "nothing to remember")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a trigger picks its agent and the agent gets the text without it; a turn rule does not stick", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Main.")])
    const jev = makeScriptedAgent({ id: "jev", name: "Jev", kind: "intent" }, [say("Living room lights on.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, jev.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("Hey Jeff, turn on the lights."), sleep(1_000), endOfTurn("and how are you")])
      assert.strictEqual(jev.probe.inputs[0]!.text, "Turn on the lights.")
      assert.strictEqual(jev.probe.inputs[0]!.utterance, "Hey Jeff, turn on the lights.")
      assert.strictEqual(jev.probe.inputs[0]!.routedBy, "trigger")
      assert.strictEqual(main.probe.inputs.length, 1, "the next utterance goes back to the default")
      assert.deepStrictEqual((yield* history).slice(0, 2), [
        { role: "user", content: "Turn on the lights." },
        { role: "assistant", content: "Living room lights on.", agentId: "jev" }
      ])
      const started = ofTag(t.events, "TurnStarted")[0]!
      assert.strictEqual(started.text, "Hey Jeff, turn on the lights.")
      assert.strictEqual(started.agentText, "Turn on the lights.")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a conversation rule makes its agent sticky across turns until the default's phrase", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Back.")])
    const claude = makeScriptedAgent({ id: "claude-subscription", name: "Claude subscription", kind: "harness", speculate: true }, [say("One."), say("Two.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, claude.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        endOfTurn("hey claude what is a quark"),
        sleep(1_000),
        endOfTurn("tell me more"),
        sleep(1_000),
        endOfTurn("hey assistant thanks")
      ])
      assert.deepStrictEqual(claude.probe.inputs.map((i) => [i.text, i.routedBy]), [["What is a quark", "trigger"], ["tell me more", "sticky"]])
      assert.deepStrictEqual(main.probe.inputs.map((i) => [i.text, i.routedBy]), [["Thanks", "trigger"]])
      assert.deepStrictEqual(yield* routerState, {})
      const changes = ofTag(t.events, "RoutingChanged").map((e) => e.state.sticky?.agentId ?? null)
      assert.deepStrictEqual(changes, ["claude-subscription", "claude-subscription", null])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("TextInput with agentId routes explicitly; SetActiveAgent makes an agent sticky at once", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Main.")])
    const other = makeScriptedAgent({ id: "other" }, [say("One."), say("Two.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, other.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        { _tag: "TextInput", text: "hey jev do it", speak: false, agentId: "other" },
        sleep(500),
        { _tag: "SetActiveAgent", agentId: "other" },
        endOfTurn("and then"),
        sleep(500),
        { _tag: "SetActiveAgent", agentId: null },
        endOfTurn("back")
      ])
      assert.deepStrictEqual(other.probe.inputs.map((i) => [i.text, i.routedBy]), [["Do it", "explicit"], ["and then", "sticky"]])
      assert.deepStrictEqual(main.probe.inputs.map((i) => i.routedBy), ["default"])
      assert.isTrue(ofTag(t.events, "RoutingChanged").length >= 2)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("textTurn routes like speech and commits at once", () => {
    const main = makeScriptedAgent({ id: "main" }, [])
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, [say("Done.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, jev.agent], routing: routing() }) })
    return Effect.gen(function*() {
      const c = yield* Conversation
      const out = yield* Stream.runCollect(c.textTurn("hey jev lights off"))
      assert.deepStrictEqual(out, ["Done."])
      assert.strictEqual(jev.probe.inputs[0]!.text, "Lights off")
      assert.deepStrictEqual(yield* c.history, [{ role: "user", content: "Lights off" }, { role: "assistant", content: "Done.", agentId: "jev" }])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("trigger only, arming and canned turns", () => {
  it.effect("'Hey Jev.' speaks the acknowledgement, records nothing, and arms Jev for the next utterance", () => {
    const main = makeScriptedAgent({ id: "main" }, [])
    const jev = makeScriptedAgent({ id: "jev", name: "Jev", kind: "intent" }, [say("Kitchen lights on.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, jev.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("Hey Jev."), sleep(2_000), endOfTurn("the kitchen lights")])
      assert.deepStrictEqual(played(t.out), ["<Yes?>", "<Kitchen lights on.>"])
      assert.strictEqual(jev.probe.inputs.length, 1)
      assert.strictEqual(jev.probe.inputs[0]!.routedBy, "armed")
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "the kitchen lights" },
        { role: "assistant", content: "Kitchen lights on.", agentId: "jev" }
      ])
      const started = ofTag(t.events, "TurnStarted")[0]!
      assert.strictEqual(started.canned, true)
      assert.strictEqual(started.agentId, "jev")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("arming lapses after armedMs", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Main.")])
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, [])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, jev.agent], routing: routing({ armedMs: 3_000 }) }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hey jev"), sleep(4_000), endOfTurn("hello")], 10_000)
      assert.strictEqual(jev.probe.inputs.length, 0)
      assert.strictEqual(main.probe.inputs[0]!.routedBy, "default")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("ExpectReply arms the agent when the turn is committed", () => {
    const main = makeScriptedAgent({ id: "main" }, [])
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, [[agentText("Which room?"), expectReply], say("Kitchen lights on.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, jev.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([eagerEndOfTurn("hey jev lights on"), sleep(300), endOfTurn("hey jev lights on"), sleep(1_000), endOfTurn("the kitchen")])
      assert.deepStrictEqual(jev.probe.inputs.map((i) => [i.text, i.routedBy]), [["Lights on", "trigger"], ["the kitchen", "armed"]])
      assert.deepStrictEqual(played(t.out), ["<Which room?>", "<Kitchen lights on.>"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a discarded speculative turn changes no routing state (and its ExpectReply is dropped)", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Main.")])
    const claude = makeScriptedAgent({ id: "claude-subscription", kind: "model" }, [[agentText("Sure?"), expectReply]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, claude.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([eagerEndOfTurn("hey claude"), sleep(100), turnResumed, sleep(200), endOfTurn("what is the weather")])
      assert.deepStrictEqual(yield* routerState, {})
      assert.deepStrictEqual(ofTag(t.events, "RoutingChanged"), [])
      assert.strictEqual(main.probe.inputs.length, 1)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("no agent running at all: a canned reply, nothing recorded", () => {
    const t = harness({ setup: makeAgentSetup({ agents: [], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hello")])
      assert.deepStrictEqual(played(t.out), ["<No agent is available right now.>", "<Check the agents in the options.>"])
      assert.deepStrictEqual(yield* history, [])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("Say speaks a canned turn in a voice, interrupting the current one, and records nothing", () => {
    const main = makeScriptedAgent({ id: "main" }, [[agentText("One. "), sleep(5_000), agentText("Two.")]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("count"), sleep(150), { _tag: "Say", text: "This is the natural voice.", voice: "natural" }], 10_000)
      assert.deepStrictEqual(played(t.out), ["<One.>", "<[voice:natural] This is the natural voice.>"])
      assert.deepStrictEqual(yield* history, [{ role: "user", content: "count" }, { role: "assistant", content: "One.", interrupted: true, agentId: "main" }])
      assert.strictEqual(ofTag(t.events, "TurnStarted")[1]!.canned, true)
    }).pipe(Effect.provide(t.layer))
  })
})

describe("speculation per agent kind", () => {
  it.effect("a harness agent with speculate: false is called only at promotion; a discarded turn never reaches it", () => {
    const main = makeScriptedAgent({ id: "main" }, [])
    const claude = makeScriptedAgent({ id: "claude-subscription", kind: "harness" }, [say("Hi.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, claude.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        eagerEndOfTurn("hey claude hello"),
        sleep(100),
        turnResumed,
        sleep(100),
        eagerEndOfTurn("hey claude hello there"),
        sleep(300),
        endOfTurn("hey claude hello there")
      ])
      assert.deepStrictEqual(claude.probe.calledAt, [500])
      assert.strictEqual(claude.probe.inputs[0]!.text, "Hello there")
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<Hi.>", at: 500 }])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a model agent runs during the speculative turn (its speech is buffered until promotion)", () => {
    const main = makeScriptedAgent({ id: "main" }, [[sleep(50), agentText("Noon.")]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([eagerEndOfTurn("what time"), sleep(300), endOfTurn("what time")])
      assert.deepStrictEqual(main.probe.calledAt, [0])
      assert.deepStrictEqual(t.out.probe.chunks, [{ text: "<Noon.>", at: 300 }])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("fallback", () => {
  it.effect("a hand-off before any text: the default agent answers the same text; TurnAgentChanged", () => {
    const main = makeScriptedAgent({ id: "main", name: "Main" }, [say("Quarks are tiny.")])
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, [[handoff("no_match"), agentText("never")]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, jev.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hey jev what is a quark")])
      assert.strictEqual(main.probe.inputs[0]!.text, "What is a quark")
      assert.deepStrictEqual(played(t.out), ["<Quarks are tiny.>"])
      assert.deepStrictEqual(ofTag(t.events, "TurnAgentChanged"), [{ _tag: "TurnAgentChanged", turnId: 1, agentId: "main", from: "jev", reason: "handoff" }])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "What is a quark" },
        { role: "assistant", content: "Quarks are tiny.", agentId: "main" }
      ])
      const [trace] = yield* traces
      assert.deepStrictEqual(trace!.agent, { id: "main", kind: "model", routedBy: "trigger", fallbackFrom: "jev" })
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a hand-off with no conversational agent to take it: 'I can't help with that right now.'", () => {
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, [[handoff()]])
    const t = harness({ setup: makeAgentSetup({ agents: [jev.agent], routing: routing({ defaultAgent: "jev" }) }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("what is a quark")])
      assert.deepStrictEqual(played(t.out), ["<I can't help with that right now.>"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("failure before any text: 'X isn't available.' then the default agent answers", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Here you go.")])
    const claude = makeScriptedAgent({ id: "claude-subscription", name: "Claude subscription", speculate: true }, [[sleep(100), agentFails("unavailable")]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, claude.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hey claude tell me a joke")])
      assert.deepStrictEqual(played(t.out), ["<Claude subscription isn't available.>", "<Here you go.>"])
      assert.deepStrictEqual(ofTag(t.events, "TurnAgentChanged").map((e) => e.reason), ["failed"])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "Tell me a joke" },
        { role: "assistant", content: "Here you go.", agentId: "main" }
      ], "the notice is not recorded")
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("no first event within firstEventTimeoutMs counts as a failure before text", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Fallback.")])
    const slow = makeScriptedAgent({ id: "slow", name: "Slow", firstEventTimeoutMs: 1_000 }, [[sleep(10_000), agentText("Too late.")]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, slow.agent], routing: routing({ rules: [{ agent: "slow", phrases: ["hey slow"], mode: "turn" }] }) }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hey slow hi")], 20_000)
      assert.deepStrictEqual(played(t.out), ["<Slow isn't available.>", "<Fallback.>"])
      assert.strictEqual(slow.probe.interrupted, 1)
      assert.strictEqual(main.probe.calledAt[0], 1_000)
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("failure after text: the turn fails and keeps what was said, as before", () => {
    const main = makeScriptedAgent({ id: "main" }, [[agentText("Partly "), agentText("said. "), agentFails()]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hi")])
      assert.deepStrictEqual(played(t.out), ["<Partly said.>"])
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["failed"])
      assert.deepStrictEqual(ofTag(t.events, "TurnAgentChanged"), [])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a routed agent that is not running: the default answers after 'X isn't available.'", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("I can do that.")])
    const t = harness({
      setup: makeAgentSetup({ agents: [main.agent], routing: routing(), names: new Map([["codex-subscription", "Codex"]]) })
    })
    return Effect.gen(function*() {
      yield* run([endOfTurn("hey codex write a poem")])
      assert.deepStrictEqual(played(t.out), ["<Codex isn't available.>", "<I can do that.>"])
      assert.strictEqual(ofTag(t.events, "TurnStarted")[0]!.fallbackFrom, "codex-subscription")
      assert.deepStrictEqual(yield* routerState, {}, "nothing sticks to the missing agent")
      assert.deepStrictEqual((yield* history)[0], { role: "user", content: "Write a poem" })
    }).pipe(Effect.provide(t.layer))
  })
})

describe("what agents report", () => {
  it.effect("rounds are rebuilt from tool events; actions and decisions are events, not history", () => {
    const call = { id: "c1", name: "lookup", input: {} }
    const result = { id: "c1", name: "lookup", content: "42", isError: false }
    const events: AgentScript = [
      agentText("Checking."),
      agentText("\n"),
      { _tag: "ToolStarted", call },
      sleep(50),
      { _tag: "ToolFinished", result, ms: 50 },
      agentText("It is 42. "),
      { _tag: "Decision", decision: { decider: "keywords", outcome: "act", params: [], ms: 1 } },
      { _tag: "ActionStarted", callId: "a1", actionId: "demo-home.lights_on", label: "Turn lights on", params: { target: "all" } },
      { _tag: "ActionFinished", callId: "a1", ok: true, ms: 2 },
      agentText("Lights on.")
    ]
    const main = makeScriptedAgent({ id: "main" }, [events])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("go")])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "go" },
        { role: "assistant", content: "Checking.", toolCalls: [call], agentId: "main" },
        { role: "tool", results: [result] },
        { role: "assistant", content: "It is 42. Lights on.", agentId: "main" }
      ])
      assert.deepStrictEqual(played(t.out), ["<Checking.>", "<It is 42.>", "<Lights on.>"])
      assert.deepStrictEqual(ofTag(t.events, "IntentDecided").map((e) => e.agentId), ["main"])
      assert.deepStrictEqual(ofTag(t.events, "ActionStarted").map((e) => [e.turnId, e.actionId]), [[1, "demo-home.lights_on"]])
      assert.deepStrictEqual(ofTag(t.events, "ActionFinished").map((e) => e.ok), [true])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("each agent gets its own system prompt, the shared history and the turn's tools", () => {
    const tool = makeTool({ name: "lookup", description: "l", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(1) })
    const a = makeScriptedAgent({ id: "main", systemPrompt: "A" }, [say("From A.")])
    const b = makeScriptedAgent({ id: "jev", kind: "intent" }, [say("From B.")])
    const setup = makeAgentSetup({
      agents: [a.agent, b.agent],
      routing: routing(),
      registry: makeToolRegistry([{ name: "m", tools: [tool], context: [{ name: "Clock", get: Effect.succeed("noon") }] }]),
      extra: { promptFor: (agent) => `${agent.systemPrompt ?? "global"} + voice` }
    })
    const t = harness({ setup })
    return Effect.gen(function*() {
      yield* run([endOfTurn("one"), sleep(500), endOfTurn("hey jev two")])
      assert.strictEqual(a.probe.inputs[0]!.system, "A + voice")
      assert.strictEqual(b.probe.inputs[0]!.system, "global + voice")
      assert.strictEqual(a.probe.inputs[0]!.context, "## Clock\nnoon")
      assert.deepStrictEqual(a.probe.inputs[0]!.tools.specs.map((s) => s.name), ["lookup"])
      assert.deepStrictEqual(b.probe.inputs[0]!.history, [{ role: "user", content: "one" }, { role: "assistant", content: "From A.", agentId: "main" }])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("makeModelAgent: maxToolRounds is read from each turn's setup (live)", () => {
    const tool = makeTool({ name: "lookup", description: "l", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed(1) })
    const llm = makeScriptedLlm((_, index) => [toolCall(`t${index}`, "lookup", {})])
    let rounds = 1
    return Effect.gen(function*() {
      const service = yield* Effect.provide(Effect.service(Llm), llm.layer)
      const agent = { id: "main", name: "Main", kind: "model" as const, speculate: true, firstEventTimeoutMs: 5_000, turn: makeModelAgent({ llm: service }).turn }
      const t = harness({
        setup: () => makeAgentSetup({ agents: [agent], routing: routing(), registry: makeToolRegistry([{ name: "m", tools: [tool] }]), extra: { maxToolRounds: rounds } })
      })
      yield* Effect.gen(function*() {
        yield* run([endOfTurn("loop")])
        assert.strictEqual(llm.probe.requests.length, 2)
        rounds = 3
        yield* run([endOfTurn("loop again")])
        assert.strictEqual(llm.probe.requests.length, 2 + 4)
      }).pipe(Effect.provide(t.layer))
    })
  })

  it.effect("barge-in interrupts the agent's stream; history keeps only what was played", () => {
    const main = makeScriptedAgent({ id: "main" }, [[agentText("One. Two. "), sleep(10_000), agentText("Three.")]])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("count"), sleep(150), speechStarted], 20_000)
      assert.strictEqual(main.probe.interrupted, 1)
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "count" },
        { role: "assistant", content: "One. Two.", interrupted: true, agentId: "main" }
      ])
    }).pipe(Effect.provide(t.layer))
  })
})

describe("a turn records its events in order", () => {
  it.effect("Decision → IntentDecided carries the decision", () => {
    const decision = { decider: "keywords", outcome: "act" as const, params: [], ms: 3 }
    const jev = makeScriptedAgent({ id: "jev", kind: "intent" }, [[{ _tag: "Decision", decision } satisfies AgentEvent, agentText("Done.")]])
    const t = harness({ setup: makeAgentSetup({ agents: [jev.agent], routing: routing({ defaultAgent: "jev" }) }) })
    return Effect.gen(function*() {
      yield* run([endOfTurn("lights on")])
      assert.deepStrictEqual(ofTag(t.events, "IntentDecided"), [{ _tag: "IntentDecided", turnId: 1, agentId: "jev", decision }])
    }).pipe(Effect.provide(t.layer))
  })
})
