import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Effect } from "effect"
import {
  type Actor,
  actorKey,
  type ChangeOp,
  type ChangeRecord,
  type CheckedQuery,
  checkQuery,
  checkRowId,
  type Collection,
  type CollectionHandle,
  type CommittedChange,
  currentActor,
  decodeStored,
  encodeValue,
  MAX_SEARCH_LIMIT,
  type ModuleSql,
  type ModuleStore,
  readOnlyError,
  resolveScope,
  type Row,
  type ScopeRef,
  scopeKey,
  type ScopeUnknown,
  searchTokensOf,
  searchWords,
  StoreConflict,
  StoreError,
  StoreNotFound,
  type UndoResult
} from "./HouseholdStore.ts"
import type { Transactions } from "./StoreTransactions.ts"

/**
 * The semantics of `ctx.store` collections, written once over a small backend (`StoreBackend`), so the SQLite store
 * and the in-memory double behave the same: availability, scope resolution, validation, every write as one
 * read-check-write step inside a transaction, the change log, undo, erase and the migration of a collection at start.
 * Internal to `@pva/core` and `@pva/store-sqlite`.
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

/** A change to append (the backend gives it its number, which is also its `rev`). */
export type NewChange = Omit<ChangeRecord, "seq" | "undone" | "rev"> & { readonly actorKey: string }

/**
 * The backend's primitives. None of them takes a lock: the callers below run reads through `tx.statement` and writes
 * inside `tx.transaction` (`StoreTransactions.ts`), so a backend never sees two of them at once.
 */
export interface StoreBackend {
  readonly readOnly: boolean
  readonly fts5: boolean
  readonly tx: Transactions
  /** The row with this id in the collection, whatever its scope. */
  readonly read: (module: string, collection: string, id: string) => Effect.Effect<StoredDoc | undefined, StoreError>
  /** One index range read (`CheckedQuery`), in the order `compareIndexed` defines. */
  readonly list: (module: string, collection: string, scope: ScopeRef, query: CheckedQuery) => Effect.Effect<ReadonlyArray<StoredDoc>, StoreError>
  /** Rows of the scope with a token beginning with each word, the most recently written first (`searchTokens`). */
  readonly search: (module: string, collection: string, scope: ScopeRef, words: ReadonlyArray<string>, limit: number) => Effect.Effect<ReadonlyArray<StoredDoc>, StoreError>
  /** Append a change; returns its number (the `rev` of the row it wrote). */
  readonly append: (change: NewChange) => Effect.Effect<number, StoreError>
  /** Insert (`"absent"`) or replace the row at rev `expect` in its scope; `false` when that did not hold. Sets its search words. */
  readonly put: (doc: StoredDoc, expect: "absent" | number, tokens: ReadonlyArray<string>) => Effect.Effect<boolean, StoreError>
  /** Delete the row at rev `expect` in `scope` (and its search entry); `false` when it was not there so. */
  readonly remove: (module: string, collection: string, id: string, scope: ScopeRef, expect: number) => Effect.Effect<boolean, StoreError>
  /** The newest change of `actorKey` in the collection and scope that is not undone, not an undo or an erase, and still has its values. */
  readonly lastUndoable: (module: string, collection: string, actorKey: string, scope: ScopeRef) => Effect.Effect<ChangeRecord | undefined, StoreError>
  readonly markUndone: (seq: number) => Effect.Effect<void, StoreError>
  /** Whether the row id has a change after `seq` (in any scope) that is not undone and not itself an undo. */
  readonly changedSince: (module: string, collection: string, id: string, seq: number) => Effect.Effect<boolean, StoreError>
  /** Drop every payload of the row id in `scope` from the change log. */
  readonly purge: (module: string, collection: string, id: string, scope: ScopeRef) => Effect.Effect<void, StoreError>
  /** Rows of a collection after `afterId` in id order (the migration at start). */
  readonly scan: (module: string, collection: string, afterId: string, limit: number) => Effect.Effect<ReadonlyArray<StoredDoc>, StoreError>
  /** Store a migrated value of a row (same rev, same place in search order). */
  readonly rewrite: (doc: StoredDoc, v: number, text: string, tokens: ReadonlyArray<string>) => Effect.Effect<void, StoreError>
  /** After an erase committed: make the old content unreadable in the files too (SQLite: a checkpoint, retried). */
  readonly scrub: () => void
}

const newId = () => globalThis.crypto.randomUUID()

const sameScope = (a: ScopeRef, b: ScopeRef) => scopeKey(a) === scopeKey(b)

/**
 * `ctx.store` of one module over a backend. `collections`: what the module declared; `unavailable`: the module's
 * verdict now (read at every call, so a handle made before `prepare` refused the data is refused too).
 */
export const makeModuleStoreOn = (
  backend: StoreBackend,
  moduleId: string,
  collections: ReadonlyMap<string, Collection<any>>,
  sql: ModuleSql,
  unavailable: () => ModuleUnavailable | undefined = () => undefined
): ModuleStore => {
  const { tx } = backend
  const handles = new Map<string, CollectionHandle<any>>()

  const usable = <X, E, R>(effect: Effect.Effect<X, E, R>): Effect.Effect<X, E | StoreError, R> =>
    Effect.suspend((): Effect.Effect<X, E | StoreError, R> => {
      const verdict = unavailable()
      return verdict === undefined
        ? effect
        : Effect.fail(new StoreError({ reason: "unavailable", message: `Module ${moduleId}'s data is not usable here: ${verdict.reason}` }))
    })

  /** Append a change and queue its event for after the commit. Inside a transaction. */
  const logChange = (
    collection: string,
    op: ChangeOp,
    meta: { readonly id: string; readonly scope: ScopeRef; readonly actor: Actor; readonly at: number },
    payload: ChangeRecord["payload"],
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
        scope: meta.scope,
        actor: meta.actor,
        actorKey: actorKey(meta.actor),
        ...(payload !== undefined ? { payload } : {}),
        ...(undoes !== undefined ? { undoes } : {})
      })
      const announce = (rows: { readonly row?: Row<unknown>; readonly before?: Row<unknown> }) =>
        tx.enqueue({
          _tag: "change",
          change: {
            seq,
            opId,
            at: meta.at,
            module: moduleId,
            collection,
            id: meta.id,
            op,
            rev: seq,
            scope: meta.scope,
            actor: meta.actor,
            ...(rows.row !== undefined ? { row: rows.row } : {}),
            ...(rows.before !== undefined ? { before: rows.before } : {})
          } satisfies CommittedChange
        })
      return { seq, announce }
    })

  const handleFor = <A>(c: Collection<A>): CollectionHandle<A> => {
    const declared = collections.get(c.name)
    const known = declared === c || (declared !== undefined && declared.schema === c.schema && declared.version === c.version)
    const notDeclared = new StoreError({
      reason: "invalid",
      message: `Module ${moduleId}: collection "${c.name}" is not declared in its storage.collections`
    })
    const guard = <X, E>(effect: Effect.Effect<X, E>): Effect.Effect<X, E | StoreError> => (known ? usable(effect) : Effect.fail(notDeclared))
    const writable = <X, E>(what: string, effect: Effect.Effect<X, E>): Effect.Effect<X, E | StoreError> =>
      guard<X, E | StoreError>(backend.readOnly ? Effect.fail(readOnlyError(what)) : effect)

    /** The row as the module sees it, with its JSON form at the collection's version. */
    const decode = (doc: StoredDoc): Effect.Effect<{ readonly row: Row<A>; readonly json: unknown }, StoreError> =>
      Effect.gen(function*() {
        const stored = yield* Effect.try({
          try: () => JSON.parse(doc.text) as unknown,
          catch: (cause) => new StoreError({ reason: "failed", message: `Row ${doc.id} of ${c.name} is not JSON`, cause })
        })
        const decoded = yield* decodeStored(c, doc.v, stored, doc.id)
        return {
          row: { id: doc.id, rev: doc.rev, scope: doc.scope, value: decoded.value, createdAt: doc.createdAt, updatedAt: doc.updatedAt, updatedBy: doc.updatedBy },
          json: decoded.migrated ?? stored
        }
      })
    const toRow = (doc: StoredDoc) => Effect.map(decode(doc), (d) => d.row)

    const payloadOf = (before: unknown, after: unknown): ChangeRecord["payload"] =>
      c.history === "none" ? undefined : { v: c.version, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) }

    const conflict = (id: string, message: string) => new StoreConflict({ collection: c.name, id, message })

    const get: CollectionHandle<A>["get"] = (id, options) =>
      guard(Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const doc = yield* tx.statement(backend.read(moduleId, c.name, id))
        return doc === undefined || !sameScope(doc.scope, scope) ? undefined : yield* toRow(doc)
      }))

    const list: CollectionHandle<A>["list"] = (query) =>
      guard(Effect.gen(function*() {
        const checked = yield* checkQuery(c, query)
        const scope = yield* resolveScope(c, query?.scope)
        const docs = yield* tx.statement(backend.list(moduleId, c.name, scope, checked))
        return yield* Effect.forEach(docs, toRow)
      }))

    const search: CollectionHandle<A>["search"] = (text, options) =>
      guard(Effect.gen(function*() {
        if (c.search.length === 0) return yield* new StoreError({ reason: "invalid", message: `Collection ${c.name} declares no search fields` })
        const scope = yield* resolveScope(c, options?.scope)
        const words = searchWords(text)
        if (words.length === 0) return []
        const limit = options?.limit ?? 20
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
          return yield* new StoreError({ reason: "invalid", message: `Collection ${c.name}: a search limit must be 1 to ${MAX_SEARCH_LIMIT}` })
        }
        const docs = yield* tx.statement(backend.search(moduleId, c.name, scope, words, limit))
        return yield* Effect.forEach(docs, toRow)
      }))

    const insert: CollectionHandle<A>["insert"] = (value, options) =>
      writable("insert", Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const id = options?.id ?? newId()
        yield* checkRowId(c.name, id)
        const encoded = yield* encodeValue(c, value)
        const actor = yield* currentActor(moduleId, options?.actor)
        return yield* tx.transaction(Effect.gen(function*() {
          if ((yield* backend.read(moduleId, c.name, id)) !== undefined) return yield* conflict(id, `A row ${id} already exists in ${c.name}`)
          const at = yield* Clock.currentTimeMillis
          const log = yield* logChange(c.name, "insert", { id, scope, actor, at }, payloadOf(undefined, encoded.json))
          const doc: StoredDoc = { module: moduleId, collection: c.name, id, scope, rev: log.seq, v: c.version, text: encoded.text, createdAt: at, updatedAt: at, updatedBy: actor }
          if (!(yield* backend.put(doc, "absent", searchTokensOf(c, encoded.json)))) return yield* conflict(id, `A row ${id} already exists in ${c.name}`)
          const row: Row<A> = { id, rev: log.seq, scope, value: encoded.value, createdAt: at, updatedAt: at, updatedBy: actor }
          yield* log.announce({ row })
          return row
        }))
      }))

    const update: CollectionHandle<A>["update"] = (id, f, options) =>
      writable("update", Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const actor = yield* currentActor(moduleId, options?.actor)
        return yield* tx.transaction(Effect.gen(function*() {
          const doc = yield* backend.read(moduleId, c.name, id)
          if (doc === undefined || !sameScope(doc.scope, scope)) return yield* new StoreNotFound({ collection: c.name, id })
          if (options?.expectRev !== undefined && doc.rev !== options.expectRev) {
            return yield* conflict(id, `Row ${id} of ${c.name} is at rev ${doc.rev}, not ${options.expectRev}`)
          }
          const before = yield* decode(doc)
          const next = yield* Effect.try({
            try: () => f(before.row.value),
            catch: (cause) => new StoreError({ reason: "failed", message: `Collection ${c.name}: the update function failed`, cause })
          })
          const encoded = yield* encodeValue(c, next)
          const at = yield* Clock.currentTimeMillis
          const log = yield* logChange(c.name, "update", { id, scope: doc.scope, actor, at }, payloadOf(before.json, encoded.json))
          const written: StoredDoc = { ...doc, rev: log.seq, v: c.version, text: encoded.text, updatedAt: at, updatedBy: actor }
          if (!(yield* backend.put(written, doc.rev, searchTokensOf(c, encoded.json)))) return yield* conflict(id, `Row ${id} of ${c.name} changed meanwhile`)
          const row: Row<A> = { id, rev: log.seq, scope: doc.scope, value: encoded.value, createdAt: doc.createdAt, updatedAt: at, updatedBy: actor }
          yield* log.announce({ row, before: before.row })
          return row
        }))
      }))

    const remove: CollectionHandle<A>["remove"] = (id, options) =>
      writable("remove", Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const actor = yield* currentActor(moduleId, options?.actor)
        return yield* tx.transaction(Effect.gen(function*() {
          const doc = yield* backend.read(moduleId, c.name, id)
          if (doc === undefined || !sameScope(doc.scope, scope)) return false
          if (options?.expectRev !== undefined && doc.rev !== options.expectRev) {
            return yield* conflict(id, `Row ${id} of ${c.name} is at rev ${doc.rev}, not ${options.expectRev}`)
          }
          const before = yield* decode(doc)
          const at = yield* Clock.currentTimeMillis
          const log = yield* logChange(c.name, "remove", { id, scope: doc.scope, actor, at }, payloadOf(before.json, undefined))
          if (!(yield* backend.remove(moduleId, c.name, id, doc.scope, doc.rev))) return yield* conflict(id, `Row ${id} of ${c.name} changed meanwhile`)
          yield* log.announce({ before: before.row })
          return true
        }))
      }))

    const erase: CollectionHandle<A>["erase"] = (id, options) =>
      writable("erase", Effect.gen(function*() {
        const scope = yield* resolveScope(c, options?.scope)
        const actor = yield* currentActor(moduleId, options?.actor)
        return yield* tx.transaction(Effect.gen(function*() {
          const doc = yield* backend.read(moduleId, c.name, id)
          // A row of this id in another scope is not this caller's to forget: nothing of it is touched.
          if (doc !== undefined && !sameScope(doc.scope, scope)) return false
          // Its history in this scope goes in any case (a row removed earlier still has payloads there).
          yield* backend.purge(moduleId, c.name, id, scope)
          yield* tx.enqueue({ _tag: "run", run: backend.scrub })
          if (doc === undefined) return false
          const at = yield* Clock.currentTimeMillis
          const log = yield* logChange(c.name, "erase", { id, scope, actor, at }, undefined)
          if (!(yield* backend.remove(moduleId, c.name, id, doc.scope, doc.rev))) return yield* conflict(id, `Row ${id} of ${c.name} changed meanwhile`)
          // The content does not travel on the bus either.
          yield* log.announce({})
          return true
        }))
      })) as Effect.Effect<boolean, StoreError | ScopeUnknown>

    const undo: CollectionHandle<A>["undo"] = (options) =>
      writable("undo", Effect.gen(function*() {
        if (c.history === "none") return yield* new StoreError({ reason: "invalid", message: `Collection ${c.name} keeps no history, so nothing in it can be undone` })
        const scope = yield* resolveScope(c, options?.scope)
        const actor = yield* currentActor(moduleId, options?.actor)
        return yield* tx.transaction(Effect.gen(function*() {
          const last = yield* backend.lastUndoable(moduleId, c.name, actorKey(actor), scope)
          if (last === undefined || last.payload === undefined) return undefined
          const payload = last.payload
          const found = yield* backend.read(moduleId, c.name, last.id)
          const changedSince = yield* backend.changedSince(moduleId, c.name, last.id, last.seq)
          const notUndone = conflict(last.id, `Row ${last.id} of ${c.name} was changed again since; not undone`)
          // The id belongs to another scope now: that is a change since, too.
          if (changedSince || (found !== undefined && !sameScope(found.scope, scope))) return yield* notUndone
          const doc = found
          const at = yield* Clock.currentTimeMillis
          const valueAt = (json: unknown) => Effect.map(decodeStored(c, payload.v, json, last.id), (d) => d.value)
          let result: UndoResult<A>
          if (last.op === "insert") {
            if (doc === undefined) return yield* notUndone
            const before = yield* decode(doc)
            const log = yield* logChange(c.name, "remove", { id: last.id, scope, actor, at }, payloadOf(before.json, undefined), last.opId)
            if (!(yield* backend.remove(moduleId, c.name, last.id, scope, doc.rev))) return yield* notUndone
            yield* log.announce({ before: before.row })
            result = { undid: "insert", id: last.id, row: undefined }
          } else if (last.op === "update") {
            if (doc === undefined || payload.before === undefined) return yield* notUndone
            const before = yield* decode(doc)
            const encoded = yield* encodeValue(c, yield* valueAt(payload.before))
            const log = yield* logChange(c.name, "update", { id: doc.id, scope, actor, at }, payloadOf(before.json, encoded.json), last.opId)
            const written: StoredDoc = { ...doc, rev: log.seq, v: c.version, text: encoded.text, updatedAt: at, updatedBy: actor }
            if (!(yield* backend.put(written, doc.rev, searchTokensOf(c, encoded.json)))) return yield* notUndone
            const row: Row<A> = { id: doc.id, rev: log.seq, scope, value: encoded.value, createdAt: doc.createdAt, updatedAt: at, updatedBy: actor }
            yield* log.announce({ row, before: before.row })
            result = { undid: "update", id: doc.id, row }
          } else if (last.op === "remove") {
            if (doc !== undefined || payload.before === undefined) return yield* notUndone
            const encoded = yield* encodeValue(c, yield* valueAt(payload.before))
            const log = yield* logChange(c.name, "insert", { id: last.id, scope, actor, at }, payloadOf(undefined, encoded.json), last.opId)
            const written: StoredDoc = { module: moduleId, collection: c.name, id: last.id, scope, rev: log.seq, v: c.version, text: encoded.text, createdAt: at, updatedAt: at, updatedBy: actor }
            if (!(yield* backend.put(written, "absent", searchTokensOf(c, encoded.json)))) return yield* notUndone
            const row: Row<A> = { id: last.id, rev: log.seq, scope, value: encoded.value, createdAt: at, updatedAt: at, updatedBy: actor }
            yield* log.announce({ row })
            result = { undid: "remove", id: last.id, row }
          } else return undefined
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
    transaction: (work) => usable(tx.transaction(work)),
    logChange: (change) =>
      backend.readOnly ? Effect.fail(readOnlyError("logChange")) : usable(tx.transaction(Effect.gen(function*() {
        const actor = yield* currentActor(moduleId, change.actor)
        const at = yield* Clock.currentTimeMillis
        const log = yield* logChange(`sql:${change.table}`, change.op, { id: change.id, scope: change.scope ?? { kind: "household" }, actor, at }, undefined)
        yield* log.announce({})
      })))
  }
}

/**
 * Migrate every row of a collection to its declared version (inside the caller's transaction, at start): each row is
 * decoded at its stored version, migrated, and stored through the same checks as a write (`encodeValue`: the schema,
 * the size limit, scalar indexed fields), with its search words. A row that fails fails the whole migration.
 */
export const migrateCollectionOn = (backend: StoreBackend, moduleId: string, c: Collection<any>): Effect.Effect<number, StoreError> =>
  Effect.gen(function*() {
    let after = ""
    let n = 0
    for (;;) {
      const docs = yield* backend.scan(moduleId, c.name, after, 200)
      for (const doc of docs) {
        if (doc.v === c.version) continue
        const stored = yield* Effect.try({
          try: () => JSON.parse(doc.text) as unknown,
          catch: (cause) => new StoreError({ reason: "failed", message: `Row ${doc.id} of ${c.name} is not JSON`, cause })
        })
        const decoded = yield* decodeStored(c, doc.v, stored, doc.id)
        const encoded = yield* encodeValue(c, decoded.value).pipe(
          Effect.mapError((e) => new StoreError({ reason: "failed", message: `Row ${doc.id} of ${c.name}, migrated from version ${doc.v}: ${e.message}` }))
        )
        yield* backend.rewrite(doc, c.version, encoded.text, searchTokensOf(c, encoded.json))
        n++
      }
      if (docs.length < 200) return n
      after = docs[docs.length - 1]!.id
      yield* Effect.yieldNow
    }
  })

/**
 * How a backend finds a conversation's rows and drops the payloads of its changes (`undefined`: every conversation),
 * leaving out the modules in `keep` (their data is not usable here: it is never touched).
 */
export interface ConversationRows {
  readonly docs: (conversationId: string | undefined) => Effect.Effect<ReadonlyArray<StoredDoc>, StoreError>
  readonly purge: (conversationId: string | undefined, keep: ReadonlyArray<string>) => Effect.Effect<void, StoreError>
}

/**
 * A conversation ended (or, with `undefined`, every conversation, at start): erase each of its rows as `erase` does,
 * in one transaction: one `erase` change per row (actor `system:conversation-ended`), the row and its search words
 * gone, and every payload of a change in that scope dropped, so nothing of it can be undone or read back.
 */
export const endConversationsOn = (
  backend: StoreBackend,
  rows: ConversationRows,
  conversationId: string | undefined,
  unavailable: () => ReadonlyArray<string> = () => []
): Effect.Effect<number, StoreError> =>
  backend.tx.transaction(Effect.gen(function*() {
    // A module whose data is newer (or failed to upgrade) keeps its rows as they are, conversation rows too.
    const keep = unavailable()
    const docs = (yield* rows.docs(conversationId)).filter((d) => !keep.includes(d.module))
    const actor: Actor = { kind: "system", name: "conversation-ended" }
    const at = yield* Clock.currentTimeMillis
    let n = 0
    for (const doc of docs) {
      const opId = newId()
      const seq = yield* backend.append({ opId, at, module: doc.module, collection: doc.collection, id: doc.id, op: "erase", scope: doc.scope, actor, actorKey: actorKey(actor) })
      if (!(yield* backend.remove(doc.module, doc.collection, doc.id, doc.scope, doc.rev))) continue
      yield* backend.tx.enqueue({
        _tag: "change",
        change: { seq, opId, at, module: doc.module, collection: doc.collection, id: doc.id, op: "erase", rev: seq, scope: doc.scope, actor }
      })
      n++
      if (n % 200 === 0) yield* Effect.yieldNow
    }
    yield* rows.purge(conversationId, keep)
    yield* backend.tx.enqueue({ _tag: "run", run: backend.scrub })
    return n
  }))
