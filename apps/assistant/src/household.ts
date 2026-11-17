import { CORE_SCHEMA_VERSION, householdDbPath, makeSqliteStore, restoreDatabase } from "@pva/store-sqlite"
import { Clock, Effect } from "effect"
import { writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { userCwd } from "./env.ts"
import { acquireDataDirLock } from "./serve/DataDirLock.ts"
import { DataDirConfig } from "./serve/SettingsStore.ts"
import { StartupError } from "./startup.ts"

/**
 * `pnpm start household backup | export <module> [file] | restore <backup file>` (docs/STORING-DATA.md "Backup and
 * restore"). `backup` and `export` only read the database through a connection of their own (they work while the server
 * runs); `restore` takes the data directory's writer lock, so it refuses while the server runs.
 */
export const householdCommand = (args: ReadonlyArray<string>): Effect.Effect<void, unknown> =>
  Effect.scoped(Effect.gen(function*() {
    const dataDir = yield* DataDirConfig
    const file = householdDbPath(dataDir)
    const [command, ...rest] = args
    if (command === "backup") {
      if (!existsSync(file)) return yield* new StartupError({ message: `There is no household data yet (${file}).` })
      const store = yield* makeSqliteStore({ filename: file, readOnly: true, ...(process.env.HOUSEHOLD_BACKUP_COPY_DIR ? { backupCopyDir: process.env.HOUSEHOLD_BACKUP_COPY_DIR } : {}) })
      const done = yield* store.backup()
      process.stdout.write(`Backed up to ${done.path}\n`)
      return
    }
    if (command === "export") {
      const [moduleId, out] = rest
      if (moduleId === undefined) return yield* new StartupError({ message: "Usage: household export <module id> [file]" })
      if (!existsSync(file)) return yield* new StartupError({ message: `There is no household data yet (${file}).` })
      const store = yield* makeSqliteStore({ filename: file, readOnly: true })
      const data = JSON.stringify(yield* store.exportModule(moduleId), null, 2)
      if (out === undefined) process.stdout.write(`${data}\n`)
      else {
        yield* Effect.promise(() => writeFile(resolve(userCwd, out), `${data}\n`, { mode: 0o600 }))
        process.stdout.write(`Wrote ${resolve(userCwd, out)}\n`)
      }
      return
    }
    if (command === "restore") {
      const [from] = rest
      if (from === undefined) return yield* new StartupError({ message: "Usage: household restore <backup file> (with the server stopped)" })
      const source = resolve(userCwd, from)
      // The server must not run: the same lock it holds. The restore runs under the lock's guard, so the lock is not
      // released (to a server starting meanwhile) before every file operation of it has settled, even on Ctrl+C.
      const lock = yield* acquireDataDirLock(dataDir)
      const at = yield* Clock.currentTimeMillis
      const done = yield* Effect.uninterruptible(Effect.tryPromise({
        try: () => lock.guard("household restore", () => restoreDatabase({ source, target: file, knownSchema: CORE_SCHEMA_VERSION, now: at })),
        catch: (cause) => new StartupError({ message: `Nothing was restored: ${cause instanceof Error ? cause.message : String(cause)}` })
      }))
      process.stdout.write(`Restored ${source} as ${file}${done.aside !== undefined ? `; the previous database is ${done.aside} (kept 14 days)` : ""}. Start the server again.\n`)
      return
    }
    return yield* new StartupError({ message: "Usage: household backup | household export <module id> [file] | household restore <backup file>" })
  }))
