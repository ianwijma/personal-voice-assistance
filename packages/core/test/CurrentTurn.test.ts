// Module API v2 (docs/MODULES-PLAN.md §4 P1): `CurrentTurn` is provided around every tool call and action run of a
// turn whose setup names its origin, in core's tool loop; it is undefined in a turn without one (the CLI modes).
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { actionTool, defineAction, registerActions } from "../src/Actions.ts"
import { Conversation } from "../src/Conversation.ts"
import type { TurnSetup } from "../src/ConversationEvents.ts"
import { makeTool } from "../src/Module.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentTurn, type TurnContext, type TurnOrigin } from "../src/TurnContext.ts"
import { makeScriptedLlm, testTurnTraceLayer, textDelta, toolCall } from "../src/testing.ts"

const seen: Array<{ readonly where: string; readonly turn: TurnContext | undefined }> = []

const whoami = makeTool({
  name: "whoami",
  description: "Who asks",
  parameters: Schema.Struct({}),
  execute: () =>
    Effect.gen(function*() {
      seen.push({ where: "tool", turn: yield* CurrentTurn })
      // A fiber the tool forks sees it too.
      const forked = yield* Effect.forkChild(Effect.gen(function*() {
        return yield* CurrentTurn
      }))
      seen.push({ where: "forked", turn: yield* Fiber.join(forked) })
      return "ok"
    })
})

const [whereAction] = registerActions("home", [
  defineAction({
    id: "where",
    label: "Say where",
    description: "Where the owner is",
    params: {},
    run: () =>
      Effect.gen(function*() {
        seen.push({ where: "action", turn: yield* CurrentTurn })
        return { say: "Here." }
      })
  })
])

const conversationWith = (origin: TurnOrigin | undefined) => {
  const context = {
    name: "Who",
    get: Effect.gen(function*() {
      seen.push({ where: "context", turn: yield* CurrentTurn })
      return ""
    })
  }
  const registry = makeToolRegistry([{ name: "t", tools: [whoami, actionTool(whereAction!)], context: [context] }])
  const setup: TurnSetup = { system: "sys", registry, ...(origin !== undefined ? { turnContext: origin } : {}) }
  const llm = makeScriptedLlm([
    [toolCall("c1", "whoami", {}), toolCall("c2", "home_where", {})],
    [textDelta("Done.")]
  ])
  return Conversation.layerWithSetup({ setup: Effect.succeed(setup) }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)))
}

const turn = Effect.gen(function*() {
  const c = yield* Conversation
  const text = yield* Stream.runCollect(c.textTurn("where am I"))
  return { text: text.join(""), conversationId: yield* c.conversationId }
})

describe("CurrentTurn in core's tool loop", () => {
  it.effect("a context provider, a tool, a fiber it forks and an action see the turn: ids, source and the setup's origin", () => {
    seen.length = 0
    const origin: TurnOrigin = { assistantId: "jeff", deviceId: "d-kitchen-0001", deviceName: "Kitchen tablet" }
    return Effect.gen(function*() {
      const { conversationId, text } = yield* turn
      assert.strictEqual(text.trim(), "Done.")
      assert.deepStrictEqual(seen.map((s) => s.where).sort(), ["action", "context", "forked", "tool"])
      for (const { turn: t, where } of seen) {
        assert.isDefined(t, where)
        assert.strictEqual(t!.conversationId, conversationId, where)
        assert.strictEqual(t!.source, "text", where)
        assert.strictEqual(t!.assistantId, "jeff", where)
        assert.strictEqual(t!.deviceId, "d-kitchen-0001", where)
        assert.strictEqual(t!.deviceName, "Kitchen tablet", where)
        assert.strictEqual(t!.room, undefined, where)
        assert.strictEqual(t!.person, undefined, where)
        assert.isTrue(Number.isInteger(t!.turnId) && t!.turnId > 0, where)
      }
      // One value per turn: every reader got the same object.
      assert.isTrue(seen.every((s) => s.turn === seen[0]!.turn))
    }).pipe(Effect.provide(conversationWith(origin)))
  })

  it.effect("a turn whose setup names no origin (the CLI modes) leaves it undefined", () => {
    seen.length = 0
    return Effect.gen(function*() {
      yield* turn
      assert.strictEqual(seen.length, 4)
      assert.isTrue(seen.every((s) => s.turn === undefined))
    }).pipe(Effect.provide(conversationWith(undefined)))
  })

  it.effect("outside a turn it is undefined", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* CurrentTurn, undefined)
    }))
})
