import type { Issue, StoredModule } from "@pva/core"
import { Clock, Effect } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { makeSqliteStore, type SqliteHouseholdStore } from "./SqliteStore.ts"

/** The household database's file in a data directory. */
export const householdDbPath = (dataDir: string): string => join(dataDir, "household.db")

/** A backup older than this is a warning. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000

/** How long a removal may wait for its checkpoint before it is a Health issue. */
export const REMOVAL_PENDING_MS = 10 * 60 * 1000

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ")

/**
 * The cheap household checks (serve mode's Health page, on every check, and `doctor`): a recent backup exists, old
 * backups could be removed, and no removal has waited long for its checkpoint. Only file times and the store's own
 * state: never a read of the database.
 */
export const householdBackupIssues = (store: SqliteHouseholdStore): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.gen(function*() {
    const issues: Array<Issue> = []
    const last = yield* store.lastBackupAt
    const now = yield* Clock.currentTimeMillis
    const where = store.backupDir ?? "data/backups"
    const backUp = { kind: "command", label: "Back up now", value: "pnpm start household backup" } as const
    if (last === undefined) {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The household data has no backup yet", detail: `The server makes one a day in ${where}.`, fix: backUp })
    } else if (now - last > BACKUP_STALE_MS) {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The last household backup is old", detail: `The newest backup in ${where} is from ${when(last)}.`, fix: backUp })
    }
    const failed = store.pruneFailures()
    if (failed.length > 0) {
      issues.push({
        id: "core.household.retention",
        severity: "warning",
        title: "Old household backups could not be removed",
        detail: `Backups older than 14 days are kept against the promise that removed data is gone after 14 days: ${failed.join("; ").slice(0, 1500)}`
      })
    }
    const pending = store.removalPendingSince()
    if (pending !== undefined && now - pending > REMOVAL_PENDING_MS) {
      issues.push({
        id: "core.household.removal",
        severity: "warning",
        title: "Something removed is still in the household database's log",
        detail: `Since ${when(pending)} a reader (a long backup or a command-line mode) has kept an older snapshot open, so the checkpoint that removes the content from the log keeps waiting. It is retried; stop the other reader to finish it.`
      })
    }
    return issues
  })

/**
 * `pnpm start doctor`: the household database opens (read-only), passes SQLite's quick check (it reads the whole file,
 * so it is not part of serve mode's Health page), is not from a newer version, no module's data in it is newer than
 * that module (judged against `modules`, read-only: nothing is migrated), and a recent backup exists. Nothing is
 * written.
 */
export const householdIssues = (
  dataDir: string,
  options: { readonly backupDir?: string; readonly modules?: ReadonlyArray<StoredModule & { readonly name?: string }> } = {}
): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.scoped(Effect.gen(function*() {
    const file = householdDbPath(dataDir)
    // No file yet: nothing to check (the server makes it at its first start).
    if (!existsSync(file)) return [] as ReadonlyArray<Issue>
    const opened = yield* Effect.result(makeSqliteStore({ filename: file, readOnly: true, ...(options.backupDir !== undefined ? { backupDir: options.backupDir } : {}) }))
    if (opened._tag === "Failure") {
      return [{
        id: "core.household.open",
        severity: "error",
        title: "The household database cannot be opened",
        detail: opened.failure.message,
        fix: { kind: "link", label: "How to restore a backup", value: "docs/STORING-DATA.md#restoring-a-backup" }
      }] satisfies ReadonlyArray<Issue>
    }
    const store = opened.success
    const issues: Array<Issue> = []
    const check = yield* Effect.result(store.check)
    if (check._tag === "Failure" || check.success !== "ok") {
      issues.push({
        id: "core.household.check",
        severity: "error",
        title: "The household database is damaged",
        detail: check._tag === "Failure" ? check.failure.message : check.success.slice(0, 1500),
        fix: { kind: "link", label: "Restore the last backup", value: "docs/STORING-DATA.md#restoring-a-backup" }
      })
    }
    const modules = (options.modules ?? []).filter((m) => m.storage !== undefined)
    yield* store.prepare(modules).pipe(Effect.ignore)
    for (const m of modules) {
      const verdict = store.availability(m.id)
      if (verdict === undefined) continue
      issues.push({ id: `core.household.module.${m.id}`, severity: "error", title: `Module ${m.name ?? m.id}: its stored data cannot be used`, detail: verdict.reason })
    }
    issues.push(...(yield* householdBackupIssues(store)))
    return issues
  }))
