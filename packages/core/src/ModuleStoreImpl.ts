import { Clock, Effect } from "effect"
import {
  type Actor,
  actorKey,
  type ChangeOp,
  type ChangeRecord,
  checkQuery,
  checkRowId,
  type Collection,
  type CollectionHandle,
  type CommittedChange,
  currentActor,
  decodeStored,
  encodeValue,
  type ListQuery,
  type ModuleSql,
  type ModuleStore,
  readOnlyError,
  resolveScope,
  type Row,
  type ScopeRef,
  ScopeUnknown,
  searchTextOf,
  searchWords,
  StoreConflict,
  StoreError,
  StoreNotFound,
  type UndoResult,
  type WhereValue
} from "./HouseholdStore.ts"

/**
 * The semantics of `ctx.store` collections, written once over a small backend (`StoreBackend`), so the SQLite store
 * and the in-memory double behave the same: scope resolution, validation, lazy migration, optimistic updates, the
 * change log, undo and erase. Internal to `@pva/core` and `@pva/store-sqlite`.
 */

/** A row as a backend keeps it: the value as JSON text, at the collection version `v`. */
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
  readonly updatedBy: Actor
}

export interface BackendListQuery {
  readonly where: ReadonlyArray<readonly [field: string, value: WhereValue]>
  /** A JSON field, or the `createdAt` / `updatedAt` column. */
  readonly order: { readonly field: string; readonly column: boolean; readonly desc: boolean }
  readonly limit: number
}

/** A change to append (the backend gives it its number). */
export type NewChange = Omit<ChangeRecord, "seq" | "undone"> & { readonly actorKey: string }

export interface StoreBackend {
  readonly readOnly: boolean
  readonly fts5: boolean
  /** One transaction; nested calls are savepoints. Writes outside one are wrapped by the callers below. */
  readonly transaction: <X, E, R>(work: Effect.Effect<X, E, R>) => Effect.Effect<X, E | StoreError, R>
  /** Inside a transaction: hand `change` to the commit listeners after the outermost commit (never on a rollback). */
  readonly afterCommit: (change: CommittedChange) => Effect.Effect<void>
  readonly read: (module: string, collection: string, id: string) => Effect.Effect<StoredDoc | undefined, StoreError>
  readonly list: (module: string, collection: string, scope: ScopeRef, query: BackendListQuery) => Effect.Effect<ReadonlyArray<StoredDoc>, StoreError>
  /** Rows whose search text has every word, best first (FTS5), or among the newest `SEARCH_SCAN_ROWS` (fallback). */
  readonly search: (module: string, collection: string, scope: ScopeRef, words: ReadonlyArray<string>, limit: number) => Effect.Effect<ReadonlyArray<StoredDoc>, StoreError>
  /** Insert (`expect: "absent"`) or replace the row at rev `expect`; `false` when that did not hold. Sets its search text. */
  readonly put: (doc: StoredDoc, expect: "absent" | number, search: string) => Effect.Effect<boolean, StoreError>
  /** Delete the row at rev `expect` (and its search entry); `false` when it was not there at that rev. */
  readonly delete: (module: string, collection: string, id: string, expect: number) => Effect.Effect<boolean, StoreError>
  /** Rewrite a row migrated on read (no new rev, no change-log row). Best effort. */
  readonly rewrite: (doc: StoredDoc, v: number, text: string) => Effect.Effect<void>
  readonly append: (change: NewChange) => Effect.Effect<number, StoreError>
  /** The newest change of `actorKey` in the collection that is not undone and not itself an undo. */
  readonly lastUndoable: (module: string, collection: string, actorKey: string) => Effect.Effect<ChangeRecord | undefined, StoreError>
  readonly markUndone: (seq: number) => Effect.Effect<void, StoreError>
  /** Whether the row has a change after `seq` that is not undone and not itself an undo (someone changed it since). */
  readonly changedSince: (module: string, collection: string, id: string, seq: number) => Effect.Effect<boolean, StoreError>
  /** Drop every payload of the row from the change log and its search entries. */
  readonly purge: (module: string, collection: string, id: string) => Effect.Effect<void, StoreError>
  /** After an erase committed: make sure the old content is gone from the files too (SQLite: a WAL checkpoint). */
  readonly afterErase: Effect.Effect<void>
}

const MAX_ATTEMPTS = 3

const newId = () => globalThis.crypto.randomUUID()

/** `ctx.store` of one module over a backend. `collections`: what the module declared. */
export const makeModuleStoreOn = (
  backend: StoreBackend,
  moduleId: string,
  collections: ReadonlyMap<string, Collection<any>>,
  sql: ModuleSql
): ModuleStore => {
  const handles = new Map<string, CollectionHandle<any>>()

  const logChange = (
    collection: string,
    op: ChangeOp,
    meta: { readonly id: string; readonly rev: number; readonly scope: ScopeRef; readonly actor: Actor; readonly at: number },
    payload: ChangeRecord["payload"],
    rows: { readonly row?: Row<unknown>; readonly before?: Row<unknown> },
    undoes?: string
  ) =>
    Effect.gen(function*() {
      const opId = newId()
      const seq = yield* backend.append({
        opId,
        at: meta.at,
        module: moduleId,
        collection,
        id: meta.id,
        op,
        rev: meta.rev,
        scope: meta.scope,
        actor: meta.actor,
        actorKey: actorKey(meta.actor),
        ...(payload !== undefined ? { payload } : {}),
        ...(undoes !== undefined ? { undoes } : {})
      })
      yield* backend.afterCommit({
        seq,
        opId,
        at: meta.at,
        module: moduleId,
        collection,
        id: meta.id,
        op,
        rev: meta.rev,
        scope: meta.scope,
        actor: meta.actor,
        ...(rows.row !== undefined ? { row: rows.row } : {}),
        ...(rows.before !== undefined ? { before: rows.before } : {})
      })
      return seq
    })

  const handleFor = <A>(c: Collection<A>): CollectionHandle<A> => {
    const declared = collections.get(c.name)
    const known = declared === c || (declared !== undefined && declared.schema === c.schema && declared.version === c.version)
    const notDeclared = new StoreError({
      reason: "invalid",
      message: `Module ${moduleId}: collection "${c.name}" is not declared in its storage.collections`
    })
    const guard = <X, E>(effect: Effect.Effect<X, E>): Effect.Effect<X, E | StoreError> => (known ? effect : Effect.fail(notDeclared))
    const writable = <X, E>(what: string, effect: Effect.Effect<X, E>): Effect.Effect<X, E | StoreError> =>
      guard<X, E | StoreError>(backend.readOnly ? Effect.fail(readOnlyError(what)) : effect)

    const toRow = (doc: StoredDoc): Effect.Effect<Row<A>, StoreError> =>
      Effect.gen(function*() {
        const decoded = yield* decodeStored(c, doc.v, JSON.parse(doc.text), doc.id)
        if (decoded.migrated !== undefined && !backend.readOnly) {
          yield* backend.rewrite(doc, c.version, JSON.stringify(decoded.migrated))
        }
        return { id: doc.id, rev: doc.rev, scope: doc.scope, value: decoded.value, createdAt: doc.createdAt, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }
      })

    const inScope = (doc: StoredDoc | undefined, scope: ScopeRef): StoredDoc | undefined =>
      doc !== undefined && doc.scope.kind === scope.kind && (scope.kind === "household" || (doc.scope.kind !== "household" && doc.scope.id === scope.id)) ? doc : undefined

    const payloadOf = (before: unknown, after: unknown): ChangeRecord["payload"] =>
      c.history === "none" ? undefined : { v: c.version, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }

    const get: CollectionHandle<A>["get"] = (id, options) =>
      guard(Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const doc = inScope(yield* backend.read(moduleId, c.name, id), scope)
        return doc === undefined ? undefined : yield* toRow(doc)
      }))

    const list: CollectionHandle<A>["list"] = (query?: ListQuery<A>) =>
      guard(Effect.gen(function*() {
        const limit = yield* checkQuery(c, query)
        const scope = yield* resolveScope(c, query?.scope)
        const field = query?.orderBy?.field ?? "updatedAt"
        const column = field === "createdAt" || field === "updatedAt"
        const docs = yield* backend.list(moduleId, c.name, scope, {
          where: Object.entries(query?.where ?? {}) as ReadonlyArray<readonly [string, WhereValue]>,
          order: { field, column, desc: (query?.orderBy?.direction ?? (column && query?.orderBy === undefined ? "desc" : "asc")) === "desc" },
          limit
        })
        return yield* Effect.forEach(docs, toRow)
      }))

    const search: CollectionHandle<A>["search"] = (text, options) =>
      guard(Effect.gen(function*() {
        if (c.search.length === 0) return yield* new StoreError({ reason: "invalid", message: `Collection ${c.name} declares no search fields` })
        const scope = yield* resolveScope(c, options?.scope)
        const words = searchWords(text)
        if (words.length === 0) return []
        const limit = Math.min(Math.max(1, options?.limit ?? 20), 200)
        const docs = yield* backend.search(moduleId, c.name, scope, words, limit)
        return yield* Effect.forEach(docs, toRow)
      }))

    const insert: CollectionHandle<A>["insert"] = (value, options) =>
      writable("insert", Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const id = options?.id ?? newId()
        yield* checkRowId(c.name, id)
        const encoded = yield* encodeValue(c, value)
        const actor = yield* currentActor(moduleId, options?.actor)
        const at = yield* Clock.currentTimeMillis
        const doc: StoredDoc = { module: moduleId, collection: c.name, id, scope, rev: 1, v: c.version, text: encoded.text, createdAt: at, updatedAt: at, updatedBy: actor }
        const row: Row<A> = { id, rev: 1, scope, value: encoded.value, createdAt: at, updatedAt: at, updatedBy: actor }
        return yield* backend.transaction(Effect.gen(function*() {
          const ok = yield* backend.put(doc, "absent", searchTextOf(c, encoded.json))
          if (!ok) return yield* new StoreConflict({ collection: c.name, id, message: `A row ${id} already exists in ${c.name}` })
          yield* logChange(c.name, "insert", { id, rev: 1, scope, actor, at }, payloadOf(undefined, encoded.json), { row })
          return row
        }))
      }))

    const update: CollectionHandle<A>["update"] = (id, f, options) =>
      writable("update", Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const actor = yield* currentActor(moduleId, options?.actor)
        for (let attempt = 1; ; attempt++) {
          const doc = inScope(yield* backend.read(moduleId, c.name, id), scope)
          if (doc === undefined) return yield* new StoreNotFound({ collection: c.name, id })
          if (options?.expectRev !== undefined && doc.rev !== options.expectRev) {
            return yield* new StoreConflict({ collection: c.name, id, message: `Row ${id} of ${c.name} is at rev ${doc.rev}, not ${options.expectRev}` })
          }
          const before = yield* toRow(doc)
          const next = yield* Effect.try({
            try: () => f(before.value),
            catch: (cause) => new StoreError({ reason: "failed", message: `Collection ${c.name}: the update function failed`, cause })
          })
          const encoded = yield* encodeValue(c, next)
          const beforeJson = (yield* encodeValue(c, before.value)).json
          const at = yield* Clock.currentTimeMillis
          const rev = doc.rev + 1
          const written: StoredDoc = { ...doc, rev, v: c.version, text: encoded.text, updatedAt: at, updatedBy: actor }
          const row: Row<A> = { id, rev, scope: doc.scope, value: encoded.value, createdAt: doc.createdAt, updatedAt: at, updatedBy: actor }
          const done = yield* backend.transaction(Effect.gen(function*() {
            const ok = yield* backend.put(written, doc.rev, searchTextOf(c, encoded.json))
            if (!ok) return false
            yield* logChange(c.name, "update", { id, rev, scope: doc.scope, actor, at }, payloadOf(beforeJson, encoded.json), { row, before })
            return true
          }))
          if (done) return row
          if (options?.expectRev !== undefined || attempt >= MAX_ATTEMPTS) {
            return yield* new StoreConflict({ collection: c.name, id, message: `Row ${id} of ${c.name} kept changing; tried ${attempt} times` })
          }
        }
      }))

    const removeOrErase = (id: string, op: "remove" | "erase", options?: { readonly scope?: ScopeRef; readonly actor?: Actor; readonly expectRev?: number }) =>
      Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const actor = yield* currentActor(moduleId, options?.actor)
        for (let attempt = 1; ; attempt++) {
          const doc = inScope(yield* backend.read(moduleId, c.name, id), scope)
          if (doc === undefined) {
            if (op === "erase") {
              // Nothing left of the row itself; its history may still hold payloads: erase them all the same.
              yield* backend.transaction(backend.purge(moduleId, c.name, id))
              yield* backend.afterErase
            }
            return false
          }
          if (options?.expectRev !== undefined && doc.rev !== options.expectRev) {
            return yield* new StoreConflict({ collection: c.name, id, message: `Row ${id} of ${c.name} is at rev ${doc.rev}, not ${options.expectRev}` })
          }
          const before = yield* toRow(doc)
          const beforeJson = op === "remove" ? (yield* encodeValue(c, before.value)).json : undefined
          const at = yield* Clock.currentTimeMillis
          const rev = doc.rev + 1
          const done = yield* backend.transaction(Effect.gen(function*() {
            const ok = yield* backend.delete(moduleId, c.name, id, doc.rev)
            if (!ok) return false
            if (op === "erase") yield* backend.purge(moduleId, c.name, id)
            yield* logChange(c.name, op, { id, rev, scope: doc.scope, actor, at }, op === "erase" ? undefined : payloadOf(beforeJson, undefined), { before })
            return true
          }))
          if (done) {
            if (op === "erase") yield* backend.afterErase
            return true
          }
          if (options?.expectRev !== undefined || attempt >= MAX_ATTEMPTS) {
            return yield* new StoreConflict({ collection: c.name, id, message: `Row ${id} of ${c.name} kept changing; tried ${attempt} times` })
          }
        }
      })

    const remove: CollectionHandle<A>["remove"] = (id, options) => writable("remove", removeOrErase(id, "remove", options))
    const erase: CollectionHandle<A>["erase"] = (id, options) =>
      writable("erase", removeOrErase(id, "erase", options)) as Effect.Effect<boolean, StoreError | ScopeUnknown>

    const undo: CollectionHandle<A>["undo"] = (options) =>
      writable("undo", Effect.gen(function*() {
        if (c.history === "none") return yield* new StoreError({ reason: "invalid", message: `Collection ${c.name} keeps no history, so nothing in it can be undone` })
        const actor = yield* currentActor(moduleId, options?.actor)
        return yield* backend.transaction(Effect.gen(function*() {
          const last = yield* backend.lastUndoable(moduleId, c.name, actorKey(actor))
          if (last === undefined || last.payload === undefined) return undefined
          const doc = yield* backend.read(moduleId, c.name, last.id)
          const changedSince = yield* backend.changedSince(moduleId, c.name, last.id, last.seq)
          const conflict = new StoreConflict({ collection: c.name, id: last.id, message: `Row ${last.id} of ${c.name} was changed again since; not undone` })
          const at = yield* Clock.currentTimeMillis
          const decodeAt = (json: unknown) => Effect.map(decodeStored(c, last.payload!.v, json, last.id), (d) => d.value)
          let result: UndoResult<A>
          if (last.op === "insert") {
            if (doc === undefined || changedSince) return yield* conflict
            const before = yield* toRow(doc)
            if (!(yield* backend.delete(moduleId, c.name, last.id, doc.rev))) return yield* conflict
            yield* logChange(c.name, "remove", { id: last.id, rev: doc.rev + 1, scope: doc.scope, actor, at }, { v: c.version, before: JSON.parse(doc.text) }, { before }, last.opId)
            result = { undid: "insert", id: last.id, row: undefined }
          } else {
            const prior = last.payload.before
            if (prior === undefined) return undefined
            const value = yield* decodeAt(prior)
            const encoded = yield* encodeValue(c, value)
            if (last.op === "update") {
              if (doc === undefined || changedSince) return yield* conflict
              const before = yield* toRow(doc)
              const rev = doc.rev + 1
              const written: StoredDoc = { ...doc, rev, v: c.version, text: encoded.text, updatedAt: at, updatedBy: actor }
              if (!(yield* backend.put(written, doc.rev, searchTextOf(c, encoded.json)))) return yield* conflict
              const row: Row<A> = { id: doc.id, rev, scope: doc.scope, value: encoded.value, createdAt: doc.createdAt, updatedAt: at, updatedBy: actor }
              yield* logChange(c.name, "update", { id: doc.id, rev, scope: doc.scope, actor, at }, { v: c.version, before: JSON.parse(doc.text), after: encoded.json }, { row, before }, last.opId)
              result = { undid: "update", id: doc.id, row }
            } else if (last.op === "remove") {
              if (doc !== undefined || changedSince) return yield* conflict
              const rev = last.rev + 1
              const written: StoredDoc = { module: moduleId, collection: c.name, id: last.id, scope: last.scope, rev, v: c.version, text: encoded.text, createdAt: at, updatedAt: at, updatedBy: actor }
              if (!(yield* backend.put(written, "absent", searchTextOf(c, encoded.json)))) return yield* conflict
              const row: Row<A> = { id: last.id, rev, scope: last.scope, value: encoded.value, createdAt: at, updatedAt: at, updatedBy: actor }
              yield* logChange(c.name, "insert", { id: last.id, rev, scope: last.scope, actor, at }, { v: c.version, after: encoded.json }, { row }, last.opId)
              result = { undid: "remove", id: last.id, row }
            } else return undefined
          }
          yield* backend.markUndone(last.seq)
          return result
        }))
      }))

    return { get, list, search, insert, update, remove, erase, undo }
  }

  return {
    moduleId,
    readOnly: backend.readOnly,
    fts5: backend.fts5,
    collection: <A>(c: Collection<A>) => {
      let h = handles.get(c.name)
      if (h === undefined) {
        h = handleFor(c)
        handles.set(c.name, h)
      }
      return h as CollectionHandle<A>
    },
    sql,
    transaction: (work) => backend.transaction(work),
    logChange: (change) =>
      backend.readOnly ? Effect.fail(readOnlyError("logChange")) : backend.transaction(Effect.gen(function*() {
        const actor = yield* currentActor(moduleId, change.actor)
        const at = yield* Clock.currentTimeMillis
        yield* logChange(`sql:${change.table}`, change.op, { id: change.id, rev: 0, scope: change.scope ?? { kind: "household" }, actor, at }, undefined, {})
      }))
  }
}

/** Order two JSON field values like SQLite orders `json_extract` results: null, numbers, text. */
export const compareJsonValues = (a: unknown, b: unknown): number => {
  const rank = (x: unknown) => (x === null || x === undefined ? 0 : typeof x === "number" || typeof x === "boolean" ? 1 : typeof x === "string" ? 2 : 3)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 1) return Number(a) - Number(b)
  if (ra === 2) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
  return 0
}

/** Whether a stored JSON value equals a filter value (booleans compare as SQLite's 1 / 0). */
export const jsonEquals = (stored: unknown, filter: WhereValue): boolean => {
  if (filter === null) return stored === null || stored === undefined
  if (typeof filter === "boolean") return stored === filter || stored === (filter ? 1 : 0)
  if (typeof stored === "boolean") return (stored ? 1 : 0) === filter
  return stored === filter
}

