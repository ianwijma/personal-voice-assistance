// For tests only: how the checkpoint worker starts a new write-ahead log, and pauses to put a main-thread write in
// the window or behind the worker's lock (docs/STORING-DATA.md "The write-ahead log"). Nothing here runs in the app.
import { checkpointerOf, journalConversionHooks, type LogStarts } from "./files.ts"
import type { SqliteHouseholdStore } from "./SqliteStore.ts"

export type { LogStarts }

const checkpointer = (store: SqliteHouseholdStore) => {
  const c = checkpointerOf.get(store)
  if (c === undefined) throw new Error("This store has no checkpoint worker (in memory, or read only)")
  return c
}

/** What the worker's log starts came to so far (`LogStarts`). */
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

/** A checkpoint now, as the store makes them (`true`: done; a truncation a reader blocked is `false`). */
export const checkpointNow = (store: SqliteHouseholdStore, kind: "passive" | "truncate"): Promise<boolean> =>
  kind === "passive" ? checkpointer(store).passive() : checkpointer(store).truncate()

/** The checkpoint worker connection's settings (`PRAGMA` values by name). */
export const workerSettings = (store: SqliteHouseholdStore): Promise<Readonly<Record<string, number>>> => checkpointer(store).settings()

/**
 * The journal conversion of a backup's copy (made one file, on a thread of its own): a pause inside it (`pauseMs`),
 * and something to do to the copy just before it (`before`, given the copy's path). Reset with `{ pauseMs: 0 }`.
 */
export const setBackupJournalHooks = (hooks: { readonly pauseMs: number; readonly before?: (file: string) => void }): void => {
  journalConversionHooks.pauseMs = hooks.pauseMs
  journalConversionHooks.before = hooks.before
}
