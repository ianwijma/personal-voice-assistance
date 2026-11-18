import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Effect, Exit, Schema, SchemaRepresentation } from "effect"
import {
  type Actor,
  actorOfTurn,
  BULK_STEP_ROWS,
  checkModuleStorage,
  type Collection,
  type CollectionHandle,
  type CollectionReader,
  type CommittedChange,
  CORE_OWNER,
  type CoreOwner,
  type CoreStorage,
  DEFAULT_LIST_LIMIT,
  type HostTx,
  type HouseholdStore,
  type IndexKey,
  indexKeyOf,
  isIndexable,
  isStoreFailure,
  type ListQuery,
  MAX_LIST_LIMIT,
  MAX_MIGRATION_ROWS,
  maxListRows,
  type ModuleEventRecord,
  type ModuleStorage,
  type ModuleStore,
  type PageCursor,
  readOnlyError,
  type Released,
  type Row,
  SAFE_ID,
  type ScopeRef,
  scopeKey,
  ScopeUnknown,
  StoreConflict,
  StoreError,
  type StoreFailure,
  type StoredModule,
  StoreNotFound,
  type StoreTx,
  type TxCollection,
  type UndeclaredData,
  type WhereValue
} from "./HouseholdStore.ts"
import { observe, runHook } from "./storeHooks.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

/**
 * The engine both household stores run (docs/STORING-DATA.md): the semantics of collections, the transaction model,
 * `prepare` and the release of events, written once over a small **synchronous** backend (`SyncBackend`): SQLite's
 * `DatabaseSync` in `@pva/store-sqlite`, maps with an undo list in the in-memory double. Internal to `@pva/core` and
 * `@pva/store-sqlite` (`@pva/core/store-backend`).
 *
 * The transaction model is one rule: **a transaction is one synchronous step, begun and ended by the engine alone.**
 * `runTx` begins, runs the function (which has no awaits), and commits, or rolls back when the function throws, without
 * ever yielding. Nothing else (no other fiber, no timer, no socket) runs in between, so there is nothing to lock, nest
 * or interrupt. Nothing outside the engine can begin or end the backend's transaction (there is no SQL in the
 * interface), and the engine still asks the backend whether its transaction is open after every failed statement and
 * before the commit: a transaction SQLite ended itself (`SQLITE_FULL`) fails whole, as does a failed `COMMIT`, with a
 * `StoreError`, and its rollback hooks run. A function that returns a promise, an Effect, a generator or a function
 * fails the transaction (it would run later against a transaction that has ended). A handle (`tx`, its collections) is
 * valid only while its function is on the stack. A `runTx` called while one runs (only possible from inside its
 * function) joins it. The events of a transaction (its data changes, its module events, its `afterCommit` callbacks)
 * are kept in a list on it and released after the commit, in the order they were made.
 */

/**
 * A row as a backend keeps it: the value as JSON text, the actor as JSON text. A row carries no data version of its
 * own: every row of a collection is at the collection's stored version (`StoredCollection.version`), because only
 * `prepare` changes that version, and it rewrites every row whose value changes in the same transaction.
 */
export interface StoredDoc {
  readonly owner: string
  readonly collection: string
  readonly id: string
  readonly scope: ScopeRef
  readonly rev: number
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly updatedBy: string
}

/**
 * One index of a collection, as the backend makes it. Column orders (after the owner, collection and scope):
 * `s` = (field, createdAt, id); `u` = (field, updatedAt, createdAt, id); `p` = (first, second, createdAt, id); the
 * base indexes `updated` = (updatedAt, createdAt, id) and `created` = (createdAt, id) exist for every collection.
 * `slots` are the positions of the fields in `Collection.fields` (the key columns `k0` … `k7`).
 */
export interface IndexSpec {
  readonly kind: "s" | "u" | "p"
  readonly slots: ReadonlyArray<number>
}

/** The indexes a collection's declaration asks for. */
export const layoutOf = (c: Collection<any>): ReadonlyArray<IndexSpec> =>
  c.indexes.flatMap((i): ReadonlyArray<IndexSpec> =>
    typeof i === "string"
      ? [{ kind: "s", slots: [c.fields.indexOf(i)] }, { kind: "u", slots: [c.fields.indexOf(i)] }]
      : [{ kind: "p", slots: [c.fields.indexOf(i[0]), c.fields.indexOf(i[1])] }]
  )

/** A list query as one index range read: its index, its filter (on the index's first key column) and its direction. */
export interface CheckedQuery {
  readonly limit: number
  readonly index: { readonly kind: "updated" | "created" } | IndexSpec
  /** Equality on the index's first key column. */
  readonly where: IndexKey | undefined
  readonly desc: boolean
  /**
   * Continue after this place in the index's order: the values of its columns after the scope (`cursorColumns`), ending
   * with the id. Only a key column can be `null` (a missing field): the first without `where`, the second of a pair.
   */
  readonly after?: ReadonlyArray<IndexKey>
}

/**
 * The names of an index's columns after (owner, collection, scope), in its order, as the memory backend and SQLite
 * both read them: a row's place in a list is these values, compared one after the other (`compareIndexed`).
 */
export const cursorColumns = (index: CheckedQuery["index"]): ReadonlyArray<string> => {
  switch (index.kind) {
    case "updated":
      return ["updatedAt", "createdAt", "id"]
    case "created":
      return ["createdAt", "id"]
    case "s":
      return [`k${index.slots[0]}`, "createdAt", "id"]
    case "u":
      return [`k${index.slots[0]}`, "updatedAt", "createdAt", "id"]
    case "p":
      return [`k${index.slots[0]}`, `k${index.slots[1]}`, "createdAt", "id"]
  }
}

/** What a backend keeps about a stored collection (`pva_collections`). */
export interface StoredCollection {
  readonly version: number
  readonly scope: string
  readonly shape: string
}

/** Where a bulk removal continues (conversation, owner, collection, id). */
export interface BulkKey {
  readonly scopeId: string
  readonly owner: string
  readonly collection: string
  readonly id: string
}

/** A row a bulk removal takes: its key and rev, nothing of its value. */
export interface BulkRow extends BulkKey {
  readonly scope: ScopeRef
  readonly rev: number
}

/**
 * The backend's primitives: all synchronous, all throwing on failure. The engine calls the writing ones only between
 * `begin` and `commit` / `rollback`, and is the only caller of those three.
 */
export interface SyncBackend {
  readonly readOnly: boolean
  readonly begin: () => void
  readonly commit: () => void
  readonly rollback: () => void
  /** Whether the backend's transaction is still open (SQLite ends one itself on some errors). */
  readonly inTransaction: () => boolean
  /** The row with this id in the collection, whatever its scope. */
  readonly read: (owner: string, collection: string, id: string) => StoredDoc | undefined
  /** One index range read (`CheckedQuery`), in the index's order (`compareIndexed`, ties by createdAt then id). */
  readonly list: (owner: string, collection: string, scope: ScopeRef, query: CheckedQuery) => ReadonlyArray<StoredDoc>
  /** Rows of one scope, newest first (`updatedAt`, `createdAt`, id, descending), after `after`. */
  readonly page: (owner: string, collection: string, scope: ScopeRef, after: PageCursor | undefined, limit: number) => ReadonlyArray<StoredDoc>
  /** Insert (`"absent"`) or replace the row at rev `expect` in its scope, with its index keys; `false` when that did not hold. */
  readonly put: (doc: StoredDoc, keys: ReadonlyArray<IndexKey>, expect: "absent" | number) => boolean
  /** Delete the row at rev `expect` in `scope`; `false` when it was not there so. */
  readonly remove: (owner: string, collection: string, id: string, scope: ScopeRef, expect: number) => boolean
  /** The next number of the store's one counter (rolled back with the transaction). */
  readonly nextRev: () => number
  readonly lastRev: () => number
  /** Rows of a collection after `afterId` in id order. */
  readonly scan: (owner: string, collection: string, afterId: string, limit: number) => ReadonlyArray<StoredDoc>
  /** How many rows a collection has, counting at most `cap + 1`. */
  readonly count: (owner: string, collection: string, cap: number) => number
  /** Store a migrated value of a row (same rev) with its new index keys. */
  readonly rewrite: (doc: StoredDoc, text: string, keys: ReadonlyArray<IndexKey>) => void
  /** Conversation-scoped rows (of one conversation, or of all) after `after`, in key order, at most `limit`. */
  readonly conversationRows: (conversationId: string | undefined, after: BulkKey | undefined, limit: number) => ReadonlyArray<BulkRow>
  /** The data version stored for an owner (`undefined`: none yet). */
  readonly ownerVersion: (owner: string) => number | undefined
  readonly setOwnerVersion: (owner: string, version: number) => void
  /** What is stored about the collections of an owner. */
  readonly storedCollections: (owner: string) => ReadonlyMap<string, StoredCollection>
  /** Every stored collection (for `undeclared`). */
  readonly allCollections: () => ReadonlyArray<{ readonly owner: string; readonly name: string; readonly version: number }>
  readonly setCollection: (owner: string, name: string, meta: StoredCollection) => void
  /** Make the indexes of one collection exactly `layoutOf(c)`. */
  readonly syncIndexes: (owner: string, c: Collection<any>) => void
  /** Whether the indexes `layoutOf(c)` asks for exist (read-only preparation). */
  readonly indexesReady: (owner: string, c: Collection<any>) => boolean
  /** After a commit that removed rows: make their content unreadable in the files too (SQLite: a checkpoint). */
  readonly removed: () => void
}

const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/
/**
 * Module ids the store (and `defineModule`) refuses: `host` is the host's event namespace (`host.*`), `core` the core
 * services' (`core.<name>.*`: their data owners and their events).
 */
export const RESERVED_MODULE_IDS: ReadonlySet<string> = new Set(["host", "core"])

const newId = () => globalThis.crypto.randomUUID()

const fail = (reason: StoreError["reason"], message: string, cause?: unknown): never => {
  throw new StoreError({ reason, message, ...(cause !== undefined ? { cause } : {}) })
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** SQLite's "busy" and "locked" (another connection holds the lock). */
const isBusy = (e: unknown): boolean => {
  const code = (e as { errcode?: unknown } | null)?.errcode
  return code === 5 || code === 6 || /SQLITE_BUSY|database is locked/i.test(messageOf(e))
}

// ---- Values

const jsonCodecs = new WeakMap<object, Schema.Codec<any, unknown>>()
const jsonOf = <A>(collection: Collection<A>): Schema.Codec<A, unknown> => {
  let codec = jsonCodecs.get(collection.schema)
  if (codec === undefined) {
    codec = Schema.toCodecJson(collection.schema) as unknown as Schema.Codec<A, unknown>
    jsonCodecs.set(collection.schema, codec)
  }
  return codec
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** JSON with sorted keys and without `annotations` (documentation, not shape). */
const canonical = (x: unknown): string => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (isObject(v)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v).sort()) if (k !== "annotations") out[k] = walk(v[k])
      return out
    }
    return v
  }
  return JSON.stringify(walk(x)) ?? "null"
}

const shapes = new WeakMap<Collection<any>, string>()
/**
 * The canonical description of a collection's declaration: its scope, its indexes (in order: they decide the key
 * columns), its `maxChars` and its schema's JSON form (Effect's schema representation of `Schema.toCodecJson`, without
 * annotations). It covers the structure of the schema and the built-in checks the representation holds; a custom
 * check's function is not in it (`defineCollection`).
 */
export const shapeOf = (c: Collection<any>): string => {
  let shape = shapes.get(c)
  if (shape === undefined) {
    let schema: unknown
    try {
      schema = SchemaRepresentation.toRepresentation(Schema.toCodecJson(c.schema).ast)
    } catch (e) {
      schema = { opaque: messageOf(e) }
    }
    shape = canonical({ scope: c.scope, indexes: c.indexes, maxChars: c.maxChars, schema })
    shapes.set(c, shape)
  }
  return shape
}

/**
 * A value as it is stored: encoded with the schema's JSON codec, which must give an object; at most the collection's
 * `maxChars` of JSON; indexed fields `isIndexable` or missing; decoded again from the text, so the value returned is
 * what a read gives back (and never the caller's object). With the key of each indexed field.
 */
export const encodeValue = <A>(collection: Collection<A>, value: A): { readonly text: string; readonly value: A; readonly keys: ReadonlyArray<IndexKey> } => {
  const codec = jsonOf(collection)
  const encoded = Schema.encodeUnknownExit(codec)(value)
  if (Exit.isFailure(encoded)) return fail("invalid", `Collection ${collection.name}: the value does not match its schema: ${String(encoded.cause).slice(0, 500)}`)
  const json = encoded.value
  if (!isObject(json)) return fail("invalid", `Collection ${collection.name}: a value must be an object (its JSON form is ${Array.isArray(json) ? "a list" : json === null ? "null" : typeof json})`)
  let text: string | undefined
  try {
    text = JSON.stringify(json)
  } catch (cause) {
    return fail("invalid", `Collection ${collection.name}: the value is not JSON`, cause)
  }
  if (text === undefined) return fail("invalid", `Collection ${collection.name}: the value is not JSON`)
  if (text.length > collection.maxChars) {
    return fail("invalid", `Collection ${collection.name}: a value may hold at most ${collection.maxChars} characters of JSON (its maxChars; this one has ${text.length})`)
  }
  const parsed = JSON.parse(text) as Record<string, unknown>
  const keys = keysOf(collection, parsed)
  const decoded = Schema.decodeUnknownExit(codec)(parsed)
  if (Exit.isFailure(decoded)) return fail("invalid", `Collection ${collection.name}: the value does not survive storing: ${String(decoded.cause).slice(0, 500)}`)
  return { text, value: decoded.value, keys }
}

/** The index key of each indexed field of a value's JSON form; a field that is not `isIndexable` is `invalid`. */
const keysOf = (collection: Collection<any>, parsed: Record<string, unknown>): ReadonlyArray<IndexKey> =>
  collection.fields.map((field) => {
    if (!Object.hasOwn(parsed, field)) return null
    const v = parsed[field]
    if (!isIndexable(v)) {
      return fail("invalid", `Collection ${collection.name}: the indexed field "${field}" must be a string (well-formed, without NUL, at most 500 characters), a finite number or true/false`)
    }
    return indexKeyOf(v)
  })

const parseStored = (collection: Collection<any>, text: string, id: string): unknown => {
  try {
    return JSON.parse(text)
  } catch (cause) {
    return fail("failed", `Row ${id} of ${collection.name} is not JSON`, cause)
  }
}

/**
 * A stored value (JSON text) as the collection's type: decoded and validated, never migrated (a read never migrates:
 * every row is at its collection's version, `StoredDoc`). A value the schema refuses (a custom check that changed
 * without a new version) is `failed`.
 */
export const decodeStored = <A>(collection: Collection<A>, text: string, id: string): { readonly value: A } => {
  const decoded = Schema.decodeUnknownExit(jsonOf(collection))(parseStored(collection, text, id))
  if (Exit.isFailure(decoded)) return fail("failed", `Row ${id} of ${collection.name} does not match its schema: ${String(decoded.cause).slice(0, 500)}`)
  return { value: decoded.value }
}

export { observe }

/**
 * A stored value of a collection at data version `from`, migrated to `to` one version at a time (a version without a
 * migration of this collection leaves it as it is), then decoded as the collection's type. Only `prepare` calls it.
 */
export const migrateStored = <A>(collection: Collection<A>, from: number, to: number, text: string, id: string, log: (line: string) => void = () => {}): { readonly value: A } => {
  let current = parseStored(collection, text, id)
  for (let at = from; at < to; at++) {
    const step = collection.migrate[at]
    if (step === undefined) continue
    try {
      current = step(current)
    } catch (cause) {
      return fail("failed", `Collection ${collection.name}: migrating row ${id} from version ${at} failed: ${messageOf(cause)}`, cause)
    }
    const refused = refusedResult(current)
    if (refused !== undefined) {
      observe(current, log, `Migrating row ${id} of ${collection.name}`)
      return fail("failed", `Collection ${collection.name}: migrating row ${id} from version ${at} returned ${refused}; a migration returns the new value`)
    }
  }
  const decoded = Schema.decodeUnknownExit(jsonOf(collection))(current)
  if (Exit.isFailure(decoded)) return fail("failed", `Row ${id} of ${collection.name} does not match its schema: ${String(decoded.cause).slice(0, 500)}`)
  return { value: decoded.value }
}

/** Whether a collection's migrations do anything between two versions. */
const migratesBetween = (c: Collection<any>, from: number, to: number) => {
  for (let at = from; at < to; at++) if (c.migrate[at] !== undefined) return true
  return false
}

/** Check a list query against the collection's indexes and the shapes one index can answer (`ListQuery`). */
export const checkQuery = (collection: Collection<any>, query: ListQuery<any> | undefined): CheckedQuery => {
  const invalid = (message: string) => fail("invalid", `Collection ${collection.name}: ${message}`)
  const single = (f: string) => collection.indexes.includes(f)
  const pair = (f: string, g: string) => collection.indexes.some((i) => typeof i !== "string" && i[0] === f && i[1] === g)
  const slot = (f: string) => collection.fields.indexOf(f)
  const entries = Object.entries(query?.where ?? {}).filter(([, v]) => v !== undefined)
  if (entries.length > 1) return invalid(`list filters on one indexed field at a time (it was given ${entries.map(([f]) => f).join(", ")}); store a combined field and index it`)
  const field = query?.orderBy?.field ?? "updatedAt"
  const column = field === "createdAt" || field === "updatedAt"
  const direction = query?.orderBy?.direction
  if (direction !== undefined && direction !== "asc" && direction !== "desc") return invalid(`direction must be "asc" or "desc"`)
  const most = maxListRows(collection)
  const limit = query?.limit ?? Math.min(DEFAULT_LIST_LIMIT, most)
  if (!Number.isInteger(limit) || limit < 1 || limit > most) {
    return invalid(`limit must be 1 to ${most} (rows of at most ${collection.maxChars} characters; LIST_BUDGET_CHARS / maxChars, at most ${MAX_LIST_LIMIT}); continue with \`after\``)
  }
  const where = entries[0] as readonly [string, unknown] | undefined
  if (where === undefined) {
    if (column) return { limit, index: { kind: field === "createdAt" ? "created" : "updated" }, where: undefined, desc: (direction ?? "desc") === "desc" }
    if (!single(field)) return invalid(`cannot order on "${field}", which is not declared as an index of its own`)
    return { limit, index: { kind: "s", slots: [slot(field)] }, where: undefined, desc: (direction ?? "asc") === "desc" }
  }
  const [f, value] = where
  if (!isIndexable(value)) return invalid(`the filter on "${f}" must be a string (well-formed, without NUL, at most 500 characters), a finite number or true/false`)
  const key = indexKeyOf(value)
  if (field === "updatedAt" || field === "createdAt" || field === f) {
    if (!single(f)) return invalid(`"${f}" is not declared as an index of its own (indexes: ${JSON.stringify(collection.indexes)})`)
    const kind = field === "updatedAt" ? "u" : "s"
    return { limit, index: { kind, slots: [slot(f)] }, where: key, desc: (direction ?? (column ? "desc" : "asc")) === "desc" }
  }
  if (!pair(f, field)) return invalid(`a list filtered on "${f}" and ordered by "${field}" needs the index ["${f}", "${field}"]`)
  return { limit, index: { kind: "p", slots: [slot(f), slot(field)] }, where: key, desc: (direction ?? "asc") === "desc" }
}

/** A row id a caller gave (to insert, get, update or remove): `SAFE_ID`. */
const checkRowId = (collection: string, id: string) => {
  if (typeof id !== "string" || !SAFE_ID.test(id)) fail("invalid", `Collection ${collection}: "${String(id).slice(0, 40)}" is not a valid row id (1–200 letters, digits, _ . : -)`)
}

const ACTOR_KINDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  turn: ["conversationId", "source"],
  job: ["jobId"],
  admin: [],
  ui: ["deviceId"],
  module: ["moduleId"],
  system: ["name"]
}
const OPTIONAL_TURN_FIELDS = ["assistantId", "deviceId", "personId"]

/** An actor as `Actor` says: a known kind, its fields strings, a turn's id a finite number; nothing else. */
const checkActor = (actor: unknown): Actor => {
  const bad = (why: string) => fail("invalid", `The actor is not valid: ${why}`)
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) return bad("it must be an object")
  const a = actor as Record<string, unknown>
  const kind = a.kind
  const required = typeof kind === "string" && Object.hasOwn(ACTOR_KINDS, kind) ? ACTOR_KINDS[kind]! : undefined
  if (required === undefined) return bad(`its kind must be one of ${Object.keys(ACTOR_KINDS).join(", ")}`)
  const allowed = new Set(["kind", ...required, ...(kind === "turn" ? ["turnId", ...OPTIONAL_TURN_FIELDS] : [])])
  for (const k of Object.keys(a)) if (!allowed.has(k)) bad(`a ${String(kind)} actor has no field "${k}"`)
  for (const k of required) if (typeof a[k] !== "string") bad(`"${k}" must be a string`)
  if (kind === "turn") {
    if (typeof a.turnId !== "number" || !Number.isFinite(a.turnId)) bad("a turn's turnId must be a finite number")
    for (const k of OPTIONAL_TURN_FIELDS) if (a[k] !== undefined && typeof a[k] !== "string") bad(`"${k}" must be a string`)
  }
  return a as unknown as Actor
}

/**
 * The scope of a call: the one given (of the collection's kind, its id `SAFE_ID`), else the turn's, else
 * `ScopeUnknown`. Always a fresh object: nothing the caller holds is kept.
 */
export const resolveScopeSync = (collection: Collection<any>, given: ScopeRef | undefined, turn: TurnContext | undefined): ScopeRef => {
  if (given !== undefined) {
    if (given === null || typeof given !== "object" || given.kind !== collection.scope) {
      return fail("invalid", `Collection ${collection.name} is ${collection.scope}-scoped; it was given a ${String((given as { kind?: unknown } | null)?.kind)} scope`)
    }
    if (given.kind === "household") return { kind: "household" }
    const id = given.id
    if (typeof id !== "string" || !SAFE_ID.test(id)) return fail("invalid", `Collection ${collection.name}: a scope id must be 1 to 200 letters, digits, _ . : -`)
    return { kind: given.kind, id }
  }
  const kind = collection.scope
  if (kind === "household") return { kind: "household" }
  const id = turn === undefined
    ? undefined
    : kind === "person" ? turn.person?.id : kind === "device" ? turn.deviceId : kind === "assistant" ? turn.assistantId : turn.conversationId
  if (id !== undefined && id !== "") {
    if (!SAFE_ID.test(id)) return fail("invalid", `Collection ${collection.name}: the turn's ${kind} id is not a valid scope id`)
    return { kind, id }
  }
  const message = kind === "person"
    ? `No person is known for this ${turn === undefined ? "call" : "turn"}, so it is not clear whose ${collection.name} this is.`
    : `No ${kind} is known for this ${turn === undefined ? "call (no turn)" : "turn"}; pass the scope explicitly.`
  throw new ScopeUnknown({ collection: collection.name, scope: kind, message })
}

const sameScope = (a: ScopeRef, b: ScopeRef) => scopeKey(a) === scopeKey(b)

/** A valid scope given to an event (`publish`): household by default, an id `SAFE_ID`. */
const eventScope = (scope: ScopeRef | undefined): ScopeRef => {
  if (scope === undefined || scope.kind === "household") return { kind: "household" }
  if (!["person", "assistant", "device", "conversation"].includes(scope.kind) || typeof scope.id !== "string" || !SAFE_ID.test(scope.id)) {
    return fail("invalid", "An event's scope id must be 1 to 200 letters, digits, _ . : -")
  }
  return { kind: scope.kind, id: scope.id }
}

/** Module event types: lower-case words separated by dots (`stock.low`), at most 80 characters. */
export const EVENT_TYPE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/

/**
 * Why a transaction function's result cannot be accepted (`undefined`: it can): a promise or other thenable, an
 * Effect, a generator or other iterator object, or a function would all go on running after the transaction ended.
 */
export const refusedResult = (x: unknown): string | undefined => {
  if (typeof x === "function") return "a function"
  if (typeof x !== "object" || x === null) return undefined
  if (Effect.isEffect(x)) return "an Effect"
  if (typeof (x as { then?: unknown }).then === "function") return "a promise"
  if (typeof (x as { next?: unknown }).next === "function" && (Symbol.iterator in x || Symbol.asyncIterator in x)) return "a generator"
  return undefined
}

// ---- The engine

interface TxState {
  /** What to release after the commit, in order. */
  readonly out: Array<Released | { readonly _tag: "run"; readonly run: () => void }>
  readonly undo: Array<() => void>
  removed: boolean
  /** Set once the transaction cannot commit any more (SQLite ended it; a function returned a promise): its error. */
  doomed: StoreError | undefined
}

/** One function's hold on a transaction: live while that function runs. */
interface Frame {
  live: boolean
  readonly tx: TxState
}

/** The context of one call: whose turn, the actor by default, the time. */
interface CallContext {
  readonly turn: TurnContext | undefined
  readonly at: number
}

interface Declared {
  readonly c: Collection<any>
  readonly shape: string
  /** Whether the store holds the collection (read-only: a collection the server never prepared reads as empty). */
  present: boolean
}

interface OwnerState {
  readonly owner: string
  /** The data version declared (`ModuleStorage.version`). */
  readonly version: number
  readonly collections: Map<string, Declared>
  verdict: ModuleUnavailable | undefined
}

/** The beginning of a transaction found the database locked by another connection: nothing ran yet; try again. */
class BusyAtBegin {
  readonly error: StoreError
  constructor(error: StoreError) {
    this.error = error
  }
}

export interface EngineOptions {
  readonly backend: SyncBackend
  /** A backup before the first migration of this start (SQLite; not for a new or in-memory file). */
  readonly backupBeforeUpgrade?: (what: string) => Effect.Effect<string | undefined, StoreError>
  readonly log?: (line: string) => void
}

/** What both stores share of `HouseholdStore`; each adds `info` and `backup`. */
export type EngineStore = Omit<HouseholdStore, "info" | "backup"> & {
  /** Whether a transaction is running now. */
  readonly inTransaction: () => boolean
}

/**
 * A transaction whose beginning found the database locked is tried again after pauses on timers (never blocking the
 * event loop) that double from 1 ms up to `BUSY_MAX_PAUSE_MS`, until `BUSY_BUDGET_MS` of pauses have passed: the
 * store's own checkpoint worker holds the write lock while it truncates the log, and that must not reach a caller as
 * `busy`. Only a lock held for longer (a second server, an external tool) is `busy` (docs/STORING-DATA.md).
 */
const BUSY_BUDGET_MS = 1_000
const BUSY_MAX_PAUSE_MS = 100
/** The pause before try `n + 1` after `n + 1` busy beginnings (`n` from 0), or `undefined` when the budget is spent. */
const busyPauseMs = (n: number): number | undefined => {
  let spent = 0
  for (let i = 0; i < n; i++) spent += Math.min(BUSY_MAX_PAUSE_MS, 2 ** i)
  return spent >= BUSY_BUDGET_MS ? undefined : Math.min(BUSY_MAX_PAUSE_MS, 2 ** n)
}

/** A pause on a real timer (not the Effect clock): the lock is held by another thread, whatever a test's clock says. */
const pause = (ms: number) => Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
/** Let the event loop run (timers, sockets) between two bounded steps. */
const yieldToLoop = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
/** After the `n`-th busy beginning (from 0): try `again` after a pause, or fail `busy` once the budget is spent. */
const againAfterBusy = <X, E>(n: number, busy: BusyAtBegin, again: () => Effect.Effect<X, E>): Effect.Effect<X, E | StoreError> => {
  const ms = busyPauseMs(n)
  return ms === undefined ? Effect.fail(busy.error) : Effect.flatMap(pause(ms), again)
}

export const makeStoreEngine = (options: EngineOptions): EngineStore => {
  const { backend } = options
  const readOnly = backend.readOnly
  const log = options.log ?? (() => {})

  const owners = new Map<string, OwnerState>()
  let undeclaredData: ReadonlyArray<UndeclaredData> = []
  const listeners = new Set<(released: ReadonlyArray<Released>) => void>()

  // ---- Release, in order, never re-entrant (a listener that starts a transaction has it released after this one)

  let releasing = false
  const pending: Array<TxState["out"]> = []
  const fire = (batch: ReadonlyArray<Released>) => {
    if (batch.length === 0) return
    for (const l of [...listeners]) {
      try {
        l(batch)
      } catch {
        // A listener must not break a commit or the other listeners.
      }
    }
  }
  const release = (out: TxState["out"]) => {
    pending.push(out)
    if (releasing) return
    releasing = true
    try {
      for (let items = pending.shift(); items !== undefined; items = pending.shift()) {
        let batch: Array<Released> = []
        for (const item of items) {
          if (item._tag !== "run") {
            batch.push(item)
            continue
          }
          fire(batch)
          batch = []
          runHook(item.run, log, "An after-commit callback")
        }
        fire(batch)
      }
    } finally {
      releasing = false
    }
  }

  // ---- Transactions: one synchronous step each

  let active: TxState | undefined

  const runUndo = (undo: ReadonlyArray<() => void>) => {
    for (let i = undo.length - 1; i >= 0; i--) {
      runHook(undo[i]!, log, "A rollback hook")
    }
  }

  const lost = () => new StoreError({ reason: "failed", message: "The database ended the household transaction itself (for example, the disk is full); nothing of it was kept" })

  /** A backend call: a failure inside a transaction checks that the backend's transaction is still open. */
  const guarded = <X>(f: () => X): X => {
    try {
      return f()
    } catch (e) {
      if (active !== undefined && !backend.inTransaction()) {
        active.doomed ??= lost()
        throw active.doomed
      }
      if (isStoreFailure(e)) throw e
      throw new StoreError({ reason: isBusy(e) ? "busy" : "failed", message: `The household store failed: ${messageOf(e)}`, cause: e })
    }
  }

  const runTx = <X>(body: (state: TxState) => X): X => {
    if (active !== undefined) {
      if (active.doomed !== undefined) throw active.doomed
      if (!backend.inTransaction()) throw (active.doomed = lost())
      return body(active)
    }
    const state: TxState = { out: [], undo: [], removed: false, doomed: undefined }
    try {
      backend.begin()
    } catch (e) {
      const error = new StoreError({ reason: isBusy(e) ? "busy" : "failed", message: `The household transaction could not begin: ${messageOf(e)}`, cause: e })
      throw isBusy(e) ? new BusyAtBegin(error) : error
    }
    active = state
    let result: X
    try {
      result = body(state)
      if (state.doomed !== undefined) throw state.doomed
      if (!backend.inTransaction()) throw lost()
      try {
        backend.commit()
      } catch (e) {
        throw new StoreError({ reason: isBusy(e) ? "busy" : "failed", message: `The household transaction could not be committed; nothing of it was kept: ${messageOf(e)}`, cause: e })
      }
      if (backend.inTransaction()) throw new StoreError({ reason: "failed", message: "The household transaction did not end at its commit; nothing of it was kept" })
    } catch (e) {
      active = undefined
      try {
        if (backend.inTransaction()) backend.rollback()
      } catch {
        // The transaction is gone either way.
      }
      runUndo(state.undo)
      throw e
    }
    active = undefined
    if (state.removed) {
      try {
        backend.removed()
      } catch {
        // Scheduling the checkpoint must not fail a committed transaction.
      }
    }
    release(state.out)
    return result
  }

  /**
   * Run a transaction function with a handle valid only while it runs, and refuse a result that would go on running
   * after it (the whole transaction rolls back, also when it was joined).
   */
  const callFn = <H, X>(state: TxState, make: (frame: Frame) => H, f: (handle: H) => X): X => {
    const frame: Frame = { live: true, tx: state }
    let result: X
    try {
      result = f(make(frame))
    } finally {
      frame.live = false
    }
    const refused = refusedResult(result)
    if (refused !== undefined) {
      // It goes on without the transaction; whatever it does there fails. Never an unhandled rejection.
      observe(result, log, "A household transaction function that returned a promise")
      state.doomed = new StoreError({
        reason: "invalid",
        message: `A transaction function returned ${refused}: transactions cannot await (no promise, Effect or generator; do the asynchronous work before or after it). Nothing of it was kept.`
      })
      throw state.doomed
    }
    return result
  }

  /** The handle's transaction, if the handle is still valid. */
  const live = (frame: Frame, what: string): TxState => {
    if (!frame.live || active !== frame.tx) {
      return fail("invalid", `${what}: this transaction handle was used after its function returned; use a handle only inside the function it was given to`)
    }
    if (frame.tx.doomed !== undefined) throw frame.tx.doomed
    return frame.tx
  }

  const contextNow = Effect.all([Effect.service(CurrentTurn), Clock.currentTimeMillis])

  /** The transaction's effect: the turn and the time are read first, then `f` runs as one step (tried again while busy). */
  const transactionEffect = <X>(f: (ctx: CallContext) => X): Effect.Effect<X, StoreFailure> =>
    Effect.flatMap(contextNow, ([turn, at]) => {
      const attempt = (n: number): Effect.Effect<X, StoreFailure> =>
        Effect.suspend(() => {
          try {
            return Effect.succeed(f({ turn, at }))
          } catch (e) {
            if (e instanceof BusyAtBegin) return againAfterBusy(n, e, () => attempt(n + 1))
            return isStoreFailure(e) ? Effect.fail(e) : Effect.die(e)
          }
        })
      return attempt(0)
    })

  /** A read outside any transaction (or inside the running one): one synchronous step too. */
  const readEffect = <X>(f: (ctx: CallContext) => X): Effect.Effect<X, StoreError | ScopeUnknown> =>
    Effect.flatMap(contextNow, ([turn, at]) =>
      Effect.suspend(() => {
        try {
          return Effect.succeed(f({ turn, at }))
        } catch (e) {
          return e instanceof StoreError || e instanceof ScopeUnknown ? Effect.fail(e) : Effect.die(e)
        }
      }))

  // ---- Owners and their collections

  const usable = (owner: string) => {
    const verdict = owners.get(owner)?.verdict
    if (verdict !== undefined) fail("unavailable", `${owner}'s data is not usable here: ${verdict.reason}`)
  }

  /** The owner's declaration of `c` (the canonical one: the caller's object is used only to find it). */
  const resolve = (owner: string, c: Collection<any>): { readonly st: OwnerState; readonly d: Declared } => {
    const st = owners.get(owner)
    const name = (c as { name?: unknown } | null)?.name
    if (st?.verdict !== undefined) fail("unavailable", `${owner}'s data is not usable here: ${st.verdict.reason}`)
    const d = typeof name === "string" ? st?.collections.get(name) : undefined
    if (st === undefined || d === undefined) return fail("invalid", `${owner}: collection "${String(name)}" is not declared in its storage.collections`)
    if (d.c !== c && shapeOf(c) !== d.shape) {
      return fail("invalid", `${owner}: this is another declaration of collection "${d.c.name}" (its schema, scope or indexes differ from the declared one)`)
    }
    if (st.verdict !== undefined) fail("unavailable", `${owner}'s data is not usable here: ${st.verdict.reason}`)
    return { st, d }
  }

  const rowOf = <A>(c: Collection<A>, doc: StoredDoc): Row<A> => {
    const decoded = decodeStored(c, doc.text, doc.id)
    return {
      id: doc.id,
      rev: doc.rev,
      scope: { ...doc.scope },
      value: decoded.value,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      updatedBy: JSON.parse(doc.updatedBy) as Actor
    }
  }

  const actorText = (owner: string, given: Actor | undefined, turn: TurnContext | undefined): string => {
    const actor: Actor = checkActor(given !== undefined ? given : turn === undefined ? { kind: "module", moduleId: owner } : actorOfTurn(turn))
    let text: string | undefined
    try {
      text = JSON.stringify(actor)
    } catch {
      text = undefined
    }
    if (text === undefined || text.length > 2000) return fail("invalid", "The actor must be plain JSON of at most 2,000 characters")
    return text
  }

  /** Conversations whose rows are being removed (`endConversation`): hidden at once. `"*"`: every conversation (the sweep). */
  const ending = new Map<string, number>()
  const hidden = (scope: ScopeRef) => scope.kind === "conversation" && (ending.has("*") || ending.has(scope.id))

  // ---- The operations, once

  const doGet = <A>(owner: string, c: Collection<A>, id: string, scopeGiven: ScopeRef | undefined, turn: TurnContext | undefined): Row<A> | undefined => {
    const { d } = resolve(owner, c)
    const scope = resolveScopeSync(d.c, scopeGiven, turn)
    checkRowId(d.c.name, id)
    if (hidden(scope) || !d.present) return undefined
    const doc = guarded(() => backend.read(owner, d.c.name, id))
    return doc === undefined || !sameScope(doc.scope, scope) ? undefined : rowOf(d.c, doc)
  }

  /** The rows lists gave out, with the query that gave each (a later list continues `after` one of them). */
  const listed = new WeakMap<object, { readonly owner: string; readonly collection: string; readonly query: string; readonly doc: StoredDoc }>()
  const queryKey = (scope: ScopeRef, q: CheckedQuery) => JSON.stringify([scopeKey(scope), q.index, q.where, q.desc])

  /** Where a list continues after `row`: its values of the index's columns (`cursorColumns`). */
  const cursorAfter = (owner: string, c: Collection<any>, scope: ScopeRef, q: CheckedQuery, row: unknown): ReadonlyArray<IndexKey> => {
    const from = typeof row === "object" && row !== null ? listed.get(row) : undefined
    if (from === undefined || from.owner !== owner || from.collection !== c.name || from.query !== queryKey(scope, q)) {
      return fail("invalid", `Collection ${c.name}: \`after\` must be a row a list of the same query (where, orderBy, scope) of this collection returned`)
    }
    const doc = from.doc
    const keys = keysOf(c, parseStored(c, doc.text, doc.id) as Record<string, unknown>)
    return cursorColumns(q.index).map((col) => (col === "updatedAt" ? doc.updatedAt : col === "createdAt" ? doc.createdAt : col === "id" ? doc.id : keys[Number(col.slice(1))] ?? null))
  }

  const doList = <A>(owner: string, c: Collection<A>, query: ListQuery<A> | undefined, turn: TurnContext | undefined): ReadonlyArray<Row<A>> => {
    const { d } = resolve(owner, c)
    const checked = checkQuery(d.c, query)
    const scope = resolveScopeSync(d.c, query?.scope, turn)
    const q: CheckedQuery = query?.after === undefined ? checked : { ...checked, after: cursorAfter(owner, d.c, scope, checked, query.after) }
    if (hidden(scope) || !d.present) return []
    const key = queryKey(scope, checked)
    return guarded(() => backend.list(owner, d.c.name, scope, q)).map((doc) => {
      const row = rowOf(d.c, doc)
      listed.set(row, { owner, collection: d.c.name, query: key, doc })
      return row
    })
  }

  const writeTarget = (owner: string, c: Collection<any>, what: string) => {
    const target = resolve(owner, c)
    if (readOnly) throw readOnlyError(what)
    return target
  }

  const writeScope = (c: Collection<any>, given: ScopeRef | undefined, turn: TurnContext | undefined) => {
    const scope = resolveScopeSync(c, given, turn)
    if (hidden(scope)) fail("invalid", `Collection ${c.name}: the conversation ${scopeKey(scope)} has ended; its rows are being removed`)
    return scope
  }

  const announce = (state: TxState, change: CommittedChange) => void state.out.push({ _tag: "change", change })

  const doInsert = <A>(state: TxState, owner: string, c: Collection<A>, value: A, opts: { readonly id?: string; readonly scope?: ScopeRef; readonly actor?: Actor } | undefined, ctx: CallContext): Row<A> => {
    const { d } = writeTarget(owner, c, "insert")
    const scope = writeScope(d.c, opts?.scope, ctx.turn)
    const id = opts?.id ?? newId()
    checkRowId(d.c.name, id)
    const encoded = encodeValue(d.c, value)
    const updatedBy = actorText(owner, opts?.actor, ctx.turn)
    const conflict = () => new StoreConflict({ collection: d.c.name, id, message: `A row ${id} already exists in ${d.c.name}` })
    if (guarded(() => backend.read(owner, d.c.name, id)) !== undefined) throw conflict()
    const rev = guarded(() => backend.nextRev())
    const doc: StoredDoc = { owner, collection: d.c.name, id, scope, rev, text: encoded.text, createdAt: ctx.at, updatedAt: ctx.at, updatedBy }
    if (!guarded(() => backend.put(doc, encoded.keys, "absent"))) throw conflict()
    announce(state, { seq: rev, at: ctx.at, module: owner, collection: d.c.name, id, op: "insert", rev, scope: { ...scope }, actor: JSON.parse(updatedBy) as Actor, row: rowOf(d.c, doc) })
    return rowOf(d.c, doc)
  }

  const doUpdate = <A>(state: TxState, owner: string, c: Collection<A>, id: string, f: (value: A) => A, opts: { readonly expectRev?: number; readonly scope?: ScopeRef; readonly actor?: Actor } | undefined, ctx: CallContext): Row<A> => {
    const { d } = writeTarget(owner, c, "update")
    const scope = writeScope(d.c, opts?.scope, ctx.turn)
    checkRowId(d.c.name, id)
    const doc = guarded(() => backend.read(owner, d.c.name, id))
    if (doc === undefined || !sameScope(doc.scope, scope)) throw new StoreNotFound({ collection: d.c.name, id: String(id) })
    const conflict = (message: string) => new StoreConflict({ collection: d.c.name, id, message })
    if (opts?.expectRev !== undefined && doc.rev !== opts.expectRev) throw conflict(`Row ${id} of ${d.c.name} is at rev ${doc.rev}, not ${opts.expectRev}`)
    // The function gets a value of its own: what it does to it never reaches the row it replaces.
    const before = rowOf(d.c, doc)
    let next: A
    try {
      next = f(rowOf(d.c, doc).value)
    } catch (cause) {
      if (isStoreFailure(cause)) throw cause
      return fail("failed", `Collection ${d.c.name}: the update function failed: ${messageOf(cause)}`, cause)
    }
    const refused = refusedResult(next)
    if (refused !== undefined) {
      observe(next, log, `The update function of ${d.c.name}`)
      return fail("invalid", `Collection ${d.c.name}: the update function returned ${refused}; it must return the new value`)
    }
    const encoded = encodeValue(d.c, next)
    const updatedBy = actorText(owner, opts?.actor, ctx.turn)
    const rev = guarded(() => backend.nextRev())
    const written: StoredDoc = { ...doc, rev, text: encoded.text, updatedAt: ctx.at, updatedBy }
    if (!guarded(() => backend.put(written, encoded.keys, doc.rev))) throw conflict(`Row ${id} of ${d.c.name} changed meanwhile`)
    announce(state, { seq: rev, at: ctx.at, module: owner, collection: d.c.name, id, op: "update", rev, scope: { ...doc.scope }, actor: JSON.parse(updatedBy) as Actor, row: rowOf(d.c, written), before })
    return rowOf(d.c, written)
  }

  const doRemove = (state: TxState, owner: string, c: Collection<any>, id: string, opts: { readonly expectRev?: number; readonly scope?: ScopeRef; readonly actor?: Actor } | undefined, ctx: CallContext): boolean => {
    const { d } = writeTarget(owner, c, "remove")
    const scope = writeScope(d.c, opts?.scope, ctx.turn)
    checkRowId(d.c.name, id)
    const doc = guarded(() => backend.read(owner, d.c.name, id))
    if (doc === undefined || !sameScope(doc.scope, scope)) return false
    if (opts?.expectRev !== undefined && doc.rev !== opts.expectRev) throw new StoreConflict({ collection: d.c.name, id, message: `Row ${id} of ${d.c.name} is at rev ${doc.rev}, not ${opts.expectRev}` })
    const updatedBy = actorText(owner, opts?.actor, ctx.turn)
    let before: Row<unknown> | undefined
    try {
      before = rowOf(d.c, doc)
    } catch {
      before = undefined
    }
    const rev = guarded(() => backend.nextRev())
    if (!guarded(() => backend.remove(owner, d.c.name, id, doc.scope, doc.rev))) throw new StoreConflict({ collection: d.c.name, id, message: `Row ${id} of ${d.c.name} changed meanwhile` })
    state.removed = true
    announce(state, { seq: rev, at: ctx.at, module: owner, collection: d.c.name, id, op: "remove", rev, scope: { ...doc.scope }, actor: JSON.parse(updatedBy) as Actor, ...(before !== undefined ? { before } : {}) })
    return true
  }

  const publishIn = (state: TxState, owner: string, ctx: CallContext, type: string, data: unknown, scope: ScopeRef | undefined) => {
    if (typeof type !== "string" || type.length > 80 || !EVENT_TYPE.test(type)) fail("invalid", `${owner}: event type "${String(type).slice(0, 80)}" is not lower-case words separated by dots`)
    const event: ModuleEventRecord = {
      at: ctx.at,
      module: owner,
      type: `${owner}.${type}`,
      scope: eventScope(scope),
      actor: ctx.turn === undefined ? { kind: "module", moduleId: owner } : actorOfTurn(ctx.turn),
      data
    }
    state.out.push({ _tag: "event", event })
  }

  /** The handle of a running transaction for one owner, valid while `frame` is. */
  const storeTx = (owner: string, frame: Frame, ctx: CallContext): StoreTx => {
    const handles = new WeakMap<Collection<any>, TxCollection<any>>()
    return {
      collection: <A>(c: Collection<A>) => {
        let h = handles.get(c)
        if (h === undefined) {
          h = {
            get: (id, o) => (live(frame, "A read"), doGet(owner, c, id, o?.scope, ctx.turn)),
            list: (q) => (live(frame, "A read"), doList(owner, c, q, ctx.turn)),
            insert: (v, o) => doInsert(live(frame, "A write"), owner, c, v, o, ctx),
            update: (id, f, o) => doUpdate(live(frame, "A write"), owner, c, id, f, o, ctx),
            remove: (id, o) => doRemove(live(frame, "A write"), owner, c, id, o, ctx)
          } satisfies TxCollection<A>
          handles.set(c, h)
        }
        return h as TxCollection<A>
      },
      publish: (type, data, scope) => {
        const state = live(frame, "An event")
        usable(owner)
        publishIn(state, owner, ctx, type, data, scope)
      },
      afterCommit: (f) => void live(frame, "afterCommit").out.push({ _tag: "run", run: f }),
      onRollback: (f) => void live(frame, "onRollback").undo.push(f)
    }
  }

  /** The store of one owner (a module's `ctx.store`, or a core service's): it reaches that owner's collections only. */
  const ownerStore = (owner: string): ModuleStore => {
    const handles = new WeakMap<Collection<any>, CollectionHandle<any>>()
    return {
      moduleId: owner,
      readOnly,
      collection: <A>(c: Collection<A>) => {
        let h = handles.get(c)
        if (h === undefined) {
          const handle: CollectionHandle<A> = {
            get: (id, o) => readEffect((ctx) => doGet(owner, c, id, o?.scope, ctx.turn)),
            list: (q) => readEffect((ctx) => doList(owner, c, q, ctx.turn)),
            insert: (v, o) => transactionEffect((ctx) => runTx((state) => doInsert(state, owner, c, v, o, ctx))) as Effect.Effect<Row<A>, StoreError | StoreConflict | ScopeUnknown>,
            update: (id, f, o) => transactionEffect((ctx) => runTx((state) => doUpdate(state, owner, c, id, f, o, ctx))),
            remove: (id, o) => transactionEffect((ctx) => runTx((state) => doRemove(state, owner, c, id, o, ctx))) as Effect.Effect<boolean, StoreError | StoreConflict | ScopeUnknown>
          }
          h = handle
          handles.set(c, h)
        }
        return h as CollectionHandle<A>
      },
      transaction: (f) =>
        transactionEffect((ctx) =>
          runTx((state) => {
            usable(owner)
            return callFn(state, (frame) => storeTx(owner, frame, ctx), f)
          })
        ) as Effect.Effect<any, StoreFailure>
    }
  }

  const refusedOwner = (owner: string, message: string): ModuleStore => {
    const error = new StoreError({ reason: "invalid", message })
    const handle: CollectionHandle<any> = { get: () => Effect.fail(error), list: () => Effect.fail(error), insert: () => Effect.fail(error), update: () => Effect.fail(error), remove: () => Effect.fail(error) }
    return { moduleId: owner, readOnly, collection: () => handle, transaction: () => Effect.fail(error) }
  }

  const moduleStores = new Map<string, ModuleStore>()
  const forModule = (moduleId: string): ModuleStore => {
    let s = moduleStores.get(moduleId)
    if (s === undefined) {
      s = CORE_OWNER.test(moduleId) || !MODULE_ID.test(moduleId) ? refusedOwner(moduleId, `"${moduleId}" is not a module id`) : ownerStore(moduleId)
      moduleStores.set(moduleId, s)
    }
    return s
  }
  const coreStores = new Map<string, ModuleStore>()
  const forCore = (owner: CoreOwner): ModuleStore => {
    let s = coreStores.get(owner)
    if (s === undefined) {
      s = CORE_OWNER.test(owner) ? ownerStore(owner) : refusedOwner(owner, `"${owner}" is not a core owner (core.<name>)`)
      coreStores.set(owner, s)
    }
    return s
  }

  // ---- Host reads

  const reader = <A>(owner: string, c: Collection<A>): CollectionReader<A> | undefined => {
    const st = owners.get(owner)
    const d = st?.collections.get(c.name)
    if (st === undefined || d === undefined || st.verdict !== undefined || (d.c !== c && shapeOf(c) !== d.shape)) return undefined
    const scopeOf = (scope: ScopeRef) => resolveScopeSync(d.c, scope, undefined)
    return {
      get: (id, scope) => doGet(owner, c, id, scope, undefined),
      list: (query) => doList(owner, c, query, undefined),
      page: (scope, after, limit) => {
        resolve(owner, c)
        const s = scopeOf(scope)
        if (hidden(s) || !d.present) return []
        const n = Math.max(1, Math.min(maxListRows(d.c), Math.floor(limit)))
        return guarded(() => backend.page(owner, d.c.name, s, after, n)).map((doc) => rowOf(d.c, doc))
      }
    }
  }

  // ---- Preparing owners

  const prepareOne = (owner: string, kind: "module" | "core", given: ModuleStorage | undefined, duplicate: boolean) =>
    Effect.gen(function*() {
      // A module list cannot name a core owner (module ids have no dot): such an entry is ignored, never judged in
      // place of the core service's data.
      if (kind === "module" && CORE_OWNER.test(owner)) return
      // No storage at all is an empty declaration at version 1: stored data of a newer version is judged the same way.
      const declaresNothing = given === undefined
      const storage: ModuleStorage = given ?? {}
      const declaredVersion = storage.version ?? 1
      const st: OwnerState = { owner, version: Number.isInteger(declaredVersion) ? declaredVersion : 1, collections: new Map(), verdict: undefined }
      owners.set(owner, st)
      const deny = (reason: string) => {
        st.verdict = { reason }
      }
      const okId = kind === "module" ? MODULE_ID.test(owner) && !RESERVED_MODULE_IDS.has(owner) : CORE_OWNER.test(owner)
      if (!okId) return deny("Its id cannot key stored data.")
      if (duplicate) return deny("Another module has the same id, so their stored data cannot be told apart.")
      try {
        checkModuleStorage(owner, storage)
      } catch (e) {
        return deny(`Its storage declaration is not valid: ${messageOf(e)}`)
      }
      for (const c of storage.collections ?? []) st.collections.set(c.name, { c, shape: shapeOf(c), present: false })
      const version = st.version
      let stored: ReadonlyMap<string, StoredCollection>
      let ownerVersion: number | undefined
      try {
        stored = backend.storedCollections(owner)
        ownerVersion = backend.ownerVersion(owner)
      } catch (e) {
        return deny(`Its stored data could not be read: ${messageOf(e)}`)
      }
      const newest = Math.max(ownerVersion ?? 0, ...[...stored.values()].map((s) => s.version))
      if (newest > version) {
        return deny(`Its stored data (version ${newest}) was written by a newer version of this module (this one knows ${version}); update the module. The data is kept as it is.`)
      }
      // A module that declares nothing has nothing to create or upgrade.
      if (declaresNothing) return
      for (const d of st.collections.values()) {
        const s = stored.get(d.c.name)
        if (s === undefined) continue
        if (s.scope !== d.c.scope) {
          return deny(`Its collection ${d.c.name} holds ${s.scope}-scoped rows and is now declared ${d.c.scope}-scoped; a collection keeps its scope (declare a new collection instead). Nothing was changed.`)
        }
        if (s.version === version && s.shape !== d.shape) {
          return deny(`Its collection ${d.c.name} changed its shape (schema or indexes) without a new storage.version (${version}); every change of shape needs a higher version and, where values change, a migration. Nothing was changed.`)
        }
      }
      const behind = [...st.collections.values()].filter((d) => {
        const s = stored.get(d.c.name)
        return s !== undefined && s.version < version
      })
      if (readOnly) {
        if (behind.length > 0 || (ownerVersion !== undefined && ownerVersion < version)) {
          return deny("Its stored data needs an upgrade, which the server makes when it starts (pnpm start serve).")
        }
        for (const d of st.collections.values()) {
          if (!stored.has(d.c.name)) continue
          let ready = false
          try {
            ready = backend.indexesReady(owner, d.c)
          } catch {
            ready = false
          }
          if (!ready) return deny(`The indexes of its collection ${d.c.name} are not ready; the server makes them when it starts (pnpm start serve).`)
          d.present = true
        }
        return
      }
      // Rows are rewritten only where something changes: a new shape, or a migration between the versions.
      const rewrites = behind.filter((d) => {
        const s = stored.get(d.c.name)!
        return s.shape !== d.shape || migratesBetween(d.c, s.version, version)
      })
      let rows = 0
      try {
        for (const d of rewrites) rows += backend.count(owner, d.c.name, MAX_MIGRATION_ROWS)
      } catch (e) {
        return deny(`Its stored data could not be read: ${messageOf(e)}`)
      }
      if (rows > MAX_MIGRATION_ROWS) {
        return deny(`It has more than ${MAX_MIGRATION_ROWS} rows to migrate, more than a version upgrade migrates at start; the data is kept as it is.`)
      }
      let backup: string | undefined
      if (rows > 0 && options.backupBeforeUpgrade !== undefined) {
        const done = yield* Effect.result(options.backupBeforeUpgrade(owner))
        if (done._tag === "Failure") return deny(`Its data needs an upgrade, and the backup before it failed (${done.failure.message}); nothing was changed.`)
        backup = done.success
      }
      const attempt = (n: number): Effect.Effect<void, StoreError> =>
        Effect.suspend(() => {
          try {
            runTx(() => {
              for (const d of rewrites) {
                let after = ""
                let migrated = 0
                for (;;) {
                  const docs = backend.scan(owner, d.c.name, after, 500)
                  const from = stored.get(d.c.name)!.version
                  for (const doc of docs) {
                    const decoded = migrateStored(d.c, from, version, doc.text, doc.id, log)
                    let encoded: ReturnType<typeof encodeValue>
                    try {
                      encoded = encodeValue(d.c, decoded.value)
                    } catch (e) {
                      return fail("failed", `Row ${doc.id} of ${d.c.name}, migrated from version ${from}: ${messageOf(e)}`)
                    }
                    backend.rewrite(doc, encoded.text, encoded.keys)
                    migrated++
                  }
                  if (docs.length < 500) break
                  after = docs[docs.length - 1]!.id
                }
                if (migrated > 0) log(`${owner}: ${migrated} row(s) of ${d.c.name} migrated to version ${version}`)
              }
              for (const d of st.collections.values()) {
                backend.setCollection(owner, d.c.name, { version, scope: d.c.scope, shape: d.shape })
                backend.syncIndexes(owner, d.c)
              }
              backend.setOwnerVersion(owner, version)
            })
            return Effect.void
          } catch (e) {
            if (e instanceof BusyAtBegin) return againAfterBusy(n, e, () => attempt(n + 1))
            const message = messageOf(e)
            const where = backup !== undefined ? ` A backup from before is at ${backup}.` : ""
            log(`${owner}: preparing its data failed: ${message}`)
            deny(`Its data could not be upgraded (${message}); it was left as it was.${where}`)
            return Effect.void
          }
        })
      yield* attempt(0)
      if (st.verdict === undefined) for (const d of st.collections.values()) d.present = true
    })

  /**
   * What a collection's first read would otherwise compile, done while preparing (before serving), so the first list
   * after a start costs what later ones do: its JSON codec (one stored row decoded builds its decoder) and the
   * backend's statements of a `get` and of its default list (newest first). Best effort: a read that fails here fails
   * where it is made.
   */
  const warm = (owner: string, d: Declared) => {
    try {
      const scope = (d.c.scope === "household" ? { kind: "household" } : { kind: d.c.scope, id: "-" }) as ScopeRef
      backend.read(owner, d.c.name, "-")
      backend.list(owner, d.c.name, scope, checkQuery(d.c, { limit: 1 }))
      const [doc] = backend.scan(owner, d.c.name, "", 1)
      if (doc !== undefined) rowOf(d.c, doc)
    } catch {
      // Not warmed: the first read pays for it.
    }
  }

  const prepare = (modules: ReadonlyArray<StoredModule>, core: ReadonlyArray<CoreStorage> = []) =>
    Effect.gen(function*() {
      const counts = new Map<string, number>()
      for (const id of [...modules.map((m) => m.id), ...core.map((c) => c.owner)]) counts.set(id, (counts.get(id) ?? 0) + 1)
      for (const m of modules) yield* prepareOne(m.id, "module", m.storage, (counts.get(m.id) ?? 0) > 1)
      for (const c of core) yield* prepareOne(c.owner, "core", c.storage, (counts.get(c.owner) ?? 0) > 1)
      for (const st of owners.values()) {
        if (st.verdict !== undefined) continue
        for (const d of st.collections.values()) if (d.present) warm(st.owner, d)
      }
      let all: ReturnType<SyncBackend["allCollections"]> = []
      try {
        all = backend.allCollections()
      } catch (e) {
        log(`The household store's collections could not be listed: ${messageOf(e)}`)
      }
      undeclaredData = all
        .filter((x) => owners.get(x.owner)?.collections.has(x.name) !== true)
        .map((x) => ({ owner: x.owner, collection: x.name, version: x.version }))
    })

  // ---- Bulk removal: ended conversations, in bounded steps off the turn's path

  const endConversations = (conversationId: string | undefined): Effect.Effect<number, StoreError> =>
    readOnly
      ? Effect.succeed(0)
      : Effect.suspend(() => {
        const key = conversationId ?? "*"
        // Hidden from now until this removal ends, however it ends (done, failed, interrupted): the release is Effect's
        // finalisation, not a JavaScript `finally` around a yield (which a failed or interrupted fiber never runs).
        return Effect.acquireUseRelease(
          Effect.sync(() => void ending.set(key, (ending.get(key) ?? 0) + 1)),
          () => removeConversationRows(conversationId),
          () =>
            Effect.sync(() => {
              const left = (ending.get(key) ?? 1) - 1
              if (left > 0) ending.set(key, left)
              else ending.delete(key)
            })
        )
      })

  const removeConversationRows = (conversationId: string | undefined): Effect.Effect<number, StoreError> =>
    Effect.gen(function*() {
      let total = 0
      let after: BulkKey | undefined
      const actor: Actor = { kind: "system", name: "conversation-ended" }
      const step = (at: number) =>
        runTx((state) => {
          const rows = backend.conversationRows(conversationId, after, BULK_STEP_ROWS)
          let n = 0
          for (const r of rows) {
            // Only rows of a declared collection of an owner whose data is usable here: an owner that is newer or
            // failed its upgrade, and a collection no declaration names any more, keep their rows as they are.
            const st = owners.get(r.owner)
            if (st === undefined || st.verdict !== undefined || !st.collections.has(r.collection)) continue
            const rev = backend.nextRev()
            if (!backend.remove(r.owner, r.collection, r.id, r.scope, r.rev)) continue
            state.removed = true
            state.out.push({ _tag: "change", change: { seq: rev, at, module: r.owner, collection: r.collection, id: r.id, op: "remove", rev, scope: { ...r.scope }, actor } })
            n++
          }
          return { n, last: rows.at(-1), done: rows.length < BULK_STEP_ROWS }
        })
      for (;;) {
        const at = yield* Clock.currentTimeMillis
        const attempt = (tries: number): Effect.Effect<ReturnType<typeof step>, StoreError> =>
          Effect.suspend(() => {
            try {
              return Effect.succeed(step(at))
            } catch (e) {
              if (e instanceof BusyAtBegin) return againAfterBusy(tries, e, () => attempt(tries + 1))
              return Effect.fail(e instanceof StoreError ? e : new StoreError({ reason: "failed", message: messageOf(e), cause: e }))
            }
          })
        const done = yield* attempt(0)
        total += done.n
        if (done.done || done.last === undefined) break
        after = done.last
        yield* yieldToLoop
      }
      return total
    })

  // ---- The rest

  const hostTransaction = <X>(f: (tx: HostTx) => X): Effect.Effect<X, StoreFailure> =>
    transactionEffect((ctx) =>
      runTx((state) =>
        callFn(state, (frame): HostTx => ({
          forModule: (moduleId) => {
            live(frame, "forModule")
            if (!MODULE_ID.test(moduleId) || CORE_OWNER.test(moduleId)) fail("invalid", `"${moduleId}" is not a module id`)
            usable(moduleId)
            return storeTx(moduleId, frame, ctx)
          },
          forCore: (owner) => {
            live(frame, "forCore")
            if (!CORE_OWNER.test(owner)) fail("invalid", `"${owner}" is not a core owner (core.<name>)`)
            usable(owner)
            return storeTx(owner, frame, ctx)
          },
          afterCommit: (g) => void live(frame, "afterCommit").out.push({ _tag: "run", run: g }),
          onRollback: (g) => void live(frame, "onRollback").undo.push(g)
        }), f)
      )
    )

  return {
    prepare,
    availability: (owner) => owners.get(owner)?.verdict,
    undeclared: () => undeclaredData,
    forModule,
    forCore,
    transaction: hostTransaction as HouseholdStore["transaction"],
    afterCommit: (f) =>
      Effect.sync(() => {
        if (active !== undefined) active.out.push({ _tag: "run", run: f })
        else release([{ _tag: "run", run: f }])
      }),
    publish: (event) => {
      const item: Released = { _tag: "event", event }
      if (active !== undefined) active.out.push(item)
      else release([item])
    },
    reader,
    // A backend failure is a StoreError, as for every other read.
    lastSeq: Effect.suspend(() => {
      try {
        return Effect.succeed(guarded(() => backend.lastRev()))
      } catch (e) {
        return e instanceof StoreError ? Effect.fail(e) : Effect.die(e)
      }
    }),
    endConversation: (conversationId) => endConversations(conversationId),
    sweepConversations: endConversations(undefined),
    onCommit: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    inTransaction: () => active !== undefined
  }
}
