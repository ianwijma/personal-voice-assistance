// For tests only: how the checkpoint worker starts a new write-ahead log, and pauses to put a main-thread write in
// the window or behind the worker's lock (docs/STORING-DATA.md "The write-ahead log"). Nothing here runs in the app.
import { checkpointerOf, type LogStarts } from "./files.ts"
import type { SqliteHouseholdStore } from "./SqliteStore.ts"

export type { LogStarts }

const checkpointer = (store: SqliteHouseholdStore) => {
  const c = checkpointerOf.get(store)
  if (c === undefined) throw new Error("This store has no checkpoint worker (in memory, or read only)")
  return c
}

/** How the store's new logs were started so far: by the worker, or in the window by the main thread. */
export const logStarts = (store: SqliteHouseholdStore): LogStarts => checkpointer(store).logStarts()

/**
 * Make the worker pause after each checkpoint before it starts the new log (`gapMs`: a main-thread commit then lands
 * in the window), or while it holds the write lock for it (`holdMs`: a main-thread write then finds the store busy).
 * Zero: no pause.
 */
export const setLogStartPauses = (store: SqliteHouseholdStore, pauses: { readonly gapMs: number; readonly holdMs: number }): Promise<void> =>
  checkpointer(store).setPauses(pauses)

/** Resolved when the worker next begins the pause named. */
export const nextLogStartPause = (store: SqliteHouseholdStore, what: "gapMs" | "holdMs"): Promise<void> => checkpointer(store).nextPause(what)
