// The execution gateway and CurrentTurn, review round 1 (docs/MODULES-PLAN.md §4 P1): principals (turn, job, local,
// notification), refusal without one in serve mode, the connection a turn came in on, and concurrent turns of two
// assistants on two devices seeing only their own identity (finding 24).
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { defineAction, registerActions } from "../src/Actions.ts"
import { Conversation } from "../src/Conversation.ts"
import type { TurnSetup } from "../src/ConversationEvents.ts"
import { ALLOW, type GatewayAccess, type GatewayCall, makeExecutionGateway, refuse } from "../src/Gateway.ts"
import { makeTool } from "../src/Module.ts"
import { makeToolRegistry } from "../src/ToolRegistry.ts"
import { CurrentJob, CurrentTurn, makeConnectionRef, type TurnContext, type TurnOrigin } from "../src/TurnContext.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  makeMarkerTts,
  makeRecordingAudioOutput,
  makeScriptedLlm,
  scripted,
  sleep,
  testTurnTraceLayer,
  textDelta,
  toolCall
} from "../src/testing.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

const openAccess: GatewayAccess = { moduleOn: () => true, toolOff: () => false }

describe("principals (plan items 5 and 8)", () => {
  const ran: Array<string> = []
  const tool = makeTool({ name: "t", description: "", parameters: Schema.Struct({}), execute: () => Effect.sync(() => (ran.push("t"), "ran")) })

  it.effect("the CLI modes run a call with no turn for the explicit local principal; serve mode refuses it", () =>
    Effect.gen(function*() {
      const calls: Array<GatewayCall> = []
      const risk = (call: GatewayCall) => Effect.sync(() => (calls.push(call), ALLOW))
      const cli = makeExecutionGateway({ risk })
      assert.strictEqual(yield* cli.tool("m", tool, {}), "ran")
      assert.deepStrictEqual(calls[0]!.principal, { _tag: "local" })
      const serve = makeExecutionGateway({ access: openAccess, risk })
      const refused = yield* Effect.flip(serve.tool("m", tool, {}))
      assert.strictEqual(refused.message, "Not run: it has no turn, job or other principal to run for.")
      assert.strictEqual(calls.length, 1, "a refused principal never reaches the hooks")
      // A job made for an assistant is admitted for that assistant.
      const job = yield* Effect.provideService(serve.tool("m", tool, {}), CurrentJob, { jobId: "j1", moduleId: "m", assistantId: "a" })
      assert.strictEqual(job, "ran")
      assert.deepStrictEqual(calls[1]!.principal, { _tag: "job", job: { jobId: "j1", moduleId: "m", assistantId: "a" } })
      assert.strictEqual(calls[1]!.assistantId, "a")
    }))

  it.effect("a notification's action is admitted by the notification, whatever modules the device's assistant has on; the risk hook still runs", () =>
    Effect.gen(function*() {
      const seen: Array<GatewayCall> = []
      const gateway = makeExecutionGateway({
        access: { moduleOn: () => false, toolOff: () => true },
        risk: (call) => Effect.sync(() => (seen.push(call), call.risk === "security" ? refuse("denied.") : ALLOW))
      })
      const [snooze, unlock] = registerActions("alarms", [
        defineAction({ id: "snooze", label: "Snooze", description: "", params: {}, run: () => Effect.succeed({ say: "Snoozed." }) }),
        defineAction({ id: "unlock", label: "Unlock", description: "", params: {}, risk: "security", run: () => Effect.succeed({ say: "Open." }) })
      ])
      const principal = { _tag: "notification", notification: { notificationId: "n1", deviceId: "d-hall", connection: makeConnectionRef("c9") } } as const
      // Inside some other assistant's turn the explicit principal still wins.
      const turn: TurnContext = { turnId: 1, conversationId: "c", assistantId: "b", source: "voice" }
      const outcome = yield* Effect.provideService(gateway.action(snooze!, {}, { principal }), CurrentTurn, turn)
      assert.deepStrictEqual(outcome, { say: "Snoozed." })
      assert.strictEqual(seen[0]!.deviceId, "d-hall")
      assert.strictEqual(seen[0]!.connection?.id, "c9")
      assert.isUndefined(seen[0]!.assistantId)
      const denied = yield* Effect.flip(gateway.action(unlock!, {}, { principal }))
      assert.strictEqual(denied.message, "Not run: denied.")
    }))
})

describe("the connection a turn came in on (plan item 6)", () => {
  it.effect("a typed turn's CurrentTurn names the connection that typed it, over the setup's", () =>
    Effect.gen(function*() {
      const seen: Array<string | undefined> = []
      const who = makeTool({
        name: "who",
        description: "",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () => Effect.flatMap(CurrentTurn, (t) => Effect.sync(() => (seen.push(t?.connection?.id), "ok")))
      })
      const registry = makeToolRegistry([{ name: "m", tools: [who] }])
      const origin: TurnOrigin = { assistantId: "a", deviceId: "d1", connection: makeConnectionRef("owner-tab") }
      const setup: TurnSetup = { system: "s", registry, turnContext: origin }
      const llm = makeScriptedLlm([[toolCall("c1", "who", {})], [textDelta("One.")], [toolCall("c2", "who", {})], [textDelta("Two.")]])
      const tts = makeMarkerTts()
      const out = makeRecordingAudioOutput({ chunkMillis: 100 })
      const layer = Conversation.layerWithSetup({ setup: Effect.succeed(setup) }).pipe(
        Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)),
        Layer.provideMerge(Layer.mergeAll(tts.layer, out.layer))
      )
      yield* Effect.gen(function*() {
        const c = yield* Conversation
        const fiber = yield* Effect.forkChild(c.voice(scripted([
          { _tag: "TextInput", text: "who", speak: false, connection: makeConnectionRef("second-tab") },
          sleep(1_000),
          endOfTurn("who again"),
          sleep(1_000)
        ])))
        yield* advance(3_000)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(seen, ["second-tab", "owner-tab"])
    }))
})

describe("two assistants on two devices at once (finding 24)", () => {
  it.effect("each concurrent turn's tool, its forked fiber and the gateway see only that turn", () =>
    Effect.gen(function*() {
      const barrier = yield* Deferred.make<void>()
      const arrived: Array<string> = []
      const seen: Array<string> = []
      const admitted: Array<string> = []
      const gateway = makeExecutionGateway({ access: openAccess, risk: (call) => Effect.sync(() => (admitted.push(`${call.assistantId}@${call.deviceId}`), ALLOW)) })
      const who = makeTool({
        name: "who",
        description: "",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.gen(function*() {
            const before = yield* CurrentTurn
            arrived.push(before!.assistantId!)
            if (arrived.length === 2) yield* Deferred.succeed(barrier, undefined)
            // Both turns are inside their tool call at the same time here.
            yield* Deferred.await(barrier)
            const forked = yield* Effect.forkChild(CurrentTurn)
            const after = yield* Fiber.join(forked)
            seen.push(`${before!.assistantId}@${before!.deviceId}=${after!.assistantId}@${after!.deviceId}`)
            return "ok"
          })
      })
      const registry = makeToolRegistry([{ name: "m", tools: [who] }], { gateway })
      const conversation = (origin: TurnOrigin) => {
        const llm = makeScriptedLlm([[toolCall("c1", "who", {})], [textDelta("Done.")]])
        return Conversation.layerWithSetup({ setup: Effect.succeed({ system: "s", registry, turnContext: origin }) }).pipe(
          Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer))
        )
      }
      const turnOn = (origin: TurnOrigin) =>
        Effect.gen(function*() {
          const c = yield* Conversation
          return (yield* Stream.runCollect(c.textTurn("who"))).join("")
        }).pipe(Effect.provide(conversation(origin)))
      const [a, b] = yield* Effect.all([turnOn({ assistantId: "a", deviceId: "d1" }), turnOn({ assistantId: "b", deviceId: "d2" })], { concurrency: 2 })
      assert.strictEqual(a.trim(), "Done.")
      assert.strictEqual(b.trim(), "Done.")
      assert.sameMembers(arrived, ["a", "b"])
      assert.sameMembers(seen, ["a@d1=a@d1", "b@d2=b@d2"])
      assert.sameMembers(admitted, ["a@d1", "b@d2"])
    }))

  it.effect("access revoked while a turn waits for promotion: the tool is refused after promotion and never runs", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      let on = true
      const gateway = makeExecutionGateway({ access: { moduleOn: () => on, toolOff: () => false } })
      const door = makeTool({ name: "door", description: "", parameters: Schema.Struct({}), execute: () => Effect.sync(() => (ran.push("door"), "open")) })
      const registry = makeToolRegistry([{ name: "home", tools: [door] }], { gateway })
      const llm = makeScriptedLlm([[toolCall("c1", "door", {})], [textDelta("Could not.")]])
      const tts = makeMarkerTts()
      const out = makeRecordingAudioOutput({ chunkMillis: 100 })
      const layer = Conversation.layerWithSetup({ setup: Effect.succeed({ system: "s", registry, turnContext: { assistantId: "a", deviceId: "d1" } }) }).pipe(
        Layer.provideMerge(Layer.mergeAll(llm.layer, testTurnTraceLayer)),
        Layer.provideMerge(Layer.mergeAll(tts.layer, out.layer))
      )
      yield* Effect.gen(function*() {
        const c = yield* Conversation
        const fiber = yield* Effect.forkChild(c.voice(scripted([eagerEndOfTurn("open the door"), sleep(500), endOfTurn("open the door"), sleep(1_000)])))
        yield* advance(200)
        assert.deepStrictEqual(ran, [], "a non-speculative tool waits for promotion")
        on = false
        yield* advance(2_000)
        yield* Fiber.join(fiber)
        const results = (yield* c.history).flatMap((m) => (m.role === "tool" ? m.results : []))
        assert.deepStrictEqual(results.map((r) => r.content), ["Not run: the home module is not on for this assistant."])
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(ran, [])
    }))

  it.effect("a confirmed action is refused when the assistant's access was revoked since it was proposed", () =>
    Effect.gen(function*() {
      const ran: Array<string> = []
      let on = true
      const gateway = makeExecutionGateway({ access: { moduleOn: () => on, toolOff: () => false } })
      const [allOff] = registerActions("home", [
        defineAction({ id: "all_off", label: "All off", description: "", params: {}, confirm: true, run: () => Effect.sync(() => void ran.push("all_off")) })
      ])
      const turn: TurnContext = { turnId: 2, conversationId: "c", assistantId: "a", deviceId: "d1", source: "voice" }
      on = false
      const refused = yield* Effect.flip(Effect.provideService(gateway.action(allOff!, {}, { confirmed: true }), CurrentTurn, turn))
      assert.strictEqual(refused.message, "Not run: the home module is not on for this assistant.")
      assert.deepStrictEqual(ran, [])
    }))
})
