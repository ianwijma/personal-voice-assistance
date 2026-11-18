// How far a ring arriving in the middle of a turn moves the turn's first audio (docs/NOTIFICATIONS.md "Latency"),
// measured with TurnTrace (at most 2 ms is asserted): the same scripted turn (the real Conversation, zero-delay synthesis and output, a language
// model whose first token comes 5 ms after the request) with and without a ring sent while the model "thinks". The
// ring is the heaviest delivery the bounds allow at once: everywhere, to 64 connected devices, every text at its bound with the costliest characters, two actions, through the host's page boundary, every card encoded as
// the hub encodes a frame, on the SQLite store, in the same process and on the same thread as the turn. Runs are
// counterbalanced (without, with, with, without, …); the medians are printed and compared.
import { Conversation, type ConversationEvent, CurrentTurn, makeToolRegistry, MAX_NOTIFICATION_LABEL_CHARS, MAX_NOTIFICATION_TEXT_CHARS, MAX_NOTIFICATION_TITLE_CHARS, notifyStorage, schedulerStorage, type Trace, TurnTrace } from "@pva/core"
import { contractDevice, notifyWorld } from "@pva/core/notify-contract"
import { endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta } from "@pva/core/testing"
import { encodeServerMessage } from "@pva/protocol"
import { Effect, Fiber, Layer, Queue, Stream } from "effect"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeSqliteStore } from "../src/index.ts"
import { bound, latencyDir } from "./latencyBound.ts"

const TURNS = 120
const WARM = 20
const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
const Q = "\""
const DEVICES = Array.from({ length: 64 }, (_, i) => contractDevice(`device-${String(i).padStart(2, "0")}-xxxxxxxx`, `Device ${i}`, `Room ${i % 8}`, "shared", null))

describe("a ring in the middle of a turn", () => {
  it("moves end of turn -> playbackStart by less than 2 ms (TurnTrace, counterbalanced)", async () => {
    const measure = (withRing: boolean) =>
      Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: join(latencyDir("pva-notify-turn"), "household.db") })
        yield* store.prepare([], [schedulerStorage, notifyStorage])
        const frames = { ring: 0, resolved: 0 }
        const world = yield* notifyWorld(store, {
          devices: DEVICES,
          unrecorded: true,
          outlet: (_d, m) => void (encodeServerMessage(m).length > 0 && (m.type === "notification.ring" ? frames.ring++ : frames.resolved++))
        })
        const context = yield* Effect.context<never>()
        const rang: Array<string> = []
        let sending: Fiber.Fiber<void, unknown> | undefined
        const ring = () =>
          void (sending = Effect.runForkWith(context)(
            Effect.map(
              world.bell().send({
                title: Q.repeat(MAX_NOTIFICATION_TITLE_CHARS),
                text: Q.repeat(MAX_NOTIFICATION_TEXT_CHARS),
                priority: "ring",
                target: "everywhere",
                actions: [{ id: "a".repeat(32), label: Q.repeat(MAX_NOTIFICATION_LABEL_CHARS) }, { id: "b".repeat(32), label: Q.repeat(MAX_NOTIFICATION_LABEL_CHARS) }],
                handler: "answer"
              }).pipe(
                Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "voice", assistantId: "jeff", deviceId: DEVICES[0]!.id })
              ),
              (r) => void rang.push(r.notification.id)
            )
          ))
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
              // Between turns (outside what is measured): this turn's ring is sent and its delivery has finished on a
              // slow runner too; then it is resolved, so every turn's ring is a new delivery within the bounds.
              if (sending !== undefined) yield* Fiber.join(sending)
              sending = undefined
              yield* world.settle
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
    type Run = { audible: number; p95: number; frames: { ring: number; resolved: number } }
    const without: Array<Run> = []
    const withRing: Array<Run> = []
    for (const order of [[false, true], [true, false], [false, true], [true, false]] as const) {
      for (const w of order) (w ? withRing : without).push(await Effect.runPromise(measure(w)))
    }
    const m = (xs: ReadonlyArray<{ audible: number; p95: number }>, k: "audible" | "p95") => median(xs.map((x) => x[k]))
    console.log(
      `TurnTrace, end of turn -> playbackStart, median of ${TURNS - WARM} turns x 4 counterbalanced runs (model's first token at 5 ms): ` +
        `without a ring ${m(without, "audible").toFixed(3)} ms (p95 ${m(without, "p95").toFixed(3)}), ` +
        `with a ring to 64 devices mid-turn ${m(withRing, "audible").toFixed(3)} ms (p95 ${m(withRing, "p95").toFixed(3)}); ` +
        `${withRing[0]!.frames.ring} ring frames per run`
    )
    // Every turn's ring reached every device, and was withdrawn from every device, in every run.
    for (const run of withRing) expect(run.frames).toEqual({ ring: 64 * TURNS, resolved: 64 * TURNS })
    for (const run of without) expect(run.frames).toEqual({ ring: 0, resolved: 0 })
    expect(m(withRing, "audible")).toBeLessThan(m(without, "audible") + bound(2))
  }, 240_000)
})
