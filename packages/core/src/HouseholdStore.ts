import type { HouseholdScope, ModuleUnavailable } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { CurrentTurn, type TurnContext, type TurnSource } from "./TurnContext.ts"

/**
 * The household store (docs/MODULES-PLAN.md §4 P4; docs/STORING-DATA.md; shared-state-jobs-and-notifications.md §4):
 * the one place modules keep data that outlives a turn, a conversation and an instance. This file is the contract;
 * `@pva/store-sqlite` implements it on `data/household.db`, and `@pva/core/testing` has an in-memory double with the
 * same semantics (`makeMemoryHouseholdStore`) that passes the same contract tests (`@pva/core/store-contract`).
 *
 * - **Document collections** (`defineCollection`): JSON rows validated by a Schema, each with an id, a `rev`, a scope
 *   and who changed it last; equality filters, ordering and limits backed by declared indexes; full-text search over
 *   declared fields; lazy migration on read. Every write appends one change-log row in the same transaction.
 * - **Module SQL** (`ModuleStore.sql`): a module's own tables, prefixed `m_<moduleId>__`, with its own migrations;
 *   statements that reach outside the prefix are refused. SQLite store only.
 * - **Transactions** span a module's collections and its SQL (`ModuleStore.transaction`); core services (scheduler,
 *   notifications) join the same transaction with their own tables (`HouseholdStore.core`).
 *
 * Every call is synchronous SQLite on the main thread in the SQLite store, which also frames audio: keep each
 * statement small (single-row writes, indexed reads), and never wait on the network inside a transaction.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Scopes and actors

/** Where a row belongs (`household` has no id). The same shape as the protocol's `HouseholdScope`. */
export type ScopeRef = HouseholdScope
export type ScopeKind = ScopeRef["kind"]

export const HOUSEHOLD_SCOPE: ScopeRef = { kind: "household" }

/** `household`, or `<kind>:<id>`: a key for maps and logs. */
export const scopeKey = (scope: ScopeRef): string => (scope.kind === "household" ? "household" : `${scope.kind}:${scope.id}`)

/** The scope id stored in a column ("" for household). */
export const scopeIdOf = (scope: ScopeRef): string => (scope.kind === "household" ? "" : scope.id)

/** A scope from its two columns. */
export const scopeFromColumns = (kind: string, id: string): ScopeRef =>
  kind === "household" ? HOUSEHOLD_SCOPE : { kind: kind as Exclude<ScopeKind, "household">, id }

/**
 * Who made a change. A turn's actor carries what identifies the speaker as far as the server knows; jobs, the admin
 * page, a tap on a device and a module's own code (no turn) have their own kinds.
 */
export type Actor =
  | {
    readonly kind: "turn"
    readonly turnId: number
    readonly conversationId: string
    readonly source: TurnSource
    readonly assistantId?: string
    readonly deviceId?: string
    readonly personId?: string
  }
  | { readonly kind: "job"; readonly jobId: string }
  | { readonly kind: "admin" }
  | { readonly kind: "ui"; readonly deviceId: string }
  | { readonly kind: "module"; readonly moduleId: string }
  | { readonly kind: "system"; readonly name: string }

/** The actor of a turn (`CurrentTurn`). */
export const actorOfTurn = (turn: TurnContext): Actor => ({
  kind: "turn",
  turnId: turn.turnId,
  conversationId: turn.conversationId,
  source: turn.source,
  ...(turn.assistantId !== undefined ? { assistantId: turn.assistantId } : {}),
  ...(turn.deviceId !== undefined ? { deviceId: turn.deviceId } : {}),
  ...(turn.person !== undefined ? { personId: turn.person.id } : {})
})

/**
 * Who "the same actor" is for undo: a person when one is known, else the device (a voice turn and a tap on the same
 * device are one actor), else the conversation; a job, the admin, a module, a system task by their ids.
 */
export const actorKey = (actor: Actor): string => {
  switch (actor.kind) {
    case "turn":
      return actor.personId !== undefined ? `person:${actor.personId}` : actor.deviceId !== undefined ? `device:${actor.deviceId}` : `conversation:${actor.conversationId}`
    case "ui":
      return `device:${actor.deviceId}`
    case "job":
      return `job:${actor.jobId}`
    case "admin":
      return "admin"
    case "module":
      return `module:${actor.moduleId}`
    case "system":
      return `system:${actor.name}`
  }
}

/** The actor of a call: the one given, else the turn's (`CurrentTurn`), else the module itself. */
export const currentActor = (moduleId: string, given?: Actor): Effect.Effect<Actor> =>
  given !== undefined ? Effect.succeed(given) : Effect.map(Effect.service(CurrentTurn), (turn) => (turn === undefined ? { kind: "module", moduleId } : actorOfTurn(turn)))

// ---------------------------------------------------------------------------------------------------------------------
// Errors

/**
 * The store could not do it. `unavailable`: no store in this mode, or the module's data is not usable here;
 * `read-only`: the CLI modes read the store and never write it; `invalid`: the call itself is wrong (an undeclared
 * collection, an unindexed filter, a value that does not match the schema); `refused`: module SQL that reaches
 * outside the module's tables; `failed`: the database said no.
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  reason: Schema.Literals(["unavailable", "read-only", "invalid", "refused", "failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** The row moved on: `expectRev` was not its rev, or three optimistic attempts all lost their race. */
export class StoreConflict extends Schema.TaggedError<StoreConflict>()("StoreConflict", {
  collection: Schema.String,
  id: Schema.String,
  message: Schema.String
}) {}

/** There is no such row in the scope asked for. */
export class StoreNotFound extends Schema.TaggedError<StoreNotFound>()("StoreNotFound", {
  collection: Schema.String,
  id: Schema.String
}) {}

/**
 * The scope's id is not known for this call: a person-scoped collection with no known person (no voice
 * identification; P5 adds the device's default person), a device-scoped one outside a device's turn, any non-household
 * scope in a job or `shared` code that did not pass one. A module turns it into a question ("Whose reminder is
 * this?") or passes the scope explicitly. Never silently written to the household instead.
 */
export class ScopeUnknown extends Schema.TaggedError<ScopeUnknown>()("ScopeUnknown", {
  collection: Schema.String,
  scope: Schema.Literals(["person", "assistant", "device", "conversation"]),
  message: Schema.String
}) {}

// ---------------------------------------------------------------------------------------------------------------------
// Collections

/** One stored row: the value with its id, rev, scope and who changed it last. Times are epoch milliseconds. */
export interface Row<A> {
  readonly id: string
  readonly rev: number
  readonly scope: ScopeRef
  readonly value: A
  readonly createdAt: number
  readonly updatedAt: number
  readonly updatedBy: Actor
}

/**
 * The device a page runs on, as a projection sees it. Small on purpose and growing: P5 adds the device's room and
 * default person. `id` is absent for a voice page that sent no device.
 */
export interface TargetDevice {
  readonly id?: string
  readonly name?: string
}

/** What an `ambient` function is given besides the rows. */
export interface AmbientContext {
  readonly now: number
  readonly turn: TurnContext | undefined
}

/** A filter value: equality on a declared index (`null` matches a missing field). */
export type WhereValue = string | number | boolean | null

/** A collection as declared (`defineCollection`). */
export interface Collection<A> {
  readonly _tag: "Collection"
  /** `/^[a-z][a-z0-9_]{0,39}$/`, unique within the module. */
  readonly name: string
  readonly scope: ScopeKind
  /** The row's type; rows are stored in its JSON form (`Schema.toCodecJson`). */
  readonly schema: Schema.Codec<A, unknown>
  /** Raised by one for each change of shape; rows of an older version are migrated on read (`migrate`). */
  readonly version: number
  /** `migrate[n]` turns a version-`n` value (JSON form) into a version-`n+1` one. One entry per version below `version`. */
  readonly migrate: Readonly<Record<number, (value: any) => unknown>>
  /** Top-level fields `list` may filter (`where`) or order on. Each is one index. */
  readonly indexes: ReadonlyArray<string>
  /** Top-level string (or string list) fields that `search` looks in. */
  readonly search: ReadonlyArray<string>
  /** `full`: the change log keeps each change's values (undo works). `none`: only that it happened (no undo). */
  readonly history: "full" | "none"
  /** Lines for the per-turn household facts (shared-state §7), from the rows the turn's device and person see. */
  readonly ambient?: (rows: ReadonlyArray<Row<A>>, context: AmbientContext) => string | ReadonlyArray<string> | undefined
  /** How many rows (newest first) per scope the ambient lines are made from. Default 20. */
  readonly ambientRows: number
  /**
   * What a voice page on `device` may see of a row, or `undefined` for nothing (docs/STORING-DATA.md "Pages"). Without
   * it the collection is never sent to pages. Called for the snapshot, for every change and for the replay after a
   * reconnect, always with the row as it is now. Return plain JSON.
   */
  readonly project?: (row: Row<A>, device: TargetDevice) => unknown
}

const NAME = /^[a-z][a-z0-9_]{0,39}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** Declare a document collection. Checked at definition time. */
export const defineCollection = <A>(definition: {
  readonly name: string
  readonly scope: ScopeKind
  readonly schema: Schema.Codec<A, unknown>
  readonly version?: number
  readonly migrate?: Readonly<Record<number, (value: any) => unknown>>
  readonly indexes?: ReadonlyArray<string>
  readonly search?: ReadonlyArray<string>
  readonly history?: "full" | "none"
  readonly ambient?: Collection<A>["ambient"]
  readonly ambientRows?: number
  readonly project?: Collection<A>["project"]
}): Collection<A> => {
  const version = definition.version ?? 1
  if (!NAME.test(definition.name)) throw new Error(`Collection name "${definition.name}" must match ${NAME}`)
  if (!Number.isInteger(version) || version < 1 || version > 10_000) throw new Error(`Collection ${definition.name}: version must be a whole number from 1`)
  for (let v = 1; v < version; v++) {
    if (typeof definition.migrate?.[v] !== "function") throw new Error(`Collection ${definition.name}: migrate[${v}] (version ${v} to ${v + 1}) is missing`)
  }
  for (const field of [...(definition.indexes ?? []), ...(definition.search ?? [])]) {
    if (!FIELD.test(field)) throw new Error(`Collection ${definition.name}: field "${field}" must match ${FIELD}`)
  }
  if ((definition.indexes?.length ?? 0) > 8) throw new Error(`Collection ${definition.name}: at most 8 indexes`)
  return {
    _tag: "Collection",
    name: definition.name,
    scope: definition.scope,
    schema: definition.schema,
    version,
    migrate: definition.migrate ?? {},
    indexes: definition.indexes ?? [],
    search: definition.search ?? [],
    history: definition.history ?? "full",
    ...(definition.ambient !== undefined ? { ambient: definition.ambient } : {}),
    ambientRows: definition.ambientRows ?? 20,
    ...(definition.project !== undefined ? { project: definition.project } : {})
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Module SQL

/** A value bound to a `?` of module SQL. */
export type SqlValue = string | number | bigint | null | Uint8Array

/**
 * A module's own SQL (SQLite store): tables, indexes, views, triggers and FTS5 tables whose names start with
 * `prefix` (`m_<moduleId>__`, dashes as underscores). One statement per call, `?` placeholders. Refused: names
 * outside the prefix (in any quoting), `ATTACH`, `PRAGMA`, transaction statements, `sqlite_*` and `pragma_*` names;
 * schema statements (`CREATE`, `DROP`, `ALTER`) outside the module's migrations.
 */
export interface ModuleSql {
  readonly prefix: string
  /** `table("items")` = `m_lists__items`. */
  readonly table: (name: string) => string
  /** The SQLite build has FTS5 (`CREATE VIRTUAL TABLE … USING fts5`). Without it, fall back to `LIKE`. */
  readonly fts5: boolean
  readonly query: <R = Record<string, unknown>>(sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<R>, StoreError>
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<{ readonly changes: number; readonly lastInsertRowid: number }, StoreError>
}

/** One migration of a module's SQL: statements (`;`-separated) or an effect on the guarded `ModuleSql`. */
export type SqlMigration = string | ((sql: ModuleSql) => Effect.Effect<void, StoreError>)

/** What a module declares about its data (`defineModule({ storage })`, module API 2). */
export interface ModuleStorage {
  /** Every collection the module uses. A collection not listed here is refused at run time. */
  readonly collections?: ReadonlyArray<Collection<any>>
  /** Module SQL; `migrations[n]` brings the module's SQL schema from version `n` to `n + 1`. Never edit a released one. */
  readonly sql?: { readonly migrations: ReadonlyArray<SqlMigration> }
}

/** Check a module's storage declaration (called by `defineModule`). */
export const checkModuleStorage = (moduleId: string, storage: ModuleStorage): void => {
  const seen = new Set<string>()
  for (const c of storage.collections ?? []) {
    if (c._tag !== "Collection") throw new Error(`Module ${moduleId}: storage.collections holds something that is not a collection`)
    if (seen.has(c.name)) throw new Error(`Module ${moduleId}: collection "${c.name}" is declared twice`)
    seen.add(c.name)
  }
  if ((storage.sql?.migrations.length ?? 0) > 1000) throw new Error(`Module ${moduleId}: too many SQL migrations`)
}

/** The table prefix of a module's SQL. */
export const sqlPrefixOf = (moduleId: string): string => `m_${moduleId.replace(/-/g, "_")}__`

// ---------------------------------------------------------------------------------------------------------------------
// The module's view: ctx.store

export interface ScopeOptions {
  /** The scope, when it is not the turn's (jobs, shared code, admin). Must be of the collection's kind. */
  readonly scope?: ScopeRef
}

export interface WriteOptions extends ScopeOptions {
  /** Who did it, when it is not the turn (jobs, a tap). Default: the turn's actor, else the module. */
  readonly actor?: Actor
}

export interface ListQuery<A> extends ScopeOptions {
  /** Equality on declared indexes. */
  readonly where?: Partial<Record<keyof A & string, WhereValue>>
  /** A declared index, or `createdAt` / `updatedAt` (default: `updatedAt`, newest first). */
  readonly orderBy?: { readonly field: (keyof A & string) | "createdAt" | "updatedAt"; readonly direction?: "asc" | "desc" }
  /** Default 100, at most 1000. */
  readonly limit?: number
}

/** What `undo` reversed: the change it undid, and the row as it is now (`undefined` when the undo removed it). */
export interface UndoResult<A> {
  readonly undid: "insert" | "update" | "remove"
  readonly id: string
  readonly row: Row<A> | undefined
}

export interface CollectionHandle<A> {
  /** The row, or `undefined` when there is none in the scope. */
  readonly get: (id: string, options?: ScopeOptions) => Effect.Effect<Row<A> | undefined, StoreError | ScopeUnknown>
  readonly list: (query?: ListQuery<A>) => Effect.Effect<ReadonlyArray<Row<A>>, StoreError | ScopeUnknown>
  /**
   * Rows whose `search` fields contain every word of `text` (FTS5 ranking where the build has it; otherwise a scan
   * of the newest 2,000 rows of the scope). Default limit 20.
   */
  readonly search: (text: string, options?: ScopeOptions & { readonly limit?: number }) => Effect.Effect<ReadonlyArray<Row<A>>, StoreError | ScopeUnknown>
  /** A new row (a random id unless `id` is given; an id in use is a `StoreConflict`). */
  readonly insert: (value: A, options?: WriteOptions & { readonly id?: string }) => Effect.Effect<Row<A>, StoreError | StoreConflict | ScopeUnknown>
  /**
   * Optimistic update: `f` is applied to the value read, and the write succeeds only if the rev has not moved; it is
   * re-applied to a fresh read on a conflict, three attempts in all. With `expectRev`, a row at another rev is a
   * conflict at once.
   */
  readonly update: (
    id: string,
    f: (value: A) => A,
    options?: WriteOptions & { readonly expectRev?: number }
  ) => Effect.Effect<Row<A>, StoreError | StoreConflict | StoreNotFound | ScopeUnknown>
  /** `false` when there was no such row. */
  readonly remove: (id: string, options?: WriteOptions & { readonly expectRev?: number }) => Effect.Effect<boolean, StoreError | StoreConflict | ScopeUnknown>
  /**
   * Remove the row and every earlier payload of it: its values in the change log (the log keeps that a change
   * happened, without content) and its search entries. Daily backups keep it until they rotate out (14 days).
   */
  readonly erase: (id: string, options?: WriteOptions) => Effect.Effect<boolean, StoreError | ScopeUnknown>
  /**
   * Undo the last change the actor (default: the turn's) made in this collection that is not already undone. A row
   * changed by someone else since is a `StoreConflict`. `undefined`: nothing to undo. Never for `history: "none"`.
   */
  readonly undo: (options?: { readonly actor?: Actor }) => Effect.Effect<UndoResult<A> | undefined, StoreError | StoreConflict>
}

/** A module SQL write reported to the change log and the bus (collections log their own writes). */
export interface SqlChange {
  /** The table without its prefix. */
  readonly table: string
  readonly id: string
  readonly op: "insert" | "update" | "remove"
  readonly scope?: ScopeRef
  readonly actor?: Actor
}

/** `ctx.store`: a module's data, shared by all its instances and its `shared` part. */
export interface ModuleStore {
  readonly moduleId: string
  /** The CLI modes read the store and refuse every write. */
  readonly readOnly: boolean
  readonly fts5: boolean
  /** A declared collection (an undeclared one fails each call with `invalid`). */
  readonly collection: <A>(collection: Collection<A>) => CollectionHandle<A>
  /** The module's SQL (fails `unavailable` without `storage.sql`, or in the in-memory store). */
  readonly sql: ModuleSql
  /**
   * Run `work` in one transaction (nested calls are savepoints): every collection write and SQL statement in it
   * commits or rolls back together, and events are published only after the commit. No network calls inside: the
   * transaction holds the database's one connection.
   */
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /** Record a module SQL write in the change log (for "what changed" and the bus). */
  readonly logChange: (change: SqlChange) => Effect.Effect<void, StoreError>
}

// ---------------------------------------------------------------------------------------------------------------------
// The host's view

export type ChangeOp = "insert" | "update" | "remove" | "erase"

/** A committed change, as the bus receives it (values decoded; `before` is the value it replaced). */
export interface CommittedChange {
  readonly seq: number
  readonly opId: string
  readonly at: number
  readonly module: string
  /** The collection, or `sql:<table>` for a module SQL change. */
  readonly collection: string
  readonly id: string
  readonly op: ChangeOp
  readonly rev: number
  readonly scope: ScopeRef
  readonly actor: Actor
  readonly row?: Row<unknown>
  readonly before?: Row<unknown>
}

/** One change-log row as read back (`changesSince`). Payloads are absent for `history: "none"`, erased rows and SQL changes. */
export interface ChangeRecord {
  readonly seq: number
  readonly opId: string
  readonly at: number
  readonly module: string
  readonly collection: string
  readonly id: string
  readonly op: ChangeOp
  readonly rev: number
  readonly scope: ScopeRef
  readonly actor: Actor
  /** The version the payloads were written at, and the values before and after (JSON form). */
  readonly payload?: { readonly v: number; readonly before?: unknown; readonly after?: unknown }
  readonly undoes?: string
  readonly undone: boolean
}

/** A core service's own SQL (scheduler, notifications): tables `core_<owner>__*`, joined to `transaction`. SQLite only. */
export interface CoreSql {
  readonly prefix: string
  readonly query: <R = Record<string, unknown>>(sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<R>, StoreError>
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<{ readonly changes: number; readonly lastInsertRowid: number }, StoreError>
  /** Bring the owner's tables to `migrations.length` (each in the store's migration transaction, after a backup). */
  readonly migrate: (migrations: ReadonlyArray<string>) => Effect.Effect<void, StoreError>
}

/** One module's data as JSON (`HouseholdStore.exportModule`). */
export interface ModuleExport {
  readonly module: string
  readonly exportedAt: number
  readonly collections: Readonly<Record<string, ReadonlyArray<{ readonly id: string; readonly rev: number; readonly scope: ScopeRef; readonly value: unknown; readonly createdAt: number; readonly updatedAt: number }>>>
  readonly tables: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>
}

export interface StoreInfo {
  readonly kind: "sqlite" | "memory" | "closed"
  readonly readOnly: boolean
  readonly fts5: boolean
  /** The database file (SQLite). */
  readonly path?: string
}

/** A module as `prepare` sees it. */
export interface StoredModule {
  readonly id: string
  readonly storage: ModuleStorage | undefined
}

export interface HouseholdStore {
  readonly info: StoreInfo
  /**
   * Judge and upgrade every module's data, once, before the module host is made: a module whose stored versions are
   * newer than it declares is `unavailable` (its data is never touched); pending migrations run in one transaction
   * per module after a backup of the file; a failed migration leaves the data as it was and the module unavailable.
   */
  readonly prepare: (modules: ReadonlyArray<StoredModule>) => Effect.Effect<void, StoreError>
  /** Why a module's data cannot be used here (from `prepare`), or `undefined`. */
  readonly availability: (moduleId: string) => ModuleUnavailable | undefined
  /** `ctx.store` of a module (prepared or not: an unprepared module has no collections). */
  readonly forModule: (moduleId: string) => ModuleStore
  /** One transaction across modules and core services (`ModuleStore.transaction` is this). */
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /** A core service's own tables (P6 scheduler, P9 notifications). */
  readonly core: (owner: string) => CoreSql
  /** The change log after `seq`, oldest first, at most `limit`; `complete`: nothing after these. */
  readonly changesSince: (seq: number, limit: number) => Effect.Effect<{ readonly changes: ReadonlyArray<ChangeRecord>; readonly complete: boolean; readonly oldest: number }, StoreError>
  /** The change log's last number (0 when empty). */
  readonly lastSeq: Effect.Effect<number, StoreError>
  /** Delete every conversation-scoped row of a conversation that ended. Returns how many. */
  readonly endConversation: (conversationId: string) => Effect.Effect<number, StoreError>
  /** Retention: delete change-log rows older than `maxAgeMs` (default 90 days), in small batches. */
  readonly pruneChanges: (options?: { readonly now?: number; readonly maxAgeMs?: number }) => Effect.Effect<number, StoreError>
  /** An online backup to `<dir>/household-<date>.db` (keeps 14), and a copy to the second directory if set. */
  readonly backup: (options?: { readonly now?: number }) => Effect.Effect<{ readonly path: string }, StoreError>
  /** One module's data as JSON. */
  readonly exportModule: (moduleId: string) => Effect.Effect<ModuleExport, StoreError>
  /** Called after each commit with what it committed, in order (the event bus). Returns an unsubscribe function. */
  readonly onCommit: (listener: (changes: ReadonlyArray<CommittedChange>) => void) => () => void
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers both stores use

export const DEFAULT_LIST_LIMIT = 100
export const MAX_LIST_LIMIT = 1000
export const SEARCH_SCAN_ROWS = 2000
/** The largest value a row may hold, as JSON. */
export const MAX_VALUE_CHARS = 64_000
export const CHANGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const ID = /^[A-Za-z0-9_.:-]{1,200}$/

/** A row id a caller chose must be 1–200 characters of letters, digits and `_ . : -`. */
export const checkRowId = (collection: string, id: string): Effect.Effect<void, StoreError> =>
  ID.test(id) ? Effect.void : Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection}: "${id.slice(0, 40)}" is not a valid row id` }))

/**
 * The scope of a call: the one given (it must be of the collection's kind), else the turn's (`CurrentTurn`), else
 * `ScopeUnknown`. Household needs nothing.
 */
export const resolveScope = (collection: Collection<any>, given: ScopeRef | undefined): Effect.Effect<ScopeRef, StoreError | ScopeUnknown> => {
  if (given !== undefined) {
    if (given.kind !== collection.scope) {
      return Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection.name} is ${collection.scope}-scoped; it was given a ${given.kind} scope` }))
    }
    if (given.kind !== "household" && (given.id.length === 0 || given.id.length > 200)) {
      return Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection.name}: a scope id must be 1 to 200 characters` }))
    }
    return Effect.succeed(given)
  }
  const kind = collection.scope
  if (kind === "household") return Effect.succeed(HOUSEHOLD_SCOPE)
  return Effect.flatMap(Effect.service(CurrentTurn), (turn) => {
    const id = turn === undefined
      ? undefined
      : kind === "person" ? turn.person?.id : kind === "device" ? turn.deviceId : kind === "assistant" ? turn.assistantId : turn.conversationId
    if (id !== undefined && id !== "") return Effect.succeed<ScopeRef>({ kind, id })
    const message = kind === "person"
      ? `No person is known for this ${turn === undefined ? "call" : "turn"}, so it is not clear whose ${collection.name} this is.`
      : `No ${kind} is known for this ${turn === undefined ? "call (no turn)" : "turn"}; pass the scope explicitly.`
    return Effect.fail(new ScopeUnknown({ collection: collection.name, scope: kind, message }))
  })
}

const jsonCodecs = new WeakMap<object, Schema.Codec<any, unknown>>()
const jsonOf = <A>(collection: Collection<A>): Schema.Codec<A, unknown> => {
  let codec = jsonCodecs.get(collection.schema)
  if (codec === undefined) {
    codec = Schema.toCodecJson(collection.schema) as unknown as Schema.Codec<A, unknown>
    jsonCodecs.set(collection.schema, codec)
  }
  return codec
}

/**
 * A value as it is stored: validated against the schema (encoded, then decoded again, so the row returned is what a
 * read gives back), with its JSON text. Values over `MAX_VALUE_CHARS` are refused.
 */
export const encodeValue = <A>(collection: Collection<A>, value: A): Effect.Effect<{ readonly json: unknown; readonly text: string; readonly value: A }, StoreError> =>
  Effect.gen(function*() {
    const codec = jsonOf(collection)
    const json = yield* Schema.encodeUnknownEffect(codec)(value).pipe(
      Effect.mapError((e) => new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the value does not match its schema: ${e.message}` }))
    )
    const text = JSON.stringify(json)
    if (text === undefined) return yield* new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the value is not JSON` })
    if (text.length > MAX_VALUE_CHARS) {
      return yield* new StoreError({ reason: "invalid", message: `Collection ${collection.name}: a value may hold at most ${MAX_VALUE_CHARS} characters of JSON` })
    }
    const decoded = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(text)).pipe(
      Effect.mapError((e) => new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the value does not survive storing: ${e.message}` }))
    )
    return { json, text, value: decoded }
  })

/**
 * A stored value (JSON form, written at version `v`) as the collection's type now: migrated forward one version at a
 * time, then decoded. `migrated` tells the store to rewrite it lazily. A value from a newer version is refused.
 */
export const decodeStored = <A>(
  collection: Collection<A>,
  v: number,
  json: unknown,
  id: string
): Effect.Effect<{ readonly value: A; readonly migrated: unknown | undefined }, StoreError> =>
  Effect.gen(function*() {
    if (v > collection.version) {
      return yield* new StoreError({ reason: "unavailable", message: `Row ${id} of ${collection.name} was written by a newer version of its module (${v} > ${collection.version})` })
    }
    let current = json
    for (let at = v; at < collection.version; at++) {
      const step = collection.migrate[at]!
      current = yield* Effect.try({
        try: () => step(current),
        catch: (cause) => new StoreError({ reason: "failed", message: `Collection ${collection.name}: migrating row ${id} from version ${at} failed`, cause })
      })
    }
    const value = yield* Schema.decodeUnknownEffect(jsonOf(collection))(current).pipe(
      Effect.mapError((e) => new StoreError({ reason: "failed", message: `Row ${id} of ${collection.name} does not match its schema: ${e.message}` }))
    )
    return { value, migrated: v < collection.version ? current : undefined }
  })

/** The text a row contributes to search: its `search` fields (strings and string lists), joined. */
export const searchTextOf = (collection: Collection<any>, json: unknown): string => {
  if (collection.search.length === 0 || json === null || typeof json !== "object") return ""
  const parts: Array<string> = []
  for (const field of collection.search) {
    const v = (json as Record<string, unknown>)[field]
    if (typeof v === "string") parts.push(v)
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") parts.push(x)
  }
  return parts.join("\n")
}

/** The words of a search (letters and digits, lower case, at most 8). */
export const searchWords = (text: string): ReadonlyArray<string> =>
  (text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8)

/** Whether `text` contains every word (the fallback without FTS5, and the in-memory store). */
export const matchesWords = (text: string, words: ReadonlyArray<string>): boolean => {
  const hay = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  return words.every((w) => hay.includes(w))
}

/** Check a list query against the collection's indexes. */
export const checkQuery = (collection: Collection<any>, query: ListQuery<any> | undefined): Effect.Effect<number, StoreError> => {
  for (const field of Object.keys(query?.where ?? {})) {
    if (!collection.indexes.includes(field)) {
      return Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection.name}: "${field}" is not a declared index (indexes: ${collection.indexes.join(", ") || "none"})` }))
    }
  }
  const order = query?.orderBy?.field
  if (order !== undefined && order !== "createdAt" && order !== "updatedAt" && !collection.indexes.includes(order)) {
    return Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection.name}: cannot order on "${order}", which is not a declared index` }))
  }
  const limit = query?.limit ?? DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection.name}: limit must be 1 to ${MAX_LIST_LIMIT}` }))
  }
  return Effect.succeed(limit)
}

/** The error of a write in read-only mode. */
export const readOnlyError = (what: string) =>
  new StoreError({ reason: "read-only", message: `The household data is read-only here (${what}); changes are made by the server (pnpm start serve).` })

/** A store that refuses everything (no store in this mode): reads and writes fail `unavailable`. */
export const makeClosedStore = (reason: string): HouseholdStore => {
  const fail = Effect.fail(new StoreError({ reason: "unavailable", message: reason }))
  const sql: ModuleSql = { prefix: "", table: (n) => n, fts5: false, query: () => fail, run: () => fail }
  const handle: CollectionHandle<any> = {
    get: () => fail,
    list: () => fail,
    search: () => fail,
    insert: () => fail,
    update: () => fail,
    remove: () => fail,
    erase: () => fail,
    undo: () => fail
  }
  return {
    info: { kind: "closed", readOnly: true, fts5: false },
    prepare: () => Effect.void,
    availability: () => undefined,
    forModule: (moduleId) => ({
      moduleId,
      readOnly: true,
      fts5: false,
      collection: () => handle,
      sql: { ...sql, prefix: sqlPrefixOf(moduleId), table: (n) => `${sqlPrefixOf(moduleId)}${n}` },
      transaction: (work) => work,
      logChange: () => fail
    }),
    transaction: (work) => work,
    core: (owner) => ({ prefix: `core_${owner}__`, query: () => fail, run: () => fail, migrate: () => fail }),
    changesSince: () => Effect.succeed({ changes: [], complete: true, oldest: 0 }),
    lastSeq: Effect.succeed(0),
    endConversation: () => Effect.succeed(0),
    pruneChanges: () => Effect.succeed(0),
    backup: () => fail,
    exportModule: () => fail,
    onCommit: () => () => {}
  }
}
