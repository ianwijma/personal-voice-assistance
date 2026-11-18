// A ring arriving in the middle of a turn does not move the turn's first audio (docs/NOTIFICATIONS.md "Latency"),
// measured with TurnTrace: the same scripted turn (the real Conversation, zero-delay synthesis and output, a language
// model whose first token comes 5 ms after the request) with and without a ring sent while the model "thinks". The
// ring is the heaviest delivery the bounds allow at once: everywhere, to 64 connected devices, every card encoded as
// the hub encodes a frame, on the SQLite store, in the same process and on the same thread as the turn. Runs are
// counterbalanced (without, with, with, without, …); the medians are printed and compared.
import { Conversation, type ConversationEvent, CurrentTurn, makeToolRegistry, notifyStorage, schedulerStorage, type Trace, TurnTrace } from "@pva/core"
import { contractDevice, notifyWorld } from "@pva/core/notify-contract"
import { endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta } from "@pva/core/testing"
import { encodeServerMessage } from "@pva/protocol"
import { Effect, Layer, Queue, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeSqliteStore } from "../src/index.ts"
import { bound } from "./latencyBound.ts"

const TURNS = 120
const WARM = 20
const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
const DEVICES = Array.from({ length: 64 }, (_, i) => contractDevice(`device-${String(i).padStart(2, "0")}-xxxxxxxx`, `Device ${i}`, `Room ${i % 8}`, "shared", null))

describe("a ring in the middle of a turn", () => {
  it("does not move end of turn -> playbackStart (TurnTrace, counterbalanced)", async () => {
    const measure = (withRing: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: join(mkdtempSync(join(tmpdir(), "pva-notify-turn-")), "household.db") })
        yield* store.prepare([], [schedulerStorage, notifyStorage])
        let frames = 0
        const world = yield* notifyWorld(store, { devices: DEVICES, unrecorded: true, outlet: (_d, m) => void (frames += encodeServerMessage(m).length > 0 ? 1 : 0) })
        const context = yield* Effect.context<never>()
        const rang: Array<string> = []
        const ring = () =>
          void Effect.runForkWith(context)(
            Effect.map(
              world.bell().send({ title: "Pasta timer", text: "Ten minutes are up.", priority: "ring", target: "everywhere", actions: [{ id: "snooze", label: "Snooze" }], handler: "answer" }).pipe(
                Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "voice", assistantId: "jeff", deviceId: DEVICES[0]!.id })
              ),
              (r) => void rang.push(r.notification.id)
            )
          )
        const ended = yield* Queue.unbounded<Trace>()
        const onEvent = (e: ConversationEvent) => {
          if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
        }
        const audible: Array<number> = []
        const events = Stream.range(1, TURNS).pipe(
          Stream.flatMap((i) =>
            Stream.make(speechStarted, endOfTurn(`Turn ${i}`)).pipe(Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
              const t = yield* Queue.take(ended)
              audible.push(t.marks.playbackStart! - t.marks.endOfTurn!)
              // Resolved between turns, so every turn's ring is a new delivery within the bounds.
              for (const id of rang.splice(0)) yield* world.bell().resolve(id)
              yield* world.settle
            })))), { concurrency: 1 })
        )
        // The ring is sent the moment the request reaches the model, and delivered while the model "thinks".
        const llm = makeScriptedLlm(() => {
          if (withRing) ring()
          return [sleep(5), textDelta("Done. The pasta is ready.")]
        })
        const layer = Conversation.layerWithSetup({
          onEvent,
          setup: Effect.succeed({ system: "Benchmark.", registry: makeToolRegistry([]), turnContext: { deviceId: DEVICES[0]!.id, assistantId: "jeff" } })
        }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, TurnTrace.layer())))
        yield* Effect.gen(function*() {
          const c = yield* Conversation
          yield* c.voice(events)
        }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
        return { audible: median(audible.slice(WARM)), p95: p95(audible.slice(WARM)), frames }
      }))
    const without: Array<{ audible: number; p95: number; frames: number }> = []
    const withRing: Array<{ audible: number; p95: number; frames: number }> = []
    for (const order of [[false, true], [true, false], [false, true], [true, false]] as const) {
      for (const w of order) (w ? withRing : without).push(await Effect.runPromise(measure(w)))
    }
    const m = (xs: ReadonlyArray<{ audible: number; p95: number }>, k: "audible" | "p95") => median(xs.map((x) => x[k]))
    console.log(
      `TurnTrace, end of turn -> playbackStart, median of ${TURNS - WARM} turns x 4 counterbalanced runs (model's first token at 5 ms): ` +
        `without a ring ${m(without, "audible").toFixed(3)} ms (p95 ${m(without, "p95").toFixed(3)}), ` +
        `with a ring to 64 devices mid-turn ${m(withRing, "audible").toFixed(3)} ms (p95 ${m(withRing, "p95").toFixed(3)}); ` +
        `${withRing[0]!.frames} ring frames per run`
    )
    expect(withRing[0]!.frames).toBeGreaterThanOrEqual(64 * (TURNS - 1))
    expect(m(withRing, "audible")).toBeLessThan(m(without, "audible") + bound(2))
  }, 240_000)
})
