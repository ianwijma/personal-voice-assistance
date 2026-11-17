import { Clock, Effect } from "effect"
import type { SqliteHouseholdStore } from "./SqliteStore.ts"

/**
 * The store's maintenance fiber (serve mode): once an hour it makes the day's backup when there is none yet (the
 * first one a minute after start, so a start is not slowed down), and once a day it prunes the change log to 90 days.
 * Never on a turn's path; each step is logged, and a failed backup is reported through `onBackup`.
 */
export const runMaintenance = (
  store: SqliteHouseholdStore,
  options: {
    readonly firstDelayMs?: number
    readonly intervalMs?: number
    /** A backup succeeded (`undefined`) or failed (its message). */
    readonly onBackup?: (problem: string | undefined) => void
    readonly log?: (line: string) => void
  } = {}
): Effect.Effect<never> =>
  Effect.gen(function*() {
    const log = options.log ?? (() => {})
    yield* Effect.sleep(options.firstDelayMs ?? 60_000)
    let prunedOn = ""
    for (;;) {
      const now = yield* Clock.currentTimeMillis
      const day = new Date(now).toDateString()
      const last = yield* store.lastBackupAt
      if (last === undefined || new Date(last).toDateString() !== day) {
        const result = yield* Effect.result(store.backup({ now }))
        if (result._tag === "Success") {
          log(`Household data backed up to ${result.success.path}`)
          options.onBackup?.(undefined)
        } else {
          log(`The household backup failed: ${result.failure.message}`)
          options.onBackup?.(result.failure.message)
        }
      }
      if (prunedOn !== day) {
        prunedOn = day
        const pruned = yield* Effect.result(store.pruneChanges({ now }))
        if (pruned._tag === "Success" && pruned.success > 0) log(`Household change log: ${pruned.success} change(s) older than 90 days removed`)
      }
      yield* Effect.sleep(options.intervalMs ?? 60 * 60_000)
    }
  })
