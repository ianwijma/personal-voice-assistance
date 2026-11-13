import { Effect } from "effect"
import { acquireDataDirLockSync, type DataDirLock, releaseDataDirLock } from "../../src/serve/DataDirLock.ts"
import { type LoadOptions, loadSettingsStore } from "../../src/serve/SettingsStore.ts"

/** The lock each test directory's current "process" holds. */
const current = new Map<string, DataDirLock>()

/**
 * A writable store on `dir`, as a server (re)started on it would load it: the previous store on the same
 * directory is treated as a process that stopped (its lock is released, so its saves fail from now on).
 */
export const openStore = (dir: string, options: Omit<LoadOptions, "lock" | "readOnly"> = {}) =>
  Effect.suspend(() => {
    const previous = current.get(dir)
    if (previous !== undefined) releaseDataDirLock(previous)
    const { lock } = acquireDataDirLockSync(dir)
    current.set(dir, lock)
    return loadSettingsStore(dir, { ...options, lock })
  })
