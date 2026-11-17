// The execution gateway (docs/MODULES-PLAN.md §4 P1): one way to a tool's execute and an action's run, checking the
// assistant's module, its offTools, then the risk hook, in that order.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema, Stream } from "effect"
import { defineAction, registerActions } from "../src/Actions.ts"
import { Conversation } from "../src/Conversation.ts"
import { ALLOW, type GatewayCall, makeExecutionGateway, refuse } from "../src/Gateway.ts"
import { makeTool } from "../src/Module.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext } from "../src/TurnContext.ts"
import { makeScriptedLlm, testTurnTraceLayer, textDelta, toolCall } from "../src/testing.ts"

const ran: Array<string> = []
const door = makeTool({
  name: "door",
  description: "Open a door",
  parameters: Schema.Struct({ which: Schema.String }),
  risk: { classes: ["change", "security"], of: ({ which }) => (which === "garage" ? "security" : "change") },
  execute: ({ which }) => Effect.sync(() => (ran.push(which), `${which} open`))
})
const turnOf = (assistantId: string): TurnContext => ({ turnId: 1, conversationId: "c", assistantId, deviceId: "d-1", source: "voice" })
const access = {
  moduleOn: (assistant: string, moduleId: string) => !(assistant === "b" && moduleId === "home"),
  toolOff: (assistant: string, _moduleId: string, tool: string) => assistant === "a" && tool === "door"
}

describe("the execution gateway", () => {
  it.effect("checks the module, then offTools, then the hooks, and runs nothing it refuses", () =>
    Effect.gen(function*() {
      ran.length = 0
      const seen: Array<string> = []
      const gateway = makeExecutionGateway({
        access,
        risk: (call) => Effect.sync(() => (seen.push(`risk:${call.risk}`), call.risk === "security" ? refuse("security is denied.") : ALLOW))
      })
      const run = (assistantId: string | undefined, which: string) =>
        Effect.flip(gateway.tool("home", door, { which })).pipe(
          Effect.map((e) => e.message),
          Effect.orElseSucceed(() => "ran"),
          assistantId === undefined ? (e) => e : Effect.provideService(CurrentTurn, turnOf(assistantId))
        )
      assert.strictEqual(yield* run("b", "front"), "Not run: the home module is not on for this assistant.")
      assert.strictEqual(yield* run("a", "front"), "Not run: door is switched off for this assistant.")
      assert.deepStrictEqual(seen, [], "the hooks are not asked once an access check refused")
      assert.strictEqual(yield* run("c", "garage"), "Not run: security is denied.", "the risk function saw the validated input")
      assert.deepStrictEqual(seen, ["risk:security"])
      assert.strictEqual(yield* run("c", "front"), "ran")
      assert.deepStrictEqual(seen, ["risk:security", "risk:change"])
      assert.strictEqual(yield* run(undefined, "back"), "Not run: it has no turn, job or other principal to run for.", "serve mode: no turn, no job, refused")
      assert.deepStrictEqual(ran, ["front"])
      assert.match(yield* run("c", 42 as unknown as string), /^Invalid input: Expected string/)
    }))

  it.effect("an action goes through the same checks, under its generated tool's name, with its values", () =>
    Effect.gen(function*() {
      const calls: Array<GatewayCall> = []
      const gateway = makeExecutionGateway({ access, risk: (call) => Effect.sync(() => (calls.push(call), ALLOW)) })
      const [action] = registerActions("home", [
        defineAction({ id: "door", label: "Open", description: "", params: {}, risk: { classes: ["security"], of: () => "security" }, run: () => Effect.succeed({ say: "Open." }) })
      ])
      const off = yield* Effect.flip(gateway.action(action!, {})).pipe(Effect.provideService(CurrentTurn, turnOf("b")))
      assert.strictEqual(off.message, "Not run: the home module is not on for this assistant.")
      const outcome = yield* gateway.action(action!, {}, { confirmed: true }).pipe(Effect.provideService(CurrentTurn, turnOf("c")))
      assert.deepStrictEqual(outcome, { say: "Open." })
      assert.strictEqual(calls[0]!.name, "home_door")
      assert.strictEqual(calls[0]!.risk, "security")
      assert.isTrue(calls[0]!.confirmed)
      assert.strictEqual(calls[0]!.deviceId, "d-1")
    }))

  it.effect("in core's tool loop, a tool the assistant has off is refused and the model is told so", () =>
    Effect.gen(function*() {
      ran.length = 0
      const registry = makeToolRegistry([{ name: "home", tools: [door] }], { gateway: makeExecutionGateway({ access }) })
      const llm = makeScriptedLlm([[toolCall("c1", "door", { which: "front" })], [textDelta("I cannot.")]])
      const layer = Conversation.layerWithSetup({
        setup: Effect.succeed({ system: "sys", registry, turnContext: { assistantId: "a", deviceId: "d-1" } })
      }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)))
      yield* Effect.gen(function*() {
        const c = yield* Conversation
        yield* Stream.runDrain(c.textTurn("open the front door"))
        const history = yield* c.history
        const results = history.flatMap((m) => (m.role === "tool" ? m.results : []))
        assert.deepStrictEqual(results, [{ id: "c1", name: "door", content: "Not run: door is switched off for this assistant.", isError: true }])
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(ran, [], "execute was never reached")
    }))
})
