import type { Issue, StoredModule } from "@pva/core"
import { Clock, Effect } from "effect"
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { makeSqliteStore, type SqliteHouseholdStore } from "./SqliteStore.ts"

/** The household database's file in a data directory. */
export const householdDbPath = (dataDir: string): string => join(dataDir, "household.db")

/** A backup older than this is a warning. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000

/** How long a removal may wait for its checkpoint before it is a Health issue. */
export const REMOVAL_PENDING_MS = 10 * 60 * 1000

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ")
const backupsDoc = { kind: "link", label: "About backups", value: "docs/STORING-DATA.md#backups" } as const

/**
 * The cheap household checks (serve mode's Health page, on every check, and `doctor`): a recent backup exists and its
 * copy in the second directory, old backups could be removed, the data and backup directories are private, the
 * write-ahead log is not growing without bound, and no removal has waited long for its checkpoint. Only file times and
 * the store's own state: never a read of the database.
 */
export const householdBackupIssues = (store: SqliteHouseholdStore): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.gen(function*() {
    const issues: Array<Issue> = []
    const now = yield* Clock.currentTimeMillis
    const where = store.backupDir ?? "data/backups"
    for (const problem of store.directoryProblems()) {
      issues.push({ id: "core.household.directory", severity: "error", title: "A household data directory can be written by other users", detail: problem.slice(0, 1900) })
    }
    const last = yield* Effect.result(store.lastBackupAt)
    if (last._tag === "Failure") {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The household backups cannot be checked", detail: last.failure.message.slice(0, 1900), fix: backupsDoc })
    } else if (last.success === undefined) {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The household data has no backup yet", detail: `The server makes one a day in ${where}.`, fix: backupsDoc })
    } else if (now - last.success > BACKUP_STALE_MS) {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The last household backup is old", detail: `The newest backup in ${where} is from ${when(last.success)}.`, fix: backupsDoc })
    }
    const copy = store.copyFailure()
    if (copy !== undefined) {
      issues.push({ id: "core.household.copy", severity: "warning", title: "The household backup could not be copied to the second directory", detail: `${copy.slice(0, 1700)} It is tried again every hour.` })
    }
    const failed = store.pruneFailures()
    if (failed.length > 0) {
      issues.push({
        id: "core.household.retention",
        severity: "warning",
        title: "Old household backups could not all be checked or removed",
        detail: `Backups older than 14 days are kept against the promise that removed data is gone after 14 days: ${failed.join("; ").slice(0, 1500)}`
      })
    }
    if (store.walSize() > store.walWarnBytes) {
      issues.push({
        id: "core.household.log",
        severity: "warning",
        title: "The household database's log keeps growing",
        detail: `household.db-wal holds ${Math.round(store.walSize() / 1024 / 1024)} MB: a reader (a command-line mode, a long backup) keeps the checkpoints from finishing. Stop the other reader.`
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

/** A directory others may write to (doctor's read-only check; serve mode narrows its own). */
const openToOthers = (dir: string): string | undefined => {
  try {
    const s = statSync(dir)
    return (s.mode & 0o022) !== 0 ? `${dir} can be written by other users (mode ${(s.mode & 0o777).toString(8)}); the server narrows it to 700 when it is the assistant user's own.` : undefined
  } catch {
    return undefined
  }
}

/**
 * `pnpm start doctor`: the household database opens (read-only), passes SQLite's quick check (it reads the whole file,
 * so it is not part of serve mode's Health page), is not from a newer version, no module's data in it is unusable
 * (judged against `modules`, read-only: nothing is migrated), which stored collections no module declares any more
 * (their data is kept, unreachable), the directories are private and a recent backup exists. Nothing is written.
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
    for (const dir of [dirname(file), store.backupDir]) {
      const problem = dir === undefined ? undefined : openToOthers(dir)
      if (problem !== undefined) issues.push({ id: "core.household.directory", severity: "error", title: "A household data directory can be written by other users", detail: problem })
    }
    // Every module, also one that declares no storage: stored data a newer version of it wrote is judged too.
    const modules = options.modules ?? []
    yield* store.prepare(modules).pipe(Effect.ignore)
    for (const m of modules) {
      const verdict = store.availability(m.id)
      if (verdict === undefined) continue
      issues.push({ id: `core.household.module.${m.id}`, severity: "error", title: `Module ${m.name ?? m.id}: its stored data cannot be used`, detail: verdict.reason })
    }
    // Core services are not judged here (doctor knows the modules only), so their collections are not listed.
    const undeclared = store.undeclared().filter((u) => !u.owner.startsWith("core."))
    if (undeclared.length > 0) {
      issues.push({
        id: "core.household.undeclared",
        severity: "info",
        title: "Stored data no module declares any more",
        detail: `Kept as it is, unreachable (the store never deletes it): ${undeclared.map((u) => `${u.owner}/${u.collection} (version ${u.version})`).join(", ").slice(0, 1700)}`
      })
    }
    issues.push(...(yield* householdBackupIssues(store)).filter((i) => i.id !== "core.household.directory"))
    return issues
  }))
