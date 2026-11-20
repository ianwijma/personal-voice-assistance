import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { makeClaudeAgent } from "../../../agent-claude-code/src/index.ts"
import { makeFakeSdk } from "../../../agent-claude-code/test/fakeSdk.ts"
import { Conversation } from "../../src/Conversation.ts"
import type { ConversationInput } from "../../src/ConversationEvents.ts"
import { presentPrepared, presentWorld } from "../../src/presentContract.ts"
import { CurrentTurnCommit } from "../../src/TurnContext.ts"
import { eagerEndOfTurn, endOfTurn, makeAgentSetup, makeMarkerTts, makeMemoryHouseholdStore, makeRecordingAudioOutput, speechStarted, testTurnTraceLayer, turnResumed } from "../../src/testing.ts"

describe("Claude presentation commit context", () => {
  for (const promoted of [false, true]) {
    it.live(`a2: the real Conversation and SDK callback ${promoted ? "promote once" : "discard without showing"}`, () => Effect.gen(function*() {
      let calls = 0
      const commits: Array<boolean | undefined> = []
      const world = yield* presentWorld(yield* presentPrepared(makeMemoryHouseholdStore()), { speculative: true, toolRun: () => Effect.gen(function*() {
        calls++
        commits.push((yield* CurrentTurnCommit)?.committed())
        return { forModel: "Safe", present: { kind: "card", title: "Speculative", spoken: "S" }, show: { lifetime: "pinned" } }
      }) })
      let calledResolve = () => undefined as void
      const called = new Promise<void>((resolve) => { calledResolve = resolve })
      const fake = makeFakeSdk({ respond: async (ctx) => {
        await ctx.callTool("board_show", {})
        calledResolve()
        ctx.delta("Done.")
        ctx.result()
      } })
      const agent = yield* Effect.promise(() => makeClaudeAgent({ model: "claude-haiku-5-5", tools: true, speculate: true, sessionIdleMinutes: 60, env: { PATH: "/usr/bin" }, sdk: fake.sdk }))
      yield* Effect.addFinalizer(() => Effect.sync(() => agent.shutdown()))
      const setup = { ...makeAgentSetup({ agents: [{ id: "bridge", name: "Bridge", kind: "harness", speculate: true, firstEventTimeoutMs: 5_000, turn: agent.turn }], registry: world.host.snapshot().registry, routing: { defaultAgent: "bridge" } }), turnContext: { assistantId: "jeff", deviceId: "kitchen-display" } }
      const layer = Conversation.layerWithAgents({ setup: Effect.succeed(setup) }).pipe(
        Layer.provideMerge(testTurnTraceLayer),
        Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer))
      )
      yield* Effect.gen(function*() {
        const c = yield* Conversation
        const q = yield* Queue.unbounded<ConversationInput, Cause.Done>()
        const f = yield* Effect.forkChild(c.voice(Stream.fromQueue(q)))
        yield* Queue.offer(q, speechStarted)
        yield* Queue.offer(q, eagerEndOfTurn("show it"))
        yield* Effect.promise(() => called)
        yield* world.settle
        assert.strictEqual(calls, 1)
        assert.deepStrictEqual(commits, [false])
        assert.deepStrictEqual(world.shownOn("kitchen-display"), [])
        assert.deepStrictEqual(yield* world.rows, [])
        yield* Queue.offer(q, promoted ? endOfTurn("show it") : turnResumed)
        yield* Queue.end(q)
        yield* Fiber.join(f)
      }).pipe(Effect.provide(layer))
      yield* world.settle
      assert.strictEqual(world.shownOn("kitchen-display").length, promoted ? 1 : 0)
      assert.strictEqual((yield* world.rows).length, promoted ? 1 : 0)
      assert.strictEqual(world.firstTab("kitchen-display")!.messages.filter((m) => m.type === "present.show").length, promoted ? 1 : 0)
      assert.strictEqual(calls, 1)
    }).pipe(Effect.scoped))
  }
})
