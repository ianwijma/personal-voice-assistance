// P8 through the Claude Code bridge: the SDK calls tools from outside the turn's fiber, so the bridge gives each call the
// turn (`CurrentTurn`) and the turn's trace (`CurrentTurnTrace`); the gateway decides each call on the household's risk
// policy of that moment and records the decision on the turn's trace; a refusal reaches the model as "Not run: …".
import { describe, expect, it } from "@effect/vitest"
import { type AgentTurnInput, CurrentTurn, DEFAULT_RISK_POLICY, makeExecutionGateway, makeTool, makeToolRegistry, type RiskPolicy, type Trace, type TurnContext } from "@pva/core"
import { Effect, Schema, Stream } from "effect"
import { makeClaudeAgent } from "../src/index.ts"
import { makeFakeSdk } from "./fakeSdk.ts"

const lamp = makeTool({ name: "lamp", description: "Switch the lamp", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.succeed("on") })
const turn: TurnContext = { turnId: 9, conversationId: "c1", assistantId: "jeff", deviceId: "d-kitchen-0001", deviceName: "Kitchen", source: "voice" }

describe("the Claude Code bridge and the risk policy", () => {
  it.live("each call is decided on the policy of now and recorded on the turn's trace", () =>
    Effect.gen(function*() {
      let policy: RiskPolicy = DEFAULT_RISK_POLICY
      const trace: Trace = { id: 9, mode: "voice", speculative: false, startedAt: 0, marks: {}, tools: [], voices: [] }
      const gateway = makeExecutionGateway({ access: { moduleOn: () => true, toolOff: () => false }, policy: () => policy })
      const input: AgentTurnInput = {
        turnId: 9,
        text: "Lamp on.",
        conversationId: "c1",
        utterance: "Lamp on.",
        source: "voice",
        spoken: true,
        routedBy: "trigger",
        history: [],
        system: "Be brief.",
        context: undefined,
        tools: makeToolRegistry([{ name: "house", tools: [lamp] }], { gateway }),
        actions: [],
        deciders: new Map(),
        promoted: Effect.void,
        speculative: false,
        mark: () => {},
        trace,
        maxToolRounds: 4
      }
      const results: Array<{ content: string; isError: boolean }> = []
      const fake = makeFakeSdk({
        respond: async (ctx) => {
          results.push(await ctx.callTool("lamp", {}))
          // The owner saves "Refuse" for changes while the turn runs: the next call is refused.
          policy = { ...DEFAULT_RISK_POLICY, change: "deny" }
          results.push(await ctx.callTool("lamp", {}))
          ctx.delta("Done.")
          ctx.result()
        }
      })
      const agent = yield* Effect.promise(() =>
        makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: false, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" }, sdk: fake.sdk })
      )
      yield* Stream.runDrain(agent.turn(input).pipe(Stream.provideService(CurrentTurn, turn)))
      expect(results).toEqual([
        { content: "on", isError: false },
        { content: "Not run: it would change something in the house, which this household does not allow.", isError: true }
      ])
      expect(trace.calls?.map((c) => [c.name, c.outcome, c.by])).toEqual([["lamp", "allow", "change"], ["lamp", "deny", "change"]])
      agent.shutdown()
    }))
})
