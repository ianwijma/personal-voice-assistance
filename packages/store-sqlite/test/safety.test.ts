// The SQLite store's files and data safety (review round 1): private files, a newer file refused untouched,
// backups that cannot meet, the checkpoint after an erase, retention of every archive, collection-only upgrades,
// index names, the index every list shape uses, module namespaces, and a complete, consistent export.
import { assert, describe, it } from "@effect/vitest"
import { checkQuery, defineCollection, type StoreError } from "@pva/core"
import { Effect, Exit, Fiber, Schema } from "effect"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { indexName, listSql, makeSqliteStore } from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "pva-safety-"))
const Item = Schema.Struct({ text: Schema.String })
const items = defineCollection({ name: "items", scope: "household", schema: Item, search: ["text"] })
const errorOf = <A>(exit: Exit.Exit<A, unknown>) => (Exit.isFailure(exit) ? (exit.cause.reasons.find((r) => r._tag === "Fail") as { error: StoreError } | undefined)?.error : undefined)
const mode = (path: string) => statSync(path).mode & 0o777
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const DAY = 86_400_000

describe("SQLite store files", () => {
  it.effect("everything it creates is private to the user: the directory, the database, its log, backups and copies", () =>
    Effect.gen(function*() {
      const dir = join(tmp(), "data")
      const copyDir = join(dir, "..", "share")
      const file = join(dir, "household.db")
      const store = yield* makeSqliteStore({ filename: file, backupCopyDir: copyDir })
      yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
      yield* store.forModule("shop").collection(items).insert({ text: "coffee" })
      assert.strictEqual(mode(dir), 0o700)
      for (const f of [file, `${file}-wal`, `${file}-shm`]) assert.strictEqual(mode(f) & 0o077, 0, f)
      const done = yield* store.backup()
      assert.strictEqual(mode(join(dir, "backups")), 0o700)
      assert.strictEqual(mode(done.path), 0o600)
      for (const n of readdirSync(copyDir)) assert.strictEqual(mode(join(copyDir, n)), 0o600)
    }).pipe(Effect.scoped))

  it.effect("an existing database readable by others is narrowed to the user", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      yield* Effect.scoped(makeSqliteStore({ filename: file }))
      chmodSync(file, 0o644)
      yield* Effect.scoped(makeSqliteStore({ filename: file }))
      assert.strictEqual(mode(file), 0o600)
    }))

  it.effect("a database of a newer assistant is refused without a byte of it changed (not even switched to WAL)", () =>
    Effect.gen(function*() {
      const file = join(tmp(), "household.db")
      const raw = new DatabaseSync(file)
      raw.exec("PRAGMA journal_mode = DELETE; CREATE TABLE pva_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO pva_meta VALUES ('schema', '99')")
      raw.close()
      const before = sha(file)
      const exit = yield* Effect.exit(Effect.scoped(makeSqliteStore({ filename: file })))
      assert.match(errorOf(exit)!.message, /newer version of the assistant/)
      assert.strictEqual(sha(file), before)
      assert.isFalse(existsSync(`${file}-wal`))
      const again = new DatabaseSync(file, { readOnly: true })
      assert.strictEqual((again.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete")
      again.close()
    }))

  it.effect("concurrent backups of one day never meet: each writes its own file and publishes it whole", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const copyDir = join(dir, "share")
      const writer = yield* makeSqliteStore({ filename: file, backupCopyDir: copyDir })
      yield* writer.prepare([{ id: "shop", storage: { collections: [items] } }])
      for (let i = 0; i < 200; i++) yield* writer.forModule("shop").collection(items).insert({ text: `item ${i} ${"z".repeat(500)}` })
      const reader = yield* makeSqliteStore({ filename: file, readOnly: true, backupCopyDir: copyDir })
      const now = Date.UTC(2026, 10, 18, 12)
      const results = yield* Effect.all([writer.backup({ now }), writer.backup({ now }), reader.backup({ now }), reader.backup({ now })], { concurrency: "unbounded" })
      assert.strictEqual(new Set(results.map((r) => r.path)).size, 1)
      for (const d of [join(dir, "backups"), copyDir]) {
        assert.deepStrictEqual(readdirSync(d).filter((n) => n.includes(".part-")), [], d)
        const copy = new DatabaseSync(join(d, readdirSync(d).find((n) => n.endsWith(".db"))!), { readOnly: true })
        assert.strictEqual((copy.prepare("SELECT count(*) AS n FROM pva_docs").get() as { n: number }).n, 200)
        assert.strictEqual((copy.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok")
        copy.close()
      }
    }).pipe(Effect.scoped))

  it.effect("a collection-only upgrade makes a backup first, which holds the rows as they were", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const v2 = defineCollection({ name: "items", scope: "household", version: 2, schema: Schema.Struct({ text: Schema.String, n: Schema.Finite }), migrate: { 1: (v: { text: string }) => ({ ...v, n: 1 }) } })
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "shop", storage: { collections: [items] } }])
        yield* store.forModule("shop").collection(items).insert({ text: "as it was" })
      }))
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "shop", storage: { collections: [v2] } }])
        assert.strictEqual(store.availability("shop"), undefined)
      }))
      const backup = readdirSync(join(dir, "backups")).find((n) => /-before-shop\.db$/.test(n))
      assert.isDefined(backup)
      const raw = new DatabaseSync(join(dir, "backups", backup!), { readOnly: true })
      assert.deepStrictEqual({ ...(raw.prepare("SELECT v, value FROM pva_docs").get() as object) }, { v: 1, value: "{\"text\":\"as it was\"}" })
      raw.close()
    }))

  it.effect("every archive is removed after 14 days: daily backups, pre-upgrade backups; temporary files of others are left", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const store = yield* makeSqliteStore({ filename: file })
      const now = Date.UTC(2026, 10, 30, 12)
      const backups = join(dir, "backups")
      yield* store.backup({ now: now - 20 * DAY })
      yield* store.backup({ now })
      const old = (name: string, days: number) => {
        const p = join(name.startsWith("household.db.") ? dir : backups, name)
        writeFileSync(p, "x", { mode: 0o600 })
        const t = (now - days * DAY) / 1000
        utimesSync(p, t, t)
      }
      old("household-2026-11-01-before-shop.db", 29)
      old("household-2026-11-25-before-lists.db", 5)
      old("household-2026-11-30.db.part-1234-0123456789ab", 0)
      utimesSync(join(backups, "household-2026-11-10.db"), (now - 20 * DAY) / 1000, (now - 20 * DAY) / 1000)
      const removed = yield* store.pruneBackups({ now })
      assert.sameMembers([...removed], ["household-2026-11-10.db", "household-2026-11-01-before-shop.db"])
      assert.sameMembers(readdirSync(backups), ["household-2026-11-30.db", "household-2026-11-25-before-lists.db", "household-2026-11-30.db.part-1234-0123456789ab"])
    }).pipe(Effect.scoped))
})

describe("SQLite store: erase reaches the files", () => {
  it.live("an erase while a reader holds an older snapshot is pending, retried, and complete once the reader lets go", (): Effect.Effect<void, unknown> =>
    Effect.gen(function*() {
      const dir = tmp()
      const file = join(dir, "household.db")
      const store = yield* makeSqliteStore({ filename: file, scrubRetryMs: 20 })
      yield* store.prepare([{ id: "memory", storage: { collections: [items] } }])
      const c = store.forModule("memory").collection(items)
      const row = yield* c.insert({ text: "quetzalcoatlsecret one" })
      yield* c.update(row.id, () => ({ text: "quetzalcoatlsecret two" }))
      for (let i = 0; i < 20; i++) yield* c.insert({ text: `filler ${i}` })
      const ck = new DatabaseSync(file)
      ck.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
      ck.close()
      // A reader (a command-line mode, a backup) holds the snapshot that still has the secret.
      const reader = new DatabaseSync(file, { readOnly: true })
      reader.exec("BEGIN")
      reader.prepare("SELECT count(*) FROM pva_docs").get()
      assert.isTrue(yield* c.erase(row.id))
      yield* Effect.sleep(100)
      assert.isDefined(store.erasePendingSince())
      reader.exec("COMMIT")
      reader.close()
      yield* store.scrubbed.pipe(Effect.timeout(5000))
      assert.isUndefined(store.erasePendingSince())
      for (const name of readdirSync(dir).filter((n) => n.startsWith("household.db"))) {
        assert.isFalse(readFileSync(join(dir, name)).includes("quetzalcoatlsecret"), `${name} still holds the erased text`)
      }
      assert.isTrue(!existsSync(`${file}-wal`) || statSync(`${file}-wal`).size === 0)
    }).pipe(Effect.scoped))
})

describe("SQLite store: names and indexes", () => {
  it.effect("index names cannot collide: case-distinct fields and names with __ each get their own index; a dropped field loses its index", () =>
    Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      const Two = Schema.Struct({ Title: Schema.optionalKey(Schema.String), title: Schema.optionalKey(Schema.String), c__d: Schema.optionalKey(Schema.String), d: Schema.optionalKey(Schema.String) })
      const both = defineCollection({ name: "b", scope: "household", schema: Two, indexes: ["Title", "title", "c__d"] })
      const other = defineCollection({ name: "b__c", scope: "household", schema: Two, indexes: ["d"] })
      yield* store.prepare([{ id: "m", storage: { collections: [both, other] } }])
      const names = [indexName("m", "b", "Title"), indexName("m", "b", "title"), indexName("m", "b", "c__d"), indexName("m", "b__c", "d")]
      assert.strictEqual(new Set(names).size, 4)
      const c = store.forModule("m").collection(both)
      yield* c.insert({ Title: "X", title: "y" }, { id: "1" })
      yield* c.insert({ Title: "y", title: "X" }, { id: "2" })
      assert.deepStrictEqual((yield* c.list({ where: { Title: "X" } })).map((r) => r.id), ["1"])
      assert.deepStrictEqual((yield* c.list({ where: { title: "X" } })).map((r) => r.id), ["2"])
      // The module drops `title` from its indexes: the index goes.
      const fewer = defineCollection({ name: "b", scope: "household", schema: Two, indexes: ["Title"] })
      yield* store.prepare([{ id: "m", storage: { collections: [fewer, other] } }])
      const exit = yield* Effect.exit(store.forModule("m").collection(fewer).list({ where: { title: "X" } as never }))
      assert.strictEqual(errorOf(exit)?.reason, "invalid")
      const raw = yield* store.core("probe").query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'pva_ix_%' ORDER BY name")
      assert.sameMembers(raw.map((r) => r.name), [indexName("m", "b", "Title"), indexName("m", "b__c", "d")])
    }).pipe(Effect.scoped))

  it.effect("every list shape reads one index in its own order (no sort of the matching rows), on a large table", () =>
    Effect.gen(function*() {
      const store = yield* makeSqliteStore({ filename: ":memory:" })
      const Timer = Schema.Struct({ state: Schema.String, due: Schema.Finite, label: Schema.String })
      const timers = defineCollection({ name: "timers", scope: "household", schema: Timer, indexes: ["state", "due"] })
      yield* store.prepare([{ id: "timers", storage: { collections: [timers] } }])
      const c = store.forModule("timers").collection(timers)
      yield* store.transaction(Effect.forEach(Array.from({ length: 3000 }, (_, i) => i), (i) => c.insert({ state: i % 3 === 0 ? "running" : "done", due: i % 50, label: `t${i}` }), { discard: true }))
      const shapes = [
        undefined,
        { orderBy: { field: "updatedAt" as const, direction: "asc" as const } },
        { orderBy: { field: "createdAt" as const } },
        { orderBy: { field: "due" as const } },
        { orderBy: { field: "due" as const, direction: "desc" as const } },
        { where: { state: "running" } },
        { where: { state: "running" }, orderBy: { field: "updatedAt" as const, direction: "asc" as const } },
        { where: { state: "running" }, orderBy: { field: "state" as const } },
        { where: { due: null } }
      ]
      const raw = store.core("probe")
      for (const shape of shapes) {
        const checked = yield* checkQuery(timers, { ...shape, limit: 20 })
        const { sql, params } = listSql("timers", "timers", { kind: "household" }, checked)
        const plan = (yield* raw.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params as ReadonlyArray<string | number>)).map((r) => r.detail).join(" | ")
        assert.notMatch(plan, /TEMP B-TREE|SCAN pva_docs(?! USING)/, `${JSON.stringify(shape)}: ${plan}`)
        assert.match(plan, /USING (COVERING )?INDEX/, `${JSON.stringify(shape)}: ${plan}`)
        assert.isTrue((yield* c.list({ ...shape, limit: 20 })).length <= 20)
      }
    }).pipe(Effect.scoped))
})

describe("the warning filter", () => {
  it("lets another ExperimentalWarning about SQLite through", async () => {
    await import("../src/quiet.ts")
    const seen: Array<string> = []
    const listener = (w: Error) => seen.push(`${w.name}: ${w.message}`)
    process.on("warning", listener)
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning")
    process.emitWarning("SQLite sessions are an experimental feature", "ExperimentalWarning")
    process.emitWarning("SQLite is an experimental feature and might change at any time", "DeprecationWarning")
    await new Promise((r) => setTimeout(r, 10))
    process.off("warning", listener)
    assert.deepStrictEqual(seen, ["ExperimentalWarning: SQLite sessions are an experimental feature", "DeprecationWarning: SQLite is an experimental feature and might change at any time"])
  })
})
