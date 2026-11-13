import type { ModulePersistence } from "@pva/core"
import type { SettingValue } from "@pva/protocol"
import { Config, Effect, Schema } from "effect"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { userCwd } from "../env.ts"

/**
 * `data/settings.json` (module intent and values, assistant settings sections)
 * and `data/secrets.json` (mode 0600, secrets only) — docs/UI-AND-MODULES.md §1.6.
 * Only values the owner set are stored. Both files are read once at startup;
 * the server is their only writer. Writes are atomic (temporary file, then
 * rename) and serialised.
 */

export interface SettingsFile {
  readonly version: 1
  readonly modules: Readonly<Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, unknown>> }>>
  readonly sections: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export interface SecretsFile {
  readonly version: 1
  readonly modules: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly sections: Readonly<Record<string, Readonly<Record<string, string>>>>
}

export class SettingsStoreError extends Schema.TaggedError<SettingsStoreError>()("SettingsStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url))

/** `PVA_DATA_DIR`, default `<repo>/data`. Relative paths resolve against where the command was run. */
export const DataDirConfig = Config.String("PVA_DATA_DIR").pipe(
  Config.withDefault(join(repoRoot, "data")),
  Config.map((p) => resolve(userCwd, p))
)

const emptySettings = (): SettingsFile => ({ version: 1, modules: {}, sections: {} })
const emptySecrets = (): SecretsFile => ({ version: 1, modules: {}, sections: {} })

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const recordOfRecords = (u: unknown) => u === undefined || (isRecord(u) && Object.values(u).every(isRecord))

const validSettings = (u: unknown): u is SettingsFile =>
  isRecord(u) && u.version === 1 && recordOfRecords(u.modules) && recordOfRecords(u.sections)

const validSecrets = (u: unknown): u is SecretsFile =>
  validSettings(u) &&
  [...Object.values(u.modules ?? {}), ...Object.values(u.sections ?? {})].every((r) => Object.values(r).every((v) => typeof v === "string"))

export interface SettingsStore {
  readonly directory: string
  readonly settings: () => SettingsFile
  readonly secrets: () => SecretsFile
  /** Problems found while loading (a corrupt file that was set aside), for the log and the UI. */
  readonly problems: ReadonlyArray<string>
  readonly saveModule: (
    id: string,
    record: { readonly enabled: boolean; readonly settings: Readonly<Record<string, SettingValue>>; readonly secrets: Readonly<Record<string, string>> }
  ) => Effect.Effect<void, SettingsStoreError>
  readonly saveSection: (
    id: string,
    values: Readonly<Record<string, SettingValue>>,
    secrets: Readonly<Record<string, string>>
  ) => Effect.Effect<void, SettingsStoreError>
  /** The module host's view of the store. */
  readonly modulePersistence: ModulePersistence
}

export interface LoadOptions {
  /** Never write (CLI modes): a corrupt file is reported but left in place, and saves are ignored. */
  readonly readOnly?: boolean
  /** For tests. Default `Date.now`. */
  readonly now?: () => number
}

const loadFile = async <A>(
  path: string,
  valid: (u: unknown) => u is A,
  empty: () => A,
  options: LoadOptions,
  problems: Array<string>
): Promise<A> => {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  if (valid(parsed)) return { ...empty(), ...parsed }
  if (options.readOnly === true) {
    problems.push(`${path} is not valid settings JSON; using defaults (the file was left as it is)`)
    return empty()
  }
  const aside = `${path}.corrupt-${new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}`
  await rename(path, aside)
  problems.push(`${path} could not be read and was renamed to ${aside}; everything starts from the defaults`)
  return empty()
}

export const loadSettingsStore = (directory: string, options: LoadOptions = {}): Effect.Effect<SettingsStore, SettingsStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const problems: Array<string> = []
      const settingsPath = join(directory, "settings.json")
      const secretsPath = join(directory, "secrets.json")
      let settings = await loadFile(settingsPath, validSettings, emptySettings, options, problems)
      let secrets = await loadFile(secretsPath, validSecrets, emptySecrets, options, problems)

      // Writes are chained so they never interleave; each one writes a temporary file and renames it.
      let queue: Promise<unknown> = Promise.resolve()
      const write = (path: string, data: unknown, mode: number) => {
        const next = queue.then(async () => {
          await mkdir(directory, { recursive: true })
          const tmp = `${path}.tmp`
          await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode })
          await chmod(tmp, mode)
          await rename(tmp, path)
        })
        queue = next.catch(() => {})
        return next
      }
      const persist = (what: string, writeSettings: boolean, writeSecrets: boolean) =>
        Effect.tryPromise({
          try: async () => {
            if (options.readOnly === true) return
            if (writeSettings) await write(settingsPath, settings, 0o644)
            if (writeSecrets) await write(secretsPath, secrets, 0o600)
          },
          catch: (cause) => new SettingsStoreError({ message: `Could not save ${what} in ${directory}`, cause })
        })

      const sameSecrets = (a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>>) =>
        JSON.stringify(a ?? {}) === JSON.stringify(b)

      const saveModule: SettingsStore["saveModule"] = (id, record) =>
        Effect.suspend(() => {
          const secretsChanged = !sameSecrets(secrets.modules[id], record.secrets)
          settings = { ...settings, modules: { ...settings.modules, [id]: { enabled: record.enabled, settings: record.settings } } }
          if (secretsChanged) {
            const modules = { ...secrets.modules }
            if (Object.keys(record.secrets).length === 0) delete modules[id]
            else modules[id] = record.secrets
            secrets = { ...secrets, modules }
          }
          return persist(`the settings of module ${id}`, true, secretsChanged)
        })

      const saveSection: SettingsStore["saveSection"] = (id, values, sectionSecrets) =>
        Effect.suspend(() => {
          const secretsChanged = !sameSecrets(secrets.sections[id], sectionSecrets)
          settings = { ...settings, sections: { ...settings.sections, [id]: values } }
          if (secretsChanged) {
            const sections = { ...secrets.sections }
            if (Object.keys(sectionSecrets).length === 0) delete sections[id]
            else sections[id] = sectionSecrets
            secrets = { ...secrets, sections }
          }
          return persist(`the ${id} settings`, true, secretsChanged)
        })

      const store: SettingsStore = {
        directory,
        settings: () => settings,
        secrets: () => secrets,
        problems,
        saveModule,
        saveSection,
        modulePersistence: {
          initial: { modules: settings.modules, secrets: secrets.modules },
          save: saveModule
        }
      }
      return store
    },
    catch: (cause) => new SettingsStoreError({ message: `Could not read the settings in ${directory}`, cause })
  })
