// A backup's copy is made one file (journal mode DELETE) on a thread of its own: the change writes and syncs a journal
// and syncs the directory, which on the main thread stopped it for as long as the disk took (docs/STORING-DATA.md
// "Latency"). Here the step is made slow on purpose (`setBackupJournalHooks`), so where it runs shows on any disk.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection } from "@pva/core"
import { Effect, Schema } from "effect"
import { chmodSync, readdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"
import { setBackupJournalHooks } from "../src/testing.ts"
import { bound, latencyDir } from "./latencyBound.ts"

const items = defineCollection({ name: "items", scope: "household", schema: Schema.Struct({ text: Schema.String }) })

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
  const dir = latencyDir("pva-backup-journal")
  const store = yield* makeSqliteStore({ filename: join(dir, "household.db") })
  yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
  const c = store.forModule("shop").collection(items)
  for (let i = 0; i < 200; i++) yield* c.insert({ text: `row ${i} ${"x".repeat(500)}` })
  return { dir, store }
})

describe("a backup's copy is made one file on a thread of its own", () => {
  it.live("with that step made slow (300 ms), the main thread does not stop; the copy is one file in DELETE mode", () =>
    Effect.scoped(Effect.gen(function*() {
      const { store } = yield* open
      setBackupJournalHooks({ pauseMs: 300 })
      const t0 = performance.now()
      const { value: made, worst } = yield* longestStop(store.backup()).pipe(Effect.ensuring(Effect.sync(() => setBackupJournalHooks({ pauseMs: 0 }))))
      const took = performance.now() - t0
      console.log(`a backup whose journal conversion takes 300 ms: took ${took.toFixed(0)} ms, longest stop ${worst.toFixed(2)} ms`)
      assert.isAtLeast(took, 300, "the conversion's pause was part of the backup")
      assert.isBelow(worst, bound(10))
      const copy = new DatabaseSync(made.path, { readOnly: true })
      try {
        assert.strictEqual(copy.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete")
        assert.strictEqual(copy.prepare("SELECT count(*) AS n FROM pva_docs").get()?.n, 200)
      } finally {
        copy.close()
      }
    })), { timeout: 60_000 })

  it.live("a conversion that fails (the copy cannot be written) says SQLite's message, and leaves no temporary file behind", () =>
    Effect.scoped(Effect.gen(function*() {
      const { dir, store } = yield* open
      setBackupJournalHooks({ pauseMs: 0, before: (file) => chmodSync(file, 0o400) })
      const result = yield* Effect.result(store.backup()).pipe(Effect.ensuring(Effect.sync(() => setBackupJournalHooks({ pauseMs: 0 }))))
      assert.strictEqual(result._tag, "Failure")
      if (result._tag !== "Failure") return
      assert.strictEqual(result.failure.reason, "failed")
      assert.match(result.failure.message, /failed: disk I\/O error$/)
      assert.notInclude(result.failure.message, "Error:")
      assert.deepStrictEqual(readdirSync(join(dir, "backups")), [], "neither the copy nor its log, index or journal is left")
    })), { timeout: 60_000 })
})
