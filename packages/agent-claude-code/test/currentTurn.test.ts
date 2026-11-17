// Module API v2 through the Claude Code bridge (docs/MODULES-PLAN.md §4 P1): the SDK calls tools from outside the
// turn's fiber, so the bridge captures `CurrentTurn` at the turn's start and gives it to every call; every call goes
// through the registry's execution gateway, which refuses a tool the assistant has off.
import { describe, expect, it } from "@effect/vitest"
import {
  type AgentEvent,
  type AgentTurnInput,
  CurrentTurn,
  makeExecutionGateway,
  makeTool,
  makeToolRegistry,
  type Trace,
  type TurnContext
} from "@pva/core"
import { Effect, Schema, Stream } from "effect"
import { makeClaudeAgent } from "../src/index.ts"
import { makeFakeSdk } from "./fakeSdk.ts"

const seen: Array<TurnContext | undefined> = []
const ran: Array<string> = []
const whoami = makeTool({
  name: "whoami",
  description: "Who asks",
  parameters: Schema.Struct({}),
  speculative: true,
  execute: () =>
    Effect.gen(function*() {
      seen.push(yield* CurrentTurn)
      ran.push("whoami")
      return "ok"
    })
})
const unlock = makeTool({
  name: "unlock",
  description: "Unlock the door",
  parameters: Schema.Struct({}),
  speculative: true,
  execute: () => Effect.sync(() => (ran.push("unlock"), "unlocked"))
})

const turn: TurnContext = { turnId: 7, conversationId: "c1", assistantId: "jeff", deviceId: "d-kitchen-0001", deviceName: "Kitchen", source: "voice" }

const inputOf = (): AgentTurnInput => {
  const trace: Trace = { id: 7, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
  const gateway = makeExecutionGateway({ access: { moduleOn: () => true, toolOff: (assistant, _m, tool) => assistant === "jeff" && tool === "unlock" } })
  return {
    turnId: 7,
    text: "Who am I?",
    conversationId: "c1",
    utterance: "Who am I?",
    source: "voice",
    spoken: true,
    routedBy: "trigger",
    history: [],
    system: "Be brief.",
    context: undefined,
    tools: makeToolRegistry([{ name: "house", tools: [whoami, unlock] }], { gateway }),
    actions: [],
    deciders: new Map(),
    promoted: Effect.void,
    speculative: false,
    mark: () => {},
    trace,
    maxToolRounds: 4
  }
}

describe("the Claude Code bridge and module API v2", () => {
  it.live("a tool the harness calls sees the turn; a tool the assistant has off is refused by the gateway", () =>
    Effect.gen(function*() {
      seen.length = 0
      ran.length = 0
      const results: Array<{ content: string; isError: boolean }> = []
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          results.push(await ctx.callTool("whoami", {}))
          results.push(await ctx.callTool("unlock", {}))
          ctx.delta("Done.")
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() =>
        makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" }, sdk: fake.sdk })
      )
      const events: Array<AgentEvent> = Array.from(yield* Stream.runCollect(agent.turn(inputOf()).pipe(Stream.provideService(CurrentTurn, turn))))
      expect(events.some((e) => e._tag === "TextDelta")).toBe(true)
      expect(seen).toEqual([turn])
      expect(results[0]).toEqual({ content: "ok", isError: false })
      expect(results[1]).toEqual({ content: "Not run: unlock is switched off for this assistant.", isError: true })
      expect(ran).toEqual(["whoami"])

      // Without a turn (no origin: the CLI modes) the tool reads undefined, and no access check applies.
      seen.length = 0
      yield* Stream.runDrain(agent.turn(inputOf()))
      expect(seen).toEqual([undefined])
      agent.shutdown()
    }))
})
