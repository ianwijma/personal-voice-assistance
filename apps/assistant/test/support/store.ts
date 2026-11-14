import { Effect } from "effect"
import { acquireDataDirLockSync, type DataDirLock, releaseDataDirLock } from "../../src/serve/DataDirLock.ts"
import type { SettingValue } from "@pva/protocol"
import { sectionDefinitions } from "../../src/serve/sectionDefinitions.ts"
import { type LoadOptions, loadSettingsStore, type SettingsStore } from "../../src/serve/SettingsStore.ts"

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

/** The keys of an assistant settings section (`sectionDefinitions.ts`). */
export const sectionKeys = (id: string): ReadonlyArray<string> => {
  const d = sectionDefinitions().find((s) => s.id === id)
  if (d === undefined) throw new Error(`no settings section ${id}`)
  return Object.keys(d.spec)
}

/**
 * Save a whole section, as the settings screen does (`sections.ts`): every key of the section takes its value from
 * `values` / `secrets`, or goes back to its default when absent there. (Before settings were stored flat by key,
 * the store had `saveSection`; these tests were written against it.)
 */
export const saveSection = (
  store: SettingsStore,
  id: string,
  values: Readonly<Record<string, SettingValue>>,
  secrets: Readonly<Record<string, string>>
) => store.saveAssistant(sectionKeys(id), values, secrets)

/** The values of one section in a settings or secrets file (as loaded, or parsed from disk); `undefined` when none is saved. */
export const sectionOf = (file: { readonly assistant?: Readonly<Record<string, unknown>> } | undefined, id: string): any => {
  const out: Record<string, unknown> = {}
  for (const key of sectionKeys(id)) if (file?.assistant !== undefined && Object.hasOwn(file.assistant, key)) out[key] = file.assistant[key]
  return Object.keys(out).length === 0 ? undefined : out
}
