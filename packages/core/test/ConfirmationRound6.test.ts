// Review round 6: confirmation of an action declared `confirm: true` is an interaction core conducts
// itself, identically whichever agent proposed the action (intent, model or harness). The agent
// proposes; core speaks the action's own question, arms it once presented, offers the next committed
// turn to it before routing, and runs the action through ONE consumption operation at execution time.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { actionTool, defineAction, Param, type ParamOption, registerActions, type RegisteredAction } from "../src/Actions.ts"
import type { Agent, AgentEvent } from "../src/Agent.ts"
import { Conversation } from "../src/Conversation.ts"
import type { AgentTurnSetup, ConversationEvent, ConversationInput, PlaybackObserver } from "../src/ConversationEvents.ts"
import { choiceAnswer, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import type { LlmEvent, LlmRequest, Message, ToolResult } from "../src/Domain.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeModelAgent } from "../src/ModelAgent.ts"
import { CONFIRM_WINDOW_MS, confirmationAnswer, consumeConfirmation, makePendingIntents, PROPOSED_RESULT } from "../src/PendingIntents.ts"
import { AudioOutput } from "../src/Services.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  makeAgentSetup,
  makeMarkerTts,
  makeRecordingAudioOutput,
  scripted,
  sleep,
  speechStarted,
  testTurnTraceLayer
} from "../src/testing.ts"

const rooms: Array<ParamOption> = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:bedroom", label: "Bedroom" }]

/** A house: `all_off` and `wipe` (per room) need a confirmation; `lights_on` does not. `register()` makes new registrations (a reconfigured module). */
const house = () => {
  const runs: Array<string> = []
  const register = () =>
    registerActions("home", [
      defineAction({
        id: "all_off",
        label: "Switch everything off",
        description: "Switch off every light in the house at once.",
        examples: ["switch everything off"],
        params: {},
        confirm: true,
        announce: () => "Everything is off.",
        run: () => Effect.sync(() => void runs.push("all_off"))
      }),
      defineAction({
        id: "wipe",
        label: "Reset the room",
        description: "Reset every device in a room.",
        params: { target: Param.dynamic({ label: "Room", options: () => rooms }) },
        confirm: (p) => `Reset the ${String(p.target).slice(5)}? Every device goes back to its defaults.`,
        run: (p) => Effect.sync(() => void runs.push(`wipe ${String(p.target)}`))
      }),
      defineAction({
        id: "lights_on",
        label: "Turn lights on",
        description: "Switch on the lights in a room.",
        params: { target: Param.dynamic({ label: "Room", options: () => rooms }) },
        run: (p) => Effect.sync(() => void runs.push(`lights_on ${String(p.target)}`))
      })
    ])
  return { runs, register }
}

const allOffCall = (id = "c1"): LlmEvent => ({ _tag: "ToolCall", id, name: "home_all_off", input: {} })
const wipeCall = (target: string, id = "c1"): LlmEvent => ({ _tag: "ToolCall", id, name: "home_wipe", input: { target } })

/**
 * A model agent over a scripted `Llm`: on a user message it makes the calls `plan(text)` gives
 * (none: says "ok"); after tool results it keeps talking (`after`), which core must discard.
 */
const scriptedModel = (plan: (text: string) => ReadonlyArray<LlmEvent>, after = "Done, all switched off!") => {
  const results: Array<ToolResult> = []
  const requests: Array<LlmRequest> = []
  const users: Array<string> = []
  const llm = {
    stream: (request: LlmRequest) =>
      Stream.suspend(() => {
        requests.push(request)
        const last = request.messages[request.messages.length - 1]!
        if (last.role === "tool") {
          results.push(...last.results)
          return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: after }, { _tag: "Done", stopReason: "end" }])
        }
        if (last.role === "user") users.push(last.content)
        const calls = last.role === "user" ? plan(last.content) : []
        return Stream.fromIterable<LlmEvent>(calls.length > 0 ? [...calls, { _tag: "Done", stopReason: "tool_use" }] : [{ _tag: "TextDelta", text: "ok" }, { _tag: "Done", stopReason: "end" }])
      })
  }
  const agent: Agent = { id: "main", name: "Main", kind: "model", speculate: true, firstEventTimeoutMs: 5_000, ...makeModelAgent({ llm }) }
  return { agent, results, requests, users }
}

/** A harness agent: calls the assistant's tools in-process (as the MCP bridge does), reporting them, then keeps talking. */
const scriptedHarness = (plan: (text: string) => { readonly name: string; readonly input: unknown } | undefined, then: ReadonlyArray<AgentEvent> = [{ _tag: "TextDelta", text: "Done!" }]) => {
  const results: Array<ToolResult> = []
  const users: Array<string> = []
  const histories: Array<ReadonlyArray<Message>> = []
  const agent: Agent = {
    id: "main",
    name: "Harness",
    kind: "harness",
    speculate: false,
    firstEventTimeoutMs: 5_000,
    turn: (input) =>
      Stream.suspend(() => {
        users.push(input.text)
        histories.push(input.history)
        const call = plan(input.text)
        if (call === undefined) return Stream.make({ _tag: "TextDelta", text: "ok" } as AgentEvent)
        const c = { id: `h${input.turnId}`, name: call.name, input: call.input }
        return Stream.make({ _tag: "ToolStarted", call: c } as AgentEvent).pipe(
          Stream.concat(Stream.unwrap(Effect.map(input.tools.run(c), (r): Stream.Stream<AgentEvent> => {
            results.push(r)
            return Stream.make({ _tag: "ToolFinished", result: r, ms: 1 } as AgentEvent)
          }))),
          Stream.concat(Stream.fromIterable(then))
        )
      })
  }
  return { agent, results, users, histories }
}

const one = (value: number): DecisionAnswer => ({ type: "noul", value })
/** A provider that confidently picks `home.all_off`, and says yes to every pending question. */
const allOffDecider = () =>
  makeScriptedDecider((request: DecisionRequest) => {
    const answers: Record<string, DecisionAnswer> = { action: choiceAnswer({ "home.all_off": 1 }), fits: one(1), compound: one(0) }
    if (request.questions["pending/answers"] !== undefined) {
      answers["pending/answers"] = one(1)
      answers["pending/yes"] = one(1)
    }
    return { answers }
  }, { id: "keywords" })

const jevAgent = () => {
  const intent = makeIntentAgent({ deciders: ["keywords"] })
  let calls = 0
  const agent: Agent = {
    id: "jev",
    name: "Jev",
    kind: "intent",
    speculate: true,
    firstEventTimeoutMs: 5_000,
    turn: (input) => {
      calls++
      return intent.turn(input)
    }
  }
  return { agent, calls: () => calls }
}

const setupFor = (
  agents: ReadonlyArray<Agent>,
  actions: () => ReadonlyArray<RegisteredAction>,
  routing: Record<string, unknown> = { defaultAgent: "main" }
): Effect.Effect<AgentTurnSetup> => {
  let current: AgentTurnSetup | undefined
  let built: ReadonlyArray<RegisteredAction> | undefined
  return Effect.sync(() => {
    const acts = actions()
    if (current !== undefined && built === acts) return current
    built = acts
    current = makeAgentSetup({
      agents,
      routing,
      registry: makeToolRegistry([{ name: "home", tools: acts.map(actionTool) }]),
      extra: { actions: acts, deciders: new Map([["keywords", allOffDecider()]]) }
    })
    return current
  })
}

const conversation = (setup: Effect.Effect<AgentTurnSetup>, events?: Array<ConversationEvent>, extra: Record<string, unknown> = {}) =>
  Conversation.layerWithAgents({ setup, confirmActions: "on", ...(events !== undefined ? { onEvent: (e) => void events.push(e) } : {}), ...extra }).pipe(
    Layer.provideMerge(testTurnTraceLayer)
  )
const typed = (text: string, agentId?: string) =>
  Effect.flatMap(Effect.service(Conversation), (c) =>
    Stream.runCollect(c.textTurn(text, agentId !== undefined ? { agentId } : undefined)).pipe(Effect.map((chunks) => Array.from(chunks).join(""))))
const historyOf = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const lastAssistant = (h: ReadonlyArray<Message>) => [...h].reverse().find((m) => m.role === "assistant")

type Kind = "intent" | "model" | "harness"
/** One proposer of `home.all_off` of each kind, with "main" (a model saying "ok") as the conversational default. */
const proposer = (kind: Kind) => {
  const h = house()
  const acts = h.register()
  if (kind === "intent") {
    const jev = jevAgent()
    const main = scriptedModel(() => [])
    return { h, acts, calls: jev.calls, setup: setupFor([main.agent, jev.agent], () => acts, { defaultAgent: "jev", fallbackAgent: "main" }), proposerId: "jev" }
  }
  if (kind === "model") {
    const model = scriptedModel((text) => (text === "switch everything off" ? [allOffCall()] : []))
    return { h, acts, calls: () => model.users.length, setup: setupFor([model.agent], () => acts), proposerId: "main" }
  }
  const harness = scriptedHarness((text) => (text === "switch everything off" ? { name: "home_all_off", input: {} } : undefined))
  return { h, acts, calls: () => harness.users.length, setup: setupFor([harness.agent], () => acts), proposerId: "main" }
}

describe("round 6: core conducts the confirmation, whichever agent proposed", () => {
  for (const kind of ["intent", "model", "harness"] as const) {
    it.effect(`${kind}: the question is core's and nothing is said after it; "yes" runs the action once, without the agent`, () => {
      const t = proposer(kind)
      return Effect.gen(function*() {
        const said = yield* typed("switch everything off")
        assert.deepStrictEqual(t.h.runs, [])
        assert.isTrue(said.trimEnd().endsWith("Switch everything off?"), `said: ${JSON.stringify(said)}`)
        assert.notInclude(said, "Done")
        const h1 = yield* historyOf
        const q = lastAssistant(h1)
        assert.strictEqual(q?.role === "assistant" ? q.content : undefined, "Switch everything off?")
        assert.strictEqual(q?.role === "assistant" ? q.agentId : undefined, t.proposerId)
        const before = t.calls()
        const done = yield* typed("yes")
        assert.deepStrictEqual(t.h.runs, ["all_off"])
        assert.include(done, "Everything is off.")
        assert.strictEqual(t.calls(), before, "no agent answered the yes")
        const h2 = yield* historyOf
        // Round 7: the outcome follows as an explicit note.
        assert.deepStrictEqual(h2.slice(-3).map((m) => (m.role === "tool" ? "tool" : `${m.role}: ${m.content}`)), [
          "user: yes",
          "assistant: Everything is off.",
          "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]"
        ])
        // Consumed: another "yes" is a fresh request and does not run it again.
        yield* typed("yes")
        assert.deepStrictEqual(t.h.runs, ["all_off"])
      }).pipe(Effect.provide(conversation(t.setup)))
    })

    it.effect(`${kind}: a refusal does not run it and says so; a later yes does nothing`, () => {
      const t = proposer(kind)
      return Effect.gen(function*() {
        yield* typed("switch everything off")
        const said = yield* typed("no, never mind")
        assert.include(said, "OK, I won't.")
        yield* typed("yes")
        assert.deepStrictEqual(t.h.runs, [])
      }).pipe(Effect.provide(conversation(t.setup)))
    })

    it.effect(`${kind}: an unrelated sentence drops it and is routed as usual; a later yes does nothing`, () => {
      const t = proposer(kind)
      return Effect.gen(function*() {
        yield* typed("switch everything off")
        const before = t.calls()
        yield* typed("what is the weather like")
        assert.isAbove(t.calls(), before, "routed to the agent")
        yield* typed("yes")
        assert.deepStrictEqual(t.h.runs, [])
      }).pipe(Effect.provide(conversation(t.setup)))
    })

    it.effect(`${kind}: the module disabled or reconfigured between question and answer: not run`, () => {
      const h = house()
      let acts: ReadonlyArray<RegisteredAction> = h.register()
      const make = () => {
        if (kind === "intent") return setupFor([scriptedModel(() => []).agent, jevAgent().agent], () => acts, { defaultAgent: "jev", fallbackAgent: "main" })
        if (kind === "model") return setupFor([scriptedModel((text) => (text === "switch everything off" ? [allOffCall()] : [])).agent], () => acts)
        return setupFor([scriptedHarness((text) => (text === "switch everything off" ? { name: "home_all_off", input: {} } : undefined)).agent], () => acts)
      }
      return Effect.gen(function*() {
        yield* typed("switch everything off")
        acts = [] // disabled
        yield* typed("yes")
        acts = h.register() // enabled again: a new registration
        yield* typed("yes")
        assert.deepStrictEqual(h.runs, [])
        yield* typed("switch everything off")
        acts = h.register() // reconfigured while asking
        yield* typed("yes")
        assert.deepStrictEqual(h.runs, [])
      }).pipe(Effect.provide(conversation(make())))
    })
  }

  it.effect("a model that keeps talking after the tool call: nothing after the call is spoken or recorded; the next request sees what happened", () => {
    const h = house()
    const acts = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [allOffCall()] : []))
    return Effect.gen(function*() {
      const said = yield* typed("switch everything off")
      assert.notInclude(said, "Done")
      assert.strictEqual(model.requests.length, 1, "no second model request in the proposing turn")
      yield* typed("yes")
      yield* typed("is it dark now")
      const seen = model.requests.at(-1)!.messages.map((m) => (m.role === "tool" ? `tool: ${m.results[0]!.content}` : `${m.role}: ${m.content}${m.role === "assistant" && m.toolCalls !== undefined ? ` [${m.toolCalls.map((c) => c.name).join()}]` : ""}`))
      assert.deepStrictEqual(seen, [
        "user: switch everything off",
        "assistant:  [home_all_off]",
        `tool: ${PROPOSED_RESULT}`,
        "assistant: Switch everything off?",
        "user: yes",
        "assistant: Everything is off.",
        "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.]",
        "user: is it dark now"
      ])
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })

  it.effect("a harness keeps its session: what core asked and did reaches it through the shared history (catch-up)", () => {
    const h = house()
    const acts = h.register()
    const harness = scriptedHarness((text) => (text === "switch everything off" ? { name: "home_all_off", input: {} } : undefined))
    return Effect.gen(function*() {
      yield* typed("switch everything off")
      assert.deepStrictEqual(harness.results.map((r) => r.content), [PROPOSED_RESULT])
      yield* typed("yes")
      yield* typed("thanks")
      const history = harness.histories.at(-1)!
      assert.deepStrictEqual(history.filter((m) => m.role !== "tool").map((m) => `${m.role}: ${m.content}${m.role === "assistant" ? ` (${m.agentId})` : ""}`), [
        "user: switch everything off",
        "assistant:  (main)",
        "assistant: Switch everything off? (main)",
        "user: yes",
        "assistant: Everything is off. (main)",
        "assistant: [Switch everything off: the owner confirmed; it ran and succeeded.] (main)"
      ])
    }).pipe(Effect.provide(conversation(setupFor([harness.agent], () => acts))))
  })

  it.effect("parallel tool calls in one turn: the first proposal wins, every other call is refused, nothing runs", () => {
    const h = house()
    const acts = h.register()
    const model = scriptedModel((text) => (text === "do it all" ? [allOffCall("a"), wipeCall("kitchen", "b"), { _tag: "ToolCall", id: "c", name: "home_lights_on", input: { target: "kitchen" } }] : []))
    const events: Array<ConversationEvent> = []
    return Effect.gen(function*() {
      const said = yield* typed("do it all")
      const results = events.flatMap((e) => (e._tag === "ToolFinished" ? [e.result] : []))
      assert.strictEqual(results.length, 3)
      const proposed = results.filter((r) => r.content === PROPOSED_RESULT)
      assert.strictEqual(proposed.length, 1)
      assert.isTrue(results.filter((r) => r !== proposed[0]).every((r) => r.isError && r.content.startsWith("Not run")))
      assert.deepStrictEqual(h.runs, [])
      // The question is that of the one proposal.
      assert.isTrue(said.includes("Switch everything off?") !== said.includes("Reset the kitchen?"))
      assert.strictEqual(model.requests.length, 1)
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts), events)))
  })

  it.effect("a second proposal while one is pending replaces it: the owner hears the new question, and yes runs only the new one", () => {
    const h = house()
    const acts = h.register()
    const model = scriptedModel((text) => (text === "switch everything off" ? [allOffCall()] : text === "reset the bedroom" ? [wipeCall("bedroom")] : []))
    return Effect.gen(function*() {
      yield* typed("switch everything off")
      const said = yield* typed("reset the bedroom")
      assert.include(said, "Reset the room: room Bedroom?")
      yield* typed("yes")
      assert.deepStrictEqual(h.runs, ["wipe area:bedroom"])
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })

  it.effect("an intent parameter question and a confirmation: the newest replaces the older", () => {
    const h = house()
    const acts = h.register()
    // jev asks "Which room?" for lights_on; then main proposes all_off; then the answer "the kitchen" is no answer any more.
    let n = 0
    const decider = makeScriptedDecider((request: DecisionRequest) => {
      n++
      return { answers: { action: choiceAnswer({ "home.lights_on": 1 }), fits: one(1), compound: one(0), "home.lights_on/target": choiceAnswer({ "area:kitchen": 0.5, "area:bedroom": 0.5 }), "pending/answers": one(1), "pending/answer": choiceAnswer({ "area:kitchen": 1 }) } }
    }, { id: "keywords" })
    const jev: Agent = { id: "jev", name: "Jev", kind: "intent", speculate: true, firstEventTimeoutMs: 5_000, turn: makeIntentAgent({ deciders: ["keywords"] }).turn }
    const model = scriptedModel((text) => (text === "switch everything off" ? [allOffCall()] : []))
    const setup = Effect.sync(() =>
      makeAgentSetup({
        agents: [model.agent, jev],
        routing: { defaultAgent: "main" },
        registry: makeToolRegistry([{ name: "home", tools: acts.map(actionTool) }]),
        extra: { actions: acts, deciders: new Map([["keywords", decider]]) }
      })
    )
    return Effect.gen(function*() {
      const asked = yield* typed("hey jev lights on")
      assert.include(asked, "Which room?")
      yield* typed("switch everything off", "main")
      yield* typed("hey jev the kitchen")
      assert.deepStrictEqual(h.runs, [], "the question was replaced by the confirmation, and the confirmation by the next turn")
      assert.isAbove(n, 1)
    }).pipe(Effect.provide(conversation(setup)))
  })

  it.effect("reviewer probe 1: a proposal followed by a Handoff in the same turn never reaches the fallback; nothing runs on that turn", () => {
    const h = house()
    const acts = h.register()
    const jev = jevAgent()
    // main (harness) calls home_all_off and then hands off; jev would happily act on "yes".
    const main = scriptedHarness(() => ({ name: "home_all_off", input: {} }), [{ _tag: "Handoff", reason: "not mine" }])
    return Effect.gen(function*() {
      const said = yield* typed("yes")
      assert.deepStrictEqual(h.runs, [])
      assert.strictEqual(jev.calls(), 0, "the fallback did not run")
      assert.isTrue(said.trimEnd().endsWith("Switch everything off?"))
    }).pipe(Effect.provide(conversation(setupFor([main.agent, jev.agent], () => acts, { defaultAgent: "main", fallbackAgent: "jev" }))))
  })

  it.effect("the generated tool never runs a confirm: true action by itself, and says why", () => {
    const h = house()
    const acts = h.register()
    const registry = makeToolRegistry([{ name: "home", tools: acts.map(actionTool) }])
    return Effect.gen(function*() {
      const r = yield* registry.run({ id: "x", name: "home_all_off", input: {} })
      assert.isTrue(r.isError)
      assert.deepStrictEqual(h.runs, [])
      assert.include(registry.specs.find((s) => s.name === "home_all_off")!.description, "Do not ask the owner yourself")
    })
  })

  it.effect("invalid or incomplete values are refused, not proposed", () => {
    const h = house()
    const acts = h.register()
    const model = scriptedModel((text) => (text === "reset" ? [wipeCall("attic")] : text === "reset it" ? [{ _tag: "ToolCall", id: "c", name: "home_wipe", input: {} }] : []))
    return Effect.gen(function*() {
      yield* typed("reset")
      yield* typed("reset it")
      assert.isTrue(model.results.every((r) => r.isError))
      yield* typed("yes")
      assert.deepStrictEqual(h.runs, [])
    }).pipe(Effect.provide(conversation(setupFor([model.agent], () => acts))))
  })

  it("closed grammars: confirmation, refusal, anything else", () => {
    for (const yes of ["yes", "Yes please", "ja, doe maar", "go ahead"]) assert.strictEqual(confirmationAnswer(yes), "yes", yes)
    for (const no of ["no", "No thanks", "cancel", "never mind", "nee", "laat maar", "niet doen"]) assert.strictEqual(confirmationAnswer(no), "no", no)
    for (const other of ["yes?", "no?", "what time is it", "yes turn on the kitchen", "maybe"]) assert.strictEqual(confirmationAnswer(other), "other", other)
  })

  it("the consumption operation: current, armed, later turn, open window, same registration", () => {
    const h = house()
    const acts = h.register()
    const store = makePendingIntents()
    const intent = { action: acts[0]!, params: {}, missing: [], awaiting: { kind: "confirm" as const, question: "?" }, probability: 1 }
    const entry = { intent, at: 1_000, armedAt: 1_000, until: 1_000 + CONFIRM_WINDOW_MS, turnId: 3 }
    store.set(entry)
    assert.isUndefined(consumeConfirmation(store, entry, { turnId: 3, now: 2_000, actions: acts }), "the proposing turn itself")
    assert.isUndefined(consumeConfirmation(store, entry, { turnId: 4, now: 900, actions: acts }), "before arming")
    assert.isUndefined(consumeConfirmation(store, { ...entry }, { turnId: 4, now: 2_000, actions: acts }), "not the current entry")
    assert.isUndefined(consumeConfirmation(store, entry, { turnId: 4, now: 16_000, actions: acts }), "window closed")
    store.set(entry)
    assert.isUndefined(consumeConfirmation(store, entry, { turnId: 4, now: 2_000, actions: h.register() }), "another registration")
    assert.isUndefined(store.current(2_000), "an entry whose action is gone is dropped")
    store.set(entry)
    assert.strictEqual(consumeConfirmation(store, entry, { turnId: 4, now: 2_000, actions: acts }), entry)
    assert.isUndefined(consumeConfirmation(store, entry, { turnId: 5, now: 2_100, actions: acts }), "used once")
  })
})

// ---------------------------------------------------------------------------
// Spoken: arming, the window, interruption policy, eager answers.

/** Runs `script` through `voice` with a model proposing on "switch everything off" / "reset the kitchen". */
const voiceRun = (
  script: ReadonlyArray<ConversationInput | ReturnType<typeof sleep>>,
  options: { readonly output?: Layer.Layer<AudioOutput>; readonly window?: number } = {}
) => {
  const h = house()
  const acts = h.register()
  const model = scriptedModel((text) => (text === "switch everything off" ? [allOffCall()] : text === "reset the kitchen" ? [wipeCall("kitchen")] : []))
  const events: Array<ConversationEvent> = []
  const layer = conversation(setupFor([model.agent], () => acts), events, options.window !== undefined ? { confirmWindowMs: options.window } : {}).pipe(
    Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, options.output ?? makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
  )
  return Effect.gen(function*() {
    const c = yield* Conversation
    const fiber = yield* Effect.forkChild(c.voice(scripted(script)))
    for (let i = 0; i < 400; i++) {
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      yield* TestClock.adjust(100)
    }
    yield* Fiber.join(fiber)
    return { runs: h.runs, model, events, history: yield* c.history }
  }).pipe(Effect.provide(layer))
}

describe("round 6: arming and the response window (spoken)", () => {
  // "Switch everything off?" is one clause: it plays [0, 100) ms and is armed at ~100 ms.
  it.effect("a yes after the question finished playing runs it", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(1_000), speechStarted, endOfTurn("yes")])
      assert.deepStrictEqual(r.runs, ["all_off"])
    }))

  it.effect("reviewer probe 2: eager yes inside the window, final yes after it closed: not run (the clock is read at promotion)", () =>
    Effect.gen(function*() {
      const late = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(14_000), speechStarted, eagerEndOfTurn("yes"), sleep(2_000), endOfTurn("yes")])
      assert.deepStrictEqual(late.runs, [])
      // Round 7: core answers it (the window had closed) rather than passing "yes" on as a fresh request.
      assert.notInclude(late.model.users, "yes")
      const inTime = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(1_000), speechStarted, eagerEndOfTurn("yes"), sleep(500), endOfTurn("yes")])
      assert.deepStrictEqual(inTime.runs, ["all_off"], "a turn promoted from an eager yes runs it")
    }))

  it.effect("the window is counted from arming, not from the proposal, and is a setting", () =>
    Effect.gen(function*() {
      // A slow question (two clauses, 200 ms) does not eat into the window; a short window closes.
      const ok = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(2_100), speechStarted, endOfTurn("yes")], { window: 2_000 })
      assert.deepStrictEqual(ok.runs, ["wipe area:kitchen"])
      const closed = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(2_400), speechStarted, endOfTurn("yes")], { window: 2_000 })
      assert.deepStrictEqual(closed.runs, [])
    }))

  it.effect("a yes during the question's first clause (barge-in): not armed, not run", () =>
    Effect.gen(function*() {
      // "Reset the kitchen?" plays [0, 100), "Every device goes back to its defaults." [100, 200).
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(50), speechStarted, endOfTurn("yes")])
      assert.deepStrictEqual(r.runs, [])
    }))

  it.effect("a yes over the question's final clause (barge-in after it started): not armed, not run (round 7: no barge-in shortcut)", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(150), speechStarted, endOfTurn("yes")])
      assert.deepStrictEqual(r.runs, [])
    }))

  it.effect("the question stopped with Stop (even over its final clause): not armed", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(150), { _tag: "Interrupt" }, sleep(100), speechStarted, endOfTurn("yes")])
      assert.deepStrictEqual(r.runs, [])
    }))

  it.effect("the question's playback fails: not armed", () =>
    Effect.gen(function*() {
      const failing = Layer.succeed(AudioOutput, AudioOutput.of({ play: () => Effect.die("speaker gone") }))
      const r = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(1_000), speechStarted, endOfTurn("yes")], { output: failing })
      assert.deepStrictEqual(r.runs, [])
    }))

  it.effect("a typed yes (TextInput, from any tab) answers it", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(1_000), { _tag: "TextInput", text: "yes", speak: false }])
      assert.deepStrictEqual(r.runs, ["all_off"])
    }))

  it.effect("a yes after the window: handled normally, not run", () =>
    Effect.gen(function*() {
      const r = yield* voiceRun([speechStarted, endOfTurn("switch everything off"), sleep(CONFIRM_WINDOW_MS + 500), speechStarted, endOfTurn("yes")])
      assert.deepStrictEqual(r.runs, [])
    }))
})

// ---------------------------------------------------------------------------
// PlaybackObserver.final: the authoritative count decides which clauses were heard.

/** An output that reports progress past every chunk handed over, then, when interrupted, a lower final count. */
const finalReportingOutput = (finalAt: (handed: number, samplesPerChunk: ReadonlyArray<number>) => number) =>
  Layer.succeed(
    AudioOutput,
    AudioOutput.of({
      reportsPlayback: true,
      play: <E>(audio: Stream.Stream<Uint8Array, E>, _rate: number, observer?: PlaybackObserver) =>
        Effect.suspend(() => {
          let played = 0
          const sizes: Array<number> = []
          let first = true
          return audio.pipe(
            Stream.runForEach((chunk) =>
              Effect.gen(function*() {
                if (first) observer?.started()
                first = false
                sizes.push(chunk.length >> 1)
                played += chunk.length >> 1
                observer?.progress(played)
                yield* Effect.sleep(100)
              })
            ),
            Effect.onExit(() => Effect.sync(() => observer?.final?.(finalAt(sizes.length, sizes))))
          )
        })
    })
  )

describe("PlaybackObserver.final", () => {
  it.effect("a final count below an earlier progress value shrinks what was heard, before history is committed", () =>
    Effect.gen(function*() {
      // A model says two clauses; progress reaches the second clause's start, the final count stops inside the first.
      const llm = {
        stream: () => Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: "The first sentence is here. And the second one follows. " }, { _tag: "Done", stopReason: "end" }])
      }
      const agent: Agent = { id: "main", name: "Main", kind: "model", speculate: true, firstEventTimeoutMs: 5_000, ...makeModelAgent({ llm }) }
      const events: Array<ConversationEvent> = []
      const output = finalReportingOutput((_handed, sizes) => Math.max(0, (sizes[0] ?? 0) - 1))
      const layer = conversation(Effect.sync(() => makeAgentSetup({ agents: [agent], routing: { defaultAgent: "main" } })), events).pipe(
        Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, output))
      )
      const history = yield* Effect.gen(function*() {
        const c = yield* Conversation
        const fiber = yield* Effect.forkChild(c.voice(scripted([speechStarted, endOfTurn("talk"), sleep(150), speechStarted, sleep(100), endOfTurn("")])))
        for (let i = 0; i < 20; i++) {
          yield* Effect.repeat(Effect.yieldNow, { times: 20 })
          yield* TestClock.adjust(100)
        }
        yield* Fiber.join(fiber)
        return yield* c.history
      }).pipe(Effect.provide(layer))
      const playing = events.filter((e) => e._tag === "ClausePlaying").map((e) => (e._tag === "ClausePlaying" ? e.index : -1))
      assert.include(playing, 1, "the second clause was announced as playing from progress")
      const reply = history.find((m) => m.role === "assistant")
      assert.deepStrictEqual(reply?.role === "assistant" ? [reply.content, reply.interrupted] : [], ["The first sentence is here.", true], "only the first clause was heard")
    }))

  it.effect("arming uses the final count: progress reached the question's final clause, the final count did not", () =>
    Effect.gen(function*() {
      // "Reset the kitchen?" + "Every device goes back to its defaults.": interrupted at 150 ms; the final count ends inside the first clause.
      const output = finalReportingOutput((_handed, sizes) => Math.max(0, (sizes[0] ?? 0) - 1))
      const r = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(150), speechStarted, endOfTurn("yes")], { output })
      assert.deepStrictEqual(r.runs, [])
      // Round 7: with a full final count the same interruption does not arm it either (the answer began
      // before the question had been played to its end); played to the end, it is armed.
      const full = finalReportingOutput((_handed, sizes) => sizes.reduce((a, b) => a + b, 0))
      const interrupted = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(150), speechStarted, endOfTurn("yes")], { output: full })
      assert.deepStrictEqual(interrupted.runs, [])
      const armed = yield* voiceRun([speechStarted, endOfTurn("reset the kitchen"), sleep(400), speechStarted, endOfTurn("yes")], { output: full })
      assert.deepStrictEqual(armed.runs, ["wipe area:kitchen"])
    }))
})
