import "./quiet.ts"
import {
  type Actor,
  CHANGE_RETENTION_MS,
  type ChangeRecord,
  type CheckedQuery,
  type Collection,
  type CommittedChange,
  type CoreSql,
  type HouseholdStore,
  type ModuleExport,
  type ModuleSql,
  makeTransactions,
  type OutboxItem,
  readOnlyError,
  type ScopeRef,
  scopeFromColumns,
  scopeIdOf,
  type SqlMigration,
  sqlPrefixOf,
  type SqlValue,
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
import { checkModuleStatement, coreStatements, type GuardContext, migrationStatements } from "./SqlGuard.ts"

/**
 * The household store on SQLite (docs/STORING-DATA.md; shared-state-jobs-and-notifications.md §4.1): one file
 * (`data/household.db`, mode 0600 in a 0700 directory), WAL, `synchronous = NORMAL`, `secure_delete = ON`, one
 * connection through `@effect/sql-sqlite-node` on Node's built-in `node:sqlite` (no native build), with the
 * transaction model of `StoreTransactions.ts` on top of the driver's transactions and savepoints.
 *
 * Every statement on that connection is synchronous on the main thread, which also frames audio. So every read a turn
 * can make is one index range with a row limit (`INDEXED BY`, so a query that cannot use its index fails instead of
 * scanning), writes touch single rows, and everything long runs elsewhere: backups and exports read through a
 * connection of their own (backups in one step on a worker thread), retention deletes in small transactions with a
 * yield between them, and the checkpoint after an erase runs in the background, never waiting for a reader.
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
   * Since when an erase's content may still be in the file or its log (a checkpoint a reader blocked; it is retried),
   * or `undefined` when nothing is pending.
   */
  readonly erasePendingSince: () => number | undefined
  /** Wait until no erase is pending (tests; doctor). */
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
    search_id INTEGER,
    PRIMARY KEY (module, collection, id)
  ) WITHOUT ROWID`,
  `CREATE INDEX pva_docs_updated ON pva_docs (module, collection, scope_kind, scope_id, updated_at, id)`,
  `CREATE INDEX pva_docs_created ON pva_docs (module, collection, scope_kind, scope_id, created_at, id)`,
  `CREATE INDEX pva_docs_conversation ON pva_docs (scope_id) WHERE scope_kind = 'conversation'`,
  `CREATE UNIQUE INDEX pva_docs_search ON pva_docs (search_id) WHERE search_id IS NOT NULL`,
  `CREATE TABLE pva_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    op_id TEXT NOT NULL UNIQUE,
    module TEXT NOT NULL, collection TEXT NOT NULL,
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    row_id TEXT NOT NULL, op TEXT NOT NULL,
    actor TEXT NOT NULL, actor_key TEXT NOT NULL, at INTEGER NOT NULL,
    data TEXT, undoes TEXT, undone INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX pva_changes_row ON pva_changes (module, collection, row_id, seq)`,
  `CREATE INDEX pva_changes_undoable ON pva_changes (module, collection, actor_key, scope_kind, scope_id, seq)
    WHERE undone = 0 AND undoes IS NULL AND op != 'erase' AND data IS NOT NULL`,
  `CREATE INDEX pva_changes_at ON pva_changes (at)`,
  `CREATE INDEX pva_changes_conversation ON pva_changes (scope_id) WHERE scope_kind = 'conversation'`,
  `CREATE TABLE pva_indexes (name TEXT PRIMARY KEY, module TEXT NOT NULL, collection TEXT NOT NULL, field TEXT NOT NULL, ddl TEXT NOT NULL) WITHOUT ROWID`,
  // Search: the words (`searchTokens`, made in JS, the same as the in-memory store) separated by spaces, which the
  // `ascii` tokenizer splits back into exactly those words; `k` is a token naming the row's module, collection and scope.
  `CREATE VIRTUAL TABLE pva_search USING fts5(k, t, tokenize = 'ascii', prefix = '2 3', detail = 'column')`,
  `INSERT INTO pva_search (pva_search, rank) VALUES ('secure-delete', 1)`
]

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/
const OWNER = /^[a-z][a-z0-9]{0,30}$/
const sha = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n)

/** The index of a collection's field: a name from a hash of the exact module, collection and field (case kept). */
export const indexName = (module: string, collection: string, field: string) => `pva_ix_${sha(`${module}\u0000${collection}\u0000${field}`, 32)}`
const fieldExpr = (field: string) => `json_extract(value, '$.${field}')`
const indexDdl = (name: string, module: string, collection: string, field: string) =>
  `CREATE INDEX ${name} ON pva_docs (module, collection, scope_kind, scope_id, ${fieldExpr(field)}, updated_at, id) WHERE module = ${lit(module)} AND collection = ${lit(collection)}`
/** The search token of a module's collection in one scope. */
export const scopeToken = (module: string, collection: string, scope: ScopeRef) => `k${sha(`${module}\u0000${collection}\u0000${scope.kind}\u0000${scopeIdOf(scope)}`, 40)}`

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
  readonly search_id: number | null
}

interface ChangeRow {
  readonly seq: number
  readonly op_id: string
  readonly module: string
  readonly collection: string
  readonly scope_kind: string
  readonly scope_id: string
  readonly row_id: string
  readonly op: string
  readonly actor: string
  readonly at: number
  readonly data: string | null
  readonly undoes: string | null
  readonly undone: number
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

const toChange = (r: ChangeRow): ChangeRecord => ({
  seq: Number(r.seq),
  opId: r.op_id,
  at: Number(r.at),
  module: r.module,
  collection: r.collection,
  id: r.row_id,
  op: r.op as ChangeRecord["op"],
  rev: Number(r.seq),
  scope: scopeFromColumns(r.scope_kind, r.scope_id),
  actor: JSON.parse(r.actor) as Actor,
  ...(r.data !== null ? { payload: JSON.parse(r.data) as NonNullable<ChangeRecord["payload"]> } : {}),
  ...(r.undoes !== null ? { undoes: r.undoes } : {}),
  undone: Number(r.undone) !== 0
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
        "Update the assistant, or restore a backup made by this version (docs/STORING-DATA.md, \"Restore\")."
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
      // after an erase sets 0 itself: a busy wait would stop the event loop.
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
    // Module views and triggers may not call functions with side effects.
    yield* exec("PRAGMA trusted_schema = OFF")
    const fts5 = yield* query<{ n: number }>("SELECT count(*) AS n FROM pragma_module_list WHERE name = 'fts5'").pipe(Effect.map((r) => Number(r[0]?.n ?? 0) > 0))
    const vtableModules = new Set((yield* query<{ name: string }>("SELECT lower(name) AS name FROM pragma_module_list")).map((r) => r.name))
    const hasMeta = (yield* query<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'pva_meta'"))[0]!.n > 0
    const metaOf = (key: string) => Effect.map(query<{ value: string }>("SELECT value FROM pva_meta WHERE key = ?", [key]), (r) => r[0]?.value)
    let created = false
    if (!hasMeta) {
      if (readOnly && !memory) return yield* new StoreError({ reason: "unavailable", message: `${options.filename} holds no household data yet` })
      if (!fts5) return yield* new StoreError({ reason: "unavailable", message: "This Node's SQLite has no full-text search (FTS5), which the household store needs" })
      yield* driverTx(Effect.gen(function*() {
        for (const ddl of CORE_DDL) yield* exec(ddl)
        const at = yield* Clock.currentTimeMillis
        yield* exec("INSERT INTO pva_meta (key, value) VALUES ('schema', ?), ('created', ?)", [String(CORE_SCHEMA_VERSION), String(at)])
      }))
      created = true
    } else {
      // Checked again on the open connection (the preflight read the same file a moment ago).
      const schema = Number((yield* metaOf("schema")) ?? "0")
      if (schema > CORE_SCHEMA_VERSION) {
        return yield* new StoreError({ reason: "unavailable", message: `${options.filename} was written by a newer version of the assistant (household schema ${schema}; this version knows ${CORE_SCHEMA_VERSION})` })
      }
      if (!fts5) return yield* new StoreError({ reason: "unavailable", message: `${options.filename} uses full-text search (FTS5), which this Node's SQLite does not have` })
    }

    // ---- Names in the schema (the SQL guard's "outside the prefix" list)

    let schemaNames: ReadonlySet<string> = new Set()
    const verdictCache = new Map<string, string | undefined>()
    const refreshNames = Effect.map(query<{ name: string }>("SELECT lower(name) AS name FROM sqlite_schema"), (rows) => {
      schemaNames = new Set(rows.map((r) => r.name))
      verdictCache.clear()
    })
    yield* refreshNames

    // ---- Search entries

    const searchIdOf = (module: string, collection: string, id: string) =>
      Effect.map(query<{ search_id: number | null }>("SELECT search_id FROM pva_docs WHERE module = ? AND collection = ? AND id = ?", [module, collection, id]), (r) =>
        r[0]?.search_id === null || r[0]?.search_id === undefined ? undefined : Number(r[0].search_id))
    /** Set a row's search words: a new entry (newest in search order), or the same entry again (`keepOrder`, migration). */
    const setSearch = (doc: StoredDoc, tokens: ReadonlyArray<string>, keepOrder: boolean) =>
      Effect.gen(function*() {
        const old = yield* searchIdOf(doc.module, doc.collection, doc.id)
        if (old !== undefined) yield* exec("DELETE FROM pva_search WHERE rowid = ?", [old])
        if (tokens.length === 0) {
          if (old !== undefined) yield* exec("UPDATE pva_docs SET search_id = NULL WHERE module = ? AND collection = ? AND id = ?", [doc.module, doc.collection, doc.id])
          return
        }
        const k = scopeToken(doc.module, doc.collection, doc.scope)
        const r = keepOrder && old !== undefined
          ? yield* exec("INSERT INTO pva_search (rowid, k, t) VALUES (?, ?, ?)", [old, k, tokens.join(" ")])
          : yield* exec("INSERT INTO pva_search (k, t) VALUES (?, ?)", [k, tokens.join(" ")])
        yield* exec("UPDATE pva_docs SET search_id = ? WHERE module = ? AND collection = ? AND id = ?", [r.lastInsertRowid, doc.module, doc.collection, doc.id])
      })

    // ---- Erasure: the checkpoint after an erase, in the background, retried while a reader holds an old snapshot

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
          log(`An erased item is still in the household log: a reader holds an older snapshot; retrying in ${Math.round(wait / 1000)} s`)
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
      fts5,
      tx,
      read: (module, collection, id) =>
        Effect.map(query<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id = ?", [module, collection, id]), (r) => (r[0] === undefined ? undefined : toDoc(r[0]))),
      list: (module, collection, scope, q) => {
        const { sql, params } = listSql(module, collection, scope, q)
        return Effect.map(query<DocRow>(sql, params), (rows) => rows.map(toDoc))
      },
      search: (module, collection, scope, words, limit) =>
        Effect.gen(function*() {
          const match = [`k : "${scopeToken(module, collection, scope)}"`, ...words.map((w) => `t : "${w}"*`)].join(" AND ")
          const ids = (yield* query<{ rowid: number }>("SELECT rowid FROM pva_search WHERE pva_search MATCH ? ORDER BY rowid DESC LIMIT ?", [match, limit])).map((r) => Number(r.rowid))
          if (ids.length === 0) return []
          const rows = yield* query<DocRow>(`SELECT * FROM pva_docs WHERE search_id IN (${ids.map(() => "?").join(", ")})`, ids)
          const byId = new Map(rows.map((r) => [Number(r.search_id), r]))
          return ids.flatMap((id) => {
            const r = byId.get(id)
            return r !== undefined && r.module === module && r.collection === collection && r.scope_kind === scope.kind && r.scope_id === scopeIdOf(scope) ? [toDoc(r)] : []
          })
        }),
      append: (c) =>
        Effect.map(
          exec(
            `INSERT INTO pva_changes (op_id, module, collection, scope_kind, scope_id, row_id, op, actor, actor_key, at, data, undoes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              c.opId,
              c.module,
              c.collection,
              c.scope.kind,
              scopeIdOf(c.scope),
              c.id,
              c.op,
              JSON.stringify(c.actor),
              c.actorKey,
              c.at,
              c.payload === undefined ? null : JSON.stringify(c.payload),
              c.undoes ?? null
            ]
          ),
          (r) => r.lastInsertRowid
        ),
      put: (doc, expect, tokens) =>
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
          if (r.changes !== 1) return false
          yield* setSearch(doc, tokens, false)
          return true
        }),
      remove: (module, collection, id, scope, expect) =>
        Effect.gen(function*() {
          const old = yield* searchIdOf(module, collection, id)
          const r = yield* exec("DELETE FROM pva_docs WHERE module = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?", [module, collection, id, expect, scope.kind, scopeIdOf(scope)])
          if (r.changes !== 1) return false
          if (old !== undefined) yield* exec("DELETE FROM pva_search WHERE rowid = ?", [old])
          return true
        }),
      lastUndoable: (module, collection, actorKey, scope) =>
        Effect.map(
          query<ChangeRow>(
            `SELECT * FROM pva_changes INDEXED BY pva_changes_undoable
             WHERE module = ? AND collection = ? AND actor_key = ? AND scope_kind = ? AND scope_id = ?
               AND undone = 0 AND undoes IS NULL AND op != 'erase' AND data IS NOT NULL
             ORDER BY seq DESC LIMIT 1`,
            [module, collection, actorKey, scope.kind, scopeIdOf(scope)]
          ),
          (r) => (r[0] === undefined ? undefined : toChange(r[0]))
        ),
      markUndone: (seq) => Effect.asVoid(exec("UPDATE pva_changes SET undone = 1 WHERE seq = ?", [seq])),
      changedSince: (module, collection, id, seq) =>
        Effect.map(
          query<{ n: number }>(
            "SELECT count(*) AS n FROM (SELECT 1 FROM pva_changes WHERE module = ? AND collection = ? AND row_id = ? AND seq > ? AND undone = 0 AND undoes IS NULL LIMIT 1)",
            [module, collection, id, seq]
          ),
          (r) => Number(r[0]!.n) > 0
        ),
      purge: (module, collection, id, scope) =>
        Effect.asVoid(exec(
          "UPDATE pva_changes SET data = NULL WHERE module = ? AND collection = ? AND row_id = ? AND scope_kind = ? AND scope_id = ? AND data IS NOT NULL",
          [module, collection, id, scope.kind, scopeIdOf(scope)]
        )),
      scan: (module, collection, afterId, limit) =>
        Effect.map(query<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id > ? ORDER BY id LIMIT ?", [module, collection, afterId, limit]), (rows) => rows.map(toDoc)),
      rewrite: (doc, v, text, tokens) =>
        Effect.gen(function*() {
          yield* exec("UPDATE pva_docs SET v = ?, value = ? WHERE module = ? AND collection = ? AND id = ?", [v, text, doc.module, doc.collection, doc.id])
          yield* setSearch(doc, tokens, true)
        }),
      scrub
    }

    const conversations = {
      docs: (conversationId: string | undefined) =>
        Effect.map(
          conversationId === undefined
            ? query<DocRow>("SELECT * FROM pva_docs INDEXED BY pva_docs_conversation WHERE scope_kind = 'conversation'")
            : query<DocRow>("SELECT * FROM pva_docs INDEXED BY pva_docs_conversation WHERE scope_kind = 'conversation' AND scope_id = ?", [conversationId]),
          (rows) => rows.map(toDoc)
        ),
      purge: (conversationId: string | undefined) =>
        Effect.asVoid(conversationId === undefined
          ? exec("UPDATE pva_changes SET data = NULL WHERE scope_kind = 'conversation' AND data IS NOT NULL")
          : exec("UPDATE pva_changes SET data = NULL WHERE scope_kind = 'conversation' AND scope_id = ? AND data IS NOT NULL", [conversationId]))
    }

    // ---- Versions and preparing modules

    const versionsOf = (owner: string) =>
      Effect.map(query<{ name: string; version: number }>("SELECT name, version FROM pva_versions WHERE owner = ?", [owner]), (rows) =>
        new Map(rows.map((r) => [r.name, Number(r.version)])))
    const setVersion = (owner: string, name: string, version: number) =>
      exec("INSERT INTO pva_versions (owner, name, version) VALUES (?, ?, ?) ON CONFLICT (owner, name) DO UPDATE SET version = excluded.version", [owner, name, version])

    const verdicts = new Map<string, ModuleUnavailable>()
    const declared = new Map<string, { readonly collections: ReadonlyMap<string, Collection<any>>; readonly sql: boolean }>()
    const stores = new Map<string, ReturnType<typeof makeModuleStoreOn>>()
    let backedUpForUpgrade: string | undefined

    const guardOf = (moduleId: string, allowSchema: boolean): GuardContext => ({ prefix: sqlPrefixOf(moduleId), schemaNames, allowSchema, readOnly, vtableModules })

    const moduleSql = (moduleId: string, mode: "run" | "migrate"): ModuleSql => {
      const prefix = sqlPrefixOf(moduleId)
      const checked = (sql: string): Effect.Effect<void, StoreError> => {
        if (mode === "run" && declared.get(moduleId)?.sql !== true) {
          return Effect.fail(new StoreError({ reason: "unavailable", message: `Module ${moduleId} declares no storage.sql, so it has no tables` }))
        }
        if (mode === "run" && verdicts.has(moduleId)) {
          return Effect.fail(new StoreError({ reason: "unavailable", message: `Module ${moduleId}'s data is not usable: ${verdicts.get(moduleId)!.reason}` }))
        }
        const cacheKey = `${moduleId}\u0000${mode}\u0000${sql}`
        let why = verdictCache.get(cacheKey)
        if (!verdictCache.has(cacheKey)) {
          why = checkModuleStatement(sql, guardOf(moduleId, mode === "migrate"))
          if (verdictCache.size > 2000) verdictCache.clear()
          verdictCache.set(cacheKey, why)
        }
        return why === undefined ? Effect.void : Effect.fail(new StoreError({ reason: "refused", message: `Module ${moduleId}: refused SQL (${why})` }))
      }
      // Migrations run inside prepare's transaction (statements unlocked); at run time every call is one statement under `tx`.
      const wrap = mode === "migrate" ? <X>(e: Effect.Effect<X, StoreError>) => e : <X>(e: Effect.Effect<X, StoreError>) => tx.statement(e)
      return {
        prefix,
        table: (name) => `${prefix}${name}`,
        fts5,
        query: <R>(sql: string, params: ReadonlyArray<SqlValue> = []) => wrap(Effect.andThen(checked(sql), query<R>(sql, params))),
        run: (sql, params = []) => (readOnly ? Effect.fail(readOnlyError("module SQL")) : wrap(Effect.andThen(checked(sql), exec(sql, params))))
      }
    }

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

    const runMigration = (moduleId: string, migration: SqlMigration) =>
      typeof migration === "function"
        ? migration(moduleSql(moduleId, "migrate")).pipe(Effect.andThen(refreshNames))
        : Effect.gen(function*() {
          const split = migrationStatements(migration, guardOf(moduleId, true))
          if ("refused" in split) return yield* new StoreError({ reason: "refused", message: `Module ${moduleId}: refused SQL in a migration (${split.refused})` })
          for (const statement of split.statements) {
            // Each statement is checked against the names as they are now (an earlier one may have made a table).
            const why = checkModuleStatement(statement, guardOf(moduleId, true))
            if (why !== undefined) return yield* new StoreError({ reason: "refused", message: `Module ${moduleId}: refused SQL in a migration (${why})` })
            yield* exec(statement)
            yield* refreshNames
          }
        })

    const prepareOne = (m: StoredModule) =>
      Effect.gen(function*() {
        const owner = `module:${m.id}`
        const collections = new Map((m.storage?.collections ?? []).map((c) => [c.name, c]))
        const migrations = m.storage?.sql?.migrations ?? []
        declared.set(m.id, { collections, sql: migrations.length > 0 })
        stores.delete(m.id)
        verdicts.delete(m.id)
        if (!MODULE_ID.test(m.id)) return void verdicts.set(m.id, { reason: "Its id cannot key stored data." })
        const stored = yield* versionsOf(owner)
        const sqlStored = stored.get("sql") ?? 0
        const newer = [...collections.values()].find((c) => (stored.get(`collection:${c.name}`) ?? 0) > c.version)
        if (newer !== undefined || sqlStored > migrations.length) {
          return void verdicts.set(m.id, {
            reason: newer !== undefined
              ? `Its stored data (${newer.name}, version ${stored.get(`collection:${newer.name}`)}) was written by a newer version of this module (this one knows ${newer.version}); update the module. The data is kept as it is.`
              : `Its stored tables (version ${sqlStored}) were written by a newer version of this module (this one knows ${migrations.length}); update the module. The data is kept as it is.`
          })
        }
        const pendingSql = sqlStored < migrations.length
        const pendingCollections = [...collections.values()].filter((c) => (stored.get(`collection:${c.name}`) ?? 0) < c.version)
        // Rows to rewrite: a collection whose stored version is older and that has rows.
        let rewrites = false
        for (const c of pendingCollections) if (stored.has(`collection:${c.name}`) && (yield* hasRows(m.id, c.name))) rewrites = true
        if (readOnly) {
          if (pendingSql || rewrites) verdicts.set(m.id, { reason: "Its stored data needs an upgrade, which the server makes when it starts (pnpm start serve)." })
          return
        }
        let backup: string | undefined
        if (pendingSql || rewrites) {
          const done = yield* Effect.result(backupBeforeUpgrade(m.id))
          if (done._tag === "Failure") {
            return void verdicts.set(m.id, { reason: `Its data needs an upgrade, and the backup before it failed (${done.failure.message}); nothing was changed.` })
          }
          backup = done.success
        }
        const before = new Set(schemaNames)
        const upgraded = yield* Effect.result(tx.transaction(Effect.gen(function*() {
          for (let i = sqlStored; i < migrations.length; i++) {
            yield* runMigration(m.id, migrations[i]!)
            yield* setVersion(owner, "sql", i + 1)
          }
          for (const c of pendingCollections) {
            const n = yield* migrateCollectionOn(backend, m.id, c)
            if (n > 0) log(`Module ${m.id}: ${n} row(s) of ${c.name} migrated to version ${c.version}`)
            yield* setVersion(owner, `collection:${c.name}`, c.version)
          }
          yield* syncIndexes(m.id, collections)
          yield* refreshNames
          const prefix = sqlPrefixOf(m.id)
          const strays = [...schemaNames].filter((n) => !before.has(n) && !n.startsWith(prefix) && !n.startsWith("pva_ix_") && !n.startsWith("sqlite_autoindex_"))
          if (strays.length > 0) return yield* new StoreError({ reason: "refused", message: `Module ${m.id}: its migrations made ${strays.join(", ")}, outside ${prefix}*` })
        })))
        if (upgraded._tag === "Failure") {
          yield* refreshNames.pipe(Effect.ignore)
          const where = backup !== undefined ? ` A backup from before is at ${backup}.` : ""
          log(`Module ${m.id}: upgrading its data failed: ${upgraded.failure.message}`)
          return void verdicts.set(m.id, { reason: `Its data could not be upgraded (${upgraded.failure.message}); it was left as it was.${where}` })
        }
        if (pendingSql) log(`Module ${m.id}: tables upgraded to version ${migrations.length}`)
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
        s = makeModuleStoreOn(backend, moduleId, declared.get(moduleId)?.collections ?? new Map(), moduleSql(moduleId, "run"), () => verdicts.get(moduleId))
        stores.set(moduleId, s)
      }
      return s
    }

    const lastSeqRaw = Effect.map(query<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'pva_changes'"), (r) => Number(r[0]?.seq ?? 0))

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
              try: () => migrations.map((m) => coreStatements(m)),
              catch: (cause) => new StoreError({ reason: "invalid", message: `The ${owner} migrations cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, cause })
            })
            yield* tx.transaction(Effect.gen(function*() {
              for (let i = at; i < migrations.length; i++) {
                for (const statement of statements[i]!) yield* exec(statement)
                yield* setVersion(`core:${owner}`, "sql", i + 1)
              }
            }))
            yield* tx.statement(refreshNames)
          })
      }
    }

    // ---- Export: one consistent snapshot on a connection of its own, in pages with a yield between them

    const exportModule = (moduleId: string) =>
      Effect.gen(function*() {
        const at = yield* Clock.currentTimeMillis
        if (memory) return yield* tx.statement(exportFrom(moduleId, at, undefined))
        const { DatabaseSync } = yield* Effect.promise(() => sqlite())
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              const db = new DatabaseSync(options.filename, { readOnly: true })
              // The snapshot starts with the first read: take it now, so every table is read as of this moment.
              db.exec("BEGIN")
              db.prepare("SELECT count(*) FROM sqlite_schema").get()
              return db
            },
            catch: (cause) => new StoreError({ reason: "failed", message: `Could not open ${options.filename} to export: ${String(cause)}`, cause })
          }),
          (db) => exportFrom(moduleId, at, db),
          (db) => Effect.sync(() => {
            try {
              db.exec("COMMIT")
            } finally {
              db.close()
            }
          })
        )
      }).pipe(Effect.scoped)

    /** Read a module's data from `db` (a read transaction of its own) or, in memory, from the store's connection. */
    const exportFrom = (moduleId: string, at: number, db: InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined) =>
      Effect.gen(function*() {
        const plain = (v: unknown): unknown => (v instanceof Uint8Array ? { base64: Buffer.from(v).toString("base64") } : typeof v === "bigint" ? (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v)) : v)
        /** Every row of a query, handed to `each` 500 at a time with a yield between: no long stretch on the event loop. */
        const each = (sql: string, params: ReadonlyArray<SqlValue>, f: (row: Record<string, unknown>) => void) =>
          Effect.gen(function*() {
            if (db === undefined) {
              const rows = (yield* query<Record<string, unknown>>(sql, [...params])) as ReadonlyArray<Record<string, unknown>>
              for (const row of rows) f(row)
              return
            }
            const statement = db.prepare(sql)
            statement.setReadBigInts(true)
            const it = statement.iterate(...params) as Iterator<Record<string, unknown>>
            for (;;) {
              for (let n = 0; n < 500; n++) {
                const next = it.next()
                if (next.done === true) return
                f(next.value)
              }
              yield* Effect.yieldNow
            }
          })
        const grouped = new Map<string, Array<ModuleExport["collections"][string][number]>>()
        yield* each("SELECT * FROM pva_docs WHERE module = ? ORDER BY module, collection, id", [moduleId], (r) => {
          const d = toDoc({ ...(r as unknown as DocRow), rev: Number(r.rev), v: Number(r.v), created_at: Number(r.created_at), updated_at: Number(r.updated_at) })
          let rows = grouped.get(d.collection)
          if (rows === undefined) grouped.set(d.collection, rows = [])
          rows.push({ id: d.id, rev: d.rev, scope: d.scope, value: JSON.parse(d.text), createdAt: d.createdAt, updatedAt: d.updatedAt })
        })
        const prefix = sqlPrefixOf(moduleId)
        const objects: Array<{ name: string; sql: string | null }> = []
        yield* each("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, ?) = ? ORDER BY name", [prefix.length, prefix], (r) => {
          objects.push({ name: String(r.name), sql: r.sql === null ? null : String(r.sql) })
        })
        const virtual = objects.filter((o) => /^\s*create\s+virtual/i.test(o.sql ?? ""))
        const shadowOf = (n: string) => virtual.some((v) => n.startsWith(`${v.name}_`) && n !== v.name)
        const tables = new Map<string, ReadonlyArray<Record<string, unknown>>>()
        const omitted: Array<{ table: string; reason: string }> = []
        const quote = (n: string) => `"${n.replace(/"/g, "\"\"")}"`
        for (const o of objects) {
          const short = o.name.slice(prefix.length)
          if (shadowOf(o.name)) continue
          const isVirtual = virtual.includes(o)
          if (isVirtual) {
            const content = /content\s*=\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+))/i.exec(o.sql ?? "")
            const source = content === null ? undefined : content[1] ?? content[2] ?? content[3] ?? ""
            if (source !== undefined) {
              omitted.push({ table: short, reason: source === "" ? "a full-text index without content of its own" : `a full-text index of ${source}, which holds the content` })
              continue
            }
          }
          const rows: Array<Record<string, unknown>> = []
          yield* each(isVirtual ? `SELECT rowid AS rowid, * FROM ${quote(o.name)}` : `SELECT * FROM ${quote(o.name)}`, [], (row) => {
            rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plain(v)])))
          })
          tables.set(short, rows)
        }
        return { module: moduleId, exportedAt: at, collections: Object.fromEntries(grouped), tables: Object.fromEntries(tables), omitted } satisfies ModuleExport
      })

    const store: SqliteHouseholdStore = {
      info: { kind: "sqlite", readOnly, fts5, ...(memory ? {} : { path: options.filename }) },
      prepare: (modules) => Effect.forEach(modules, prepareOne, { discard: true }),
      availability: (moduleId) => verdicts.get(moduleId),
      forModule,
      transaction: tx.transaction,
      afterCommit: (f) => tx.enqueue({ _tag: "run", run: f }),
      core,
      changesSince: (seq, limit) =>
        tx.statement(Effect.gen(function*() {
          const rows = yield* query<ChangeRow>("SELECT * FROM pva_changes WHERE seq > ? ORDER BY seq LIMIT ?", [seq, limit + 1])
          const oldestRow = yield* query<{ seq: number | null }>("SELECT min(seq) AS seq FROM pva_changes")
          const oldest = oldestRow[0]?.seq ?? (yield* lastSeqRaw) + 1
          return { changes: rows.slice(0, limit).map(toChange), complete: rows.length <= limit, oldest: Number(oldest) }
        })),
      lastSeq: tx.statement(lastSeqRaw),
      endConversation: (conversationId) => (readOnly ? Effect.succeed(0) : endConversationsOn(backend, conversations, conversationId)),
      sweepConversations: readOnly ? Effect.succeed(0) : endConversationsOn(backend, conversations, undefined),
      pruneChanges: (opts) =>
        readOnly ? Effect.fail(readOnlyError("pruneChanges")) : Effect.gen(function*() {
          const now = opts?.now ?? (yield* Clock.currentTimeMillis)
          const cut = now - (opts?.maxAgeMs ?? CHANGE_RETENTION_MS)
          let total = 0
          // Small transactions with a yield between them: a turn waits for one batch at most.
          for (;;) {
            const r = yield* tx.transaction(exec("DELETE FROM pva_changes WHERE seq IN (SELECT seq FROM pva_changes INDEXED BY pva_changes_at WHERE at < ? ORDER BY at LIMIT 100)", [cut]))
            total += r.changes
            if (r.changes < 100) return total
            yield* Effect.yieldNow
          }
        }),
      backup,
      exportModule,
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
