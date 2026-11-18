import type { Actor, Row } from "@pva/core"
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
 * at most `MAX_TIDY_STEPS` steps a run. Running it twice is harmless (it only removes what is old).
 */
export const tidy = (engine: Engine, settings: TidySettings, now: number, actor: Actor) =>
  Effect.gen(function*() {
    let steps = 0
    const { store, itemStore, undoStore } = engine
    /** Remove the oldest rows of one list in one status while `old` holds, a page per step. */
    const sweep = (list: string, status: ItemStatus, old: (row: Row<Item>) => boolean) =>
      Effect.gen(function*() {
        while (steps < MAX_TIDY_STEPS) {
          steps++
          const page = yield* itemStore.list({ where: { place: placeOf(list, status) }, orderBy: { field: "since", direction: "asc" }, limit: ITEM_PAGE })
          const gone = page.filter(old)
          if (gone.length > 0) {
            yield* store.transaction((tx) => {
              const t = tx.collection(items)
              let removed = 0
              for (const r of gone) if (t.remove(r.id, { actor })) removed++
              if (status !== "removed" && tx.collection(lists).get(list) !== undefined) {
                engine.bump(tx, list, status === "open" ? -removed : 0, status === "done" ? -removed : 0)
              }
            })
          }
          if (page.length < ITEM_PAGE || gone.length < page.length) return
          yield* Effect.yieldNow
        }
      })
    const rows: ReadonlyArray<Row<ListRow>> = yield* engine.loadLists
    for (const row of rows) {
      if (steps >= MAX_TIDY_STEPS) break
      if (row.value.deletedAt !== undefined && row.value.deletedAt < now - UNDO_WINDOW_MS) {
        // A deleted list past its undo window: every item, then the list itself.
        for (const status of ["open", "done", "removed"] as const) yield* sweep(row.id, status, () => true)
        if (steps < MAX_TIDY_STEPS) {
          const left = yield* Effect.forEach(["open", "done", "removed"] as const, (status) => itemStore.list({ where: { place: placeOf(row.id, status) }, limit: 1 }))
          if (left.every((l) => l.length === 0)) yield* store.transaction((tx) => void tx.collection(lists).remove(row.id, { actor }))
        }
        continue
      }
      const keepMs = row.id === SHOPPING || row.value.kind === "shopping" ? settings.keepDoneShoppingHours * 3_600_000 : settings.keepDoneDays * 86_400_000
      yield* sweep(row.id, "done", (r) => r.value.since < now - keepMs)
      yield* sweep(row.id, "removed", (r) => r.value.since < now - UNDO_WINDOW_MS)
    }
    // Undo entries past the window, oldest first (one row a read: an entry may be large).
    while (steps < MAX_TIDY_STEPS) {
      steps++
      const [oldest] = yield* undoStore.list({ orderBy: { field: "at", direction: "asc" }, limit: 1 })
      if (oldest === undefined || oldest.value.at >= now - UNDO_WINDOW_MS) break
      yield* store.transaction((tx) => void tx.collection(undo).remove(oldest.id, { actor }))
      yield* Effect.yieldNow
    }
    yield* engine.loadLists
    return steps
  })
