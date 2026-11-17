import { householdDbPath, makeSqliteStore } from "@pva/store-sqlite"
import { Effect } from "effect"
import { existsSync } from "node:fs"
import { DataDirConfig } from "./serve/SettingsStore.ts"
import { StartupError } from "./startup.ts"

/**
 * `pnpm start household backup` (docs/STORING-DATA.md "Backups"): one backup now, made through a read connection of
 * its own, so it works while the server runs. Restoring a backup is a manual step with the server stopped
 * (docs/STORING-DATA.md "Restoring a backup").
 */
export const householdCommand = (args: ReadonlyArray<string>): Effect.Effect<void, unknown> =>
  Effect.scoped(Effect.gen(function*() {
    const dataDir = yield* DataDirConfig
    const file = householdDbPath(dataDir)
    const [command] = args
    if (command === "backup") {
      if (!existsSync(file)) return yield* new StartupError({ message: `There is no household data yet (${file}).` })
      const store = yield* makeSqliteStore({ filename: file, readOnly: true, ...(process.env.HOUSEHOLD_BACKUP_COPY_DIR ? { backupCopyDir: process.env.HOUSEHOLD_BACKUP_COPY_DIR } : {}) })
      const done = yield* store.backup()
      process.stdout.write(`Backed up to ${done.path}\n`)
      return
    }
    return yield* new StartupError({ message: "Usage: household backup (restoring is a manual step: docs/STORING-DATA.md, \"Restoring a backup\")" })
  }))
