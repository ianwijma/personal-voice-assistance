import { assert, describe, expect, it } from "@effect/vitest"
import { type AgentEvent, type AgentTurnInput, makeTool, makeToolRegistry, type Message, type Trace, type TraceMark } from "@pva/core"
import { Deferred, Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import { claudeSubscriptionAgentModule, makeClaudeAgent, OPT_IN_TEXT } from "../src/index.ts"
import { makeFakeSdk } from "./fakeSdk.ts"

const lightsTool = makeTool({
  name: "lights_on",
  description: "Turn lights on",
  parameters: Schema.Struct({ room: Schema.String }),
  execute: ({ room }) => Effect.succeed(`${room} lights on`)
})
const timeTool = makeTool({
  name: "current_time",
  description: "Current time",
  parameters: Schema.Struct({}),
  speculative: true,
  execute: () => Effect.succeed("14:32")
})

const makeInput = (overrides: Partial<AgentTurnInput> & { marks?: Array<TraceMark> } = {}): AgentTurnInput & { traceObj: Trace; marks: Array<TraceMark> } => {
  const marks = overrides.marks ?? []
  const trace: Trace = { id: 1, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
  return {
    turnId: 1,
    text: "What's a good name for a goldfish?",
    utterance: "Hey Claude, what's a good name for a goldfish?",
    source: "voice",
    spoken: true,
    routedBy: "trigger",
    history: [],
    system: "You are Jev's colleague. Speak briefly.",
    context: undefined,
    tools: makeToolRegistry([{ name: "test", tools: [lightsTool, timeTool] }]),
    actions: [],
    deciders: new Map(),
    promoted: Effect.void,
    speculative: false,
    mark: (m) => marks.push(m),
    trace,
    maxToolRounds: 4,
    ...overrides,
    traceObj: trace,
    marks
  }
}

const collect = (stream: Stream.Stream<AgentEvent, unknown>) => Effect.map(Stream.runCollect(stream), (c) => Array.from(c))
const texts = (events: ReadonlyArray<AgentEvent>) => events.filter((e) => e._tag === "TextDelta").map((e) => (e as { text: string }).text)

const agentOptions = { model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test" } }

describe("claude-subscription agent", () => {
  it.live("spawns one warm session at start (before any turn) and checks the subscription login", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      expect(fake.queries).toHaveLength(1)
      expect(fake.queries[0]!.received).toEqual([]) // no warm-up turn: no quota spent
      expect(agent.info?.()).toEqual({ login: "Logged in with a max plan" })
      expect(fake.queries[0]!.options.env?.ANTHROPIC_API_KEY).toBeUndefined()
      agent.shutdown()
      expect(fake.queries[0]!.closed).toBe(true)
    }))

  it.live("refuses an API-key login: the agent is for the subscription", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({ account: { apiKeySource: "ANTHROPIC_API_KEY" } })
      const error = yield* Effect.flip(Effect.tryPromise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk })))
      expect(String(error.cause)).toMatch(/not using a subscription login \(it uses ANTHROPIC_API_KEY\)/)
      expect(fake.queries[0]!.closed).toBe(true)
    }))

  it.live("first turn: binds the warm session (instructions + tools via setMcpServers), streams deltas, marks the trace", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const input = makeInput({ context: "Local time: 14:32" })
      const events = yield* collect(agent.turn(input))
      expect(texts(events)).toEqual(["Hello", " there."])
      expect(input.marks).toEqual(["llmRequestSent", "llmFirstToken", "llmFirstToken"])
      const q = fake.queries[0]!
      expect(fake.queries).toHaveLength(1)
      expect(q.received[0]).toBe(
        "<instructions>\nYou are Jev's colleague. Speak briefly.\n</instructions>\n\n<context>\nLocal time: 14:32\n</context>\n\nWhat's a good name for a goldfish?"
      )
      expect(q.registered).toEqual([{ tools: expect.any(Array), viaSetMcpServers: true }])
      expect(q.registered[0]!.tools.map((t) => t.name)).toEqual(["lights_on", "current_time"])

      // Second turn: same process (warm), no instructions again, nothing to catch up on.
      const history: Array<Message> = [{ role: "user", content: input.text }, { role: "assistant", content: "Hello there." }]
      yield* collect(agent.turn(makeInput({ text: "And for a cat?", history })))
      expect(fake.queries).toHaveLength(1)
      expect(q.received[1]).toBe("And for a cat?")
      agent.shutdown()
    }))

  it.live("catch-up: what other agents said since the last turn is prepended", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const h1: Array<Message> = []
      yield* collect(agent.turn(makeInput({ text: "Hi", history: h1 })))
      const h2: Array<Message> = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello there.", agentId: "claude-subscription" } as Message,
        { role: "user", content: "turn on the lights" },
        { role: "assistant", content: "Living room lights on.", agentId: "jev" } as Message
      ]
      yield* collect(agent.turn(makeInput({ text: "Did that work?", history: h2 })))
      expect(fake.queries[0]!.received[1]).toBe("<earlier>\nUser: turn on the lights\nJev: Living room lights on.\n</earlier>\n\nDid that work?")
      agent.shutdown()
    }))

  it.live("tool calls go through the handler: flush before the call, promotion awaited, events and trace recorded", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          ctx.delta("Let me check,")
          const r = await ctx.callTool("lights_on", { room: "Kitchen" })
          ctx.delta(` done: ${r.content}.`)
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const promoted = yield* Deferred.make<void>()
      const input = makeInput({ promoted: Deferred.await(promoted), speculative: true })
      const fiber = yield* Effect.forkChild(collect(agent.turn(input)))
      yield* Effect.sleep("50 millis")
      assert.isUndefined(fiber.pollUnsafe()) // the side-effecting tool waits for promotion
      yield* Deferred.succeed(promoted, undefined)
      const events = yield* Fiber.join(fiber)
      expect(events.map((e) => e._tag)).toEqual(["TextDelta", "TextDelta", "ToolStarted", "ToolFinished", "TextDelta"])
      expect(texts(events)).toEqual(["Let me check,", "\n", " done: Kitchen lights on."])
      const started = events[2] as Extract<AgentEvent, { _tag: "ToolStarted" }>
      expect(started.call).toMatchObject({ name: "lights_on", input: { room: "Kitchen" } })
      const finished = events[3] as Extract<AgentEvent, { _tag: "ToolFinished" }>
      expect(finished.result).toMatchObject({ name: "lights_on", content: "Kitchen lights on", isError: false })
      expect(input.traceObj.tools.map((t) => t.name)).toEqual(["lights_on"])
      agent.shutdown()
    }))

  it.live("the tool-round limit is enforced in the handler", () =>
    Effect.gen(function*() {
      const results: Array<string> = []
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          for (let i = 0; i < 3; i++) results.push((await ctx.callTool("current_time", {})).content)
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      yield* collect(agent.turn(makeInput({ maxToolRounds: 2 })))
      expect(results).toEqual(["14:32", "14:32", "Tool limit reached for this turn: answer with what you have."])
      agent.shutdown()
    }))

  it.live("barge-in: interrupting the stream calls interrupt(), keeps the session, and the next turn says what was heard", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          ctx.delta("Goldie is a classic,")
          await Promise.race([ctx.interrupted, ctx.sleep(2000)])
          ctx.delta(" never heard")
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const first = yield* collect(agent.turn(makeInput()).pipe(Stream.take(1)))
      expect(texts(first)).toEqual(["Goldie is a classic,"])
      const q = fake.queries[0]!
      expect(q.interrupts).toBe(1)

      fake.setRespond((ctx) => {
        ctx.delta("Sure.")
        ctx.result()
      })
      const history: Array<Message> = [
        { role: "user", content: "What's a good name for a goldfish?" },
        { role: "assistant", content: "Goldie is a classic,", interrupted: true, agentId: "claude-subscription" } as Message
      ]
      const second = yield* collect(agent.turn(makeInput({ text: "Another one?", history })))
      expect(texts(second)).toEqual(["Sure."])
      expect(fake.queries).toHaveLength(1) // same session after the interrupt
      expect(q.received[1]).toBe(
        "<earlier>\n(You were interrupted; the owner heard only: \"Goldie is a classic,\")\n</earlier>\n\nAnother one?"
      )
      agent.shutdown()
    }))

  it.live("a stuck interrupt kills the session; the next turn runs on a new one, primed with the history", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({
        hangOnInterrupt: true,
        respond: async (ctx) => {
          ctx.delta("Thinking")
          await Promise.race([ctx.interrupted, ctx.sleep(3000)])
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk, interruptAckMs: 50 }))
      yield* collect(agent.turn(makeInput()).pipe(Stream.take(1)))
      fake.setRespond((ctx) => {
        ctx.delta("Back.")
        ctx.result()
      })
      const history: Array<Message> = [{ role: "user", content: "Hi" }, { role: "assistant", content: "Thinking", interrupted: true }]
      const events = yield* collect(agent.turn(makeInput({ text: "Hello?", history })))
      expect(texts(events)).toEqual(["Back."])
      expect(fake.queries[0]!.closed).toBe(true)
      const replacement = fake.queries.at(-1)!
      expect(replacement.options.systemPrompt).toBe("You are Jev's colleague. Speak briefly.") // spawned with the real prompt
      expect(replacement.registered[0]?.viaSetMcpServers).toBe(false)
      expect(replacement.received.at(-1)).toBe("<earlier>\nUser: Hi\nAssistant: Thinking (interrupted)\n</earlier>\n\nHello?")
      agent.shutdown()
    }))

  it.live("a crash mid-turn fails it as unavailable (fallback applies); the next turn gets a new session", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({ respond: (ctx) => ctx.query.crash() })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const error = yield* Effect.flip(collect(agent.turn(makeInput())))
      expect(error).toMatchObject({ _tag: "AgentError", reason: "unavailable" })
      expect((error as Error).message).toMatch(/process exited with code 1/)
      fake.setRespond((ctx) => {
        ctx.delta("OK.")
        ctx.result()
      })
      const events = yield* collect(agent.turn(makeInput()))
      expect(texts(events)).toEqual(["OK."])
      expect(fake.queries.length).toBeGreaterThanOrEqual(2)
      agent.shutdown()
    }))

  it.live("a changed system prompt or tool list restarts the session at the turn boundary", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      yield* collect(agent.turn(makeInput()))
      yield* collect(agent.turn(makeInput({ system: "A different prompt." })))
      expect(fake.queries).toHaveLength(2)
      expect(fake.queries[1]!.options.systemPrompt).toBe("A different prompt.")
      expect(fake.queries[1]!.options.allowedTools).toContain("mcp__assistant__lights_on")
      yield* collect(agent.turn(makeInput({ system: "A different prompt.", tools: makeToolRegistry([{ name: "t", tools: [timeTool] }]) })))
      expect(fake.queries).toHaveLength(3)
      expect(fake.queries[0]!.closed && fake.queries[1]!.closed).toBe(true)
      agent.shutdown()
    }))

  it.live("a turn that never finishes fails with timeout and is interrupted", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({ respond: async (ctx) => void (await ctx.interrupted) })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk, turnTimeoutMs: 100 }))
      const error = yield* Effect.flip(collect(agent.turn(makeInput())))
      expect(error).toMatchObject({ _tag: "AgentError", reason: "timeout" })
      expect(fake.queries[0]!.interrupts).toBe(1)
      agent.shutdown()
    }))

  it.live("usage limit and login errors before any text are 'unavailable'", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({
        respond: (ctx) => {
          ctx.emit({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", message: { content: [] } })
          ctx.result("success", true, "rate limited")
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const error = yield* Effect.flip(collect(agent.turn(makeInput())))
      expect(error).toMatchObject({ reason: "unavailable" })
      expect((error as Error).message).toMatch(/usage limit/)
      agent.shutdown()
    }))

  it.live("refuses to continue when Claude Code offers tools it should not have", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({ extraInitTools: ["Bash"] })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const error = yield* Effect.flip(collect(agent.turn(makeInput())))
      expect(error).toMatchObject({ reason: "unavailable" })
      expect((error as Error).message).toMatch(/offered tools it should not have \(Bash\)/)
      agent.shutdown()
    }))
})

describe("claude-subscription module", () => {
  it.live("is off by default; without the opt-in the start fails with the opt-in sentence and spawns nothing", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const module = claudeSubscriptionAgentModule({ sdk: fake.sdk })
      expect(module).toMatchObject({ id: "claude-subscription", kind: "agent", agentKind: "harness", enabledByDefault: false })
      const settings = { optIn: false, model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60, claudePath: "" }
      const exit = yield* Effect.exit(Effect.scoped(module.start({ settings, setStatus: () => {} })))
      assert.isTrue(Exit.isFailure(exit))
      expect(String(exit)).toContain(OPT_IN_TEXT)
      expect(fake.queries).toHaveLength(0)
      expect(module.settings.optIn.describe("optIn").description).toMatch(/terms .* are unclear/)
    }))

  it.live("with the opt-in: one harness agent, speculate off, the session closed with the module scope", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const module = claudeSubscriptionAgentModule({ sdk: fake.sdk, env: {} })
      const settings = { optIn: true, model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60, claudePath: "" }
      const statuses: Array<string> = []
      const scope = yield* Scope.make()
      const instance = yield* module.start({ settings, setStatus: (s) => s !== undefined && statuses.push(s.text) }).pipe(Scope.provide(scope))
      const agent = (instance as { agents?: ReadonlyArray<{ kind: string; speculate: boolean; firstEventTimeoutMs: number }> }).agents![0]!
      expect(agent).toMatchObject({ kind: "harness", speculate: false, firstEventTimeoutMs: 8000 })
      expect(statuses.at(-1)).toBe("Ready · claude-haiku-5-5 · max plan")
      expect(fake.queries).toHaveLength(1)
      yield* Scope.close(scope, Exit.void)
      expect(fake.queries[0]!.closed).toBe(true)
    }))
})
