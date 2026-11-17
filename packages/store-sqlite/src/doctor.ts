import type { Issue } from "@pva/core"
import { Clock, Effect } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { makeSqliteStore } from "./SqliteStore.ts"

/** The household database's file in a data directory. */
export const householdDbPath = (dataDir: string): string => join(dataDir, "household.db")

/** A backup older than this is a warning. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000

/**
 * `pnpm start doctor` (and the Health page): the household database opens (read-only), passes SQLite's quick check,
 * is not from a newer version, and its last backup is recent. Nothing is written.
 */
export const householdIssues = (dataDir: string, options: { readonly backupDir?: string } = {}): Effect.Effect<ReadonlyArray<Issue>> =>
  Effect.scoped(Effect.gen(function*() {
    const file = householdDbPath(dataDir)
    if (!existsSync(file)) {
      return [{ id: "core.household.none", severity: "info", title: "No household data yet", detail: `${file} is made at the first start of the server.` }] satisfies ReadonlyArray<Issue>
    }
    const opened = yield* Effect.result(makeSqliteStore({ filename: file, readOnly: true, ...(options.backupDir !== undefined ? { backupDir: options.backupDir } : {}) }))
    if (opened._tag === "Failure") {
      return [{
        id: "core.household.open",
        severity: "error",
        title: "The household database cannot be opened",
        detail: opened.failure.message,
        fix: { kind: "link", label: "How to restore a backup", value: "docs/STORING-DATA.md#restore" }
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
        fix: { kind: "link", label: "Restore the last backup", value: "docs/STORING-DATA.md#restore" }
      })
    }
    const last = yield* store.lastBackupAt
    const now = yield* Clock.currentTimeMillis
    if (last === undefined) {
      issues.push({ id: "core.household.backup", severity: "warning", title: "The household data has no backup yet", detail: `The server makes one a day in ${store.backupDir ?? "data/backups"}; or run pnpm start household backup.`, fix: { kind: "command", label: "Back up now", value: "pnpm start household backup" } })
    } else if (now - last > BACKUP_STALE_MS) {
      issues.push({
        id: "core.household.backup",
        severity: "warning",
        title: "The last household backup is old",
        detail: `The newest backup in ${store.backupDir ?? "data/backups"} is from ${new Date(last).toISOString().slice(0, 16).replace("T", " ")}.`,
        fix: { kind: "command", label: "Back up now", value: "pnpm start household backup" }
      })
    }
    return issues
  }))
