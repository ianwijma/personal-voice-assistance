// The longest stretch the store holds the event loop (which also frames audio), on a large file: every read a turn can
// make is one bounded index read (the worst legal `list` of structured values is in listLatency.test.ts); the main
// connection never checkpoints, also when a reader let the log grow and then let go; backups, checkpoints and the removal of an ended conversation (its steps at the legal
// maximum: the largest values, eight indexes, secure deletion) run beside turns without a long stop. The numbers are
// printed (docs/STORING-DATA.md "Latency" quotes them).
import { assert, describe, it } from "@effect/vitest"
import {
  BULK_STEP_ROWS,
  type Collection,
  CurrentTurn,
  DEFAULT_MAX_CHARS,
  defineCollection,
  type HouseholdStore,
  LIST_BUDGET_CHARS,
  makeHouseholdFeed,
  MAX_INDEXED_CHARS,
  MAX_INDEXES,
  MAX_LIST_LIMIT,
  MAX_MIGRATION_ROWS,
  MAX_VALUE_CHARS,
  maxListRows,
  type Row
} from "@pva/core"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import { Effect, Schema } from "effect"
import { statSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeSqliteStore } from "../src/index.ts"
import { bound, latencyDir } from "./latencyBound.ts"

const ROWS = 100_000
const Note = Schema.Struct({ state: Schema.String, due: Schema.Finite, text: Schema.String })
// Rows of about 1 KB (maxChars 1,200): a list reads at most maxListRows(notes) = LIST_BUDGET_CHARS / 1,200 of them.
const notes = defineCollection({ name: "notes", scope: "household", schema: Note, indexes: ["state", "due", ["state", "due"]], maxChars: 1_200, project: (row: Row<typeof Note.Type>) => row.value })
const chat = defineCollection({ name: "chat", scope: "conversation", schema: Schema.Struct({ text: Schema.String }) })
const MODULE = [{ id: "big", storage: { collections: [notes, chat] } }]

/**
 * A conversation-scoped collection at the legal maximum for a bulk removal: the largest values, eight indexed fields
 * (sixteen indexes) of strings at the indexed limit.
 */
const wideFields = Array.from({ length: MAX_INDEXES }, (_, i) => `f${i}`)
const WideChat = Schema.Struct({ ...Object.fromEntries(wideFields.map((f) => [f, Schema.String])), text: Schema.String })
const wideChat = defineCollection({ name: "wide_chat", scope: "conversation", schema: WideChat, indexes: wideFields, maxChars: MAX_VALUE_CHARS }) as unknown as Collection<Record<string, string>>
const wideChatValue = (i: number): Record<string, string> => {
  const fields = Object.fromEntries(wideFields.map((f, k) => [f, `${i}.${k}.`.padEnd(MAX_INDEXED_CHARS, "abcdefghij")]))
  const base = JSON.stringify({ ...fields, text: "" }).length
  return { ...fields, text: "t".repeat(MAX_VALUE_CHARS - base) }
}

/** Fill the file directly (fast), in the store's own format (index keys in k0, k1: the fields state, due). */
const fill = (file: string, rows = ROWS) => {
  const db = new DatabaseSync(file)
  const doc = db.prepare(`INSERT INTO pva_docs (owner, collection, id, scope_kind, scope_id, rev, value, created_at, updated_at, updated_by, k0, k1)
    VALUES ('big', 'notes', ?, 'household', '', ?, ?, ?, ?, '{"kind":"system","name":"fill"}', ?, ?)`)
  const filler = "lorem ipsum dolor sit amet ".repeat(36)
  db.exec("BEGIN")
  for (let i = 1; i <= rows; i++) {
    const state = i % 7 === 0 ? "running" : "done"
    const value = JSON.stringify({ state, due: i % 500, text: `note ${i} milk ${filler}` })
    doc.run(`n${i}`, i, value, i, i, state, i % 500)
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

/** The worst of `n` calls (the first included: `prepare` warms what a first read would otherwise compile). */
const worstOf = (n: number, effect: Effect.Effect<unknown, unknown>) =>
  Effect.gen(function*() {
    let worst = 0
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      yield* effect
      worst = Math.max(worst, performance.now() - t0)
    }
    return worst
  })

describe("SQLite store latency on 100,000 rows of ~1 KB", () => {
  it.live("turn reads are bounded index reads, the worst legal one under 10 ms; the main connection never checkpoints; long work never holds the event loop", () =>
    Effect.gen(function*() {
      const dir = latencyDir("pva-latency")
      const file = join(dir, "household.db")
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare(MODULE)
      }))
      fill(file)
      const store = yield* makeSqliteStore({ filename: file, scrubRetryMs: 20 })
      yield* store.prepare(MODULE)
      const c = store.forModule("big").collection(notes)
      const most = maxListRows(notes)
      const reads = {
        [`list newest ${notes.ambientRows} (ambient)`]: c.list({ limit: notes.ambientRows }),
        [`list newest ${most} (the most a list of these rows asks for)`]: c.list({ limit: most }),
        [`list oldest ${most}`]: c.list({ orderBy: { field: "createdAt", direction: "asc" }, limit: most }),
        [`list where state = running, ${most}`]: c.list({ where: { state: "running" }, limit: most }),
        [`list ordered by due, ${most}`]: c.list({ orderBy: { field: "due" }, limit: most }),
        [`list where state = running ordered by due (a pair index), ${most}`]: c.list({ where: { state: "running" }, orderBy: { field: "due" }, limit: most }),
        "get by id": c.get("n54321")
      }
      const results: Array<string> = []
      let worstRead = 0
      for (const [name, read] of Object.entries(reads)) {
        const worst = yield* worstOf(30, read as Effect.Effect<unknown, unknown>)
        worstRead = Math.max(worstRead, worst)
        results.push(`${name}: worst ${worst.toFixed(2)} ms`)
      }
      // Writes: one row each, one synchronous transaction each.
      const worstWrite = yield* worstOf(30, Effect.suspend(() => c.update(`n${50_000 + Math.floor(Math.random() * 1000)}`, (v) => ({ ...v, state: "running" }))))
      results.push(`update one row (its own transaction): worst ${worstWrite.toFixed(2)} ms`)
      // Background work is bounded by the main thread's longest stop while it runs (a heartbeat, with a turn's read every
      // 2 ms beside it), not by how long the work takes: that is the disk's (and on a busy or slow disk far longer,
      // with nothing wrong). What it must not do is stop the main thread.
      const background: Record<string, Effect.Effect<unknown, unknown>> = { "backup (own connection, worker thread)": store.backup() }
      let worstBackground = 0
      for (const [name, work] of Object.entries(background)) {
        const { worst } = yield* longestStop(Effect.all([work, Effect.forEach(Array.from({ length: 50 }, (_, i) => i), () => Effect.andThen(Effect.sleep(2), c.list({ limit: 20 })), { discard: true })], { concurrency: "unbounded" }))
        worstBackground = Math.max(worstBackground, worst)
        results.push(`${name}: longest stop ${worst.toFixed(1)} ms`)
      }
      // A reader holds an old snapshot while tens of MB of log accumulate, then lets go: the next one-row write must not
      // pay for a checkpoint (the main connection makes none).
      const reader = new DatabaseSync(file, { readOnly: true })
      reader.exec("BEGIN")
      reader.prepare("SELECT count(*) FROM pva_docs").get()
      for (let k = 0; k < 4; k++) {
        yield* store.forModule("big").transaction((tx) => {
          for (let i = 0; i < 2000; i++) tx.collection(notes).update(`n${1000 + ((k * 2000 + i) % 90_000)}`, (v) => ({ ...v, text: `${v.text.slice(0, 900)} ${k}` }))
        })
      }
      const wal = statSync(`${file}-wal`).size
      reader.exec("COMMIT")
      reader.close()
      const t0 = performance.now()
      yield* c.update("n7", (v) => ({ ...v, state: "done" }))
      const afterRelease = performance.now() - t0
      results.push(`one-row write right after a reader let go of a ${(wal / 1024 / 1024).toFixed(0)} MB log: ${afterRelease.toFixed(2)} ms`)
      // A removal and its checkpoint (on the worker thread), the log grown as above, reads beside it.
      const removal = yield* longestStop(Effect.all([
        Effect.andThen(c.remove("n100"), store.scrubbed),
        Effect.forEach(Array.from({ length: 50 }, (_, i) => i), () => Effect.andThen(Effect.sleep(2), c.list({ limit: 20 })), { discard: true })
      ], { concurrency: "unbounded" }))
      results.push(`remove + truncating checkpoint of that log (worker thread), reads beside it: longest stop ${removal.worst.toFixed(1)} ms`)
      // An ended conversation of 3,000 rows of ~1 KB: removed in bounded steps beside a timer.
      const turn = { turnId: 1, conversationId: "conv-big", source: "voice" as const }
      for (let k = 0; k < 30; k++) {
        yield* store.forModule("big").transaction((tx) => {
          for (let i = 0; i < 100; i++) tx.collection(chat).insert({ text: "c".repeat(1000) })
        }).pipe(Effect.provideService(CurrentTurn, turn))
      }
      const ended = yield* longestStop(store.endConversation("conv-big"))
      assert.strictEqual(ended.value, 3000)
      results.push(`end a conversation of 3,000 rows of ~1 KB (steps of ${BULK_STEP_ROWS}): longest stop ${ended.worst.toFixed(1)} ms`)
      // A snapshot for a page: its longest step (one index read of 20 rows, projected, frames built).
      const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "big", collections: [notes], events: [] }] })
      const run = feed.snapshot({ id: "kitchen-01" })
      let worstStep = 0
      for (let done = false; !done;) {
        const s0 = performance.now()
        done = run.step().done
        worstStep = Math.max(worstStep, performance.now() - s0)
      }
      results.push(`snapshot step for a page (20 rows of ~1 KB): worst ${worstStep.toFixed(2)} ms`)
      console.log(`Household store latency (${ROWS} rows):\n  ${results.join("\n  ")}`)
      // The stated bound for turn reads; generous bounds elsewhere for a loaded machine (`bound`: more on CI).
      assert.isBelow(worstRead, bound(10))
      assert.isBelow(worstWrite, bound(25))
      assert.isBelow(afterRelease, bound(10))
      assert.isBelow(worstStep, bound(25))
      assert.isBelow(ended.worst, bound(50))
      assert.isBelow(worstBackground, bound(150))
      assert.isBelow(removal.worst, bound(150))
    }).pipe(Effect.scoped), { timeout: 600_000 })

  it.live("a version upgrade at start: the most rows it migrates (MAX_MIGRATION_ROWS of ~1 KB) in one transaction, before serving", () =>
    Effect.gen(function*() {
      const dir = latencyDir("pva-migration")
      const file = join(dir, "household.db")
      const Note2 = Schema.Struct({ state: Schema.String, due: Schema.Finite, text: Schema.String, label: Schema.String })
      const v2 = defineCollection({ name: "notes", scope: "household", schema: Note2, indexes: ["state", "due", ["state", "due"]], maxChars: 1_200, migrate: { 1: (v: typeof Note.Type) => ({ ...v, label: v.state }) } })
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare(MODULE)
      }))
      fill(file, MAX_MIGRATION_ROWS)
      const store = yield* makeSqliteStore({ filename: file })
      const { worst } = yield* longestStop(store.prepare([{ id: "big", storage: { version: 2, collections: [v2, chat] } }]))
      assert.strictEqual(store.availability("big"), undefined)
      assert.strictEqual((yield* store.forModule("big").collection(v2).get("n8"))?.value.label, "done")
      console.log(`Household store: migrating ${MAX_MIGRATION_ROWS} rows of ~1 KB at start (one transaction, after a backup): longest stop ${worst.toFixed(0)} ms`)
      assert.isBelow(worst, bound(10_000))
    }).pipe(Effect.scoped), { timeout: 240_000 })

  it.live("ending a conversation at the legal maximum (values of MAX_VALUE_CHARS, eight indexed fields at the indexed limit, secure deletion): each step of BULK_STEP_ROWS stays under 10 ms", () =>
    Effect.gen(function*() {
      const dir = latencyDir("pva-bulk")
      const store = yield* makeSqliteStore({ filename: join(dir, "household.db") })
      yield* store.prepare([{ id: "wide", storage: { collections: [wideChat] } }])
      const turn = { turnId: 1, conversationId: "conv-wide", source: "voice" as const }
      const total = BULK_STEP_ROWS * 40
      for (let k = 0; k < total; k += 50) {
        yield* store.forModule("wide").transaction((tx) => {
          for (let i = k; i < k + 50; i++) tx.collection(wideChat).insert(wideChatValue(i))
        }).pipe(Effect.provideService(CurrentTurn, turn))
      }
      // Every step is one commit: the time between two steps' commits, less the yield between them, is a step.
      const commits: Array<number> = []
      const off = store.onCommit(() => void commits.push(performance.now()))
      const ended = yield* longestStop(store.endConversation("conv-wide"))
      off()
      assert.strictEqual(ended.value, total)
      console.log(`Household store: ending a conversation of ${total} rows at the legal maximum, steps of ${BULK_STEP_ROWS}: longest stop ${ended.worst.toFixed(1)} ms (${commits.length} steps)`)
      assert.isBelow(ended.worst, bound(10))

      // A removal step right after a completed checkpoint: there, before the checkpoint worker started the new log, the
      // step's commit started it and synced its header on the main thread (docs/STORING-DATA.md "The write-ahead log").
      // Back to back, the steps above rarely land there; so 40 conversations of one step each, every one ended once the
      // checkpoint after the removal before it has completed, with no write in between.
      const ONE_STEP = 40
      const insertInto = (conversationId: string, rows: number, from: number) =>
        store.forModule("wide").transaction((tx) => {
          for (let i = from; i < from + rows; i++) tx.collection(wideChat).insert(wideChatValue(i))
        }).pipe(Effect.provideService(CurrentTurn, { turnId: 2, conversationId, source: "voice" as const }))
      yield* insertInto("conv-before", 1, 0)
      for (let k = 0; k < ONE_STEP; k++) yield* insertInto(`conv-step-${k}`, BULK_STEP_ROWS, k * BULK_STEP_ROWS)
      // A removal first, so the first of them also follows a completed checkpoint.
      assert.strictEqual(yield* store.endConversation("conv-before"), 1)
      let afterCheckpoint = 0
      let worstAfterCheckpoint = 0
      for (let k = 0; k < ONE_STEP; k++) {
        yield* store.scrubbed
        // Every removal so far is covered by a completed checkpoint, and nothing was written since.
        assert.isUndefined(store.removalPendingSince())
        afterCheckpoint++
        const one = yield* longestStop(store.endConversation(`conv-step-${k}`))
        assert.strictEqual(one.value, BULK_STEP_ROWS)
        worstAfterCheckpoint = Math.max(worstAfterCheckpoint, one.worst)
      }
      console.log(`Household store: ${afterCheckpoint} removal steps of ${BULK_STEP_ROWS} rows at the legal maximum, each right after a completed checkpoint: longest stop ${worstAfterCheckpoint.toFixed(1)} ms`)
      assert.strictEqual(afterCheckpoint, ONE_STEP)
      assert.isBelow(worstAfterCheckpoint, bound(10))
    }).pipe(Effect.scoped), { timeout: 240_000 })
})
