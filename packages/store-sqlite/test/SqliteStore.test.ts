// What only the SQLite store does: refusing newer data, backups, removal on disk, the checkpoints (never on the main
// connection), a lock held elsewhere, SQLite ending a transaction itself, read-only opening, and the quiet warning.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, MAX_VALUE_CHARS, type StoreError } from "@pva/core"
import { Effect, Exit, Fiber, Schema } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { householdBackupIssues, householdIssues, makeSqliteStore } from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "pva-sqlite-"))
const Item = Schema.Struct({ text: Schema.String, tag: Schema.optionalKey(Schema.String) })
const items = defineCollection({ name: "items", scope: "household", schema: Item, maxChars: MAX_VALUE_CHARS })
const tagged = defineCollection({ name: "items", scope: "household", schema: Item, indexes: ["tag"], maxChars: MAX_VALUE_CHARS })
const errorOf = <A>(exit: Exit.Exit<A, unknown>) => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: StoreError } | undefined)?.error : undefined)

describe("SQLite household store", () => {
  it.effect("a database from a newer assistant is refused with a clear message", () =>
    Effect.gen(function*() {
      const file = join(tmp(), "household.db")
      yield* Effect.scoped(makeSqliteStore({ filename: file }))
      const raw = new DatabaseSync(file)
      raw.prepare("UPDATE pva_meta SET value = '99' WHERE key = 'schema'").run()
      raw.close()
      const exit = yield* Effect.exit(Effect.scoped(makeSqliteStore({ filename: file })))
      assert.match(errorOf(exit)!.message, /newer version of the assistant/)
      const issues = yield* householdIssues(join(file, ".."))
      assert.strictEqual(issues.find((i) => i.id === "core.household.open")?.severity, "error")
    }))

  it.effect("doctor: only a missing file is no database; a database whose directory cannot be searched is core.household.open, and doctor creates nothing and changes no mode", () =>
    Effect.gen(function*() {
      // Root searches any directory.
      if (process.getuid?.() === 0) return
      const dir = tmp()
      assert.deepStrictEqual(yield* householdIssues(dir), [])
      yield* Effect.scoped(makeSqliteStore({ filename: join(dir, "household.db") }))
      const before = readdirSync(dir).sort()
      chmodSync(dir, 0o600)
      const issues = yield* Effect.ensuring(householdIssues(dir), Effect.sync(() => {
        // Checked before access is restored: doctor changed no mode.
        assert.strictEqual(statSync(dir).mode & 0o777, 0o600)
        chmodSync(dir, 0o700)
      }))
      const open = issues.find((i) => i.id === "core.household.open")
      assert.strictEqual(open?.severity, "error")
      assert.match(open!.detail ?? "", /EACCES|permission denied/i)
      assert.deepStrictEqual(readdirSync(dir).sort(), before)
    }))

  it.effect("a backup opens as a database; every backup older than 14 days goes; each is copied to the second directory", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const copyDir = join(dir, "share")
      const file = join(dir, "household.db")
      const day = 86_400_000
      const start = Date.UTC(2026, 10, 1, 12)
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file, backupCopyDir: copyDir })
        yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
        yield* store.forModule("shop").collection(items).insert({ text: "coffee" })
        for (let i = 0; i < 20; i++) yield* store.backup({ now: start + i * day })
        assert.isDefined(yield* store.lastBackupAt)
        assert.isDefined(yield* store.lastCopyAt)
      }))
      const backups = readdirSync(join(dir, "backups")).filter((n) => /^household-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort()
      // Now is day 19 at noon: days 5 to 19 are kept (day 5 ended 13.5 days ago), days 0 to 4 are older than 14 days.
      assert.strictEqual(backups.length, 15)
      assert.strictEqual(readdirSync(copyDir).length, 15)
      const restored = join(dir, "backups", backups.at(-1)!)
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: restored, readOnly: true })
        yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
        assert.deepStrictEqual((yield* store.forModule("shop").collection(items).list()).map((r) => r.value.text), ["coffee"])
      }))
      const issues = yield* householdIssues(dir)
      assert.isUndefined(issues.find((i) => i.severity === "error"))
    }))

  it.effect("backups are made by the serving process only: a read-only store (a CLI mode) and an in-memory one make none", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      yield* Effect.scoped(makeSqliteStore({ filename: file }))
      const reader = yield* makeSqliteStore({ filename: file, readOnly: true })
      assert.strictEqual(errorOf(yield* Effect.exit(reader.backup()))?.reason, "unavailable")
      const memory = yield* makeSqliteStore({ filename: ":memory:" })
      assert.strictEqual(errorOf(yield* Effect.exit(memory.backup()))?.reason, "unavailable")
      assert.isFalse(existsSync(join(dir, "backups", ".backup.lock")))
      assert.deepStrictEqual(readdirSync(join(dir, "backups")), [])
    }).pipe(Effect.scoped))

  it.effect("remove leaves no trace of the content in the database files", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "memory", storage: { collections: [items] } }])
        const c = store.forModule("memory").collection(items)
        const row = yield* c.insert({ text: "zanzibarpassphrase first" })
        yield* c.update(row.id, () => ({ text: "zanzibarpassphrase second" }))
        for (let i = 0; i < 20; i++) yield* c.insert({ text: `filler ${i}` })
        yield* c.remove(row.id)
        yield* store.scrubbed
      }))
      for (const name of readdirSync(dir).filter((n) => n.startsWith("household.db"))) {
        assert.isFalse(readFileSync(join(dir, name)).includes("zanzibarpassphrase"), `${name} still holds the removed text`)
      }
    }))

  it.effect("read-only beside the writer: sees committed rows, refuses writes, a fresh file is not created", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const missing = yield* Effect.exit(Effect.scoped(makeSqliteStore({ filename: join(dir, "nothing.db"), readOnly: true })))
      assert.isTrue(Exit.isFailure(missing))
      const writer = yield* makeSqliteStore({ filename: file })
      yield* writer.prepare([{ id: "shop", storage: { collections: [items] } }])
      yield* writer.forModule("shop").collection(items).insert({ text: "bread" })
      const reader = yield* makeSqliteStore({ filename: file, readOnly: true })
      yield* reader.prepare([{ id: "shop", storage: { collections: [items] } }])
      assert.deepStrictEqual((yield* reader.forModule("shop").collection(items).list()).map((r) => r.value.text), ["bread"])
      const w = yield* Effect.exit(reader.forModule("shop").collection(items).insert({ text: "x" }))
      assert.strictEqual(errorOf(w)?.reason, "read-only")
      assert.isTrue(existsSync(file))
    }).pipe(Effect.scoped))

  it.effect("read-only: a collection is usable only when its stored version, shape and indexes match the code; a missing index never reaches SQLite", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const writer = yield* makeSqliteStore({ filename: file })
      yield* writer.prepare([{ id: "shop", storage: { collections: [items] } }])
      yield* writer.forModule("shop").collection(items).insert({ text: "bread", tag: "t" })
      const reader = yield* makeSqliteStore({ filename: file, readOnly: true })
      // A newer build beside the old server: an index it declares at a new version is not there yet.
      yield* reader.prepare([{ id: "shop", storage: { version: 2, collections: [tagged] } }])
      assert.match(reader.availability("shop")?.reason ?? "", /upgrade/)
      // The same version with another shape: refused here too.
      yield* reader.prepare([{ id: "shop", storage: { collections: [tagged] } }])
      assert.match(reader.availability("shop")?.reason ?? "", /shape/)
      // An index the file lacks (dropped by hand): unavailable, not a "no such index" from SQLite.
      yield* writer.prepare([{ id: "shop", storage: { version: 2, collections: [tagged] } }])
      const raw = new DatabaseSync(file)
      const name = (raw.prepare("SELECT name FROM pva_indexes LIMIT 1").get() as { name: string }).name
      raw.exec(`DROP INDEX ${name}`)
      raw.close()
      yield* reader.prepare([{ id: "shop", storage: { version: 2, collections: [tagged] } }])
      assert.match(reader.availability("shop")?.reason ?? "", /indexes/)
      // A module the server never prepared reads as empty, through any list shape.
      const fresh = defineCollection({ name: "fresh", scope: "household", schema: Item, indexes: ["tag"] })
      yield* reader.prepare([{ id: "newmod", storage: { collections: [fresh] } }])
      assert.strictEqual(reader.availability("newmod"), undefined)
      assert.deepStrictEqual(yield* reader.forModule("newmod").collection(fresh).list({ where: { tag: "t" } }), [])
    }).pipe(Effect.scoped))

  it.effect("the store's own indexes are part of being ready: a writable start makes a missing one again; read-only and doctor refuse the file and write nothing", () =>
    Effect.gen(function*() {
      for (const name of ["pva_docs_updated", "pva_docs_created", "pva_docs_conversation"]) {
        const dir = tmp()
        const file = join(dir, "household.db")
        yield* Effect.scoped(Effect.gen(function*() {
          const store = yield* makeSqliteStore({ filename: file })
          yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
          yield* store.forModule("shop").collection(items).insert({ text: "bread" })
        }))
        const raw = new DatabaseSync(file)
        raw.exec(`DROP INDEX ${name}`)
        raw.exec("PRAGMA wal_checkpoint(TRUNCATE)")
        raw.close()
        const before = readFileSync(file)
        const reader = yield* Effect.exit(Effect.scoped(makeSqliteStore({ filename: file, readOnly: true })))
        assert.strictEqual(errorOf(reader)?.reason, "unavailable", name)
        assert.match(errorOf(reader)?.message ?? "", new RegExp(name))
        const issues = yield* householdIssues(dir)
        assert.match(issues.find((i) => i.id === "core.household.open")?.detail ?? "", new RegExp(name))
        assert.isTrue(readFileSync(file).equals(before), `${name}: read-only and doctor wrote nothing`)
        yield* Effect.scoped(Effect.gen(function*() {
          const store = yield* makeSqliteStore({ filename: file })
          yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
          assert.deepStrictEqual((yield* store.forModule("shop").collection(items).list()).map((r) => r.value.text), ["bread"])
          assert.strictEqual(yield* store.sweepConversations, 0)
        }))
        const again = new DatabaseSync(file, { readOnly: true })
        assert.strictEqual((again.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name) as { n: number }).n, 1)
        again.close()
      }
    }))

  it.effect("a read-only store refuses pruning: no backup is removed and no file's mode changes", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      yield* Effect.scoped(makeSqliteStore({ filename: file }))
      const old = join(dir, "backups", "household-2026-01-01.db")
      writeFileSync(old, "x", { mode: 0o600 })
      chmodSync(old, 0o644)
      utimesSync(old, Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 0, 1) / 1000)
      const reader = yield* makeSqliteStore({ filename: file, readOnly: true })
      const pruned = yield* reader.pruneBackups({ now: Date.UTC(2026, 10, 18) })
      assert.deepStrictEqual(pruned.removed, [])
      assert.match(pruned.failed.join(" "), /serve mode/)
      assert.deepStrictEqual(reader.pruneFailures(), [])
      assert.isTrue(existsSync(old))
      assert.strictEqual(statSync(old).mode & 0o777, 0o644)
    }).pipe(Effect.scoped))

  it("node:sqlite's ExperimentalWarning is filtered; other warnings pass", async () => {
    const seen: Array<string> = []
    const listener = (w: Error) => seen.push(`${w.name}: ${w.message}`)
    process.on("warning", listener)
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning")
    process.emitWarning("Something else", "ExperimentalWarning")
    await new Promise((r) => setTimeout(r, 10))
    process.off("warning", listener)
    assert.deepStrictEqual(seen, ["ExperimentalWarning: Something else"])
  })
})

describe("SQLite household store: transactions the database ends, locks held elsewhere", () => {
  it.effect("SQLite ending a transaction itself (the disk is full) fails it whole with a StoreError, also when the function caught the error; rollback hooks run, nothing is released", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const Big = Schema.Struct({ text: Schema.String })
      const bigs = defineCollection({ name: "bigs", scope: "household", schema: Big, maxChars: MAX_VALUE_CHARS })
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "fill", storage: { collections: [bigs] } }])
      }))
      // A file that cannot grow: SQLite answers SQLITE_FULL and rolls the transaction back itself.
      const pages = (() => {
        const raw = new DatabaseSync(file)
        const n = Number((raw.prepare("PRAGMA page_count").get() as { page_count: number }).page_count)
        raw.close()
        return n
      })()
      const store = yield* makeSqliteStore({ filename: file, maxPageCount: pages + 8 })
      yield* store.prepare([{ id: "fill", storage: { collections: [bigs] } }])
      const undone: Array<string> = []
      const heard: Array<unknown> = []
      store.onCommit((r) => heard.push(...r))
      const exit = yield* Effect.exit(store.forModule("fill").transaction((tx) => {
        tx.onRollback(() => undone.push("rolled back"))
        const c = tx.collection(bigs)
        c.insert({ text: "first" }, { id: "first" })
        try {
          for (let i = 0; i < 100; i++) c.insert({ text: "x".repeat(15_000) }, { id: `big${i}` })
        } catch {
          // The module catches the failure and carries on: the store must not let the next write autocommit.
        }
        c.insert({ text: "after" }, { id: "after" })
      }))
      assert.strictEqual(errorOf(exit)?._tag, "StoreError")
      assert.strictEqual(errorOf(exit)?.reason, "failed")
      assert.deepStrictEqual(undone, ["rolled back"])
      assert.deepStrictEqual(heard, [])
      assert.deepStrictEqual((yield* store.forModule("fill").collection(bigs).list()).map((r) => r.id), [])
      yield* store.forModule("fill").collection(bigs).insert({ text: "later" }, { id: "later" })
      assert.strictEqual((yield* store.forModule("fill").collection(bigs).list()).length, 1)
    }).pipe(Effect.scoped))

  it.live("a write made while the store's own checkpoint worker truncates a large log (it holds the write lock meanwhile) waits for it on timers and succeeds: no `busy` in ordinary operation", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      // No periodic checkpoint: the log grows until the removal's truncating checkpoint.
      const store = yield* makeSqliteStore({ filename: file, checkpointEveryMs: 3_600_000 })
      yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
      const c = store.forModule("shop").collection(items)
      const text = "x".repeat(MAX_VALUE_CHARS - 20)
      for (let k = 0; k < 10; k++) {
        yield* store.forModule("shop").transaction((tx) => {
          for (let i = 0; i < 100; i++) tx.collection(items).insert({ text })
        })
      }
      const wal = statSync(`${file}-wal`).size
      const victim = (yield* c.list({ limit: 1 }))[0]!
      // The removal schedules the worker's truncating checkpoint of the whole log; writes go on meanwhile.
      yield* c.remove(victim.id)
      let settled = false
      const scrub = yield* Effect.forkChild(Effect.andThen(store.scrubbed, Effect.sync(() => void (settled = true))))
      const waits: Array<number> = []
      let ticks = 0
      const timer = setInterval(() => ticks++, 1)
      // A write every 2 ms (a busy household, not a loop that would starve the checkpoint), at most 2,000 of them.
      const failures: Array<unknown> = []
      while (!settled && waits.length < 2_000) {
        const t0 = performance.now()
        const exit = yield* Effect.exit(c.insert({ text: "during the checkpoint" }))
        waits.push(performance.now() - t0)
        if (Exit.isFailure(exit)) failures.push(errorOf(exit))
        yield* Effect.sleep(2)
      }
      clearInterval(timer)
      assert.deepStrictEqual(failures, [], "every write during the checkpoint succeeds")
      assert.isTrue(settled, "the truncating checkpoint settled while writes went on")
      yield* Fiber.join(scrub)
      const longest = Math.max(...waits)
      console.log(`writes during the truncating checkpoint of a ${(wal / 1024 / 1024).toFixed(0)} MB log: ${waits.length}, all succeeded; the longest waited ${longest.toFixed(1)} ms`)
      assert.isAbove(waits.length, 0)
      // The event loop ran while a write waited for the lock.
      assert.isAbove(ticks, 0)
    }).pipe(Effect.scoped), 120_000)

  it.live("a write lock held by another connection beyond the store's wait (about one second) is a typed `busy` failure, tried off the event loop; a lock released in time is waited for", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const store = yield* makeSqliteStore({ filename: file })
      yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
      const c = store.forModule("shop").collection(items)
      const other = new DatabaseSync(file)
      other.exec("BEGIN IMMEDIATE")
      let ticks = 0
      const timer = setInterval(() => ticks++, 1)
      const t0 = performance.now()
      const busy = yield* Effect.exit(c.insert({ text: "blocked" }))
      const took = performance.now() - t0
      clearInterval(timer)
      assert.strictEqual(errorOf(busy)?.reason, "busy")
      assert.isAtLeast(took, 1000)
      assert.isBelow(took, 3000)
      // The event loop ran meanwhile (the tries wait on timers, not in SQLite).
      assert.isAbove(ticks, 50)
      // Released while the store is trying, after half a second: the write goes through.
      setTimeout(() => other.exec("COMMIT"), 500)
      assert.strictEqual((yield* c.insert({ text: "after the lock" })).value.text, "after the lock")
      other.close()
    }).pipe(Effect.scoped))
})

describe("SQLite household store: checkpoints off the main connection", () => {
  it.live("the main connection never checkpoints: the log grows until the checkpointer copies it; its size is a Health issue past the limit", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      // No periodic checkpoint during the test.
      const store = yield* makeSqliteStore({ filename: file, checkpointEveryMs: 3_600_000 })
      yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
      for (let i = 0; i < 30; i++) {
        yield* store.forModule("shop").transaction((tx) => {
          for (let j = 0; j < 50; j++) tx.collection(items).insert({ text: `${i}.${j} ${"w".repeat(2000)}` })
        })
      }
      // SQLite's own automatic checkpoint (1,000 pages, ~4 MB) would have reset the log long before this.
      const grown = statSync(`${file}-wal`).size
      assert.isAbove(grown, 6 * 1024 * 1024)
      const issues = yield* householdBackupIssues(store)
      assert.isUndefined(issues.find((i) => i.id === "core.household.log"))
      // With a short interval, the checkpointer (its own worker thread) makes passive checkpoints as the log grows:
      // the log is then reset by the next write and cut back to 4 MB, and its size past the limit is a Health issue.
      const watched = yield* makeSqliteStore({ filename: file, checkpointEveryMs: 20, walWarnBytes: 1024 * 1024 })
      yield* watched.prepare([{ id: "shop", storage: { collections: [items] } }])
      for (let i = 0; i < 30; i++) {
        yield* watched.forModule("shop").transaction((tx) => {
          for (let j = 0; j < 50; j++) tx.collection(items).insert({ text: `again ${i}.${j} ${"w".repeat(2000)}` })
        })
      }
      yield* Effect.sleep(50)
      assert.isTrue((yield* householdBackupIssues(watched)).some((i) => i.id === "core.household.log"))
      yield* Effect.sleep(400)
      yield* watched.forModule("shop").collection(items).insert({ text: "one more" })
      assert.isAtMost(statSync(`${file}-wal`).size, 4 * 1024 * 1024 + 64 * 1024)
    }).pipe(Effect.scoped))

  it.live("each removal is acknowledged only by a checkpoint that started after it: a second removal while the first is checkpointed stays pending", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const store = yield* makeSqliteStore({ filename: file, scrubRetryMs: 20 })
      yield* store.prepare([{ id: "memory", storage: { collections: [items] } }])
      const c = store.forModule("memory").collection(items)
      yield* c.insert({ text: "zebrafirst" }, { id: "a" })
      yield* c.insert({ text: "zebrasecond" }, { id: "b" })
      assert.isTrue(yield* c.remove("a"))
      const reader = new DatabaseSync(file, { readOnly: true })
      reader.exec("BEGIN")
      reader.prepare("SELECT count(*) FROM pva_docs").get()
      assert.isTrue(yield* c.remove("b"))
      yield* Effect.sleep(200)
      assert.isDefined(store.removalPendingSince(), "the second removal waits for the reader")
      reader.exec("COMMIT")
      reader.close()
      yield* store.scrubbed.pipe(Effect.timeout(5000))
      assert.isUndefined(store.removalPendingSince())
      for (const name of readdirSync(dir).filter((n) => n.startsWith("household.db"))) {
        assert.isFalse(readFileSync(join(dir, name)).includes("zebrasecond"), `${name} still holds the removed text`)
      }
    }).pipe(Effect.scoped))

  it.live("a removal whose checkpoint was pending when the store closed is settled by the checkpoint at the next start, which stays pending while the reader holds on", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const held = yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file, scrubRetryMs: 20 })
        yield* store.prepare([{ id: "memory", storage: { collections: [items] } }])
        const c = store.forModule("memory").collection(items)
        yield* c.insert({ text: "okapisecret" }, { id: "s" })
        for (let i = 0; i < 20; i++) yield* c.insert({ text: `filler ${i}` })
        const r = new DatabaseSync(file, { readOnly: true })
        r.exec("BEGIN")
        r.prepare("SELECT count(*) FROM pva_docs").get()
        assert.isTrue(yield* c.remove("s"))
        yield* Effect.sleep(100)
        assert.isDefined(store.removalPendingSince())
        return r
      }))
      // A new store (a restart) with the reader still there: the start's checkpoint cannot finish; it is pending.
      const store = yield* makeSqliteStore({ filename: file, scrubRetryMs: 20 })
      assert.isDefined(store.removalPendingSince())
      held.exec("COMMIT")
      held.close()
      yield* store.scrubbed.pipe(Effect.timeout(5000))
      assert.isUndefined(store.removalPendingSince())
      for (const name of readdirSync(dir).filter((n) => n.startsWith("household.db"))) {
        assert.isFalse(readFileSync(join(dir, name)).includes("okapisecret"), `${name} still holds the removed text`)
      }
    }).pipe(Effect.scoped))
})

describe("SQLite household store: retention and directories", () => {
  it.effect("a backup that could not be removed, a directory that cannot be listed or a file that cannot be checked is reported, never counted as done, and shows on the Health page", () =>
    Effect.gen(function*() {
      if (process.getuid?.() === 0) return
      const dir = tmp()
      const file = join(dir, "household.db")
      const store = yield* makeSqliteStore({ filename: file })
      const backups = join(dir, "backups")
      yield* store.backup({ now: Date.now() })
      const old = join(backups, "household-2026-01-01.db")
      writeFileSync(old, "x", { mode: 0o600 })
      utimesSync(old, Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 0, 1) / 1000)
      // The file cannot be removed (the directory is not writable).
      chmodSync(backups, 0o500)
      try {
        const pruned = yield* store.pruneBackups({ now: Date.now() })
        assert.deepStrictEqual(pruned.removed, [])
        assert.strictEqual(pruned.failed.length, 1)
        assert.isTrue(existsSync(old))
        assert.isTrue((yield* householdBackupIssues(store)).some((i) => i.id === "core.household.retention"))
      } finally {
        chmodSync(backups, 0o700)
      }
      // The directory cannot be listed at all.
      chmodSync(backups, 0o000)
      try {
        const pruned = yield* store.pruneBackups({ now: Date.now() })
        assert.deepStrictEqual(pruned.removed, [])
        assert.match(pruned.failed.join(" "), /could not be listed/)
        const issues = yield* householdBackupIssues(store)
        assert.isTrue(issues.some((i) => i.id === "core.household.retention"))
        assert.isTrue(issues.some((i) => i.id === "core.household.backup" && /cannot be checked/.test(i.title)))
      } finally {
        chmodSync(backups, 0o700)
      }
      // Once it works again, the issue goes.
      yield* store.pruneBackups({ now: Date.now() })
      assert.isFalse((yield* householdBackupIssues(store)).some((i) => i.id === "core.household.retention"))
    }).pipe(Effect.scoped))

  it.effect("an existing data or backup directory others may write to is made private (it is the user's); the database files too", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const backups = join(dir, "backups")
      const copyDir = join(dir, "share")
      for (const d of [backups, copyDir]) {
        mkdirSync(d, { mode: 0o777 })
        chmodSync(d, 0o777)
      }
      chmodSync(dir, 0o777)
      const store = yield* makeSqliteStore({ filename: file, backupCopyDir: copyDir })
      for (const d of [dir, backups, copyDir]) assert.strictEqual(statSync(d).mode & 0o777, 0o700, d)
      assert.deepStrictEqual(store.directoryProblems(), [])
      yield* store.backup()
      assert.strictEqual(statSync(file).mode & 0o077, 0)
    }).pipe(Effect.scoped))

  it.effect("doctor says which module's stored data is newer than the module, and which stored collections nothing declares, without changing the file", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const gone = defineCollection({ name: "gone", scope: "household", schema: Item })
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "shop", storage: { version: 2, collections: [items] } }, { id: "old", storage: { collections: [gone] } }])
        yield* store.forModule("shop").collection(items).insert({ text: "x" })
        yield* store.backup()
      }))
      const before = readFileSync(file)
      const issues = yield* householdIssues(dir, { modules: [{ id: "shop", name: "Shop", storage: { collections: [items] } }] })
      const mine = issues.find((i) => i.id === "core.household.module.shop")
      assert.strictEqual(mine?.severity, "error")
      assert.match(mine!.detail ?? "", /newer version/)
      assert.match(issues.find((i) => i.id === "core.household.undeclared")?.detail ?? "", /old\/gone/)
      assert.isTrue(readFileSync(file).equals(before))
    }))
})
