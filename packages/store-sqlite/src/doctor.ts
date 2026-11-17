import type { Issue } from "@pva/core"
import { Clock, Effect } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { makeSqliteStore, type SqliteHouseholdStore } from "./SqliteStore.ts"

/** The household database's file in a data directory. */
export const householdDbPath = (dataDir: string): string => join(dataDir, "household.db")

/** A backup older than this is a warning. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000

/** How long an erase may wait for its checkpoint before it is a Health issue. */
export const ERASE_PENDING_MS = 10 * 60 * 1000

/**
 * The cheap household checks (serve mode's Health page, on every check, and `doctor`): the last backup is recent, and
 * no erase has waited long for its checkpoint. Only file times and the store's own state: never a read of the database.
 */
export const householdBackupIssues = (store: SqliteHouseholdStore): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.gen(function*() {
    const issues: Array<Issue> = []
    const last = yield* store.lastBackupAt
    const now = yield* Clock.currentTimeMillis
    const where = store.backupDir ?? "data/backups"
    if (last === undefined) {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The household data has no backup yet", detail: `The server makes one a day in ${where}; or run pnpm start household backup.`, fix: { kind: "command", label: "Back up now", value: "pnpm start household backup" } })
    } else if (now - last > BACKUP_STALE_MS) {
      issues.push({
        id: "core.household.backup",
        severity: "warning",
        title: "The last household backup is old",
        detail: `The newest backup in ${where} is from ${new Date(last).toISOString().slice(0, 16).replace("T", " ")}.`,
        fix: { kind: "command", label: "Back up now", value: "pnpm start household backup" }
      })
    }
    const pending = store.erasePendingSince()
    if (pending !== undefined && now - pending > ERASE_PENDING_MS) {
      issues.push({
        id: "core.household.erase",
        severity: "warning",
        title: "Something erased is still in the household database's log",
        detail: `Since ${new Date(pending).toISOString().slice(0, 16).replace("T", " ")} a reader (a long backup, export or a command-line mode) has kept an older snapshot open, so the checkpoint that removes the erased content from the files keeps waiting. It is retried; stop the other reader to finish it.`
      })
    }
    return issues
  })

/**
 * `pnpm start doctor`: the household database opens (read-only), passes SQLite's quick check (it reads the whole file,
 * so it is not part of serve mode's Health page, which runs `householdBackupIssues`), is not from a newer version, and
 * its last backup is recent. Nothing is written.
 */
export const householdIssues = (dataDir: string, options: { readonly backupDir?: string } = {}): Effect.Effect<ReadonlyArray<Issue>> =>
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
    issues.push(...(yield* householdBackupIssues(store)))
    return issues
  }))
