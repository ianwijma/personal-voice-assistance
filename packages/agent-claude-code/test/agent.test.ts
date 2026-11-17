import { assert, describe, expect, it } from "@effect/vitest"
import { type AgentEvent, type AgentTurnInput, makeTool, makeToolRegistry, type Message, type Trace, type TraceMark, traceTimeline } from "@pva/core"
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
    conversationId: "c1",
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
      // The trace clock is the agent's only clock: a fake one that only the test moves.
      let clock = 1000
      const input = makeInput({ promoted: Deferred.await(promoted), speculative: true, now: () => clock })
      const fiber = yield* Effect.forkChild(collect(agent.turn(input)))
      yield* Effect.sleep("50 millis")
      assert.isUndefined(fiber.pollUnsafe()) // the side-effecting tool waits for promotion
      clock = 1500 // the turn is confirmed this much later
      yield* Deferred.succeed(promoted, undefined)
      const events = yield* Fiber.join(fiber)
      expect(events.map((e) => e._tag)).toEqual(["TextDelta", "TextDelta", "ToolStarted", "ToolFinished", "TextDelta"])
      expect(texts(events)).toEqual(["Let me check,", "\n", " done: Kitchen lights on."])
      const started = events[2] as Extract<AgentEvent, { _tag: "ToolStarted" }>
      expect(started.call).toMatchObject({ name: "lights_on", input: { room: "Kitchen" } })
      const finished = events[3] as Extract<AgentEvent, { _tag: "ToolFinished" }>
      expect(finished.result).toMatchObject({ name: "lights_on", content: "Kitchen lights on", isError: false })
      expect(input.traceObj.tools.map((t) => t.name)).toEqual(["lights_on"])
      // The tool span begins once the turn was confirmed (not at the call), on the trace clock.
      const span = input.traceObj.events!.find((e) => e.name === "tool")!
      expect(span).toMatchObject({ at: 1500, detail: "lights_on" })
      expect(span.ms).toBe(0)
      agent.shutdown()
    }))

  it.live("time line: its own request, first text and completion, after a failed agent's request too; no duplicate request otherwise", () =>
    Effect.gen(function*() {
      let clock = 100
      const fake = makeFakeSdk({
        // Each message is handled before the clock moves on (the fake delivers them asynchronously).
        respond: async (ctx) => {
          const later = () => new Promise((resolve) => setTimeout(resolve, 10))
          clock = 120
          ctx.delta("Hello")
          await later()
          clock = 130
          ctx.delta(" there.")
          await later()
          clock = 150
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      /** An input whose `mark` records first-only marks on the trace, as the conversation does. */
      const marking = (trace?: (t: Trace) => void) => {
        const input = makeInput({ now: () => clock })
        trace?.(input.traceObj)
        return { ...input, mark: (m: TraceMark) => void (input.traceObj.marks[m] ??= clock) }
      }
      // A model failed before answering (its request at 0, round 1), then this agent answers in the same turn.
      clock = 100
      const fallback = marking((t) => {
        t.marks.llmRequestSent = 0
        t.events = [{ name: "llmRequestSent", at: 0, detail: "round 1" }]
      })
      yield* collect(agent.turn(fallback))
      const line = traceTimeline(fallback.trace)
      expect(line.filter((e) => e.name === "llmRequestSent").map((e) => e.at)).toEqual([0, 100])
      expect(line.find((e) => e.name === "llmFirstToken")?.at).toBe(120)
      expect(line.filter((e) => e.name === "llmDone").map((e) => e.at)).toEqual([150])
      expect(fallback.trace.marks.llmRequestSent).toBe(0) // the mark stays first-only
      // No fallback: one request, one first text on the published time line (the entry replaces the mark).
      clock = 100
      const plain = marking()
      yield* collect(agent.turn(plain))
      const names = traceTimeline(plain.trace).map((e) => e.name)
      expect(names.filter((n) => n === "llmRequestSent")).toHaveLength(1)
      expect(names.filter((n) => n === "llmFirstToken")).toHaveLength(1)
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
      const settings = { optIn: false, model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60, claudePath: "", debugLogs: false, proxy: undefined }
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
      const settings = { optIn: true, model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60, claudePath: "", debugLogs: false, proxy: undefined }
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

describe("the Claude Code process gets an allow-listed environment, no debug logs, and no raw stderr (fifth review, hardening)", () => {
  const planted = {
    PATH: "/usr/bin",
    HOME: "/home/owner",
    LANG: "en_GB.UTF-8",
    LC_ALL: "en_GB.UTF-8",
    XDG_CONFIG_HOME: "/home/owner/.config",
    CLAUDE_CONFIG_DIR: "/home/owner/.claude",
    HTTPS_PROXY: "http://proxy:3128",
    // Secrets of the assistant that must never reach the subprocess:
    PLANTED_SECRET: "s3cret-planted",
    OPENAI_API_KEY: "sk-openai",
    PVA_VAULT_PASSWORD: "vault-pass",
    HOME_ASSISTANT_TOKEN: "ha-token",
    ANTHROPIC_API_KEY: "sk-ant",
    DEBUG_CLAUDE_AGENT_SDK: "1",
    CLAUDE_DEBUG: "1",
    DEBUG: "*"
  }

  it.live("a planted secret variable (and every other one off the list) does not reach the options passed to the SDK", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, env: planted, sdk: fake.sdk }))
      const options = fake.queries[0]!.options
      expect(options.env).toEqual({
        PATH: "/usr/bin",
        HOME: "/home/owner",
        LANG: "en_GB.UTF-8",
        LC_ALL: "en_GB.UTF-8",
        XDG_CONFIG_HOME: "/home/owner/.config",
        CLAUDE_CONFIG_DIR: "/home/owner/.claude",
        HTTPS_PROXY: "http://proxy:3128",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_AGENT_SDK_CLIENT_APP: "personal-voice-assistant/0.0.0"
      })
      expect(JSON.stringify(options)).not.toContain("s3cret-planted")
      expect(options.debug).toBe(false)
      expect(options.debugFile).toBeUndefined()
      agent.shutdown()
    }))

  it.live("debug logging only when the setting switches it on", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const module = claudeSubscriptionAgentModule({ sdk: fake.sdk, env: planted })
      const settings = { optIn: true, model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60, claudePath: "", debugLogs: true, proxy: undefined }
      const scope = yield* Scope.make()
      yield* module.start({ settings, setStatus: () => {} }).pipe(Scope.provide(scope))
      expect(fake.queries[0]!.options.debug).toBe(true)
      expect(fake.queries[0]!.options.env?.DEBUG_CLAUDE_AGENT_SDK).toBeUndefined()
      expect((module.settings.debugLogs.describe("debugLogs") as { default?: unknown }).default).toBe(false)
      yield* Scope.close(scope, Exit.void)
    }))

  it.live("an exit error's stderr text is not passed on: the turn's error is one bounded line without it", () =>
    Effect.gen(function*() {
      const leaked = `${"x".repeat(500)} OPENAI_API_KEY=sk-leaked`
      const fake = makeFakeSdk({ respond: (ctx) => ctx.query.crash(`Claude Code process exited with code 1. stderr: ${leaked}\nmore lines`) })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const error = yield* Effect.flip(collect(agent.turn(makeInput())))
      const message = (error as Error).message
      expect(message).toMatch(/process exited with code 1/)
      expect(message).not.toContain("stderr")
      expect(message).not.toContain("sk-leaked")
      expect(message.length).toBeLessThanOrEqual(240)
      expect(String((error as { cause?: unknown }).cause)).not.toContain("sk-leaked")
      agent.shutdown()
    }))

  it("safeErrorText: drops the stderr tail, keeps one line, bounds the length", async () => {
    const { safeErrorText } = await import("../src/session.ts")
    expect(safeErrorText(new Error("Claude Code process exited with code 1. stderr: secret"))).toBe("Claude Code process exited with code 1")
    expect(safeErrorText("a\n  b")).toBe("a b")
    expect(safeErrorText("y".repeat(1000)).length).toBe(200)
  })
})

describe("proxy credentials and the locale and XDG lists (sixth review, finding 3)", () => {
  const base = { optIn: true, model: "claude-haiku-5-5", systemPrompt: "", speculate: false, tools: true, sessionIdleMinutes: 60, claudePath: "", debugLogs: false, proxy: undefined }

  it.live("an inherited proxy URL with credentials is not passed on; the start fails saying how to supply it, and spawns nothing", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const env = { PATH: "/usr/bin", HTTPS_PROXY: "http://owner:password@proxy:8080", http_proxy: "http://proxy:3128" }
      const module = claudeSubscriptionAgentModule({ sdk: fake.sdk, env })
      const exit = yield* Effect.exit(Effect.scoped(module.start({ settings: { ...base, proxy: undefined }, setStatus: () => {} })))
      assert.isTrue(Exit.isFailure(exit))
      const text = String(exit)
      expect(text).toContain("HTTPS_PROXY")
      expect(text).toMatch(/credentials/)
      expect(text).toContain("Proxy for Claude Code")
      expect(text).not.toContain("password")
      expect(fake.queries).toHaveLength(0)
      // And the agent itself never passes it, whoever calls it.
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, env, sdk: fake.sdk }))
      expect(fake.queries[0]!.options.env).toMatchObject({ http_proxy: "http://proxy:3128" })
      expect(fake.queries[0]!.options.env?.HTTPS_PROXY).toBeUndefined()
      expect(JSON.stringify(fake.queries[0]!.options)).not.toContain("password")
      agent.shutdown()
    }))

  it.live("the \"Proxy for Claude Code\" setting is a secret, passed to the subprocess as-is, replacing inherited proxy variables", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const env = { PATH: "/usr/bin", HTTPS_PROXY: "http://owner:password@proxy:8080", ALL_PROXY: "socks5://proxy:1080", NO_PROXY: "localhost" }
      const module = claudeSubscriptionAgentModule({ sdk: fake.sdk, env })
      expect(module.settings.proxy.describe("proxy")).toMatchObject({ type: "secret", label: "Proxy for Claude Code" })
      const scope = yield* Scope.make()
      yield* module.start({ settings: { ...base, proxy: "http://me:s3cret@proxy:8080" }, setStatus: () => {} }).pipe(Scope.provide(scope))
      expect(fake.queries[0]!.options.env).toMatchObject({ HTTPS_PROXY: "http://me:s3cret@proxy:8080", HTTP_PROXY: "http://me:s3cret@proxy:8080", NO_PROXY: "localhost" })
      expect(fake.queries[0]!.options.env?.ALL_PROXY).toBeUndefined()
      expect(JSON.stringify(fake.queries[0]!.options)).not.toContain("owner:password")
      yield* Scope.close(scope, Exit.void)
    }))

  it("sessionEnv: only the standard LC_ and XDG_ names; credential-free proxies pass, credential-bearing ones do not", async () => {
    const { sessionEnv } = await import("../src/options.ts")
    const env = sessionEnv({
      LC_ALL: "C", LC_TIME: "en_GB.UTF-8", LC_SECRET_TOKEN: "x", LC_ANYTHING: "y",
      XDG_CONFIG_HOME: "/c", XDG_RUNTIME_DIR: "/run/user/1000", XDG_API_KEY: "k", XDG_WHATEVER: "w",
      HTTP_PROXY: "http://proxy:3128", https_proxy: "http://u@proxy:3128", ALL_PROXY: "http://:pw@proxy:1"
    })
    expect(env).toMatchObject({ LC_ALL: "C", LC_TIME: "en_GB.UTF-8", XDG_CONFIG_HOME: "/c", XDG_RUNTIME_DIR: "/run/user/1000", HTTP_PROXY: "http://proxy:3128" })
    for (const k of ["LC_SECRET_TOKEN", "LC_ANYTHING", "XDG_API_KEY", "XDG_WHATEVER", "https_proxy", "ALL_PROXY"]) expect(env[k]).toBeUndefined()
  })
})

describe("claude-subscription agent: one session per conversation (docs/VOICE-SESSIONS.md §3)", () => {
  const conv = (conversationId: string, text: string, history: Array<Message> = []) => makeInput({ conversationId, text, history })

  it.live("two conversations run in parallel, each in its own session; the first takes the warm one; one login check", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          await ctx.sleep(150)
          ctx.delta(`Answer to ${ctx.text.split("\n").at(-1)}`)
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      const t0 = Date.now()
      const [a, b] = yield* Effect.all([collect(agent.turn(conv("kitchen", "Hi from the kitchen"))), collect(agent.turn(conv("desk", "Hi from the desk")))], {
        concurrency: "unbounded"
      })
      const elapsed = Date.now() - t0
      expect(texts(a)).toEqual(["Answer to Hi from the kitchen"])
      expect(texts(b)).toEqual(["Answer to Hi from the desk"])
      assert.isBelow(elapsed, 280, "the two turns overlapped (each takes 150 ms)")
      expect(fake.queries).toHaveLength(2)
      // The warm (provisional) session was bound for the first conversation; the second was spawned with the real prompt.
      expect(fake.queries[0]!.received[0]).toContain("<instructions>")
      expect(fake.queries[1]!.options.systemPrompt).toBe("You are Jev's colleague. Speak briefly.")
      expect(fake.queries[1]!.received[0]).toBe("Hi from the desk")
      expect(agent.session("kitchen")).not.toBe(agent.session("desk"))
      expect(agent.conversations()).toEqual(["kitchen", "desk"])
      agent.shutdown()
      expect(fake.queries.every((q) => q.closed)).toBe(true)
    }))

  it.live("catch-up is kept per conversation", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      yield* collect(agent.turn(conv("a", "Hi")))
      yield* collect(agent.turn(conv("b", "Hello")))
      // Conversation a: Jev answered something since; b: nothing new.
      const ha: Array<Message> = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello there.", agentId: "claude-subscription" } as Message,
        { role: "user", content: "turn on the lights" },
        { role: "assistant", content: "Living room lights on.", agentId: "jev" } as Message
      ]
      const hb: Array<Message> = [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hello there.", agentId: "claude-subscription" } as Message]
      yield* collect(agent.turn(conv("b", "And now?", hb)))
      yield* collect(agent.turn(conv("a", "Did that work?", ha)))
      const qa = fake.queries.find((q) => q.received[0]?.endsWith("Hi"))!
      const qb = fake.queries.find((q) => q.received[0]?.endsWith("Hello"))!
      expect(qb.received[1]).toBe("And now?")
      expect(qa.received[1]).toBe("<earlier>\nUser: turn on the lights\nJev: Living room lights on.\n</earlier>\n\nDid that work?")
      agent.shutdown()
    }))

  it.live("at most maxSessions open: the least recently used one is closed, and primes from the history when it comes back", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk, maxSessions: 2 }))
      yield* collect(agent.turn(conv("a", "One")))
      yield* collect(agent.turn(conv("b", "Two")))
      yield* collect(agent.turn(conv("a", "One again", [{ role: "user", content: "One" }, { role: "assistant", content: "Hello there.", agentId: "claude-subscription" } as Message])))
      // b is now the least recently used: a third conversation closes it.
      const bSession = agent.session("b")!
      yield* collect(agent.turn(conv("c", "Three")))
      expect(bSession.dead).toBeDefined()
      expect(agent.conversations()).toEqual(["a", "c"])
      expect(fake.queries.filter((q) => !q.closed)).toHaveLength(2)
      // b comes back: a fresh session (closing a, now the least recently used), told what was said before.
      const hb: Array<Message> = [{ role: "user", content: "Two" }, { role: "assistant", content: "Hello there.", agentId: "claude-subscription" } as Message]
      yield* collect(agent.turn(conv("b", "Two again", hb)))
      expect(agent.conversations()).toEqual(["c", "b"])
      expect(fake.queries.at(-1)!.received[0]).toBe("<earlier>\nUser: Two\nYou: Hello there.\n</earlier>\n\nTwo again")
      expect(fake.queries.filter((q) => !q.closed)).toHaveLength(2)
      agent.shutdown()
    }))

  it.live("endConversation closes that conversation's session and keeps a warm one for the next conversation", () =>
    Effect.gen(function*() {
      const fake = makeFakeSdk()
      const agent = yield* Effect.promise(() => makeClaudeAgent({ ...agentOptions, sdk: fake.sdk }))
      yield* collect(agent.turn(conv("old", "Hi")))
      yield* collect(agent.turn(conv("other", "Hello")))
      const old = agent.session("old")!
      yield* agent.endConversation("old")
      expect(old.dead).toBeDefined()
      expect(agent.conversations()).toEqual(["other"])
      expect(agent.session("other")!.dead).toBeUndefined()
      const spawned = fake.queries.length
      // The new conversation takes the warm replacement: no process start on its first turn.
      yield* Effect.sleep("20 millis")
      yield* collect(agent.turn(conv("new", "Fresh start")))
      expect(fake.queries).toHaveLength(spawned)
      expect(fake.queries.at(-1)!.received[0]).toBe("Fresh start")
      // Unknown or already closed: nothing happens.
      yield* agent.endConversation("old")
      yield* agent.endConversation("never")
      agent.shutdown()
    }))
})
