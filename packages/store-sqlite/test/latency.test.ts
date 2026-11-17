// The longest stretch the store holds the event loop (which also frames audio), on a large file: every read a turn can
// make is one bounded index read; backups, exports, pruning and the checkpoint after an erase run beside turns
// without a long stop. The numbers are printed (docs/STORING-DATA.md "Latency" quotes them).
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, searchTokens } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeSqliteStore, scopeToken } from "../src/index.ts"

const ROWS = 100_000
const Note = Schema.Struct({ state: Schema.String, due: Schema.Finite, text: Schema.String })
const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["state", "due"], search: ["text"] })
const MODULE = [{ id: "big", storage: { collections: [notes] } }]

/** Fill the file directly (fast), in the store's own format. */
const fill = (file: string) => {
  const db = new DatabaseSync(file)
  const k = scopeToken("big", "notes", { kind: "household" })
  const doc = db.prepare(`INSERT INTO pva_docs (module, collection, id, scope_kind, scope_id, rev, v, value, created_at, updated_at, updated_by, search_id)
    VALUES ('big', 'notes', ?, 'household', '', ?, 1, ?, ?, ?, '{"kind":"system","name":"fill"}', ?)`)
  const fts = db.prepare("INSERT INTO pva_search (rowid, k, t) VALUES (?, ?, ?)")
  const change = db.prepare(`INSERT INTO pva_changes (op_id, module, collection, scope_kind, scope_id, row_id, op, actor, actor_key, at, data)
    VALUES (?, 'big', 'notes', 'household', '', ?, 'insert', '{"kind":"system","name":"fill"}', 'system:fill', ?, ?)`)
  const filler = "lorem ipsum dolor sit amet ".repeat(36)
  db.exec("BEGIN")
  for (let i = 1; i <= ROWS; i++) {
    const text = `${i % 1000 === 0 ? "rarepasta " : ""}note ${i} milk ${filler}`
    const value = JSON.stringify({ state: i % 7 === 0 ? "running" : "done", due: i % 500, text })
    change.run(`op-${i}`, `n${i}`, 1, JSON.stringify({ v: 1, after: JSON.parse(value) }))
    doc.run(`n${i}`, i, value, i, i, i)
    fts.run(i, k, searchTokens(text).join(" "))
  }
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
        "get by id": c.get("n54321"),
        "search a common word": c.search("milk"),
        "search a rare word": c.search("rarepasta"),
        "search a short prefix": c.search("no")
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
        "backup (own connection, worker thread)": store.backup(),
        "export of the module (own connection, pages of 500)": store.exportModule("big"),
        "prune 100,000 changes (100 per transaction)": store.pruneChanges({ now: 91 * 86_400_000 })
      }
      let worstBackground = 0
      for (const [name, work] of Object.entries(background)) {
        // A turn's read every few milliseconds meanwhile, as a busy household would.
        const { worst } = yield* longestStop(Effect.all([work, Effect.forEach(Array.from({ length: 50 }, (_, i) => i), () => Effect.andThen(Effect.sleep(2), c.list({ limit: 20 })), { discard: true })], { concurrency: "unbounded" }))
        worstBackground = Math.max(worstBackground, worst)
        results.push(`${name}: longest stop ${worst.toFixed(1)} ms`)
      }
      // An erase and its checkpoint (the log holds the pruning's pages).
      const erase = yield* longestStop(Effect.andThen(c.erase("n100"), store.scrubbed))
      results.push(`erase + checkpoint: longest stop ${erase.worst.toFixed(1)} ms`)
      console.log(`Household store latency (${ROWS} rows):\n  ${results.join("\n  ")}`)
      // Generous bounds for a shared, loaded runner; the printed numbers are the measurement.
      assert.isBelow(worstRead, 25)
      assert.isBelow(worstBackground, 150)
    }).pipe(Effect.scoped), { timeout: 240_000 })
})
