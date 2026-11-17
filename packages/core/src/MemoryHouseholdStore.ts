import { Effect } from "effect"
import {
  compareCodePoints,
  compareIndexed,
  type HouseholdStore,
  indexedEquals,
  scopeKey,
  type ScopeRef,
  StoreError
} from "./HouseholdStore.ts"
import { makeStoreEngine, type StoredDoc, type SyncBackend } from "./StoreEngine.ts"

/**
 * The in-memory household store (`@pva/core/testing`): the semantics of the SQLite store without a database, for
 * module tests. It runs the same engine (`StoreEngine.ts`: collections, synchronous flat transactions, events after
 * the commit, `prepare`) over a backend of maps with an undo list (a rollback replays it backwards), and answers lists
 * in the same order as SQLite's indexes. It keeps rows as JSON text, as SQLite does, so nothing a caller passes in or
 * gets back is shared with what it stores. The shared contract (`@pva/core/store-contract`) and a randomised comparison
 * with the SQLite store check both. It has no core SQL (`tx.core` throws `unavailable`; use `tx.onRollback` and
 * `tx.afterCommit` for a core service's in-memory state) and no backups.
 */

export interface MemoryStoreOptions {
  /** Refuse every write, like the CLI modes. */
  readonly readOnly?: boolean
  /** Versions as if a newer build had written them: `{ "<moduleId>": { "collection:<name>": 3 } }`. */
  readonly storedVersions?: Readonly<Record<string, Readonly<Record<string, number>>>>
}

const key = (module: string, collection: string, id: string) => `${module}\u0000${collection}\u0000${id}`

const noCoreSql = () => new StoreError({ reason: "unavailable", message: "Core SQL needs the SQLite store (makeSqliteStore({ filename: \":memory:\" }) in tests)" })

/** The in-memory backend (exported for the randomised comparison with SQLite). */
export const makeMemoryBackend = (options: MemoryStoreOptions = {}): SyncBackend => {
  const docs = new Map<string, StoredDoc>()
  const versions = new Map<string, Map<string, number>>()
  for (const [m, vs] of Object.entries(options.storedVersions ?? {})) versions.set(`module:${m}`, new Map(Object.entries(vs)))
  let rev = 0
  let undo: Array<() => void> | undefined

  const remember = (f: () => void) => {
    if (undo === undefined) throw new StoreError({ reason: "failed", message: "A write outside a transaction" })
    undo.push(f)
  }
  const set = (k: string, doc: StoredDoc | undefined) => {
    const before = docs.get(k)
    remember(() => (before === undefined ? docs.delete(k) : docs.set(k, before)))
    if (doc === undefined) docs.delete(k)
    else docs.set(k, doc)
  }
  const sameScope = (a: ScopeRef, b: ScopeRef) => scopeKey(a) === scopeKey(b)
  const docsOf = (module: string, collection: string, scope: ScopeRef) =>
    [...docs.values()].filter((d) => d.module === module && d.collection === collection && sameScope(d.scope, scope))
  const fieldOf = (d: StoredDoc, field: string): unknown => {
    const value = JSON.parse(d.text) as Record<string, unknown>
    return Object.hasOwn(value, field) ? value[field] : undefined
  }

  return {
    readOnly: options.readOnly === true,
    begin: () => {
      if (undo !== undefined) throw new StoreError({ reason: "failed", message: "A transaction is already open" })
      undo = []
    },
    commit: () => {
      undo = undefined
    },
    rollback: () => {
      const steps = undo ?? []
      undo = undefined
      for (let i = steps.length - 1; i >= 0; i--) steps[i]!()
    },
    inTransaction: () => undo !== undefined,
    read: (module, collection, id) => docs.get(key(module, collection, id)),
    list: (module, collection, scope, q) => {
      const { order } = q
      const keyOf = (d: StoredDoc): ReadonlyArray<unknown> =>
        order.column ? [order.field === "createdAt" ? d.createdAt : d.updatedAt] : [fieldOf(d, order.field), d.updatedAt]
      return docsOf(module, collection, scope)
        .filter((d) => q.where === undefined || indexedEquals(fieldOf(d, q.where[0]), q.where[1]))
        .sort((a, b) => {
          const ka = keyOf(a)
          const kb = keyOf(b)
          let c = 0
          for (let i = 0; i < ka.length && c === 0; i++) c = compareIndexed(ka[i], kb[i])
          if (c === 0) c = compareCodePoints(a.id, b.id)
          return order.desc ? -c : c
        })
        .slice(0, q.limit)
    },
    page: (module, collection, scope, after, limit) =>
      docsOf(module, collection, scope)
        .filter((d) => after === undefined || d.updatedAt < after.updatedAt || (d.updatedAt === after.updatedAt && compareCodePoints(d.id, after.id) < 0))
        .sort((a, b) => b.updatedAt - a.updatedAt || compareCodePoints(b.id, a.id))
        .slice(0, limit),
    put: (doc, expect) => {
      const k = key(doc.module, doc.collection, doc.id)
      const existing = docs.get(k)
      if (expect === "absent" ? existing !== undefined : existing === undefined || existing.rev !== expect || !sameScope(existing.scope, doc.scope)) return false
      set(k, { ...doc, scope: { ...doc.scope } })
      return true
    },
    remove: (module, collection, id, scope, expect) => {
      const k = key(module, collection, id)
      const existing = docs.get(k)
      if (existing === undefined || existing.rev !== expect || !sameScope(existing.scope, scope)) return false
      set(k, undefined)
      return true
    },
    nextRev: () => {
      const before = rev
      remember(() => {
        rev = before
      })
      return ++rev
    },
    lastRev: () => rev,
    scan: (module, collection, afterId, limit) =>
      [...docs.values()]
        .filter((d) => d.module === module && d.collection === collection && compareCodePoints(d.id, afterId) > 0)
        .sort((a, b) => compareCodePoints(a.id, b.id))
        .slice(0, limit),
    count: (module, collection, cap) => {
      let n = 0
      for (const d of docs.values()) if (d.module === module && d.collection === collection && ++n > cap) break
      return n
    },
    rewrite: (doc, v, text) => {
      const k = key(doc.module, doc.collection, doc.id)
      const now = docs.get(k)
      if (now !== undefined) set(k, { ...now, v, text })
    },
    conversationDocs: (conversationId) =>
      [...docs.values()].filter((d) => d.scope.kind === "conversation" && (conversationId === undefined || d.scope.id === conversationId)),
    versions: (owner) => new Map(versions.get(owner) ?? []),
    setVersion: (owner, name, version) => {
      let vs = versions.get(owner)
      if (vs === undefined) versions.set(owner, vs = new Map())
      const before = vs.get(name)
      const target = vs
      remember(() => (before === undefined ? target.delete(name) : target.set(name, before)))
      vs.set(name, version)
    },
    syncIndexes: () => {},
    core: () => {
      throw noCoreSql()
    },
    removed: () => {}
  }
}

export const makeMemoryHouseholdStore = (options: MemoryStoreOptions = {}): HouseholdStore => {
  const backend = makeMemoryBackend(options)
  const { runTx: _runTx, inTransaction: _inTransaction, ...engine } = makeStoreEngine({ backend })
  return {
    ...engine,
    info: { kind: "memory", readOnly: backend.readOnly },
    core: (owner) => ({ prefix: `core_${owner}__`, query: () => Effect.fail(noCoreSql()), run: () => Effect.fail(noCoreSql()), migrate: () => Effect.fail(noCoreSql()) }),
    backup: () => Effect.fail(new StoreError({ reason: "unavailable", message: "The in-memory store has no backups" }))
  }
}
