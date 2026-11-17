import { Effect } from "effect"
import {
  type Collection,
  compareCodePoints,
  compareIndexed,
  type HouseholdStore,
  type IndexKey,
  scopeKey,
  type ScopeRef,
  StoreError
} from "./HouseholdStore.ts"
import { type BulkKey, type BulkRow, type CheckedQuery, layoutOf, makeStoreEngine, type StoredCollection, type StoredDoc, type SyncBackend } from "./StoreEngine.ts"

/**
 * The in-memory household store (`@pva/core/testing`): the semantics of the SQLite store without a database, for
 * module tests. It runs the same engine (`StoreEngine.ts`: collections, synchronous flat transactions, events after
 * the commit, `prepare`) over a backend of maps with an undo list (a rollback replays it backwards), and answers lists
 * in the same order as SQLite's indexes (the same index keys, compared the way SQLite compares its columns). It keeps
 * rows as JSON text, as SQLite does, so nothing a caller passes in or gets back is shared with what it stores. The
 * shared contract (`@pva/core/store-contract`) and a randomised comparison with the SQLite store check both. It has
 * no backups.
 */

export interface MemoryStoreOptions {
  /** Refuse every write, like the CLI modes. */
  readonly readOnly?: boolean
  /** Data versions as if a newer build had written them: `{ "<owner>": 3 }`. */
  readonly storedVersions?: Readonly<Record<string, number>>
}

const key = (owner: string, collection: string, id: string) => `${owner}\u0000${collection}\u0000${id}`

interface MemoryDoc extends StoredDoc {
  readonly keys: ReadonlyArray<IndexKey>
}

/** The in-memory backend (exported for the randomised comparison with SQLite). */
export const makeMemoryBackend = (options: MemoryStoreOptions = {}): SyncBackend => {
  const docs = new Map<string, MemoryDoc>()
  const ownerVersions = new Map<string, number>(Object.entries(options.storedVersions ?? {}))
  const collections = new Map<string, Map<string, StoredCollection>>()
  let rev = 0
  let undo: Array<() => void> | undefined

  const remember = (f: () => void) => {
    if (undo === undefined) throw new StoreError({ reason: "failed", message: "A write outside a transaction" })
    undo.push(f)
  }
  const set = (k: string, doc: MemoryDoc | undefined) => {
    const before = docs.get(k)
    remember(() => (before === undefined ? docs.delete(k) : docs.set(k, before)))
    if (doc === undefined) docs.delete(k)
    else docs.set(k, doc)
  }
  const sameScope = (a: ScopeRef, b: ScopeRef) => scopeKey(a) === scopeKey(b)
  const docsOf = (owner: string, collection: string, scope: ScopeRef) =>
    [...docs.values()].filter((d) => d.owner === owner && d.collection === collection && sameScope(d.scope, scope))
  const plain = ({ keys: _keys, ...doc }: MemoryDoc): StoredDoc => doc

  /** The sort key of a row in an index (`CheckedQuery.index`), ending with createdAt; the id breaks the last tie. */
  const sortKey = (d: MemoryDoc, q: CheckedQuery): ReadonlyArray<unknown> => {
    const i = q.index
    switch (i.kind) {
      case "updated":
        return [d.updatedAt, d.createdAt]
      case "created":
        return [d.createdAt]
      case "s":
        return [d.keys[i.slots[0]!] ?? null, d.createdAt]
      case "u":
        return [d.keys[i.slots[0]!] ?? null, d.updatedAt, d.createdAt]
      case "p":
        return [d.keys[i.slots[0]!] ?? null, d.keys[i.slots[1]!] ?? null, d.createdAt]
    }
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
    read: (owner, collection, id) => {
      const d = docs.get(key(owner, collection, id))
      return d === undefined ? undefined : plain(d)
    },
    list: (owner, collection, scope, q) => {
      const first = "slots" in q.index ? q.index.slots[0]! : undefined
      return docsOf(owner, collection, scope)
        .filter((d) => q.where === undefined || (d.keys[first!] ?? null) === q.where)
        .sort((a, b) => {
          const ka = sortKey(a, q)
          const kb = sortKey(b, q)
          let c = 0
          for (let i = 0; i < ka.length && c === 0; i++) c = compareIndexed(ka[i], kb[i])
          if (c === 0) c = compareCodePoints(a.id, b.id)
          return q.desc ? -c : c
        })
        .slice(0, q.limit)
        .map(plain)
    },
    page: (owner, collection, scope, after, limit) => {
      const cmp = (a: { updatedAt: number; createdAt: number; id: string }, b: { updatedAt: number; createdAt: number; id: string }) =>
        a.updatedAt - b.updatedAt || a.createdAt - b.createdAt || compareCodePoints(a.id, b.id)
      return docsOf(owner, collection, scope)
        .filter((d) => after === undefined || cmp(d, after) < 0)
        .sort((a, b) => cmp(b, a))
        .slice(0, limit)
        .map(plain)
    },
    put: (doc, keys, expect) => {
      const k = key(doc.owner, doc.collection, doc.id)
      const existing = docs.get(k)
      if (expect === "absent" ? existing !== undefined : existing === undefined || existing.rev !== expect || !sameScope(existing.scope, doc.scope)) return false
      set(k, { ...doc, scope: { ...doc.scope }, keys: [...keys] })
      return true
    },
    remove: (owner, collection, id, scope, expect) => {
      const k = key(owner, collection, id)
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
    scan: (owner, collection, afterId, limit) =>
      [...docs.values()]
        .filter((d) => d.owner === owner && d.collection === collection && compareCodePoints(d.id, afterId) > 0)
        .sort((a, b) => compareCodePoints(a.id, b.id))
        .slice(0, limit)
        .map(plain),
    count: (owner, collection, cap) => {
      let n = 0
      for (const d of docs.values()) if (d.owner === owner && d.collection === collection && ++n > cap) break
      return n
    },
    rewrite: (doc, v, text, keys) => {
      const k = key(doc.owner, doc.collection, doc.id)
      const now = docs.get(k)
      if (now !== undefined) set(k, { ...now, v, text, keys: [...keys] })
    },
    conversationRows: (conversationId, after, limit) => {
      const order = (x: BulkKey) => [x.scopeId, x.owner, x.collection, x.id]
      const cmp = (a: BulkKey, b: BulkKey) => {
        const ka = order(a)
        const kb = order(b)
        for (let i = 0; i < ka.length; i++) {
          const c = compareCodePoints(ka[i]!, kb[i]!)
          if (c !== 0) return c
        }
        return 0
      }
      return [...docs.values()]
        .filter((d) => d.scope.kind === "conversation" && (conversationId === undefined || d.scope.id === conversationId))
        .map((d): BulkRow => ({ scopeId: d.scope.kind === "household" ? "" : d.scope.id, owner: d.owner, collection: d.collection, id: d.id, scope: { ...d.scope }, rev: d.rev }))
        .filter((r) => after === undefined || cmp(r, after) > 0)
        .sort(cmp)
        .slice(0, limit)
    },
    ownerVersion: (owner) => ownerVersions.get(owner),
    setOwnerVersion: (owner, version) => {
      const before = ownerVersions.get(owner)
      remember(() => (before === undefined ? ownerVersions.delete(owner) : ownerVersions.set(owner, before)))
      ownerVersions.set(owner, version)
    },
    storedCollections: (owner) => new Map(collections.get(owner) ?? []),
    allCollections: () => [...collections.entries()].flatMap(([owner, cs]) => [...cs.entries()].map(([name, meta]) => ({ owner, name, version: meta.version }))),
    setCollection: (owner, name, meta) => {
      let cs = collections.get(owner)
      if (cs === undefined) collections.set(owner, cs = new Map())
      const target = cs
      const before = target.get(name)
      remember(() => (before === undefined ? target.delete(name) : target.set(name, before)))
      target.set(name, { ...meta })
    },
    syncIndexes: (_owner, c: Collection<any>) => void layoutOf(c),
    indexesReady: () => true,
    removed: () => {}
  }
}

export const makeMemoryHouseholdStore = (options: MemoryStoreOptions = {}): HouseholdStore => {
  const backend = makeMemoryBackend(options)
  const { inTransaction: _inTransaction, ...engine } = makeStoreEngine({ backend })
  return {
    ...engine,
    info: { kind: "memory", readOnly: backend.readOnly },
    backup: () => Effect.fail(new StoreError({ reason: "unavailable", message: "The in-memory store has no backups" }))
  }
}
