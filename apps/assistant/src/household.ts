import { householdDbPath, makeSqliteStore } from "@pva/store-sqlite"
import { Clock, Effect } from "effect"
import { copyFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { userCwd } from "./env.ts"
import { acquireDataDirLock } from "./serve/DataDirLock.ts"
import { DataDirConfig } from "./serve/SettingsStore.ts"
import { StartupError } from "./startup.ts"

/**
 * `pnpm start household backup | export <module> [file] | restore <backup file>` (docs/STORING-DATA.md "Backup and
 * restore"). `backup` and `export` only read the database (they work while the server runs); `restore` takes the
 * data directory's writer lock, so it refuses while the server runs.
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
      // The server must not run: the same lock it holds.
      yield* acquireDataDirLock(dataDir)
      // The backup must open and pass SQLite's check before anything is moved.
      const check = yield* Effect.scoped(Effect.flatMap(makeSqliteStore({ filename: source, readOnly: true }), (s) => s.check))
      if (check !== "ok") return yield* new StartupError({ message: `${source} does not pass SQLite's check: ${check}` })
      const at = yield* Clock.currentTimeMillis
      const aside = `${file}.before-restore-${new Date(at).toISOString().replace(/[:.]/g, "-")}`
      yield* Effect.promise(async () => {
        // The current file goes aside with its WAL (which may hold its latest changes), never deleted.
        if (existsSync(file)) await rename(file, aside)
        for (const extra of ["-wal", "-shm"]) if (existsSync(`${file}${extra}`)) await rename(`${file}${extra}`, `${aside}${extra}`)
        await copyFile(source, `${file}.part`)
        await rename(`${file}.part`, file)
      })
      process.stdout.write(`Restored ${source} as ${file}${existsSync(aside) ? `; the previous file is ${aside}` : ""}. Start the server again.\n`)
      return
    }
    return yield* new StartupError({ message: "Usage: household backup | household export <module id> [file] | household restore <backup file>" })
  }))
