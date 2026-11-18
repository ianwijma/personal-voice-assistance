// The write-ahead log after a checkpoint (docs/STORING-DATA.md "The write-ahead log"): the checkpoint worker starts the
// new log itself, with one tiny write, so the header sync SQLite makes when a log starts again is the worker's and not
// the main thread's next commit. On a real disk (`latencyDir`): on tmpfs a sync costs nothing and this cannot show.
//
// Whether a commit started a new log is read from the log's header here too (its checkpoint sequence and salts change
// whenever a log starts again), independently of the worker's counters.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection } from "@pva/core"
import { Effect, Schema } from "effect"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { makeCheckpointer } from "../src/files.ts"
import { makeSqliteStore } from "../src/index.ts"
import { checkpointNow, type LogStarts, logStarts, nextLogStartPause, setLogStartPauses, workerSettings } from "../src/testing.ts"
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

/** The log header's checkpoint sequence and salts (they change whenever a log starts again); "" for an empty log. */
const logHeader = (file: string): string => {
  let fd: number
  try {
    fd = openSync(`${file}-wal`, "r")
  } catch {
    return ""
  }
  try {
    const b = Buffer.alloc(32)
    return readSync(fd, b, 0, 32, 0) < 32 ? "" : b.toString("hex", 12, 24)
  } finally {
    closeSync(fd)
  }
}
const walBytes = (file: string) => {
  try {
    return statSync(`${file}-wal`).size
  } catch {
    return 0
  }
}

/** The log starts since `before`. */
const since = (before: LogStarts, now: LogStarts): LogStarts => ({
  byWorker: now.byWorker - before.byWorker,
  byMainThread: now.byMainThread - before.byMainThread,
  appended: now.appended - before.appended,
  notStarted: now.notStarted - before.notStarted
})

const open = (options: { readonly scrubRetryMs?: number } = {}) =>
  Effect.gen(function*() {
    const file = join(latencyDir("pva-log-start"), "household.db")
    const store = yield* makeSqliteStore({ filename: file, checkpointEveryMs: 3_600_000, ...options })
    yield* store.prepare(MODULE)
    return { file, store, c: store.forModule("logs").collection(items) }
  })

describe("the checkpoint worker starts the new log", () => {
  it.live("after each removal's checkpoint, the next main-thread commit does not sync the log", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, c } = yield* open()
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
      console.log(`one-row commit right after a removal's checkpoint, ${ROUNDS} rounds: worst ${worst.toFixed(2)} ms, median ${[...commits].sort((a, b) => a - b)[ROUNDS >> 1]!.toFixed(2)} ms; log starts ${JSON.stringify(logStarts(store))}`)
      assert.isBelow(worst, bound(10))
      assert.deepStrictEqual(logStarts(store), { byWorker: ROUNDS + 1, byMainThread: 0, appended: 0, notStarted: 0 }, "every checkpoint's log (and the start's) was started by the worker")
      for (const [i, id] of written.entries()) assert.deepStrictEqual((yield* c.get(id))?.value, { text: `after ${i}` })
    })), { timeout: 60_000 })

  it.live("the window after a truncating checkpoint: a main-thread commit before the worker's write starts the log itself, succeeds, and is counted", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, c } = yield* open()
      const kept = yield* c.insert({ text: "kept" })
      const gone = yield* c.insert({ text: "to remove" })
      const before = logStarts(store)
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 300, holdMs: 0 }))
      const inWindow = nextLogStartPause(store, "gapMs")
      yield* c.remove(gone.id)
      yield* Effect.promise(() => inWindow)
      // The checkpoint has completed; the worker has not started the new log: this commit does.
      const forced = yield* c.insert({ text: "in the window" })
      yield* store.scrubbed
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 0, holdMs: 0 }))
      assert.deepStrictEqual(since(before, logStarts(store)), { byWorker: 0, byMainThread: 1, appended: 0, notStarted: 0 })
      // Consistent: everything committed is there, the removed row is not, and the file checks.
      assert.deepStrictEqual((yield* c.get(forced.id))?.value, { text: "in the window" })
      assert.deepStrictEqual((yield* c.get(kept.id))?.value, { text: "kept" })
      assert.isUndefined(yield* c.get(gone.id))
      const after = yield* c.insert({ text: "after the window" })
      assert.deepStrictEqual((yield* c.get(after.id))?.value, { text: "after the window" })
      assert.strictEqual(yield* store.check, "ok")
    })), { timeout: 60_000 })

  it.live("the window after a passive checkpoint: a main-thread commit that starts the log is counted as the main thread's, not the worker's", () =>
    Effect.scoped(Effect.gen(function*() {
      const { file, store, c } = yield* open()
      for (let i = 0; i < 5; i++) yield* c.insert({ text: `row ${i}` })
      const before = logStarts(store)
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 300, holdMs: 0 }))
      const inWindow = nextLogStartPause(store, "gapMs")
      const checkpoint = checkpointNow(store, "passive")
      yield* Effect.promise(() => inWindow)
      // Every frame was copied: this commit starts the log again (the header changes).
      const header = logHeader(file)
      yield* c.insert({ text: "in the window" })
      assert.notStrictEqual(logHeader(file), header, "the main thread's commit started a new log")
      assert.isTrue(yield* Effect.promise(() => checkpoint))
      yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 0, holdMs: 0 }))
      assert.deepStrictEqual(since(before, logStarts(store)), { byWorker: 0, byMainThread: 1, appended: 0, notStarted: 0 })
      assert.strictEqual(yield* store.check, "ok")
    })), { timeout: 60_000 })

  it.live("a truncation a reader blocks after everything was copied: the worker still starts the log; the truncation is still not done", () =>
    Effect.scoped(Effect.gen(function*() {
      const { file, store, c } = yield* open()
      for (let i = 0; i < 5; i++) yield* c.insert({ text: `row ${i}` })
      // A reader at the newest snapshot (a backup, a command-line mode): every frame can be copied, the log not emptied.
      const reader = new DatabaseSync(file, { readOnly: true })
      reader.exec("BEGIN")
      reader.prepare("SELECT count(*) FROM pva_docs").get()
      const before = logStarts(store)
      const done = yield* Effect.promise(() => checkpointNow(store, "truncate"))
      reader.exec("COMMIT")
      reader.close()
      assert.isFalse(done, "the truncation is reported as not done (it is retried; a log start acknowledges no removal)")
      const counted = since(before, logStarts(store))
      assert.strictEqual(counted.byMainThread + counted.notStarted, 0, JSON.stringify(counted))
      assert.strictEqual(counted.byWorker + counted.appended, 1, JSON.stringify(counted))
      // The reader has gone: the next main-thread commit does not start a new log (it would sync it).
      const header = logHeader(file)
      const t0 = performance.now()
      yield* c.insert({ text: "after the reader" })
      const ms = performance.now() - t0
      assert.strictEqual(logHeader(file), header, "the main thread's commit did not start a new log")
      assert.isBelow(ms, bound(10))
      assert.isTrue(yield* Effect.promise(() => checkpointNow(store, "truncate")), "a truncation without the reader is done")
      assert.strictEqual(yield* store.check, "ok")
    })), { timeout: 60_000 })

  for (const how of ["commits having written nothing", "rolls back"] as const) {
    it.live(`a log start that finds the lock taken by a transaction that ${how}: the worker tries again and starts the log; nothing is counted until it did`, () =>
      Effect.scoped(Effect.gen(function*() {
        const { file, store, c } = yield* open()
        yield* c.insert({ text: "kept" })
        const other = new DatabaseSync(file)
        other.exec("PRAGMA busy_timeout = 0")
        const before = logStarts(store)
        yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 150, holdMs: 0 }))
        const inWindow = nextLogStartPause(store, "gapMs")
        const checkpoint = checkpointNow(store, "truncate")
        yield* Effect.promise(() => inWindow)
        other.exec("BEGIN IMMEDIATE")
        if (how === "rolls back") other.exec("INSERT INTO pva_meta (key, value) VALUES ('probe', 'x')")
        // The worker's first try comes when its 150 ms pause ends: the lock is still held then; it is let go at 250 ms.
        yield* Effect.sleep(250)
        other.exec(how === "rolls back" ? "ROLLBACK" : "COMMIT")
        assert.isTrue(yield* Effect.promise(() => checkpoint))
        yield* Effect.promise(() => setLogStartPauses(store, { gapMs: 0, holdMs: 0 }))
        other.close()
        assert.deepStrictEqual(since(before, logStarts(store)), { byWorker: 1, byMainThread: 0, appended: 0, notStarted: 0 })
        const header = logHeader(file)
        assert.notStrictEqual(header, "", "the worker started the log")
        yield* c.insert({ text: "next" })
        assert.strictEqual(logHeader(file), header, "the main thread's next commit did not start a new log")
        assert.strictEqual(yield* store.check, "ok")
      })), { timeout: 60_000 })
  }

  it.live("the worker's connection has the main connection's settings, but full synchronisation; no automatic checkpoint of its own", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store } = yield* open()
      assert.deepStrictEqual(yield* Effect.promise(() => workerSettings(store)), {
        busy_timeout: 0,
        wal_autocheckpoint: 0,
        journal_size_limit: 4 * 1024 * 1024,
        secure_delete: 1,
        trusted_schema: 0,
        synchronous: 2
      })
    })), { timeout: 60_000 })

  it.live("closing: the worker's last checkpoint leaves the log empty, so the main connection's close has nothing to copy or sync", () =>
    Effect.promise(async () => {
      const file = join(latencyDir("pva-log-close"), "close.db")
      const main = new DatabaseSync(file)
      const cp = makeCheckpointer(file)
      try {
        main.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 0")
        main.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b'), ('c')")
        assert.isTrue(await cp.truncate())
        assert.strictEqual(cp.logStarts().byWorker, 1)
        assert.isAbove(walBytes(file), 0, "the worker started a new log")
        await cp.close()
        assert.strictEqual(walBytes(file), 0, "after the worker's close the log is empty")
      } finally {
        await cp.close()
        main.close()
      }
    }), { timeout: 60_000 })

  it.live("a main-thread write while the worker holds the lock for the new log waits on a timer: the main thread does not stop", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store, c } = yield* open()
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
