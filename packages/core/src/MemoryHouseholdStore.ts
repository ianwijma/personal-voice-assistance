import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Context, Effect, Semaphore } from "effect"
import {
  CHANGE_RETENTION_MS,
  type ChangeRecord,
  type Collection,
  type CommittedChange,
  type HouseholdStore,
  matchesWords,
  type ModuleExport,
  type ModuleSql,
  readOnlyError,
  SEARCH_SCAN_ROWS,
  scopeKey,
  type ScopeRef,
  sqlPrefixOf,
  type StoredModule,
  StoreError
} from "./HouseholdStore.ts"
import { compareJsonValues, jsonEquals, makeModuleStoreOn, type StoreBackend, type StoredDoc } from "./ModuleStoreImpl.ts"

/**
 * The in-memory household store (`@pva/core/testing`): the semantics of the SQLite store (scopes, rev, the change log,
 * undo, erase, transactions with rollback, events after commit, schema versions and downgrade refusal) without a
 * database, for module tests. It has no module SQL and no backups: a module with `storage.sql` is `unavailable` here
 * (test it on `makeSqliteStore({ filename: ":memory:" })` from `@pva/store-sqlite`).
 */

export interface MemoryStoreOptions {
  /** Refuse every write, like the CLI modes. */
  readonly readOnly?: boolean
  /** Versions as if a newer build had written them: `{ "<moduleId>": { "collection:<name>": 3 } }`. */
  readonly storedVersions?: Readonly<Record<string, Readonly<Record<string, number>>>>
}

interface State {
  docs: Map<string, StoredDoc>
  search: Map<string, string>
  changes: Array<ChangeRecord & { readonly actorKey: string }>
  nextSeq: number
}

const TxRef = Context.Reference<{ readonly store: object; readonly pending: Array<CommittedChange>; readonly undo: Array<() => void> } | undefined>("@pva/core/MemoryStoreTx", {
  defaultValue: () => undefined
})

const key = (module: string, collection: string, id: string) => `${module}\u0000${collection}\u0000${id}`

export const makeMemoryHouseholdStore = (options: MemoryStoreOptions = {}): HouseholdStore & {
  /** For assertions: every change-log row, oldest first. */
  readonly changeLog: () => ReadonlyArray<ChangeRecord>
  /** For assertions: the search text kept for a row (`undefined` when none). */
  readonly searchEntry: (module: string, collection: string, id: string) => string | undefined
  /**
   * Inside a transaction of this store: run `undo` if that transaction (or the nested one it is in) rolls back. Outside
   * one: nothing. How an in-memory table of a core service (the scheduler's) joins the store's transactions.
   */
  readonly onRollback: (undo: () => void) => Effect.Effect<void>
} => {
  const self = {}
  const readOnly = options.readOnly === true
  let state: State = { docs: new Map(), search: new Map(), changes: [], nextSeq: 1 }
  const versions = new Map<string, Map<string, number>>()
  for (const [m, vs] of Object.entries(options.storedVersions ?? {})) versions.set(m, new Map(Object.entries(vs)))
  const verdicts = new Map<string, ModuleUnavailable>()
  const declared = new Map<string, ReadonlyMap<string, Collection<any>>>()
  const listeners = new Set<(changes: ReadonlyArray<CommittedChange>) => void>()
  const lock = Semaphore.makeUnsafe(1)

  const copy = (s: State): State => ({ docs: new Map(s.docs), search: new Map(s.search), changes: [...s.changes], nextSeq: s.nextSeq })

  const fire = (changes: ReadonlyArray<CommittedChange>) => {
    if (changes.length === 0) return
    for (const l of listeners) {
      try {
        l(changes)
      } catch {
        // A listener must not break a commit.
      }
    }
  }

  const transaction = <X, E, R>(work: Effect.Effect<X, E, R>): Effect.Effect<X, E | StoreError, R> =>
    Effect.flatMap(Effect.service(TxRef), (tx) => {
      if (tx?.store === self) {
        return Effect.suspend(() => {
          const saved = copy(state)
          const mark = tx.pending.length
          const undoMark = tx.undo.length
          return work.pipe(Effect.onError(() => Effect.sync(() => {
            state = saved
            tx.pending.length = mark
            for (const undo of tx.undo.splice(undoMark).reverse()) undo()
          })))
        })
      }
      return lock.withPermits(1)(Effect.suspend(() => {
        const saved = copy(state)
        const frame = { store: self, pending: [] as Array<CommittedChange>, undo: [] as Array<() => void> }
        return work.pipe(
          Effect.provideService(TxRef, frame),
          Effect.onExit((exit) => Effect.sync(() => {
            if (exit._tag === "Failure") {
              state = saved
              for (const undo of frame.undo.splice(0).reverse()) undo()
            } else fire(frame.pending)
          }))
        )
      }))
    })

  /** Reads and writes outside a transaction wait for one that runs (as on SQLite's one connection). */
  const locked = <X, E>(effect: Effect.Effect<X, E>): Effect.Effect<X, E> =>
    Effect.flatMap(Effect.service(TxRef), (tx) => (tx?.store === self ? effect : lock.withPermits(1)(effect)))

  const sameScope = (a: ScopeRef, b: ScopeRef) => scopeKey(a) === scopeKey(b)
  const docsOf = (module: string, collection: string, scope: ScopeRef) =>
    [...state.docs.values()].filter((d) => d.module === module && d.collection === collection && sameScope(d.scope, scope))

  const backend: StoreBackend = {
    readOnly,
    fts5: false,
    transaction,
    afterCommit: (change) => Effect.flatMap(Effect.service(TxRef), (tx) => Effect.sync(() => (tx?.store === self ? tx.pending.push(change) : fire([change])))),
    read: (module, collection, id) => locked(Effect.sync(() => state.docs.get(key(module, collection, id)))),
    list: (module, collection, scope, q) =>
      locked(Effect.sync(() => {
        const field = (d: StoredDoc) => (q.order.column ? (q.order.field === "createdAt" ? d.createdAt : d.updatedAt) : (JSON.parse(d.text) as Record<string, unknown>)[q.order.field])
        return docsOf(module, collection, scope)
          .filter((d) => {
            if (q.where.length === 0) return true
            const value = JSON.parse(d.text) as Record<string, unknown>
            return q.where.every(([f, v]) => jsonEquals(value[f], v))
          })
          .sort((a, b) => {
            const c = compareJsonValues(field(a), field(b))
            return (q.order.desc ? -c : c) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
          })
          .slice(0, q.limit)
      })),
    search: (module, collection, scope, words, limit) =>
      locked(Effect.sync(() =>
        docsOf(module, collection, scope)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, SEARCH_SCAN_ROWS)
          .filter((d) => matchesWords(state.search.get(key(module, collection, d.id)) ?? "", words))
          .slice(0, limit)
      )),
    put: (doc, expect, search) =>
      Effect.sync(() => {
        const k = key(doc.module, doc.collection, doc.id)
        const existing = state.docs.get(k)
        if (expect === "absent" ? existing !== undefined : existing?.rev !== expect) return false
        state.docs.set(k, doc)
        if (search.length > 0) state.search.set(k, search)
        else state.search.delete(k)
        return true
      }),
    delete: (module, collection, id, expect) =>
      Effect.sync(() => {
        const k = key(module, collection, id)
        if (state.docs.get(k)?.rev !== expect) return false
        state.docs.delete(k)
        state.search.delete(k)
        return true
      }),
    rewrite: (doc, v, text) =>
      locked(Effect.sync(() => {
        const k = key(doc.module, doc.collection, doc.id)
        const now = state.docs.get(k)
        if (now !== undefined && now.rev === doc.rev) state.docs.set(k, { ...now, v, text })
      })),
    append: (change) =>
      Effect.sync(() => {
        const seq = state.nextSeq++
        state.changes.push({ ...change, seq, undone: false })
        return seq
      }),
    lastUndoable: (module, collection, actorKey) =>
      Effect.sync(() => {
        for (let i = state.changes.length - 1; i >= 0; i--) {
          const c = state.changes[i]!
          if (c.module !== module || c.collection !== collection || c.actorKey !== actorKey) continue
          if (c.undone || c.undoes !== undefined || c.op === "erase") continue
          return c
        }
        return undefined
      }),
    markUndone: (seq) =>
      Effect.sync(() => {
        state.changes = state.changes.map((c) => (c.seq === seq ? { ...c, undone: true } : c))
      }),
    changedSince: (module, collection, id, seq) =>
      Effect.sync(() => state.changes.some((c) => c.seq > seq && c.module === module && c.collection === collection && c.id === id && !c.undone && c.undoes === undefined)),
    purge: (module, collection, id) =>
      Effect.sync(() => {
        state.changes = state.changes.map((c) => {
          if (c.module !== module || c.collection !== collection || c.id !== id || c.payload === undefined) return c
          const { payload: _gone, ...rest } = c
          return rest
        })
        state.search.delete(key(module, collection, id))
      }),
    afterErase: Effect.void
  }

  const noSql = (moduleId: string): ModuleSql => {
    const fail = Effect.fail(new StoreError({ reason: "unavailable", message: "Module SQL needs the SQLite store (use makeSqliteStore({ filename: \":memory:\" }) in tests)" }))
    const prefix = sqlPrefixOf(moduleId)
    return { prefix, table: (n) => `${prefix}${n}`, fts5: false, query: () => fail, run: () => fail }
  }

  const stores = new Map<string, ReturnType<typeof makeModuleStoreOn>>()

  const prepare = (modules: ReadonlyArray<StoredModule>) =>
    Effect.sync(() => {
      for (const m of modules) {
        const collections = new Map((m.storage?.collections ?? []).map((c) => [c.name, c]))
        declared.set(m.id, collections)
        stores.delete(m.id)
        const stored = versions.get(m.id) ?? new Map<string, number>()
        const newer = [...collections.values()].find((c) => (stored.get(`collection:${c.name}`) ?? 0) > c.version)
        const sqlNewer = (stored.get("sql") ?? 0) > (m.storage?.sql?.migrations.length ?? 0)
        if (newer !== undefined || sqlNewer) {
          verdicts.set(m.id, {
            reason: newer !== undefined
              ? `Its data (${newer.name}, version ${stored.get(`collection:${newer.name}`)}) was written by a newer version of this module; update the module. The data is kept as it is.`
              : "Its data was written by a newer version of this module; update the module. The data is kept as it is."
          })
          continue
        }
        if ((m.storage?.sql?.migrations.length ?? 0) > 0) {
          verdicts.set(m.id, { reason: "It keeps SQL tables, which need the SQLite store." })
          continue
        }
        verdicts.delete(m.id)
        if (readOnly) continue
        for (const c of collections.values()) stored.set(`collection:${c.name}`, Math.max(stored.get(`collection:${c.name}`) ?? 0, c.version))
        versions.set(m.id, stored)
      }
    })

  const forModule = (moduleId: string) => {
    let s = stores.get(moduleId)
    if (s === undefined) {
      s = makeModuleStoreOn(backend, moduleId, declared.get(moduleId) ?? new Map(), noSql(moduleId))
      stores.set(moduleId, s)
    }
    return s
  }

  const oldestSeq = () => state.changes[0]?.seq ?? state.nextSeq

  const exportModule = (moduleId: string): Effect.Effect<ModuleExport, StoreError> =>
    locked(Effect.gen(function*() {
      const at = yield* Clock.currentTimeMillis
      const collections: Record<string, Array<ModuleExport["collections"][string][number]>> = {}
      for (const d of state.docs.values()) {
        if (d.module !== moduleId) continue
        ;(collections[d.collection] ??= []).push({ id: d.id, rev: d.rev, scope: d.scope, value: JSON.parse(d.text), createdAt: d.createdAt, updatedAt: d.updatedAt })
      }
      return { module: moduleId, exportedAt: at, collections, tables: {} }
    }))

  return {
    info: { kind: "memory", readOnly, fts5: false },
    prepare,
    availability: (moduleId) => verdicts.get(moduleId),
    forModule,
    transaction,
    core: (owner) => {
      const fail = Effect.fail(new StoreError({ reason: "unavailable", message: "Core SQL needs the SQLite store" }))
      return { prefix: `core_${owner}__`, query: () => fail, run: () => fail, migrate: () => fail }
    },
    changesSince: (seq, limit) =>
      locked(Effect.sync(() => {
        const after = state.changes.filter((c) => c.seq > seq)
        return {
          changes: after.slice(0, limit).map(({ actorKey: _k, ...c }) => c),
          complete: after.length <= limit,
          oldest: oldestSeq()
        }
      })),
    lastSeq: locked(Effect.sync(() => state.nextSeq - 1)),
    endConversation: (conversationId) =>
      readOnly ? Effect.succeed(0) : transaction(Effect.sync(() => {
        let n = 0
        for (const [k, d] of state.docs) {
          if (d.scope.kind === "conversation" && d.scope.id === conversationId) {
            state.docs.delete(k)
            state.search.delete(k)
            n++
          }
        }
        return n
      })),
    pruneChanges: (opts) =>
      readOnly ? Effect.fail(readOnlyError("pruneChanges")) : transaction(Effect.gen(function*() {
        const now = opts?.now ?? (yield* Clock.currentTimeMillis)
        const cut = now - (opts?.maxAgeMs ?? CHANGE_RETENTION_MS)
        const before = state.changes.length
        state.changes = state.changes.filter((c) => c.at >= cut)
        return before - state.changes.length
      })),
    backup: () => Effect.fail(new StoreError({ reason: "unavailable", message: "The in-memory store has no backups" })),
    exportModule,
    onCommit: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changeLog: () => state.changes.map(({ actorKey: _k, ...c }) => c),
    onRollback: (undo) => Effect.flatMap(Effect.service(TxRef), (tx) => Effect.sync(() => (tx?.store === self ? void tx.undo.push(undo) : undefined))),
    searchEntry: (module, collection, id) => state.search.get(key(module, collection, id))
  }
}
