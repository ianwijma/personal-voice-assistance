import type { Row, StoreFailure } from "@pva/core"
import { type AddItemRequest, type AddItemResult, isLine, LIST_KEY_PATTERN, type ListItem, LISTS_LIMITS, ListsError, type ListsService } from "@pva/module-contracts"
import { Clock, Effect } from "effect"
import { type Item, ITEM_PAGE, itemOf, items, matchOf, MAX_OPEN, placeOf, type Quantity, SHOPPING, withStatus } from "./data.ts"
import { type Engine, isRefusal } from "./engine.ts"

/** Why a request is outside the contract's bounds (`detail`, English, for the log), or `undefined`. */
const problemOf = (request: AddItemRequest): string | undefined => {
  if (typeof request !== "object" || request === null) return "the request is not an object"
  const { text, note, quantity, dedupeKey } = request
  if (!isLine(text, LISTS_LIMITS.textChars) || text.trim() === "") return `text must be 1 to ${LISTS_LIMITS.textChars} characters of one line, not only spaces`
  if (note !== undefined && !isLine(note, LISTS_LIMITS.noteChars)) return `note must be at most ${LISTS_LIMITS.noteChars} characters of one line`
  if (quantity !== undefined) {
    if (typeof quantity !== "object" || quantity === null) return "quantity must be an object"
    const { amount, unit } = quantity
    if (typeof amount !== "number" || !Number.isFinite(amount) || !(amount > 0) || amount > LISTS_LIMITS.maxAmount) return `quantity.amount must be above 0 and at most ${LISTS_LIMITS.maxAmount}`
    if (unit !== undefined && (!isLine(unit, LISTS_LIMITS.unitChars) || unit.trim() === "")) return `quantity.unit must be 1 to ${LISTS_LIMITS.unitChars} characters of one line`
  }
  if (dedupeKey !== undefined) return keyProblem(dedupeKey)
  return undefined
}

const keyProblem = (key: unknown): string | undefined =>
  typeof key === "string" && key.length >= 3 && key.length <= LISTS_LIMITS.keyChars && LIST_KEY_PATTERN.test(key)
    ? undefined
    : `a key is 3 to ${LISTS_LIMITS.keyChars} characters of [A-Za-z0-9_.:@/-] with a colon after the first character`

/** A store failure in the contract's words: `busy` (nothing changed, try again) or `failed`. */
const failed = (e: StoreFailure) =>
  new ListsError({ reason: e._tag === "StoreError" && e.reason === "busy" ? "busy" : "failed", detail: e._tag === "StoreError" ? `store ${e.reason}` : e._tag })

/**
 * The `Lists` service (`packages/module-contracts/src/lists.ts`): four operations on the household's shopping list, by
 * a consumer's key. Each is one store transaction of a few single-row reads and writes. It records no undo entry: the
 * consumer's own changes are its business, and "undo" reverses what was said to the lists module.
 */
export const makeListsService = (engine: Engine): ListsService => {
  const { store } = engine
  /** The rows of the shopping list with this key: the live one (open or done) and any removed ones. */
  const keyed = (rows: ReadonlyArray<Row<Item>>) => {
    const own = rows.filter((r) => r.value.list === SHOPPING)
    return { live: own.find((r) => r.value.status !== "removed"), removed: own.filter((r) => r.value.status === "removed") }
  }

  const addItem = (request: AddItemRequest): Effect.Effect<AddItemResult, ListsError> =>
    Effect.gen(function*() {
      const problem = problemOf(request)
      if (problem !== undefined) return yield* Effect.fail(new ListsError({ reason: "invalid", detail: problem }))
      const now = yield* Clock.currentTimeMillis
      const { text, note, quantity, dedupeKey } = request
      const q: Quantity | undefined = quantity === undefined ? undefined : { amount: quantity.amount, ...(quantity.unit !== undefined ? { unit: quantity.unit } : {}) }
      const result = yield* engine.refusable((tx) => {
        const list = engine.ensureList(tx, SHOPPING)!
        const t = tx.collection(items)
        const found = dedupeKey === undefined ? { live: undefined, removed: [] } : keyed(t.list({ where: { dedupeKey }, limit: ITEM_PAGE }))
        const replaced = (v: Item): Item => {
          const { quantity: _q, note: _n, ...rest } = v
          return { ...rest, text, match: matchOf(SHOPPING, text), ...(q !== undefined ? { quantity: q } : {}), ...(note !== undefined ? { note } : {}) }
        }
        if (found.live !== undefined) {
          const reopening = found.live.value.status === "done"
          if (reopening && list.value.open + 1 > MAX_OPEN) engine.refuse("full")
          const row = t.update(found.live.id, (v) => replaced(reopening ? withStatus(v, "open", now) : v))
          if (reopening) engine.bump(tx, SHOPPING, 1, -1)
          return { outcome: reopening ? "reopened" as const : "updated" as const, item: itemOf(row) }
        }
        if (list.value.open + 1 > MAX_OPEN) engine.refuse("full")
        // A removed item kept for "undo" gives its key up: the key names the new item from now on.
        for (const r of found.removed) t.remove(r.id)
        const row = t.insert({
          list: SHOPPING,
          text,
          ...(q !== undefined ? { quantity: q } : {}),
          ...(note !== undefined ? { note } : {}),
          status: "open",
          place: placeOf(SHOPPING, "open"),
          since: now,
          match: matchOf(SHOPPING, text),
          ...(dedupeKey !== undefined ? { dedupeKey } : {})
        })
        engine.bump(tx, SHOPPING, 1, 0)
        return { outcome: "added" as const, item: itemOf(row) }
      }).pipe(Effect.mapError(failed))
      if (isRefusal(result)) return yield* Effect.fail(new ListsError({ reason: "limit", detail: `${MAX_OPEN} open items on the shopping list` }))
      return result
    })

  const completeByKey = (dedupeKey: string): Effect.Effect<ListItem | undefined, ListsError> =>
    Effect.gen(function*() {
      const problem = keyProblem(dedupeKey)
      if (problem !== undefined) return yield* Effect.fail(new ListsError({ reason: "invalid", detail: problem }))
      const now = yield* Clock.currentTimeMillis
      return yield* store.transaction((tx) => {
        const t = tx.collection(items)
        const { live } = keyed(t.list({ where: { dedupeKey }, limit: ITEM_PAGE }))
        if (live === undefined || live.value.status !== "open") return undefined
        const row = t.update(live.id, (v) => withStatus(v, "done", now))
        engine.bump(tx, SHOPPING, -1, 1)
        return itemOf(row)
      }).pipe(Effect.mapError(failed))
    })

  const removeByKey = (dedupeKey: string): Effect.Effect<boolean, ListsError> =>
    Effect.gen(function*() {
      const problem = keyProblem(dedupeKey)
      if (problem !== undefined) return yield* Effect.fail(new ListsError({ reason: "invalid", detail: problem }))
      return yield* store.transaction((tx) => {
        const t = tx.collection(items)
        const { live, removed } = keyed(t.list({ where: { dedupeKey }, limit: ITEM_PAGE }))
        for (const r of removed) t.remove(r.id)
        if (live === undefined) return false
        t.remove(live.id)
        engine.bump(tx, SHOPPING, live.value.status === "open" ? -1 : 0, live.value.status === "done" ? -1 : 0)
        return true
      }).pipe(Effect.mapError(failed))
    })

  const find = (dedupeKey: string): Effect.Effect<ListItem | undefined, ListsError> =>
    Effect.gen(function*() {
      const problem = keyProblem(dedupeKey)
      if (problem !== undefined) return yield* Effect.fail(new ListsError({ reason: "invalid", detail: problem }))
      const { live } = keyed(yield* engine.itemStore.list({ where: { dedupeKey }, limit: ITEM_PAGE }).pipe(Effect.mapError(failed)))
      return live === undefined ? undefined : itemOf(live)
    })

  return { addItem, completeByKey, removeByKey, find }
}
