// R8 (docs/PRESENTING.md, "Speculative turns"): nothing a speculative turn asks for reaches a screen before the turn is
// promoted. `news_top` (the tool generated from the read action `news.top`) and `news_headlines` are speculative tools:
// through the real host, gateway, model loop and Presenter, a turn that is discarded shows nothing and withdraws
// nothing, and a promoted one shows once; `news_headlines` changes no screen at all.
import { assert, describe, it } from "@effect/vitest"
import { Conversation, type ConversationInput, type TurnSetup } from "@pva/core"
import { eagerEndOfTurn, endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, scripted, sleep, testTurnTraceLayer, textDelta, toolCall } from "@pva/core/testing"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { refreshed, startNews, type Kit } from "./helpers.ts"
import { ARS, BBC, GUARDIAN, rss, xml } from "./helpers.ts"

const world = {
  [BBC]: xml(rss("BBC News", [{ title: "Storm hits the coast", link: "https://bbc.example/storm", ago: 30 }])),
  [GUARDIAN]: xml(rss("The Guardian", [{ title: "Rail strike called off", link: "https://guardian.example/rail", ago: 20 }])),
  [ARS]: xml(rss("Ars Technica", [{ title: "New chip is faster", link: "https://ars.example/chip", ago: 200 }]))
}

type Events = ReadonlyArray<ConversationInput | ReturnType<typeof sleep>>

/** A model that calls `tool` for "show it", and answers in words for anything else or after a tool round. */
const converse = (kit: Kit, tool: string, events: Events) =>
  Effect.gen(function*() {
    const setup: TurnSetup = { system: "s", registry: kit.host.snapshot().registry, turnContext: { assistantId: "jeff", deviceId: "kitchen-display" } }
    const model = makeScriptedLlm((request) => {
      const last = request.messages[request.messages.length - 1]
      return last?.role === "user" && last.content === "show it" ? [toolCall("c1", tool, {})] : [textDelta("Done.")]
    })
    const layer = Conversation.layerWithSetup({ setup: Effect.succeed(setup) }).pipe(
      Layer.provideMerge(Layer.mergeAll(model.layer, testTurnTraceLayer)),
      Layer.provideMerge(Layer.mergeAll(makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 100 }).layer))
    )
    yield* Effect.gen(function*() {
      const c = yield* Conversation
      const fiber = yield* Effect.forkChild(c.voice(scripted<ConversationInput>(events)))
      for (let i = 0; i < 40; i++) {
        yield* Effect.repeat(Effect.yieldNow, { times: 50 })
        yield* TestClock.adjust(250)
      }
      yield* Fiber.join(fiber)
    }).pipe(Effect.provide(layer))
    yield* kit.present.settle
    return model
  })

const DISCARDED: Events = [eagerEndOfTurn("show it"), sleep(2_000), endOfTurn("show it somewhere else"), sleep(2_000)]
const PROMOTED: Events = [eagerEndOfTurn("show it"), sleep(2_000), endOfTurn("show it"), sleep(2_000)]

const sends = (kit: Kit) => kit.present.messages.filter((m) => m.deviceId === "kitchen-display").map((m) => m.message.type)
const shows = (kit: Kit) => sends(kit).filter((t) => t === "present.show").length
const titles = (kit: Kit) => kit.present.shown("kitchen-display").map((p) => (p.content as { readonly title?: string }).title)

describe("@pva/module-news: a speculative turn and the screen (R8)", () => {
  it.effect("news_top: a turn that is discarded shows nothing", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      const model = yield* converse(kit, "news_top", DISCARDED)
      assert.isAtLeast(model.probe.requests.length, 2, "the tool ran while the turn was speculative")
      assert.deepStrictEqual(sends(kit), [])
      assert.deepStrictEqual(kit.present.shown("kitchen-display"), [])
    }))

  // (Each turn here is a new `Conversation`, whose turn ids start again: a discarded and a promoted turn do not share a kit.)
  it.effect("news_top: a promoted turn shows the list once", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      yield* converse(kit, "news_top", PROMOTED)
      assert.strictEqual(shows(kit), 1)
      assert.deepStrictEqual(titles(kit), ["News"])
    }))

  it.effect("news_top: a discarded turn withdraws nothing and replaces nothing of what is on the screen", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      yield* converse(kit, "news_top", PROMOTED)
      const [first] = kit.present.shown("kitchen-display")
      const before = sends(kit).length
      yield* converse(kit, "news_top", DISCARDED)
      assert.strictEqual(sends(kit).length, before)
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), [first!.id])
    }))

  it.effect("news_headlines changes no screen, in a discarded turn or a promoted one", () =>
    Effect.gen(function*() {
      const { kit } = yield* startNews(world)
      yield* refreshed(kit)
      yield* converse(kit, "news_top", PROMOTED)
      const [first] = kit.present.shown("kitchen-display")
      const before = sends(kit).length
      yield* converse(kit, "news_headlines", DISCARDED)
      yield* converse(kit, "news_headlines", PROMOTED)
      assert.strictEqual(sends(kit).length, before)
      assert.deepStrictEqual(kit.present.shown("kitchen-display").map((p) => p.id), [first!.id])
    }))
})
