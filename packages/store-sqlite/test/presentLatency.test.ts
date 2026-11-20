// What the Presenter costs (docs/PRESENTING.md "Latency" quotes the printed numbers), on SQLite on a file, at the
// stated maximum: live presentations at their total bound (32) with every text at its bound with the costliest
// characters JSON has for it (the worst legal list: twelve items, three buttons), 64 devices with a page each, every
// message encoded as the hub encodes a frame, through the host's real page boundary.
//
// - The turn: the same scripted turn (the real Conversation, a tool round through the host's registry and gateway,
//   zero-delay synthesis and output, the model's next token 5 ms after each request) whose tool returns the same
//   `forModel` with and without a presentation (`{ forModel, present }`): end of turn -> playbackStart with TurnTrace,
//   counterbalanced; the difference is asserted under the shared `bound(2)`.
// - `show` as a tool calls it (one transaction and an enqueue), and the longest main-thread stop of a 1 ms timer while a
//   page says hello with nine presentations and while every device is reconciled, asserted with `bound(10)`.
import { assert, describe, it } from "@effect/vitest"
import { Conversation, type ConversationEvent, CurrentTurn, MAX_LIVE_PER_MODULE, MAX_LIVE_TOTAL, type Presentation, type Trace, TurnTrace } from "@pva/core"
import { presentPrepared, presentWorld } from "@pva/core/present-contract"
import { contractDevice } from "@pva/core/notify-contract"
import { done, endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, sleep, speechStarted, textDelta, toolCall } from "@pva/core/testing"
import { encodeServerMessage, MAX_PINNED_PER_DEVICE } from "@pva/protocol"
import { Effect, Layer, Queue, Stream } from "effect"
import { join } from "node:path"
import { expect } from "vitest"
import { makeSqliteStore } from "../src/index.ts"
import { bound, latencyDir } from "./latencyBound.ts"

const Q = "\""
const DEVICES = Array.from({ length: 64 }, (_, i) => contractDevice(`device-${String(i).padStart(2, "0")}-xxxxxxxx`, `Device ${i}`, `Room ${i % 8}`, "shared", null))
const MODULES = Array.from({ length: Math.ceil(MAX_LIVE_TOTAL / MAX_LIVE_PER_MODULE) }, (_, i) => (i === 0 ? "board" : `board${i}`))
const turnOn = (deviceId: string) => ({ turnId: 1, conversationId: "c1", source: "voice" as const, assistantId: "jeff", deviceId })
/** The worst legal presentation: a checklist of twelve items, every text at its bound with the costliest characters. */
const WORST = (n: number): Presentation => ({
  kind: "list",
  title: Q.repeat(60),
  style: "checklist",
  items: Array.from({ length: 12 }, (_, i) => ({ id: `${n}-${i}`.padEnd(40, "x"), text: Q.repeat(80) })),
  spoken: Q.repeat(300),
  handler: "answer",
  buttons: Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`.padEnd(32, "x"), label: Q.repeat(20) }))
})
const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

const longestStop = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const value = yield* effect
      return { value, worst: Math.max(worst, performance.now() - last) }
    } finally {
      clearInterval(timer)
    }
  })

/** The world on a SQLite file with the live presentations at their total bound less `leave`, pinned, 8 on the turn's device. */
const loaded = (leave: number, frames: { n: number; bytes: number }) =>
  Effect.gen(function*() {
    const store = yield* makeSqliteStore({ filename: join(latencyDir("pva-present"), "household.db") })
    yield* presentPrepared(store)
    const world = yield* presentWorld(store, {
      modules: MODULES,
      devices: DEVICES,
      unrecorded: true,
      outlet: (_d, m) => {
        frames.n++
        frames.bytes += encodeServerMessage(m).length
      }
    })
    yield* world.settle
    let n = 0
    for (const m of MODULES) {
      // The turn's module keeps room for the turn's own presentation.
      for (let i = 0; i < MAX_LIVE_PER_MODULE - (m === "board" ? leave : 0) && n < MAX_LIVE_TOTAL - leave; i++, n++) {
        const device = n < MAX_PINNED_PER_DEVICE ? DEVICES[0]!.id : DEVICES[1 + (n % 63)]!.id
        yield* world.board(m).show({ device }, WORST(n), { lifetime: "pinned", expiresInMs: 3_600_000 }).pipe(Effect.provideService(CurrentTurn, turnOn(device)))
      }
    }
    yield* world.settle
    return world
  })

describe("presentation latency on SQLite at the stated maximum", () => {
  it.live("a tool's presentation does not move the turn's first audio (TurnTrace, counterbalanced)", () =>
    Effect.gen(function*() {
      const TURNS = 100
      const WARM = 20
      const measure = (present: boolean) =>
        Effect.scoped(Effect.gen(function*() {
          const frames = { n: 0, bytes: 0 }
          const world = yield* loaded(1, frames)
          const before = frames.n
          world.answer.current = () => Effect.void
          // The tool returns the same `forModel` either way; with a presentation, the worst legal one, by one key.
          let shown = 0
          const value = () => {
            const forModel = { items: 12 }
            if (!present) return forModel
            shown++
            return { forModel, present: WORST(1000 + shown), show: { key: "turn" } }
          }
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
                // Between turns (outside what is measured): what the turn showed has been written and sent.
                yield* world.settle
              })))), { concurrency: 1 })
          )
          const llm = makeScriptedLlm((request) => {
            const last = request.messages[request.messages.length - 1]
            if (last?.role === "tool") return [sleep(5), textDelta("Here is the list.")]
            world.toolResult(value())
            return [sleep(5), toolCall(`t${audible.length}`, "board_show", {}), done("tool_use")]
          })
          const layer = Conversation.layerWithSetup({
            onEvent,
            setup: Effect.sync(() => ({ system: "Benchmark.", registry: world.host.snapshot().registry, turnContext: { deviceId: DEVICES[0]!.id, assistantId: "jeff" } }))
          }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, TurnTrace.layer())))
          yield* Effect.gen(function*() {
            const c = yield* Conversation
            yield* c.voice(events)
          }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
          return { audible: median(audible.slice(WARM)), p95: p95(audible.slice(WARM)), frames: frames.n - before, shown }
        }))
      type Run = { audible: number; p95: number; frames: number; shown: number }
      const without: Array<Run> = []
      const withP: Array<Run> = []
      for (const order of [[false, true], [true, false], [false, true], [true, false]] as const) {
        for (const w of order) (w ? withP : without).push(yield* measure(w))
      }
      const m = (xs: ReadonlyArray<Run>, k: "audible" | "p95") => median(xs.map((x) => x[k]))
      console.log(
        `TurnTrace, end of turn -> playbackStart, median of ${TURNS - WARM} turns x 4 counterbalanced runs (a tool round; the model's tokens 5 ms after each request): ` +
          `without a presentation ${m(without, "audible").toFixed(3)} ms (p95 ${m(without, "p95").toFixed(3)}), ` +
          `with the worst legal presentation from the tool ${m(withP, "audible").toFixed(3)} ms (p95 ${m(withP, "p95").toFixed(3)}), ` +
          `${MAX_LIVE_TOTAL - 1} other presentations live; ${withP[0]!.frames} frames per run with`
      )
      // Every turn's presentation reached the turn's page (a show, then an update in place by its key).
      for (const run of withP) expect(run.frames).toBe(TURNS)
      for (const run of without) expect(run.frames).toBe(0)
      expect(m(withP, "audible")).toBeLessThan(m(without, "audible") + bound(2))
    }), 240_000)

  it.live("show as a tool calls it, a page's hello with nine presentations and reconciling every device with real fan-out hold the main thread under the bound", () =>
    Effect.scoped(Effect.gen(function*() {
      const frames = { n: 0, bytes: 0 }
      const world = yield* loaded(1, frames)
      // `show` as a tool calls it, at the bound: the transaction and the enqueue (a transient: it replaces the last);
      // the longest stop across the whole workload is asserted (review round 1, a14), the median too.
      const shows: Array<number> = []
      const showing = yield* longestStop(Effect.gen(function*() {
        for (let i = 0; i < 200; i++) {
          const t = performance.now()
          yield* world.board().show("origin", WORST(2000 + i)).pipe(Effect.provideService(CurrentTurn, turnOn(DEVICES[0]!.id)))
          shows.push(performance.now() - t)
          yield* world.settle
        }
      }))
      // A page of the turn's device says hello: nine presentations (eight pinned and the transient) in one step.
      const hello = yield* longestStop(Effect.andThen(world.open(DEVICES[0]!.id), world.settle))
      console.log(
        `show as a tool calls it (200 calls): median ${median(shows).toFixed(3)} ms, p95 ${p95(shows).toFixed(3)} ms, worst ${Math.max(...shows).toFixed(3)} ms, ` +
          `longest main-thread stop across them ${showing.worst.toFixed(2)} ms; a page's hello with 9 presentations: longest stop ${hello.worst.toFixed(2)} ms`
      )
      assert.isBelow(showing.worst, bound(10))
      assert.isBelow(hello.worst, bound(10))
      assert.isBelow(median(shows), bound(2))
    })), 240_000)

  it.live("reconciling every device with real fan-out at the bounds: 64 devices in one room, each page holding 9 of the worst legal presentations", () =>
    Effect.scoped(Effect.gen(function*() {
      const frames = { n: 0, bytes: 0 }
      const house = DEVICES.map((d) => ({ ...d, room: "House", place: { ...d.place, room: "House" } }))
      const store = yield* makeSqliteStore({ filename: join(latencyDir("pva-present-fan"), "household.db") })
      yield* presentPrepared(store)
      const world = yield* presentWorld(store, { modules: MODULES, devices: house, unrecorded: true, outlet: (_d, m) => {
        frames.n++
        frames.bytes += encodeServerMessage(m).length
      } })
      yield* world.settle
      // Eight pinned and one transient, each to the whole room: every page's bound.
      for (let i = 0; i < MAX_PINNED_PER_DEVICE; i++) {
        yield* world.board(MODULES[i % MODULES.length]).show({ room: "House" }, WORST(i), { lifetime: "pinned", expiresInMs: 3_600_000 }).pipe(Effect.provideService(CurrentTurn, turnOn(house[0]!.id)))
      }
      yield* world.board().show({ room: "House" }, WORST(99)).pipe(Effect.provideService(CurrentTurn, turnOn(house[0]!.id)))
      yield* world.settle
      // A fresh page on every device at once (the server restarted under open pages), reconciled together.
      const tabs = world.tabs as Map<string, { id: string; deviceId: string; messages: Array<unknown>; declares: boolean }>
      for (const [id] of [...tabs]) tabs.delete(id)
      world.present.reconcileAll()
      yield* world.settle
      for (const d of house) tabs.set(`fresh-${d.id}`, { id: `fresh-${d.id}`, deviceId: d.id, messages: [], declares: false })
      const before = frames.n
      const bytes = frames.bytes
      const all = yield* longestStop(Effect.andThen(Effect.sync(() => world.present.reconcileAll()), world.settle))
      const sent = frames.n - before
      console.log(
        `reconciling every device with fan-out: ${sent} frames (${((frames.bytes - bytes) / 1024 / 1024).toFixed(2)} MiB encoded) to 64 fresh pages; longest main-thread stop ${all.worst.toFixed(2)} ms`
      )
      expect(sent).toBe(64 * (MAX_PINNED_PER_DEVICE + 1))
      assert.isBelow(all.worst, bound(10))
    })), 240_000)
})
