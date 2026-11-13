import type { ModulePersistence } from "@pva/core"
import type { SettingValue } from "@pva/protocol"
import { Config, Effect, Schema } from "effect"
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { userCwd } from "../env.ts"
import type { Vault, VaultSecrets } from "./Vault.ts"

/**
 * `data/settings.json` (module intent and values, assistant settings sections)
 * and the secrets — docs/UI-AND-MODULES.md §1.6. Only values the owner set are
 * stored. Files are read once at startup; the server is their only writer.
 * Writes are atomic (temporary file, then rename) and serialised.
 *
 * Secrets: once a key vault exists (`Vault.ts`), they are read from and written
 * to the vault only: nothing while it is locked (a save that changes a secret
 * then fails with "Keys are locked"). Before that, they are kept as before in
 * `data/secrets.json` (mode 0600); `importLegacySecrets` moves that file's keys
 * into the vault and deletes it (after setup, and at an unlock if the file came back).
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

/** The message of a save refused because the vault is locked. */
export const KEYS_LOCKED_MESSAGE = "Keys are locked — unlock them in Options"

export interface SettingsStore {
  readonly directory: string
  readonly settings: () => SettingsFile
  /** The secrets in effect: the vault's (empty while it is locked) once a vault exists, else `data/secrets.json`. */
  readonly secrets: () => SecretsFile
  /** Keys still in `data/secrets.json` (a count; 0 when the file is gone or empty). */
  readonly legacySecretCount: () => number
  /**
   * Move the keys of `data/secrets.json` into the unlocked vault (values already in the vault win) and delete the
   * file. Returns how many keys came from the file (0 when there was none). Never in read-only mode.
   */
  readonly importLegacySecrets: () => Effect.Effect<number, SettingsStoreError>
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
  /** The key vault. Without one (or while it does not exist yet) secrets stay in `data/secrets.json`. */
  readonly vault?: Vault
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

class KeysUnavailable extends Error {}

export const loadSettingsStore = (directory: string, options: LoadOptions = {}): Effect.Effect<SettingsStore, SettingsStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const problems: Array<string> = []
      const settingsPath = join(directory, "settings.json")
      const secretsPath = join(directory, "secrets.json")
      let settings = await loadFile(settingsPath, validSettings, emptySettings, options, problems)
      let secrets = await loadFile(secretsPath, validSecrets, emptySecrets, options, problems)
      const vault = options.vault
      const vaultInUse = () => vault !== undefined && vault.state() !== "none"
      const fromVault = (): SecretsFile => {
        const s = vault?.secrets()
        return s === undefined ? emptySecrets() : { version: 1, modules: s.modules, sections: s.sections }
      }
      const current = (): SecretsFile => (vaultInUse() ? fromVault() : secrets)
      const countKeys = (file: SecretsFile) =>
        [...Object.values(file.modules), ...Object.values(file.sections)].reduce((n, r) => n + Object.keys(r).length, 0)

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
      // Saves run one at a time, each computing its change from the state at that moment.
      let saving: Promise<unknown> = Promise.resolve()
      const serial = <A>(f: () => Promise<A>): Promise<A> => {
        const next = saving.then(f)
        saving = next.catch(() => {})
        return next
      }

      type Group = Readonly<Record<string, Readonly<Record<string, string>>>>
      const withSecrets = (group: Group, id: string, values: Readonly<Record<string, string>>): Group => {
        const out = { ...group }
        if (Object.keys(values).length === 0) delete out[id]
        else out[id] = values
        return out
      }
      const sameSecrets = (a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>>) =>
        JSON.stringify(a ?? {}) === JSON.stringify(b)

      /**
       * Save a change: the secrets first (the vault refuses a change while locked, and then nothing changes), then
       * the settings.
       */
      const persist = (
        what: string,
        updateSettings: (s: SettingsFile) => SettingsFile,
        updateSecrets: (s: SecretsFile) => SecretsFile | undefined
      ) =>
        Effect.tryPromise({
          try: () =>
            serial(async () => {
              const nextSecrets = updateSecrets(current())
              if (options.readOnly === true) {
                settings = updateSettings(settings)
                return
              }
              if (nextSecrets !== undefined) {
                if (vaultInUse()) {
                  const saved = await vault!.save({ modules: nextSecrets.modules, sections: nextSecrets.sections })
                  if (!saved.ok) throw new KeysUnavailable(saved.reason === "locked" ? KEYS_LOCKED_MESSAGE : saved.message)
                } else {
                  await write(secretsPath, nextSecrets, 0o600)
                  secrets = nextSecrets
                }
              }
              settings = updateSettings(settings)
              await write(settingsPath, settings, 0o644)
            }),
          catch: (cause) =>
            new SettingsStoreError({
              message: cause instanceof KeysUnavailable ? cause.message : `Could not save ${what} in ${directory}`,
              cause
            })
        })

      const saveModule: SettingsStore["saveModule"] = (id, record) =>
        persist(
          `the settings of module ${id}`,
          (s) => ({ ...s, modules: { ...s.modules, [id]: { enabled: record.enabled, settings: record.settings } } }),
          (base) => (sameSecrets(base.modules[id], record.secrets) ? undefined : { ...base, modules: withSecrets(base.modules, id, record.secrets) })
        )

      const saveSection: SettingsStore["saveSection"] = (id, values, sectionSecrets) =>
        persist(
          `the ${id} settings`,
          (s) => ({ ...s, sections: { ...s.sections, [id]: values } }),
          (base) => (sameSecrets(base.sections[id], sectionSecrets) ? undefined : { ...base, sections: withSecrets(base.sections, id, sectionSecrets) })
        )

      const importLegacySecrets: SettingsStore["importLegacySecrets"] = () =>
        Effect.tryPromise({
          try: () => serial(async () => {
            if (options.readOnly === true || vault === undefined) return 0
            const inVault = vault.secrets()
            if (inVault === undefined) throw new KeysUnavailable(KEYS_LOCKED_MESSAGE)
            const count = countKeys(secrets)
            if (count > 0) {
              const merge = (a: VaultSecrets["modules"], b: VaultSecrets["modules"]) => {
                const out: Record<string, Readonly<Record<string, string>>> = { ...b }
                for (const [id, keys] of Object.entries(a)) out[id] = { ...(b[id] ?? {}), ...keys }
                return out
              }
              // The vault's values win over the file's.
              const merged = { modules: merge(inVault.modules, secrets.modules), sections: merge(inVault.sections, secrets.sections) }
              const saved = await vault.save(merged)
              if (!saved.ok) throw new KeysUnavailable(saved.message)
            }
            try {
              await unlink(secretsPath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            secrets = emptySecrets()
            return count
          }),
          catch: (cause) =>
            new SettingsStoreError({
              message: cause instanceof KeysUnavailable ? cause.message : `Could not move ${secretsPath} into the vault`,
              cause
            })
        })

      const store: SettingsStore = {
        directory,
        settings: () => settings,
        secrets: current,
        legacySecretCount: () => countKeys(secrets),
        importLegacySecrets,
        problems,
        saveModule,
        saveSection,
        modulePersistence: {
          initial: { modules: settings.modules, secrets: current().modules },
          save: saveModule
        }
      }
      return store
    },
    catch: (cause) => new SettingsStoreError({ message: `Could not read the settings in ${directory}`, cause })
  })
