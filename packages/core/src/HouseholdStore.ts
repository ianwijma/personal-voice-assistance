import type { HouseholdScope, ModuleUnavailable } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { CurrentTurn, type TurnContext, type TurnSource } from "./TurnContext.ts"

/**
 * The household store (docs/MODULES-PLAN.md §4 P4; docs/STORING-DATA.md): the one place modules and core services keep
 * data that outlives a turn, a conversation and an instance. This file is the contract; `@pva/store-sqlite` implements
 * it on `data/household.db`, and `@pva/core/testing` has an in-memory double (`makeMemoryHouseholdStore`). Both run the
 * same engine (`StoreEngine.ts`) over a small synchronous backend and pass the same contract tests
 * (`@pva/core/store-contract`).
 *
 * - **Document collections** (`defineCollection`), and nothing else: rows whose value is a JSON object validated by a
 *   Schema, each with an id, a `rev`, a scope and who changed it last. `get`, `list` (`ListQuery`: one index range,
 *   bounded), `insert`, `update` (with a revision check) and `remove`, which really removes. There is no SQL anywhere in
 *   this interface: core services (the scheduler, notifications) use the same collections under a reserved owner
 *   (`core.<name>`), through a handle only the host has (`HouseholdStore.forCore`).
 * - **Transactions are synchronous and flat** (`ModuleStore.transaction(tx => …)`): the function runs with no awaits
 *   against a handle with the same operations as plain synchronous calls; begin, the function and commit (or
 *   rollback, if it throws) are one uninterrupted synchronous step that only the engine begins and ends. A function that
 *   returns a promise, an Effect, a generator or a function fails the transaction (`StoreError` `invalid`), and a
 *   handle is valid only while its function runs. A `transaction` started while one runs joins it. Events of a
 *   transaction are released after its commit, in the order it made them; a transaction that rolls back releases
 *   nothing and runs its `onRollback` hooks.
 *
 * Every call is synchronous on the main thread in the SQLite store, which also frames audio: every read a turn can make
 * is bounded by construction (one index range of at most `maxListRows(c)` rows of at most `c.maxChars` each, a product
 * of at most `LIST_BUDGET_CHARS`), and nothing waits on the network or on a lock inside a transaction.
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
 * collection or another declaration of it, an unindexed filter, a limit above `maxListRows`, a value that does not
 * match the schema, a transaction function that returned a promise or an Effect, a handle used after its transaction);
 * `busy`: another connection held the database's write lock for longer than the store waits (a few milliseconds, never
 * on the event loop); nothing was done, try again; `failed`: the database said no.
 */
export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  reason: Schema.Literals(["unavailable", "read-only", "invalid", "busy", "failed"]),
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
// Values and indexes

/** A filter value: equality on a declared index. */
export type WhereValue = string | number | boolean

/** The longest string an indexed field may hold. */
export const MAX_INDEXED_CHARS = 500

/** Whether a string is well-formed Unicode (no unpaired surrogate) and holds no NUL. */
export const isPlainText = (s: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/.test(s)

/**
 * Whether `v` may be stored in an indexed field or used as a filter: a string of well-formed Unicode without NUL of at
 * most `MAX_INDEXED_CHARS`, a finite number, or a boolean. These are exactly the values that survive SQLite unchanged:
 * an indexed field's value is kept in a column of its own, bound from JavaScript (strings as UTF-8 TEXT, numbers as
 * 8-byte REAL, `true` / `false` as 1 / 0), never re-parsed from the row's JSON text by SQLite (whose number parser is
 * not exact: `58.00995086` would come back as `58.009950860000004`). `-0` is stored as `0`.
 */
export const isIndexable = (v: unknown): v is WhereValue =>
  typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= MAX_INDEXED_CHARS && isPlainText(v))

/** An indexed value as its column holds it: `null` (missing), a number (`true` = 1, `false` = 0, `-0` = 0) or a string. */
export type IndexKey = string | number | null

/** The column value of an indexable value (or `null` for a missing field). */
export const indexKeyOf = (v: WhereValue | undefined): IndexKey =>
  v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? (v === 0 ? 0 : v) : v

/**
 * The order of index keys, the same in both stores (it is SQLite's order of its column values): missing first, then
 * numbers (`false` = 0, `true` = 1) by value, then strings by code point (UTF-8 byte order). Ties are broken by
 * `createdAt`, then by id, in the same direction.
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

/** Whether a stored indexed value equals a filter value, as SQLite compares their columns. */
export const indexedEquals = (stored: unknown, filter: WhereValue): boolean =>
  indexKeyOf(stored as WhereValue | undefined) === indexKeyOf(filter)

// ---------------------------------------------------------------------------------------------------------------------
// Collections

/** What an `ambient` function is given besides the rows. */
export interface AmbientContext {
  readonly now: number
  readonly turn: TurnContext | undefined
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

/** One index: a field (`"state"`), or a filter field and an order field (`["state", "dueAt"]`). */
export type IndexDeclaration = string | readonly [filter: string, order: string]

/** A collection as declared (`defineCollection`). */
export interface Collection<A> {
  readonly _tag: "Collection"
  /** `/^[a-z][a-z0-9_]{0,39}$/`, unique within the module. */
  readonly name: string
  /** Fixed for the collection's life: a migration may not change it (declare a new collection instead). */
  readonly scope: ScopeKind
  /** The row's type; its JSON form (`Schema.toCodecJson`) must be an object. */
  readonly schema: Schema.Codec<A, unknown>
  /**
   * The most characters of JSON a value may have (default `DEFAULT_MAX_CHARS`, at most `MAX_VALUE_CHARS`; refused at
   * write). It decides how many rows one `list` may ask for (`maxListRows`). Part of the shape: a change needs a new
   * `storage.version`, and a smaller one fails the upgrade when a stored value is longer.
   */
  readonly maxChars: number
  /**
   * `migrate[n]` turns a value of the module's data version `n` (`ModuleStorage.version`), in its JSON form, into one
   * of version `n + 1`. A version without an entry leaves this collection's values as they are.
   */
  readonly migrate: Readonly<Record<number, (value: any) => unknown>>
  /**
   * What `list` may filter or order on (`ListQuery`). A field (`"state"`) is one index: `where` on it, ordered by it.
   * A pair (`["state", "dueAt"]`) is an index for `where` on the first ordered by the second. At most 8 entries, of at
   * most 8 distinct top-level fields, none of them a row's own name (`RESERVED_FIELDS`). An indexed field's value must
   * be `isIndexable` or missing; anything else is refused at write.
   */
  readonly indexes: ReadonlyArray<IndexDeclaration>
  /** The distinct indexed fields, in order of first appearance (each kept in a column of its own). */
  readonly fields: ReadonlyArray<string>
  /** Lines for the per-turn household facts, from the newest `ambientRows` rows the turn's device and person see. */
  readonly ambient?: (rows: ReadonlyArray<Row<A>>, context: AmbientContext) => string | ReadonlyArray<string> | undefined
  /** How many rows (newest first) per scope the ambient lines are made from. Default 10, at most `MAX_AMBIENT_ROWS` and `maxListRows`. */
  readonly ambientRows: number
  /**
   * What a voice page on `device` may see of a row, or `undefined` for nothing (docs/STORING-DATA.md "Pages"). Without
   * it the collection is never sent to pages. Called with the committed row as it is when a frame is built for that
   * page, and with the server's record of the device. Return plain JSON of at most `MAX_VALUE_CHARS` characters; a
   * projection that throws or returns anything else hides that row and is reported as a Health issue. Row ids of a
   * projected collection may reach any page that could see its scope (in a removal), so do not put anything private
   * in them.
   */
  readonly project?: (row: Row<A>, device: TargetDevice) => unknown
}

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

const NAME = /^[a-z][a-z0-9_]{0,39}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const SCOPES: ReadonlyArray<ScopeKind> = ["household", "person", "assistant", "device", "conversation"]

/** The most rows an ambient read takes per collection and scope. */
export const MAX_AMBIENT_ROWS = 20
/** The most indexes of a collection, and the most distinct fields they use. */
export const MAX_INDEXES = 8
/**
 * Names an index declaration may not use: a row's own fields (`Row`), which `list` orders by (`createdAt`,
 * `updatedAt`) or which are not part of the value.
 */
export const RESERVED_FIELDS: ReadonlySet<string> = new Set(["updatedAt", "createdAt", "id", "rev", "scope"])

/**
 * Declare a document collection. Checked at definition time.
 *
 * Whether two declarations have the same shape (docs/STORING-DATA.md "Versions") is judged from the structure of the
 * schema and the built-in checks Effect can represent, its scope, its indexes and `maxChars`. A custom check's function
 * (`Schema.makeFilter`) is not part of the shape: changing one needs a new `storage.version` from the author, and a
 * stored row the new check refuses fails `failed` when it is read.
 */
export const defineCollection = <A>(definition: {
  readonly name: string
  readonly scope: ScopeKind
  readonly schema: Schema.Codec<A, unknown>
  /** The most characters of JSON a value may have (default `DEFAULT_MAX_CHARS`, at most `MAX_VALUE_CHARS`). */
  readonly maxChars?: number
  readonly migrate?: Readonly<Record<number, (value: any) => unknown>>
  readonly indexes?: ReadonlyArray<IndexDeclaration>
  readonly ambient?: Collection<A>["ambient"]
  readonly ambientRows?: number
  readonly project?: Collection<A>["project"]
}): Collection<A> => {
  if (!NAME.test(definition.name)) throw new Error(`Collection name "${definition.name}" must match ${NAME}`)
  if (!SCOPES.includes(definition.scope)) throw new Error(`Collection ${definition.name}: scope must be one of ${SCOPES.join(", ")}`)
  const indexes = definition.indexes ?? []
  if (indexes.length > MAX_INDEXES) throw new Error(`Collection ${definition.name}: at most ${MAX_INDEXES} indexes`)
  const fields: Array<string> = []
  const seen = new Set<string>()
  for (const index of indexes) {
    const parts = typeof index === "string" ? [index] : index
    if (!Array.isArray(parts) && typeof index !== "string") throw new Error(`Collection ${definition.name}: an index is a field or a pair of fields`)
    if (parts.length !== 1 && parts.length !== 2) throw new Error(`Collection ${definition.name}: an index is a field or a pair of fields`)
    if (parts.length === 2 && parts[0] === parts[1]) throw new Error(`Collection ${definition.name}: the index [${parts.join(", ")}] names one field twice`)
    for (const field of parts) {
      if (typeof field !== "string" || !FIELD.test(field)) throw new Error(`Collection ${definition.name}: field "${String(field)}" must match ${FIELD}`)
      if (RESERVED_FIELDS.has(field)) throw new Error(`Collection ${definition.name}: "${field}" is a row's own field (${[...RESERVED_FIELDS].join(", ")}) and cannot be indexed; name the value's field otherwise`)
      if (!fields.includes(field)) fields.push(field)
    }
    const key = parts.join("\u0000")
    if (seen.has(key)) throw new Error(`Collection ${definition.name}: an index is declared twice`)
    seen.add(key)
  }
  if (fields.length > MAX_INDEXES) throw new Error(`Collection ${definition.name}: its indexes use at most ${MAX_INDEXES} distinct fields`)
  for (const [k, f] of Object.entries(definition.migrate ?? {})) {
    if (!/^[1-9][0-9]*$/.test(k) || typeof f !== "function") throw new Error(`Collection ${definition.name}: migrate is keyed by the data version a function migrates from (1, 2, …)`)
  }
  const maxChars = definition.maxChars ?? DEFAULT_MAX_CHARS
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_VALUE_CHARS) {
    throw new Error(`Collection ${definition.name}: maxChars must be a whole number from 1 to ${MAX_VALUE_CHARS}`)
  }
  const ambientMost = Math.min(MAX_AMBIENT_ROWS, listRowsFor(maxChars))
  const ambientRows = definition.ambientRows ?? Math.min(10, ambientMost)
  if (!Number.isInteger(ambientRows) || ambientRows < 1 || ambientRows > ambientMost) {
    throw new Error(`Collection ${definition.name}: ambientRows must be 1 to ${ambientMost}`)
  }
  return {
    _tag: "Collection",
    name: definition.name,
    scope: definition.scope,
    schema: definition.schema,
    maxChars,
    migrate: definition.migrate ?? {},
    indexes: indexes.map((i) => (typeof i === "string" ? i : [i[0], i[1]] as const)),
    fields,
    ...(definition.ambient !== undefined ? { ambient: definition.ambient } : {}),
    ambientRows,
    ...(definition.project !== undefined ? { project: definition.project } : {})
  }
}

/** What a module (or a core service) declares about its data (`defineModule({ storage })`, module API 2). */
export interface ModuleStorage {
  /**
   * The data version of all the module's collections (default 1). Raise it with every change of shape of any
   * collection (its schema, its indexes, its `maxChars`): at start every row of every collection is migrated
   * (`Collection.migrate`) in one transaction, after a backup, before the module runs. Changing a shape without raising
   * it is refused, as far as the shape is seen (`defineCollection`: a custom check's function is not).
   */
  readonly version?: number
  /** Every collection the module uses. A collection not listed here is refused at run time. */
  readonly collections?: ReadonlyArray<Collection<any>>
}

/** The highest data version. */
export const MAX_DATA_VERSION = 10_000

/** Check a module's storage declaration (called by `defineModule`; `prepare` checks it again). */
export const checkModuleStorage = (moduleId: string, storage: ModuleStorage): void => {
  const version = storage.version ?? 1
  if (!Number.isInteger(version) || version < 1 || version > MAX_DATA_VERSION) throw new Error(`Module ${moduleId}: storage.version must be a whole number from 1 to ${MAX_DATA_VERSION}`)
  const seen = new Set<string>()
  for (const c of storage.collections ?? []) {
    if (c === null || typeof c !== "object" || c._tag !== "Collection") throw new Error(`Module ${moduleId}: storage.collections holds something that is not a collection`)
    if (seen.has(c.name)) throw new Error(`Module ${moduleId}: collection "${c.name}" is declared twice`)
    seen.add(c.name)
    for (const k of Object.keys(c.migrate)) {
      if (Number(k) >= version) throw new Error(`Module ${moduleId}: collection ${c.name} migrates from version ${k}, which is not below storage.version ${version}`)
    }
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
 * A list read. Every shape is one index range read of at most `limit` rows (no sort of the matching rows), by
 * construction; ties are broken by `createdAt`, then id, in the same direction. `after` continues it: the last row of
 * the previous page of the same query (same `where`, `orderBy` and scope), and the list goes on after that row's place
 * in the order:
 *
 * - no `where`: ordered by `updatedAt` (the default, newest first), `createdAt` (default newest first), or a field
 *   declared as an index on its own (default ascending);
 * - `where` on **one** field declared as an index on its own: ordered by `updatedAt` (default, newest first),
 *   `createdAt` or that same field (both: by `createdAt`);
 * - `where` on field `f` ordered by another field `g`: only with the pair `[f, g]` declared (`indexes: [["state",
 *   "dueAt"]]`), default ascending.
 *
 * Anything else (two filter fields, an order no index has) is `invalid`, as is a `limit` above `maxListRows(c)` and an
 * `after` that is not a row a list of the same query of this collection returned.
 */
export interface ListQuery<A> extends ScopeOptions {
  /** Equality on one indexed field (`isIndexable` values). */
  readonly where?: Partial<Record<keyof A & string, WhereValue>>
  /** An indexed field, or `createdAt` / `updatedAt` (default: `updatedAt`, newest first). */
  readonly orderBy?: { readonly field: (keyof A & string) | "createdAt" | "updatedAt"; readonly direction?: "asc" | "desc" }
  /** Default `DEFAULT_LIST_LIMIT` (or `maxListRows(c)` when that is smaller), at most `maxListRows(c)`. */
  readonly limit?: number
  /** The last row of the previous page of this query: the list continues after it. */
  readonly after?: Row<A>
}

/**
 * One collection inside a transaction: the same operations as `CollectionHandle`, as plain synchronous calls. A failure
 * is thrown (`StoreFailure`); left uncaught, it rolls the transaction back and becomes the transaction's failure. Valid
 * only while the transaction's function runs.
 */
export interface TxCollection<A> {
  /** The row, or `undefined` when there is none in the scope. */
  readonly get: (id: string, options?: ScopeOptions) => Row<A> | undefined
  readonly list: (query?: ListQuery<A>) => ReadonlyArray<Row<A>>
  /** A new row (a random id unless `id` is given; an id in use is a `StoreConflict`). */
  readonly insert: (value: A, options?: WriteOptions & { readonly id?: string }) => Row<A>
  /** Read, apply `f` (synchronous) and write. With `expectRev`, a row at another rev is a `StoreConflict`. */
  readonly update: (id: string, f: (value: A) => A, options?: WriteOptions & { readonly expectRev?: number }) => Row<A>
  /** Delete the row; `false` when there was none in the scope. */
  readonly remove: (id: string, options?: WriteOptions & { readonly expectRev?: number }) => boolean
}

/**
 * One collection, outside a transaction: each call is one transaction of its own (one synchronous step).
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

/**
 * The handle of a running transaction. Everything on it is synchronous and part of the one transaction: collection
 * writes, module events (`publish`) and callbacks (`afterCommit`), which are all released after the commit in the
 * order they were made, and `onRollback` hooks, which run (newest first) when the transaction rolls back instead.
 * Valid only while the function it was given to runs: any use afterwards (also from a later transaction) is refused.
 */
export interface StoreTx {
  /** A declared collection of this owner (and of no other: the handle is built for one owner). */
  readonly collection: <A>(collection: Collection<A>) => TxCollection<A>
  /**
   * Publish `<owner>.<type>` after the commit, in order with the transaction's data changes (dropped on rollback).
   * The scope defaults to the household. As `ModuleEvents.publish`, but part of the transaction.
   */
  readonly publish: (type: string, data: unknown, scope?: ScopeRef) => void
  /** Run `f` after the commit, in order with the transaction's events (never on rollback). */
  readonly afterCommit: (f: () => void) => void
  /** Run `f` if the transaction rolls back (state kept outside the store). */
  readonly onRollback: (f: () => void) => void
}

/**
 * What a transaction function may return: a plain value. A promise or other thenable, an Effect, a generator or a
 * function is refused at run time (the transaction rolls back and fails `invalid`: transactions cannot await); the
 * type refuses the first two.
 */
export type TxResult<X> = X extends PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown> ? never : X

/** `ctx.store`: one owner's data (a module's, shared by all its instances and its `shared` part; or a core service's). */
export interface ModuleStore {
  /** The owner: a module id, or `core.<name>`. */
  readonly moduleId: string
  /** The CLI modes read the store and refuse every write. */
  readonly readOnly: boolean
  /** A declared collection of this owner (an undeclared one, or another declaration of its name, fails each call with `invalid`). */
  readonly collection: <A>(collection: Collection<A>) => CollectionHandle<A>
  /**
   * Run `f` as one transaction: begin, `f` and commit (or rollback when `f` throws) are one synchronous step, so nothing
   * else runs in between. `f` must not await: a promise, an Effect or a generator returned from it rolls everything back
   * and fails `invalid`. A store failure thrown in `f` and not caught is the effect's failure; anything else `f` throws
   * rolls back and is a defect. Called while a transaction runs (from inside `f`), it joins that transaction. Its
   * events are published after the commit, in order.
   */
  readonly transaction: <X>(f: (tx: StoreTx) => TxResult<X>) => Effect.Effect<X, StoreFailure>
}

// ---------------------------------------------------------------------------------------------------------------------
// The host's view

/**
 * The owner of a core service's collections: `core.<name>` (`core.scheduler`, `core.notifications`). No module id can
 * take it (module ids have no dot), and only the host can reach it (`HouseholdStore.forCore`).
 */
export type CoreOwner = `core.${string}`
export const CORE_OWNER = /^core\.[a-z][a-z0-9-]{0,30}$/

/** A core service's data, declared as a module's is (`prepare`). */
export interface CoreStorage {
  readonly owner: CoreOwner
  readonly storage: ModuleStorage
}

export type ChangeOp = "insert" | "update" | "remove"

/** A committed change, as the bus receives it (values decoded; `before` is the row it replaced or removed). */
export interface CommittedChange {
  /** The number of the store's counter this write took (for an insert or update: the row's new `rev`). */
  readonly seq: number
  readonly at: number
  /** The owner: a module id, or `core.<name>`. */
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

/** Data the store keeps that no declaration reaches any more (never deleted by the store; `doctor` lists it). */
export interface UndeclaredData {
  readonly owner: string
  readonly collection: string
  readonly version: number
}

/** A host-side transaction: any module's or core service's collections. Never given to module code. */
export interface HostTx {
  readonly forModule: (moduleId: string) => StoreTx
  readonly forCore: (owner: CoreOwner) => StoreTx
  readonly afterCommit: (f: () => void) => void
  readonly onRollback: (f: () => void) => void
}

/** Synchronous reads for the host (voice pages, ambient facts): committed state now, bounded by construction. */
export interface CollectionReader<A> {
  readonly get: (id: string, scope: ScopeRef) => Row<A> | undefined
  /** One index range read, as `list` (the scope is required). */
  readonly list: (query: ListQuery<A> & { readonly scope: ScopeRef }) => ReadonlyArray<Row<A>>
  /**
   * The rows of one scope newest first (`updatedAt`, then `createdAt`, then id, descending), after `after`, at most
   * `limit`, and never more than `maxListRows(c)` (fewer rows than asked does not mean the end then).
   */
  readonly page: (scope: ScopeRef, after: PageCursor | undefined, limit: number) => ReadonlyArray<Row<A>>
}

/** Where `CollectionReader.page` continues. */
export interface PageCursor {
  readonly updatedAt: number
  readonly createdAt: number
  readonly id: string
}

export interface HouseholdStore {
  readonly info: StoreInfo
  /**
   * Judge and upgrade every owner's data, once, before the module host is made (docs/STORING-DATA.md "Versions"): an
   * owner whose stored version is newer than it declares is `unavailable` (its data is never read, migrated or
   * deleted); one that changed a collection's shape without raising its version, or a collection's scope, too; an older
   * one is migrated in one transaction after a backup, every row checked against its new declaration, and a failure
   * leaves the data as it was and the owner unavailable. Core services' collections (`core`) are prepared the same way.
   */
  readonly prepare: (modules: ReadonlyArray<StoredModule>, core?: ReadonlyArray<CoreStorage>) => Effect.Effect<void, StoreError>
  /** Why an owner's data cannot be used here (from `prepare`), or `undefined`. */
  readonly availability: (owner: string) => ModuleUnavailable | undefined
  /** Stored collections no declaration reaches (from `prepare`). */
  readonly undeclared: () => ReadonlyArray<UndeclaredData>
  /** `ctx.store` of a module (prepared or not: an unprepared module has no collections). */
  readonly forModule: (moduleId: string) => ModuleStore
  /** The collections of a core service (`core.<name>`): the host's only, never given to a module. */
  readonly forCore: (owner: CoreOwner) => ModuleStore
  /** One transaction for the host (several owners). Joins a running one, as `ModuleStore.transaction`. */
  readonly transaction: <X>(f: (tx: HostTx) => TxResult<X>) => Effect.Effect<X, StoreFailure>
  /** Inside a running transaction: run `f` after its commit, in order (dropped on rollback). Outside one: run it now. */
  readonly afterCommit: (f: () => void) => Effect.Effect<void>
  /**
   * Release a module event (`ModuleEvents.publish`): inside a running transaction, after its commit and in order with
   * its changes; outside one, now. Either way through the commit listeners (`onCommit`), so they see changes and module
   * events in one order.
   */
  readonly publish: (event: ModuleEventRecord) => void
  /** Host-side synchronous reads of a declared collection (`undefined` when the owner's data is not usable here). */
  readonly reader: <A>(owner: string, collection: Collection<A>) => CollectionReader<A> | undefined
  /** The last number the store's counter gave out (0 when none). */
  readonly lastSeq: Effect.Effect<number, StoreError>
  /**
   * A conversation ended: its rows are hidden at once and removed in bounded steps (`BULK_STEP_ROWS` rows each, one
   * transaction each, yielding between them; one `remove` change each, by `system:conversation-ended`). Run it off the
   * turn's path. The number removed.
   */
  readonly endConversation: (conversationId: string) => Effect.Effect<number, StoreError>
  /** At start, before any conversation: the same for every conversation-scoped row (conversations do not outlive a process). */
  readonly sweepConversations: Effect.Effect<number, StoreError>
  /** An online backup to `<dir>/household-<date>.db` (serve mode only; docs/STORING-DATA.md "Backups"). */
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

export const DEFAULT_LIST_LIMIT = 20
/** The most rows one `list` returns, whatever its collection's `maxChars`. */
export const MAX_LIST_LIMIT = 100
/** The largest `maxChars` a collection may declare (and the largest projection sent to a page), as JSON. */
export const MAX_VALUE_CHARS = 16_000
/** A collection's `maxChars` when it declares none. */
export const DEFAULT_MAX_CHARS = 2_000
/**
 * The most characters of values one `list` may decode: a list asks for at most `maxListRows(c)` rows, so
 * rows × `maxChars` stays within it. Chosen by measuring structured values (arrays of small objects, arrays of
 * numbers) at the limits, so the worst legal list blocks the main thread under 10 ms with a margin of two
 * (docs/STORING-DATA.md "Latency").
 */
export const LIST_BUDGET_CHARS = 120_000
const listRowsFor = (maxChars: number) => Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(LIST_BUDGET_CHARS / maxChars)))
/** The most rows one `list` of `c` may ask for: `min(MAX_LIST_LIMIT, floor(LIST_BUDGET_CHARS / c.maxChars))`. */
export const maxListRows = (c: Pick<Collection<unknown>, "maxChars">): number => listRowsFor(c.maxChars)
/** The most rows of an owner a version upgrade rewrites (one synchronous transaction at start, before serving). */
export const MAX_MIGRATION_ROWS = 20_000
/**
 * The rows one step of a bulk removal (an ended conversation) removes, in one transaction of its own: measured at the
 * legal maximum (values of `MAX_VALUE_CHARS`, eight indexed fields at `MAX_INDEXED_CHARS`, secure deletion) so one
 * step holds the main thread under 10 ms with a margin of two (docs/STORING-DATA.md "Latency").
 */
export const BULK_STEP_ROWS = 10

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
  const owner = (moduleId: string): ModuleStore => ({ moduleId, readOnly: true, collection: () => handle, transaction: () => fail })
  return {
    info: { kind: "closed", readOnly: true },
    prepare: () => Effect.void,
    availability: () => undefined,
    undeclared: () => [],
    forModule: owner,
    forCore: owner,
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
