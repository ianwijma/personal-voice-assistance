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
 *   and who changed it last; one equality filter, ordering and a limit, each list read bound to one index by
 *   construction. A collection whose version rises is migrated whole, at start, in
 *   one transaction after a backup. Every write appends one change-log row in the same transaction.
 * - **Transactions** span a module's collections (`ModuleStore.transaction`); core services (scheduler,
 *   notifications) join the same transaction with their own tables (`HouseholdStore.core`). The model, shared by both
 *   stores, is in `StoreTransactions.ts`.
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
 * collection, an unindexed filter, a value that does not match the schema); `failed`: the database said no.
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  reason: Schema.Literals(["unavailable", "read-only", "invalid", "failed"]),
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

/**
 * The order of indexed values, the same in both stores (it is SQLite's order of `json_extract` results): a missing
 * field and `null` first, then numbers (`false` = 0, `true` = 1) by value, then strings by code point (UTF-8 byte
 * order). Ties are broken by `updatedAt`, then by id, in the same direction.
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

/** Two strings by code point (= UTF-8 byte order, SQLite's BINARY collation), not by UTF-16 unit. */
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
  if (filter === null) return stored === null || stored === undefined
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
  /** The row's type; rows are stored in its JSON form (`Schema.toCodecJson`). */
  readonly schema: Schema.Codec<A, unknown>
  /**
   * Raised by one for each change of shape. When the module starts with a higher version than its stored rows, every
   * row is migrated (`migrate`) in one transaction, after a backup, before the module runs; a failure leaves the
   * data as it was and the module `unavailable`.
   */
  readonly version: number
  /** `migrate[n]` turns a version-`n` value (JSON form) into a version-`n+1` one. One entry per version below `version`. */
  readonly migrate: Readonly<Record<number, (value: any) => unknown>>
  /**
   * Top-level fields `list` may filter (`where`, one field per query) or order on. Each is one index. Their values must
   * be strings, finite numbers, `true` / `false`, `null` or missing (a write with a list or an object there is
   * `invalid`), so both stores order and compare them the same way (`compareIndexed`).
   */
  readonly indexes: ReadonlyArray<string>
  /** `full`: the change log keeps each change's values (undo works). `none`: only that it happened (no undo). */
  readonly history: "full" | "none"
  /** Lines for the per-turn household facts (shared-state §7), from the rows the turn's device and person see. */
  readonly ambient?: (rows: ReadonlyArray<Row<A>>, context: AmbientContext) => string | ReadonlyArray<string> | undefined
  /** How many rows (newest first) per scope the ambient lines are made from. Default 20. */
  readonly ambientRows: number
  /**
   * What a voice page on `device` may see of a row, or `undefined` for nothing (docs/STORING-DATA.md "Pages"). Without
   * it the collection is never sent to pages. Called for the snapshot and for every change, always with the committed
   * row as it is now. Return plain JSON of at most 64,000 characters; a projection that throws or returns anything
   * else hides that row and is reported as a Health issue.
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
  for (const field of definition.indexes ?? []) {
    if (!FIELD.test(field)) throw new Error(`Collection ${definition.name}: field "${field}" must match ${FIELD}`)
  }
  if ((definition.indexes?.length ?? 0) > 8) throw new Error(`Collection ${definition.name}: at most 8 indexes`)
  if (new Set(definition.indexes ?? []).size !== (definition.indexes?.length ?? 0)) throw new Error(`Collection ${definition.name}: an index is declared twice`)
  const ambientRows = definition.ambientRows ?? 20
  if (!Number.isInteger(ambientRows) || ambientRows < 1 || ambientRows > 100) throw new Error(`Collection ${definition.name}: ambientRows must be 1 to 100`)
  return {
    _tag: "Collection",
    name: definition.name,
    scope: definition.scope,
    schema: definition.schema,
    version,
    migrate: definition.migrate ?? {},
    indexes: definition.indexes ?? [],
    history: definition.history ?? "full",
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
  /** Equality on one declared index. */
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

/**
 * One collection of a module. `rev` is the change-log number of the row's last write: it changes on every write and is
 * never used twice in a household, also not by a row that was removed and inserted again with the same id, so an
 * `expectRev` from before a removal never matches the new row.
 */
export interface CollectionHandle<A> {
  /** The row, or `undefined` when there is none in the scope. */
  readonly get: (id: string, options?: ScopeOptions) => Effect.Effect<Row<A> | undefined, StoreError | ScopeUnknown>
  readonly list: (query?: ListQuery<A>) => Effect.Effect<ReadonlyArray<Row<A>>, StoreError | ScopeUnknown>
  /** A new row (a random id unless `id` is given; an id in use is a `StoreConflict`). */
  readonly insert: (value: A, options?: WriteOptions & { readonly id?: string }) => Effect.Effect<Row<A>, StoreError | StoreConflict | ScopeUnknown>
  /**
   * Read, apply `f` and write, as one step (no other write can come between them). With `expectRev`, a row at another
   * rev is a `StoreConflict`. `f` must be a plain function of the value: it runs inside the store's transaction.
   */
  readonly update: (
    id: string,
    f: (value: A) => A,
    options?: WriteOptions & { readonly expectRev?: number }
  ) => Effect.Effect<Row<A>, StoreError | StoreConflict | StoreNotFound | ScopeUnknown>
  /** `false` when there was no such row. */
  readonly remove: (id: string, options?: WriteOptions & { readonly expectRev?: number }) => Effect.Effect<boolean, StoreError | StoreConflict | ScopeUnknown>
  /**
   * Forget the row: remove it and every payload of it in this scope (its values in the change log, which keeps only
   * that a change happened), committed when this returns. Afterwards the old content is
   * overwritten in `household.db` and the write-ahead log is emptied (a checkpoint, retried while a reader such as a
   * running backup still holds an older snapshot; docs/STORING-DATA.md "Forgetting" says what it cannot reach:
   * backups until they rotate out, 14 days). `false`: there is no such row in this scope (its history in this scope is
   * purged all the same; another scope's row of that id is never touched).
   */
  readonly erase: (id: string, options?: WriteOptions) => Effect.Effect<boolean, StoreError | ScopeUnknown>
  /**
   * Undo the last change the actor (default: the turn's) made in this collection **in this scope** (default: the
   * turn's, as every other call) that is not already undone and still has its values. A row changed by someone else
   * since is a `StoreConflict`. `undefined`: nothing to undo. Never for `history: "none"`.
   */
  readonly undo: (options?: ScopeOptions & { readonly actor?: Actor }) => Effect.Effect<UndoResult<A> | undefined, StoreError | StoreConflict | ScopeUnknown>
}

/** `ctx.store`: a module's data, shared by all its instances and its `shared` part. */
export interface ModuleStore {
  readonly moduleId: string
  /** The CLI modes read the store and refuse every write. */
  readonly readOnly: boolean
  /** A declared collection (an undeclared one fails each call with `invalid`). */
  readonly collection: <A>(collection: Collection<A>) => CollectionHandle<A>
  /**
   * Run `work` in one transaction (nested calls are savepoints): every collection write in it
   * commits or rolls back together, and its events (data changes and `ctx.events.publish`) are published only after
   * the commit, in change-log order. Concurrent work inside one transaction runs one savepoint at a time. A fiber
   * forked inside that outlives it fails with `StoreError`. No network calls inside: the transaction holds the
   * database's one connection.
   */
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
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
  readonly collection: string
  readonly id: string
  readonly op: ChangeOp
  readonly rev: number
  readonly scope: ScopeRef
  readonly actor: Actor
  readonly row?: Row<unknown>
  readonly before?: Row<unknown>
}

/** One change-log row as read back (`changesSince`). Payloads are absent for `history: "none"` and erased rows. */
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

/** A value bound to a `?` of core SQL. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** A core service's own SQL (scheduler, notifications): tables `core_<owner>__*`, joined to `transaction`. SQLite only. */
export interface CoreSql {
  readonly prefix: string
  readonly query: <R = Record<string, unknown>>(sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<ReadonlyArray<R>, StoreError>
  readonly run: (sql: string, params?: ReadonlyArray<SqlValue>) => Effect.Effect<{ readonly changes: number; readonly lastInsertRowid: number }, StoreError>
  /** Bring the owner's tables to `migrations.length` (each in the store's migration transaction, after a backup). */
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
  /** One transaction across modules and core services (`ModuleStore.transaction` is this; `StoreTransactions.ts`). */
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /**
   * Inside a transaction of this store: run `f` after the outermost commit, in order with its data changes (dropped if
   * the savepoint it was queued in rolls back). Outside one: run it now. How `ctx.events.publish` waits for a commit.
   */
  readonly afterCommit: (f: () => void) => Effect.Effect<void, StoreError>
  /** A core service's own tables (P6 scheduler, P9 notifications). */
  readonly core: (owner: string) => CoreSql
  /** The change log after `seq`, oldest first, at most `limit`; `complete`: nothing after these. */
  readonly changesSince: (seq: number, limit: number) => Effect.Effect<{ readonly changes: ReadonlyArray<ChangeRecord>; readonly complete: boolean; readonly oldest: number }, StoreError>
  /** The change log's last number (0 when empty). */
  readonly lastSeq: Effect.Effect<number, StoreError>
  /**
   * A conversation ended: erase every row of its scope (as `erase` does: rows and payloads in the change log; one `erase` change per row, by `system:conversation-ended`), in one transaction. Returns how many.
   */
  readonly endConversation: (conversationId: string) => Effect.Effect<number, StoreError>
  /** At start, before any conversation: the same for every conversation-scoped row (conversations do not outlive a process). */
  readonly sweepConversations: Effect.Effect<number, StoreError>
  /** Retention: delete change-log rows older than `maxAgeMs` (default 90 days), in small batches. */
  readonly pruneChanges: (options?: { readonly now?: number; readonly maxAgeMs?: number }) => Effect.Effect<number, StoreError>
  /** An online backup to `<dir>/household-<date>.db` (see docs/STORING-DATA.md "Backups" for what is kept how long). */
  readonly backup: (options?: { readonly now?: number }) => Effect.Effect<{ readonly path: string }, StoreError>
  /** Called after each commit with what it committed, in order (the event bus). Returns an unsubscribe function. */
  readonly onCommit: (listener: (changes: ReadonlyArray<CommittedChange>) => void) => () => void
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers both stores use

export const DEFAULT_LIST_LIMIT = 100
export const MAX_LIST_LIMIT = 1000
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
    let text: string | undefined
    try {
      text = JSON.stringify(json)
    } catch (cause) {
      return yield* new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the value is not JSON`, cause })
    }
    if (text === undefined) return yield* new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the value is not JSON` })
    if (text.length > MAX_VALUE_CHARS) {
      return yield* new StoreError({ reason: "invalid", message: `Collection ${collection.name}: a value may hold at most ${MAX_VALUE_CHARS} characters of JSON` })
    }
    const bad = badIndexedField(collection, json)
    if (bad !== undefined) {
      return yield* new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the indexed field "${bad}" must be a string, a number, true/false or null` })
    }
    const decoded = yield* Schema.decodeUnknownEffect(codec)(JSON.parse(text)).pipe(
      Effect.mapError((e) => new StoreError({ reason: "invalid", message: `Collection ${collection.name}: the value does not survive storing: ${e.message}` }))
    )
    return { json, text, value: decoded }
  })

/** The first indexed field of `json` that holds something other than a scalar, or `undefined`. */
const badIndexedField = (collection: Collection<any>, json: unknown): string | undefined => {
  if (collection.indexes.length === 0 || json === null || typeof json !== "object") return undefined
  for (const field of collection.indexes) {
    if (!Object.hasOwn(json, field)) continue
    const v = (json as Record<string, unknown>)[field]
    if (v !== null && typeof v !== "string" && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))) return field
  }
  return undefined
}

/**
 * A stored value (JSON form, written at version `v`) as the collection's type now: migrated forward one version at a
 * time, then decoded (`migrated`: the JSON form at the current version, when it was older). Used for rows when their
 * collection is migrated at start, and for change-log payloads of older versions (undo). A newer value is refused.
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

/** A list query as one index range read: its filter (at most one field) and its order. */
export interface CheckedQuery {
  readonly limit: number
  readonly where: readonly [field: string, value: WhereValue] | undefined
  /** A JSON field, or the `createdAt` / `updatedAt` column. */
  readonly order: { readonly field: string; readonly column: boolean; readonly desc: boolean }
}

const isWhereValue = (v: unknown): v is WhereValue =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))

/** Check a list query against the collection's indexes and the shapes one index can answer (`ListQuery`). */
export const checkQuery = (collection: Collection<any>, query: ListQuery<any> | undefined): Effect.Effect<CheckedQuery, StoreError> => {
  const invalid = (message: string) => Effect.fail(new StoreError({ reason: "invalid", message: `Collection ${collection.name}: ${message}` }))
  const entries = Object.entries(query?.where ?? {}).filter(([, v]) => v !== undefined)
  if (entries.length > 1) return invalid(`list filters on one indexed field at a time (it was given ${entries.map(([f]) => f).join(", ")}); store a combined field and index it`)
  for (const [field, value] of entries) {
    if (!collection.indexes.includes(field)) return invalid(`"${field}" is not a declared index (indexes: ${collection.indexes.join(", ") || "none"})`)
    if (!isWhereValue(value)) return invalid(`the filter on "${field}" must be a string, a finite number, true/false or null`)
  }
  const where = entries[0] as readonly [string, WhereValue] | undefined
  const field = query?.orderBy?.field ?? "updatedAt"
  const column = field === "createdAt" || field === "updatedAt"
  if (!column && !collection.indexes.includes(field)) return invalid(`cannot order on "${field}", which is not a declared index`)
  if (where !== undefined && field !== "updatedAt" && field !== where[0]) {
    return invalid(`a list filtered on "${where[0]}" is ordered by updatedAt or by "${where[0]}", not by "${field}"`)
  }
  const direction = query?.orderBy?.direction ?? (column ? "desc" : "asc")
  if (direction !== "asc" && direction !== "desc") return invalid(`direction must be "asc" or "desc"`)
  const limit = query?.limit ?? DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) return invalid(`limit must be 1 to ${MAX_LIST_LIMIT}`)
  return Effect.succeed({ limit, where, order: { field, column, desc: direction === "desc" } })
}

/** The error of a write in read-only mode. */
export const readOnlyError = (what: string) =>
  new StoreError({ reason: "read-only", message: `The household data is read-only here (${what}); changes are made by the server (pnpm start serve).` })

/** A store that refuses everything (no store in this mode): reads and writes fail `unavailable`. */
export const makeClosedStore = (reason: string): HouseholdStore => {
  const fail = Effect.fail(new StoreError({ reason: "unavailable", message: reason }))
  const handle: CollectionHandle<any> = {
    get: () => fail,
    list: () => fail,
    insert: () => fail,
    update: () => fail,
    remove: () => fail,
    erase: () => fail,
    undo: () => fail
  }
  return {
    info: { kind: "closed", readOnly: true },
    prepare: () => Effect.void,
    availability: () => undefined,
    forModule: (moduleId) => ({
      moduleId,
      readOnly: true,
      collection: () => handle,
      transaction: (work) => work
    }),
    transaction: (work) => work,
    afterCommit: (f) => Effect.sync(f),
    core: (owner) => ({ prefix: `core_${owner}__`, query: () => fail, run: () => fail, migrate: () => fail }),
    changesSince: () => Effect.succeed({ changes: [], complete: true, oldest: 0 }),
    lastSeq: Effect.succeed(0),
    endConversation: () => Effect.succeed(0),
    sweepConversations: Effect.succeed(0),
    pruneChanges: () => Effect.succeed(0),
    backup: () => fail,
    onCommit: () => () => {}
  }
}
