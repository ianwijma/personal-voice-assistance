import "./quiet.ts"
import {
  type Collection,
  type HouseholdStore,
  type IndexKey,
  type PageCursor,
  type ScopeRef,
  scopeFromColumns,
  scopeIdOf,
  StoreError
} from "@pva/core"
import { type BulkKey, type BulkRow, type CheckedQuery, type IndexSpec, layoutOf, makeStoreEngine, type StoredCollection, type StoredDoc, type SyncBackend } from "@pva/core/store-backend"
import { Clock, Effect, Semaphore, type Scope } from "effect"
import { existsSync } from "node:fs"
import { open, readdir, stat } from "node:fs/promises"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import { basename, dirname, join } from "node:path"
import {
  BEFORE,
  copyDatabase,
  copyFilePrivately,
  DAILY,
  type FileGuard,
  lastBackupIn,
  makeCheckpointer,
  narrow,
  privateDir,
  pruneArchives,
  type PruneResult,
  sqlite,
  unguarded,
  walBytes
} from "./files.ts"

/**
 * The household store on SQLite (docs/STORING-DATA.md): one file (`data/household.db`, mode 0600 in a 0700
 * directory), WAL, `synchronous = NORMAL`, `secure_delete = ON`, one connection through Node's built-in `node:sqlite`
 * (`DatabaseSync`, no native build, no driver in between), under the engine of `@pva/core/store-backend`.
 *
 * Every statement on that connection is synchronous on the main thread, which also frames audio, so nothing unbounded
 * runs on it: a transaction is one synchronous step (`BEGIN IMMEDIATE`, the function, `COMMIT`); every read a turn can
 * make is one index range with a row limit (`INDEXED BY`, so a query that cannot use its index fails instead of
 * scanning); writes touch single rows; the connection never checkpoints (`wal_autocheckpoint = 0`) and never waits for
 * a lock (`busy_timeout = 0`: a lock held elsewhere is a `busy` failure, which a transaction retries a few times on a
 * timer, off the event loop). What is long runs elsewhere: backups on a connection of their own (one step on SQLite's
 * worker thread), checkpoints on a worker thread of their own (passive ones regularly, a truncating one after a
 * removal and at start).
 *
 * The value of every indexed field is kept in a column of its own (`k0` … `k7`), bound from JavaScript: SQLite never
 * re-parses a number from the row's JSON (its parser is not exact), so filters and orders see exactly the values the
 * in-memory store sees.
 */

/** The store's own schema version (`pva_meta.schema`). A file with a higher one is refused before it is opened for writing. */
export const CORE_SCHEMA_VERSION = 1

/** How many days a backup is kept (docs/STORING-DATA.md "What is kept how long"). */
export const KEEP_DAYS = 14

/** A write-ahead log above this many bytes is a Health issue (something keeps the checkpoints from finishing). */
export const WAL_WARN_BYTES = 64 * 1024 * 1024
/** A passive checkpoint is made when the log holds more than this many bytes. */
const PASSIVE_AT_BYTES = 1024 * 1024
/** Key columns: one per distinct indexed field (`MAX_INDEXES`). */
const KEY_COLUMNS = 8

export interface SqliteStoreOptions {
  /** The database file, or `:memory:` (tests; the CLI modes when there is no file yet). */
  readonly filename: string
  /** Read only (the CLI modes): writes are refused; a file is opened read-only; no backups. */
  readonly readOnly?: boolean
  /** Where backups go. Default `<directory of the file>/backups`. */
  readonly backupDir?: string
  /** A second directory every backup is also copied to (a mounted share). */
  readonly backupCopyDir?: string
  /** Days backups are kept. Default `KEEP_DAYS`. */
  readonly keepBackups?: number
  /** Log lines (migrations, backups). */
  readonly log?: (line: string) => void
  /** Run file operations so the data directory's writer lock waits for them (serve: `DataDirLock.guard`). */
  readonly guard?: FileGuard
  /** First retry of a checkpoint a reader blocked, in ms (tests). Default 1000. */
  readonly scrubRetryMs?: number
  /** How often the log's size is looked at (and a passive checkpoint made when it grew), in ms. Default 10,000. */
  readonly checkpointEveryMs?: number
  /** A log above this many bytes is a Health issue. Default `WAL_WARN_BYTES`. */
  readonly walWarnBytes?: number
  /** The most pages the file may have (`PRAGMA max_page_count`; tests make a full disk with it). Default: SQLite's. */
  readonly maxPageCount?: number
}

export interface SqliteHouseholdStore extends HouseholdStore {
  /** The newest daily backup's time (epoch ms), or `undefined` when there is none. Fails when the directory cannot be read. */
  readonly lastBackupAt: Effect.Effect<number | undefined, StoreError>
  /** The newest daily backup's time in the second directory (`undefined`: none, or no second directory). */
  readonly lastCopyAt: Effect.Effect<number | undefined, StoreError>
  /**
   * Copy every retained backup (daily, before an upgrade) the second directory lacks (by name) to it; the copy failure
   * is cleared only when none is missing any more. Maintenance runs it every hour.
   */
  readonly copyMissing: Effect.Effect<void, StoreError>
  readonly backupDir: string | undefined
  readonly backupCopyDir: string | undefined
  /** `PRAGMA quick_check` (doctor; it reads the whole file, so never on a turn). */
  readonly check: Effect.Effect<string, StoreError>
  /** Remove backups past their time (maintenance): what was removed, and what could not be done. Serve mode only. */
  readonly pruneBackups: (options?: { readonly now?: number }) => Effect.Effect<PruneResult>
  /** The last pruning's failures (a Health issue while there are any). */
  readonly pruneFailures: () => ReadonlyArray<string>
  /** The last copy to the second directory that failed, or `undefined`. */
  readonly copyFailure: () => string | undefined
  /** Data or backup directories other users may write to, which the store could not make private (Health errors). */
  readonly directoryProblems: () => ReadonlyArray<string>
  /** The write-ahead log's size when it was last looked at, in bytes. */
  readonly walSize: () => number
  /** The size above which the log is a Health issue. */
  readonly walWarnBytes: number
  /**
   * Since when a removed row's content may still be in the write-ahead log (its checkpoint waits for a reader that
   * holds an older snapshot; it is retried), or `undefined` when every removal is checkpointed.
   */
  readonly removalPendingSince: () => number | undefined
  /** Wait until every removal committed so far is checkpointed (tests; doctor). */
  readonly scrubbed: Effect.Effect<void>
}

const keyColumns = Array.from({ length: KEY_COLUMNS }, (_, i) => `k${i}`)

const CORE_DDL = `
  CREATE TABLE pva_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE pva_owners (owner TEXT PRIMARY KEY, version INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TABLE pva_collections (
    owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, scope TEXT NOT NULL, shape TEXT NOT NULL,
    PRIMARY KEY (owner, name)
  ) WITHOUT ROWID;
  CREATE TABLE pva_docs (
    owner TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    rev INTEGER NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
    ${keyColumns.join(", ")},
    PRIMARY KEY (owner, collection, id)
  ) WITHOUT ROWID;
  CREATE TABLE pva_indexes (name TEXT PRIMARY KEY, owner TEXT NOT NULL, collection TEXT NOT NULL, ddl TEXT NOT NULL) WITHOUT ROWID;
`

/** The store's own indexes (every list without a declared index, every bulk removal reads one): name and DDL. */
export const CORE_INDEXES: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["pva_docs_updated", "CREATE INDEX pva_docs_updated ON pva_docs (owner, collection, scope_kind, scope_id, updated_at, created_at, id)"],
  ["pva_docs_created", "CREATE INDEX pva_docs_created ON pva_docs (owner, collection, scope_kind, scope_id, created_at, id)"],
  ["pva_docs_conversation", "CREATE INDEX pva_docs_conversation ON pva_docs (scope_id, owner, collection, id) WHERE scope_kind = 'conversation'"]
]

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex")

/** The columns of an index after (owner, collection, scope_kind, scope_id), in its order. */
const columnsOf = (index: CheckedQuery["index"]): ReadonlyArray<string> => {
  switch (index.kind) {
    case "updated":
      return ["updated_at", "created_at", "id"]
    case "created":
      return ["created_at", "id"]
    case "s":
      return [`k${index.slots[0]}`, "created_at", "id"]
    case "u":
      return [`k${index.slots[0]}`, "updated_at", "created_at", "id"]
    case "p":
      return [`k${index.slots[0]}`, `k${index.slots[1]}`, "created_at", "id"]
  }
}

/**
 * The index of one collection's index declaration. Injective by construction: the owner and collection in hex (no
 * `_`), the kind (`s`, `u`, `p`: not hex digits) and the key columns' numbers, joined by `_`.
 */
export const indexName = (owner: string, collection: string, spec: IndexSpec) => `pva_ix_${hex(owner)}_${hex(collection)}_${spec.kind}_${spec.slots.join("_")}`
const indexDdl = (name: string, owner: string, collection: string, spec: IndexSpec) =>
  `CREATE INDEX ${name} ON pva_docs (owner, collection, scope_kind, scope_id, ${columnsOf(spec).join(", ")}) WHERE owner = ${lit(owner)} AND collection = ${lit(collection)}`

/**
 * The SQL of one list read (`CheckedQuery`): one statement, or two after a cursor whose range crosses the missing
 * values of a key column (SQLite's row-value comparison leaves `NULL` out), read one after the other in the index's
 * order. Each names its index (`INDEXED BY`): a query that could not use it fails ("no query solution") instead of
 * scanning, and the order is the index's own, so SQLite never sorts the matching rows: together they read at most
 * `limit` index entries. Each statement ends with `LIMIT ?`, which the caller binds after `params`.
 */
export const listSql = (owner: string, collection: string, scope: ScopeRef, q: CheckedQuery): ReadonlyArray<{ readonly sql: string; readonly params: ReadonlyArray<string | number> }> => {
  const dir = q.desc ? "DESC" : "ASC"
  const index = "slots" in q.index ? indexName(owner, collection, q.index) : q.index.kind === "updated" ? "pva_docs_updated" : "pva_docs_created"
  const columns = columnsOf(q.index)
  const where = [`owner = ${lit(owner)}`, `collection = ${lit(collection)}`, "scope_kind = ?", "scope_id = ?"]
  const params: Array<string | number> = [scope.kind, scopeIdOf(scope)]
  let range = columns
  let after = q.after
  if (q.where !== undefined && q.where !== null) {
    where.push(`${columns[0]} = ?`)
    params.push(q.where)
    range = columns.slice(1)
    after = after?.slice(1)
  }
  const statement = (extra: ReadonlyArray<string>, extraParams: ReadonlyArray<string | number>) => ({
    sql: `SELECT * FROM pva_docs INDEXED BY ${index} WHERE ${[...where, ...extra].join(" AND ")} ORDER BY ${columns.map((c) => `${c} ${dir}`).join(", ")} LIMIT ?`,
    params: [...params, ...extraParams]
  })
  if (after === undefined) return [statement([], [])]
  // Only a key column (`k…`) can be NULL, and only the first of the range: NULL sorts before every value.
  const [x, ...rest] = range
  const [vx, ...restValues] = after
  const nullable = x!.startsWith("k")
  const cmp = q.desc ? "<" : ">"
  const tuple = (cols: ReadonlyArray<string>) => `(${cols.join(", ")}) ${cmp} (${cols.map(() => "?").join(", ")})`
  const values = (vs: ReadonlyArray<IndexKey>) => vs as ReadonlyArray<string | number>
  if (vx !== null) {
    const first = statement([tuple(range)], values(after))
    // Descending, the rows whose key is missing come after every value.
    return nullable && q.desc ? [first, statement([`${x} IS NULL`], [])] : [first]
  }
  const missing = statement([`${x} IS NULL`, tuple(rest)], values(restValues))
  return q.desc ? [missing] : [missing, statement([`${x} IS NOT NULL`], [])]
}

/** The SQL of `CollectionReader.page`: one scope newest first, after a cursor, through the updated index. */
export const pageSql = (owner: string, collection: string, scope: ScopeRef, after: PageCursor | undefined, limit: number): { readonly sql: string; readonly params: ReadonlyArray<string | number> } =>
  after === undefined
    ? {
      sql: `SELECT * FROM pva_docs INDEXED BY pva_docs_updated WHERE owner = ? AND collection = ? AND scope_kind = ? AND scope_id = ?
        ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?`,
      params: [owner, collection, scope.kind, scopeIdOf(scope), limit]
    }
    : {
      sql: `SELECT * FROM pva_docs INDEXED BY pva_docs_updated WHERE owner = ? AND collection = ? AND scope_kind = ? AND scope_id = ?
        AND (updated_at, created_at, id) < (?, ?, ?) ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?`,
      params: [owner, collection, scope.kind, scopeIdOf(scope), after.updatedAt, after.createdAt, after.id, limit]
    }

/** The SQL of one step of a bulk removal: conversation rows (of one conversation, or all) after a key, in key order. */
export const conversationRowsSql = (conversationId: string | undefined, after: BulkKey | undefined, limit: number): { readonly sql: string; readonly params: ReadonlyArray<string | number> } => {
  const where = ["scope_kind = 'conversation'"]
  const params: Array<string | number> = []
  if (conversationId !== undefined) {
    where.push("scope_id = ?")
    params.push(conversationId)
  }
  if (after !== undefined && conversationId !== undefined) {
    // Within one conversation the rest of the key is the range (SQLite would seek on scope_id alone otherwise).
    where.push("(owner, collection, id) > (?, ?, ?)")
    params.push(after.owner, after.collection, after.id)
  } else if (after !== undefined) {
    where.push("(scope_id, owner, collection, id) > (?, ?, ?, ?)")
    params.push(after.scopeId, after.owner, after.collection, after.id)
  }
  params.push(limit)
  return { sql: `SELECT owner, collection, id, scope_id, rev FROM pva_docs INDEXED BY pva_docs_conversation WHERE ${where.join(" AND ")} ORDER BY scope_id, owner, collection, id LIMIT ?`, params }
}

interface DocRow {
  readonly owner: string
  readonly collection: string
  readonly id: string
  readonly scope_kind: string
  readonly scope_id: string
  readonly rev: number
  readonly value: string
  readonly created_at: number
  readonly updated_at: number
  readonly updated_by: string
}

const toDoc = (r: DocRow): StoredDoc => ({
  owner: r.owner,
  collection: r.collection,
  id: r.id,
  scope: scopeFromColumns(r.scope_kind, r.scope_id),
  rev: Number(r.rev),
  text: r.value,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  updatedBy: r.updated_by
})

const padKeys = (keys: ReadonlyArray<IndexKey>): Array<IndexKey> => Array.from({ length: KEY_COLUMNS }, (_, i) => keys[i] ?? null)

const localDate = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Before the file is opened for writing (which switches it to WAL, a change to its header): read it read-only and
 * refuse a household schema this version does not know. A newer database or backup is never touched.
 */
const preflight = async (filename: string): Promise<string | undefined> => {
  const s = await stat(filename).catch(() => undefined)
  if (s === undefined || s.size === 0) return undefined
  const { DatabaseSync } = await sqlite()
  let db: DatabaseSync | undefined
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
    const serving = !memory && !readOnly
    const log = options.log ?? (() => {})
    const keep = options.keepBackups ?? KEEP_DAYS
    const guard = options.guard ?? unguarded
    const backupDir = memory ? options.backupDir : options.backupDir ?? join(dirname(options.filename), "backups")
    const copyDir = options.backupCopyDir
    const files = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: () => guard(what, run), catch: (cause) => new StoreError({ reason: "failed", message: `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause }) })
    const failed = (what: string, e: unknown) =>
      new StoreError({ reason: /readonly|read-only/i.test(String(e)) ? "read-only" : "failed", message: `${what}: ${e instanceof Error ? e.message : String(e)}`, cause: e })

    /** Directories other users may write to that could not be made private, by directory. */
    const dirProblems = new Map<string, string>()
    const noteDir = (dir: string, problem: string | undefined) => {
      if (problem === undefined) dirProblems.delete(dir)
      else {
        dirProblems.set(dir, problem)
        log(`Household data: ${problem}`)
      }
    }

    // ---- Open: read-only first (a newer file is refused untouched), private files and directories, then the connection

    if (!memory) {
      const refused = yield* Effect.promise(() => preflight(options.filename))
      if (refused !== undefined) return yield* new StoreError({ reason: "unavailable", message: refused })
      if (!readOnly) {
        yield* files(`Preparing ${options.filename}`, async () => {
          const dir = dirname(options.filename)
          noteDir(dir, await privateDir(dir))
          if (backupDir !== undefined) noteDir(backupDir, await privateDir(backupDir))
          if (copyDir !== undefined && existsSync(copyDir)) noteDir(copyDir, await privateDir(copyDir))
          // A new database is created 0600 (SQLite gives its -wal and -shm the same mode); an existing one is narrowed.
          const handle = await open(options.filename, "a", 0o600)
          await handle.close()
          for (const f of [options.filename, `${options.filename}-wal`, `${options.filename}-shm`]) await narrow(f)
        })
      }
    }
    // Loaded here, not imported at the top: `node:sqlite` is a built-in, linked (and its ExperimentalWarning printed)
    // before any module code runs, so only a dynamic import comes after the warning filter (`quiet.ts`).
    const { DatabaseSync } = yield* Effect.promise(() => sqlite())
    const db = yield* Effect.try({
      try: () => new DatabaseSync(options.filename, { readOnly: readOnly && !memory }),
      catch: (e) => failed(`Could not open ${options.filename}`, e)
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      try {
        db.close()
      } catch {
        // already closed
      }
    }))

    const statements = new Map<string, StatementSync>()
    const prepared = (sql: string): StatementSync => {
      let st = statements.get(sql)
      if (st === undefined) {
        st = db.prepare(sql)
        if (statements.size > 500) statements.clear()
        statements.set(sql, st)
      }
      return st
    }
    type Param = string | number | null
    const all = <R>(sql: string, params: ReadonlyArray<Param> = []) => prepared(sql).all(...(params as Array<Param>)) as unknown as ReadonlyArray<R>
    const one = <R>(sql: string, params: ReadonlyArray<Param> = []) => prepared(sql).get(...(params as Array<Param>)) as unknown as R | undefined
    const run = (sql: string, params: ReadonlyArray<Param> = []) => Number(prepared(sql).run(...(params as Array<Param>)).changes)

    // ---- Settings, the core schema

    yield* Effect.try({
      try: () => {
        if (serving) {
          db.exec("PRAGMA journal_mode = WAL")
          // The log is cut back to this size when it is reset after a complete checkpoint.
          db.exec("PRAGMA journal_size_limit = 4194304")
        }
        if (!readOnly) {
          // This connection never checkpoints: the checkpointer's worker thread does (`makeCheckpointer`).
          db.exec("PRAGMA wal_autocheckpoint = 0")
          db.exec("PRAGMA synchronous = NORMAL")
          db.exec("PRAGMA secure_delete = ON")
        }
        // Never wait for a lock on the event loop: a lock held elsewhere is a `busy` failure (retried on a timer).
        db.exec("PRAGMA busy_timeout = 0")
        // Views and triggers may not call functions with side effects.
        db.exec("PRAGMA trusted_schema = OFF")
        if (options.maxPageCount !== undefined) db.exec(`PRAGMA max_page_count = ${Math.max(1, Math.floor(options.maxPageCount))}`)
      },
      catch: (e) => failed(`Could not set up ${options.filename}`, e)
    })
    const hasMeta = Number(one<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'pva_meta'")?.n ?? 0) > 0
    let created = false
    if (!hasMeta) {
      if (readOnly && !memory) return yield* new StoreError({ reason: "unavailable", message: `${options.filename} holds no household data yet` })
      const at = yield* Clock.currentTimeMillis
      yield* Effect.try({
        try: () => {
          db.exec("BEGIN IMMEDIATE")
          try {
            db.exec(CORE_DDL)
            for (const [, ddl] of CORE_INDEXES) db.exec(ddl)
            run("INSERT INTO pva_meta (key, value) VALUES ('schema', ?), ('created', ?), ('rev', '0')", [String(CORE_SCHEMA_VERSION), String(at)])
            db.exec("COMMIT")
          } catch (e) {
            if (db.isTransaction) db.exec("ROLLBACK")
            throw e
          }
        },
        catch: (e) => failed(`Could not create the household tables in ${options.filename}`, e)
      })
      created = true
    } else {
      // Checked again on the open connection (the preflight read the same file a moment ago).
      const schema = Number(one<{ value: string }>("SELECT value FROM pva_meta WHERE key = 'schema'")?.value ?? "0")
      if (schema > CORE_SCHEMA_VERSION) {
        return yield* new StoreError({ reason: "unavailable", message: `${options.filename} was written by a newer version of the assistant (household schema ${schema}; this version knows ${CORE_SCHEMA_VERSION})` })
      }
      // The store's own indexes are part of being ready: without one, a list or a bulk removal would fail ("no such
      // index"). A writable start makes a missing one again before it serves; a read-only one (the CLI modes, doctor)
      // writes nothing and refuses the file.
      const missing = CORE_INDEXES.filter(([name]) => Number(one<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name = ?", [name])?.n ?? 0) === 0)
      if (missing.length > 0) {
        const names = missing.map(([name]) => name).join(", ")
        if (readOnly) {
          return yield* new StoreError({ reason: "unavailable", message: `${options.filename} lacks the household store's own indexes (${names}); the server makes them again when it starts (pnpm start serve)` })
        }
        yield* Effect.try({
          try: () => {
            db.exec("BEGIN IMMEDIATE")
            try {
              for (const [, ddl] of missing) db.exec(ddl)
              db.exec("COMMIT")
            } catch (e) {
              if (db.isTransaction) db.exec("ROLLBACK")
              throw e
            }
          },
          catch: (e) => failed(`Could not make the household store's indexes in ${options.filename}`, e)
        })
        log(`The household store's own indexes ${names} were missing in ${options.filename} and were made again`)
      }
    }

    // ---- Checkpoints: a worker thread; a truncating one at start (it also settles a removal a stopped process left
    // pending) and after every removal, retried while a reader holds an older snapshot; passive ones as the log grows

    const checkpointer = serving ? makeCheckpointer(options.filename) : undefined
    if (checkpointer !== undefined) yield* Effect.addFinalizer(() => Effect.promise(() => checkpointer.close()))
    /** Removals committed (a generation each; the start is one), and the newest one a successful checkpoint covered. */
    let removals = 0
    let checkpointed = 0
    let pendingSince: number | undefined
    let scrubbing = false
    let walNow = 0
    const waiting = new Set<() => void>()
    const settle = () => {
      if (checkpointed < removals) return
      pendingSince = undefined
      for (const f of [...waiting]) f()
    }
    const scrubLoop = Effect.gen(function*() {
      let wait = options.scrubRetryMs ?? 1000
      while (checkpointed < removals) {
        // Every removal committed before the checkpoint starts is covered by it when it succeeds.
        const covers = removals
        const done = yield* Effect.promise(() => checkpointer!.truncate())
        if (done) {
          checkpointed = Math.max(checkpointed, covers)
          settle()
          wait = options.scrubRetryMs ?? 1000
          continue
        }
        log(`A removed item may still be in the household log: a reader holds an older snapshot; retrying in ${Math.round(wait / 1000)} s`)
        yield* Effect.sleep(wait)
        wait = Math.min(wait * 2, 60_000)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => {
      scrubbing = false
    })))
    const services = yield* Effect.context<never>()
    const scope = yield* Effect.scope
    const startScrub = () => {
      if (scrubbing) return
      scrubbing = true
      Effect.runForkWith(services)(Effect.forkIn(scrubLoop, scope))
    }
    const scheduleScrub = () => {
      if (checkpointer === undefined) return
      removals++
      pendingSince ??= Date.now()
      startScrub()
    }
    if (checkpointer !== undefined) {
      removals = 1
      checkpointed = (yield* Effect.promise(() => checkpointer.truncate())) ? 1 : 0
      if (checkpointed < removals) {
        pendingSince = Date.now()
        log("The household log could not be emptied at start (a reader holds an older snapshot); retrying")
        startScrub()
      }
      const every = options.checkpointEveryMs ?? 10_000
      yield* Effect.forkScoped(Effect.forever(Effect.gen(function*() {
        yield* Effect.sleep(every)
        walNow = yield* Effect.promise(() => walBytes(options.filename).catch(() => walNow))
        if (walNow > PASSIVE_AT_BYTES) {
          yield* Effect.promise(() => checkpointer.passive())
          walNow = yield* Effect.promise(() => walBytes(options.filename).catch(() => walNow))
        }
      })))
    }
    const scrubbed: Effect.Effect<void> = Effect.callback<void>((resume) => {
      if (checkpointed >= removals) return resume(Effect.void)
      const f = () => {
        waiting.delete(f)
        resume(Effect.void)
      }
      waiting.add(f)
      return Effect.sync(() => void waiting.delete(f))
    })

    // ---- The backend the engine runs on

    const indexExists = (name: string) => one<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'index' AND name = ?", [name])?.n !== 0
    const wanted = (owner: string, c: Collection<any>) =>
      layoutOf(c).map((spec) => {
        const name = indexName(owner, c.name, spec)
        return { name, ddl: indexDdl(name, owner, c.name, spec) }
      })

    const backend: SyncBackend = {
      readOnly,
      begin: () => db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE"),
      commit: () => db.exec("COMMIT"),
      rollback: () => db.exec("ROLLBACK"),
      inTransaction: () => db.isTransaction,
      read: (owner, collection, id) => {
        const r = one<DocRow>("SELECT * FROM pva_docs WHERE owner = ? AND collection = ? AND id = ?", [owner, collection, id])
        return r === undefined ? undefined : toDoc(r)
      },
      list: (owner, collection, scope, q) => {
        const out: Array<StoredDoc> = []
        for (const { sql, params } of listSql(owner, collection, scope, q)) {
          if (out.length >= q.limit) break
          for (const r of all<DocRow>(sql, [...params, q.limit - out.length])) out.push(toDoc(r))
        }
        return out
      },
      page: (owner, collection, scope, after, limit) => {
        const { sql, params } = pageSql(owner, collection, scope, after, limit)
        return all<DocRow>(sql, params).map(toDoc)
      },
      put: (doc, keys, expect) =>
        (expect === "absent"
          ? run(
            `INSERT INTO pva_docs (owner, collection, id, scope_kind, scope_id, rev, value, created_at, updated_at, updated_by, ${keyColumns.join(", ")})
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${keyColumns.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
            [doc.owner, doc.collection, doc.id, doc.scope.kind, scopeIdOf(doc.scope), doc.rev, doc.text, doc.createdAt, doc.updatedAt, doc.updatedBy, ...padKeys(keys)]
          )
          : run(
            `UPDATE pva_docs SET rev = ?, value = ?, updated_at = ?, updated_by = ?, ${keyColumns.map((k) => `${k} = ?`).join(", ")}
             WHERE owner = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?`,
            [doc.rev, doc.text, doc.updatedAt, doc.updatedBy, ...padKeys(keys), doc.owner, doc.collection, doc.id, expect, doc.scope.kind, scopeIdOf(doc.scope)]
          )) === 1,
      remove: (owner, collection, id, scope, expect) =>
        run("DELETE FROM pva_docs WHERE owner = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?", [owner, collection, id, expect, scope.kind, scopeIdOf(scope)]) === 1,
      nextRev: () => Number(one<{ value: string }>("UPDATE pva_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value")!.value),
      lastRev: () => Number(one<{ value: string }>("SELECT value FROM pva_meta WHERE key = 'rev'")?.value ?? 0),
      scan: (owner, collection, afterId, limit) =>
        all<DocRow>("SELECT * FROM pva_docs WHERE owner = ? AND collection = ? AND id > ? ORDER BY id LIMIT ?", [owner, collection, afterId, limit]).map(toDoc),
      count: (owner, collection, cap) =>
        Number(one<{ n: number }>("SELECT count(*) AS n FROM (SELECT 1 FROM pva_docs WHERE owner = ? AND collection = ? LIMIT ?)", [owner, collection, cap + 1])?.n ?? 0),
      rewrite: (doc, text, keys) =>
        void run(`UPDATE pva_docs SET value = ?, ${keyColumns.map((k) => `${k} = ?`).join(", ")} WHERE owner = ? AND collection = ? AND id = ?`, [text, ...padKeys(keys), doc.owner, doc.collection, doc.id]),
      conversationRows: (conversationId, after, limit) => {
        const { sql, params } = conversationRowsSql(conversationId, after, limit)
        return all<{ owner: string; collection: string; id: string; scope_id: string; rev: number }>(sql, params)
          .map((r): BulkRow => ({ scopeId: r.scope_id, owner: r.owner, collection: r.collection, id: r.id, scope: { kind: "conversation", id: r.scope_id }, rev: Number(r.rev) }))
      },
      ownerVersion: (owner) => {
        const r = one<{ version: number }>("SELECT version FROM pva_owners WHERE owner = ?", [owner])
        return r === undefined ? undefined : Number(r.version)
      },
      setOwnerVersion: (owner, version) => void run("INSERT INTO pva_owners (owner, version) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET version = excluded.version", [owner, version]),
      storedCollections: (owner) =>
        new Map(all<{ name: string; version: number; scope: string; shape: string }>("SELECT name, version, scope, shape FROM pva_collections WHERE owner = ?", [owner])
          .map((r): [string, StoredCollection] => [r.name, { version: Number(r.version), scope: r.scope, shape: r.shape }])),
      allCollections: () => all<{ owner: string; name: string; version: number }>("SELECT owner, name, version FROM pva_collections ORDER BY owner, name").map((r) => ({ owner: r.owner, name: r.name, version: Number(r.version) })),
      setCollection: (owner, name, meta) =>
        void run(
          "INSERT INTO pva_collections (owner, name, version, scope, shape) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner, name) DO UPDATE SET version = excluded.version, scope = excluded.scope, shape = excluded.shape",
          [owner, name, meta.version, meta.scope, meta.shape]
        ),
      syncIndexes: (owner, c) => {
        const want = new Map(wanted(owner, c).map((w) => [w.name, w.ddl]))
        for (const h of all<{ name: string; ddl: string }>("SELECT name, ddl FROM pva_indexes WHERE owner = ? AND collection = ?", [owner, c.name])) {
          if (want.get(h.name) === h.ddl && indexExists(h.name)) {
            want.delete(h.name)
            continue
          }
          db.exec(`DROP INDEX IF EXISTS ${h.name}`)
          run("DELETE FROM pva_indexes WHERE name = ?", [h.name])
        }
        for (const [name, ddl] of want) {
          db.exec(`DROP INDEX IF EXISTS ${name}`)
          db.exec(ddl)
          run("INSERT INTO pva_indexes (name, owner, collection, ddl) VALUES (?, ?, ?, ?)", [name, owner, c.name, ddl])
        }
      },
      indexesReady: (owner, c) =>
        wanted(owner, c).every((w) => one<{ ddl: string }>("SELECT ddl FROM pva_indexes WHERE name = ?", [w.name])?.ddl === w.ddl && indexExists(w.name)),
      removed: scheduleScrub
    }

    // ---- Backups (serve mode only: a connection of their own, the copy on SQLite's worker thread), one at a time

    const backups = Semaphore.makeUnsafe(1)
    let backedUpForUpgrade: string | undefined
    let lastPrune: PruneResult = { removed: [], failed: [] }
    let copyProblem: string | undefined

    const noBackups = new StoreError({ reason: "unavailable", message: "Backups are made by the server (serve mode); this store makes none" })

    /**
     * Copy every retained backup the second directory lacks (by name) to it, keeping each one's time (so both
     * directories prune by the snapshot's age). A failure is kept (a Health issue) until no backup is missing there.
     */
    const reconcile = Effect.gen(function*() {
      if (copyDir === undefined || backupDir === undefined) return
      const listed = yield* Effect.result(files(`Listing ${backupDir} and ${copyDir}`, async () => {
        const names = (await readdir(backupDir)).filter((n) => DAILY.test(n) || BEFORE.test(n))
        const there = await readdir(copyDir).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return [] as Array<string>
          throw e
        })
        return names.filter((n) => !there.includes(n)).sort()
      }))
      if (listed._tag === "Failure") {
        copyProblem = listed.failure.message
        log(`The household backups could not be compared with ${copyDir}: ${listed.failure.message}`)
        return
      }
      let problem: string | undefined
      for (const name of listed.success) {
        const from = join(backupDir, name)
        const target = join(copyDir, name)
        const done = yield* Effect.result(files(`Copying ${from} to ${target}`, () => copyFilePrivately(from, target)))
        if (done._tag === "Failure") {
          problem = done.failure.message
          log(`The household backup could not be copied to ${copyDir}: ${done.failure.message}`)
        } else noteDir(copyDir, done.success)
      }
      copyProblem = problem
    })

    /**
     * One backup operation: one at a time, and its file work uninterruptible inside the permit, so the permit is held
     * until that work has really settled (an interrupted backup cannot publish after the next one).
     */
    const serially = <A, E>(effect: Effect.Effect<A, E>) => backups.withPermits(1)(Effect.uninterruptible(effect))

    /** A backup before the first upgrade of this start (never of a new or in-memory file), copied to the second directory too. */
    const backupBeforeUpgrade = (what: string) =>
      serially(Effect.gen(function*() {
        if (!serving || backupDir === undefined || backedUpForUpgrade !== undefined) return backedUpForUpgrade
        if (created) return undefined
        const at = yield* Clock.currentTimeMillis
        const path = join(backupDir, `household-${localDate(at)}-before-${what}.db`)
        noteDir(backupDir, yield* files(`Backing up to ${path}`, () => copyDatabase(options.filename, path)))
        backedUpForUpgrade = path
        log(`Household data backed up to ${path} before upgrading ${what}`)
        yield* reconcile
        return path
      }))

    const pruneBackups = (opts?: { readonly now?: number }) =>
      Effect.gen(function*() {
        // Only the serving process prunes (a read-only store never removes a backup or changes a file's mode).
        if (!serving) return { removed: [], failed: [memory ? "The in-memory store has no backups" : "Backups are pruned by the server (serve mode); a read-only store removes none"] } satisfies PruneResult
        const now = opts?.now ?? (yield* Clock.currentTimeMillis)
        const dirs = [backupDir, copyDir].filter((d): d is string => d !== undefined)
        const removed: Array<string> = []
        const failures: Array<string> = []
        for (const dir of dirs) {
          const done = yield* files(`Removing old backups in ${dir}`, () => pruneArchives(dir, now, keep)).pipe(
            Effect.catch((e) => Effect.succeed({ removed: [], failed: [`${dir}: ${e.message}`] } satisfies PruneResult))
          )
          removed.push(...done.removed)
          failures.push(...done.failed)
        }
        if (removed.length > 0) log(`Household backups past ${keep} days removed: ${removed.join(", ")}`)
        if (failures.length > 0) log(`Household backups past ${keep} days: not all could be checked or removed: ${failures.join("; ")}`)
        lastPrune = { removed, failed: failures }
        return lastPrune
      })

    const backup = (opts?: { readonly now?: number }) =>
      serially(Effect.gen(function*() {
        if (!serving || backupDir === undefined) return yield* noBackups
        const at = opts?.now ?? (yield* Clock.currentTimeMillis)
        const path = join(backupDir, `household-${localDate(at)}.db`)
        noteDir(backupDir, yield* files(`Backing up to ${path}`, () => copyDatabase(options.filename, path)))
        yield* pruneBackups({ now: at })
        yield* reconcile
        return { path }
      }))

    const newestIn = (dir: string | undefined) =>
      dir === undefined
        ? Effect.succeed(undefined)
        : Effect.tryPromise({ try: () => lastBackupIn(dir), catch: (e) => new StoreError({ reason: "failed", message: `${dir} could not be read: ${e instanceof Error ? e.message : String(e)}`, cause: e }) })

    const copyMissing = serially(Effect.gen(function*() {
      if (!serving || backupDir === undefined) return yield* noBackups
      yield* reconcile
    }))

    // ---- The engine, the rest

    const engine = makeStoreEngine({ backend, backupBeforeUpgrade, log })
    const { inTransaction: _inTransaction, ...shared } = engine

    const step = <X>(what: string, f: () => X): Effect.Effect<X, StoreError> =>
      Effect.suspend(() => {
        try {
          return Effect.succeed(f())
        } catch (e) {
          return Effect.fail(e instanceof StoreError ? e : failed(what, e))
        }
      })

    const store: SqliteHouseholdStore = {
      ...shared,
      info: { kind: "sqlite", readOnly, ...(memory ? {} : { path: options.filename }) },
      backup,
      lastBackupAt: newestIn(backupDir),
      lastCopyAt: newestIn(copyDir),
      copyMissing,
      backupDir,
      backupCopyDir: copyDir,
      pruneBackups,
      pruneFailures: () => lastPrune.failed,
      copyFailure: () => copyProblem,
      directoryProblems: () => [...dirProblems.values()],
      walSize: () => walNow,
      walWarnBytes: options.walWarnBytes ?? WAL_WARN_BYTES,
      removalPendingSince: () => pendingSince,
      scrubbed,
      check: step("The quick check", () => all<Record<string, unknown>>("PRAGMA quick_check").map((x) => String(Object.values(x)[0])).join("; "))
    }
    return store
  })
