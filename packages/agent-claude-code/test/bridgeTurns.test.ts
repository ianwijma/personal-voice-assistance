// P1 review round 3 (gateway findings 1, 2): a tool call from Claude Code belongs to the turn whose stream announced
// it, never to "the turn in progress now"; a call of a turn that ended or was cancelled never runs.
import { describe, expect, it } from "@effect/vitest"
import { type AgentEvent, type AgentTurnInput, CurrentTurn, makeExecutionGateway, makeTool, makeToolRegistry, type Trace, type TurnContext } from "@pva/core"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { type ToolHandler, toolUseIdOf } from "../src/sdk.ts"
import { makeClaudeAgent } from "../src/index.ts"
import { makeFakeSdk } from "./fakeSdk.ts"

const ran: Array<{ readonly text: string; readonly turn: number | undefined; readonly connection: string | undefined }> = []
const echo = (speculative: boolean) =>
  makeTool({
    name: "echo",
    description: "Echo",
    parameters: Schema.Struct({ text: Schema.String }),
    speculative,
    execute: ({ text }) =>
      Effect.gen(function*() {
        const turn = yield* CurrentTurn
        ran.push({ text, turn: turn?.turnId, connection: turn?.connection?.id })
        return text
      })
  })

const turnOf = (turnId: number): TurnContext => ({
  turnId,
  conversationId: "c1",
  assistantId: "jeff",
  deviceId: "d-kitchen-0001",
  deviceName: "Kitchen",
  source: "voice",
  connection: { _tag: "ConnectionRef", id: `tab-${turnId}` }
})

const inputOf = (turnId: number, options: { readonly speculative?: boolean; readonly promoted?: Effect.Effect<void> } = {}): AgentTurnInput => {
  const trace: Trace = { id: turnId, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
  const gateway = makeExecutionGateway({ access: { moduleOn: () => true, toolOff: () => false } })
  return {
    turnId,
    text: `Turn ${turnId}`,
    conversationId: "c1",
    utterance: `Turn ${turnId}`,
    source: "voice",
    spoken: true,
    routedBy: "trigger",
    history: [],
    system: "Be brief.",
    context: undefined,
    tools: makeToolRegistry([{ name: "house", tools: [echo(options.speculative ?? true)] }], { gateway }),
    actions: [],
    deciders: new Map(),
    promoted: options.promoted ?? Effect.void,
    speculative: false,
    mark: () => {},
    trace,
    maxToolRounds: 4
  }
}

const agentOf = (fake: ReturnType<typeof makeFakeSdk>) =>
  Effect.promise(() => makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" }, sdk: fake.sdk }))

describe("the tool_use id Claude Code sends with an MCP call (round 4)", () => {
  it("is read from the request's _meta, and absent otherwise", () => {
    // What the live test saw on the handler's second argument (Claude Code 0.3.323).
    expect(toolUseIdOf({ requestId: 1, _meta: { "claudecode/toolUseId": "toolu_01XX", progressToken: 2 } })).toBe("toolu_01XX")
    expect(toolUseIdOf({ _meta: { progressToken: 2 } })).toBeUndefined()
    expect(toolUseIdOf({ _meta: { "claudecode/toolUseId": 7 } })).toBeUndefined()
    expect(toolUseIdOf(undefined)).toBeUndefined()
  })
})

describe("the Claude Code bridge attributes a call to the turn that issued it", () => {
  it.live("1: after a barge-in, a call the first turn's stream announced never runs, not even as the next turn", () =>
    Effect.gen(function*() {
      ran.length = 0
      let kept: ToolHandler | undefined
      const late: Array<{ content: string; isError: boolean }> = []
      const fake = makeFakeSdk()
      fake.setRespond(async (ctx) => {
        // Turn 1: Claude Code announces the call, then the owner barges in before it is made.
        ctx.delta("Let me check.")
        ctx.announce("echo", { text: "one" })
        kept = ctx.mcp()
        await ctx.interrupted
      })
      const agent = yield* agentOf(fake)
      const first = yield* Stream.runHead(agent.turn(inputOf(1)).pipe(Stream.provideService(CurrentTurn, turnOf(1))))
      expect(first._tag).toBe("Some")
      // Turn 2 on the same session: the late call of turn 1 arrives while turn 2 runs.
      fake.setRespond(async (ctx) => {
        late.push(await kept!("echo", { text: "one" }))
        late.push(await ctx.callTool("echo", { text: "two" }))
        ctx.delta("Done.")
        ctx.result()
      })
      yield* Stream.runDrain(agent.turn(inputOf(2)).pipe(Stream.provideService(CurrentTurn, turnOf(2))))
      expect(late[0]?.isError).toBe(true)
      expect(late[1]).toEqual({ content: "two", isError: false })
      // Only turn 2's own call ran, with turn 2's turn and connection.
      expect(ran).toEqual([{ text: "two", turn: 2, connection: "tab-2" }])
      expect(fake.queries.length).toBe(1)
      agent.shutdown()
    }))

  it.live("round 4: an identical call of a cancelled turn, arriving after the purge, does not take the next turn's claim (matched by tool_use id)", () =>
    Effect.gen(function*() {
      ran.length = 0
      let kept: ToolHandler | undefined
      let firstId = ""
      const results: Record<string, { content: string; isError: boolean }> = {}
      const fake = makeFakeSdk()
      fake.setRespond(async (ctx) => {
        ctx.delta("Let me check.")
        firstId = ctx.announce("echo", { text: "same" })
        kept = ctx.mcp()
        await ctx.interrupted
      })
      const agent = yield* agentOf(fake)
      yield* Stream.runHead(agent.turn(inputOf(1)).pipe(Stream.provideService(CurrentTurn, turnOf(1))))
      fake.setRespond(async (ctx) => {
        // Turn 2 (another tab) announces the same call; turn 1's delayed request comes first, then turn 2's own.
        await new Promise((resolve) => setImmediate(resolve))
        const secondId = ctx.announce("echo", { text: "same" })
        results.late = await kept!("echo", { text: "same" }, firstId)
        results.own = await kept!("echo", { text: "same" }, secondId)
        // Call first, announcement after: still matched to its own announcement.
        const early = kept!("echo", { text: "same" }, "toolu_call_first")
        ctx.announce("echo", { text: "same" }, "toolu_call_first")
        results.callFirst = await early
        ctx.delta("Done.")
        ctx.result()
      })
      yield* Stream.runDrain(agent.turn(inputOf(2)).pipe(Stream.provideService(CurrentTurn, turnOf(2))))
      expect(results.late?.isError).toBe(true)
      expect(results.own).toEqual({ content: "same", isError: false })
      expect(results.callFirst).toEqual({ content: "same", isError: false })
      expect(ran).toEqual([{ text: "same", turn: 2, connection: "tab-2" }, { text: "same", turn: 2, connection: "tab-2" }])
      agent.shutdown()
    }), 20_000)

  it.live("1: a call made after its turn finished is refused (it would otherwise reach the next turn's handler)", () =>
    Effect.gen(function*() {
      ran.length = 0
      let kept: ToolHandler | undefined
      const fake = makeFakeSdk()
      fake.setRespond(async (ctx) => {
        kept = ctx.mcp()
        await ctx.callTool("echo", { text: "one" })
        ctx.result()
      })
      const agent = yield* agentOf(fake)
      yield* Stream.runDrain(agent.turn(inputOf(1)).pipe(Stream.provideService(CurrentTurn, turnOf(1))))
      let replay: { content: string; isError: boolean } | undefined
      fake.setRespond(async (ctx) => {
        replay = await kept!("echo", { text: "one" })
        ctx.result()
      })
      yield* Stream.runDrain(agent.turn(inputOf(2)).pipe(Stream.provideService(CurrentTurn, turnOf(2))))
      expect(replay?.isError).toBe(true)
      expect(ran).toEqual([{ text: "one", turn: 1, connection: "tab-1" }])
      agent.shutdown()
    }))

  it.live("2: a call waiting inside the bridge when its turn is cancelled does not start", () =>
    Effect.gen(function*() {
      ran.length = 0
      const promoted = yield* Deferred.make<void>()
      let answer: Promise<{ content: string; isError: boolean }> | undefined
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          // A non-speculative call: it waits for promotion inside the bridge.
          answer = ctx.callTool("echo", { text: "queued" })
          await ctx.interrupted
        }
      })
      const agent = yield* agentOf(fake)
      const stream = agent.turn(inputOf(1, { speculative: false, promoted: Deferred.await(promoted) })).pipe(Stream.provideService(CurrentTurn, turnOf(1)))
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.takeUntil(stream, (e: AgentEvent) => e._tag === "ToolStarted")))
      yield* Fiber.join(fiber)
      // The turn is gone (its stream closed: barge-in); then it would have been promoted.
      yield* Deferred.succeed(promoted, undefined)
      const result = yield* Effect.promise(() => answer!)
      expect(result.isError).toBe(true)
      expect(ran).toEqual([])
      agent.shutdown()
    }))
})
