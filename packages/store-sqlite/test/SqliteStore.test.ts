// What only the SQLite store does: module SQL and its migrations, refusing newer data, backups,
// erase on disk, core services joining a module's transaction, read-only opening, and the quiet warning.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, type StoreError } from "@pva/core"
import { Effect, Exit, Schema } from "effect"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { householdIssues, makeSqliteStore } from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "pva-sqlite-"))
const Item = Schema.Struct({ text: Schema.String })
const items = defineCollection({ name: "items", scope: "household", schema: Item, search: ["text"] })
const errorOf = <A>(exit: Exit.Exit<A, unknown>) => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: StoreError } | undefined)?.error : undefined)

const LISTS_V1 = ["CREATE TABLE m_lists__items (id TEXT PRIMARY KEY, text TEXT NOT NULL); CREATE INDEX m_lists__items_text ON m_lists__items (text)"]

describe("SQLite household store", () => {
  it.effect("module SQL: migrations, queries, writes, and refusals", () =>
    Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      yield* store.prepare([{ id: "lists", storage: { sql: { migrations: LISTS_V1 } } }])
      assert.strictEqual(store.availability("lists"), undefined)
      const sql = store.forModule("lists").sql
      assert.strictEqual(sql.table("items"), "m_lists__items")
      const r = yield* sql.run("INSERT INTO m_lists__items (id, text) VALUES (?, ?)", ["1", "milk"])
      assert.strictEqual(r.changes, 1)
      assert.deepStrictEqual(yield* sql.query("SELECT text FROM m_lists__items"), [{ text: "milk" }])
      const outside = yield* Effect.exit(sql.query("SELECT * FROM pva_docs"))
      assert.strictEqual(errorOf(outside)?.reason, "refused")
      const ddl = yield* Effect.exit(sql.run("CREATE TABLE m_lists__late (x)"))
      assert.strictEqual(errorOf(ddl)?.reason, "refused")
      const two = yield* Effect.exit(sql.run("DELETE FROM m_lists__items; DELETE FROM pva_docs"))
      assert.strictEqual(errorOf(two)?.reason, "refused")
      // A module without storage.sql has no tables.
      const none = yield* Effect.exit(store.forModule("weather").sql.query("SELECT 1"))
      assert.strictEqual(errorOf(none)?.reason, "unavailable")
      // FTS5 for modules where the build has it.
      if (sql.fts5) {
        yield* store.prepare([{ id: "lists", storage: { sql: { migrations: [...LISTS_V1, "CREATE VIRTUAL TABLE m_lists__fts USING fts5(text)"] } } }])
        yield* sql.run("INSERT INTO m_lists__fts (text) VALUES (?)", ["oat milk"])
        assert.strictEqual((yield* sql.query("SELECT text FROM m_lists__fts WHERE m_lists__fts MATCH ?", ["milk"])).length, 1)
      }
    }).pipe(Effect.scoped))

  it.effect("a failed migration leaves the previous data and makes a backup first; newer stored tables are refused", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "lists", storage: { sql: { migrations: LISTS_V1 } } }])
        yield* store.forModule("lists").sql.run("INSERT INTO m_lists__items (id, text) VALUES ('1', 'milk')")
      }))
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        // The second migration makes a table, then fails: nothing of it stays.
        yield* store.prepare([{ id: "lists", storage: { sql: { migrations: [...LISTS_V1, "CREATE TABLE m_lists__new (x); INSERT INTO m_lists__missing VALUES (1)"] } } }])
        const verdict = store.availability("lists")
        assert.isDefined(verdict)
        assert.match(verdict!.reason, /could not be upgraded/)
        assert.isTrue(readdirSync(join(dir, "backups")).some((n) => /^household-.*-before-lists\.db$/.test(n)))
      }))
      const raw = new DatabaseSync(file, { readOnly: true })
      assert.strictEqual((raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'm_lists__new'").get() as { n: number }).n, 0)
      assert.deepStrictEqual(raw.prepare("SELECT text FROM m_lists__items").all().map((r) => ({ ...r })), [{ text: "milk" }])
      assert.strictEqual((raw.prepare("SELECT version FROM pva_versions WHERE owner = 'module:lists' AND name = 'sql'").get() as { version: number }).version, 1)
      raw.close()
      // Upgraded by a newer version, then opened by the old one: refused, data untouched.
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "lists", storage: { sql: { migrations: [...LISTS_V1, "ALTER TABLE m_lists__items ADD COLUMN note TEXT"] } } }])
        assert.strictEqual(store.availability("lists"), undefined)
      }))
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "lists", storage: { sql: { migrations: LISTS_V1 } } }])
        assert.match(store.availability("lists")!.reason, /newer version of this module/)
        const run = yield* Effect.exit(store.forModule("lists").sql.query("SELECT * FROM m_lists__items"))
        assert.strictEqual(errorOf(run)?.reason, "unavailable")
      }))
    }))

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
  it.effect("erase leaves no trace of the content in the database files", () =>
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
        yield* c.erase(row.id)
      }))
      for (const name of readdirSync(dir).filter((n) => n.startsWith("household.db"))) {
        assert.isFalse(readFileSync(join(dir, name)).includes("zanzibarpassphrase"), `${name} still holds the erased text`)
      }
    }))

  it.effect("a core service's table joins a module's transaction: both commit or neither", () =>
    Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      yield* store.prepare([{ id: "timers", storage: { collections: [items] } }])
      const jobs = store.core("scheduler")
      yield* jobs.migrate(["CREATE TABLE core_scheduler__jobs (id TEXT PRIMARY KEY, module TEXT NOT NULL)"])
      const timers = store.forModule("timers")
      const failed = yield* Effect.exit(timers.transaction(Effect.gen(function*() {
        yield* timers.collection(items).insert({ text: "pasta" })
        yield* jobs.run("INSERT INTO core_scheduler__jobs (id, module) VALUES ('j1', 'timers')")
        return yield* Effect.fail("no")
      })))
      assert.isTrue(Exit.isFailure(failed))
      assert.strictEqual((yield* jobs.query("SELECT * FROM core_scheduler__jobs")).length, 0)
      assert.strictEqual((yield* timers.collection(items).list()).length, 0)
      yield* timers.transaction(Effect.gen(function*() {
        yield* timers.collection(items).insert({ text: "pasta" })
        yield* jobs.run("INSERT INTO core_scheduler__jobs (id, module) VALUES ('j1', 'timers')")
      }))
      assert.strictEqual((yield* jobs.query("SELECT * FROM core_scheduler__jobs")).length, 1)
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
