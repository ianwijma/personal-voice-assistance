// What only the SQLite store does: refusing newer data, backups,
// erase on disk, core services joining a module's transaction, read-only opening, and the quiet warning.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, type StoreError } from "@pva/core"
import { Effect, Exit, Schema } from "effect"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { householdBackupIssues, householdIssues, makeSqliteStore } from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "pva-sqlite-"))
const Item = Schema.Struct({ text: Schema.String })
const items = defineCollection({ name: "items", scope: "household", schema: Item })
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

  it.effect("a backup opens as a database; 14 kept; a copy in the second directory", () =>
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
        for (let i = 0; i < 16; i++) yield* store.backup({ now: start + i * day })
        assert.isDefined(yield* store.lastBackupAt)
      }))
      const backups = readdirSync(join(dir, "backups")).filter((n) => /^household-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort()
      assert.strictEqual(backups.length, 14)
      assert.strictEqual(readdirSync(copyDir).length, 14)
      // A backup is a database of its own (docs/STORING-DATA.md "Restoring a backup").
      const restored = join(backups.at(-1) === undefined ? dir : join(dir, "backups"), backups.at(-1)!)
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: restored, readOnly: true })
        yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
        assert.deepStrictEqual((yield* store.forModule("shop").collection(items).list()).map((r) => r.value.text), ["coffee"])
      }))
      const issues = yield* householdIssues(dir)
      assert.isUndefined(issues.find((i) => i.severity === "error"))
    }))
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
      }))
      for (const name of readdirSync(dir).filter((n) => n.startsWith("household.db"))) {
        assert.isFalse(readFileSync(join(dir, name)).includes("zanzibarpassphrase"), `${name} still holds the removed text`)
      }
    }))

  it.effect("a core service's table joins a module's transaction through its handle: both commit or neither", () =>
    Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      yield* store.prepare([{ id: "timers", storage: { collections: [items] } }])
      const jobs = store.core("scheduler")
      yield* jobs.migrate(["CREATE TABLE core_scheduler__jobs (id TEXT PRIMARY KEY, module TEXT NOT NULL); CREATE INDEX core_scheduler__jobs_module ON core_scheduler__jobs (module)"])
      const timers = store.forModule("timers")
      const failed = yield* Effect.exit(timers.transaction((tx) => {
        tx.collection(items).insert({ text: "pasta" })
        tx.core("scheduler").run("INSERT INTO core_scheduler__jobs (id, module) VALUES ('j1', 'timers')")
        throw new Error("no")
      }))
      assert.isTrue(Exit.isFailure(failed))
      assert.strictEqual((yield* jobs.query("SELECT * FROM core_scheduler__jobs")).length, 0)
      assert.strictEqual((yield* timers.collection(items).list()).length, 0)
      yield* timers.transaction((tx) => {
        tx.collection(items).insert({ text: "pasta" })
        tx.core("scheduler").run("INSERT INTO core_scheduler__jobs (id, module) VALUES ('j1', 'timers')")
        assert.strictEqual(tx.core("scheduler").query("SELECT * FROM core_scheduler__jobs").length, 1)
      })
      assert.strictEqual((yield* jobs.query("SELECT * FROM core_scheduler__jobs")).length, 1)
      // The scheduler's own transaction (no module).
      yield* store.transaction((tx) => tx.core("scheduler").run("DELETE FROM core_scheduler__jobs WHERE id = ?", ["j1"]))
      assert.strictEqual((yield* jobs.query("SELECT * FROM core_scheduler__jobs")).length, 0)
      // A statement that ends the transaction itself is refused, and nothing of the transaction is kept.
      const ended = yield* Effect.exit(timers.transaction((tx) => {
        tx.collection(items).insert({ text: "kept?" })
        tx.core("scheduler").run("COMMIT")
        tx.collection(items).insert({ text: "after the end" })
      }))
      assert.isTrue(Exit.isFailure(ended))
      assert.strictEqual((yield* timers.collection(items).list()).length, 1)
      // Migrating again is a no-op; fewer migrations than stored is refused.
      yield* jobs.migrate(["CREATE TABLE core_scheduler__jobs (id TEXT PRIMARY KEY, module TEXT NOT NULL)"])
      const older = yield* Effect.exit(jobs.migrate([]))
      assert.strictEqual(errorOf(older)?.reason, "unavailable")
    }).pipe(Effect.scoped))

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

describe("SQLite household store: what review round 2 found", () => {
  it.effect("SQLite ending a transaction itself (the disk is full) fails it whole, also when the function caught the error", () =>
    Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      const Big = Schema.Struct({ text: Schema.String })
      const bigs = defineCollection({ name: "bigs", scope: "household", schema: Big })
      yield* store.prepare([{ id: "fill", storage: { collections: [bigs] } }])
      const pages = Number((yield* store.core("probe").query<{ page_count: number }>("PRAGMA page_count"))[0]!.page_count)
      yield* store.core("probe").query(`PRAGMA max_page_count = ${pages + 8}`)
      const exit = yield* Effect.exit(store.forModule("fill").transaction((tx) => {
        const c = tx.collection(bigs)
        c.insert({ text: "first" }, { id: "first" })
        try {
          for (let i = 0; i < 100; i++) c.insert({ text: "x".repeat(60_000) }, { id: `big${i}` })
        } catch {
          // The module catches the failure and carries on: the store must not let the next write autocommit.
        }
        c.insert({ text: "after" }, { id: "after" })
      }))
      assert.isTrue(Exit.isFailure(exit))
      yield* store.core("probe").query("PRAGMA max_page_count = 1073741823")
      const rows = yield* store.forModule("fill").collection(bigs).list({ limit: 1000 })
      assert.deepStrictEqual(rows.map((r) => r.id), [])
      // The store goes on working.
      yield* store.forModule("fill").collection(bigs).insert({ text: "later" }, { id: "later" })
      assert.strictEqual((yield* store.forModule("fill").collection(bigs).list()).length, 1)
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
      // The first checkpoint is on its way; a reader now holds a snapshot, then the second removal commits.
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

  it.effect("a backup that could not be removed is reported, never counted as removed, and shows on the Health page", () =>
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
      chmodSync(backups, 0o500)
      try {
        // (The test clock stands at 0: give the real time.)
        const pruned = yield* store.pruneBackups({ now: Date.now() })
        assert.deepStrictEqual(pruned.removed, [])
        assert.strictEqual(pruned.failed.length, 1)
        assert.isTrue(existsSync(old))
        const issues = yield* householdBackupIssues(store)
        assert.isTrue(issues.some((i) => i.id === "core.household.retention"))
      } finally {
        chmodSync(backups, 0o700)
      }
    }).pipe(Effect.scoped))

  it.effect("doctor says which module's stored data is newer than the module, without changing the file", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const v2 = defineCollection({ name: "items", scope: "household", schema: Item, version: 2, migrate: { 1: (v: unknown) => v } })
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "shop", storage: { collections: [v2] } }])
        yield* store.forModule("shop").collection(v2).insert({ text: "x" })
        yield* store.backup()
      }))
      const before = readFileSync(file)
      const issues = yield* householdIssues(dir, { modules: [{ id: "shop", name: "Shop", storage: { collections: [items] } }] })
      const mine = issues.find((i) => i.id === "core.household.module.shop")
      assert.strictEqual(mine?.severity, "error")
      assert.match(mine!.detail ?? "", /newer version/)
      assert.isTrue(readFileSync(file).equals(before))
    }))
})
