import { ActionError, type Actor, type Collection, CurrentTurn, type ModuleStore, type ParamOption, resolveOption, type Row, type StoreFailure, type StoreTx, type TxCollection, type WriteOptions } from "@pva/core"
import { convertAmount, type UnitId } from "@pva/language"
import { type Language, LISTS_LIMITS, say } from "@pva/module-contracts"
import { Deferred, Effect, Exit, Semaphore } from "effect"
import {
  type Item,
  ITEM_PAGE,
  items,
  type ItemStatus,
  listPhrase,
  type ListRow,
  lists,
  matchOf,
  MAX_CLEAR,
  MAX_LISTS,
  MAX_LIVE_LISTS,
  MAX_OPEN,
  normalise,
  placeOf,
  type Quantity,
  SHOPPING,
  TODO,
  undo,
  type UndoEntry,
  type UndoMerge,
  type UndoStep,
  UNDO_WINDOW_MS,
  withStatus,
  withText
} from "./data.ts"
import { addAmounts, type SaidItem, sayItem } from "./parse.ts"
import { texts } from "./texts.ts"

/** The most rows a turn's scan of one list's items reads: every open item a list may have (32 indexed reads of 16). */
export const SCAN_ROWS = MAX_OPEN

/** Phrase commands kept for replay (the oldest finished one goes first). */
export const RECORDS_KEPT = 256

const DEFAULTS: ReadonlyArray<{ readonly id: string; readonly kind: "shopping" | "todo" }> = [{ id: SHOPPING, kind: "shopping" }, { id: TODO, kind: "todo" }]

/** Other names of the two default lists, in both languages (the household may say either). */
const DEFAULT_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  [SHOPPING]: ["shopping", "shopping list", "groceries", "grocery list", "list", "the list", "boodschappen", "boodschappenlijst", "boodschappenlijstje", "lijst", "lijstje"],
  [TODO]: ["to do", "to-do", "todo", "to do list", "to-do list", "todo list", "tasks", "task list", "takenlijst", "taken", "to-dolijst", "te doen"]
}

/** A list's choice value when it was said as the speaker's own ("my shopping list"): there are no personal lists. */
const MINE = "~mine"

/** A list choice's value as a list id, and whether it was said as the speaker's own. */
export const listChoice = (value: string | undefined): { readonly list: string | undefined; readonly mine: boolean } =>
  value !== undefined && value.endsWith(MINE) ? { list: value.slice(0, -MINE.length), mine: true } : { list: value, mine: false }

/** A list the household has now: a default one (whether or not its row exists yet) or a named one that is not deleted. */
export interface LiveList {
  readonly id: string
  readonly row: ListRow | undefined
  readonly rev: number | undefined
}

export interface AddResult {
  readonly kind: "ok"
  readonly added: ReadonlyArray<string>
  readonly already: ReadonlyArray<string>
}

/** Who an operation is undone for: the conversation's undo row, or nobody (a job, a routine without a turn). */
export type UndoKey = string | undefined

export type UndoResult = "nothing" | "changed" | "done" | "partly"

const defaultRow = (kind: "shopping" | "todo"): ListRow => ({ kind, open: 0, done: 0 })

export type RefusalReason = "full" | "gone" | "changed" | "taken" | "too-many"

/** Thrown inside a transaction to roll it back with nothing written; caught right outside it. */
class Refusal {
  readonly reason: RefusalReason
  constructor(reason: RefusalReason) {
    this.reason = reason
  }
}

/** Run a transaction whose function may refuse (`Refusal`): the refusal rolls it back and is answered as a value. */
const refusable = <X>(store: ModuleStore, f: (tx: StoreTx) => X): Effect.Effect<X | Refusal, StoreFailure> =>
  store.transaction((tx) => {
    try {
      return f(tx) as never
    } catch (e) {
      if (e instanceof Refusal) {
        // A refusal is decided before the function writes anything, so nothing is rolled back but the reads.
        return e as never
      }
      throw e
    }
  }) as Effect.Effect<X | Refusal, StoreFailure>

export const isRefusal = (x: unknown): x is Refusal => x instanceof Refusal

/** A transaction's handle that notes the lists written through it (`touched`); everything else as it is. */
const watched = (tx: StoreTx, touched: Set<string>): StoreTx => ({
  publish: tx.publish,
  afterCommit: tx.afterCommit,
  onRollback: tx.onRollback,
  collection: <A>(c: Collection<A>): TxCollection<A> => {
    const inner = tx.collection(c)
    if (c.name === lists.name) {
      return {
        ...inner,
        insert: (v, o) => {
          const row = inner.insert(v, o)
          touched.add(row.id)
          return row
        },
        update: (id, f, o) => (touched.add(id), inner.update(id, f, o)),
        remove: (id, o) => (touched.add(id), inner.remove(id, o))
      }
    }
    if (c.name === items.name) {
      const listOf = (v: A) => (v as unknown as Item).list
      return {
        ...inner,
        insert: (v, o) => (touched.add(listOf(v)), inner.insert(v, o)),
        update: (id, f, o) =>
          inner.update(id, (v) => {
            const next = f(v)
            touched.add(listOf(v))
            touched.add(listOf(next))
            return next
          }, o),
        remove: (id, o) => {
          const row = inner.get(id, o)
          if (row !== undefined) touched.add(listOf(row.value))
          return inner.remove(id, o)
        }
      }
    }
    return inner
  }
})

/**
 * The lists module's work on the store: shared by its tools, actions, service and job. One per module (`shared`),
 * with a cache of the list rows (at most `MAX_LISTS`, one read) for the synchronous list choices of the typed actions.
 */
export const makeEngine = (rawStore: ModuleStore) => {
  /** Called after every committed transaction of the module with the lists it touched (what shows a list follows its data); set by `shared`. */
  let onChange: (touched: ReadonlySet<string>) => void = () => {}
  /**
   * The module's store: every transaction of the lists and items (tools, actions, service, clean-up, undo) tells
   * `onChange` which lists it wrote: a list row's id, and the list of every item it inserted, changed or removed.
   */
  const store: ModuleStore = {
    moduleId: rawStore.moduleId,
    readOnly: rawStore.readOnly,
    collection: (c) => rawStore.collection(c),
    transaction: (f) => {
      const touched = new Set<string>()
      return rawStore.transaction((tx) => {
        const result = f(watched(tx, touched))
        tx.afterCommit(() => onChange(touched))
        return result
      })
    }
  }
  const listStore = store.collection(lists)
  const itemStore = store.collection(items)
  const undoStore = store.collection(undo)
  let cache: ReadonlyArray<Row<ListRow>> = []
  /**
   * One at a time: every operation that reads and then writes lists or items (each tool, action and service call,
   * each step of the nightly clean-up), and every read that reports a count with items, runs under this one permit,
   * so no two of them interleave. What decides outside the transaction it writes in still checks again inside it.
   */
  const lock = Semaphore.makeUnsafe(1)
  const serial = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => lock.withPermits(1)(effect)

  /** The outcome of a phrase command, kept by the invocation's identity: what was said, or the sentence it failed with. */
  type Replied = { readonly say: string } | { readonly fail: string }
  const records = new Map<string, { readonly deferred: Deferred.Deferred<Replied>; finished: boolean }>()
  /**
   * Runs a phrase command once for its invocation's identity (assistant, conversation, turn, device, the operation and
   * what it was asked): a repeat, a concurrent one too, gets the first outcome and changes nothing; a new invocation
   * has a new turn and acts again. Only phrase turns are kept (a model's or a typed call is the caller's own business);
   * outside a turn there is no identity. One bounded record: finished operations are forgotten oldest first, and an
   * operation still running is never forgotten.
   */
  const once = (operation: string, asked: string, run: (complete: (effect: Effect.Effect<{ readonly say: string }, ActionError>) => Effect.Effect<{ readonly say: string }, ActionError>) => Effect.Effect<{ readonly say: string }, ActionError>, aborted: string): Effect.Effect<{ readonly say: string }, ActionError> =>
    Effect.gen(function*() {
      const turn = yield* CurrentTurn
      if (turn === undefined || turn.source !== "phrase") return yield* run((effect) => effect)
      const key = [operation, turn.assistantId, turn.conversationId, turn.turnId, turn.deviceId, asked].join("\u0000")
      const kept = records.get(key)
      if (kept !== undefined) {
        const first = yield* Deferred.await(kept.deferred)
        return "say" in first ? { say: first.say } : yield* Effect.fail(new ActionError({ message: first.fail }))
      }
      const mine = { deferred: Deferred.makeUnsafe<Replied>(), finished: false }
      records.set(key, mine)
      if (records.size > RECORDS_KEPT) {
        for (const [k, r] of records) {
          if (records.size <= RECORDS_KEPT) break
          if (r.finished) records.delete(k)
        }
      }
      const finish = (outcome: Replied) => Effect.suspend(() => {
        mine.finished = true
        return Deferred.succeed(mine.deferred, outcome)
      })
      const completed = (exit: Exit.Exit<{ readonly say: string }, ActionError>) => {
        if (Exit.isSuccess(exit)) return finish({ say: exit.value.say })
        const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
        return finish({ fail: failure !== undefined ? (failure.error as ActionError).message : aborted })
      }
      // Only the bounded write and its reply are protected; reads and waiting for the permit can still be interrupted.
      // Finish the replay record inside that protection, before a pending interruption reaches the caller.
      return yield* run((effect) => Effect.uninterruptible(Effect.onExit(effect, completed))).pipe(
        Effect.onExit((exit) => {
          if (mine.finished) return Effect.void
          if (Exit.isSuccess(exit)) return finish({ say: exit.value.say })
          const failure = exit.cause.reasons.find((r) => r._tag === "Fail")
          if (failure !== undefined && exit.cause.reasons.length === 1) return finish({ fail: (failure.error as ActionError).message })
          // Cut short (interrupted, a defect): nothing was decided, so a retry runs; whoever waited is told it did not finish.
          return Effect.sync(() => void (records.get(key) === mine && records.delete(key))).pipe(Effect.andThen(finish({ fail: aborted })))
        })
      )
    })

  /** Read every list (one read: the at most `MAX_LISTS` rows fit one page) and keep them for the choices. */
  const loadLists = Effect.map(listStore.list({ limit: MAX_LISTS + 1 }), (rows) => {
    cache = rows
    return rows
  })

  /** The two default lists' rows, made when the module starts, so they are always counted in the bound of `MAX_LISTS`. */
  const ensureDefaults = serial(store.transaction((tx) => {
    for (const d of DEFAULTS) if (tx.collection(lists).get(d.id) === undefined) tx.collection(lists).insert(defaultRow(d.kind), { id: d.id })
  }))

  /** The lists the household has now, default ones first, then named ones as made. */
  const liveLists = (rows: ReadonlyArray<Row<ListRow>> = cache): ReadonlyArray<LiveList> => {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const defaults = DEFAULTS.map(({ id }) => ({ id, row: byId.get(id)?.value, rev: byId.get(id)?.rev }))
    const named = rows.filter((r) => r.id !== SHOPPING && r.id !== TODO && r.value.deletedAt === undefined).toSorted((a, b) => a.createdAt - b.createdAt)
    return [...defaults, ...named.map((r) => ({ id: r.id, row: r.value, rev: r.rev }))]
  }

  /**
   * The choices of a list parameter, in the household's language, with the other names people use. With `mine`, each
   * list also as the speaker's own ("my shopping list", "mijn boodschappenlijst"), whose value says so (`listChoice`):
   * there are no personal lists, so it is the household's list, and the answer says that.
   */
  const options = (lang: Language, mine = false): ReadonlyArray<ParamOption> => {
    const plain = liveLists().map(({ id, row }): ParamOption => {
      if (id === SHOPPING || id === TODO) {
        const label = listPhrase(id, row, lang).replace(/^(the|de) /, "")
        return { value: id, label, aliases: DEFAULT_ALIASES[id]! }
      }
      const name = row?.name ?? id
      return { value: id, label: name, aliases: [`${name} list`, `${name}lijst`, `lijst ${name}`] }
    })
    if (!mine) return plain
    const own = plain.map((o): ParamOption => {
      const names = [o.label, ...(o.aliases ?? [])]
      return { value: `${o.value}${MINE}`, label: `${lang === "nl" ? "mijn" : "my"} ${o.label}`, aliases: names.flatMap((n) => [`my ${n}`, `mijn ${n}`]) }
    })
    return [...plain, ...own]
  }

  /** The list some words name, or `undefined`. */
  const resolveList = (words: string, lang: Language): string | undefined => {
    const trimmed = words.trim()
    if (trimmed === "") return undefined
    return resolveOption(options(lang), trimmed)?.value
  }

  /** Every name a default list answers to, in both languages: a new list may not take one. */
  const defaultNames = (): ReadonlyArray<string> =>
    DEFAULTS.flatMap(({ id }) => [listPhrase(id, undefined, "en"), listPhrase(id, undefined, "nl"), ...DEFAULT_ALIASES[id]!].map((n) => n.replace(/^(the|de) /, "")))

  // -- inside a transaction ---------------------------------------------------------------------------------------

  /** The list's row, made first for a default list; `undefined` for a list that is gone or deleted. */
  const ensureList = (tx: StoreTx, id: string): Row<ListRow> | undefined => {
    const l = tx.collection(lists)
    const row = l.get(id)
    if (row !== undefined) return row.value.deletedAt === undefined ? row : undefined
    const d = DEFAULTS.find((x) => x.id === id)
    return d === undefined ? undefined : l.insert(defaultRow(d.kind), { id })
  }

  /** A list's counts changed by deltas, in the transaction that changed its items (`actor`: the job's, from the job). */
  const bump = (tx: StoreTx, id: string, open: number, done: number, options?: WriteOptions): Row<ListRow> =>
    tx.collection(lists).update(id, (v) => ({ ...v, open: Math.min(MAX_OPEN, Math.max(0, v.open + open)), done: Math.max(0, v.done + done) }), options)

  /** Write the conversation's undo entry (one level: it replaces the last one). */
  const remember = (tx: StoreTx, key: UndoKey, entry: UndoEntry) => {
    if (key === undefined) return
    const u = tx.collection(undo)
    if (u.get(key) === undefined) u.insert(entry, { id: key })
    else u.update(key, () => entry)
  }

  /**
   * When an item opened now goes: a millisecond after the newest open one (one indexed read) when that is not before
   * now, so items keep the order they were added in, also two adds in the same millisecond and items said together.
   */
  const nextSince = (tx: StoreTx, list: string, now: number): number => {
    const newest = tx.collection(items).list({ where: { place: placeOf(list, "open") }, orderBy: { field: "since", direction: "desc" }, limit: 1 })[0]
    return newest === undefined || newest.value.since < now ? now : newest.value.since + 1
  }

  /** The quantity of `existing` with `extra` added: the same unit, or one `@pva/language` converts; else `undefined`. */
  const sumOf = (existing: Quantity, extra: Quantity): Quantity | undefined => {
    if (existing.unit === extra.unit) {
      const amount = addAmounts(existing.amount, extra.amount)
      return amount <= LISTS_LIMITS.maxAmount ? { ...existing, amount } : undefined
    }
    if (existing.unit === undefined || extra.unit === undefined) return undefined
    const converted = convertAmount(extra.amount, extra.unit as UnitId, existing.unit as UnitId)
    if (converted === undefined) return undefined
    const amount = addAmounts(existing.amount, converted)
    return amount <= LISTS_LIMITS.maxAmount ? { amount, unit: existing.unit } : undefined
  }

  /** The item `text` names on a list in one status, by its indexed `match`: the oldest open one, or the newest of another status. */
  const exactIn = (tx: StoreTx, list: string, text: string, status: ItemStatus): Row<Item> | undefined =>
    tx.collection(items).list({ where: { match: matchOf(list, text, status) }, orderBy: { field: "since", direction: status === "open" ? "asc" : "desc" }, limit: 1 })[0]

  /**
   * Add what was said to a list, in one transaction. Said items are taken in order against what the list has and what
   * this request already planned, so "two litres of milk and 500 ml of milk" is one item of 2.5 l. With `merge`, an
   * item said again adds its amount to an open item of that name whose amount it can be added to (the same unit, or
   * one `@pva/language` converts), or gives one without an amount its amount; an amount of another kind ("a bag" beside
   * "1 kg") is a second item of the same name with its own amount, never lost and never hidden; said without an
   * amount, an open item is already there; a ticked-off one is put back on the list. Without `merge`, everything said
   * is a new item. Refuses `full` before writing anything when the list would pass `MAX_OPEN`. Every change it makes
   * is recorded for undo with the item's whole state before it (status, amount and note, also their absence).
   */
  const addIn = (tx: StoreTx, list: string, said: ReadonlyArray<SaidItem>, merge: boolean, now: number, lang: Language) => {
    const listRow = ensureList(tx, list)
    if (listRow === undefined) throw new Refusal("gone")
    const t = tx.collection(items)
    /** An item this request adds, or one the list has that it may change; plan first (reads only), so a refusal writes nothing. */
    interface Slot {
      readonly row?: Row<Item>
      text: string
      quantity: Quantity | undefined
      kind: "new" | "open" | "reopen"
      touched: boolean
      /** Said without an amount while the list had it open: "already has". */
      already?: string
    }
    const slots: Array<Slot> = []
    const byKey = new Map<string, { readonly open: Array<Slot>; done: Row<Item> | undefined; doneRead: boolean }>()
    const touch = (slot: Slot) => {
      if (!slot.touched) {
        slot.touched = true
        if (!slots.includes(slot)) slots.push(slot)
      }
    }
    for (const s of said) {
      if (!merge) {
        touch({ text: s.text, quantity: s.quantity, kind: "new", touched: false })
        continue
      }
      const key = normalise(s.text)
      let known = byKey.get(key)
      if (known === undefined) {
        const open = t.list({ where: { match: matchOf(list, s.text, "open") }, orderBy: { field: "since", direction: "asc" }, limit: ITEM_PAGE })
        known = { open: open.map((row) => ({ row, text: row.value.text, quantity: row.value.quantity, kind: "open" as const, touched: false })), done: undefined, doneRead: false }
        byKey.set(key, known)
      }
      const add = (slot: Slot) => {
        known!.open.push(slot)
        touch(slot)
      }
      const reopen = (quantity: Quantity | undefined) => {
        if (!known!.doneRead) {
          known!.done = exactIn(tx, list, s.text, "done")
          known!.doneRead = true
        }
        const row = known!.done
        if (row === undefined) return false
        known!.done = undefined
        add({ row, text: row.value.text, quantity: quantity ?? row.value.quantity, kind: "reopen", touched: false })
        return true
      }
      const open = known.open
      if (s.quantity === undefined) {
        const first = open[0]
        if (first !== undefined) {
          if (!first.touched && first.kind === "open") first.already ??= s.text
          continue
        }
        if (!reopen(undefined)) add({ text: s.text, quantity: undefined, kind: "new", touched: false })
        continue
      }
      const extra = s.quantity
      const summable = open.find((slot) => slot.quantity !== undefined && sumOf(slot.quantity, extra) !== undefined)
      if (summable !== undefined) {
        summable.quantity = sumOf(summable.quantity!, extra)
        touch(summable)
        continue
      }
      const bare = open.find((slot) => slot.quantity === undefined)
      if (bare !== undefined) {
        bare.quantity = extra
        touch(bare)
        continue
      }
      // Open ones of another kind of amount: a second item. None open: a ticked-off one put back, else a new one.
      if (open.length > 0 || !reopen(extra)) add({ text: s.text, quantity: extra, kind: "new", touched: false })
    }
    const opening = slots.filter((slot) => slot.kind !== "open").length
    if (listRow.value.open + opening > MAX_OPEN) throw new Refusal("full")
    const steps: Array<UndoStep> = []
    const merged: Array<UndoMerge> = []
    const added: Array<string> = []
    let reopened = 0
    let order = nextSince(tx, list, now) - now
    for (const slot of slots) {
      if (slot.kind === "new") {
        const value: Item = {
          list,
          text: slot.text,
          ...(slot.quantity !== undefined ? { quantity: slot.quantity } : {}),
          status: "open",
          place: placeOf(list, "open"),
          since: now + order++,
          match: matchOf(list, slot.text, "open")
        }
        const row = t.insert(value)
        steps.push({ id: row.id, rev: row.rev, from: "absent" })
        added.push(sayItem(value.text, value.quantity, lang))
        continue
      }
      const found = slot.row!
      const at = now + order++
      const row = t.update(found.id, (v) => {
        const next = slot.kind === "reopen" ? withStatus(v, "open", at) : v
        const { quantity: _q, ...rest } = next
        return slot.quantity === undefined ? rest : { ...rest, quantity: slot.quantity }
      }, { expectRev: found.rev })
      if (slot.kind === "reopen") {
        steps.push({ id: row.id, rev: row.rev, from: "done", since: found.value.since })
        reopened++
      }
      // Its amount and note before, their absence included: undo puts back exactly what was there.
      merged.push({
        id: row.id,
        rev: row.rev,
        ...(found.value.quantity !== undefined ? { quantity: found.value.quantity } : {}),
        ...(found.value.note !== undefined ? { note: found.value.note } : {})
      })
      added.push(sayItem(row.value.text, row.value.quantity, lang))
    }
    const already = [...byKey.values()].flatMap((k) => k.open.filter((slot) => slot.already !== undefined && !slot.touched).map((slot) => slot.already!))
    const after = steps.length + merged.length > 0 ? bump(tx, list, opening, -reopened) : listRow
    return { added, already, steps, merged, listRev: after.rev }
  }

  /** Every row of one list in one status, oldest first, page by page: at most `limit` rows, and whether there were more. */
  const scan = (list: string, status: ItemStatus, limit: number, direction: "asc" | "desc" = "asc") =>
    Effect.gen(function*() {
      const rows: Array<Row<Item>> = []
      let after: Row<Item> | undefined
      while (rows.length < limit) {
        const want = Math.min(ITEM_PAGE, limit - rows.length)
        const got = yield* itemStore.list({ where: { place: placeOf(list, status) }, orderBy: { field: "since", direction }, limit: want, ...(after !== undefined ? { after } : {}) })
        rows.push(...got)
        if (got.length < want) return { rows, cut: false }
        after = got.at(-1)
      }
      const beyond = yield* itemStore.list({ where: { place: placeOf(list, status) }, orderBy: { field: "since", direction }, limit: 1, ...(after !== undefined ? { after } : {}) })
      return { rows, cut: beyond.length > 0 }
    })

  /** The item `text` names on a list in one status, by its indexed `match` (one read): the oldest open one, the newest ticked-off one. */
  const exact = (list: string, text: string, status: ItemStatus) =>
    Effect.map(itemStore.list({ where: { match: matchOf(list, text, status) }, orderBy: { field: "since", direction: status === "open" ? "asc" : "desc" }, limit: 1 }), (rows) => rows[0])

  /** What a find answers: the row, or none; `cut` when a scan stopped at its bound, so "not on the list" is not known. */
  interface Found {
    readonly row: Row<Item> | undefined
    readonly cut: boolean
  }

  /**
   * The item `text` names on a list: an open one by its match (one indexed read), then (with `done`) a ticked-off one,
   * else the closest name among its open items (and ticked-off ones, the newest first, with `done`), by the core's own
   * name matching (sound and one edit away). Bounded by `SCAN_ROWS` per status; `cut` says a scan reached its bound.
   */
  const find = (list: string, text: string, done: boolean) =>
    Effect.gen(function*() {
      const open = yield* exact(list, text, "open")
      if (open !== undefined) return { row: open, cut: false } satisfies Found
      if (done) {
        const ticked = yield* exact(list, text, "done")
        if (ticked !== undefined) return { row: ticked, cut: false } satisfies Found
      }
      const statuses: ReadonlyArray<ItemStatus> = done ? ["open", "done"] : ["open"]
      let cut = false
      const wanted = normalise(text)
      for (const status of statuses) {
        const scanned = yield* scan(list, status, SCAN_ROWS, status === "open" ? "asc" : "desc")
        cut ||= scanned.cut
        const same = scanned.rows.find((r) => normalise(r.value.text) === wanted)
        if (same !== undefined) return { row: same, cut: false } satisfies Found
        const option = resolveOption(scanned.rows.map((r) => ({ value: r.id, label: r.value.text })), text)
        if (option !== undefined) return { row: scanned.rows.find((r) => r.id === option.value), cut: false } satisfies Found
      }
      return { row: undefined, cut } satisfies Found
    })

  /**
   * The list an item is on when no list was named: an open item by its exact name on any list (default lists first),
   * then a ticked-off one (with `done`), else the closest name on the shopping list, then the to-do list.
   */
  const findAnywhere = (text: string, done: boolean) =>
    Effect.gen(function*() {
      const live = liveLists(yield* loadLists)
      for (const status of (done ? ["open", "done"] : ["open"]) as ReadonlyArray<ItemStatus>) {
        for (const l of live) {
          const row = yield* exact(l.id, text, status)
          if (row !== undefined) return { list: l.id, row, cut: false }
        }
      }
      let cut = false
      for (const id of [SHOPPING, TODO]) {
        const found = yield* find(id, text, done)
        if (found.row !== undefined) return { list: id, row: found.row, cut: false }
        cut ||= found.cut
      }
      return { list: undefined, row: undefined, cut }
    })

  /** Tick off or remove rows found before (each still at the rev it was read at, or the whole change is a conflict). */
  const setStatus = (list: string, rows: ReadonlyArray<Row<Item>>, to: "done" | "removed", op: "complete" | "remove" | "clear", key: UndoKey, now: number, actor?: Actor) =>
    refusable(store, (tx) => {
      if (ensureList(tx, list) === undefined) throw new Refusal("gone")
      const t = tx.collection(items)
      const steps: Array<UndoStep> = []
      let open = 0
      let done = 0
      // Each a millisecond after the one before: the newest first is the last one said.
      let order = 0
      for (const r of rows) {
        const from = r.value.status
        if (from === to) continue
        const at = now + order++
        const row = t.update(r.id, (v) => withStatus(v, to, at), { expectRev: r.rev, ...(actor !== undefined ? { actor } : {}) })
        steps.push({ id: row.id, rev: row.rev, from, since: r.value.since })
        if (from === "open") open--
        if (from === "done") done--
        if (to === "done") done++
      }
      if (steps.length === 0) return 0
      const after = bump(tx, list, open, done, actor !== undefined ? { actor } : undefined)
      remember(tx, key, { at: now, op, list, listRev: after.rev, steps })
      return steps.length
    })

  /** Take up to `MAX_CLEAR` ticked-off items off a list (the oldest first), as one change that can be undone. */
  const clear = (list: string, key: UndoKey, now: number) =>
    Effect.gen(function*() {
      const { rows, cut } = yield* scan(list, "done", MAX_CLEAR)
      if (rows.length === 0) return { count: 0, more: false }
      const result = yield* setStatus(list, rows, "removed", "clear", key, now)
      if (isRefusal(result)) return result
      return { count: result, more: cut }
    })

  /** Change an item found before: its text, amount, note, or put it back on the list. */
  const update = (
    list: string,
    found: Row<Item>,
    change: { readonly text?: string; readonly quantity?: Quantity | null; readonly note?: string | null; readonly reopen?: boolean },
    key: UndoKey,
    now: number
  ) =>
    refusable(store, (tx) => {
      const listRow = ensureList(tx, list)
      if (listRow === undefined) throw new Refusal("gone")
      const reopening = change.reopen === true && found.value.status === "done"
      if (reopening && listRow.value.open + 1 > MAX_OPEN) throw new Refusal("full")
      const before = found.value
      const at = reopening ? nextSince(tx, list, now) : now
      const row = tx.collection(items).update(found.id, (v) => {
        let next: Item = reopening ? withStatus(v, "open", at) : v
        if (change.text !== undefined) next = withText(next, change.text)
        if (change.quantity === null) {
          const { quantity: _q, ...rest } = next
          next = rest
        } else if (change.quantity !== undefined) next = { ...next, quantity: change.quantity }
        if (change.note === null) {
          const { note: _n, ...rest } = next
          next = rest
        } else if (change.note !== undefined) next = { ...next, note: change.note }
        return next
      }, { expectRev: found.rev })
      // Always touches the list, so an undo of the list's making sees that it changed since.
      bump(tx, list, reopening ? 1 : 0, reopening ? -1 : 0)
      remember(tx, key, {
        at: now,
        op: "update",
        list,
        steps: [{ id: row.id, rev: row.rev, from: before.status, since: before.since }],
        before: { text: before.text, ...(before.quantity !== undefined ? { quantity: before.quantity } : {}), ...(before.note !== undefined ? { note: before.note } : {}) }
      })
      return row
    })

  /** Add to a list, as one change that can be undone. */
  const add = (list: string, said: ReadonlyArray<SaidItem>, merge: boolean, key: UndoKey, now: number, lang: Language) =>
    refusable(store, (tx) => {
      const r = addIn(tx, list, said, merge, now, lang)
      if (r.steps.length + r.merged.length > 0) remember(tx, key, { at: now, op: "add", list, steps: r.steps, ...(r.merged.length > 0 ? { merged: r.merged } : {}) })
      return { kind: "ok", added: r.added, already: r.already } satisfies AddResult
    })

  /**
   * A new named list, with its first items, as one change that can be undone. Its name and both limits are decided
   * inside the transaction that makes it, on the catalogue as it is then: two devices making "Camping" at once make
   * one, and the 31st list is never made.
   */
  const create = (name: string, kind: "shopping" | "todo" | "generic", said: ReadonlyArray<SaidItem>, key: UndoKey, now: number, lang: Language) =>
    Effect.gen(function*() {
      const id = globalThis.crypto.randomUUID()
      const wanted = normalise(name)
      const reserved = defaultNames().map(normalise)
      const result = yield* refusable(store, (tx) => {
        const rows = tx.collection(lists).list({ limit: MAX_LISTS + 1 })
        const live = liveLists(rows)
        // Taken: the name of a list there is, or one of the names the default lists answer to, in either language.
        if (reserved.includes(wanted) || live.some((l) => l.row?.name !== undefined && normalise(l.row.name) === wanted)) throw new Refusal("taken")
        // The default lists' rows count even when they are not there (yet): they are made whenever they are needed.
        const missing = DEFAULTS.filter((d) => !rows.some((r) => r.id === d.id)).length
        if (live.length >= MAX_LIVE_LISTS || rows.length + missing >= MAX_LISTS) throw new Refusal("too-many")
        tx.collection(lists).insert({ name, kind, open: 0, done: 0 }, { id })
        const r = said.length > 0 ? addIn(tx, id, said, true, now, lang) : { added: [], steps: [], listRev: tx.collection(lists).get(id)!.rev }
        remember(tx, key, { at: now, op: "create", list: id, listRev: r.listRev, steps: r.steps })
        return { kind: "made" as const, id, added: r.added }
      })
      yield* loadLists
      return result
    })

  /** Delete a named list: hidden at once, removed with its items once the undo window has passed. */
  const deleteList = (list: string, key: UndoKey, now: number) =>
    Effect.gen(function*() {
      const result = yield* refusable(store, (tx) => {
        const row = ensureList(tx, list)
        if (row === undefined) throw new Refusal("gone")
        const deleted = tx.collection(lists).update(list, (v) => ({ ...v, deletedAt: now }), { expectRev: row.rev })
        // A durable cutoff cancels pins that existed at deletion, even if undo restores the list before the worker reads it.
        // A later explicit show writes a newer pin and establishes new intent. No pin scan is added to this turn.
        const after = tx.collection(lists).update(list, (v) => ({ ...v, pinsCancelledThrough: deleted.rev }))
        remember(tx, key, { at: now, op: "delete", list, listRev: after.rev, steps: [] })
        return after
      })
      yield* loadLists
      return result
    })

  /**
   * Undo the conversation's last change, if it is within the window: each item it changed is put back as it was,
   * when it has not changed since (its rev); a list made or deleted only while the list itself has not changed since.
   */
  const undoLast = (key: UndoKey, now: number) =>
    Effect.gen(function*() {
      if (key === undefined) return { result: "nothing" as UndoResult }
      const result = yield* store.transaction((tx) => {
        const entryRow = tx.collection(undo).get(key)
        if (entryRow === undefined) return { result: "nothing" as UndoResult }
        const entry = entryRow.value
        tx.collection(undo).remove(key)
        if (entry.at < now - UNDO_WINDOW_MS) return { result: "nothing" as UndoResult }
        const l = tx.collection(lists)
        const t = tx.collection(items)
        const listRow = l.get(entry.list)
        if (entry.op === "delete") {
          if (listRow === undefined || listRow.rev !== entry.listRev) return { result: "changed" as UndoResult, list: entry.list, row: listRow?.value }
          const named = normalise(listRow.value.name ?? "")
          const others = l.list({ limit: MAX_LISTS + 1 }).filter((r) => r.id !== entry.list && r.value.deletedAt === undefined)
          // Its name was taken since, or there are as many lists as there may be: it stays deleted.
          const clash = others.some((r) => normalise(r.value.name ?? "") === named) || liveLists(others).length >= MAX_LIVE_LISTS
          if (clash) return { result: "changed" as UndoResult, list: entry.list, row: listRow?.value }
          l.update(entry.list, (v) => {
            const { deletedAt: _d, ...rest } = v
            return rest
          })
          return { result: "done" as UndoResult, list: entry.list, row: listRow.value, op: entry.op }
        }
        if (entry.op === "create") {
          if (listRow === undefined || listRow.rev !== entry.listRev) return { result: "changed" as UndoResult, list: entry.list, row: listRow?.value }
          for (const s of entry.steps) t.remove(s.id)
          l.remove(entry.list)
          return { result: "done" as UndoResult, list: entry.list, row: listRow.value, op: entry.op }
        }
        if (listRow === undefined || listRow.value.deletedAt !== undefined) return { result: "changed" as UndoResult, list: entry.list, row: listRow?.value }
        let skipped = 0
        let open = 0
        let done = 0
        const count = (status: ItemStatus, sign: 1 | -1) => {
          if (status === "open") open += sign
          if (status === "done") done += sign
        }
        const merges = new Map((entry.merged ?? []).map((m) => [m.id, m]))
        for (const s of entry.steps) {
          const row = t.get(s.id)
          if (row === undefined || row.rev !== s.rev) {
            skipped++
            merges.delete(s.id)
            continue
          }
          const merge = merges.get(s.id)
          merges.delete(s.id)
          if (s.from === "absent") {
            t.remove(s.id)
            count(row.value.status, -1)
            continue
          }
          if (s.from !== row.value.status && listRow.value.open + open + (s.from === "open" ? 1 : 0) > MAX_OPEN) {
            skipped++
            continue
          }
          t.update(s.id, (v) => {
            let next: Item = s.from === v.status ? v : withStatus(v, s.from as ItemStatus, s.since ?? now)
            if (entry.before !== undefined) {
              const { quantity: _q, note: _n, ...rest } = next
              next = { ...withText(rest as Item, entry.before.text), ...(entry.before.quantity !== undefined ? { quantity: entry.before.quantity } : {}), ...(entry.before.note !== undefined ? { note: entry.before.note } : {}) }
            }
            if (merge !== undefined) {
              const { quantity: _q, note: _n, ...rest } = next
              next = { ...rest, ...(merge.quantity !== undefined ? { quantity: merge.quantity } : {}), ...(merge.note !== undefined ? { note: merge.note } : {}) }
            }
            return next
          })
          count(row.value.status, -1)
          count(s.from as ItemStatus, 1)
        }
        for (const m of merges.values()) {
          const row = t.get(m.id)
          if (row === undefined || row.rev !== m.rev) {
            skipped++
            continue
          }
          t.update(m.id, (v) => {
            const { quantity: _q, note: _n, ...rest } = v
            return { ...rest, ...(m.quantity !== undefined ? { quantity: m.quantity } : {}), ...(m.note !== undefined ? { note: m.note } : {}) }
          })
        }
        if (open !== 0 || done !== 0) bump(tx, entry.list, open, done)
        return { result: (skipped > 0 ? "partly" : "done") as UndoResult, list: entry.list, row: listRow.value, op: entry.op }
      })
      yield* loadLists
      return result
    })

  /** The spoken name of a list now (deleted ones included, for "undone: the camping list is back"). */
  const phraseOf = (id: string, lang: Language) => listPhrase(id, cache.find((r) => r.id === id)?.value, lang)

  /** The list names for "the lists are …". */
  const listNames = (lang: Language) => liveLists().map((l) => listPhrase(l.id, l.row, lang))

  /** A list's counts (a default list without a row yet has none). */
  const countsOf = (id: string) => Effect.map(listStore.get(id), (row) => (row === undefined || row.value.deletedAt !== undefined ? { open: 0, done: 0 } : { open: row.value.open, done: row.value.done }))

  return {
    store,
    /** The store without the change signal (the module's own bookkeeping that must not wake what follows the lists). */
    rawStore,
    setOnChange: (f: (touched: ReadonlySet<string>) => void) => {
      onChange = f
    },
    once,
    serial,
    ensureDefaults,
    /** A transaction whose function may `refuse` before it writes: the refusal is its value. */
    refusable: <X>(f: (tx: StoreTx) => X) => refusable(store, f),
    refuse: (reason: RefusalReason): never => {
      throw new Refusal(reason)
    },
    itemStore,
    listStore,
    undoStore,
    loadLists,
    liveLists,
    options,
    resolveList,
    ensureList,
    bump,
    nextSince,
    scan,
    find,
    findAnywhere,
    exact,
    setStatus,
    clear,
    update,
    add,
    create,
    deleteList,
    undoLast,
    phraseOf,
    listNames,
    countsOf,
    cached: () => cache
  }
}

export type Engine = ReturnType<typeof makeEngine>

/** A sentence of the module, its first letter a capital (a list said first: "The shopping list is empty."). */
export const speak = (lang: Language, key: keyof typeof texts.en, values: Readonly<Record<string, string | number>> = {}) => {
  const s = say(texts, lang, key, values)
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}
