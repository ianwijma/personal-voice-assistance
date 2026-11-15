// Piece A of docs/AGENTS-AND-INTENTS.md: agents behind Conversation, routing at
// turn start, router state on commit, canned turns, notices, hand-off and failure
// fallback, Say, SetActiveAgent, the new events.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, Param, registerActions } from "../src/Actions.ts"
import type { Agent, AgentEvent } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionProvider, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
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
      yield* run([endOfTurn("count"), sleep(150), { _tag: "Say", text: "This is the natural voice." }], 10_000)
      assert.deepStrictEqual(played(t.out), ["<One.>", "<This is the natural voice.>"])
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

describe("review findings: Stop and manual routing against speculative turns", () => {
  it.effect("finding 9: Stop cancels a speculative turn, and its final EndOfTurn does not bring the reply back", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Hello."), say("Again."), say("Third.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        eagerEndOfTurn("hi"),
        sleep(10),
        { _tag: "Interrupt" },
        sleep(10),
        endOfTurn("hi"),
        sleep(1_000),
        // A new utterance is heard normally, even with the same words.
        speechStarted,
        eagerEndOfTurn("hi"),
        sleep(10),
        endOfTurn("hi"),
        sleep(1_000),
        endOfTurn("something else")
      ])
      assert.deepStrictEqual(played(t.out), ["<Again.>", "<Third.>"])
      assert.deepStrictEqual(yield* history, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Again.", agentId: "main" },
        { role: "user", content: "something else" },
        { role: "assistant", content: "Third.", agentId: "main" }
      ])
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["discarded", "completed", "completed"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("finding 10: an agent chosen by hand while a speculative turn waits is not overwritten by its promotion", () => {
    const main = makeScriptedAgent({ id: "main" }, [say("Main.")])
    const claude = makeScriptedAgent({ id: "claude-subscription" }, [say("Quark."), say("More.")])
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent, claude.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        eagerEndOfTurn("hey claude what is a quark"),
        sleep(20),
        { _tag: "SetActiveAgent", agentId: "main" },
        sleep(20),
        endOfTurn("hey claude what is a quark"),
        sleep(1_000),
        endOfTurn("tell me more")
      ])
      assert.deepStrictEqual(main.probe.inputs.map((i) => [i.text, i.routedBy]), [["tell me more", "sticky"]])
      assert.strictEqual((yield* routerState).sticky?.agentId, "main")
    }).pipe(Effect.provide(t.layer))
  })
})

describe("review round 2: Stop cancels an utterance, not a transcript (finding B)", () => {
  // Rule: Stop during a speculative turn cancels the utterance it belongs to. Everything the
  // recogniser sends for that utterance until its EndOfTurn (revised eager transcripts,
  // TurnResumed, a final transcript with different words) starts nothing; SpeechStarted,
  // typed text or Say begins something new. A recogniser that never ends the utterance
  // cannot keep the conversation deaf: the cancellation expires.
  const echo = () => makeScriptedAgent({ id: "main" }, (input) => [agentText(`(answer to ${input.text})`)])

  it.effect("a final transcript that differs from the stopped eager one starts nothing", () => {
    const main = echo()
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        speechStarted,
        eagerEndOfTurn("turn on kitchen lights"),
        sleep(10),
        { _tag: "Interrupt" },
        sleep(10),
        endOfTurn("turn on the kitchen lights"),
        sleep(1_000)
      ])
      assert.deepStrictEqual(played(t.out), [])
      assert.deepStrictEqual(yield* history, [])
      assert.deepStrictEqual((yield* traces).map((tr) => tr.outcome), ["discarded"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("revisions after Stop (TurnResumed, a new eager transcript, the final one) all belong to the stopped utterance", () => {
    const main = echo()
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        speechStarted,
        eagerEndOfTurn("turn on"),
        sleep(10),
        { _tag: "Interrupt" },
        turnResumed,
        eagerEndOfTurn("turn on the kitchen"),
        sleep(10),
        eagerEndOfTurn("turn on the kitchen lights"),
        sleep(10),
        endOfTurn("turn on the kitchen lights please"),
        sleep(1_000),
        // The next utterance is heard, with the same words or others.
        speechStarted,
        eagerEndOfTurn("turn on the kitchen lights please"),
        sleep(10),
        endOfTurn("turn on the kitchen lights please"),
        sleep(1_000)
      ])
      assert.deepStrictEqual(played(t.out), ["<(answer to turn on the kitchen lights please)>"])
      assert.deepStrictEqual(main.probe.inputs.map((i) => i.text), ["turn on", "turn on the kitchen lights please"], "nothing between Stop and the next utterance started")
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("the utterance ends with its EndOfTurn, even from a recogniser that then sends no SpeechStarted", () => {
    const main = echo()
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        eagerEndOfTurn("hi"),
        sleep(10),
        { _tag: "Interrupt" },
        endOfTurn("hi there"),
        sleep(1_000),
        eagerEndOfTurn("hi"),
        sleep(10),
        endOfTurn("hi")
      ])
      assert.deepStrictEqual(played(t.out), ["<(answer to hi)>"])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("a recogniser that never ends the utterance cannot leave the conversation deaf: the cancellation expires", () => {
    const main = echo()
    const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
    return Effect.gen(function*() {
      yield* run([
        eagerEndOfTurn("hi"),
        sleep(10),
        { _tag: "Interrupt" },
        sleep(1_000),
        eagerEndOfTurn("hi"), // still within the bound: the same utterance
        sleep(30_000),
        eagerEndOfTurn("hi"),
        sleep(10),
        endOfTurn("hi")
      ], 40_000)
      assert.deepStrictEqual(played(t.out), ["<(answer to hi)>"])
      assert.strictEqual(main.probe.inputs.length, 2, "the eager turn of the still-cancelled utterance never started; the late one did")
    }).pipe(Effect.provide(t.layer))
  })
})

describe("review round 2: promotion compares the values said (finding C)", () => {
  // Rule (round 5, replacing round 2's looser comparison): a speculative turn is promoted
  // only when the final transcript is canonically the same (`canonicalUtterance`).
  const echo = () => makeScriptedAgent({ id: "main" }, (input) => [agentText(`(answer to ${input.text})`)])
  const pairs: ReadonlyArray<readonly [string, string, boolean]> = [
    ["dim the kitchen to 5 percent", "dim the kitchen to -5 percent", false],
    ["dim the kitchen to 5 percent", "dim the kitchen to − 5 percent", false],
    ["dim the kitchen to 5 percent", "dim the kitchen to - 5 percent", false],
    ["set it to 15 degrees", "set it to 1.5 degrees", false],
    ["zet hem op 15 graden", "zet hem op 1,5 graden", false],
    ["rooms 35", "rooms 3-5", false],
    ["dim to 40", "dim to 40%", false],
    ["set it to 1000", "set it to 1,000", false],
    // Round 5: every promotion compares canonical texts, so case, "?" and apostrophes count too.
    ["Turn on the lights", "turn on the lights.", false],
    ["dim the kitchen to 40 percent", "Dim the kitchen to 40 percent.", false],
    ["dim to 40", "Dim to 40!", false],
    ["what's the time", "whats the time?", false],
    // Only the ignorable punctuation of `Utterance.ts`: promoted.
    ["turn on the lights", "turn on the lights.", true],
    ["Dim the kitchen to 40 percent", "Dim the kitchen to 40 percent!", true],
    ["please, dim to 40", "please dim to 40.", true]
  ]
  it.effect("each pair: promoted, or discarded and decided again from the final words", () =>
    Effect.gen(function*() {
      for (const [eager, final, same] of pairs) {
        const main = echo()
        const t = harness({ setup: makeAgentSetup({ agents: [main.agent], routing: routing() }) })
        yield* Effect.gen(function*() {
          yield* run([eagerEndOfTurn(eager), sleep(50), endOfTurn(final), sleep(1_000)])
          const outcomes = (yield* traces).map((tr) => tr.outcome)
          const h = yield* history
          if (same) {
            assert.deepStrictEqual(outcomes, ["completed"], `${eager} / ${final}: promoted`)
          } else {
            assert.deepStrictEqual(outcomes, ["discarded", "completed"], `${eager} / ${final}: discarded`)
            assert.deepStrictEqual(h[0], { role: "user", content: final }, "history records the final words")
            assert.deepStrictEqual(played(t.out), [`<(answer to ${final})>`])
          }
        }).pipe(Effect.provide(t.layer))
      }
    }))
})

/** The real intent agent behind a Conversation: a two-room house and a scripted decider that asks for the room. */
const intentHouse = () => {
  const runs: Array<unknown> = []
  const rooms = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:hall", label: "Hall" }]
  const actions = registerActions("home", [
    defineAction({
      id: "lights_on",
      label: "Turn lights on",
      description: "Switch on the lights in a room.",
      params: { target: Param.dynamic({ label: "Room or light", options: () => rooms }) },
      announce: () => "Lights on.",
      run: (p) => Effect.sync(() => void runs.push(p))
    })
  ])
  const noul = (value: number): DecisionAnswer => ({ type: "noul", value })
  const decider = makeScriptedDecider((request: DecisionRequest) => {
    const base = { action: choiceAnswer({ "home.lights_on": 1 }), fits: noul(0.95), compound: noul(0.02) }
    if (request.questions["pending/answers"] !== undefined) {
      return { answers: { ...base, fits: noul(0.1), "pending/answers": noul(0.95), "pending/answer": choiceAnswer({ "area:kitchen": 0.95, "area:hall": 0.05 }) } }
    }
    return { answers: { ...base, "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, "area:hall": 0.5 }) } }
  }, { id: "keywords" })
  const intent = makeIntentAgent({ deciders: ["keywords"] })
  const jev: Agent = { id: "jev", name: "Jev", kind: "intent", speculate: true, firstEventTimeoutMs: 5_000, turn: intent.turn }
  return { runs, actions, decider, intent, jev }
}

describe("review round 2: the intent agent behind Conversation (findings F, G)", () => {
  it.effect("F: a hand-off because no decision provider runs drops the pending question, read through Conversation", () => {
    const house = intentHouse()
    const main = makeScriptedAgent({ id: "main" }, (input) => [agentText(`(answer to ${input.text})`)])
    let deciders: ReadonlyMap<string, DecisionProvider> = new Map([["keywords", house.decider]])
    const t = harness({
      setup: () => makeAgentSetup({ agents: [main.agent, house.jev], routing: routing(), extra: { actions: house.actions, deciders } })
    })
    return Effect.gen(function*() {
      const c = yield* Conversation
      const fiber = yield* Effect.forkChild(c.voice(scripted([
        endOfTurn("hey jev lights on"),
        sleep(1_000)
      ])))
      yield* advance(2_000)
      yield* Fiber.join(fiber)
      assert.strictEqual(house.intent.pending()?.awaiting.kind, "param", "the question is pending")
      deciders = new Map()
      const second = yield* Effect.forkChild(c.voice(scripted([endOfTurn("hey jev what is a quark"), sleep(1_000)])))
      yield* advance(2_000)
      yield* Fiber.join(second)
      assert.deepStrictEqual(main.probe.inputs.map((i) => i.text), ["What is a quark"], "the fallback agent answered")
      assert.strictEqual(house.intent.pending(), undefined, "the stale question was dropped")
      // A provider again, within the pending time: "the kitchen" does not resume the old action.
      deciders = new Map([["keywords", house.decider]])
      const third = yield* Effect.forkChild(c.voice(scripted([endOfTurn("hey jev the kitchen"), sleep(1_000)])))
      yield* advance(2_000)
      yield* Fiber.join(third)
      assert.deepStrictEqual(house.runs, [])
    }).pipe(Effect.provide(t.layer))
  })

  it.effect("G: an agent chosen by hand while a speculative intent question waits is not overridden by its ExpectReply", () => {
    const house = intentHouse()
    const main = makeScriptedAgent({ id: "main" }, (input) => [agentText(`(answer to ${input.text})`)])
    const t = harness({
      setup: makeAgentSetup({ agents: [main.agent, house.jev], routing: routing(), extra: { actions: house.actions, deciders: new Map([["keywords", house.decider]]) } })
    })
    return Effect.gen(function*() {
      yield* run([
        eagerEndOfTurn("hey jev lights on"),
        sleep(20),
        { _tag: "SetActiveAgent", agentId: "main" },
        sleep(20),
        endOfTurn("hey jev lights on"),
        sleep(1_000),
        endOfTurn("the kitchen"),
        sleep(1_000)
      ])
      assert.deepStrictEqual(played(t.out)[0], "<Which room or light?>", "the question was asked")
      assert.deepStrictEqual(main.probe.inputs.map((i) => [i.text, i.routedBy]), [["the kitchen", "sticky"]], "the owner's choice stands")
      assert.isUndefined((yield* routerState).armed)
      assert.deepStrictEqual(house.runs, [])
    }).pipe(Effect.provide(t.layer))
  })
})
