import type { ModuleUnavailable } from "@pva/protocol"
import { Clock, Effect } from "effect"
import {
  CHANGE_RETENTION_MS,
  type ChangeRecord,
  type Collection,
  type CommittedChange,
  compareCodePoints,
  compareIndexed,
  type HouseholdStore,
  indexedEquals,
  matchesTokens,
  readOnlyError,
  scopeKey,
  type ScopeRef,
  type StoredModule,
  StoreError
} from "./HouseholdStore.ts"
import { endConversationsOn, makeModuleStoreOn, migrateCollectionOn, type StoreBackend, type StoredDoc } from "./ModuleStoreImpl.ts"
import { makeTransactions, type OutboxItem } from "./StoreTransactions.ts"

/**
 * The in-memory household store (`@pva/core/testing`): the semantics of the SQLite store without a database, for
 * module tests. The collection semantics are the same code (`ModuleStoreImpl.ts`) and so is the transaction model
 * (`StoreTransactions.ts`: one transaction at a time, savepoints one at a time, ended frames refused, events after the
 * commit in change-log order); the backend below keeps rows in maps and gives the same answers as SQLite's indexes
 * and search (the shared contract, `@pva/core/store-contract`, checks both). It has no backups.
 */

export interface MemoryStoreOptions {
  /** Refuse every write, like the CLI modes. */
  readonly readOnly?: boolean
  /** Versions as if a newer build had written them: `{ "<moduleId>": { "collection:<name>": 3 } }`. */
  readonly storedVersions?: Readonly<Record<string, Readonly<Record<string, number>>>>
}

interface SearchEntry {
  /** Order of the last write that set it (newest first in results), like SQLite's full-text row id. */
  readonly order: number
  readonly tokens: ReadonlyArray<string>
}

type ChangeRow = ChangeRecord & { readonly actorKey: string }

interface State {
  docs: Map<string, StoredDoc>
  search: Map<string, SearchEntry>
  changes: Array<ChangeRow>
  nextSeq: number
  nextSearch: number
}

const key = (module: string, collection: string, id: string) => `${module}\u0000${collection}\u0000${id}`
const MODULE_ID = /^[a-z][a-z0-9-]{0,39}$/

export const makeMemoryHouseholdStore = (options: MemoryStoreOptions = {}): HouseholdStore & {
  /** For assertions: every change-log row, oldest first. */
  readonly changeLog: () => ReadonlyArray<ChangeRecord>
  /** For assertions: the search words kept for a row (`undefined` when none). */
  readonly searchEntry: (module: string, collection: string, id: string) => ReadonlyArray<string> | undefined
  /**
   * Inside a transaction of this store: run `undo` if that transaction (or the savepoint it is in, or an enclosing
   * one) rolls back. Outside one: nothing. How an in-memory table of a core service (the scheduler's) joins the
   * store's transactions (`StoreTransactions.ts`, rule 5).
   */
  readonly onRollback: (undo: () => void) => Effect.Effect<void>
} => {
  const readOnly = options.readOnly === true
  let state: State = { docs: new Map(), search: new Map(), changes: [], nextSeq: 1, nextSearch: 1 }
  const versions = new Map<string, Map<string, number>>()
  for (const [m, vs] of Object.entries(options.storedVersions ?? {})) versions.set(m, new Map(Object.entries(vs)))
  const verdicts = new Map<string, ModuleUnavailable>()
  const declared = new Map<string, ReadonlyMap<string, Collection<any>>>()
  const listeners = new Set<(changes: ReadonlyArray<CommittedChange>) => void>()

  const copy = (s: State): State => ({ docs: new Map(s.docs), search: new Map(s.search), changes: [...s.changes], nextSeq: s.nextSeq, nextSearch: s.nextSearch })

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

  /** A transaction level: the whole state is put back on failure (only this level runs meanwhile, rule 2). */
  const level = <X, E, R>(work: Effect.Effect<X, E, R>) =>
    Effect.suspend(() => {
      const saved = copy(state)
      return work.pipe(Effect.onError(() => Effect.sync(() => {
        state = saved
      })))
    })

  const tx = makeTransactions({
    outer: level,
    inner: level,
    release: (items: ReadonlyArray<OutboxItem>) => {
      let run: Array<CommittedChange> = []
      for (const item of items) {
        if (item._tag === "change") {
          run.push(item.change)
          continue
        }
        fire(run)
        run = []
        try {
          item.run()
        } catch {
          // An after-commit callback must not break the others.
        }
      }
      fire(run)
    }
  })

  const sameScope = (a: ScopeRef, b: ScopeRef) => scopeKey(a) === scopeKey(b)
  const docsOf = (module: string, collection: string, scope: ScopeRef) =>
    [...state.docs.values()].filter((d) => d.module === module && d.collection === collection && sameScope(d.scope, scope))
  const fieldOf = (d: StoredDoc, field: string): unknown => {
    const value = JSON.parse(d.text) as Record<string, unknown>
    return Object.hasOwn(value, field) ? value[field] : undefined
  }

  const backend: StoreBackend = {
    readOnly,
    fts5: false,
    tx,
    read: (module, collection, id) => Effect.sync(() => state.docs.get(key(module, collection, id))),
    list: (module, collection, scope, q) =>
      Effect.sync(() => {
        const { order } = q
        const keyOf = (d: StoredDoc): ReadonlyArray<unknown> =>
          order.column
            ? [order.field === "createdAt" ? d.createdAt : d.updatedAt]
            : [fieldOf(d, order.field), d.updatedAt]
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
      }),
    search: (module, collection, scope, words, limit) =>
      Effect.sync(() =>
        docsOf(module, collection, scope)
          .flatMap((d) => {
            const entry = state.search.get(key(module, collection, d.id))
            return entry !== undefined && matchesTokens(entry.tokens, words) ? [{ d, order: entry.order }] : []
          })
          .sort((a, b) => b.order - a.order)
          .slice(0, limit)
          .map((x) => x.d)
      ),
    append: (change) =>
      Effect.sync(() => {
        const seq = state.nextSeq++
        state.changes.push({ ...change, seq, rev: seq, undone: false })
        return seq
      }),
    put: (doc, expect, tokens) =>
      Effect.sync(() => {
        const k = key(doc.module, doc.collection, doc.id)
        const existing = state.docs.get(k)
        if (expect === "absent" ? existing !== undefined : existing === undefined || existing.rev !== expect || !sameScope(existing.scope, doc.scope)) return false
        state.docs.set(k, doc)
        if (tokens.length > 0) state.search.set(k, { order: state.nextSearch++, tokens })
        else state.search.delete(k)
        return true
      }),
    remove: (module, collection, id, scope, expect) =>
      Effect.sync(() => {
        const k = key(module, collection, id)
        const existing = state.docs.get(k)
        if (existing === undefined || existing.rev !== expect || !sameScope(existing.scope, scope)) return false
        state.docs.delete(k)
        state.search.delete(k)
        return true
      }),
    lastUndoable: (module, collection, actorKey, scope) =>
      Effect.sync(() => {
        for (let i = state.changes.length - 1; i >= 0; i--) {
          const c = state.changes[i]!
          if (c.module !== module || c.collection !== collection || c.actorKey !== actorKey || !sameScope(c.scope, scope)) continue
          if (c.undone || c.undoes !== undefined || c.op === "erase" || c.payload === undefined) continue
          const { actorKey: _k, ...record } = c
          return record
        }
        return undefined
      }),
    markUndone: (seq) =>
      Effect.sync(() => {
        state.changes = state.changes.map((c) => (c.seq === seq ? { ...c, undone: true } : c))
      }),
    changedSince: (module, collection, id, seq) =>
      Effect.sync(() => state.changes.some((c) => c.seq > seq && c.module === module && c.collection === collection && c.id === id && !c.undone && c.undoes === undefined)),
    purge: (module, collection, id, scope) =>
      Effect.sync(() => {
        state.changes = state.changes.map((c) => {
          if (c.module !== module || c.collection !== collection || c.id !== id || !sameScope(c.scope, scope) || c.payload === undefined) return c
          const { payload: _gone, ...rest } = c
          return rest
        })
      }),
    scan: (module, collection, afterId, limit) =>
      Effect.sync(() =>
        [...state.docs.values()]
          .filter((d) => d.module === module && d.collection === collection && compareCodePoints(d.id, afterId) > 0)
          .sort((a, b) => compareCodePoints(a.id, b.id))
          .slice(0, limit)
      ),
    rewrite: (doc, v, text, tokens) =>
      Effect.sync(() => {
        const k = key(doc.module, doc.collection, doc.id)
        const now = state.docs.get(k)
        if (now === undefined) return
        state.docs.set(k, { ...now, v, text })
        const entry = state.search.get(k)
        if (tokens.length === 0) state.search.delete(k)
        else state.search.set(k, { order: entry?.order ?? state.nextSearch++, tokens })
      }),
    scrub: () => {}
  }

  const conversations = {
    docs: (conversationId: string | undefined) =>
      Effect.sync(() => [...state.docs.values()].filter((d) => d.scope.kind === "conversation" && (conversationId === undefined || d.scope.id === conversationId))),
    purge: (conversationId: string | undefined, keep: ReadonlyArray<string>) =>
      Effect.sync(() => {
        state.changes = state.changes.map((c) => {
          if (c.scope.kind !== "conversation" || (conversationId !== undefined && c.scope.id !== conversationId) || c.payload === undefined || keep.includes(c.module)) return c
          const { payload: _gone, ...rest } = c
          return rest
        })
      })
  }

  const stores = new Map<string, ReturnType<typeof makeModuleStoreOn>>()

  const prepareOne = (m: StoredModule) =>
    Effect.gen(function*() {
      const collections = new Map((m.storage?.collections ?? []).map((c) => [c.name, c]))
      declared.set(m.id, collections)
      stores.delete(m.id)
      verdicts.delete(m.id)
      if (!MODULE_ID.test(m.id)) return void verdicts.set(m.id, { reason: "Its id cannot key stored data." })
      const stored = versions.get(m.id) ?? new Map<string, number>()
      const newer = [...collections.values()].find((c) => (stored.get(`collection:${c.name}`) ?? 0) > c.version)
      if (newer !== undefined) {
        return void verdicts.set(m.id, {
          reason: `Its data (${newer.name}, version ${stored.get(`collection:${newer.name}`)}) was written by a newer version of this module; update the module. The data is kept as it is.`
        })
      }
      const pending = [...collections.values()].filter((c) => (stored.get(`collection:${c.name}`) ?? 0) < c.version)
      if (pending.length === 0) return
      if (readOnly) {
        if (pending.some((c) => stored.has(`collection:${c.name}`))) verdicts.set(m.id, { reason: "Its stored data needs an upgrade, which the server makes when it starts (pnpm start serve)." })
        return
      }
      const upgraded = yield* Effect.result(tx.transaction(Effect.forEach(pending, (c) => migrateCollectionOn(backend, m.id, c), { discard: true })))
      if (upgraded._tag === "Failure") {
        return void verdicts.set(m.id, { reason: `Its data could not be upgraded (${upgraded.failure.message}); it was left as it was.` })
      }
      for (const c of pending) stored.set(`collection:${c.name}`, c.version)
      versions.set(m.id, stored)
    })

  const forModule = (moduleId: string) => {
    let s = stores.get(moduleId)
    if (s === undefined) {
      s = makeModuleStoreOn(backend, moduleId, declared.get(moduleId) ?? new Map(), () => verdicts.get(moduleId))
      stores.set(moduleId, s)
    }
    return s
  }

  const oldestSeq = () => state.changes[0]?.seq ?? state.nextSeq

  return {
    info: { kind: "memory", readOnly, fts5: false },
    prepare: (modules) => Effect.forEach(modules, prepareOne, { discard: true }),
    availability: (moduleId) => verdicts.get(moduleId),
    forModule,
    transaction: tx.transaction,
    afterCommit: (f) => tx.enqueue({ _tag: "run", run: f }),
    core: (owner) => {
      const fail = Effect.fail(new StoreError({ reason: "unavailable", message: "Core SQL needs the SQLite store" }))
      return { prefix: `core_${owner}__`, query: () => fail, run: () => fail, migrate: () => fail }
    },
    changesSince: (seq, limit) =>
      tx.statement(Effect.sync(() => {
        const after = state.changes.filter((c) => c.seq > seq)
        return {
          changes: after.slice(0, limit).map(({ actorKey: _k, ...c }) => c),
          complete: after.length <= limit,
          oldest: oldestSeq()
        }
      })),
    lastSeq: tx.statement(Effect.sync(() => state.nextSeq - 1)),
    endConversation: (conversationId) => (readOnly ? Effect.succeed(0) : endConversationsOn(backend, conversations, conversationId, () => [...verdicts.keys()])),
    sweepConversations: readOnly ? Effect.succeed(0) : endConversationsOn(backend, conversations, undefined, () => [...verdicts.keys()]),
    pruneChanges: (opts) =>
      readOnly ? Effect.fail(readOnlyError("pruneChanges")) : tx.transaction(Effect.gen(function*() {
        const now = opts?.now ?? (yield* Clock.currentTimeMillis)
        const cut = now - (opts?.maxAgeMs ?? CHANGE_RETENTION_MS)
        const before = state.changes.length
        state.changes = state.changes.filter((c) => c.at >= cut)
        return before - state.changes.length
      })),
    backup: () => Effect.fail(new StoreError({ reason: "unavailable", message: "The in-memory store has no backups" })),
    onCommit: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    changeLog: () => state.changes.map(({ actorKey: _k, ...c }) => c),
    onRollback: (undo) => Effect.orDie(tx.onRollback(undo)),
    searchEntry: (module, collection, id) => state.search.get(key(module, collection, id))?.tokens
  }
}
