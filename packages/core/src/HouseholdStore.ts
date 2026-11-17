import type { HouseholdScope, ModuleUnavailable } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { CurrentTurn, type TurnContext, type TurnSource } from "./TurnContext.ts"

/**
 * The household store (docs/MODULES-PLAN.md §4 P4; docs/STORING-DATA.md): the one place modules keep data that
 * outlives a turn, a conversation and an instance. This file is the contract; `@pva/store-sqlite` implements it on
 * `data/household.db`, and `@pva/core/testing` has an in-memory double (`makeMemoryHouseholdStore`). Both run the same
 * engine (`StoreEngine.ts`) over a small synchronous backend and pass the same contract tests
 * (`@pva/core/store-contract`).
 *
 * - **Document collections** (`defineCollection`), and nothing else for modules: rows whose value is a JSON object
 *   validated by a Schema, each with an id, a `rev`, a scope and who changed it last. `get`, `list` (one equality
 *   filter on one declared index, an order an index answers, a limit), `insert`, `update` (with a revision check) and
 *   `remove`, which really removes.
 * - **Transactions are synchronous and flat** (`ModuleStore.transaction(tx => …)`): the function runs with no awaits
 *   against a handle with the same operations as plain synchronous calls; begin, the function and commit (or
 *   rollback, if it throws) are one uninterrupted synchronous step. Nothing else can run in between, so there is
 *   nothing to interleave, nest, lock or interrupt. A `transaction` started while one runs joins it. Core services
 *   take part through the same handle (`tx.core(owner)`). Events of a transaction are released after its commit,
 *   in the order it made them; a transaction that throws releases nothing.
 *
 * Every call is synchronous on the main thread in the SQLite store, which also frames audio: every read a turn can make
 * is bounded by construction (one index range with a row limit), and nothing waits on the network inside a
 * transaction (it cannot: the function has no awaits).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Scopes and actors

/** Where a row belongs (`household` has no id). The same shape as the protocol's `HouseholdScope`. */
export type ScopeRef = HouseholdScope
export type ScopeKind = ScopeRef["kind"]

export const HOUSEHOLD_SCOPE: ScopeRef = { kind: "household" }

/**
 * Scope ids, row ids: 1–200 characters of letters, digits and `_ . : -` (device ids, assistant ids, conversation
 * UUIDs, person ids all fit). Nothing else is accepted, so an id is stored and compared the same way in SQLite's TEXT
 * columns and in the in-memory double (no NUL, no malformed Unicode, no case folding).
 */
export const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/

/** `household`, or `<kind>:<id>`: a key for maps and logs. */
export const scopeKey = (scope: ScopeRef): string => (scope.kind === "household" ? "household" : `${scope.kind}:${scope.id}`)

/** The scope id stored in a column ("" for household). */
export const scopeIdOf = (scope: ScopeRef): string => (scope.kind === "household" ? "" : scope.id)

/** A scope from its two columns (a fresh object). */
export const scopeFromColumns = (kind: string, id: string): ScopeRef =>
  kind === "household" ? { kind: "household" } : { kind: kind as Exclude<ScopeKind, "household">, id }

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

/** The actor of a call: the one given, else the turn's (`CurrentTurn`), else the module itself. */
export const currentActor = (moduleId: string, given?: Actor): Effect.Effect<Actor> =>
  given !== undefined ? Effect.succeed(given) : Effect.map(Effect.service(CurrentTurn), (turn) => (turn === undefined ? { kind: "module", moduleId } : actorOfTurn(turn)))

// ---------------------------------------------------------------------------------------------------------------------
// Errors

/**
 * The store could not do it. `unavailable`: no store in this mode, or the module's data is not usable here;
 * `read-only`: the CLI modes read the store and never write it; `invalid`: the call itself is wrong (an undeclared
 * collection, an unindexed filter, a value that does not match the schema or is not an object, an id outside the safe
 * alphabet); `failed`: the database said no.
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  reason: Schema.Literals(["unavailable", "read-only", "invalid", "failed"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** The row moved on: `expectRev` was not its rev, or the id is taken. */
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

/** What a store operation can fail with. Inside a transaction they are thrown; the transaction's effect fails with them. */
export type StoreFailure = StoreError | StoreConflict | StoreNotFound | ScopeUnknown

/** Whether `e` is one of the store's own failures (thrown inside a transaction). */
export const isStoreFailure = (e: unknown): e is StoreFailure =>
  e instanceof StoreError || e instanceof StoreConflict || e instanceof StoreNotFound || e instanceof ScopeUnknown

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
 * The device a page runs on, as a projection sees it: the **server's record** of that device (its saved name), never
 * what a page said in its `hello`. Small on purpose and growing: P5 adds the device's room and default person. `id` is
 * absent for a voice page that sent no device. Device ids are claimed by the page, not authenticated
 * (docs/MODULES-PLAN.md §2 rows 5 and 7): a page that names a device's id gets that device's rows.
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

/** A filter value: equality on a declared index. */
export type WhereValue = string | number | boolean

/** The longest string an indexed field may hold. */
export const MAX_INDEXED_CHARS = 500

/** Whether a string is well-formed Unicode (no unpaired surrogate) and holds no NUL. */
export const isPlainText = (s: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/.test(s)

/**
 * Whether `v` may be stored in an indexed field or used as a filter: a string of well-formed Unicode without NUL of at
 * most `MAX_INDEXED_CHARS`, a finite number, or a boolean. These are exactly the values for which SQLite's
 * `json_extract` comparison and ordering and the in-memory double's agree.
 */
export const isIndexable = (v: unknown): v is WhereValue =>
  typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= MAX_INDEXED_CHARS && isPlainText(v))

/**
 * The order of indexed values, the same in both stores (it is SQLite's order of `json_extract` results): a missing
 * field first, then numbers (`false` = 0, `true` = 1) by value, then strings by code point (UTF-8 byte order). Ties are
 * broken by `updatedAt`, then by id, in the same direction.
 */
export const compareIndexed = (a: unknown, b: unknown): number => {
  const rank = (x: unknown) => (x === null || x === undefined ? 0 : typeof x === "number" || typeof x === "boolean" ? 1 : 2)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 1) return Number(a) - Number(b)
  if (ra === 2) return compareCodePoints(a as string, b as string)
  return 0
}

/** Two well-formed strings by code point (= UTF-8 byte order, SQLite's BINARY collation), not by UTF-16 unit. */
export const compareCodePoints = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    // A surrogate (a code point above U+FFFF) sorts after every unit of the Basic Multilingual Plane.
    const sx = x >= 0xd800 && x <= 0xdfff
    const sy = y >= 0xd800 && y <= 0xdfff
    if (sx !== sy) return sx ? 1 : -1
    return x - y
  }
  return a.length - b.length
}

/** Whether a stored indexed value equals a filter value, as SQLite compares them (booleans are 1 / 0). */
export const indexedEquals = (stored: unknown, filter: WhereValue): boolean => {
  const s = typeof stored === "boolean" ? (stored ? 1 : 0) : stored
  const f = typeof filter === "boolean" ? (filter ? 1 : 0) : filter
  return s === f
}

/** A collection as declared (`defineCollection`). */
export interface Collection<A> {
  readonly _tag: "Collection"
  /** `/^[a-z][a-z0-9_]{0,39}$/`, unique within the module. */
  readonly name: string
  readonly scope: ScopeKind
  /** The row's type; its JSON form (`Schema.toCodecJson`) must be an object. */
  readonly schema: Schema.Codec<A, unknown>
  /**
   * Raised by one for each change of shape. When the module starts with a higher version than its stored rows, every
   * row is migrated (`migrate`) in one transaction, after a backup, before the module runs; a failure leaves the
   * data as it was and the module `unavailable`. At most `MAX_MIGRATION_ROWS` rows (a larger collection is refused,
   * which keeps the migration's blocking time bounded: docs/STORING-DATA.md "Latency").
   */
  readonly version: number
  /** `migrate[n]` turns a version-`n` value (JSON form) into a version-`n+1` one. One entry per version below `version`. */
  readonly migrate: Readonly<Record<number, (value: any) => unknown>>
  /**
   * Top-level fields `list` may filter (`where`, one field per query) or order on. Each is one index. Their values must
   * be `isIndexable` (a string, a finite number, `true` / `false`) or missing; anything else is refused at write.
   */
  readonly indexes: ReadonlyArray<string>
  /** Lines for the per-turn household facts, from the newest `ambientRows` rows the turn's device and person see. */
  readonly ambient?: (rows: ReadonlyArray<Row<A>>, context: AmbientContext) => string | ReadonlyArray<string> | undefined
  /** How many rows (newest first) per scope the ambient lines are made from. Default 10, at most `MAX_AMBIENT_ROWS`. */
  readonly ambientRows: number
  /**
   * What a voice page on `device` may see of a row, or `undefined` for nothing (docs/STORING-DATA.md "Pages"). Without
   * it the collection is never sent to pages. Called with the committed row as it is when a frame is built for that
   * page, and with the server's record of the device. Return plain JSON of at most `MAX_VALUE_CHARS` characters; a
   * projection that throws or returns anything else hides that row and is reported as a Health issue.
   */
  readonly project?: (row: Row<A>, device: TargetDevice) => unknown
}

const NAME = /^[a-z][a-z0-9_]{0,39}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** The most rows an ambient read takes per collection and scope. */
export const MAX_AMBIENT_ROWS = 20

/** Declare a document collection. Checked at definition time. */
export const defineCollection = <A>(definition: {
  readonly name: string
  readonly scope: ScopeKind
  readonly schema: Schema.Codec<A, unknown>
  readonly version?: number
  readonly migrate?: Readonly<Record<number, (value: any) => unknown>>
  readonly indexes?: ReadonlyArray<string>
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
  for (const field of definition.indexes ?? []) {
    if (!FIELD.test(field)) throw new Error(`Collection ${definition.name}: field "${field}" must match ${FIELD}`)
  }
  if ((definition.indexes?.length ?? 0) > 8) throw new Error(`Collection ${definition.name}: at most 8 indexes`)
  if (new Set(definition.indexes ?? []).size !== (definition.indexes?.length ?? 0)) throw new Error(`Collection ${definition.name}: an index is declared twice`)
  const ambientRows = definition.ambientRows ?? 10
  if (!Number.isInteger(ambientRows) || ambientRows < 1 || ambientRows > MAX_AMBIENT_ROWS) {
    throw new Error(`Collection ${definition.name}: ambientRows must be 1 to ${MAX_AMBIENT_ROWS}`)
  }
  return {
    _tag: "Collection",
    name: definition.name,
    scope: definition.scope,
    schema: definition.schema,
    version,
    migrate: definition.migrate ?? {},
    indexes: definition.indexes ?? [],
    ...(definition.ambient !== undefined ? { ambient: definition.ambient } : {}),
    ambientRows,
    ...(definition.project !== undefined ? { project: definition.project } : {})
  }
}

/** What a module declares about its data (`defineModule({ storage })`, module API 2). */
export interface ModuleStorage {
  /** Every collection the module uses. A collection not listed here is refused at run time. */
  readonly collections?: ReadonlyArray<Collection<any>>
}

/** Check a module's storage declaration (called by `defineModule`). */
export const checkModuleStorage = (moduleId: string, storage: ModuleStorage): void => {
  const seen = new Set<string>()
  for (const c of storage.collections ?? []) {
    if (c._tag !== "Collection") throw new Error(`Module ${moduleId}: storage.collections holds something that is not a collection`)
    if (seen.has(c.name)) throw new Error(`Module ${moduleId}: collection "${c.name}" is declared twice`)
    seen.add(c.name)
  }
  if (seen.size > 64) throw new Error(`Module ${moduleId}: at most 64 collections`)
}

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

/**
 * A list read. Every shape is one index range read up to `limit` rows (no sort of the matching rows), by construction:
 *
 * - no `where`: ordered by `updatedAt` (the default, newest first), `createdAt`, or a declared index;
 * - `where` on **one** declared index: ordered by `updatedAt` (default newest first) or by that same field.
 *
 * Anything else (two filter fields, a filter with another order) is `invalid`; store a combined field and index it.
 * Ties are broken by `updatedAt`, then id, in the same direction (`compareIndexed`).
 */
export interface ListQuery<A> extends ScopeOptions {
  /** Equality on one declared index (`isIndexable` values). */
  readonly where?: Partial<Record<keyof A & string, WhereValue>>
  /** A declared index, or `createdAt` / `updatedAt` (default: `updatedAt`, newest first). */
  readonly orderBy?: { readonly field: (keyof A & string) | "createdAt" | "updatedAt"; readonly direction?: "asc" | "desc" }
  /** Default 100, at most 1000. */
  readonly limit?: number
}

/**
 * One collection inside a transaction: the same operations as `CollectionHandle`, as plain synchronous calls. A failure
 * is thrown (`StoreFailure`); left uncaught, it rolls the transaction back and becomes the transaction's failure.
 */
export interface TxCollection<A> {
  /** The row, or `undefined` when there is none in the scope. */
  readonly get: (id: string, options?: ScopeOptions) => Row<A> | undefined
  readonly list: (query?: ListQuery<A>) => ReadonlyArray<Row<A>>
  /** A new row (a random id unless `id` is given; an id in use is a `StoreConflict`). */
  readonly insert: (value: A, options?: WriteOptions & { readonly id?: string }) => Row<A>
  /** Read, apply `f` and write. With `expectRev`, a row at another rev is a `StoreConflict`. */
  readonly update: (id: string, f: (value: A) => A, options?: WriteOptions & { readonly expectRev?: number }) => Row<A>
  /** Delete the row; `false` when there was none in the scope. */
  readonly remove: (id: string, options?: WriteOptions & { readonly expectRev?: number }) => boolean
}

/**
 * One collection of a module, outside a transaction: each call is one transaction of its own (one synchronous step).
 * `rev` is a number from the store's one counter: it changes on every write and is never used twice in a household,
 * also not by a row that was removed and inserted again with the same id, so an `expectRev` from before a removal never
 * matches the new row.
 */
export interface CollectionHandle<A> {
  readonly get: (id: string, options?: ScopeOptions) => Effect.Effect<Row<A> | undefined, StoreError | ScopeUnknown>
  readonly list: (query?: ListQuery<A>) => Effect.Effect<ReadonlyArray<Row<A>>, StoreError | ScopeUnknown>
  readonly insert: (value: A, options?: WriteOptions & { readonly id?: string }) => Effect.Effect<Row<A>, StoreError | StoreConflict | ScopeUnknown>
  /** Read, apply `f` and write, as one step (no other write can come between them). `f` is a plain synchronous function. */
  readonly update: (
    id: string,
    f: (value: A) => A,
    options?: WriteOptions & { readonly expectRev?: number }
  ) => Effect.Effect<Row<A>, StoreError | StoreConflict | StoreNotFound | ScopeUnknown>
  /**
   * Delete the row. `false` when there was no such row in the scope. Its content is overwritten in `household.db` and
   * its write-ahead log soon after (docs/STORING-DATA.md "Removing"); only backups keep it, until they rotate out.
   */
  readonly remove: (id: string, options?: WriteOptions & { readonly expectRev?: number }) => Effect.Effect<boolean, StoreError | StoreConflict | ScopeUnknown>
}

/** A value bound to a `?` of core SQL. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** A core service's statements inside a transaction (plain parameterised SQL on its own tables; trusted code). */
export interface CoreTx {
  readonly prefix: string
  readonly query: <R = Record<string, unknown>>(sql: string, params?: ReadonlyArray<SqlValue>) => ReadonlyArray<R>
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => { readonly changes: number; readonly lastInsertRowid: number }
}

/**
 * The handle of a running transaction. Everything on it is synchronous and part of the one transaction: collection
 * writes, core services' statements (`core`), module events (`publish`) and callbacks (`afterCommit`), which are all
 * released after the commit in the order they were made, and `onRollback` hooks, which run (newest first) when the
 * transaction rolls back instead. Use it only inside the function it was given to.
 */
export interface StoreTx {
  /** A declared collection of this module. */
  readonly collection: <A>(collection: Collection<A>) => TxCollection<A>
  /**
   * Publish `<moduleId>.<type>` after the commit, in order with the transaction's data changes (dropped on rollback).
   * The scope defaults to the household. As `ModuleEvents.publish`, but part of the transaction.
   */
  readonly publish: (type: string, data: unknown, scope?: ScopeRef) => void
  /** A core service's tables in this transaction (SQLite store only; the in-memory store throws `unavailable`). */
  readonly core: (owner: string) => CoreTx
  /** Run `f` after the commit, in order with the transaction's events (never on rollback). */
  readonly afterCommit: (f: () => void) => void
  /** Run `f` if the transaction rolls back (state kept outside the store, such as a core service's memory). */
  readonly onRollback: (f: () => void) => void
}

/** `ctx.store`: a module's data, shared by all its instances and its `shared` part. */
export interface ModuleStore {
  readonly moduleId: string
  /** The CLI modes read the store and refuse every write. */
  readonly readOnly: boolean
  /** A declared collection (an undeclared one fails each call with `invalid`). */
  readonly collection: <A>(collection: Collection<A>) => CollectionHandle<A>
  /**
   * Run `f` as one transaction: begin, `f` and commit (or rollback when `f` throws) are one synchronous step, so nothing
   * else runs in between. `f` must not await (it cannot: it is a plain function). A store failure thrown in `f` and not
   * caught is the effect's failure; anything else `f` throws rolls back and is a defect. Called while a transaction
   * runs (from inside `f`), it joins that transaction. Its events are published after the commit, in order.
   */
  readonly transaction: <X>(f: (tx: StoreTx) => X) => Effect.Effect<X, StoreFailure>
}

// ---------------------------------------------------------------------------------------------------------------------
// The host's view

export type ChangeOp = "insert" | "update" | "remove"

/** A committed change, as the bus receives it (values decoded; `before` is the row it replaced or removed). */
export interface CommittedChange {
  /** The number of the store's counter this write took (for an insert or update: the row's new `rev`). */
  readonly seq: number
  readonly at: number
  readonly module: string
  readonly collection: string
  readonly id: string
  readonly op: ChangeOp
  readonly rev: number
  readonly scope: ScopeRef
  readonly actor: Actor
  readonly row?: Row<unknown>
  readonly before?: Row<unknown>
}

/** A module event as the store releases it (`<module>.<type>`). */
export interface ModuleEventRecord {
  readonly at: number
  readonly module: string
  /** The full name: `<module>.<type>`. */
  readonly type: string
  readonly scope: ScopeRef
  readonly actor: Actor
  readonly data: unknown
}

/** What a commit releases, in the order the transaction made it. */
export type Released =
  | { readonly _tag: "change"; readonly change: CommittedChange }
  | { readonly _tag: "event"; readonly event: ModuleEventRecord }

/** A core service's own SQL (scheduler, notifications): tables `core_<owner>__*`. SQLite only. Trusted code: no guard. */
export interface CoreSql {
  readonly prefix: string
  /** One statement, outside any transaction (inside one, use `tx.core(owner)`). */
  readonly query: <R = Record<string, unknown>>(sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<R>, StoreError>
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<{ readonly changes: number; readonly lastInsertRowid: number }, StoreError>
  /**
   * Bring the owner's tables to `migrations.length`: each migration (one or more `;`-separated statements) runs in one
   * transaction with its new version, after a backup of the file. A newer stored version is refused (`unavailable`).
   */
  readonly migrate: (migrations: ReadonlyArray<string>) => Effect.Effect<void, StoreError>
}

export interface StoreInfo {
  readonly kind: "sqlite" | "memory" | "closed"
  readonly readOnly: boolean
  /** The database file (SQLite). */
  readonly path?: string
}

/** A module as `prepare` sees it. */
export interface StoredModule {
  readonly id: string
  readonly storage: ModuleStorage | undefined
}

/** A host-side transaction: core services and any module's collections (`forModule`). */
export interface HostTx {
  readonly forModule: (moduleId: string) => StoreTx
  readonly core: (owner: string) => CoreTx
  readonly afterCommit: (f: () => void) => void
  readonly onRollback: (f: () => void) => void
}

/** Synchronous reads for the host (voice pages, ambient facts): committed state now, bounded by construction. */
export interface CollectionReader<A> {
  readonly get: (id: string, scope: ScopeRef) => Row<A> | undefined
  /** One index range read, as `list` (the scope is required). */
  readonly list: (query: ListQuery<A> & { readonly scope: ScopeRef }) => ReadonlyArray<Row<A>>
  /** The rows of one scope newest first (`updatedAt`, then id, descending), after `after`, at most `limit` (≤ 100). */
  readonly page: (scope: ScopeRef, after: { readonly updatedAt: number; readonly id: string } | undefined, limit: number) => ReadonlyArray<Row<A>>
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
  /** One transaction for the host (core services, several modules). Joins a running one, as `ModuleStore.transaction`. */
  readonly transaction: <X>(f: (tx: HostTx) => X) => Effect.Effect<X, StoreFailure>
  /** Inside a running transaction: run `f` after its commit, in order (dropped on rollback). Outside one: run it now. */
  readonly afterCommit: (f: () => void) => Effect.Effect<void>
  /**
   * Release a module event (`ModuleEvents.publish`): inside a running transaction, after its commit and in order with
   * its changes; outside one, now. Either way through the commit listeners (`onCommit`), so they see changes and module
   * events in one order.
   */
  readonly publish: (event: ModuleEventRecord) => void
  /** A core service's own tables (P6 scheduler, P9 notifications). */
  readonly core: (owner: string) => CoreSql
  /** Host-side synchronous reads of a declared collection (`undefined` when the module's data is not usable here). */
  readonly reader: <A>(moduleId: string, collection: Collection<A>) => CollectionReader<A> | undefined
  /** The last number the store's counter gave out (0 when none). */
  readonly lastSeq: Effect.Effect<number, StoreError>
  /** A conversation ended: remove every row of its scope (one `remove` change each, by `system:conversation-ended`), in one transaction. */
  readonly endConversation: (conversationId: string) => Effect.Effect<number, StoreError>
  /** At start, before any conversation: the same for every conversation-scoped row (conversations do not outlive a process). */
  readonly sweepConversations: Effect.Effect<number, StoreError>
  /** An online backup to `<dir>/household-<date>.db` (docs/STORING-DATA.md "Backups"). */
  readonly backup: (options?: { readonly now?: number }) => Effect.Effect<{ readonly path: string }, StoreError>
  /**
   * Called after each commit with what it released (data changes and module events), in order; and for a module event
   * published outside a transaction, at once. Synchronous: a listener must be quick and must not throw (a throw is
   * caught). Returns an unsubscribe function.
   */
  readonly onCommit: (listener: (released: ReadonlyArray<Released>) => void) => () => void
}

// ---------------------------------------------------------------------------------------------------------------------
// Limits and helpers both stores use

export const DEFAULT_LIST_LIMIT = 100
export const MAX_LIST_LIMIT = 1000
/** The largest value a row may hold, as JSON. */
export const MAX_VALUE_CHARS = 64_000
/** The most rows a collection may hold for a migration of its version (one synchronous transaction at start). */
export const MAX_MIGRATION_ROWS = 20_000

/** The error of a write in read-only mode. */
export const readOnlyError = (what: string) =>
  new StoreError({ reason: "read-only", message: `The household data is read-only here (${what}); changes are made by the server (pnpm start serve).` })

/** A store that refuses everything (no store in this mode): reads and writes fail `unavailable`. */
export const makeClosedStore = (reason: string): HouseholdStore => {
  const error = new StoreError({ reason: "unavailable", message: reason })
  const fail = Effect.fail(error)
  const handle: CollectionHandle<any> = {
    get: () => fail,
    list: () => fail,
    insert: () => fail,
    update: () => fail,
    remove: () => fail
  }
  const listeners = new Set<(released: ReadonlyArray<Released>) => void>()
  return {
    info: { kind: "closed", readOnly: true },
    prepare: () => Effect.void,
    availability: () => undefined,
    forModule: (moduleId) => ({ moduleId, readOnly: true, collection: () => handle, transaction: () => fail }),
    transaction: () => fail,
    afterCommit: (f) => Effect.sync(f),
    publish: (event) => {
      for (const l of listeners) {
        try {
          l([{ _tag: "event", event }])
        } catch {
          // A listener must not break a publisher.
        }
      }
    },
    core: (owner) => ({ prefix: `core_${owner}__`, query: () => fail, run: () => fail, migrate: () => fail }),
    reader: () => undefined,
    lastSeq: Effect.succeed(0),
    endConversation: () => Effect.succeed(0),
    sweepConversations: Effect.succeed(0),
    backup: () => fail,
    onCommit: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
