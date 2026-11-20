import type { Actor, Row, StoreTx } from "@pva/core"
import { Effect } from "effect"
import { type Item, ITEM_PAGE, items, type ItemStatus, type ListRow, lists, placeOf, SHOPPING, undo, UNDO_WINDOW_MS } from "./data.ts"
import type { Engine } from "./engine.ts"

/** The most transactions one run of the daily job makes; what is left is done the next night. */
export const MAX_TIDY_STEPS = 400

export interface TidySettings {
  readonly keepDoneShoppingHours: number
  readonly keepDoneDays: number
}

/**
 * The daily clean-up: ticked-off items older than the settings say (shopping in hours, other lists in days), removed
 * items and deleted lists once the undo window has passed (with all their items), and undo entries older than it.
 * Maintenance in steps: each step is one small transaction of at most one page of rows, with a yield between steps,
 * at most `MAX_TIDY_STEPS` steps a run, each step one at a time with the module's other changes (`engine.serial`) and
 * deciding again inside its transaction. Every write is the job's (`actor`), counts included. Running it twice is
 * harmless (it only removes what is old).
 */
export const tidy = (engine: Engine, settings: TidySettings, now: number, actor: Actor) =>
  Effect.gen(function*() {
    let steps = 0
    const { store, itemStore, undoStore } = engine
    const job = { actor }
    /**
     * Remove the oldest rows of one list in one status while `old` holds, a page per step. Each step reads, then
     * decides again inside its transaction on the rows as they are then (the same rev, the same status, still old, and
     * `still` true of the list), and changes items and counts only for those: an item reopened, changed or put back
     * since it was read stays as it is.
     */
    const sweep = (list: string, status: ItemStatus, old: (item: Item) => boolean, still: (tx: StoreTx) => boolean) =>
      Effect.gen(function*() {
        while (steps < MAX_TIDY_STEPS) {
          steps++
          const more = yield* engine.serial(Effect.gen(function*() {
            const page = yield* itemStore.list({ where: { place: placeOf(list, status) }, orderBy: { field: "since", direction: "asc" }, limit: ITEM_PAGE })
            const gone = page.filter((r) => old(r.value))
            if (gone.length === 0) return false
            const removed = yield* store.transaction((tx) => {
              if (!still(tx)) return 0
              const t = tx.collection(items)
              let count = 0
              for (const r of gone) {
                const now = t.get(r.id)
                if (now === undefined || now.rev !== r.rev || now.value.status !== status || !old(now.value)) continue
                if (t.remove(r.id, job)) count++
              }
              if (count > 0 && status !== "removed" && tx.collection(lists).get(list) !== undefined) {
                engine.bump(tx, list, status === "open" ? -count : 0, status === "done" ? -count : 0, job)
              }
              return count
            })
            return page.length === ITEM_PAGE && removed === page.length
          }))
          if (!more) return
          yield* Effect.yieldNow
        }
      })
    const rows: ReadonlyArray<Row<ListRow>> = yield* engine.loadLists
    const cutoff = now - UNDO_WINDOW_MS
    for (const row of rows) {
      if (steps >= MAX_TIDY_STEPS) break
      if (row.value.deletedAt !== undefined && row.value.deletedAt < cutoff) {
        // A deleted list past its undo window: every item, then the list itself, while it is still deleted as it was.
        const stillDeleted = (tx: StoreTx) => {
          const now = tx.collection(lists).get(row.id)
          return now !== undefined && now.value.deletedAt !== undefined && now.value.deletedAt < cutoff
        }
        for (const status of ["open", "done", "removed"] as const) yield* sweep(row.id, status, () => true, stillDeleted)
        if (steps < MAX_TIDY_STEPS) {
          yield* engine.serial(Effect.gen(function*() {
            const left = yield* Effect.forEach(["open", "done", "removed"] as const, (status) => itemStore.list({ where: { place: placeOf(row.id, status) }, orderBy: { field: "since" }, limit: 1 }))
            if (left.some((l) => l.length > 0)) return
            yield* store.transaction((tx) => {
              if (stillDeleted(tx)) tx.collection(lists).remove(row.id, job)
            })
          }))
        }
        continue
      }
      const keepMs = row.id === SHOPPING || row.value.kind === "shopping" ? settings.keepDoneShoppingHours * 3_600_000 : settings.keepDoneDays * 86_400_000
      yield* sweep(row.id, "done", (item) => item.since < now - keepMs, () => true)
      yield* sweep(row.id, "removed", (item) => item.since < cutoff, () => true)
    }
    // Undo entries past the window, oldest first (one row a read: an entry may be large). Each is removed only while it
    // is still the entry that was read and still old: one replaced since (a new change in that conversation) stays.
    while (steps < MAX_TIDY_STEPS) {
      steps++
      const more = yield* engine.serial(Effect.gen(function*() {
        const [oldest] = yield* undoStore.list({ orderBy: { field: "at", direction: "asc" }, limit: 1 })
        if (oldest === undefined || oldest.value.at >= cutoff) return false
        return yield* store.transaction((tx) => {
          const now = tx.collection(undo).get(oldest.id)
          if (now === undefined || now.rev !== oldest.rev || now.value.at >= cutoff) return false
          tx.collection(undo).remove(oldest.id, job)
          return true
        })
      }))
      if (!more) break
      yield* Effect.yieldNow
    }
    yield* engine.loadLists
    return steps
  })
