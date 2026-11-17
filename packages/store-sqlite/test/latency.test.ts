// The longest stretch the store holds the event loop (which also frames audio), on a large file: every read a turn can
// make is one bounded index read; backups and the checkpoint after a removal run beside turns
// without a long stop. The numbers are printed (docs/STORING-DATA.md "Latency" quotes them).
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, makeHouseholdFeed, MAX_MIGRATION_ROWS, type Row } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeSqliteStore } from "../src/index.ts"

const ROWS = 100_000
const Note = Schema.Struct({ state: Schema.String, due: Schema.Finite, text: Schema.String })
const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["state", "due"], project: (row: Row<typeof Note.Type>) => row.value })
const Note2 = Schema.Struct({ state: Schema.String, due: Schema.Finite, text: Schema.String, label: Schema.String })
const MODULE = [{ id: "big", storage: { collections: [notes] } }]

/** Fill the file directly (fast), in the store's own format. */
const fill = (file: string, rows = ROWS) => {
  const db = new DatabaseSync(file)
  const doc = db.prepare(`INSERT INTO pva_docs (module, collection, id, scope_kind, scope_id, rev, v, value, created_at, updated_at, updated_by)
    VALUES ('big', 'notes', ?, 'household', '', ?, 1, ?, ?, ?, '{"kind":"system","name":"fill"}')`)
  const filler = "lorem ipsum dolor sit amet ".repeat(36)
  db.exec("BEGIN")
  for (let i = 1; i <= rows; i++) {
    const text = `${i % 1000 === 0 ? "rarepasta " : ""}note ${i} milk ${filler}`
    const value = JSON.stringify({ state: i % 7 === 0 ? "running" : "done", due: i % 500, text })
    doc.run(`n${i}`, i, value, i, i)
  }
  db.prepare("UPDATE pva_meta SET value = ? WHERE key = 'rev'").run(String(rows))
  db.exec("COMMIT")
  db.close()
}

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

describe("SQLite store latency on 100,000 rows of ~1 KB", () => {
  it.live("turn reads are bounded index reads; long work never holds the event loop", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "pva-latency-"))
      const file = join(dir, "household.db")
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare(MODULE)
      }))
      fill(file)
      const store = yield* makeSqliteStore({ filename: file, scrubRetryMs: 20 })
      yield* store.prepare(MODULE)
      const c = store.forModule("big").collection(notes)
      const reads = {
        "list newest 20 (ambient)": c.list({ limit: 20 }),
        "list oldest 20": c.list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 20 }),
        "list where state = running": c.list({ where: { state: "running" }, limit: 20 }),
        "list ordered by due": c.list({ orderBy: { field: "due" }, limit: 20 }),
        "get by id": c.get("n54321")
      }
      const results: Array<string> = []
      let worstRead = 0
      for (const [name, read] of Object.entries(reads)) {
        let worst = 0
        for (let i = 0; i < 30; i++) {
          const t0 = performance.now()
          yield* (read as Effect.Effect<unknown, unknown>)
          worst = Math.max(worst, performance.now() - t0)
        }
        worstRead = Math.max(worstRead, worst)
        results.push(`${name}: worst ${worst.toFixed(2)} ms`)
      }
      const background: Record<string, Effect.Effect<unknown, unknown>> = {
        "backup (own connection, worker thread)": store.backup()
      }
      let worstBackground = 0
      for (const [name, work] of Object.entries(background)) {
        // A turn's read every few milliseconds meanwhile, as a busy household would.
        const { worst } = yield* longestStop(Effect.all([work, Effect.forEach(Array.from({ length: 50 }, (_, i) => i), () => Effect.andThen(Effect.sleep(2), c.list({ limit: 20 })), { discard: true })], { concurrency: "unbounded" }))
        worstBackground = Math.max(worstBackground, worst)
        results.push(`${name}: longest stop ${worst.toFixed(1)} ms`)
      }
      // Writes: one row each, one synchronous transaction each.
      let worstWrite = 0
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now()
        yield* c.update(`n${50_000 + i}`, (v) => ({ ...v, state: "running" }))
        worstWrite = Math.max(worstWrite, performance.now() - t0)
      }
      results.push(`update one row (its own transaction): worst ${worstWrite.toFixed(2)} ms`)
      // A removal and its checkpoint (on a worker thread), after a reader made the log grow: 2,000 updates of ~1 KB.
      const reader = new DatabaseSync(file, { readOnly: true })
      reader.exec("BEGIN")
      reader.prepare("SELECT count(*) FROM pva_docs").get()
      yield* store.forModule("big").transaction((tx) => {
        for (let i = 0; i < 2000; i++) tx.collection(notes).update(`n${i + 1000}`, (v) => ({ ...v, text: `${v.text} again` }))
      })
      reader.exec("COMMIT")
      reader.close()
      const removal = yield* longestStop(Effect.all([
        Effect.andThen(c.remove("n100"), store.scrubbed),
        Effect.forEach(Array.from({ length: 50 }, (_, i) => i), () => Effect.andThen(Effect.sleep(2), c.list({ limit: 20 })), { discard: true })
      ], { concurrency: "unbounded" }))
      results.push(`remove + checkpoint of a grown log, reads beside it: longest stop ${removal.worst.toFixed(1)} ms`)
      // A snapshot for a page: its longest step (one index read of 20 rows, projected, frames built).
      const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "big", collections: [notes], events: [] }] })
      const run = feed.snapshot({ id: "kitchen-01" })
      let worstStep = 0
      for (let done = false; !done;) {
        const t0 = performance.now()
        done = run.step().done
        worstStep = Math.max(worstStep, performance.now() - t0)
      }
      results.push(`snapshot step for a page (20 rows of ~1 KB): worst ${worstStep.toFixed(2)} ms`)
      console.log(`Household store latency (${ROWS} rows):\n  ${results.join("\n  ")}`)
      // Generous bounds for a shared, loaded runner; the printed numbers are the measurement.
      assert.isBelow(worstRead, 25)
      assert.isBelow(worstWrite, 25)
      assert.isBelow(worstStep, 25)
      assert.isBelow(worstBackground, 150)
      assert.isBelow(removal.worst, 150)
    }).pipe(Effect.scoped), { timeout: 240_000 })

  it.live("a collection migration at start: the most rows it takes (MAX_MIGRATION_ROWS of ~1 KB) in one transaction", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "pva-migration-"))
      const file = join(dir, "household.db")
      const v2 = defineCollection({ name: "notes", scope: "household", schema: Note2, version: 2, indexes: ["state", "due"], migrate: { 1: (v: typeof Note.Type) => ({ ...v, label: v.state }) } })
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare(MODULE)
      }))
      fill(file, MAX_MIGRATION_ROWS)
      const store = yield* makeSqliteStore({ filename: file })
      const { worst } = yield* longestStop(store.prepare([{ id: "big", storage: { collections: [v2] } }]))
      assert.strictEqual(store.availability("big"), undefined)
      assert.strictEqual((yield* store.forModule("big").collection(v2).get("n8"))?.value.label, "done")
      console.log(`Household store: migrating ${MAX_MIGRATION_ROWS} rows of ~1 KB at start (one transaction, after a backup): longest stop ${worst.toFixed(0)} ms`)
      assert.isBelow(worst, 10_000)
    }).pipe(Effect.scoped), { timeout: 240_000 })
})
