// Ambient facts (docs/STORING-DATA.md "Ambient facts"): the household context provider on a real SQLite file, inside
// its 50 ms budget and 600 characters, and what it costs a turn, measured with TurnTrace with it on and off.
import { assert, describe, it } from "@effect/vitest"
import {
  ambientLines,
  type AmbientMode,
  Conversation,
  type ConversationEvent,
  CurrentTurn,
  defineCollection,
  makeAmbientFacts,
  makeToolRegistry,
  MAX_AMBIENT_ROWS,
  maxListRows,
  type Row,
  type Trace,
  TurnTrace,
  withContextProvider
} from "@pva/core"
import { endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, speechStarted, textDelta } from "@pva/core/testing"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"
import { bound, latencyDir } from "./latencyBound.ts"

const Timer = Schema.Struct({ label: Schema.String, dueAt: Schema.Finite })
const fmt = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`
const timers = defineCollection({
  name: "timers",
  scope: "household",
  schema: Timer,
  ambient: (rows: ReadonlyArray<Row<typeof Timer.Type>>, { now }) => [`Timers: ${rows.map((r) => `${r.value.label} ${fmt(Math.max(0, r.value.dueAt - now))} left`).join(", ")}.`]
})
const pinned = defineCollection({
  name: "pinned",
  scope: "device",
  schema: Schema.Struct({ list: Schema.String }),
  ambient: (rows: ReadonlyArray<Row<{ readonly list: string }>>) => rows.map((r) => `This screen shows the ${r.value.list} list.`)
})

const TURNS = 150
const median = (xs: ReadonlyArray<number>) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}
const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!

const household = Effect.gen(function*() {
  const store = yield* makeSqliteStore({ filename: join(latencyDir("pva-ambient"), "household.db") })
  yield* store.prepare([{ id: "timers", storage: { collections: [timers, pinned] } }])
  const m = store.forModule("timers")
  // Plenty of rows: the ambient read takes the newest 20 per scope.
  for (let i = 0; i < 200; i++) yield* m.collection(timers).insert({ label: `timer ${i}`, dueAt: Date.now() + i * 60_000 })
  yield* m.collection(pinned).insert({ list: "shopping" }, { scope: { kind: "device", id: "kitchen-01" } })
  return store
})

describe("ambient facts", () => {
  it.live("inside the budget: under 50 ms, at most 600 characters, the turn's device included", () =>
    Effect.gen(function*() {
      const store = yield* household
      const options = { store, modules: [{ moduleId: "timers", collections: [timers, pinned] }], mode: (): AmbientMode => "all" }
      const turn = { turnId: 1, conversationId: "c", source: "voice" as const, deviceId: "kitchen-01", assistantId: "jev" }
      const times: Array<number> = []
      let text = ""
      for (let i = 0; i < 200; i++) {
        const t0 = performance.now()
        text = yield* ambientLines(options).pipe(Effect.provideService(CurrentTurn, turn))
        times.push(performance.now() - t0)
      }
      console.log(`ambient facts on SQLite (200 timers, 1 pinned list): median ${median(times.slice(20)).toFixed(3)} ms, p95 ${p95(times.slice(20)).toFixed(3)} ms, worst ${Math.max(...times.slice(20)).toFixed(3)} ms, ${text.length} characters`)
      assert.isAtMost(text.length, 600)
      assert.isBelow(p95(times.slice(20)), bound(50))
      assert.include(text, "This screen shows the shopping list.")
      // Another device does not get this device's line; "module-on" leaves out modules the assistant has off.
      const elsewhere = yield* ambientLines(options).pipe(Effect.provideService(CurrentTurn, { ...turn, deviceId: "study-001" }))
      assert.notInclude(elsewhere, "shopping")
      const off = yield* ambientLines({ ...options, mode: () => "module-on", moduleOn: () => false }).pipe(Effect.provideService(CurrentTurn, turn))
      assert.strictEqual(off, "")
      assert.strictEqual(yield* ambientLines({ ...options, mode: () => "off" }), "")
    }).pipe(Effect.scoped), 60_000)

  it.live("many full ambient collections (two modules of 64, each the most rows an ambient read takes at maxChars 2,000): the event loop is held for one collection's reads at a time, under 10 ms, never for the batch", () =>
    Effect.gen(function*() {
      const Numbers = Schema.Struct({ values: Schema.Array(Schema.Finite) })
      const empty = JSON.stringify({ values: [] }).length
      // Exactly 2,000 characters of JSON: 999 zeros and their commas, plus the frame.
      const value = { values: Array.from({ length: (2_000 - empty + 1) / 2 }, () => 0) }
      assert.strictEqual(JSON.stringify(value).length, 2_000)
      // The most rows a list of values of 2,000 characters may ask for: the largest legal ambientRows there.
      const rows = Math.min(MAX_AMBIENT_ROWS, maxListRows({ maxChars: 2_000 }))
      const modules = ["first", "second"].map((moduleId) => ({
        moduleId,
        collections: Array.from({ length: 64 }, (_, i) =>
          defineCollection({
            name: `c${i}`,
            scope: "household",
            schema: Numbers,
            maxChars: 2_000,
            ambientRows: rows,
            // Nothing in the rows merits a fact this turn: no line stops the reading early.
            ambient: () => undefined
          }))
      }))
      const store = yield* makeSqliteStore({ filename: join(latencyDir("pva-ambient-many"), "household.db") })
      yield* store.prepare(modules.map((m) => ({ id: m.moduleId, storage: { collections: m.collections } })))
      for (const m of modules) {
        yield* store.forModule(m.moduleId).transaction((tx) => {
          for (const c of m.collections) for (let i = 0; i < rows; i++) tx.collection(c).insert(value)
        })
      }
      const turn = { turnId: 1, conversationId: "c", source: "voice" as const, deviceId: "kitchen-01", assistantId: "jev" }
      const options = { store, modules, mode: (): AmbientMode => "all" }
      let worst = 0
      let longestRun = 0
      for (let run = 0; run < 10; run++) {
        let last = performance.now()
        let stop = 0
        const timer = setInterval(() => {
          const now = performance.now()
          stop = Math.max(stop, now - last)
          last = now
        }, 1)
        const t0 = performance.now()
        yield* ambientLines(options).pipe(Effect.provideService(CurrentTurn, turn))
        longestRun = Math.max(longestRun, performance.now() - t0)
        clearInterval(timer)
        worst = Math.max(worst, stop, performance.now() - last)
      }
      console.log(`ambient facts, 2 × 64 collections of ${rows} rows of 2,000 characters: longest event-loop stop ${worst.toFixed(2)} ms (each run ${longestRun.toFixed(1)} ms at most, within its 50 ms budget plus one collection)`)
      assert.isBelow(worst, bound(10))
    }).pipe(Effect.scoped), 120_000)

  it.live("TurnTrace: end of turn → request sent and → playback start, ambient facts on and off", () =>
    Effect.gen(function*() {
      const store = yield* household
      const measure = (mode: AmbientMode) =>
        Effect.gen(function*() {
          const ambient = makeAmbientFacts({ store, modules: [{ moduleId: "timers", collections: [timers, pinned] }], mode: () => mode })
          const registry = withContextProvider(makeToolRegistry([]), ambient)
          const ended = yield* Queue.unbounded<Trace>()
          const onEvent = (e: ConversationEvent) => {
            if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
          }
          const sent: Array<number> = []
          const audible: Array<number> = []
          const events = Stream.range(1, TURNS).pipe(
            Stream.flatMap((i) =>
              Stream.make(speechStarted, endOfTurn(`How long is left on timer ${i}?`)).pipe(Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
                const t = yield* Queue.take(ended)
                sent.push(t.marks.llmRequestSent! - t.marks.endOfTurn!)
                audible.push(t.marks.playbackStart! - t.marks.endOfTurn!)
              })))), { concurrency: 1 })
          )
          const layer = Conversation.layerWithSetup({
            onEvent,
            setup: Effect.succeed({ system: "Benchmark.", registry, turnContext: { deviceId: "kitchen-01", assistantId: "jev" } })
          }).pipe(Layer.provideMerge(Layer.mergeAll(makeScriptedLlm(() => [textDelta("About four minutes.")]).layer, TurnTrace.layer())))
          yield* Effect.gen(function*() {
            const c = yield* Conversation
            yield* c.voice(events)
          }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
          return { sent: median(sent.slice(20)), sentP95: p95(sent.slice(20)), audible: median(audible.slice(20)) }
        })
      const off: Array<{ sent: number; sentP95: number; audible: number }> = []
      const on: Array<{ sent: number; sentP95: number; audible: number }> = []
      for (let i = 0; i < 3; i++) {
        off.push(yield* measure("off"))
        on.push(yield* measure("all"))
      }
      const m = (xs: ReadonlyArray<{ sent: number; sentP95: number; audible: number }>, k: "sent" | "sentP95" | "audible") => median(xs.map((x) => x[k]))
      console.log(
        `TurnTrace, zero-delay fakes, median of ${TURNS - 20} turns x 3 runs: end of turn -> llmRequestSent ` +
          `off ${m(off, "sent").toFixed(3)} ms (p95 ${m(off, "sentP95").toFixed(3)}), on ${m(on, "sent").toFixed(3)} ms (p95 ${m(on, "sentP95").toFixed(3)}); ` +
          `end of turn -> playbackStart off ${m(off, "audible").toFixed(3)} ms, on ${m(on, "audible").toFixed(3)} ms`
      )
      // The provider reads a few indexed rows: well inside its budget, and a small part of a turn.
      assert.isBelow(m(on, "sent"), m(off, "sent") + 5)
    }).pipe(Effect.scoped), 120_000)
})
