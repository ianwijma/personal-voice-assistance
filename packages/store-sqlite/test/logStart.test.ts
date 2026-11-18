// The write-ahead log after a checkpoint (docs/STORING-DATA.md "The write-ahead log"): the checkpoint worker starts the
// new log itself, with one tiny write, so the header sync SQLite makes when a log starts again is the worker's and not
// the main thread's next commit. On a real disk (`latencyDir`): on tmpfs a sync costs nothing and this cannot show.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection } from "@pva/core"
import { Effect, Schema } from "effect"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"
import { logStarts, nextLogStartPause, setLogStartPauses } from "../src/testing.ts"
import { bound, latencyDir } from "./latencyBound.ts"

const items = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ text: Schema.String }) })
const MODULE = [{ id: "logs", storage: { collections: [items] } }]

/** The longest gap between ticks of a 1 ms timer while `effect` runs (what audio framing would see). */
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

const open = Effect.gen(function*() {
  const store = yield* makeSqliteStore({ filename: join(latencyDir("pva-log-start"), "household.db") })
  yield* store.prepare(MODULE)
  return { store, c: store.forModule("logs").collection(items) }
})

describe("the checkpoint worker starts the new log", () => {
  it.live("after each removal's checkpoint, the next main-thread commit does not sync the log", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, c } = yield* open
      yield* c.insert({ text: "kept" })
      const ROUNDS = 40
      const commits: Array<number> = []
      const written: Array<string> = []
      for (let i = 0; i < ROUNDS; i++) {
        const gone = yield* c.insert({ text: `to remove ${i}` })
        yield* c.remove(gone.id)
        // The truncating checkpoint after the removal, and the worker's start of the new log, have completed.
        yield* store.scrubbed
        const t0 = performance.now()
        written.push((yield* c.insert({ text: `after ${i}` })).id)
        commits.push(performance.now() - t0)
      }
      const worst = Math.max(...commits)
      console.log(`one-row commit right after a removal's checkpoint, ${ROUNDS} rounds: worst ${worst.toFixed(2)} ms, median ${[...commits].sort((a, b) => a - b)[ROUNDS >> 1]!.toFixed(2)} ms; logs started by the worker ${logStarts(store).byWorker}, by the main thread ${logStarts(store).byMainThread}`)
      assert.isBelow(worst, bound(10))
      assert.strictEqual(logStarts(store).byWorker, ROUNDS + 1, "every checkpoint's log (and the start's) was started by the worker")
      assert.strictEqual(logStarts(store).byMainThread, 0)
      for (const [i, id] of written.entries()) assert.deepStrictEqual((yield* c.get(id))?.value, { text: `after ${i}` })
    })), { timeout: 60_000 })

  it.live("the window: a main-thread commit between the checkpoint and the worker's write starts the log itself, succeeds, and is counted", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, c } = yield* open
      const kept = yield* c.insert({ text: "kept" })
      const gone = yield* c.insert({ text: "to remove" })
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 300, holdMs: 0 }))
      const inWindow = nextLogStartPause(store, "gapMs")
      yield* c.remove(gone.id)
      yield* Effect.promise(() => inWindow)
      // The checkpoint has completed; the worker has not started the new log: this commit does.
      const forced = yield* c.insert({ text: "in the window" })
      yield* store.scrubbed
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 0, holdMs: 0 }))
      assert.deepStrictEqual(logStarts(store), { byWorker: 1, byMainThread: 1, failed: 0 })
      // Consistent: everything committed is there, the removed row is not, and the file checks.
      assert.deepStrictEqual((yield* c.get(forced.id))?.value, { text: "in the window" })
      assert.deepStrictEqual((yield* c.get(kept.id))?.value, { text: "kept" })
      assert.isUndefined(yield* c.get(gone.id))
      const after = yield* c.insert({ text: "after the window" })
      assert.strictEqual((yield* c.list({ limit: 10 })).length, 3)
      assert.deepStrictEqual((yield* c.get(after.id))?.value, { text: "after the window" })
      assert.strictEqual(yield* store.check, "ok")
    })), { timeout: 60_000 })

  it.live("a main-thread write while the worker holds the lock for the new log waits on a timer: the main thread does not stop", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, c } = yield* open
      const gone = yield* c.insert({ text: "to remove" })
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 0, holdMs: 300 }))
      const holding = nextLogStartPause(store, "holdMs")
      yield* c.remove(gone.id)
      yield* Effect.promise(() => holding)
      // The worker holds the write lock (300 ms) for its write: this insert finds the store busy and tries again.
      const t0 = performance.now()
      const { value: row, worst } = yield* longestStop(c.insert({ text: "behind the worker" }))
      const waited = performance.now() - t0
      yield* store.scrubbed
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 0, holdMs: 0 }))
      console.log(`a write behind the worker's lock: waited ${waited.toFixed(0)} ms, longest stop ${worst.toFixed(2)} ms`)
      assert.isAbove(waited, 100, "it did wait for the worker")
      assert.isBelow(worst, bound(10))
      assert.deepStrictEqual((yield* c.get(row.id))?.value, { text: "behind the worker" })
      assert.strictEqual(logStarts(store).byMainThread, 0)
    })), { timeout: 60_000 })
})
