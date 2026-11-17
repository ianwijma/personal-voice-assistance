import "./quiet.ts"
import {
  type Actor,
  type CheckedQuery,
  type Collection,
  type CommittedChange,
  type CoreSql,
  type HouseholdStore,
  makeTransactions,
  type OutboxItem,
  readOnlyError,
  type ScopeRef,
  scopeFromColumns,
  scopeIdOf,
  type StoredModule,
  StoreError
} from "@pva/core"
import { endConversationsOn, makeModuleStoreOn, migrateCollectionOn, type StoreBackend, type StoredDoc } from "@pva/core/store-backend"
import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Effect, Queue, type Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { isSqlError, type SqlError } from "effect/sql/SqlError"
import { createHash } from "node:crypto"
import { open, readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { copyDatabase, copyFilePrivately, type FileGuard, narrow, privateDir, pruneArchives, sqlite, unguarded } from "./files.ts"

/**
 * The household store on SQLite (docs/STORING-DATA.md; shared-state-jobs-and-notifications.md §4.1): one file
 * (`data/household.db`, mode 0600 in a 0700 directory), WAL, `synchronous = NORMAL`, `secure_delete = ON`, one
 * connection through `@effect/sql-sqlite-node` on Node's built-in `node:sqlite` (no native build), with the
 * transaction model of `StoreTransactions.ts` on top of the driver's transactions and savepoints.
 *
 * Every statement on that connection is synchronous on the main thread, which also frames audio. So every read a turn
 * can make is one index range with a row limit (`INDEXED BY`, so a query that cannot use its index fails instead of
 * scanning), writes touch single rows, and everything long runs elsewhere: backups and exports read through a
 * connection of their own (backups in one step on a worker thread), and the checkpoint after a removal runs in the background, never waiting for a reader.
 */

/** The store's own schema version (`pva_meta.schema`). A file with a higher one is refused before it is opened for writing. */
export const CORE_SCHEMA_VERSION = 1

/** How many days every kind of backup and set-aside copy is kept (docs/STORING-DATA.md "What is kept how long"). */
export const KEEP_DAYS = 14

export interface SqliteStoreOptions {
  /** The database file, or `:memory:` (tests; the CLI modes when there is no file yet). */
  readonly filename: string
  /** Read only (the CLI modes): writes are refused; a file is opened read-only. */
  readonly readOnly?: boolean
  /** Where backups go. Default `<directory of the file>/backups`. */
  readonly backupDir?: string
  /** A second directory every backup is also copied to (a mounted share). */
  readonly backupCopyDir?: string
  /** Days (and daily backups) kept. Default `KEEP_DAYS`. */
  readonly keepBackups?: number
  /** Log lines (migrations, backups). */
  readonly log?: (line: string) => void
  /** Run file operations so the data directory's writer lock waits for them (serve: `DataDirLock.guard`). */
  readonly guard?: FileGuard
  /** First retry of a checkpoint a reader blocked, in ms (tests). Default 1000. */
  readonly scrubRetryMs?: number
}

export interface SqliteHouseholdStore extends HouseholdStore {
  /** The newest backup's time (epoch ms), or `undefined` when there is none. */
  readonly lastBackupAt: Effect.Effect<number | undefined>
  readonly backupDir: string | undefined
  /** `PRAGMA quick_check` (doctor; it reads the whole file, so never on a turn). */
  readonly check: Effect.Effect<string, StoreError>
  /** Remove backups and set-aside copies past their time (maintenance). Returns the names removed. */
  readonly pruneBackups: (options?: { readonly now?: number }) => Effect.Effect<ReadonlyArray<string>>
  /**
   * Since when a removed row's content may still be in the file or its log (a checkpoint a reader blocked; it is retried),
   * or `undefined` when nothing is pending.
   */
  readonly erasePendingSince: () => number | undefined
  /** Wait until no removal is pending (tests; doctor). */
  readonly scrubbed: Effect.Effect<void>
}

const CORE_DDL = [
  `CREATE TABLE pva_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE pva_versions (owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (owner, name)) WITHOUT ROWID`,
  `CREATE TABLE pva_docs (
    module TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    rev INTEGER NOT NULL, v INTEGER NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
    PRIMARY KEY (module, collection, id)
  ) WITHOUT ROWID`,
  `CREATE INDEX pva_docs_updated ON pva_docs (module, collection, scope_kind, scope_id, updated_at, id)`,
  `CREATE INDEX pva_docs_created ON pva_docs (module, collection, scope_kind, scope_id, created_at, id)`,
  `CREATE INDEX pva_docs_conversation ON pva_docs (scope_id) WHERE scope_kind = 'conversation'`,
  `CREATE TABLE pva_indexes (name TEXT PRIMARY KEY, module TEXT NOT NULL, collection TEXT NOT NULL, field TEXT NOT NULL, ddl TEXT NOT NULL) WITHOUT ROWID`
]

/**
 * The statements of a core migration (trusted code): split at each `;` outside quotes and comments. A trigger body
 * (`BEGIN … END`) is not supported here; a core service that needs one writes it as its own migration step.
 */
const statementsOf = (sql: string): ReadonlyArray<string> => {
  const out: Array<string> = []
  let start = 0
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!
    if (c === "'" || c === "\"" || c === "`") {
      const end = sql.indexOf(c, i + 1)
      if (end < 0) throw new Error("an unclosed quote")
      i = end
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1)
      if (end < 0) throw new Error("an unclosed [")
      i = end
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i)
      i = end < 0 ? sql.length : end
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end < 0) throw new Error("an unclosed comment")
      i = end + 1
    } else if (c === ";") {
      if (sql.slice(start, i).trim().length > 0) out.push(sql.slice(start, i))
      start = i + 1
    }
  }
  if (sql.slice(start).trim().length > 0) out.push(sql.slice(start))
  return out
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/
const OWNER = /^[a-z][a-z0-9]{0,30}$/
const sha = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n)

/** The index of a collection's field: a name from a hash of the exact module, collection and field (case kept). */
export const indexName = (module: string, collection: string, field: string) => `pva_ix_${sha(`${module}\u0000${collection}\u0000${field}`, 32)}`
const fieldExpr = (field: string) => `json_extract(value, '$.${field}')`
const indexDdl = (name: string, module: string, collection: string, field: string) =>
  `CREATE INDEX ${name} ON pva_docs (module, collection, scope_kind, scope_id, ${fieldExpr(field)}, updated_at, id) WHERE module = ${lit(module)} AND collection = ${lit(collection)}`

/**
 * The SQL of one list read (`CheckedQuery`). Each shape names its index (`INDEXED BY`): a query that could not use it
 * fails ("no query solution") instead of scanning, and the order is the index's own, so SQLite never sorts the
 * matching rows: it reads at most `limit` index entries.
 */
export const listSql = (module: string, collection: string, scope: ScopeRef, q: CheckedQuery): { readonly sql: string; readonly params: ReadonlyArray<unknown> } => {
  const dir = q.order.desc ? "DESC" : "ASC"
  const where = [`module = ${lit(module)}`, `collection = ${lit(collection)}`, "scope_kind = ?", "scope_id = ?"]
  const params: Array<unknown> = [scope.kind, scopeIdOf(scope)]
  let index: string
  let order: string
  if (q.where !== undefined) {
    const [field, value] = q.where
    index = indexName(module, collection, field)
    if (value === null) where.push(`${fieldExpr(field)} IS NULL`)
    else {
      where.push(`${fieldExpr(field)} = ?`)
      params.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
    }
    // Ordered by the filtered field itself: it is the same in every row, so the order is its tie-break's.
    order = `updated_at ${dir}, id ${dir}`
  } else if (q.order.column) {
    const created = q.order.field === "createdAt"
    index = created ? "pva_docs_created" : "pva_docs_updated"
    order = `${created ? "created_at" : "updated_at"} ${dir}, id ${dir}`
  } else {
    index = indexName(module, collection, q.order.field)
    order = `${fieldExpr(q.order.field)} ${dir}, updated_at ${dir}, id ${dir}`
  }
  params.push(q.limit)
  return { sql: `SELECT * FROM pva_docs INDEXED BY ${index} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`, params }
}

interface DocRow {
  readonly module: string
  readonly collection: string
  readonly id: string
  readonly scope_kind: string
  readonly scope_id: string
  readonly rev: number
  readonly v: number
  readonly value: string
  readonly created_at: number
  readonly updated_at: number
  readonly updated_by: string
}

const toDoc = (r: DocRow): StoredDoc => ({
  module: r.module,
  collection: r.collection,
  id: r.id,
  scope: scopeFromColumns(r.scope_kind, r.scope_id),
  rev: Number(r.rev),
  v: Number(r.v),
  text: r.value,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  updatedBy: JSON.parse(r.updated_by) as Actor
})

const localDate = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const DAILY_OR_BEFORE = /^household-\d{4}-\d{2}-\d{2}(-before-[a-z0-9-]+)?\.db$/

/**
 * Before the file is opened for writing (which switches it to WAL, a change to its header): read it read-only and
 * refuse a household schema this version does not know. A newer database or backup is never touched.
 */
const preflight = async (filename: string): Promise<string | undefined> => {
  const s = await stat(filename).catch(() => undefined)
  if (s === undefined || s.size === 0) return undefined
  const { DatabaseSync } = await sqlite()
  let db: InstanceType<typeof DatabaseSync> | undefined
  try {
    db = new DatabaseSync(filename, { readOnly: true })
    const meta = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'pva_meta'").get() as { n: number }
    if (Number(meta.n) === 0) return undefined
    const schema = Number((db.prepare("SELECT value FROM pva_meta WHERE key = 'schema'").get() as { value: string } | undefined)?.value ?? "0")
    if (schema > CORE_SCHEMA_VERSION) {
      return `${filename} was written by a newer version of the assistant (household schema ${schema}; this version knows ${CORE_SCHEMA_VERSION}). ` +
        "Update the assistant, or restore a backup made by this version (docs/STORING-DATA.md, \"Restoring a backup\")."
    }
    return undefined
  } catch (e) {
    return `${filename} cannot be read as a database: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    db?.close()
  }
}

export const makeSqliteStore = (options: SqliteStoreOptions): Effect.Effect<SqliteHouseholdStore, StoreError, Scope.Scope> =>
  Effect.gen(function*() {
    const memory = options.filename === ":memory:"
    const readOnly = options.readOnly === true
    const log = options.log ?? (() => {})
    const keep = options.keepBackups ?? KEEP_DAYS
    const guard = options.guard ?? unguarded
    const backupDir = memory ? options.backupDir : options.backupDir ?? join(dirname(options.filename), "backups")
    const files = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: () => guard(what, run), catch: (cause) => new StoreError({ reason: "failed", message: `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause }) })

    const toStoreError = (what: string) => (e: SqlError): StoreError =>
      new StoreError({
        reason: /readonly|read-only/i.test(e.message) ? "read-only" : "failed",
        message: `${what}: ${e.message}${e.cause instanceof Error && e.cause.message !== e.message ? ` (${e.cause.message})` : ""}`,
        cause: e
      })

    // ---- Open: read-only first (a newer file is refused untouched), private files, then the connection

    if (!memory) {
      const refused = yield* Effect.promise(() => preflight(options.filename))
      if (refused !== undefined) return yield* new StoreError({ reason: "unavailable", message: refused })
      if (!readOnly) {
        yield* files(`Preparing ${options.filename}`, async () => {
          await privateDir(dirname(options.filename))
          // A new database is created 0600 (SQLite gives its -wal and -shm the same mode); an existing one is narrowed.
          const handle = await open(options.filename, "a", 0o600)
          await handle.close()
          for (const f of [options.filename, `${options.filename}-wal`, `${options.filename}-shm`]) await narrow(f)
        })
      }
    }
    // Loaded here, not imported at the top: `node:sqlite` is a built-in, linked (and its ExperimentalWarning printed)
    // before any module code runs, so only a dynamic import comes after the warning filter (`quiet.ts`).
    const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-node"))
    const client = yield* SqliteClient.make({
      filename: options.filename,
      readonly: readOnly && !memory,
      disableWAL: memory,
      prepareCacheSize: 500,
      // A writer waits for no one (the server is the only writer; readers never block it in WAL), and the checkpoint
      // after a removal sets 0 itself: a busy wait would stop the event loop.
      busyTimeout: readOnly ? "1 second" : "20 millis"
    }).pipe(Effect.provide(Reactivity.layer), Effect.mapError(toStoreError(`Could not open ${options.filename}`)))

    const query = <R>(sql: string, params: ReadonlyArray<unknown> = []): Effect.Effect<ReadonlyArray<R>, StoreError> =>
      client.unsafe<any>(sql, params).pipe(Effect.mapError(toStoreError("A query of the household store failed"))) as Effect.Effect<ReadonlyArray<R>, StoreError>
    const exec = (sql: string, params: ReadonlyArray<unknown> = []): Effect.Effect<{ readonly changes: number; readonly lastInsertRowid: number }, StoreError> =>
      client.unsafe(sql, params).raw.pipe(
        Effect.map((r) => {
          const x = r as { changes?: number | bigint; lastInsertRowid?: number | bigint }
          return { changes: Number(x.changes ?? 0), lastInsertRowid: Number(x.lastInsertRowid ?? 0) }
        }),
        Effect.mapError(toStoreError("A write to the household store failed"))
      )

    // ---- Commit listeners and the transaction model

    const listeners = new Set<(changes: ReadonlyArray<CommittedChange>) => void>()
    const fire = (changes: ReadonlyArray<CommittedChange>) => {
      if (changes.length === 0) return
      for (const l of listeners) {
        try {
          l(changes)
        } catch {
          // A listener must not break a commit.
        }
      }
    }
    const driverTx = <X, E, R>(work: Effect.Effect<X, E, R>): Effect.Effect<X, E | StoreError, R> =>
      client.withTransaction(work).pipe(
        Effect.mapError((e) => (isSqlError(e) ? toStoreError("A household store transaction failed")(e as SqlError) : e) as E | StoreError)
      )
    const tx = makeTransactions({
      outer: driverTx,
      inner: driverTx,
      release: (items: ReadonlyArray<OutboxItem>) => {
        let run: Array<CommittedChange> = []
        for (const item of items) {
          if (item._tag === "change") {
            run.push(item.change)
            continue
          }
          fire(run)
          run = []
          try {
            item.run()
          } catch {
            // An after-commit callback must not break the others.
          }
        }
        fire(run)
      }
    })

    // ---- Settings, the core schema

    if (!readOnly) {
      yield* exec("PRAGMA synchronous = NORMAL")
      yield* exec("PRAGMA secure_delete = ON")
    }
    // Views and triggers may not call functions with side effects.
    yield* exec("PRAGMA trusted_schema = OFF")
    const hasMeta = (yield* query<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'pva_meta'"))[0]!.n > 0
    const metaOf = (key: string) => Effect.map(query<{ value: string }>("SELECT value FROM pva_meta WHERE key = ?", [key]), (r) => r[0]?.value)
    let created = false
    if (!hasMeta) {
      if (readOnly && !memory) return yield* new StoreError({ reason: "unavailable", message: `${options.filename} holds no household data yet` })
      yield* driverTx(Effect.gen(function*() {
        for (const ddl of CORE_DDL) yield* exec(ddl)
        const at = yield* Clock.currentTimeMillis
        yield* exec("INSERT INTO pva_meta (key, value) VALUES ('schema', ?), ('created', ?), ('rev', '0')", [String(CORE_SCHEMA_VERSION), String(at)])
      }))
      created = true
    } else {
      // Checked again on the open connection (the preflight read the same file a moment ago).
      const schema = Number((yield* metaOf("schema")) ?? "0")
      if (schema > CORE_SCHEMA_VERSION) {
        return yield* new StoreError({ reason: "unavailable", message: `${options.filename} was written by a newer version of the assistant (household schema ${schema}; this version knows ${CORE_SCHEMA_VERSION})` })
      }
    }

    // ---- Removal: the checkpoint after a removal, in the background, retried while a reader holds an old snapshot

    let erasePendingSince: number | undefined
    const scrubWake = yield* Queue.sliding<void>(1)
    const scrubDone = new Set<() => void>()
    const scrub = () => {
      if (memory || readOnly) return
      erasePendingSince ??= Date.now()
      Queue.offerUnsafe(scrubWake, undefined)
    }
    /** One TRUNCATE checkpoint that never waits: true when the log is empty afterwards (no reader held it). */
    const checkpointNow = tx.statement(Effect.gen(function*() {
      yield* exec("PRAGMA busy_timeout = 0")
      const r = yield* query<{ busy: number; log: number; checkpointed: number }>("PRAGMA wal_checkpoint(TRUNCATE)").pipe(
        Effect.ensuring(exec("PRAGMA busy_timeout = 20").pipe(Effect.ignore))
      )
      return Number(r[0]?.busy ?? 1) === 0
    }))
    if (!memory && !readOnly) {
      yield* Effect.forkScoped(Effect.forever(Effect.gen(function*() {
        yield* Queue.take(scrubWake)
        let wait = options.scrubRetryMs ?? 1000
        for (;;) {
          const done = yield* checkpointNow.pipe(Effect.orElseSucceed(() => false))
          if (done) break
          log(`A removed item is still in the household log: a reader holds an older snapshot; retrying in ${Math.round(wait / 1000)} s`)
          yield* Effect.sleep(wait)
          wait = Math.min(wait * 2, 60_000)
        }
        erasePendingSince = undefined
        for (const f of [...scrubDone]) f()
      })))
    }
    const scrubbed: Effect.Effect<void> = Effect.callback<void>((resume) => {
      if (erasePendingSince === undefined) return resume(Effect.void)
      const f = () => {
        scrubDone.delete(f)
        resume(Effect.void)
      }
      scrubDone.add(f)
      return Effect.sync(() => void scrubDone.delete(f))
    })

    // ---- The backend the collection semantics run on (no locks here: `tx` is taken by the callers)

    const backend: StoreBackend = {
      readOnly,
      tx,
      read: (module, collection, id) =>
        Effect.map(query<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id = ?", [module, collection, id]), (r) => (r[0] === undefined ? undefined : toDoc(r[0]))),
      list: (module, collection, scope, q) => {
        const { sql, params } = listSql(module, collection, scope, q)
        return Effect.map(query<DocRow>(sql, params), (rows) => rows.map(toDoc))
      },
      nextRev: Effect.map(
        query<{ value: string }>("UPDATE pva_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value"),
        (r) => Number(r[0]!.value)
      ),
      put: (doc, expect) =>
        Effect.gen(function*() {
          const r = expect === "absent"
            ? yield* exec(
              `INSERT INTO pva_docs (module, collection, id, scope_kind, scope_id, rev, v, value, created_at, updated_at, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              [doc.module, doc.collection, doc.id, doc.scope.kind, scopeIdOf(doc.scope), doc.rev, doc.v, doc.text, doc.createdAt, doc.updatedAt, JSON.stringify(doc.updatedBy)]
            )
            : yield* exec(
              `UPDATE pva_docs SET rev = ?, v = ?, value = ?, updated_at = ?, updated_by = ?
               WHERE module = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?`,
              [doc.rev, doc.v, doc.text, doc.updatedAt, JSON.stringify(doc.updatedBy), doc.module, doc.collection, doc.id, expect, doc.scope.kind, scopeIdOf(doc.scope)]
            )
          return r.changes === 1
        }),
      remove: (module, collection, id, scope, expect) =>
        Effect.gen(function*() {
          const r = yield* exec("DELETE FROM pva_docs WHERE module = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?", [module, collection, id, expect, scope.kind, scopeIdOf(scope)])
          return r.changes === 1
        }),
      scan: (module, collection, afterId, limit) =>
        Effect.map(query<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id > ? ORDER BY id LIMIT ?", [module, collection, afterId, limit]), (rows) => rows.map(toDoc)),
      rewrite: (doc, v, text) =>
        Effect.asVoid(exec("UPDATE pva_docs SET v = ?, value = ? WHERE module = ? AND collection = ? AND id = ?", [v, text, doc.module, doc.collection, doc.id])),
      scrub
    }

    const conversations = {
      docs: (conversationId: string | undefined) =>
        Effect.map(
          conversationId === undefined
            ? query<DocRow>("SELECT * FROM pva_docs INDEXED BY pva_docs_conversation WHERE scope_kind = 'conversation'")
            : query<DocRow>("SELECT * FROM pva_docs INDEXED BY pva_docs_conversation WHERE scope_kind = 'conversation' AND scope_id = ?", [conversationId]),
          (rows) => rows.map(toDoc)
        )
    }

    // ---- Versions and preparing modules

    const versionsOf = (owner: string) =>
      Effect.map(query<{ name: string; version: number }>("SELECT name, version FROM pva_versions WHERE owner = ?", [owner]), (rows) =>
        new Map(rows.map((r) => [r.name, Number(r.version)])))
    const setVersion = (owner: string, name: string, version: number) =>
      exec("INSERT INTO pva_versions (owner, name, version) VALUES (?, ?, ?) ON CONFLICT (owner, name) DO UPDATE SET version = excluded.version", [owner, name, version])

    const verdicts = new Map<string, ModuleUnavailable>()
    const declared = new Map<string, { readonly collections: ReadonlyMap<string, Collection<any>> }>()
    const stores = new Map<string, ReturnType<typeof makeModuleStoreOn>>()
    let backedUpForUpgrade: string | undefined

    const hasRows = (module: string, collection: string) =>
      Effect.map(query<{ n: number }>("SELECT count(*) AS n FROM (SELECT 1 FROM pva_docs WHERE module = ? AND collection = ? LIMIT 1)", [module, collection]), (r) => Number(r[0]!.n) > 0)

    /** A backup before the first upgrade of this start (never of a new or in-memory file). */
    const backupBeforeUpgrade = (what: string) =>
      Effect.gen(function*() {
        if (memory || backupDir === undefined || backedUpForUpgrade !== undefined) return backedUpForUpgrade
        if (created) return undefined
        const at = yield* Clock.currentTimeMillis
        const path = join(backupDir, `household-${localDate(at)}-before-${what}.db`)
        yield* files(`Backing up to ${path}`, () => copyDatabase(options.filename, path))
        backedUpForUpgrade = path
        log(`Household data backed up to ${path} before upgrading ${what}`)
        return path
      })

    /** Make the collection indexes of a module exactly the declared ones (registry `pva_indexes`). */
    const syncIndexes = (moduleId: string, collections: ReadonlyMap<string, Collection<any>>) =>
      Effect.gen(function*() {
        const want = new Map<string, { collection: string; field: string; ddl: string }>()
        for (const c of collections.values()) {
          for (const field of c.indexes) {
            const name = indexName(moduleId, c.name, field)
            want.set(name, { collection: c.name, field, ddl: indexDdl(name, moduleId, c.name, field) })
          }
        }
        const have = yield* query<{ name: string; ddl: string }>("SELECT name, ddl FROM pva_indexes WHERE module = ?", [moduleId])
        const existing = new Set((yield* query<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'pva_ix_%'")).map((r) => r.name))
        for (const h of have) {
          const w = want.get(h.name)
          if (w !== undefined && w.ddl === h.ddl && existing.has(h.name)) {
            want.delete(h.name)
            continue
          }
          yield* exec(`DROP INDEX IF EXISTS ${h.name}`)
          yield* exec("DELETE FROM pva_indexes WHERE name = ?", [h.name])
        }
        for (const [name, w] of want) {
          yield* exec(`DROP INDEX IF EXISTS ${name}`)
          yield* exec(w.ddl)
          yield* exec("INSERT INTO pva_indexes (name, module, collection, field, ddl) VALUES (?, ?, ?, ?, ?)", [name, moduleId, w.collection, w.field, w.ddl])
        }
      })

    const prepareOne = (m: StoredModule) =>
      Effect.gen(function*() {
        const owner = `module:${m.id}`
        const collections = new Map((m.storage?.collections ?? []).map((c) => [c.name, c]))
        declared.set(m.id, { collections })
        stores.delete(m.id)
        verdicts.delete(m.id)
        if (!MODULE_ID.test(m.id)) return void verdicts.set(m.id, { reason: "Its id cannot key stored data." })
        const stored = yield* versionsOf(owner)
        const newer = [...collections.values()].find((c) => (stored.get(`collection:${c.name}`) ?? 0) > c.version)
        if (newer !== undefined) {
          return void verdicts.set(m.id, {
            reason: `Its stored data (${newer.name}, version ${stored.get(`collection:${newer.name}`)}) was written by a newer version of this module (this one knows ${newer.version}); update the module. The data is kept as it is.`
          })
        }
        const pendingCollections = [...collections.values()].filter((c) => (stored.get(`collection:${c.name}`) ?? 0) < c.version)
        // Rows to rewrite: a collection whose stored version is older and that has rows.
        let rewrites = false
        for (const c of pendingCollections) if (stored.has(`collection:${c.name}`) && (yield* hasRows(m.id, c.name))) rewrites = true
        if (readOnly) {
          if (rewrites) verdicts.set(m.id, { reason: "Its stored data needs an upgrade, which the server makes when it starts (pnpm start serve)." })
          return
        }
        let backup: string | undefined
        if (rewrites) {
          const done = yield* Effect.result(backupBeforeUpgrade(m.id))
          if (done._tag === "Failure") {
            return void verdicts.set(m.id, { reason: `Its data needs an upgrade, and the backup before it failed (${done.failure.message}); nothing was changed.` })
          }
          backup = done.success
        }
        const upgraded = yield* Effect.result(tx.transaction(Effect.gen(function*() {
          for (const c of pendingCollections) {
            const n = yield* migrateCollectionOn(backend, m.id, c)
            if (n > 0) log(`Module ${m.id}: ${n} row(s) of ${c.name} migrated to version ${c.version}`)
            yield* setVersion(owner, `collection:${c.name}`, c.version)
          }
          yield* syncIndexes(m.id, collections)
        })))
        if (upgraded._tag === "Failure") {
          const where = backup !== undefined ? ` A backup from before is at ${backup}.` : ""
          log(`Module ${m.id}: upgrading its data failed: ${upgraded.failure.message}`)
          return void verdicts.set(m.id, { reason: `Its data could not be upgraded (${upgraded.failure.message}); it was left as it was.${where}` })
        }
      })

    // ---- Backups (a connection of their own, the copy on a worker thread)

    const backup = (opts?: { readonly now?: number }) =>
      Effect.gen(function*() {
        if (memory || backupDir === undefined) return yield* new StoreError({ reason: "unavailable", message: "An in-memory store has no backups" })
        const at = opts?.now ?? (yield* Clock.currentTimeMillis)
        const name = `household-${localDate(at)}.db`
        const path = join(backupDir, name)
        yield* files(`Backing up to ${path}`, () => copyDatabase(options.filename, path))
        if (options.backupCopyDir !== undefined) {
          const copyDir = options.backupCopyDir
          yield* files(`Copying the backup to ${copyDir}`, () => copyFilePrivately(path, join(copyDir, name)))
        }
        yield* pruneBackups({ now: at })
        return { path }
      })

    const pruneBackups = (opts?: { readonly now?: number }) =>
      Effect.gen(function*() {
        if (memory) return [] as ReadonlyArray<string>
        const now = opts?.now ?? (yield* Clock.currentTimeMillis)
        const dirs = [backupDir, options.backupCopyDir, memory ? undefined : dirname(options.filename)].filter((d): d is string => d !== undefined)
        const removed: Array<string> = []
        for (const dir of dirs) {
          const done = yield* files(`Removing old backups in ${dir}`, () => pruneArchives(dir, now, keep)).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
          removed.push(...done)
        }
        if (removed.length > 0) log(`Household backups past ${keep} days removed: ${removed.join(", ")}`)
        return removed as ReadonlyArray<string>
      })

    const lastBackupAt = Effect.promise(async () => {
      if (backupDir === undefined) return undefined
      let newest: number | undefined
      for (const n of await readdir(backupDir).catch(() => [] as Array<string>)) {
        if (!DAILY_OR_BEFORE.test(n)) continue
        const s = await stat(join(backupDir, n)).catch(() => undefined)
        if (s !== undefined && (newest === undefined || s.mtimeMs > newest)) newest = s.mtimeMs
      }
      return newest
    })

    // ---- The rest of the host's view

    const forModule = (moduleId: string) => {
      let s = stores.get(moduleId)
      if (s === undefined) {
        s = makeModuleStoreOn(backend, moduleId, declared.get(moduleId)?.collections ?? new Map(), () => verdicts.get(moduleId))
        stores.set(moduleId, s)
      }
      return s
    }

    const lastSeqRaw = Effect.map(query<{ value: string }>("SELECT value FROM pva_meta WHERE key = 'rev'"), (r) => Number(r[0]?.value ?? 0))

    const core = (owner: string): CoreSql => {
      const prefix = `core_${owner}__`
      const valid = OWNER.test(owner)
      const bad = Effect.fail(new StoreError({ reason: "invalid", message: `"${owner}" is not a core owner name` }))
      return {
        prefix,
        query: (sql, params = []) => (valid ? tx.statement(query(sql, params)) : bad),
        run: (sql, params = []) => (!valid ? bad : readOnly ? Effect.fail(readOnlyError(`core ${owner}`)) : tx.statement(exec(sql, params))),
        migrate: (migrations) =>
          Effect.gen(function*() {
            if (!valid) return yield* bad
            const versions = yield* tx.statement(versionsOf(`core:${owner}`))
            const at = versions.get("sql") ?? 0
            if (at > migrations.length) {
              return yield* new StoreError({ reason: "unavailable", message: `The ${owner} tables were written by a newer version of the assistant (${at} > ${migrations.length})` })
            }
            if (at === migrations.length) return
            if (readOnly) return yield* new StoreError({ reason: "unavailable", message: `The ${owner} tables need an upgrade, which the server makes when it starts` })
            yield* backupBeforeUpgrade(owner)
            const statements = yield* Effect.try({
              try: () => migrations.map((m) => statementsOf(m)),
              catch: (cause) => new StoreError({ reason: "invalid", message: `The ${owner} migrations cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
            })
            yield* tx.transaction(Effect.gen(function*() {
              for (let i = at; i < migrations.length; i++) {
                for (const statement of statements[i]!) yield* exec(statement)
                yield* setVersion(`core:${owner}`, "sql", i + 1)
              }
            }))
          })
      }
    }

    const store: SqliteHouseholdStore = {
      info: { kind: "sqlite", readOnly, ...(memory ? {} : { path: options.filename }) },
      prepare: (modules) => Effect.forEach(modules, prepareOne, { discard: true }),
      availability: (moduleId) => verdicts.get(moduleId),
      forModule,
      transaction: tx.transaction,
      afterCommit: (f) => tx.enqueue({ _tag: "run", run: f }),
      core,
      lastSeq: tx.statement(lastSeqRaw),
      endConversation: (conversationId) => (readOnly ? Effect.succeed(0) : endConversationsOn(backend, conversations, conversationId, () => [...verdicts.keys()])),
      sweepConversations: readOnly ? Effect.succeed(0) : endConversationsOn(backend, conversations, undefined, () => [...verdicts.keys()]),
      backup,
      onCommit: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      lastBackupAt,
      backupDir,
      pruneBackups,
      erasePendingSince: () => erasePendingSince,
      scrubbed,
      check: tx.statement(Effect.map(query<{ quick_check: string }>("PRAGMA quick_check"), (r) => r.map((x) => Object.values(x)[0]).join("; ")))
    }
    return store
  })

export type { ScopeRef }
