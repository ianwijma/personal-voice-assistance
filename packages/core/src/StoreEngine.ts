import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Effect, Exit, Schema } from "effect"
import {
  type Actor,
  actorOfTurn,
  type Collection,
  type CollectionHandle,
  type CollectionReader,
  type CommittedChange,
  type CoreTx,
  DEFAULT_LIST_LIMIT,
  type HostTx,
  type HouseholdStore,
  isIndexable,
  isStoreFailure,
  type ListQuery,
  MAX_LIST_LIMIT,
  MAX_MIGRATION_ROWS,
  MAX_VALUE_CHARS,
  type ModuleEventRecord,
  type ModuleStore,
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
  type WhereValue
} from "./HouseholdStore.ts"
import { CurrentTurn, type TurnContext } from "./TurnContext.ts"

/**
 * The engine both household stores run (docs/STORING-DATA.md): the semantics of collections, the transaction model,
 * `prepare` and the release of events, written once over a small **synchronous** backend (`SyncBackend`): SQLite's
 * `DatabaseSync` in `@pva/store-sqlite`, maps with an undo list in the in-memory double. Internal to `@pva/core` and
 * `@pva/store-sqlite` (`@pva/core/store-backend`).
 *
 * The transaction model is one rule: **a transaction is one synchronous step.** `runTx` begins, runs the function
 * (which has no awaits), and commits, or rolls back when the function throws, without ever yielding. Nothing else (no
 * other fiber, no timer, no socket) runs in between, so there is nothing to lock, nest or interrupt, and SQLite's own
 * transaction state cannot disagree with ours: after every step that could end it (a failed statement), the engine
 * asks the backend whether its transaction is still open, and a transaction SQLite ended itself (`SQLITE_FULL`) is
 * refused from then on and fails. A `runTx` called while one runs (only possible from inside its function) joins it.
 * The events of a transaction (its data changes, its module events, its `afterCommit` callbacks) are kept in a list on
 * it and released after the commit, in the order they were made; a transaction that throws releases nothing and runs
 * its `onRollback` hooks, newest first.
 */

/** A row as a backend keeps it: the value as JSON text at the collection version `v`, the actor as JSON text. */
export interface StoredDoc {
  readonly module: string
  readonly collection: string
  readonly id: string
  readonly scope: ScopeRef
  readonly rev: number
  readonly v: number
  readonly text: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly updatedBy: string
}

/** A list query as one index range read: its filter (at most one field) and its order. */
export interface CheckedQuery {
  readonly limit: number
  readonly where: readonly [field: string, value: WhereValue] | undefined
  /** A JSON field, or the `createdAt` / `updatedAt` column. */
  readonly order: { readonly field: string; readonly column: boolean; readonly desc: boolean }
}

/**
 * The backend's primitives: all synchronous, all throwing on failure. The engine calls the writing ones only between
 * `begin` and `commit` / `rollback`.
 */
export interface SyncBackend {
  readonly readOnly: boolean
  readonly begin: () => void
  readonly commit: () => void
  readonly rollback: () => void
  /** Whether the backend's transaction is still open (SQLite ends one itself on some errors). */
  readonly inTransaction: () => boolean
  /** The row with this id in the collection, whatever its scope. */
  readonly read: (module: string, collection: string, id: string) => StoredDoc | undefined
  /** One index range read (`CheckedQuery`), in the order `compareIndexed` defines. */
  readonly list: (module: string, collection: string, scope: ScopeRef, query: CheckedQuery) => ReadonlyArray<StoredDoc>
  /** Rows of one scope, newest first (`updatedAt`, then id, descending), after `after`. */
  readonly page: (module: string, collection: string, scope: ScopeRef, after: { readonly updatedAt: number; readonly id: string } | undefined, limit: number) => ReadonlyArray<StoredDoc>
  /** Insert (`"absent"`) or replace the row at rev `expect` in its scope; `false` when that did not hold. */
  readonly put: (doc: StoredDoc, expect: "absent" | number) => boolean
  /** Delete the row at rev `expect` in `scope`; `false` when it was not there so. */
  readonly remove: (module: string, collection: string, id: string, scope: ScopeRef, expect: number) => boolean
  /** The next number of the store's one counter (rolled back with the transaction). */
  readonly nextRev: () => number
  readonly lastRev: () => number
  /** Rows of a collection after `afterId` in id order. */
  readonly scan: (module: string, collection: string, afterId: string, limit: number) => ReadonlyArray<StoredDoc>
  /** How many rows a collection has, counting at most `cap + 1`. */
  readonly count: (module: string, collection: string, cap: number) => number
  /** Store a migrated value of a row (same rev). */
  readonly rewrite: (doc: StoredDoc, v: number, text: string) => void
  /** Rows of one conversation (`undefined`: every conversation). */
  readonly conversationDocs: (conversationId: string | undefined) => ReadonlyArray<StoredDoc>
  /** Stored versions of an owner (`module:<id>`: `collection:<name>` → version). */
  readonly versions: (owner: string) => ReadonlyMap<string, number>
  readonly setVersion: (owner: string, name: string, version: number) => void
  /** Make the collection indexes of a module exactly the declared ones. */
  readonly syncIndexes: (moduleId: string, collections: ReadonlyArray<Collection<any>>) => void
  /** A core service's statements (inside the running transaction, or alone). */
  readonly core: (owner: string) => CoreTx
  /** After a commit that removed rows: make their content unreadable in the files too (SQLite: a checkpoint). */
  readonly removed: () => void
}

const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/
/** Statements that begin or end a transaction (refused in core SQL, which always runs in the store's). */
export const TX_CONTROL = /^[\s;]*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i
/** Module ids the store refuses: `host` is the host's event namespace (`host.*`). */
export const RESERVED_MODULE_IDS: ReadonlySet<string> = new Set(["host"])

const newId = () => globalThis.crypto.randomUUID()

const fail = (reason: StoreError["reason"], message: string, cause?: unknown): never => {
  throw new StoreError({ reason, message, ...(cause !== undefined ? { cause } : {}) })
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

/**
 * A value as it is stored: encoded with the schema's JSON codec, which must give an object; at most
 * `MAX_VALUE_CHARS` of JSON; indexed fields `isIndexable` or missing; decoded again from the text, so the value
 * returned is what a read gives back (and never the caller's object).
 */
export const encodeValue = <A>(collection: Collection<A>, value: A): { readonly text: string; readonly value: A } => {
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
  if (text.length > MAX_VALUE_CHARS) return fail("invalid", `Collection ${collection.name}: a value may hold at most ${MAX_VALUE_CHARS} characters of JSON`)
  const parsed = JSON.parse(text) as Record<string, unknown>
  for (const field of collection.indexes) {
    if (Object.hasOwn(parsed, field) && !isIndexable(parsed[field])) {
      return fail("invalid", `Collection ${collection.name}: the indexed field "${field}" must be a string (well-formed, without NUL, at most 500 characters), a finite number or true/false`)
    }
  }
  const decoded = Schema.decodeUnknownExit(codec)(parsed)
  if (Exit.isFailure(decoded)) return fail("invalid", `Collection ${collection.name}: the value does not survive storing: ${String(decoded.cause).slice(0, 500)}`)
  return { text, value: decoded.value }
}

/**
 * A stored value (JSON text, written at version `v`) as the collection's type now: migrated forward one version at a
 * time (a value of a lower version is only read here in the CLI modes, before the server migrated it), then decoded.
 * A newer value is refused.
 */
export const decodeStored = <A>(collection: Collection<A>, v: number, text: string, id: string): { readonly value: A; readonly json: unknown } => {
  if (v > collection.version) return fail("unavailable", `Row ${id} of ${collection.name} was written by a newer version of its module (${v} > ${collection.version})`)
  let current: unknown
  try {
    current = JSON.parse(text)
  } catch (cause) {
    return fail("failed", `Row ${id} of ${collection.name} is not JSON`, cause)
  }
  for (let at = v; at < collection.version; at++) {
    try {
      current = collection.migrate[at]!(current)
    } catch (cause) {
      return fail("failed", `Collection ${collection.name}: migrating row ${id} from version ${at} failed`, cause)
    }
  }
  const decoded = Schema.decodeUnknownExit(jsonOf(collection))(current)
  if (Exit.isFailure(decoded)) return fail("failed", `Row ${id} of ${collection.name} does not match its schema: ${String(decoded.cause).slice(0, 500)}`)
  return { value: decoded.value, json: current }
}

/** Check a list query against the collection's indexes and the shapes one index can answer (`ListQuery`). */
export const checkQuery = (collection: Collection<any>, query: ListQuery<any> | undefined): CheckedQuery => {
  const invalid = (message: string) => fail("invalid", `Collection ${collection.name}: ${message}`)
  const entries = Object.entries(query?.where ?? {}).filter(([, v]) => v !== undefined)
  if (entries.length > 1) return invalid(`list filters on one indexed field at a time (it was given ${entries.map(([f]) => f).join(", ")}); store a combined field and index it`)
  for (const [field, value] of entries) {
    if (!collection.indexes.includes(field)) return invalid(`"${field}" is not a declared index (indexes: ${collection.indexes.join(", ") || "none"})`)
    if (!isIndexable(value)) return invalid(`the filter on "${field}" must be a string (well-formed, without NUL, at most 500 characters), a finite number or true/false`)
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
  return { limit, where, order: { field, column, desc: direction === "desc" } }
}

/** A row id a caller chose: `SAFE_ID`. */
const checkRowId = (collection: string, id: string) => {
  if (typeof id !== "string" || !SAFE_ID.test(id)) fail("invalid", `Collection ${collection}: "${String(id).slice(0, 40)}" is not a valid row id (1–200 letters, digits, _ . : -)`)
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

// ---- The engine

interface TxState {
  /** What to release after the commit, in order. */
  readonly out: Array<Released | { readonly _tag: "run"; readonly run: () => void }>
  readonly undo: Array<() => void>
  removed: boolean
}

/** The context of one call: whose turn, the actor by default, the time. */
interface CallContext {
  readonly turn: TurnContext | undefined
  readonly at: number
}

export interface EngineOptions {
  readonly backend: SyncBackend
  /** A backup before the first migration of this start (SQLite; not for a new or in-memory file). */
  readonly backupBeforeUpgrade?: (what: string) => Effect.Effect<string | undefined, StoreError>
  readonly log?: (line: string) => void
}

/** What both stores share of `HouseholdStore`; each adds `info`, `core` and `backup`. */
export type EngineStore = Omit<HouseholdStore, "info" | "core" | "backup"> & {
  /** Run `f` as one transaction (internal: the stores' `core().migrate`). Throws its failure. */
  readonly runTx: <X>(f: () => X) => X
  /** Whether a transaction is running now. */
  readonly inTransaction: () => boolean
}

export const makeStoreEngine = (options: EngineOptions): EngineStore => {
  const { backend } = options
  const readOnly = backend.readOnly
  const log = options.log ?? (() => {})

  const verdicts = new Map<string, ModuleUnavailable>()
  const declared = new Map<string, ReadonlyMap<string, Collection<any>>>()
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
          try {
            item.run()
          } catch {
            // An after-commit callback must not break the others.
          }
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
      try {
        undo[i]!()
      } catch {
        // An undo hook must not stop the others.
      }
    }
  }

  const lost = () => new StoreError({ reason: "failed", message: "The database ended the household transaction itself (for example, the disk is full); nothing of it was kept" })

  /** Check, after a backend call failed inside a transaction, that the backend's transaction is still open. */
  const guarded = <X>(f: () => X): X => {
    try {
      return f()
    } catch (e) {
      if (active !== undefined && !backend.inTransaction()) throw lost()
      throw isStoreFailure(e) ? e : new StoreError({ reason: "failed", message: `The household store failed: ${e instanceof Error ? e.message : String(e)}`, cause: e })
    }
  }

  const runTx = <X>(f: () => X): X => {
    if (active !== undefined) {
      if (!backend.inTransaction()) throw lost()
      return f()
    }
    const state: TxState = { out: [], undo: [], removed: false }
    guarded(() => backend.begin())
    active = state
    let result: X
    try {
      result = f()
      if (!backend.inTransaction()) throw lost()
      backend.commit()
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

  /** The transaction's effect: the turn and the time are read first, then `f` runs as one step. */
  const transactionEffect = <X>(f: (ctx: CallContext) => X): Effect.Effect<X, StoreFailure> =>
    Effect.flatMap(Effect.all([Effect.service(CurrentTurn), Clock.currentTimeMillis]), ([turn, at]) =>
      Effect.suspend(() => {
        try {
          return Effect.succeed(runTx(() => f({ turn, at })))
        } catch (e) {
          return isStoreFailure(e) ? Effect.fail(e) : Effect.die(e)
        }
      }))

  /** A read outside any transaction (or inside the running one): one synchronous step too. */
  const readEffect = <X>(f: (ctx: CallContext) => X): Effect.Effect<X, StoreError | ScopeUnknown> =>
    Effect.flatMap(Effect.all([Effect.service(CurrentTurn), Clock.currentTimeMillis]), ([turn, at]) =>
      Effect.suspend(() => {
        try {
          return Effect.succeed(f({ turn, at }))
        } catch (e) {
          return e instanceof StoreError || e instanceof ScopeUnknown ? Effect.fail(e) : Effect.die(e)
        }
      }))

  const inTx = (what: string): TxState => {
    if (active === undefined) return fail("failed", `${what}: the transaction has already ended (its handle was kept after its function returned)`)
    return active
  }

  // ---- Collections

  const usable = (moduleId: string) => {
    const verdict = verdicts.get(moduleId)
    if (verdict !== undefined) fail("unavailable", `Module ${moduleId}'s data is not usable here: ${verdict.reason}`)
  }

  const isDeclared = (moduleId: string, c: Collection<any>) => {
    const d = declared.get(moduleId)?.get(c.name)
    return d !== undefined && (d === c || (d.schema === c.schema && d.version === c.version))
  }

  const rowOf = <A>(c: Collection<A>, doc: StoredDoc): Row<A> => {
    const decoded = decodeStored(c, doc.v, doc.text, doc.id)
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

  const actorText = (moduleId: string, given: Actor | undefined, turn: TurnContext | undefined): string => {
    const actor: Actor = given ?? (turn === undefined ? { kind: "module", moduleId } : actorOfTurn(turn))
    let text: string | undefined
    try {
      text = JSON.stringify(actor)
    } catch {
      text = undefined
    }
    if (text === undefined || text.length > 2000) return fail("invalid", "The actor must be plain JSON of at most 2,000 characters")
    return text
  }

  /** The synchronous operations of one collection for one call context. */
  const txCollection = <A>(moduleId: string, c: Collection<A>, ctx: () => CallContext): TxCollection<A> => {
    const check = () => {
      if (!isDeclared(moduleId, c)) fail("invalid", `Module ${moduleId}: collection "${c.name}" is not declared in its storage.collections`)
      usable(moduleId)
    }
    const writable = (what: string) => {
      check()
      if (readOnly) throw readOnlyError(what)
    }
    const conflict = (id: string, message: string) => new StoreConflict({ collection: c.name, id, message })
    const announce = (change: CommittedChange) => inTx("A write").out.push({ _tag: "change", change })

    return {
      get: (id, opts) => {
        check()
        const scope = resolveScopeSync(c, opts?.scope, ctx().turn)
        if (typeof id !== "string" || !SAFE_ID.test(id)) return undefined
        const doc = guarded(() => backend.read(moduleId, c.name, id))
        return doc === undefined || !sameScope(doc.scope, scope) ? undefined : rowOf(c, doc)
      },
      list: (query) => {
        check()
        const checked = checkQuery(c, query)
        const scope = resolveScopeSync(c, query?.scope, ctx().turn)
        return guarded(() => backend.list(moduleId, c.name, scope, checked)).map((d) => rowOf(c, d))
      },
      insert: (value, opts) =>
        runTx(() => {
          writable("insert")
          const { turn, at } = ctx()
          const scope = resolveScopeSync(c, opts?.scope, turn)
          const id = opts?.id ?? newId()
          checkRowId(c.name, id)
          const encoded = encodeValue(c, value)
          const updatedBy = actorText(moduleId, opts?.actor, turn)
          if (guarded(() => backend.read(moduleId, c.name, id)) !== undefined) throw conflict(id, `A row ${id} already exists in ${c.name}`)
          const rev = guarded(() => backend.nextRev())
          const doc: StoredDoc = { module: moduleId, collection: c.name, id, scope, rev, v: c.version, text: encoded.text, createdAt: at, updatedAt: at, updatedBy }
          if (!guarded(() => backend.put(doc, "absent"))) throw conflict(id, `A row ${id} already exists in ${c.name}`)
          const row = rowOf(c, doc)
          announce({ seq: rev, at, module: moduleId, collection: c.name, id, op: "insert", rev, scope: { ...scope }, actor: JSON.parse(updatedBy) as Actor, row })
          return rowOf(c, doc)
        }),
      update: (id, f, opts) =>
        runTx(() => {
          writable("update")
          const { turn, at } = ctx()
          const scope = resolveScopeSync(c, opts?.scope, turn)
          const doc = typeof id === "string" && SAFE_ID.test(id) ? guarded(() => backend.read(moduleId, c.name, id)) : undefined
          if (doc === undefined || !sameScope(doc.scope, scope)) throw new StoreNotFound({ collection: c.name, id: String(id) })
          if (opts?.expectRev !== undefined && doc.rev !== opts.expectRev) throw conflict(id, `Row ${id} of ${c.name} is at rev ${doc.rev}, not ${opts.expectRev}`)
          // The function gets a value of its own: what it does to it never reaches the row it replaces.
          const before = rowOf(c, doc)
          let next: A
          try {
            next = f(rowOf(c, doc).value)
          } catch (cause) {
            if (isStoreFailure(cause)) throw cause
            return fail("failed", `Collection ${c.name}: the update function failed: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
          }
          const encoded = encodeValue(c, next)
          const updatedBy = actorText(moduleId, opts?.actor, turn)
          const rev = guarded(() => backend.nextRev())
          const written: StoredDoc = { ...doc, rev, v: c.version, text: encoded.text, updatedAt: at, updatedBy }
          if (!guarded(() => backend.put(written, doc.rev))) throw conflict(id, `Row ${id} of ${c.name} changed meanwhile`)
          announce({ seq: rev, at, module: moduleId, collection: c.name, id, op: "update", rev, scope: { ...doc.scope }, actor: JSON.parse(updatedBy) as Actor, row: rowOf(c, written), before })
          return rowOf(c, written)
        }),
      remove: (id, opts) =>
        runTx(() => {
          writable("remove")
          const { turn, at } = ctx()
          const scope = resolveScopeSync(c, opts?.scope, turn)
          const doc = typeof id === "string" && SAFE_ID.test(id) ? guarded(() => backend.read(moduleId, c.name, id)) : undefined
          if (doc === undefined || !sameScope(doc.scope, scope)) return false
          if (opts?.expectRev !== undefined && doc.rev !== opts.expectRev) throw conflict(id, `Row ${id} of ${c.name} is at rev ${doc.rev}, not ${opts.expectRev}`)
          const updatedBy = actorText(moduleId, opts?.actor, turn)
          let before: Row<A> | undefined
          try {
            before = rowOf(c, doc)
          } catch {
            before = undefined
          }
          const rev = guarded(() => backend.nextRev())
          if (!guarded(() => backend.remove(moduleId, c.name, id, doc.scope, doc.rev))) throw conflict(id, `Row ${id} of ${c.name} changed meanwhile`)
          inTx("A removal").removed = true
          announce({ seq: rev, at, module: moduleId, collection: c.name, id, op: "remove", rev, scope: { ...doc.scope }, actor: JSON.parse(updatedBy) as Actor, ...(before !== undefined ? { before } : {}) })
          return true
        })
    }
  }

  const coreTx = (owner: string): CoreTx => {
    const inner = backend.core(owner)
    /** Trusted code still may not end the transaction it runs in. */
    const statement = <X>(sql: string, f: () => X): X => {
      if (TX_CONTROL.test(sql)) fail("invalid", `Core ${owner}: a statement may not begin or end a transaction; it runs in the store's`)
      const result = guarded(f)
      if (!backend.inTransaction()) throw lost()
      return result
    }
    return {
      prefix: inner.prefix,
      query: (sql, params) => statement(sql, () => inner.query(sql, params)),
      run: (sql, params) => {
        if (readOnly) throw readOnlyError(`core ${owner}`)
        inTx(`Core ${owner}`)
        return statement(sql, () => inner.run(sql, params))
      }
    }
  }

  const publishIn = (state: TxState, moduleId: string, ctx: CallContext, type: string, data: unknown, scope: ScopeRef | undefined) => {
    if (typeof type !== "string" || type.length > 80 || !EVENT_TYPE.test(type)) fail("invalid", `Module ${moduleId}: event type "${String(type).slice(0, 80)}" is not lower-case words separated by dots`)
    const event: ModuleEventRecord = {
      at: ctx.at,
      module: moduleId,
      type: `${moduleId}.${type}`,
      scope: eventScope(scope),
      actor: ctx.turn === undefined ? { kind: "module", moduleId } : actorOfTurn(ctx.turn),
      data
    }
    state.out.push({ _tag: "event", event })
  }

  /** The handle of the running transaction for one module and one call context. */
  const storeTx = (moduleId: string, ctx: CallContext): StoreTx => {
    // Keyed by the declaration itself: another declaration of the same name (an older version) is a handle of its own.
    const handles = new WeakMap<Collection<any>, TxCollection<any>>()
    return {
      collection: <A>(c: Collection<A>) => {
        let h = handles.get(c)
        if (h === undefined) {
          const ops = txCollection(moduleId, c, () => ctx)
          // Inside the transaction only: a handle kept after it ended is refused.
          h = {
            get: (id, o) => (inTx("A read"), ops.get(id, o)),
            list: (q) => (inTx("A read"), ops.list(q)),
            insert: (v, o) => (inTx("A write"), ops.insert(v, o)),
            update: (id, f, o) => (inTx("A write"), ops.update(id, f, o)),
            remove: (id, o) => (inTx("A write"), ops.remove(id, o))
          } satisfies TxCollection<A>
          handles.set(c, h)
        }
        return h as TxCollection<A>
      },
      publish: (type, data, scope) => {
        usable(moduleId)
        publishIn(inTx("An event"), moduleId, ctx, type, data, scope)
      },
      core: (owner) => (inTx("Core SQL"), coreTx(owner)),
      afterCommit: (f) => void inTx("afterCommit").out.push({ _tag: "run", run: f }),
      onRollback: (f) => void inTx("onRollback").undo.push(f)
    }
  }

  const stores = new Map<string, ModuleStore>()
  const forModule = (moduleId: string): ModuleStore => {
    let s = stores.get(moduleId)
    if (s !== undefined) return s
    const handles = new WeakMap<Collection<any>, CollectionHandle<any>>()
    s = {
      moduleId,
      readOnly,
      collection: <A>(c: Collection<A>) => {
        let h = handles.get(c)
        if (h === undefined) {
          const handle: CollectionHandle<A> = {
            get: (id, o) => readEffect((ctx) => txCollection(moduleId, c, () => ctx).get(id, o)),
            list: (q) => readEffect((ctx) => txCollection(moduleId, c, () => ctx).list(q)),
            insert: (v, o) => transactionEffect((ctx) => txCollection(moduleId, c, () => ctx).insert(v, o)) as Effect.Effect<Row<A>, StoreError | StoreConflict | ScopeUnknown>,
            update: (id, f, o) => transactionEffect((ctx) => txCollection(moduleId, c, () => ctx).update(id, f, o)),
            remove: (id, o) => transactionEffect((ctx) => txCollection(moduleId, c, () => ctx).remove(id, o)) as Effect.Effect<boolean, StoreError | StoreConflict | ScopeUnknown>
          }
          h = handle
          handles.set(c, h)
        }
        return h as CollectionHandle<A>
      },
      transaction: (f) =>
        transactionEffect((ctx) => {
          usable(moduleId)
          return f(storeTx(moduleId, ctx))
        })
    }
    stores.set(moduleId, s)
    return s
  }

  // ---- Host reads

  const reader = <A>(moduleId: string, c: Collection<A>): CollectionReader<A> | undefined => {
    if (verdicts.has(moduleId) || !isDeclared(moduleId, c)) return undefined
    const scopeOf = (scope: ScopeRef) => resolveScopeSync(c, scope, undefined)
    return {
      get: (id, scope) => {
        usable(moduleId)
        const s = scopeOf(scope)
        if (typeof id !== "string" || !SAFE_ID.test(id)) return undefined
        const doc = guarded(() => backend.read(moduleId, c.name, id))
        return doc === undefined || !sameScope(doc.scope, s) ? undefined : rowOf(c, doc)
      },
      list: (query) => {
        usable(moduleId)
        const checked = checkQuery(c, query)
        return guarded(() => backend.list(moduleId, c.name, scopeOf(query.scope), checked)).map((d) => rowOf(c, d))
      },
      page: (scope, after, limit) => {
        usable(moduleId)
        const n = Math.max(1, Math.min(100, Math.floor(limit)))
        return guarded(() => backend.page(moduleId, c.name, scopeOf(scope), after, n)).map((d) => rowOf(c, d))
      }
    }
  }

  // ---- Preparing modules

  const prepareOne = (m: StoredModule, duplicate: boolean) =>
    Effect.gen(function*() {
      const collections = new Map((m.storage?.collections ?? []).map((c) => [c.name, c]))
      declared.set(m.id, collections)
      verdicts.delete(m.id)
      if (!MODULE_ID.test(m.id) || RESERVED_MODULE_IDS.has(m.id)) return void verdicts.set(m.id, { reason: "Its id cannot key stored data." })
      if (duplicate) return void verdicts.set(m.id, { reason: "Another module has the same id, so their stored data cannot be told apart." })
      if (collections.size === 0) return
      const owner = `module:${m.id}`
      const stored = backend.versions(owner)
      const newer = [...collections.values()].find((c) => (stored.get(`collection:${c.name}`) ?? 0) > c.version)
      if (newer !== undefined) {
        return void verdicts.set(m.id, {
          reason: `Its stored data (${newer.name}, version ${stored.get(`collection:${newer.name}`)}) was written by a newer version of this module (this one knows ${newer.version}); update the module. The data is kept as it is.`
        })
      }
      const pendingCollections = [...collections.values()].filter((c) => (stored.get(`collection:${c.name}`) ?? 0) < c.version)
      // Rows to rewrite: a collection whose stored version is older and that has rows.
      const rewrites = pendingCollections.filter((c) => stored.has(`collection:${c.name}`) && backend.count(m.id, c.name, 0) > 0)
      if (readOnly) {
        if (rewrites.length > 0) verdicts.set(m.id, { reason: "Its stored data needs an upgrade, which the server makes when it starts (pnpm start serve)." })
        return
      }
      const big = rewrites.find((c) => backend.count(m.id, c.name, MAX_MIGRATION_ROWS) > MAX_MIGRATION_ROWS)
      if (big !== undefined) {
        return void verdicts.set(m.id, {
          reason: `Its collection ${big.name} has more than ${MAX_MIGRATION_ROWS} rows, more than a version upgrade migrates at start; the data is kept as it is.`
        })
      }
      let backup: string | undefined
      if (rewrites.length > 0 && options.backupBeforeUpgrade !== undefined) {
        const done = yield* Effect.result(options.backupBeforeUpgrade(m.id))
        if (done._tag === "Failure") {
          return void verdicts.set(m.id, { reason: `Its data needs an upgrade, and the backup before it failed (${done.failure.message}); nothing was changed.` })
        }
        backup = done.success
      }
      try {
        runTx(() => {
          for (const c of pendingCollections) {
            let after = ""
            let n = 0
            for (;;) {
              const docs = backend.scan(m.id, c.name, after, 500)
              for (const doc of docs) {
                if (doc.v === c.version) continue
                const decoded = decodeStored(c, doc.v, doc.text, doc.id)
                let encoded: { readonly text: string }
                try {
                  encoded = encodeValue(c, decoded.value)
                } catch (e) {
                  return fail("failed", `Row ${doc.id} of ${c.name}, migrated from version ${doc.v}: ${e instanceof Error ? e.message : String(e)}`)
                }
                backend.rewrite(doc, c.version, encoded.text)
                n++
              }
              if (docs.length < 500) break
              after = docs[docs.length - 1]!.id
            }
            if (n > 0) log(`Module ${m.id}: ${n} row(s) of ${c.name} migrated to version ${c.version}`)
            backend.setVersion(owner, `collection:${c.name}`, c.version)
          }
          backend.syncIndexes(m.id, [...collections.values()])
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const where = backup !== undefined ? ` A backup from before is at ${backup}.` : ""
        log(`Module ${m.id}: upgrading its data failed: ${message}`)
        verdicts.set(m.id, { reason: `Its data could not be upgraded (${message}); it was left as it was.${where}` })
      }
    })

  const prepare = (modules: ReadonlyArray<StoredModule>) =>
    Effect.gen(function*() {
      const counts = new Map<string, number>()
      for (const m of modules) counts.set(m.id, (counts.get(m.id) ?? 0) + 1)
      for (const m of modules) yield* prepareOne(m, (counts.get(m.id) ?? 0) > 1)
    })

  // ---- Conversations

  const endConversations = (conversationId: string | undefined): Effect.Effect<number, StoreError> =>
    readOnly
      ? Effect.succeed(0)
      : Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.suspend(() => {
          try {
            return Effect.succeed(runTx(() => {
              // A module whose data is newer (or failed to upgrade) keeps its rows as they are, conversation rows too.
              const docs = backend.conversationDocs(conversationId).filter((d) => !verdicts.has(d.module))
              const actor: Actor = { kind: "system", name: "conversation-ended" }
              const state = inTx("endConversation")
              let n = 0
              for (const doc of docs) {
                const rev = backend.nextRev()
                if (!backend.remove(doc.module, doc.collection, doc.id, doc.scope, doc.rev)) continue
                state.removed = true
                state.out.push({ _tag: "change", change: { seq: rev, at, module: doc.module, collection: doc.collection, id: doc.id, op: "remove", rev, scope: { ...doc.scope }, actor } })
                n++
              }
              return n
            }))
          } catch (e) {
            return e instanceof StoreError ? Effect.fail(e) : Effect.fail(new StoreError({ reason: "failed", message: String(e), cause: e }))
          }
        }))

  // ---- The rest

  const hostTransaction = <X>(f: (tx: HostTx) => X): Effect.Effect<X, StoreFailure> =>
    transactionEffect((ctx) =>
      f({
        forModule: (moduleId) => {
          usable(moduleId)
          return storeTx(moduleId, ctx)
        },
        core: (owner) => (inTx("Core SQL"), coreTx(owner)),
        afterCommit: (g) => void inTx("afterCommit").out.push({ _tag: "run", run: g }),
        onRollback: (g) => void inTx("onRollback").undo.push(g)
      })
    )

  return {
    prepare,
    availability: (moduleId) => verdicts.get(moduleId),
    forModule,
    transaction: hostTransaction,
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
    lastSeq: Effect.sync(() => backend.lastRev()),
    endConversation: (conversationId) => endConversations(conversationId),
    sweepConversations: endConversations(undefined),
    onCommit: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    runTx,
    inTransaction: () => active !== undefined
  }
}
