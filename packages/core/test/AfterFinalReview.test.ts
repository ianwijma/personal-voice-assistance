// After the final review (docs/AGENTS-AND-INTENTS.md, "After the final review"):
//
// 1. Actions declared `confirm: true` are refused unless the conversation's `confirmActions` is
//    "on" (default "off"): nothing becomes pending, no question is asked, nothing runs, the
//    proposing agent is told, the owner hears `ConfirmTexts.switchedOff`, history gets a note.
// 2. The confirmation question is always core's own; a module's `confirm` function is never called.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Logger, Stream } from "effect"
import { actionTool, defineAction, Param, type ParamOption, registerActions, type RegisteredAction } from "../src/Actions.ts"
import type { Agent, AgentEvent } from "../src/Agent.ts"
import { Conversation, DEFAULT_CONFIRM_TEXTS, DUTCH_CONFIRM_TEXTS, makeAgentConversation } from "../src/Conversation.ts"
import type { AgentConversationOptions } from "../src/Conversation.ts"
import type { AgentTurnSetup } from "../src/ConversationEvents.ts"
import { choiceAnswer, confirmationQuestion, type DecisionAnswer, type DecisionRequest, makeScriptedDecider } from "../src/Decision.ts"
import type { LlmEvent, LlmRequest, Message, ToolResult } from "../src/Domain.ts"
import { makeIntentAgent } from "../src/IntentAgent.ts"
import { makeModelAgent } from "../src/ModelAgent.ts"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { CONFIRMATIONS_OFF_REASON, CONFIRMATIONS_OFF_RESULT, PROPOSED_RESULT } from "../src/PendingIntents.ts"
import { Llm } from "../src/Services.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { makeAgentSetup, testTurnTraceLayer } from "../src/testing.ts"

const T = DEFAULT_CONFIRM_TEXTS
const rooms: Array<ParamOption> = [{ value: "area:kitchen", label: "Kitchen" }, { value: "area:bedroom", label: "Bedroom" }]

/** `all_off` needs a confirmation; `chime` does not (no parameters, so every route can run it). */
const house = () => {
  const runs: Array<string> = []
  const acts = registerActions("home", [
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
      id: "chime",
      label: "Ring the chime",
      description: "Ring the door chime.",
      examples: ["ring the chime"],
      params: {},
      run: () => Effect.sync(() => void runs.push("chime")).pipe(Effect.as({ say: "Ding." }))
    })
  ])
  return { runs, acts }
}

const toolCall = (name: string): LlmEvent => ({ _tag: "ToolCall", id: "c1", name, input: {} })

const scriptedModel = (plan: (text: string) => ReadonlyArray<LlmEvent>) => {
  const results: Array<ToolResult> = []
  const users: Array<string> = []
  const llm = {
    stream: (request: LlmRequest) =>
      Stream.suspend(() => {
        const last = request.messages[request.messages.length - 1]!
        if (last.role === "tool") {
          results.push(...last.results)
          return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: "Done!" }, { _tag: "Done", stopReason: "end" }])
        }
        if (last.role === "user") users.push(last.content)
        const calls = last.role === "user" ? plan(last.content) : []
        return Stream.fromIterable<LlmEvent>(calls.length > 0 ? [...calls, { _tag: "Done", stopReason: "tool_use" }] : [{ _tag: "TextDelta", text: "ok" }, { _tag: "Done", stopReason: "end" }])
      })
  }
  const agent: Agent = { id: "main", name: "Main", kind: "model", speculate: true, firstEventTimeoutMs: 5_000, ...makeModelAgent({ llm }) }
  return { agent, llm, results, users }
}

const scriptedHarness = (plan: (text: string) => string | undefined) => {
  const results: Array<ToolResult> = []
  const users: Array<string> = []
  const agent: Agent = {
    id: "main",
    name: "Harness",
    kind: "harness",
    speculate: false,
    firstEventTimeoutMs: 5_000,
    turn: (input) =>
      Stream.suspend(() => {
        users.push(input.text)
        const name = plan(input.text)
        if (name === undefined) return Stream.make({ _tag: "TextDelta", text: "ok" } as AgentEvent)
        const c = { id: `h${input.turnId}`, name, input: {} }
        return Stream.make({ _tag: "ToolStarted", call: c } as AgentEvent).pipe(
          Stream.concat(Stream.unwrap(Effect.map(input.tools.run(c), (r): Stream.Stream<AgentEvent> => {
            results.push(r)
            return Stream.make({ _tag: "ToolFinished", result: r, ms: 1 } as AgentEvent)
          })))
        )
      })
  }
  return { agent, results, users }
}

const one = (value: number): DecisionAnswer => ({ type: "noul", value })
/** Picks `home.all_off` for "switch everything off", `home.chime` for "ring the chime", nothing otherwise; yes to a pending question. */
const decider = () =>
  makeScriptedDecider((request: DecisionRequest) => {
    const u = request.state.utterance.toLowerCase()
    const pick = u.includes("everything off") ? "home.all_off" : u.includes("chime") ? "home.chime" : undefined
    const answers: Record<string, DecisionAnswer> = pick === undefined
      ? { fits: one(0), compound: one(0) }
      : { action: choiceAnswer({ [pick]: 1 }), fits: one(1), compound: one(0) }
    if (request.questions["pending/answers"] !== undefined) {
      answers["pending/answers"] = one(1)
      answers["pending/yes"] = one(1)
    }
    return { answers }
  }, { id: "keywords" })

type Kind = "intent" | "model" | "harness"
/** A proposer of each kind; "main" is the conversational agent (for intent: its fallback). */
const proposer = (kind: Kind) => {
  const h = house()
  const plan = (text: string) => (text === "switch everything off" ? "home_all_off" : text === "ring the chime" ? "home_chime" : undefined)
  const setupWith = (agents: ReadonlyArray<Agent>, routing: Record<string, unknown>): AgentTurnSetup =>
    makeAgentSetup({
      agents,
      routing,
      registry: makeToolRegistry([{ name: "home", tools: h.acts.map(actionTool) }]),
      extra: { actions: h.acts, deciders: new Map([["keywords", decider()]]) }
    })
  if (kind === "intent") {
    const main = scriptedModel(() => [])
    const jev: Agent = { id: "jev", name: "Jev", kind: "intent", speculate: true, firstEventTimeoutMs: 5_000, turn: makeIntentAgent({ deciders: ["keywords"] }).turn }
    return { h, mainCalls: () => main.users.length, results: [] as Array<ToolResult>, setup: setupWith([main.agent, jev], { defaultAgent: "jev", fallbackAgent: "main" }), proposerId: "jev" }
  }
  if (kind === "model") {
    const model = scriptedModel((text) => {
      const name = plan(text)
      return name === undefined ? [] : [toolCall(name)]
    })
    return { h, mainCalls: () => model.users.length, results: model.results, setup: setupWith([model.agent], { defaultAgent: "main" }), proposerId: "main" }
  }
  const harness = scriptedHarness(plan)
  return { h, mainCalls: () => harness.users.length, results: harness.results, setup: setupWith([harness.agent], { defaultAgent: "main" }), proposerId: "main" }
}

const conversation = (setup: AgentTurnSetup, extra: Partial<AgentConversationOptions> = {}) =>
  Conversation.layerWithAgents({ setup: Effect.succeed(setup), ...extra }).pipe(Layer.provideMerge(testTurnTraceLayer))
const typed = (text: string) =>
  Effect.flatMap(Effect.service(Conversation), (c) => Stream.runCollect(c.textTurn(text)).pipe(Effect.map((chunks) => Array.from(chunks).join(""))))
const historyOf = Effect.flatMap(Effect.service(Conversation), (c) => c.history)
const show = (h: ReadonlyArray<Message>) => h.map((m) => (m.role === "tool" ? `tool: ${m.results.map((r) => r.content).join(" | ")}` : `${m.role}: ${m.content}`))

describe("after the final review, change 1: confirmation-required actions are off unless enabled", () => {
  it("the fixed sentence exists in English and Dutch", () => {
    assert.strictEqual(T.switchedOff, "I can't do that: it needs a confirmation step, and confirmations are switched off.")
    assert.strictEqual(DUTCH_CONFIRM_TEXTS.switchedOff, "Dat kan ik niet doen: daarvoor is een bevestiging nodig, en bevestigen staat uit.")
  })

  for (const kind of ["intent", "model", "harness"] as const) {
    for (const option of [undefined, "off"] as const) {
      const label = option === undefined ? "default" : "\"off\""
      it.effect(`${kind}, ${label}: the proposal is refused; nothing runs or is asked; the owner hears why; history notes it; a later yes is an ordinary message`, () => {
        const t = proposer(kind)
        return Effect.gen(function*() {
          const said = yield* typed("switch everything off")
          assert.deepStrictEqual(t.h.runs, [])
          assert.include(said, T.switchedOff)
          assert.notInclude(said, "Switch everything off?")
          assert.notInclude(said, "Done!")
          const h1 = yield* historyOf
          const notes = h1.filter((m) => m.role === "assistant").map((m) => m.content)
          assert.include(notes, T.switchedOff)
          assert.include(notes, `[Switch everything off: not asked and not run — ${CONFIRMATIONS_OFF_REASON}]`)
          if (kind !== "intent") {
            // The tool result tells the agent the action needs the owner's confirmation and confirmations are off.
            // (as recorded in history, which is what a model reads; a harness also got it from its call)
            const results = h1.flatMap((m) => (m.role === "tool" ? m.results : []))
            if (kind === "harness") assert.deepStrictEqual(t.results, results)
            assert.strictEqual(results.length, 1)
            assert.isTrue(results[0]!.isError)
            assert.strictEqual(results[0]!.content, CONFIRMATIONS_OFF_RESULT)
            assert.include(results[0]!.content, "requires confirmation by the owner")
            assert.include(results[0]!.content, "switched off in this assistant's settings")
            assert.notStrictEqual(results[0]!.content, PROPOSED_RESULT)
          }
          // A yes on the next turn runs nothing and goes to an agent like any message.
          const before = t.mainCalls()
          const yes = yield* typed("yes")
          assert.deepStrictEqual(t.h.runs, [])
          assert.notInclude(yes, T.tooEarly)
          assert.notInclude(yes, T.lapsed)
          assert.notInclude(yes, T.unavailable)
          assert.notInclude(yes, "Everything is off.")
          assert.isAbove(t.mainCalls(), before, "the yes was routed to an agent")
          const h2 = yield* historyOf
          assert.isFalse(show(h2).some((l) => l.includes("the owner confirmed")))
        }).pipe(Effect.provide(conversation(t.setup, option === undefined ? {} : { confirmActions: option })))
      })
    }

    it.effect(`${kind}, off: an action without confirm: true still runs`, () => {
      const t = proposer(kind)
      return Effect.gen(function*() {
        const said = yield* typed("ring the chime")
        assert.deepStrictEqual(t.h.runs, ["chime"])
        assert.notInclude(said, T.switchedOff)
      }).pipe(Effect.provide(conversation(t.setup)))
    })

    it.effect(`${kind}, "on": the confirmation is conducted as before`, () => {
      const t = proposer(kind)
      return Effect.gen(function*() {
        const said = yield* typed("switch everything off")
        assert.isTrue(said.trimEnd().endsWith("Switch everything off?"), said)
        assert.deepStrictEqual(t.h.runs, [])
        yield* typed("yes")
        assert.deepStrictEqual(t.h.runs, ["all_off"])
      }).pipe(Effect.provide(conversation(t.setup, { confirmActions: "on" })))
    })
  }

  it.effect("Conversation.layerWithSetup (single model), default: refused with the same result and sentence", () => {
    const h = house()
    const s = scriptedModel((text) => (text === "switch everything off" ? [toolCall("home_all_off")] : []))
    const layer = Conversation.layerWithSetup({
      setup: Effect.succeed({ system: "s", registry: makeToolRegistry([{ name: "home", tools: h.acts.map(actionTool) }]) })
    }).pipe(
      Layer.provideMerge(testTurnTraceLayer),
      Layer.provide(Layer.succeed(Llm, Llm.of({ stream: s.llm.stream })))
    )
    return Effect.gen(function*() {
      const said = yield* typed("switch everything off")
      assert.include(said, T.switchedOff)
      yield* typed("yes")
      assert.deepStrictEqual(h.runs, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("the option is read once, when the conversation is made: a later change has no effect on its life", () => {
    // `confirmActions` cannot change during a conversation's life: it is read once, at construction.
    // A getter that counts reads and answers "on" at first and "off" afterwards shows both: one read,
    // and the value read then governs (the question is asked and a yes consumes it).
    const t = proposer("model")
    let reads = 0
    const options = {
      setup: Effect.succeed(t.setup),
      get confirmActions(): "off" | "on" {
        reads++
        return reads === 1 ? "on" : "off"
      }
    } satisfies AgentConversationOptions
    return Effect.gen(function*() {
      const c = yield* makeAgentConversation(options)
      assert.strictEqual(reads, 1)
      const run = (text: string) => Stream.runCollect(c.textTurn(text)).pipe(Effect.map((chunks) => Array.from(chunks).join("")))
      const said = yield* run("switch everything off")
      assert.include(said, "Switch everything off?")
      yield* run("yes")
      assert.deepStrictEqual(t.h.runs, ["all_off"])
      assert.strictEqual(reads, 1, "never read again")
    }).pipe(Effect.provide(testTurnTraceLayer))
  })

  it.effect("read once the other way: \"off\" at construction stays off even if the options object later says \"on\"", () => {
    const t = proposer("model")
    let reads = 0
    const options = {
      setup: Effect.succeed(t.setup),
      get confirmActions(): "off" | "on" {
        reads++
        return reads === 1 ? "off" : "on"
      }
    } satisfies AgentConversationOptions
    return Effect.gen(function*() {
      const c = yield* makeAgentConversation(options)
      const run = (text: string) => Stream.runCollect(c.textTurn(text)).pipe(Effect.map((chunks) => Array.from(chunks).join("")))
      assert.include(yield* run("switch everything off"), T.switchedOff)
      yield* run("yes")
      assert.deepStrictEqual(t.h.runs, [])
      assert.strictEqual(reads, 1)
    }).pipe(Effect.provide(testTurnTraceLayer))
  })
})

describe("after the final review, change 2: the confirmation question is always core's", () => {
  const acts = registerActions("home", [
    defineAction({
      id: "reset",
      label: "Reset the room",
      description: "Reset every device in a room.",
      params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
      confirm: () => "Reset everything except the bedroom?",
      run: () => Effect.void
    }),
    defineAction({
      id: "move",
      label: "Move the speaker",
      description: "Move the music from one room to another.",
      params: { from: Param.dynamic({ label: "From", options: () => rooms }), to: Param.dynamic({ label: "To", options: () => rooms }) },
      confirm: () => "Move from Bedroom to Kitchen?",
      run: () => Effect.void
    }),
    defineAction({
      id: "level",
      label: "Set the level",
      description: "Set a level in percent.",
      params: { level: Param.number({ label: "Level", min: 0, max: 100, unit: "percent" }) },
      confirm: () => "Set to 40 watts?",
      run: () => Effect.void
    }),
    defineAction({
      id: "heat",
      label: "Set the heating",
      description: "Set the heating to a temperature.",
      params: { temp: Param.number({ label: "Temperature", min: 5, max: 30, unit: "degrees" }) },
      confirm: true,
      run: () => Effect.void
    }),
    defineAction({
      id: "never",
      label: "Never called",
      description: "Its confirmation text throws if called.",
      params: {},
      confirm: () => {
        throw new Error("must not be called")
      },
      run: () => Effect.void
    })
  ])
  const byId = (id: string) => acts.find((a) => a.definition.id === id)!

  it("a negating text is not asked: core's wording", () => {
    assert.deepStrictEqual(confirmationQuestion(byId("reset"), { room: "area:bedroom" }), { question: "Reset the room: room Bedroom?" })
  })

  it("swapped from/to in the module's text: core's wording, values in their parameters", () => {
    assert.deepStrictEqual(confirmationQuestion(byId("move"), { from: "area:kitchen", to: "area:bedroom" }), { question: "Move the speaker: from Kitchen, to Bedroom?" })
  })

  it("a wrong unit in the module's text: core's wording with the parameter's own unit", () => {
    assert.deepStrictEqual(confirmationQuestion(byId("level"), { level: 40 }), { question: "Set the level: level 40 percent?" })
    assert.deepStrictEqual(confirmationQuestion(byId("heat"), { temp: 21 }), { question: "Set the heating: temperature 21 degrees?" })
  })

  it("the module's function is not called at all", () => {
    assert.deepStrictEqual(confirmationQuestion(byId("never"), {}), { question: "Never called?" })
  })

  it.effect("end to end: the owner hears core's question for a negating module text, and yes runs what was heard", () => {
    const ran: Array<string> = []
    const a = registerActions("home", [defineAction({
      id: "reset",
      label: "Reset the room",
      description: "Reset every device in a room.",
      params: { room: Param.dynamic({ label: "Room", options: () => rooms }) },
      confirm: () => "Reset everything except the bedroom?",
      run: (p) => Effect.sync(() => void ran.push(String(p.room)))
    })])
    const model = scriptedModel((text) => (text === "reset the bedroom" ? [{ _tag: "ToolCall", id: "c1", name: "home_reset", input: { room: "bedroom" } }] : []))
    const setup = makeAgentSetup({ agents: [model.agent], routing: { defaultAgent: "main" }, registry: makeToolRegistry([{ name: "home", tools: a.map(actionTool) }]), extra: { actions: a } })
    return Effect.gen(function*() {
      const said = yield* typed("reset the bedroom")
      assert.include(said, "Reset the room: room Bedroom?")
      assert.notInclude(said, "except")
      yield* typed("yes")
      assert.deepStrictEqual(ran, ["area:bedroom"])
    }).pipe(Effect.provide(conversation(setup, { confirmActions: "on" })))
  })

  it.effect("the module host warns once per action with its own confirmation text, at start", () =>
    Effect.scoped(Effect.gen(function*() {
      const logs: Array<string> = []
      const module = defineModule({
        id: "custom",
        name: "Custom",
        description: "d",
        start: () => Effect.succeed({ actions: acts.map((r) => r.definition) })
      })
      yield* Effect.gen(function*() {
        const host = yield* makeModuleHost({ catalog: [module], persistence: readOnlyPersistence(), env: {} })
        yield* host.startEnabled
        assert.deepStrictEqual(host.snapshot().actions.map((r) => r.definition.id), ["reset", "move", "level", "heat", "never"])
      }).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(String(message)))])))
      const warnings = logs.filter((l) => l.includes("confirmation text is ignored"))
      assert.strictEqual(warnings.length, 4, logs.join("\n"))
      for (const id of ["reset", "move", "level", "never"]) assert.isTrue(warnings.some((w) => w.includes(`"${id}"`)), id)
      assert.isFalse(warnings.some((w) => w.includes(`"heat"`)))
    })))
})
