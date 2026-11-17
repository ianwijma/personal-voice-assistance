import "./quiet.ts"
import {
  type Collection,
  type CoreSql,
  type CoreTx,
  type HouseholdStore,
  readOnlyError,
  type ScopeRef,
  scopeFromColumns,
  scopeIdOf,
  type SqlValue,
  StoreError
} from "@pva/core"
import { type CheckedQuery, makeStoreEngine, type StoredDoc, type SyncBackend, TX_CONTROL } from "@pva/core/store-backend"
import { Clock, Effect, Semaphore, type Scope } from "effect"
import { open, stat } from "node:fs/promises"
import type { DatabaseSync, StatementSync } from "node:sqlite"
import { dirname, join } from "node:path"
import { checkpointFile, copyDatabase, copyFilePrivately, type FileGuard, lastBackupIn, narrow, privateDir, pruneArchives, type PruneResult, sqlite, unguarded, withBackupLock } from "./files.ts"

/**
 * The household store on SQLite (docs/STORING-DATA.md): one file (`data/household.db`, mode 0600 in a 0700
 * directory), WAL, `synchronous = NORMAL`, `secure_delete = ON`, one connection through Node's built-in `node:sqlite`
 * (`DatabaseSync`, no native build, no driver in between), under the engine of `@pva/core/store-backend`.
 *
 * Every statement on that connection is synchronous on the main thread, which also frames audio. A transaction is one
 * synchronous step (`BEGIN IMMEDIATE`, the function, `COMMIT`), so nothing can come between its statements. Every read
 * a turn can make is one index range with a row limit (`INDEXED BY`, so a query that cannot use its index fails instead
 * of scanning) and writes touch single rows. What is long runs elsewhere: backups on a connection of their own (one
 * step on SQLite's worker thread), the checkpoint after a removal on a worker thread of its own.
 */

/** The store's own schema version (`pva_meta.schema`). A file with a higher one is refused before it is opened for writing. */
export const CORE_SCHEMA_VERSION = 1

/** How many days a backup is kept (docs/STORING-DATA.md "What is kept how long"). */
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
  /** Days backups are kept. Default `KEEP_DAYS`. */
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
  /** Remove backups past their time (maintenance): what was removed, and what could not be. */
  readonly pruneBackups: (options?: { readonly now?: number }) => Effect.Effect<PruneResult>
  /** The last pruning's failures (a Health issue while there are any). */
  readonly pruneFailures: () => ReadonlyArray<string>
  /**
   * Since when a removed row's content may still be in the write-ahead log (its checkpoint waits for a reader that
   * holds an older snapshot; it is retried), or `undefined` when every removal is checkpointed.
   */
  readonly removalPendingSince: () => number | undefined
  /** Wait until every removal committed so far is checkpointed (tests; doctor). */
  readonly scrubbed: Effect.Effect<void>
}

const CORE_DDL = `
  CREATE TABLE pva_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE pva_versions (owner TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (owner, name)) WITHOUT ROWID;
  CREATE TABLE pva_docs (
    module TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    rev INTEGER NOT NULL, v INTEGER NOT NULL, value TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
    PRIMARY KEY (module, collection, id)
  ) WITHOUT ROWID;
  CREATE INDEX pva_docs_updated ON pva_docs (module, collection, scope_kind, scope_id, updated_at, id);
  CREATE INDEX pva_docs_created ON pva_docs (module, collection, scope_kind, scope_id, created_at, id);
  CREATE INDEX pva_docs_conversation ON pva_docs (scope_id) WHERE scope_kind = 'conversation';
  CREATE TABLE pva_indexes (name TEXT PRIMARY KEY, module TEXT NOT NULL, collection TEXT NOT NULL, field TEXT NOT NULL, ddl TEXT NOT NULL) WITHOUT ROWID;
`

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const OWNER = /^[a-z][a-z0-9]{0,30}$/
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex")

/**
 * The index of a collection's field. Injective by construction: the module id, collection name and field (case kept)
 * each in hex, which has no `_`, joined by `_`. (SQLite names are case-insensitive; hex digits are lower case.)
 */
export const indexName = (module: string, collection: string, field: string) => `pva_ix_${hex(module)}_${hex(collection)}_${hex(field)}`
const fieldExpr = (field: string) => `json_extract(value, '$.${field}')`
const indexDdl = (name: string, module: string, collection: string, field: string) =>
  `CREATE INDEX ${name} ON pva_docs (module, collection, scope_kind, scope_id, ${fieldExpr(field)}, updated_at, id) WHERE module = ${lit(module)} AND collection = ${lit(collection)}`

/**
 * The SQL of one list read (`CheckedQuery`). Each shape names its index (`INDEXED BY`): a query that could not use it
 * fails ("no query solution") instead of scanning, and the order is the index's own, so SQLite never sorts the
 * matching rows: it reads at most `limit` index entries.
 */
export const listSql = (module: string, collection: string, scope: ScopeRef, q: CheckedQuery): { readonly sql: string; readonly params: ReadonlyArray<SqlValue> } => {
  const dir = q.order.desc ? "DESC" : "ASC"
  const where = [`module = ${lit(module)}`, `collection = ${lit(collection)}`, "scope_kind = ?", "scope_id = ?"]
  const params: Array<SqlValue> = [scope.kind, scopeIdOf(scope)]
  let index: string
  let order: string
  if (q.where !== undefined) {
    const [field, value] = q.where
    index = indexName(module, collection, field)
    where.push(`${fieldExpr(field)} = ?`)
    params.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
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
  updatedBy: r.updated_by
})

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
    const log = options.log ?? (() => {})
    const keep = options.keepBackups ?? KEEP_DAYS
    const guard = options.guard ?? unguarded
    const backupDir = memory ? options.backupDir : options.backupDir ?? join(dirname(options.filename), "backups")
    const files = <A>(what: string, run: () => Promise<A>) =>
      Effect.tryPromise({ try: () => guard(what, run), catch: (cause) => new StoreError({ reason: "failed", message: `${what} failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause }) })
    const failed = (what: string, e: unknown) =>
      new StoreError({ reason: /readonly|read-only/i.test(String(e)) ? "read-only" : "failed", message: `${what}: ${e instanceof Error ? e.message : String(e)}`, cause: e })

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
    const all = <R>(sql: string, params: ReadonlyArray<SqlValue> = []) => prepared(sql).all(...(params as Array<SqlValue>)) as unknown as ReadonlyArray<R>
    const one = <R>(sql: string, params: ReadonlyArray<SqlValue> = []) => prepared(sql).get(...(params as Array<SqlValue>)) as unknown as R | undefined
    const run = (sql: string, params: ReadonlyArray<SqlValue> = []) => {
      const r = prepared(sql).run(...(params as Array<SqlValue>))
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
    }

    // ---- Settings, the core schema

    yield* Effect.try({
      try: () => {
        if (!readOnly && !memory) {
          db.exec("PRAGMA journal_mode = WAL")
          // The log is checkpointed back to this size after it grew (a reader held it).
          db.exec("PRAGMA journal_size_limit = 4194304")
        }
        if (!readOnly) {
          db.exec("PRAGMA synchronous = NORMAL")
          db.exec("PRAGMA secure_delete = ON")
        }
        // Waits only when the checkpoint after a removal truncates the log, a few milliseconds (docs: "Latency").
        db.exec(`PRAGMA busy_timeout = ${readOnly ? 1000 : 100}`)
        // Views and triggers may not call functions with side effects.
        db.exec("PRAGMA trusted_schema = OFF")
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
    }

    // ---- Removal: the checkpoint after a removal, on a worker thread, retried while a reader holds an old snapshot

    /** Removals committed (a generation each), and the newest one a successful checkpoint covered. */
    let removals = 0
    let checkpointed = 0
    let pendingSince: number | undefined
    let scrubbing = false
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
        const done = yield* Effect.tryPromise(() => checkpointFile(options.filename)).pipe(Effect.orElseSucceed(() => false))
        if (done) {
          checkpointed = Math.max(checkpointed, covers)
          settle()
          wait = options.scrubRetryMs ?? 1000
          continue
        }
        log(`A removed item is still in the household log: a reader holds an older snapshot; retrying in ${Math.round(wait / 1000)} s`)
        yield* Effect.sleep(wait)
        wait = Math.min(wait * 2, 60_000)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => {
      scrubbing = false
    })))
    const services = yield* Effect.context<never>()
    const scope = yield* Effect.scope
    const scheduleScrub = () => {
      if (memory || readOnly) return
      removals++
      pendingSince ??= Date.now()
      if (scrubbing) return
      scrubbing = true
      Effect.runForkWith(services)(Effect.forkIn(scrubLoop, scope))
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

    const coreOf = (owner: string): CoreTx => {
      if (!OWNER.test(owner)) throw new StoreError({ reason: "invalid", message: `"${owner}" is not a core owner name` })
      return {
        prefix: `core_${owner}__`,
        query: <R>(sql: string, params: ReadonlyArray<SqlValue> = []) => all<R>(sql, params),
        run: (sql, params = []) => run(sql, params)
      }
    }

    const backend: SyncBackend = {
      readOnly,
      begin: () => db.exec(readOnly ? "BEGIN" : "BEGIN IMMEDIATE"),
      commit: () => db.exec("COMMIT"),
      rollback: () => db.exec("ROLLBACK"),
      inTransaction: () => db.isTransaction,
      read: (module, collection, id) => {
        const r = one<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id = ?", [module, collection, id])
        return r === undefined ? undefined : toDoc(r)
      },
      list: (module, collection, scope, q) => {
        const { sql, params } = listSql(module, collection, scope, q)
        return all<DocRow>(sql, params).map(toDoc)
      },
      page: (module, collection, scope, after, limit) =>
        (after === undefined
          ? all<DocRow>(
            `SELECT * FROM pva_docs INDEXED BY pva_docs_updated WHERE module = ? AND collection = ? AND scope_kind = ? AND scope_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT ?`,
            [module, collection, scope.kind, scopeIdOf(scope), limit]
          )
          : all<DocRow>(
            `SELECT * FROM pva_docs INDEXED BY pva_docs_updated WHERE module = ? AND collection = ? AND scope_kind = ? AND scope_id = ?
             AND (updated_at, id) < (?, ?) ORDER BY updated_at DESC, id DESC LIMIT ?`,
            [module, collection, scope.kind, scopeIdOf(scope), after.updatedAt, after.id, limit]
          )).map(toDoc),
      put: (doc, expect) =>
        (expect === "absent"
          ? run(
            `INSERT INTO pva_docs (module, collection, id, scope_kind, scope_id, rev, v, value, created_at, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
            [doc.module, doc.collection, doc.id, doc.scope.kind, scopeIdOf(doc.scope), doc.rev, doc.v, doc.text, doc.createdAt, doc.updatedAt, doc.updatedBy]
          )
          : run(
            `UPDATE pva_docs SET rev = ?, v = ?, value = ?, updated_at = ?, updated_by = ?
             WHERE module = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?`,
            [doc.rev, doc.v, doc.text, doc.updatedAt, doc.updatedBy, doc.module, doc.collection, doc.id, expect, doc.scope.kind, scopeIdOf(doc.scope)]
          )).changes === 1,
      remove: (module, collection, id, scope, expect) =>
        run("DELETE FROM pva_docs WHERE module = ? AND collection = ? AND id = ? AND rev = ? AND scope_kind = ? AND scope_id = ?", [module, collection, id, expect, scope.kind, scopeIdOf(scope)])
          .changes === 1,
      nextRev: () => Number(one<{ value: string }>("UPDATE pva_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value")!.value),
      lastRev: () => Number(one<{ value: string }>("SELECT value FROM pva_meta WHERE key = 'rev'")?.value ?? 0),
      scan: (module, collection, afterId, limit) =>
        all<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id > ? ORDER BY id LIMIT ?", [module, collection, afterId, limit]).map(toDoc),
      count: (module, collection, cap) =>
        Number(one<{ n: number }>("SELECT count(*) AS n FROM (SELECT 1 FROM pva_docs WHERE module = ? AND collection = ? LIMIT ?)", [module, collection, cap + 1])?.n ?? 0),
      rewrite: (doc, v, text) => void run("UPDATE pva_docs SET v = ?, value = ? WHERE module = ? AND collection = ? AND id = ?", [v, text, doc.module, doc.collection, doc.id]),
      conversationDocs: (conversationId) =>
        (conversationId === undefined
          ? all<DocRow>("SELECT * FROM pva_docs INDEXED BY pva_docs_conversation WHERE scope_kind = 'conversation'")
          : all<DocRow>("SELECT * FROM pva_docs INDEXED BY pva_docs_conversation WHERE scope_kind = 'conversation' AND scope_id = ?", [conversationId])).map(toDoc),
      versions: (owner) => new Map(all<{ name: string; version: number }>("SELECT name, version FROM pva_versions WHERE owner = ?", [owner]).map((r) => [r.name, Number(r.version)])),
      setVersion: (owner, name, version) =>
        void run("INSERT INTO pva_versions (owner, name, version) VALUES (?, ?, ?) ON CONFLICT (owner, name) DO UPDATE SET version = excluded.version", [owner, name, version]),
      syncIndexes: (moduleId, collections: ReadonlyArray<Collection<any>>) => {
        const want = new Map<string, { collection: string; field: string; ddl: string }>()
        for (const c of collections) {
          for (const field of c.indexes) {
            const name = indexName(moduleId, c.name, field)
            want.set(name, { collection: c.name, field, ddl: indexDdl(name, moduleId, c.name, field) })
          }
        }
        const have = all<{ name: string; ddl: string }>("SELECT name, ddl FROM pva_indexes WHERE module = ?", [moduleId])
        const existing = new Set(all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'pva_ix_%'").map((r) => r.name))
        for (const h of have) {
          const w = want.get(h.name)
          if (w !== undefined && w.ddl === h.ddl && existing.has(h.name)) {
            want.delete(h.name)
            continue
          }
          db.exec(`DROP INDEX IF EXISTS ${h.name}`)
          run("DELETE FROM pva_indexes WHERE name = ?", [h.name])
        }
        for (const [name, w] of want) {
          db.exec(`DROP INDEX IF EXISTS ${name}`)
          db.exec(w.ddl)
          run("INSERT INTO pva_indexes (name, module, collection, field, ddl) VALUES (?, ?, ?, ?, ?)", [name, moduleId, w.collection, w.field, w.ddl])
        }
      },
      core: coreOf,
      removed: scheduleScrub
    }

    // ---- Backups (a connection of their own, the copy on SQLite's worker thread), one at a time: in this process (the
    // semaphore) and across processes (the lock file in the backup directory)

    const backupLock = Semaphore.makeUnsafe(1)
    let backedUpForUpgrade: string | undefined
    let lastPrune: PruneResult = { removed: [], failed: [] }

    /** A backup before the first upgrade of this start (never of a new or in-memory file). */
    const backupBeforeUpgrade = (what: string) =>
      backupLock.withPermits(1)(Effect.gen(function*() {
        if (memory || backupDir === undefined || backedUpForUpgrade !== undefined) return backedUpForUpgrade
        if (created) return undefined
        const at = yield* Clock.currentTimeMillis
        const path = join(backupDir, `household-${localDate(at)}-before-${what}.db`)
        yield* files(`Backing up to ${path}`, () => withBackupLock(backupDir, () => copyDatabase(options.filename, path)))
        backedUpForUpgrade = path
        log(`Household data backed up to ${path} before upgrading ${what}`)
        return path
      }))

    const pruneBackups = (opts?: { readonly now?: number }) =>
      Effect.gen(function*() {
        if (memory) return { removed: [], failed: [] } satisfies PruneResult
        const now = opts?.now ?? (yield* Clock.currentTimeMillis)
        const dirs = [backupDir, options.backupCopyDir].filter((d): d is string => d !== undefined)
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
        if (failures.length > 0) log(`Household backups past ${keep} days could not be removed: ${failures.join("; ")}`)
        lastPrune = { removed, failed: failures }
        return lastPrune
      })

    const backup = (opts?: { readonly now?: number }) =>
      backupLock.withPermits(1)(Effect.gen(function*() {
        if (memory || backupDir === undefined) return yield* new StoreError({ reason: "unavailable", message: "An in-memory store has no backups" })
        const at = opts?.now ?? (yield* Clock.currentTimeMillis)
        const name = `household-${localDate(at)}.db`
        const path = join(backupDir, name)
        const copyDir = options.backupCopyDir
        yield* files(`Backing up to ${path}`, () =>
          withBackupLock(backupDir, async () => {
            await copyDatabase(options.filename, path)
            if (copyDir !== undefined) await copyFilePrivately(path, join(copyDir, name))
          }))
        yield* pruneBackups({ now: at })
        return { path }
      }))

    // ---- The engine, core SQL, the rest

    const engine = makeStoreEngine({ backend, backupBeforeUpgrade, log })
    const { runTx, inTransaction: _inTransaction, ...shared } = engine

    const step = <X>(what: string, f: () => X): Effect.Effect<X, StoreError> =>
      Effect.suspend(() => {
        try {
          return Effect.succeed(f())
        } catch (e) {
          return Effect.fail(e instanceof StoreError ? e : failed(what, e))
        }
      })

    const core = (owner: string): CoreSql => {
      const prefix = `core_${owner}__`
      return {
        prefix,
        query: (sql, params = []) =>
          step(`A query of ${owner}`, () => {
            if (TX_CONTROL.test(sql)) throw new StoreError({ reason: "invalid", message: `Core ${owner}: a statement may not begin or end a transaction` })
            return coreOf(owner).query(sql, params)
          }),
        run: (sql, params = []) =>
          step(`A write of ${owner}`, () => {
            if (readOnly) throw readOnlyError(`core ${owner}`)
            if (TX_CONTROL.test(sql)) throw new StoreError({ reason: "invalid", message: `Core ${owner}: a statement may not begin or end a transaction; it runs in the store's` })
            return runTx(() => coreOf(owner).run(sql, params))
          }),
        migrate: (migrations) =>
          Effect.gen(function*() {
            yield* step(`The ${owner} tables`, () => coreOf(owner))
            const at = (yield* step("Reading versions", () => backend.versions(`core:${owner}`))).get("sql") ?? 0
            if (at > migrations.length) {
              return yield* new StoreError({ reason: "unavailable", message: `The ${owner} tables were written by a newer version of the assistant (${at} > ${migrations.length})` })
            }
            if (at === migrations.length) return
            if (readOnly) return yield* new StoreError({ reason: "unavailable", message: `The ${owner} tables need an upgrade, which the server makes when it starts` })
            yield* backupBeforeUpgrade(owner)
            yield* step(`Upgrading the ${owner} tables`, () =>
              runTx(() => {
                for (let i = at; i < migrations.length; i++) {
                  db.exec(migrations[i]!)
                  if (!db.isTransaction) throw new StoreError({ reason: "failed", message: `The ${owner} migration ${i + 1} ended the transaction` })
                  backend.setVersion(`core:${owner}`, "sql", i + 1)
                }
              }))
          })
      }
    }

    const store: SqliteHouseholdStore = {
      ...shared,
      info: { kind: "sqlite", readOnly, ...(memory ? {} : { path: options.filename }) },
      core,
      backup,
      lastBackupAt: backupDir === undefined ? Effect.succeed(undefined) : Effect.promise(() => lastBackupIn(backupDir)),
      backupDir,
      pruneBackups,
      pruneFailures: () => lastPrune.failed,
      removalPendingSince: () => pendingSince,
      scrubbed,
      check: step("The quick check", () => all<Record<string, unknown>>("PRAGMA quick_check").map((x) => String(Object.values(x)[0])).join("; "))
    }
    return store
  })
