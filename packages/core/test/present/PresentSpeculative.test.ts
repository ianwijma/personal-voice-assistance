// R8 (review round 2): nothing a speculative turn asks for reaches a screen before the turn is promoted. Through the real
// module host, gateway, model loop (`Conversation`) and Presenter: a presentation returned by a speculative tool (way 1)
// and `ctx.present` called from inside one (way 2), in a turn that is discarded and in one that is promoted.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { Conversation } from "../../src/Conversation.ts"
import type { ConversationInput, TurnSetup } from "../../src/ConversationEvents.ts"
import type { LlmRequest } from "../../src/Domain.ts"
import type { ModulePresent, Presentation, PresentHandle } from "../../src/Present.ts"
import { presentPrepared, presentWorld } from "../../src/presentContract.ts"
import {
  eagerEndOfTurn,
  endOfTurn,
  makeMarkerTts,
  makeMemoryHouseholdStore,
  makeRecordingAudioOutput,
  makeScriptedLlm,
  scripted,
  sleep,
  testTurnTraceLayer,
  textDelta,
  toolCall
} from "../../src/testing.ts"

const card = (title: string): Presentation => ({ kind: "card", title, text: "Text", spoken: `${title}.` } as Presentation)
type World = Effect.Success<ReturnType<typeof presentWorld>>
type Events = ReadonlyArray<ConversationInput | ReturnType<typeof sleep>>

/** A model that calls the board's tool for "show it", and answers in words after a tool round or for anything else. */
const llm = () =>
  makeScriptedLlm((request: LlmRequest) => {
    const last = request.messages[request.messages.length - 1]
    if (last?.role === "user" && last.content === "show it") return [toolCall("c1", "board_show", {})]
    return [textDelta("Done.")]
  })

/** The conversation of the kitchen display's assistant over the world's registry, fed `events`, run to its end. */
const converse = (world: World, events: Events, beforeDecision: Effect.Effect<void, unknown> = Effect.void) =>
  Effect.gen(function*() {
    const setup: TurnSetup = { system: "s", registry: world.host.snapshot().registry, turnContext: { assistantId: "jeff", deviceId: "kitchen-display" } }
    const model = llm()
    const layer = Conversation.layerWithSetup({ setup: Effect.succeed(setup) }).pipe(
      Layer.provideMerge(Layer.mergeAll(model.layer, testTurnTraceLayer)),
      Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
    )
    yield* Effect.gen(function*() {
      const c = yield* Conversation
      const fiber = yield* Effect.forkChild(c.voice(scripted<ConversationInput>(events)))
      for (let i = 0; i < 40; i++) {
        yield* Effect.repeat(Effect.yieldNow, { times: 50 })
        if (i === 4) yield* beforeDecision
        yield* TestClock.adjust(250)
      }
      yield* Fiber.join(fiber)
    }).pipe(Effect.provide(layer))
    yield* world.settle
    return model
  })

const DISCARDED: Events = [eagerEndOfTurn("show it"), sleep(2_000), endOfTurn("show it somewhere else"), sleep(2_000)]
const PROMOTED: Events = [eagerEndOfTurn("show it"), sleep(2_000), endOfTurn("show it"), sleep(2_000)]

const titles = (world: World) => world.shownOn("kitchen-display").map((p) => (p.content as { readonly title?: string }).title)
const showsOf = (world: World, title: string) =>
  world.firstTab("kitchen-display")!.messages.filter((m) => m.type === "present.show" && (m.presentation.content as { readonly title?: string }).title === title).length

const setUp = (o: Parameters<typeof presentWorld>[1]) =>
  Effect.gen(function*() {
    const store = yield* presentPrepared(makeMemoryHouseholdStore())
    const world = yield* presentWorld(store, { speculative: true, ...o })
    yield* world.settle
    // What is on the kitchen display before the turn: a transient a newer one would end.
    const earlier = yield* world.showOn("kitchen-display", card("Earlier"), { expiresInMs: 5 * 60_000 })
    return { world, earlier }
  })

describe("R8: a speculative turn and the screen", () => {
  it.effect("way 1: a presentation returned by a speculative tool in a turn that is discarded is never shown and withdraws nothing", () =>
    Effect.gen(function*() {
      let calls = 0
      const { world } = yield* setUp({ toolRun: () => Effect.sync(() => {
        calls++
        return { forModel: "Here it is.", present: card("Speculative") }
      }) })
      const model = yield* converse(world, DISCARDED, Effect.gen(function*() {
        assert.strictEqual(calls, 1, "a speculative tool completed before discard")
        assert.strictEqual(showsOf(world, "Speculative"), 0)
        assert.deepStrictEqual(titles(world), ["Earlier"])
        assert.deepStrictEqual((yield* world.rows).map((r) => (r.value.content as { title?: string }).title), ["Earlier"])
      }))
      assert.strictEqual(calls, 1)
      assert.isTrue(model.probe.requests.some((r) => r.messages.some((m) => m.role === "tool")), "the model received the speculative tool result")
      assert.strictEqual(showsOf(world, "Speculative"), 0)
      assert.deepStrictEqual(titles(world), ["Earlier"])
      assert.deepStrictEqual((yield* world.rows).map((r) => (r.value.content as { title?: string }).title), ["Earlier"])
    }))

  it.effect("way 1: in a turn that is promoted it is shown once, and the model's note is the usual one", () =>
    Effect.gen(function*() {
      const { world } = yield* setUp({})
      world.toolResult({ forModel: "Here it is.", present: card("Speculative") })
      const model = yield* converse(world, PROMOTED)
      assert.strictEqual(showsOf(world, "Speculative"), 1)
      assert.deepStrictEqual(titles(world), ["Speculative"])
      const toolMessage = model.probe.requests.flatMap((r) => r.messages).find((m) => m.role === "tool")
      assert.include(JSON.stringify(toolMessage), "Here it is.\\n[Screen: Showing on \\\"Kitchen display\\\".]")
    }))

  const recorded = (into: Array<unknown>, run: (present: ModulePresent) => Effect.Effect<unknown, unknown>) => (present: ModulePresent) =>
    run(present).pipe(
      Effect.map((v) => (into.push(v), "ok")),
      Effect.catch((e) => Effect.sync(() => (into.push((e as { readonly reason?: unknown }).reason), "refused")))
    )

  it.effect("way 2: ctx.present.show from inside a speculative tool changes nothing and says the turn is not committed; the discarded turn shows nothing", () =>
    Effect.gen(function*() {
      const outcomes: Array<unknown> = []
      const { world } = yield* setUp({ toolRun: recorded(outcomes, (present) => Effect.map(present.show("origin", card("Speculative")), (h) => h.outcome.note)) })
      yield* converse(world, DISCARDED)
      assert.deepStrictEqual(outcomes, ["uncommitted"])
      assert.strictEqual(showsOf(world, "Speculative"), 0)
      assert.deepStrictEqual(titles(world), ["Earlier"])
    }))

  it.effect("way 2: update and dismiss from inside a speculative tool change nothing (undefined, false)", () =>
    Effect.gen(function*() {
      const outcomes: Array<unknown> = []
      const handle: { current?: PresentHandle } = {}
      const { world, earlier } = yield* setUp({
        toolRun: recorded(outcomes, () => Effect.zip(handle.current!.update(card("Changed")), handle.current!.dismiss))
      })
      handle.current = earlier
      yield* converse(world, DISCARDED)
      assert.deepStrictEqual(outcomes, [[undefined, false]])
      assert.deepStrictEqual(titles(world), ["Earlier"])
    }))

  it.effect("way 2: the same calls from a committed turn act as before", () =>
    Effect.gen(function*() {
      const outcomes: Array<unknown> = []
      const { world } = yield* setUp({ toolRun: recorded(outcomes, (present) => Effect.map(present.show("origin", card("Committed")), (h) => h.outcome.note)) })
      yield* converse(world, [endOfTurn("show it"), sleep(2_000)])
      assert.deepStrictEqual(outcomes, ["Showing on \"Kitchen display\"."])
      assert.deepStrictEqual(titles(world), ["Committed"])
    }))
})
