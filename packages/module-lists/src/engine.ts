import { type ModuleStore, type ParamOption, resolveOption, type Row, type StoreFailure, type StoreTx } from "@pva/core"
import { convertAmount, type UnitId } from "@pva/language"
import { isLine, type Language, LISTS_LIMITS, say } from "@pva/module-contracts"
import { Effect } from "effect"
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
  withStatus
} from "./data.ts"
import { addAmounts, type SaidItem, sayItem } from "./parse.ts"
import { texts } from "./texts.ts"

/** The most rows a turn's scan of one list's items reads: every open item a list may have (32 indexed reads of 16). */
export const SCAN_ROWS = MAX_OPEN

const DEFAULTS: ReadonlyArray<{ readonly id: string; readonly kind: "shopping" | "todo" }> = [{ id: SHOPPING, kind: "shopping" }, { id: TODO, kind: "todo" }]

/** Other names of the two default lists, in both languages (the household may say either). */
const DEFAULT_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  [SHOPPING]: ["shopping", "shopping list", "groceries", "grocery list", "list", "the list", "boodschappen", "boodschappenlijst", "boodschappenlijstje", "lijst", "lijstje"],
  [TODO]: ["to do", "to-do", "todo", "to do list", "to-do list", "todo list", "tasks", "task list", "takenlijst", "taken", "to-dolijst", "te doen"]
}

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

/** Thrown inside a transaction to roll it back with nothing written; caught right outside it. */
class Refusal {
  readonly reason: "full" | "gone" | "changed"
  constructor(reason: "full" | "gone" | "changed") {
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

/**
 * The lists module's work on the store: shared by its tools, actions, service and job. One per module (`shared`),
 * with a cache of the list rows (at most `MAX_LISTS`, one read) for the synchronous list choices of the typed actions.
 */
export const makeEngine = (store: ModuleStore) => {
  const listStore = store.collection(lists)
  const itemStore = store.collection(items)
  const undoStore = store.collection(undo)
  let cache: ReadonlyArray<Row<ListRow>> = []

  /** Read every list (one read: `MAX_LISTS` rows fit one page) and keep them for the choices. */
  const loadLists = Effect.map(listStore.list({ limit: MAX_LISTS + 1 }), (rows) => {
    cache = rows
    return rows
  })

  /** The lists the household has now, default ones first, then named ones as made. */
  const liveLists = (rows: ReadonlyArray<Row<ListRow>> = cache): ReadonlyArray<LiveList> => {
    const byId = new Map(rows.map((r) => [r.id, r]))
    const defaults = DEFAULTS.map(({ id }) => ({ id, row: byId.get(id)?.value, rev: byId.get(id)?.rev }))
    const named = rows.filter((r) => r.id !== SHOPPING && r.id !== TODO && r.value.deletedAt === undefined).toSorted((a, b) => a.createdAt - b.createdAt)
    return [...defaults, ...named.map((r) => ({ id: r.id, row: r.value, rev: r.rev }))]
  }

  /** The choices of a list parameter, in the household's language, with the other names people use. */
  const options = (lang: Language): ReadonlyArray<ParamOption> =>
    liveLists().map(({ id, row }) => {
      if (id === SHOPPING || id === TODO) {
        const label = listPhrase(id, row, lang).replace(/^(the|de) /, "")
        return { value: id, label, aliases: DEFAULT_ALIASES[id]! }
      }
      const name = row?.name ?? id
      return { value: id, label: name, aliases: [`${name} list`, `${name}lijst`, `lijst ${name}`] }
    })

  /** The list some words name, or `undefined`. */
  const resolveList = (words: string, lang: Language): string | undefined => {
    const trimmed = words.trim()
    if (trimmed === "") return undefined
    return resolveOption(options(lang), trimmed)?.value
  }

  // -- inside a transaction ---------------------------------------------------------------------------------------

  /** The list's row, made first for a default list; `undefined` for a list that is gone or deleted. */
  const ensureList = (tx: StoreTx, id: string): Row<ListRow> | undefined => {
    const l = tx.collection(lists)
    const row = l.get(id)
    if (row !== undefined) return row.value.deletedAt === undefined ? row : undefined
    const d = DEFAULTS.find((x) => x.id === id)
    return d === undefined ? undefined : l.insert(defaultRow(d.kind), { id })
  }

  const bump = (tx: StoreTx, id: string, open: number, done: number): Row<ListRow> =>
    tx.collection(lists).update(id, (v) => ({ ...v, open: Math.min(MAX_OPEN, Math.max(0, v.open + open)), done: Math.max(0, v.done + done) }))

  /** Write the conversation's undo entry (one level: it replaces the last one). */
  const remember = (tx: StoreTx, key: UndoKey, entry: UndoEntry) => {
    if (key === undefined) return
    const u = tx.collection(undo)
    if (u.get(key) === undefined) u.insert(entry, { id: key })
    else u.update(key, () => entry)
  }

  /** The item that `text` names on the list by its match: open first, then the most recently ticked off. */
  const matchIn = (tx: StoreTx, list: string, text: string): Row<Item> | undefined => {
    const rows = tx.collection(items).list({ where: { match: matchOf(list, text) }, limit: ITEM_PAGE }).filter((r) => r.value.list === list && r.value.status !== "removed")
    return rows.find((r) => r.value.status === "open") ?? rows.filter((r) => r.value.status === "done").toSorted((a, b) => b.value.since - a.value.since)[0]
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

  /**
   * Add what was said to a list, in one transaction. With `merge`, an item said again is merged into the open one
   * (its amount added, or set when it had none; an amount in another unit goes into the note) or a ticked-off one is
   * put back; otherwise it is added. Refuses `full` before writing anything when the list would pass `MAX_OPEN`.
   */
  const addIn = (tx: StoreTx, list: string, said: ReadonlyArray<SaidItem>, merge: boolean, now: number, lang: Language) => {
    const listRow = ensureList(tx, list)
    if (listRow === undefined) throw new Refusal("gone")
    const t = tx.collection(items)
    // Plan first (reads only), so a refusal writes nothing.
    type Plan =
      | { readonly kind: "new"; readonly said: SaidItem }
      | { readonly kind: "already"; readonly said: SaidItem }
      | { readonly kind: "merge"; readonly said: SaidItem; readonly row: Row<Item>; readonly quantity?: Quantity; readonly note?: string }
      | { readonly kind: "reopen"; readonly said: SaidItem; readonly row: Row<Item> }
    const plans: Array<Plan> = []
    const planned = new Map<string, number>()
    for (const s of said) {
      const key = normalise(s.text)
      // Said twice in one request ("milk and milk"): the first plan wins and the second merges into nothing.
      if (planned.has(key)) {
        plans.push({ kind: "already", said: s })
        continue
      }
      planned.set(key, plans.length)
      const found = merge ? matchIn(tx, list, s.text) : undefined
      if (found === undefined) plans.push({ kind: "new", said: s })
      else if (found.value.status === "done") plans.push({ kind: "reopen", said: s, row: found })
      else if (s.quantity === undefined) plans.push({ kind: "already", said: s })
      else if (found.value.quantity === undefined) plans.push({ kind: "merge", said: s, row: found, quantity: s.quantity })
      else {
        const sum = sumOf(found.value.quantity, s.quantity)
        if (sum !== undefined) plans.push({ kind: "merge", said: s, row: found, quantity: sum })
        else {
          const extra = sayItem(s.text, s.quantity, lang)
          const note = found.value.note === undefined ? extra : `${found.value.note}; ${extra}`
          plans.push(isLine(note, LISTS_LIMITS.noteChars) ? { kind: "merge", said: s, row: found, note } : { kind: "already", said: s })
        }
      }
    }
    const opening = plans.filter((p) => p.kind === "new" || p.kind === "reopen").length
    if (listRow.value.open + opening > MAX_OPEN) throw new Refusal("full")
    const steps: Array<UndoStep> = []
    const merged: Array<UndoMerge> = []
    const added: Array<string> = []
    const already: Array<string> = []
    let reopened = 0
    // Items keep the order they were added in: each a millisecond after the newest open one (one indexed read), so
    // two adds in the same millisecond, or items said together, never tie.
    const newest = t.list({ where: { place: placeOf(list, "open") }, orderBy: { field: "since", direction: "desc" }, limit: 1 })[0]
    let order = newest === undefined || newest.value.since < now ? 0 : newest.value.since + 1 - now
    for (const p of plans) {
      switch (p.kind) {
        case "new": {
          const value: Item = {
            list,
            text: p.said.text,
            ...(p.said.quantity !== undefined ? { quantity: p.said.quantity } : {}),
            status: "open",
            place: placeOf(list, "open"),
            since: now + order++,
            match: matchOf(list, p.said.text)
          }
          const row = t.insert(value)
          steps.push({ id: row.id, rev: row.rev, from: "absent" })
          added.push(sayItem(value.text, value.quantity, lang))
          break
        }
        case "reopen": {
          const before = p.row.value
          const at = now + order++
          const row = t.update(p.row.id, (v) => ({ ...withStatus(v, "open", at), ...(p.said.quantity !== undefined ? { quantity: p.said.quantity } : {}) }), { expectRev: p.row.rev })
          steps.push({ id: row.id, rev: row.rev, from: "done", since: before.since })
          if (p.said.quantity !== undefined && before.quantity !== undefined) merged.push({ id: row.id, rev: row.rev, quantity: before.quantity })
          added.push(sayItem(row.value.text, row.value.quantity, lang))
          reopened++
          break
        }
        case "merge": {
          const before = p.row.value
          const row = t.update(p.row.id, (v) => ({ ...v, ...(p.quantity !== undefined ? { quantity: p.quantity } : {}), ...(p.note !== undefined ? { note: p.note } : {}) }), { expectRev: p.row.rev })
          merged.push({ id: row.id, rev: row.rev, ...(before.quantity !== undefined ? { quantity: before.quantity } : {}), ...(before.note !== undefined ? { note: before.note } : {}) })
          added.push(sayItem(row.value.text, row.value.quantity, lang))
          break
        }
        case "already":
          already.push(sayItem(p.said.text, undefined, lang))
          break
      }
    }
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

  /**
   * The item `text` names on a list: by its match (one indexed read), else the closest name among its open items (and
   * ticked-off ones when `done`), by the core's own name matching (sound and one edit away). Bounded by `SCAN_ROWS`
   * per status.
   */
  const find = (list: string, text: string, done: boolean) =>
    Effect.gen(function*() {
      const exact = (yield* itemStore.list({ where: { match: matchOf(list, text) }, limit: ITEM_PAGE })).filter(
        (r) => r.value.list === list && (r.value.status === "open" || (done && r.value.status === "done"))
      )
      const best = exact.find((r) => r.value.status === "open") ?? exact[0]
      if (best !== undefined) return best
      const statuses: ReadonlyArray<ItemStatus> = done ? ["open", "done"] : ["open"]
      for (const status of statuses) {
        const { rows } = yield* scan(list, status, SCAN_ROWS)
        const wanted = normalise(text)
        const same = rows.find((r) => normalise(r.value.text) === wanted)
        if (same !== undefined) return same
        const option = resolveOption(rows.map((r) => ({ value: r.id, label: r.value.text })), text)
        if (option !== undefined) return rows.find((r) => r.id === option.value)
      }
      return undefined
    })

  /** The list an item is on when no list was named: an exact match on any list (default lists first), else the closest name on the shopping list, then the to-do list. */
  const findAnywhere = (text: string, done: boolean) =>
    Effect.gen(function*() {
      const live = liveLists(yield* loadLists)
      for (const l of live) {
        const exact = (yield* itemStore.list({ where: { match: matchOf(l.id, text) }, limit: ITEM_PAGE })).filter(
          (r) => r.value.list === l.id && (r.value.status === "open" || (done && r.value.status === "done"))
        )
        const best = exact.find((r) => r.value.status === "open") ?? exact[0]
        if (best !== undefined) return { list: l.id, row: best }
      }
      for (const id of [SHOPPING, TODO]) {
        const row = yield* find(id, text, done)
        if (row !== undefined) return { list: id, row }
      }
      return undefined
    })

  /** Tick off or remove rows found before (each still at the rev it was read at, or the whole change is a conflict). */
  const setStatus = (list: string, rows: ReadonlyArray<Row<Item>>, to: "done" | "removed", op: "complete" | "remove" | "clear", key: UndoKey, now: number) =>
    refusable(store, (tx) => {
      if (ensureList(tx, list) === undefined) throw new Refusal("gone")
      const t = tx.collection(items)
      const steps: Array<UndoStep> = []
      let open = 0
      let done = 0
      for (const r of rows) {
        const from = r.value.status
        if (from === to) continue
        const row = t.update(r.id, (v) => withStatus(v, to, now), { expectRev: r.rev })
        steps.push({ id: row.id, rev: row.rev, from, since: r.value.since })
        if (from === "open") open--
        if (from === "done") done--
        if (to === "done") done++
      }
      const after = bump(tx, list, open, done)
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
      const row = tx.collection(items).update(found.id, (v) => {
        let next: Item = reopening ? withStatus(v, "open", now) : v
        if (change.text !== undefined) next = { ...next, text: change.text, match: matchOf(list, change.text) }
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

  /** A new named list, with its first items, as one change that can be undone. */
  const create = (name: string, kind: "shopping" | "todo" | "generic", said: ReadonlyArray<SaidItem>, key: UndoKey, now: number, lang: Language) =>
    Effect.gen(function*() {
      const rows = yield* loadLists
      const live = liveLists(rows)
      const wanted = normalise(name)
      // Taken: the name of a list there is, or one of the names the default lists answer to, in either language.
      const taken = options(lang).some((o) => [o.label, ...(o.aliases ?? [])].some((n) => normalise(n) === wanted)) || live.some((l) => normalise(l.row?.name ?? "") === wanted)
      if (taken) return { kind: "taken" as const }
      if (live.length >= MAX_LIVE_LISTS || rows.length >= MAX_LISTS) return { kind: "too-many" as const }
      const id = globalThis.crypto.randomUUID()
      const result = yield* refusable(store, (tx) => {
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
        const after = tx.collection(lists).update(list, (v) => ({ ...v, deletedAt: now }), { expectRev: row.rev })
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
          const clash = l.list({ limit: MAX_LISTS + 1 }).some((r) => r.id !== entry.list && r.value.deletedAt === undefined && normalise(r.value.name ?? "") === named)
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
              next = { ...rest, text: entry.before.text, match: matchOf(v.list, entry.before.text), ...(entry.before.quantity !== undefined ? { quantity: entry.before.quantity } : {}), ...(entry.before.note !== undefined ? { note: entry.before.note } : {}) }
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
    /** A transaction whose function may `refuse` before it writes: the refusal is its value. */
    refusable: <X>(f: (tx: StoreTx) => X) => refusable(store, f),
    refuse: (reason: "full" | "gone" | "changed"): never => {
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
    scan,
    find,
    findAnywhere,
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
