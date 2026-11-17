import { SqliteClient } from "@effect/sql-sqlite-node"
import {
  type Actor,
  type ChangeRecord,
  type Collection,
  type CommittedChange,
  type CoreSql,
  type HouseholdStore,
  matchesWords,
  type ModuleExport,
  type ModuleSql,
  readOnlyError,
  SEARCH_SCAN_ROWS,
  type ScopeRef,
  scopeFromColumns,
  scopeIdOf,
  type SqlMigration,
  sqlPrefixOf,
  type SqlValue,
  type StoredModule,
  StoreError,
  CHANGE_RETENTION_MS
} from "@pva/core"
import { makeModuleStoreOn, type StoreBackend, type StoredDoc } from "@pva/core/store-backend"
import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Effect, type Scope } from "effect"
import * as Reactivity from "effect/reactivity/Reactivity"
import { isSqlError, type SqlError } from "effect/sql/SqlError"
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { checkModuleStatement, coreStatements, type GuardContext, migrationStatements } from "./SqlGuard.ts"

/**
 * The household store on SQLite (docs/STORING-DATA.md; shared-state-jobs-and-notifications.md §4.1): one file
 * (`data/household.db`), WAL, `synchronous = NORMAL`, `secure_delete = ON` (deleted content is overwritten, so an
 * erase really erases), one connection with writes serialised (the driver's semaphore; a transaction holds the
 * connection), through `@effect/sql-sqlite-node` on Node's built-in `node:sqlite` (no native build).
 *
 * Every statement is synchronous on the main thread, which also frames audio. Each one is kept small: single-row
 * writes, indexed reads, retention in batches of 500 with a yield between them.
 */

/** The store's own schema version (`pva_meta.schema`). A file with a higher one is refused. */
export const CORE_SCHEMA_VERSION = 1

export interface SqliteStoreOptions {
  /** The database file, or `:memory:` (tests; the CLI modes when there is no file yet). */
  readonly filename: string
  /** Read only (the CLI modes): writes are refused; a file is opened read-only. */
  readonly readOnly?: boolean
  /** Where backups go. Default `<directory of the file>/backups`. */
  readonly backupDir?: string
  /** A second directory every backup is also copied to (a mounted share). */
  readonly backupCopyDir?: string
  /** Daily backups kept (and pre-upgrade backups kept). Default 14. */
  readonly keepBackups?: number
  /** Log lines (migrations, backups). */
  readonly log?: (line: string) => void
}

export interface SqliteHouseholdStore extends HouseholdStore {
  /** The newest backup's time (epoch ms), or `undefined` when there is none. */
  readonly lastBackupAt: Effect.Effect<number | undefined>
  readonly backupDir: string | undefined
  /** `PRAGMA quick_check` (doctor). */
  readonly check: Effect.Effect<string, StoreError>
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
  `CREATE INDEX pva_docs_scope ON pva_docs (module, collection, scope_kind, scope_id, updated_at)`,
  `CREATE INDEX pva_docs_conversation ON pva_docs (scope_id) WHERE scope_kind = 'conversation'`,
  `CREATE TABLE pva_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    op_id TEXT NOT NULL UNIQUE,
    module TEXT NOT NULL, collection TEXT NOT NULL,
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
    row_id TEXT NOT NULL, op TEXT NOT NULL, rev INTEGER NOT NULL,
    actor TEXT NOT NULL, actor_key TEXT NOT NULL, at INTEGER NOT NULL,
    data TEXT, undoes TEXT, undone INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX pva_changes_row ON pva_changes (module, collection, row_id)`,
  `CREATE INDEX pva_changes_actor ON pva_changes (module, collection, actor_key, seq)`,
  `CREATE INDEX pva_changes_at ON pva_changes (at)`,
  `CREATE TABLE pva_search_rows (
    rowid INTEGER PRIMARY KEY,
    module TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
    scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, updated_at INTEGER NOT NULL, text TEXT NOT NULL,
    UNIQUE (module, collection, id)
  )`,
  `CREATE INDEX pva_search_scope ON pva_search_rows (module, collection, scope_kind, scope_id, updated_at)`
]
const FTS_DDL = [
  `CREATE VIRTUAL TABLE pva_search USING fts5(text, content='pva_search_rows', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`,
  `INSERT INTO pva_search(pva_search, rank) VALUES ('secure-delete', 1)`
]

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/
const OWNER = /^[a-z][a-z0-9]{0,30}$/

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

interface ChangeRow {
  readonly seq: number
  readonly op_id: string
  readonly module: string
  readonly collection: string
  readonly scope_kind: string
  readonly scope_id: string
  readonly row_id: string
  readonly op: string
  readonly rev: number
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
  rev: Number(r.rev),
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

const DAILY = /^household-\d{4}-\d{2}-\d{2}\.db$/
const BEFORE = /^household-\d{4}-\d{2}-\d{2}-before-[a-z0-9-]+\.db$/

export const makeSqliteStore = (options: SqliteStoreOptions): Effect.Effect<SqliteHouseholdStore, StoreError, Scope.Scope> =>
  Effect.gen(function*() {
    const memory = options.filename === ":memory:"
    const readOnly = options.readOnly === true
    const log = options.log ?? (() => {})
    const keep = options.keepBackups ?? 14
    const backupDir = memory ? options.backupDir : options.backupDir ?? join(dirname(options.filename), "backups")

    const toStoreError = (what: string) => (e: SqlError): StoreError =>
      new StoreError({
        reason: /readonly|read-only/i.test(e.message) ? "read-only" : "failed",
        message: `${what}: ${e.message}${e.cause instanceof Error && e.cause.message !== e.message ? ` (${e.cause.message})` : ""}`,
        cause: e
      })

    if (!memory) yield* Effect.promise(() => mkdir(dirname(options.filename), { recursive: true }).catch(() => undefined))
    const client = yield* SqliteClient.make({
      filename: options.filename,
      readonly: readOnly && !memory,
      disableWAL: memory,
      prepareCacheSize: 500
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

    const transaction = <X, E, R>(work: Effect.Effect<X, E, R>): Effect.Effect<X, E | StoreError, R> =>
      client.withTransaction(work).pipe(
        Effect.mapError((e) => (isSqlError(e) ? toStoreError("A household store transaction failed")(e as SqlError) : e) as E | StoreError)
      )

    // ---- Open: settings, FTS5, the core schema

    if (!readOnly) {
      yield* exec("PRAGMA synchronous = NORMAL")
      yield* exec("PRAGMA secure_delete = ON")
    }
    const fts5 = yield* exec("CREATE VIRTUAL TABLE temp.pva_fts5_probe USING fts5(x)").pipe(
      Effect.andThen(exec("DROP TABLE temp.pva_fts5_probe")),
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
    const hasMeta = (yield* query<{ n: number }>("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'pva_meta'"))[0]!.n > 0
    const metaOf = (key: string) => Effect.map(query<{ value: string }>("SELECT value FROM pva_meta WHERE key = ?", [key]), (r) => r[0]?.value)
    let created = false
    if (!hasMeta) {
      if (readOnly && !memory) {
        return yield* new StoreError({ reason: "unavailable", message: `${options.filename} holds no household data yet` })
      }
      yield* transaction(Effect.gen(function*() {
        for (const ddl of CORE_DDL) yield* exec(ddl)
        if (fts5) for (const ddl of FTS_DDL) yield* exec(ddl)
        const at = yield* Clock.currentTimeMillis
        yield* exec("INSERT INTO pva_meta (key, value) VALUES ('schema', ?), ('search', ?), ('created', ?)", [String(CORE_SCHEMA_VERSION), fts5 ? "fts5" : "like", String(at)])
      }))
      created = true
    } else {
      const schema = Number((yield* metaOf("schema")) ?? "0")
      if (schema > CORE_SCHEMA_VERSION) {
        return yield* new StoreError({
          reason: "unavailable",
          message: `${options.filename} was written by a newer version of the assistant (household schema ${schema}; this version knows ${CORE_SCHEMA_VERSION}). ` +
            "Update the assistant, or restore a backup made by this version (docs/STORING-DATA.md, \"Restore\")."
        })
      }
      if ((yield* metaOf("search")) === "fts5" && !fts5) {
        return yield* new StoreError({ reason: "unavailable", message: `${options.filename} uses full-text search (FTS5), which this Node's SQLite does not have` })
      }
    }
    const searchFts = fts5 && (yield* metaOf("search")) === "fts5"

    // ---- Names in the schema (the SQL guard's "outside the prefix" list)

    let schemaNames: ReadonlySet<string> = new Set()
    const refreshNames = Effect.map(query<{ name: string }>("SELECT lower(name) AS name FROM sqlite_schema"), (rows) => {
      schemaNames = new Set(rows.map((r) => r.name))
    })
    yield* refreshNames

    // ---- Commit listeners

    const listeners = new Set<(changes: ReadonlyArray<CommittedChange>) => void>()
    const fire = (changes: ReadonlyArray<CommittedChange>) => {
      for (const l of listeners) {
        try {
          l(changes)
        } catch {
          // A listener must not break a commit.
        }
      }
    }

    // ---- Search rows

    const searchRow = (module: string, collection: string, id: string) =>
      Effect.map(
        query<{ rowid: number; text: string }>("SELECT rowid, text FROM pva_search_rows WHERE module = ? AND collection = ? AND id = ?", [module, collection, id]),
        (r) => r[0]
      )
    const dropSearch = (module: string, collection: string, id: string) =>
      Effect.gen(function*() {
        const old = yield* searchRow(module, collection, id)
        if (old === undefined) return
        if (searchFts) yield* exec("INSERT INTO pva_search (pva_search, rowid, text) VALUES ('delete', ?, ?)", [old.rowid, old.text])
        yield* exec("DELETE FROM pva_search_rows WHERE rowid = ?", [old.rowid])
      })
    const setSearch = (doc: StoredDoc, text: string) =>
      Effect.gen(function*() {
        yield* dropSearch(doc.module, doc.collection, doc.id)
        if (text.length === 0) return
        const r = yield* exec(
          "INSERT INTO pva_search_rows (module, collection, id, scope_kind, scope_id, updated_at, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [doc.module, doc.collection, doc.id, doc.scope.kind, scopeIdOf(doc.scope), doc.updatedAt, text]
        )
        if (searchFts) yield* exec("INSERT INTO pva_search (rowid, text) VALUES (?, ?)", [r.lastInsertRowid, text])
      })

    // ---- The backend the collection semantics run on

    const checkpoint = memory ? Effect.void : exec("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.ignore)

    const backend: StoreBackend = {
      readOnly,
      fts5,
      transaction,
      afterCommit: (change) => client.afterCommit(Effect.sync(() => fire([change]))),
      read: (module, collection, id) =>
        Effect.map(query<DocRow>("SELECT * FROM pva_docs WHERE module = ? AND collection = ? AND id = ?", [module, collection, id]), (r) => (r[0] === undefined ? undefined : toDoc(r[0]))),
      list: (module, collection, scope, q) => {
        // Module and collection as literals, so the planner can use the collection's partial indexes.
        const where = [`module = ${lit(module)}`, `collection = ${lit(collection)}`, "scope_kind = ?", "scope_id = ?"]
        const params: Array<unknown> = [scope.kind, scopeIdOf(scope)]
        for (const [field, value] of q.where) {
          if (value === null) where.push(`json_extract(value, '$.${field}') IS NULL`)
          else {
            where.push(`json_extract(value, '$.${field}') = ?`)
            params.push(typeof value === "boolean" ? (value ? 1 : 0) : value)
          }
        }
        const order = q.order.column ? (q.order.field === "createdAt" ? "created_at" : "updated_at") : `json_extract(value, '$.${q.order.field}')`
        params.push(q.limit)
        return Effect.map(
          query<DocRow>(`SELECT * FROM pva_docs WHERE ${where.join(" AND ")} ORDER BY ${order} ${q.order.desc ? "DESC" : "ASC"}, id ASC LIMIT ?`, params),
          (rows) => rows.map(toDoc)
        )
      },
      search: (module, collection, scope, words, limit) =>
        searchFts
          ? Effect.map(
            query<DocRow>(
              `SELECT d.* FROM pva_search s JOIN pva_search_rows r ON r.rowid = s.rowid
               JOIN pva_docs d ON d.module = r.module AND d.collection = r.collection AND d.id = r.id
               WHERE pva_search MATCH ? AND r.module = ? AND r.collection = ? AND r.scope_kind = ? AND r.scope_id = ?
               ORDER BY s.rank LIMIT ?`,
              [words.map((w) => `"${w}"*`).join(" "), module, collection, scope.kind, scopeIdOf(scope), limit]
            ),
            (rows) => rows.map(toDoc)
          )
          : Effect.map(
            query<DocRow & { search_text: string }>(
              `SELECT d.*, r.text AS search_text FROM pva_search_rows r
               JOIN pva_docs d ON d.module = r.module AND d.collection = r.collection AND d.id = r.id
               WHERE r.module = ? AND r.collection = ? AND r.scope_kind = ? AND r.scope_id = ?
               ORDER BY r.updated_at DESC LIMIT ?`,
              [module, collection, scope.kind, scopeIdOf(scope), SEARCH_SCAN_ROWS]
            ),
            (rows) => rows.filter((r) => matchesWords(r.search_text, words)).slice(0, limit).map(toDoc)
          ),
      put: (doc, expect, search) =>
        Effect.gen(function*() {
          const r = expect === "absent"
            ? yield* exec(
              `INSERT INTO pva_docs (module, collection, id, scope_kind, scope_id, rev, v, value, created_at, updated_at, updated_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              [doc.module, doc.collection, doc.id, doc.scope.kind, scopeIdOf(doc.scope), doc.rev, doc.v, doc.text, doc.createdAt, doc.updatedAt, JSON.stringify(doc.updatedBy)]
            )
            : yield* exec(
              `UPDATE pva_docs SET rev = ?, v = ?, value = ?, updated_at = ?, updated_by = ?
               WHERE module = ? AND collection = ? AND id = ? AND rev = ?`,
              [doc.rev, doc.v, doc.text, doc.updatedAt, JSON.stringify(doc.updatedBy), doc.module, doc.collection, doc.id, expect]
            )
          if (r.changes !== 1) return false
          yield* setSearch(doc, search)
          return true
        }),
      delete: (module, collection, id, expect) =>
        Effect.gen(function*() {
          const r = yield* exec("DELETE FROM pva_docs WHERE module = ? AND collection = ? AND id = ? AND rev = ?", [module, collection, id, expect])
          if (r.changes !== 1) return false
          yield* dropSearch(module, collection, id)
          return true
        }),
      rewrite: (doc, v, text) =>
        readOnly
          ? Effect.void
          : exec("UPDATE pva_docs SET v = ?, value = ? WHERE module = ? AND collection = ? AND id = ? AND rev = ?", [v, text, doc.module, doc.collection, doc.id, doc.rev]).pipe(Effect.ignore),
      append: (c) =>
        Effect.map(
          exec(
            `INSERT INTO pva_changes (op_id, module, collection, scope_kind, scope_id, row_id, op, rev, actor, actor_key, at, data, undoes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              c.opId,
              c.module,
              c.collection,
              c.scope.kind,
              scopeIdOf(c.scope),
              c.id,
              c.op,
              c.rev,
              JSON.stringify(c.actor),
              c.actorKey,
              c.at,
              c.payload === undefined ? null : JSON.stringify(c.payload),
              c.undoes ?? null
            ]
          ),
          (r) => r.lastInsertRowid
        ),
      lastUndoable: (module, collection, actorKey) =>
        Effect.map(
          query<ChangeRow>(
            `SELECT * FROM pva_changes WHERE module = ? AND collection = ? AND actor_key = ? AND undone = 0 AND undoes IS NULL AND op != 'erase'
             ORDER BY seq DESC LIMIT 1`,
            [module, collection, actorKey]
          ),
          (r) => (r[0] === undefined ? undefined : toChange(r[0]))
        ),
      markUndone: (seq) => Effect.asVoid(exec("UPDATE pva_changes SET undone = 1 WHERE seq = ?", [seq])),
      changedSince: (module, collection, id, seq) =>
        Effect.map(
          query<{ n: number }>(
            "SELECT count(*) AS n FROM pva_changes WHERE module = ? AND collection = ? AND row_id = ? AND seq > ? AND undone = 0 AND undoes IS NULL",
            [module, collection, id, seq]
          ),
          (r) => r[0]!.n > 0
        ),
      purge: (module, collection, id) =>
        Effect.gen(function*() {
          yield* exec("UPDATE pva_changes SET data = NULL WHERE module = ? AND collection = ? AND row_id = ? AND data IS NOT NULL", [module, collection, id])
          yield* dropSearch(module, collection, id)
        }),
      // After the commit (also when the erase ran inside an outer transaction): the WAL still holds the old pages.
      afterErase: client.afterCommit(checkpoint)
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

    const guardOf = (moduleId: string, allowSchema: boolean): GuardContext => ({ prefix: sqlPrefixOf(moduleId), schemaNames, allowSchema, readOnly })

    const verdictCache = new Map<string, string | undefined>()
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
      return {
        prefix,
        table: (name) => `${prefix}${name}`,
        fts5,
        query: <R>(sql: string, params: ReadonlyArray<SqlValue> = []) => Effect.andThen(checked(sql), query<R>(sql, params)),
        run: (sql, params = []) => (readOnly ? Effect.fail(readOnlyError("module SQL")) : Effect.andThen(checked(sql), exec(sql, params)))
      }
    }

    const hasData = Effect.map(query<{ n: number }>("SELECT (SELECT count(*) FROM pva_docs) + (SELECT count(*) FROM pva_versions) AS n"), (r) => r[0]!.n > 0)

    /** A backup before the first upgrade of this start (never of a new or in-memory file). */
    const backupBeforeUpgrade = (what: string) =>
      Effect.gen(function*() {
        if (memory || backupDir === undefined || backedUpForUpgrade !== undefined) return backedUpForUpgrade
        if (created && !(yield* hasData)) return undefined
        const at = yield* Clock.currentTimeMillis
        const path = join(backupDir, `household-${localDate(at)}-before-${what}.db`)
        yield* backupTo(path)
        backedUpForUpgrade = path
        log(`Household data backed up to ${path} before upgrading ${what}`)
        yield* prune(backupDir, BEFORE)
        return path
      })

    const indexDdl = (moduleId: string, c: Collection<any>) =>
      c.indexes.map((field) => {
        const name = `pva_ix_${moduleId.replace(/-/g, "_")}__${c.name}__${field}`.toLowerCase()
        return `CREATE INDEX IF NOT EXISTS ${name} ON pva_docs (scope_kind, scope_id, json_extract(value, '$.${field}'))
                WHERE module = ${lit(moduleId)} AND collection = ${lit(c.name)}`
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
        if (!MODULE_ID.test(m.id)) return verdicts.set(m.id, { reason: "Its id cannot key stored data." })
        const stored = yield* versionsOf(owner)
        const sqlStored = stored.get("sql") ?? 0
        const newer = [...collections.values()].find((c) => (stored.get(`collection:${c.name}`) ?? 0) > c.version)
        if (newer !== undefined || sqlStored > migrations.length) {
          return verdicts.set(m.id, {
            reason: newer !== undefined
              ? `Its stored data (${newer.name}, version ${stored.get(`collection:${newer.name}`)}) was written by a newer version of this module (this one knows ${newer.version}); update the module. The data is kept as it is.`
              : `Its stored tables (version ${sqlStored}) were written by a newer version of this module (this one knows ${migrations.length}); update the module. The data is kept as it is.`
          })
        }
        const pendingSql = sqlStored < migrations.length
        const pendingCollections = [...collections.values()].filter((c) => (stored.get(`collection:${c.name}`) ?? 0) < c.version)
        if (readOnly) {
          if (pendingSql) verdicts.set(m.id, { reason: "Its stored tables need an upgrade, which the server makes when it starts (pnpm start serve)." })
          return
        }
        let backup: string | undefined
        if (pendingSql) {
          const done = yield* Effect.result(backupBeforeUpgrade(m.id))
          if (done._tag === "Failure") {
            return verdicts.set(m.id, { reason: `Its data needs an upgrade, and the backup before it failed (${done.failure.message}); nothing was changed.` })
          }
          backup = done.success
        }
        const before = new Set(schemaNames)
        const upgraded = yield* Effect.result(transaction(Effect.gen(function*() {
          for (let i = sqlStored; i < migrations.length; i++) {
            yield* runMigration(m.id, migrations[i]!)
            yield* setVersion(owner, "sql", i + 1)
          }
          for (const c of pendingCollections) yield* setVersion(owner, `collection:${c.name}`, c.version)
          for (const c of collections.values()) for (const ddl of indexDdl(m.id, c)) yield* exec(ddl)
          yield* refreshNames
          const prefix = sqlPrefixOf(m.id)
          const strays = [...schemaNames].filter((n) => !before.has(n) && !n.startsWith(prefix) && !n.startsWith("pva_ix_") && !n.startsWith("sqlite_autoindex_"))
          if (strays.length > 0) return yield* new StoreError({ reason: "refused", message: `Module ${m.id}: its migrations made ${strays.join(", ")}, outside ${prefix}*` })
        })))
        if (upgraded._tag === "Failure") {
          yield* refreshNames.pipe(Effect.ignore)
          const where = backup !== undefined ? ` A backup from before is at ${backup}.` : ""
          log(`Module ${m.id}: upgrading its data failed: ${upgraded.failure.message}`)
          return verdicts.set(m.id, { reason: `Its data could not be upgraded (${upgraded.failure.message}); it was left as it was.${where}` })
        }
        if (pendingSql) log(`Module ${m.id}: data upgraded to version ${migrations.length}`)
      })

    // ---- Backups

    const backupTo = (path: string) =>
      Effect.gen(function*() {
        yield* Effect.promise(() => mkdir(dirname(path), { recursive: true }).catch(() => undefined))
        const part = `${path}.part`
        yield* Effect.promise(() => rm(part, { force: true }).catch(() => undefined))
        yield* client.backup(part).pipe(Effect.mapError(toStoreError(`Backing up to ${path} failed`)))
        yield* Effect.tryPromise({
          try: () => rename(part, path),
          catch: (cause) => new StoreError({ reason: "failed", message: `Backing up to ${path} failed`, cause })
        })
      })

    const prune = (dir: string, pattern: RegExp) =>
      Effect.promise(async () => {
        const names = (await readdir(dir).catch(() => [] as Array<string>)).filter((n) => pattern.test(n)).sort().reverse()
        for (const old of names.slice(keep)) await rm(join(dir, old), { force: true }).catch(() => undefined)
      })

    const backup = (opts?: { readonly now?: number }) =>
      Effect.gen(function*() {
        if (memory || backupDir === undefined) return yield* new StoreError({ reason: "unavailable", message: "An in-memory store has no backups" })
        const at = opts?.now ?? (yield* Clock.currentTimeMillis)
        const path = join(backupDir, `household-${localDate(at)}.db`)
        yield* backupTo(path)
        yield* prune(backupDir, DAILY)
        if (options.backupCopyDir !== undefined) {
          const copy = join(options.backupCopyDir, `household-${localDate(at)}.db`)
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(options.backupCopyDir!, { recursive: true })
              await copyFile(path, `${copy}.part`)
              await rename(`${copy}.part`, copy)
            },
            catch: (cause) => new StoreError({ reason: "failed", message: `Copying the backup to ${options.backupCopyDir} failed`, cause })
          })
          yield* prune(options.backupCopyDir, DAILY)
        }
        return { path }
      })

    const lastBackupAt = Effect.promise(async () => {
      if (backupDir === undefined) return undefined
      let newest: number | undefined
      for (const n of await readdir(backupDir).catch(() => [] as Array<string>)) {
        if (!DAILY.test(n) && !BEFORE.test(n)) continue
        const s = await stat(join(backupDir, n)).catch(() => undefined)
        if (s !== undefined && (newest === undefined || s.mtimeMs > newest)) newest = s.mtimeMs
      }
      return newest
    })

    // ---- The rest of the host's view

    const forModule = (moduleId: string) => {
      let s = stores.get(moduleId)
      if (s === undefined) {
        s = makeModuleStoreOn(backend, moduleId, declared.get(moduleId)?.collections ?? new Map(), moduleSql(moduleId, "run"))
        stores.set(moduleId, s)
      }
      return s
    }

    const lastSeq = Effect.map(query<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'pva_changes'"), (r) => Number(r[0]?.seq ?? 0))

    const core = (owner: string): CoreSql => {
      const prefix = `core_${owner}__`
      const valid = OWNER.test(owner)
      const bad = Effect.fail(new StoreError({ reason: "invalid", message: `"${owner}" is not a core owner name` }))
      return {
        prefix,
        query: (sql, params = []) => (valid ? query(sql, params) : bad),
        run: (sql, params = []) => (!valid ? bad : readOnly ? Effect.fail(readOnlyError(`core ${owner}`)) : exec(sql, params)),
        migrate: (migrations) =>
          Effect.gen(function*() {
            if (!valid) return yield* bad
            const versions = yield* versionsOf(`core:${owner}`)
            const at = versions.get("sql") ?? 0
            if (at > migrations.length) {
              return yield* new StoreError({ reason: "unavailable", message: `The ${owner} tables were written by a newer version of the assistant (${at} > ${migrations.length})` })
            }
            if (at === migrations.length) return
            if (readOnly) return yield* new StoreError({ reason: "unavailable", message: `The ${owner} tables need an upgrade, which the server makes when it starts` })
            yield* backupBeforeUpgrade(owner)
            yield* transaction(Effect.gen(function*() {
              for (let i = at; i < migrations.length; i++) {
                for (const statement of coreStatements(migrations[i]!)) yield* exec(statement)
                yield* setVersion(`core:${owner}`, "sql", i + 1)
              }
            }))
            yield* refreshNames
          })
      }
    }

    const exportModule = (moduleId: string) =>
      Effect.gen(function*() {
        const at = yield* Clock.currentTimeMillis
        const collections: Record<string, Array<ModuleExport["collections"][string][number]>> = {}
        const docs = yield* query<DocRow>("SELECT * FROM pva_docs WHERE module = ? ORDER BY collection, created_at, id", [moduleId])
        for (const r of docs) {
          const d = toDoc(r)
          ;(collections[d.collection] ??= []).push({ id: d.id, rev: d.rev, scope: d.scope, value: JSON.parse(d.text), createdAt: d.createdAt, updatedAt: d.updatedAt })
        }
        const prefix = sqlPrefixOf(moduleId)
        const objects = yield* query<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, ?) = ?", [prefix.length, prefix])
        const virtual = objects.filter((o) => /^\s*create\s+virtual/i.test(o.sql ?? "")).map((o) => o.name)
        const shadow = (n: string) => virtual.some((v) => n.startsWith(`${v}_`))
        const tables: Record<string, ReadonlyArray<Record<string, unknown>>> = {}
        for (const o of objects) {
          if (virtual.includes(o.name) || shadow(o.name)) continue
          const rows = yield* query<Record<string, unknown>>(`SELECT * FROM "${o.name.replace(/"/g, "\"\"")}" LIMIT 100000`)
          tables[o.name.slice(prefix.length)] = rows.map((row) =>
            Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { base64: Buffer.from(v).toString("base64") } : typeof v === "bigint" ? String(v) : v]))
          )
        }
        return { module: moduleId, exportedAt: at, collections, tables } satisfies ModuleExport
      })

    const store: SqliteHouseholdStore = {
      info: { kind: "sqlite", readOnly, fts5, ...(memory ? {} : { path: options.filename }) },
      prepare: (modules) => Effect.forEach(modules, prepareOne, { discard: true }),
      availability: (moduleId) => verdicts.get(moduleId),
      forModule,
      transaction,
      core,
      changesSince: (seq, limit) =>
        Effect.gen(function*() {
          const rows = yield* query<ChangeRow>("SELECT * FROM pva_changes WHERE seq > ? ORDER BY seq LIMIT ?", [seq, limit + 1])
          const oldestRow = yield* query<{ seq: number | null }>("SELECT min(seq) AS seq FROM pva_changes")
          const oldest = oldestRow[0]?.seq ?? (yield* lastSeq) + 1
          return { changes: rows.slice(0, limit).map(toChange), complete: rows.length <= limit, oldest: Number(oldest) }
        }),
      lastSeq,
      endConversation: (conversationId) =>
        readOnly ? Effect.succeed(0) : transaction(Effect.gen(function*() {
          const rows = yield* query<{ module: string; collection: string; id: string }>(
            "SELECT module, collection, id FROM pva_docs WHERE scope_kind = 'conversation' AND scope_id = ?",
            [conversationId]
          )
          for (const r of rows) yield* dropSearch(r.module, r.collection, r.id)
          const done = yield* exec("DELETE FROM pva_docs WHERE scope_kind = 'conversation' AND scope_id = ?", [conversationId])
          return done.changes
        })),
      pruneChanges: (opts) =>
        readOnly ? Effect.fail(readOnlyError("pruneChanges")) : Effect.gen(function*() {
          const now = opts?.now ?? (yield* Clock.currentTimeMillis)
          const cut = now - (opts?.maxAgeMs ?? CHANGE_RETENTION_MS)
          let total = 0
          for (;;) {
            const r = yield* exec("DELETE FROM pva_changes WHERE seq IN (SELECT seq FROM pva_changes WHERE at < ? ORDER BY seq LIMIT 500)", [cut])
            total += r.changes
            if (r.changes < 500) return total
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
      check: Effect.map(query<{ quick_check: string }>("PRAGMA quick_check"), (r) => r.map((x) => Object.values(x)[0]).join("; "))
    }
    return store
  })

export type { ScopeRef }
