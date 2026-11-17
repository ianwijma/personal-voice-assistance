import type { ModulePersistence } from "@pva/core"
import {
  Assistant,
  type AssistantBody,
  BUILT_IN_WEB_VOICE_SETTINGS,
  DeviceId,
  DeviceName,
  type DeviceOwn,
  DeviceRecord as DeviceRecordSchema,
  DeviceSettings,
  deviceTypeOf,
  FrontendKindId,
  makeAssistantId,
  MAX_ASSISTANTS,
  NonNegativeFinite,
  NonNegativeInt,
  ProfileOverrides,
  removeAssistantFromSettings,
  type SettingValue
} from "@pva/protocol"
import { Config, Effect, Schema, Semaphore } from "effect"
import { chmod, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { userCwd } from "../env.ts"
import type { DataDirLock } from "./DataDirLock.ts"
import { flattenSections } from "./flatten.ts"
import {
  type AssistantContext,
  type AssistantList,
  type AssistantsData,
  type EnvironmentLock,
  type V3FrontendData,
  getPath,
  type V3DeviceRecord as V3Device,
  MIGRATED_ASSISTANT_ID,
  migrateToV4,
  mirrorFlatKeys,
  mirrorModuleSwitch,
  mirrorSubscriptionSettings,
  type MigrationRecord,
  setPath,
  type SettingsFile,
  type SettingsFileV3,
  type StoredDevice,
  type StoredDeviceType,
  withEnvironment
} from "./migrateAssistants.ts"
import { isVaultText, type Vault, type VaultSecrets, type VaultWriter } from "./Vault.ts"

/**
 * `data/settings.json` (module intent and values, assistant settings) and the
 * secrets — docs/UI-AND-MODULES.md §1.6. Only values the owner set are stored.
 * Files are read once at startup; the server is their only writer. Writes are
 * atomic (temporary file, then rename) and serialised; memory changes only
 * after a successful write.
 *
 * Assistants and devices (version 4; docs/ASSISTANTS.md §2.5, §6): `assistants` (order and records), `deviceTypes`
 * (each device type's complete defaults) and `devices` (each remembered device with its own sections), every entity
 * with a `rev` that each of its saves raises; a save naming an older `rev` is refused `stale` (`EntitySaveError`).
 * A version-3 file (or 2/1, read as 3 first) is migrated at load (`migrateAssistants.ts`): the original is kept as
 * `settings.json.v3-backup` (`.v1-backup` for version 1), then version 4 is written at once with the same revision
 * (one committed state either way: a reader taking no lock sees the old file migrated in memory, or the new one).
 * Read-only loads migrate in memory only. A missing file is the default install: its assistant and browser defaults
 * are made in memory and written by the first save. Entries that do not decode are dropped at load with a problem.
 *
 * The device registry's saves (`saveDeviceRecords`: a device seen, forgotten) are refused while the settings are
 * `blocked()`: a device registering must not count as the owner's word that settings from two saves belong
 * together. Saves of flat keys that became per assistant, and of module switches, are mirrored into the migrated
 * assistant (see `migrateAssistants.ts`).
 *
 * Assistant settings are stored flat by key (version 2; docs/SETTINGS-UI.md
 * §4.3): the settings sections are only how the screen groups them, so a field
 * can move to another page without losing its saved value. A version-1 file
 * (values per section) is migrated at load: flattened collision-safe
 * (`flatten.ts`), the original kept as `settings.json.v1-backup`, and the file
 * written back (now as version 4) with its revision (in read-only mode only in memory).
 *
 * Secrets: once a key vault exists (`Vault.ts`), they are read from and written
 * to the vault only: nothing while it is locked (a save that changes a secret
 * then fails with "Keys are locked"). Before that, they are kept as before in
 * `data/secrets.json` (mode 0600); `importLegacySecrets` moves that file's keys
 * into the vault and deletes it (after setup, and at an unlock if the file came back).
 * "The secrets file" below is whichever of the two holds the secrets: `secrets.json`, or the vault's file.
 *
 * A save that changes both files is a transaction recorded in `data/transaction.json` (mode 0600: it can hold
 * secrets), written before either file is replaced: the committed state (`prior`) and the state being saved
 * (`next`), as the files' texts. With the vault those texts are the vault file's (encrypted, so the journal holds
 * no key in the clear; it names which one with `secrets: "vault"`). It is removed when the save ends. At load an
 * unfinished one is resolved before anything is read: if both files hold `next` the save had completed (only the
 * journal's removal was missed) and it stands; otherwise both files are put back to `prior`, the state the failed
 * save reported it kept. Restoring the vault's text needs no password.
 *
 * One writer: a writable store needs the data directory's lock (`DataDirLock.ts`), taken before anything is read
 * or recovered, and checks it before every save. A second server on the same directory therefore refuses to
 * start; it can neither recover a transaction that is still running nor save over the first one's changes from
 * its own stale copy. Read-only loads (the CLI modes) take no lock and never write. (The lock is the data
 * directory's: two servers on different data directories sharing one vault file are not kept apart.)
 *
 * A journal that cannot be used (unreadable, or its contents are not valid settings) is set aside as
 * `transaction.json.corrupt-<time>` (0600) and the two files are loaded as they are, with a startup problem
 * saying they may come from different saves. One from a newer version of the assistant stops the start (this
 * version cannot tell what it means). Leftovers that may hold secrets (set-aside journals, a journal whose
 * removal failed, temporary files) are kept 0600, counted in a startup problem, and removed: temporary files at
 * startup, set-aside journals after the next successful save. A version-1 journal (left by the version before
 * the settings screen) is resolved like any other.
 *
 * Revisions: a save writes both files, each with the save's `revision` (one more than any before; a failed
 * save uses one up too), after the journal and in the order secrets, then settings. Two files with the same
 * revision are therefore one committed save, and two with different ones are not. This is what lets a reader
 * that takes no lock see one save (`readSnapshot`), and lets the writer tell, after a damaged journal, whether the
 * two files belong together. Files from before revisions (none in either) are taken as they are. The vault
 * carries its revision outside the encrypted part (authenticated), so it is compared without the password. With
 * the vault, a save that changes no secret writes only `settings.json`, with the vault's revision (the pair is
 * still one committed state): saving settings works while the keys are locked.
 *
 * Settings and keys that may come from two saves (a damaged journal, unless the revisions prove the files belong
 * together; or two files with different revisions) are not used to start anything: `blocked()` says why, and the
 * next successful save clears it (the owner has then looked at and saved the settings).
 */

export type { AssistantContext, AssistantList, AssistantsData, EnvironmentLock, MigrationRecord, SettingsFile, StoredDevice, StoredDeviceType }

/** A device record of a version-3 file. */
const V3DeviceRecord = Schema.Struct({
  kind: FrontendKindId,
  name: DeviceName,
  firstSeen: NonNegativeFinite,
  lastSeen: NonNegativeFinite,
  overrides: ProfileOverrides
})

const StoredDeviceTypeSchema = Schema.Struct({ ...DeviceSettings.fields, rev: NonNegativeInt })
const StoredDeviceSchema = Schema.Struct({ ...DeviceRecordSchema.fields, rev: NonNegativeInt })

/**
 * The settings file's format. 5 (P5): device types and devices have the `place` and `capabilities` sections and a
 * device record its last declaration (`declared`); shared settings have Members. A version-4 file is migrated at load
 * (`migrateV4ToV5`: nothing in it changes meaning; the original is kept as `settings.json.v4-backup`). A file of a
 * newer version than this stops the start (it is never set aside or overwritten). An assistant of version 4 (before
 * P5) cannot refuse a version-5 file this way: it sets the file aside as `settings.json.corrupt-<time>` (kept, not
 * changed) and starts from the defaults; to go back to such a build, put `settings.json.v4-backup` back first
 * (docs/ASSISTANTS.md §6).
 */
export const SETTINGS_VERSION = 5

export interface SecretsFile {
  readonly version: 2
  readonly revision?: number
  readonly modules: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Assistant secrets by key. */
  readonly assistant: Readonly<Record<string, string>>
}

export class SettingsStoreError extends Schema.TaggedError<SettingsStoreError>()("SettingsStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** A save of an assistant, a device type or a device that was refused (nothing was written). */
export class EntitySaveError extends Schema.TaggedError<EntitySaveError>()("EntitySaveError", {
  /** `stale`: the entity changed since the page read it (reload it); `locked`: a field set by the environment changed. */
  code: Schema.Literals(["stale", "unknown_assistant", "unknown_device", "limit_reached", "locked"]),
  message: Schema.String
}) {}

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url))

/** `PVA_DATA_DIR`, default `<repo>/data`. Relative paths resolve against where the command was run. */
export const DataDirConfig = Config.String("PVA_DATA_DIR").pipe(
  Config.withDefault(join(repoRoot, "data")),
  Config.map((p) => resolve(userCwd, p))
)

const emptySecrets = (): SecretsFile => ({ version: 2, modules: {}, assistant: {} })

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const recordOfRecords = (u: unknown): u is Record<string, Record<string, unknown>> => isRecord(u) && Object.values(u).every(isRecord)
const optionalRecords = (u: unknown) => u === undefined || recordOfRecords(u)
const allStrings = (r: Record<string, unknown>) => Object.values(r).every((v) => typeof v === "string")
const revisionField = (u: Record<string, unknown>) => (typeof u.revision === "number" ? { revision: u.revision } : {})

/** A parsed file, migrated to version 2; `migrated` when it was version 1. `undefined`: not a settings file. */
interface Read<A> {
  readonly file: A
  readonly migrated: boolean
  readonly problems: ReadonlyArray<string>
}

/**
 * `settings.json` as read: version 5 (`from` 4: a version-4 file, migrated by `migrateV4ToV5`), or an older one read
 * as version 3 (`from`: the version it had; 0: no file) that `migrateToV4` turns into the current version.
 */
export type StoredSettings =
  | { readonly version: 5; readonly file: SettingsFile; readonly from: 4 | 5 }
  | { readonly version: 3; readonly file: SettingsFileV3; readonly from: number }

/**
 * Version 4 → 5 (P5). Explicit, although nothing changes meaning: a type entry without `place` or `capabilities`
 * already reads as the built-in's (`withNewKeys`), and a device's own sections never had them. The file is then
 * written as version 5, so a version-4 assistant can no longer read it as its own and drop what it does not know.
 */
export const migrateV4ToV5 = (file: Omit<SettingsFile, "version"> & { readonly version: 4 | 5 }): SettingsFile => ({ ...file, version: 5 })

/** The error for a settings file of a newer format than this assistant's (`undefined` otherwise). */
export const newerSettings = (path: string, text: string | undefined): SettingsStoreError | undefined => {
  if (text === undefined) return undefined
  const u = parseOrUndefined(text)
  if (!isRecord(u) || typeof u.version !== "number" || u.version <= SETTINGS_VERSION) return undefined
  return new SettingsStoreError({
    message: `${path} was written by a newer version of the assistant (settings version ${u.version}; this one reads up to ` +
      `${SETTINGS_VERSION}). Nothing was changed. Start that version, or restore an older copy of the file (settings.json.v4-backup ` +
      "and the daily backups are next to it)."
  })
}

/**
 * P5: the newer-format refusal of a writable start, read before any write: `settings.json`, the journal's own version,
 * and the settings on either side of an unfinished save (recovery would write one of them back).
 */
const newerOnDisk = async (settingsPath: string, journalPath: string): Promise<SettingsStoreError | undefined> => {
  const onDisk = newerSettings(settingsPath, await readText(settingsPath))
  if (onDisk !== undefined) return onDisk
  const raw = await readText(journalPath)
  if (raw === undefined) return undefined
  const journal = parseOrUndefined(raw)
  const newer = newerJournal(journalPath, journal)
  if (newer !== undefined) return newer
  if (!isRecord(journal)) return undefined
  for (const side of [journal.prior, journal.next]) {
    if (!isRecord(side) || typeof side.settings !== "string") continue
    const inJournal = newerSettings(journalPath, side.settings)
    if (inJournal !== undefined) return inJournal
  }
  return undefined
}

const decodeOverrides = Schema.decodeUnknownOption(ProfileOverrides)
const decodeV3Device = Schema.decodeUnknownOption(V3DeviceRecord)
const decodeAssistant = Schema.decodeUnknownOption(Assistant)
const decodeDeviceType = Schema.decodeUnknownOption(StoredDeviceTypeSchema)
const decodeDevice = Schema.decodeUnknownOption(StoredDeviceSchema)
const isKindId = Schema.is(FrontendKindId)
const isDeviceId = Schema.is(DeviceId)

/** The front-end maps of a version-3 file; entries that do not decode are dropped, each with a problem. */
const readFrontendData = (u: Record<string, unknown>, problems: Array<string>): V3FrontendData => {
  const frontends: Record<string, ProfileOverrides> = {}
  const devices: Record<string, V3Device> = {}
  for (const [kind, value] of Object.entries(isRecord(u.frontends) ? u.frontends : {})) {
    const decoded = decodeOverrides(value)
    if (isKindId(kind) && decoded._tag === "Some") frontends[kind] = decoded.value
    else problems.push(`settings.json: the defaults of front-end kind "${kind.slice(0, 40)}" were not valid and were dropped`)
  }
  for (const [id, value] of Object.entries(isRecord(u.devices) ? u.devices : {})) {
    const decoded = decodeV3Device(value)
    if (isDeviceId(id) && decoded._tag === "Some") devices[id] = decoded.value
    else problems.push(`settings.json: the record of device "${id.slice(0, 64)}" was not valid and was dropped`)
  }
  return { frontends, devices }
}

/**
 * A stored type entry is a complete `DeviceSettings`: one written before a section key existed (`look`, `voice`,
 * docs/LOOKS-AND-VOICES.md; `place`, `capabilities`, protocol 11) lacks it and takes the built-in's, so it loads whole
 * and behaves as before.
 */
const withNewKeys = (value: unknown, kind: string): unknown => {
  if (!isRecord(value)) return value
  const builtIn: DeviceSettings = deviceTypeOf(kind)?.builtIn ?? BUILT_IN_WEB_VOICE_SETTINGS
  const missing: Record<string, unknown> = {}
  for (const key of ["look", "voice", "place", "capabilities"] as const) if (value[key] === undefined) missing[key] = builtIn[key]
  return { ...missing, ...value }
}

/** The entities of a version-4 file; entries that do not decode are dropped, each with a problem. */
const readEntities = (u: Record<string, unknown>, problems: Array<string>): AssistantsData & { readonly migration?: MigrationRecord } => {
  const list = isRecord(u.assistants) ? u.assistants : {}
  const byId: Record<string, Assistant> = {}
  for (const [id, value] of Object.entries(isRecord(list.byId) ? list.byId : {})) {
    const decoded = decodeAssistant(value)
    if (decoded._tag === "Some" && decoded.value.id === id) byId[id] = decoded.value
    else problems.push(`settings.json: assistant "${id.slice(0, 40)}" was not valid and was dropped`)
  }
  const listed = Array.isArray(list.order) ? list.order.filter((id): id is string => typeof id === "string" && Object.hasOwn(byId, id)) : []
  const order = [...new Set([...listed, ...Object.keys(byId)])]
  const deviceTypes: Record<string, StoredDeviceType> = {}
  for (const [kind, value] of Object.entries(isRecord(u.deviceTypes) ? u.deviceTypes : {})) {
    const decoded = decodeDeviceType(withNewKeys(value, kind))
    if (isKindId(kind) && decoded._tag === "Some") deviceTypes[kind] = decoded.value
    else problems.push(`settings.json: the defaults of device type "${kind.slice(0, 40)}" were not valid and were dropped`)
  }
  const devices: Record<string, StoredDevice> = {}
  for (const [id, value] of Object.entries(isRecord(u.devices) ? u.devices : {})) {
    const decoded = decodeDevice(value)
    if (isDeviceId(id) && decoded._tag === "Some") devices[id] = decoded.value
    else problems.push(`settings.json: the record of device "${id.slice(0, 64)}" was not valid and was dropped`)
  }
  const m = u.migration
  const migration = isRecord(m) && typeof m.from === "number" && typeof m.at === "number" && Array.isArray(m.notes)
    ? { migration: { from: m.from, at: m.at, notes: m.notes.filter((n): n is string => typeof n === "string") } }
    : {}
  return { assistants: { order, byId }, deviceTypes, devices, ...migration }
}

/**
 * Read `settings.json` of version 1 to 5 (exported for tests). The revision is kept. Version 4 is read as version 5
 * (`migrateV4ToV5`, `migrated`); versions 1–3 as version 3 with the version they had (`from`), for `migrateToV4`.
 * A newer version is not read (`newerSettings` stops the start before this).
 */
export const readStoredSettings = (u: unknown): Read<StoredSettings> | undefined => {
  if (!isRecord(u) || !optionalRecords(u.modules)) return undefined
  const modules = (u.modules ?? {}) as SettingsFile["modules"]
  if ((u.version === 4 || u.version === 5) && (u.assistant === undefined || isRecord(u.assistant))) {
    if (["assistants", "deviceTypes", "devices"].some((k) => u[k] !== undefined && !isRecord(u[k]))) return undefined
    const problems: Array<string> = []
    const from = u.version
    const file = migrateV4ToV5({ version: from, ...revisionField(u), modules, assistant: (u.assistant ?? {}) as Record<string, unknown>, ...readEntities(u, problems) })
    return { file: { version: 5, file, from }, migrated: from === 4, problems }
  }
  if ((u.version === 2 || u.version === 3) && (u.assistant === undefined || isRecord(u.assistant))) {
    if (u.version === 3 && ((u.frontends !== undefined && !isRecord(u.frontends)) || (u.devices !== undefined && !isRecord(u.devices)))) {
      return undefined
    }
    const problems: Array<string> = []
    const frontendData = u.version === 3 ? readFrontendData(u, problems) : { frontends: {}, devices: {} }
    const file: SettingsFileV3 = { version: 3, ...revisionField(u), modules, assistant: (u.assistant ?? {}) as Record<string, unknown>, ...frontendData }
    return { file: { version: 3, file, from: u.version }, migrated: true, problems }
  }
  if (u.version === 1 && optionalRecords(u.sections)) {
    const { flat, problems } = flattenSections((u.sections ?? {}) as Record<string, Record<string, unknown>>, "settings.json")
    const file: SettingsFileV3 = { version: 3, ...revisionField(u), modules, assistant: flat, frontends: {}, devices: {} }
    return { file: { version: 3, file, from: 1 }, migrated: true, problems }
  }
  return undefined
}

/**
 * Read `settings.json` of any version as the current one (exported for tests): an older file is migrated in memory
 * (`migrateToV4`, without secrets, or `migrateV4ToV5`). `migrated`: it was not the current version.
 */
export const readSettingsFile = (
  u: unknown,
  options: { readonly context?: AssistantContext; readonly now?: number } = {}
): Read<SettingsFile> | undefined => {
  const read = readStoredSettings(u)
  if (read === undefined) return undefined
  const stored = read.file
  return {
    file: stored.version === 5 ? stored.file : migrateToV4({ file: stored.file, from: stored.from, context: options.context ?? {}, now: options.now ?? Date.now() }),
    migrated: read.migrated || stored.version === 3,
    problems: read.problems
  }
}

const emptyStored = (): StoredSettings => ({
  version: 3,
  file: { version: 3, modules: {}, assistant: {}, frontends: {}, devices: {} },
  from: 0
})

const readSecretsFile = (u: unknown): Read<SecretsFile> | undefined => {
  if (!isRecord(u) || !optionalRecords(u.modules) || !Object.values(u.modules ?? {}).every(allStrings)) return undefined
  const modules = (u.modules ?? {}) as SecretsFile["modules"]
  if (u.version === 2 && (u.assistant === undefined || (isRecord(u.assistant) && allStrings(u.assistant)))) {
    return {
      file: { version: 2, ...revisionField(u), modules, assistant: (u.assistant ?? {}) as Record<string, string> },
      migrated: false,
      problems: []
    }
  }
  if (u.version === 1 && optionalRecords(u.sections) && Object.values(u.sections ?? {}).every(allStrings)) {
    const { flat, problems } = flattenSections((u.sections ?? {}) as Record<string, Record<string, string>>, "secrets.json")
    return { file: { version: 2, ...revisionField(u), modules, assistant: flat }, migrated: true, problems }
  }
  return undefined
}

const validSettings = (u: unknown) => readStoredSettings(u) !== undefined
const validSecrets = (u: unknown) => readSecretsFile(u) !== undefined

/** The message of a save refused because the vault is locked. */
export const KEYS_LOCKED_MESSAGE = "Keys are locked — unlock them in Settings → Keys & access"

export interface SettingsStore {
  readonly directory: string
  readonly settings: () => SettingsFile
  /**
   * P5: `listener(before, after)` runs synchronously in the step that commits a new settings state, before anything
   * else can run (the device boundary, `serveMode.ts`). Returns an unsubscribe function.
   */
  readonly onCommitted: (listener: (before: SettingsFile, after: SettingsFile) => void) => () => void
  /** The secrets in effect: the vault's (empty while it is locked) once a vault exists, else `data/secrets.json`. */
  readonly secrets: () => SecretsFile
  /** Keys still in `data/secrets.json` (a count; 0 when the file is gone or empty). */
  readonly legacySecretCount: () => number
  /**
   * Move the keys of `data/secrets.json` into the unlocked vault (values already in the vault win) and delete the
   * file. Returns how many keys came from the file (0 when there was none). Never in read-only mode.
   */
  readonly importLegacySecrets: () => Effect.Effect<number, SettingsStoreError>
  /** The revision of the last save (`undefined` before revisions): a new vault starts with it (`Keys.setup`). */
  readonly revision: () => number | undefined
  /** Problems found while loading (a corrupt file that was set aside), for the log and the UI. */
  readonly problems: ReadonlyArray<string>
  /**
   * Why the settings and keys loaded may not belong together (they may come from two saves), until the next
   * successful save; `undefined` when they do. Nothing that uses them should start meanwhile.
   */
  readonly blocked: () => string | undefined
  /** Called once when `blocked()` becomes `undefined` (after a successful save). */
  readonly onUnblocked: (listener: () => void) => void
  readonly saveModule: (
    id: string,
    record: { readonly enabled: boolean; readonly settings: Readonly<Record<string, SettingValue>>; readonly secrets: Readonly<Record<string, string>> }
  ) => Effect.Effect<void, SettingsStoreError>
  /**
   * Save assistant settings: every key in `keys` takes its value from `values` / `secrets`, or is removed when
   * absent there (back to the default). Keys not in `keys` are left as they are.
   */
  readonly saveAssistant: (
    keys: ReadonlyArray<string>,
    values: Readonly<Record<string, SettingValue>>,
    secrets: Readonly<Record<string, string>>
  ) => Effect.Effect<void, SettingsStoreError>
  /**
   * Save the remembered devices (a device seen for the first time, its last visit, forgotten): `change` maps the
   * committed records to the new ones. Refused while `blocked()` (see the header). Never touches the secrets.
   */
  readonly saveDeviceRecords: (what: string, change: (committed: Readonly<Record<string, StoredDevice>>) => Readonly<Record<string, StoredDevice>>) => Effect.Effect<void, SettingsStoreError>
  /** The assistants as stored, in the admin's order. */
  readonly assistants: () => ReadonlyArray<Assistant>
  /**
   * The assistants in effect: the migrated assistant with its fields set by the environment applied, and the
   * fields that locks (docs/ASSISTANTS.md §1.2); others as stored, with none.
   */
  readonly assistantsInEffect: () => ReadonlyArray<{ readonly assistant: Assistant; readonly locks: ReadonlyArray<EnvironmentLock> }>
  /** Create an assistant (its id from its name, `rev` 0), last in the order. `limit_reached` at `MAX_ASSISTANTS`. */
  readonly createAssistant: (body: AssistantBody) => Effect.Effect<Assistant, SettingsStoreError | EntitySaveError>
  /**
   * Save a whole assistant. Its `rev` must be the stored one (else `stale`); it is stored with `rev + 1`, which is
   * returned. A field locked by the environment must be unchanged (its effective or stored value), else `locked`;
   * the stored value of a locked field is kept.
   */
  readonly saveAssistantRecord: (assistant: Assistant) => Effect.Effect<Assistant, SettingsStoreError | EntitySaveError>
  /**
   * Delete an assistant (`rev` as for a save). It leaves every assignment list; a `withoutPhrase` naming it becomes
   * `nobody`, a TypeSafe fallback naming it the first remaining assistant (docs/ASSISTANTS.md §2.6).
   */
  readonly deleteAssistantRecord: (id: string, rev: number) => Effect.Effect<void, SettingsStoreError | EntitySaveError>
  /** Save a device type's complete defaults (`rev` as for an assistant; a type never saved has `rev` 0). */
  readonly saveDeviceType: (kind: string, rev: number, settings: DeviceSettings) => Effect.Effect<StoredDeviceType, SettingsStoreError | EntitySaveError>
  /**
   * P5: a person was removed from Members: every device type and device whose `place.defaultPerson` is not one of
   * `known` gets nobody instead (each changed entity's `rev` moves on). Nothing is written when nothing points elsewhere.
   */
  readonly clearDefaultPeople: (known: ReadonlySet<string>) => Effect.Effect<number, SettingsStoreError | EntitySaveError>
  /** Save a remembered device's own sections and, when given, its name (`rev` as for an assistant). */
  readonly saveDevice: (
    id: string,
    rev: number,
    change: { readonly name?: string; readonly own: DeviceOwn }
  ) => Effect.Effect<StoredDevice, SettingsStoreError | EntitySaveError>
  /** The module host's view of the store. */
  readonly modulePersistence: ModulePersistence
  /**
   * P3: replace the module route tokens (`RouteTokens.ts`), kept with the module secrets under the entry
   * `ROUTE_TOKENS_ENTRY` (not a module id), so they live in the key vault once there is one. `change` maps the
   * committed entry to the new one. Refused while the vault is locked.
   */
  readonly saveRouteTokens: (change: (committed: Readonly<Record<string, string>>) => Readonly<Record<string, string>>) => Effect.Effect<void, SettingsStoreError>
}

/** P3: where route tokens are kept among the module secrets; never a module id (they cannot contain "@"). */
export const ROUTE_TOKENS_ENTRY = "@route-tokens"

export interface LoadOptions {
  /** Never write (CLI modes): a corrupt file is reported but left in place, and saves are ignored. */
  readonly readOnly?: boolean
  /** Required unless `readOnly`: the data directory's writer lock, held for as long as the store is used. */
  readonly lock?: DataDirLock
  /** The key vault. Without one (or while it does not exist yet) secrets stay in `data/secrets.json`. */
  readonly vault?: Vault
  /** For tests. Default `Date.now`. */
  readonly now?: () => number
  /**
   * For tests: called before each disk step of a save (`journal`, `secrets`, `settings`, `rollback`,
   * `journal-remove`); throwing makes that step fail. A test can also copy the directory here to see what
   * a restart after a crash at that point would load. A returned promise is awaited (a test pauses the save there).
   */
  readonly beforeStep?: (step: SaveStep) => void | Promise<void>
  /** For tests: called before recovery writes a file back (throwing, or blocking the path, makes it fail). */
  readonly beforeRecoveryWrite?: () => void
  /**
   * For tests, writable loads: called (and awaited) before each file operation of the startup: removing a
   * temporary file, setting a damaged journal or a corrupt file aside, recovery writing a file back or removing
   * the journal, migrating a version-1 file. A test pauses the startup there.
   */
  readonly beforeStartupStep?: (step: StartupStep) => void | Promise<void>
  /**
   * For tests, read-only loads: called after each file a snapshot reads (`journal`, `settings`, `secrets`,
   * `journal-again`), so a test can run a whole save between two reads.
   */
  readonly afterRead?: (file: "journal" | "settings" | "secrets" | "journal-again", attempt: number) => void | Promise<void>
  /** For tests, read-only loads: attempts before giving up (default `SNAPSHOT_ATTEMPTS`). */
  readonly snapshotAttempts?: number
  /**
   * The environment and the module catalog: what the version-3 migration reads (effective values: environment >
   * saved > default; which modules were on), and which fields of the migrated assistant the environment locks.
   * Without it: no environment, and module switches only as saved.
   */
  readonly assistants?: AssistantContext
}

/** A read-only load reads the files at most this many times while they keep changing (about 1 s in all). */
export const SNAPSHOT_ATTEMPTS = 20

export type SaveStep = "journal" | "secrets" | "settings" | "rollback" | "journal-remove"
export type StartupStep =
  | "remove-temporary"
  | "set-aside-journal"
  | "recover-secrets"
  | "recover-settings"
  | "recover-journal-remove"
  | "set-aside-file"
  | "migrate-settings"
  | "migrate-assistants"
  | "migrate-settings-v5"

/**
 * Before each file operation of a writable startup: a check that the lock is still held (its release has not
 * begun), then the test hook. Stopping between two steps is safe: the journal is removed last, so the next start
 * resolves the transaction again.
 */
type StartupGate = (step: StartupStep) => Promise<void>

const startupGate = (directory: string, options: LoadOptions): StartupGate => async (step) => {
  if (options.lock?.held() !== true) {
    throw new SettingsStoreError({ message: `Stopped loading the settings in ${directory}: the server is stopping (its writer lock is being released)` })
  }
  // After the check, as the file operation itself: a test pausing here holds an operation that has begun.
  await options.beforeStartupStep?.(step)
}

/** Where the secrets are kept: `data/secrets.json`, or the key vault's file. */
type SecretsKind = "file" | "vault"

const JOURNAL_VERSION = 2
/** The Claude subscription agent module, whose per-assistant settings are mirrored into the migrated assistant. */
const SUBSCRIPTION_MODULE_ID = "claude-subscription"

interface Journal {
  /** 1: written before the settings screen (secrets always in `secrets.json`). */
  readonly version: 1 | 2
  readonly secrets?: SecretsKind
  readonly prior: { readonly settings: string; readonly secrets: string }
  readonly next: { readonly settings: string; readonly secrets: string }
}

const journalKind = (journal: Journal): SecretsKind => journal.secrets ?? "file"

const parses = (text: string, valid: (u: unknown) => boolean) => {
  try {
    return valid(JSON.parse(text))
  } catch {
    return false
  }
}

/** Whether `text` is a valid secrets file of `kind`. */
const validSecretsText = (kind: SecretsKind, text: string) => (kind === "vault" ? isVaultText(text) : parses(text, validSecrets))

/** A journal whose four texts are each valid files: only such a journal is ever written back. */
const validJournal = (u: unknown): u is Journal => {
  if (!isRecord(u)) return false
  const kind: SecretsKind | undefined = u.version === 1 ? "file" : u.version === 2 && (u.secrets === "file" || u.secrets === "vault") ? u.secrets : undefined
  if (kind === undefined) return false
  const pair = (p: unknown) =>
    isRecord(p) && typeof p.settings === "string" && typeof p.secrets === "string" &&
    parses(p.settings, validSettings) && validSecretsText(kind, p.secrets)
  return pair(u.prior) && pair(u.next)
}

/** Files a crash or a failed save may leave behind that can hold secrets. */
const leftover = {
  temporary: (name: string) => /^(settings|secrets|transaction)\.json\.tmp$/.test(name),
  journalAside: (name: string) => name.startsWith("transaction.json.corrupt-"),
  secretsAside: (name: string) => name.startsWith("secrets.json.corrupt-")
}

/** The `revision` of a file's text (`undefined`: none, missing, or not valid JSON). Works for the vault's file too. */
const revisionOf = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  try {
    const u = JSON.parse(text) as unknown
    return isRecord(u) && typeof u.revision === "number" ? u.revision : undefined
  } catch {
    return undefined
  }
}

/**
 * The two files' revisions do not rule out one save: equal, or a vault file from before revisions (written before
 * this version: its pairing with `settings.json` cannot be known, so it is taken as it is, like two files without one).
 */
const revisionsAgree = (kind: SecretsKind, settings: string | undefined, secrets: string | undefined) =>
  revisionOf(settings) === revisionOf(secrets) || (kind === "vault" && secrets !== undefined && revisionOf(secrets) === undefined)

/** Both files carry the same revision: written by one save. */
const provenTogether = (settings: string | undefined, secrets: string | undefined) => {
  const a = revisionOf(settings)
  return a !== undefined && a === revisionOf(secrets)
}

const twoSaves = (directory: string, why: string) =>
  `The settings and the keys in ${directory} may come from two different saves (${why}), so the engines and the ` +
  "modules were not started. Check every page of Settings (keys included: enter again any key you changed or " +
  "removed just before the assistant stopped) and save once; the assistant then starts with what you saved."

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * Writes `content` to `path` atomically with `mode`. The temporary file is created fresh (`wx`, after removing
 * a stale one), so its content is never written into an existing file with wider permissions.
 */
const writeAtomic = async (directory: string, path: string, content: string, mode: number) => {
  await mkdir(directory, { recursive: true })
  const tmp = `${path}.tmp`
  await rm(tmp, { force: true })
  await writeFile(tmp, content, { mode, flag: "wx" })
  await chmod(tmp, mode)
  await rename(tmp, path)
}

/** The error for a journal written by a newer version (`undefined` for any other journal). */
const newerJournal = (journalPath: string, journal: unknown) =>
  isRecord(journal) && typeof journal.version === "number" && journal.version > JOURNAL_VERSION
    ? new SettingsStoreError({
      message: `${journalPath} was written by a newer version of the assistant (journal version ${journal.version}), ` +
        "which had not finished saving the settings. Start that version again so it can finish; " +
        `or, to keep the files as they are, delete ${journalPath}.`
    })
    : undefined

const parseOrUndefined = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Paths {
  readonly settings: string
  readonly journal: string
  /** The secrets file of each kind (`vault` absent without a vault). */
  readonly secrets: { readonly file: string; readonly vault?: string }
}

const secretsPathOf = (paths: Paths, kind: SecretsKind, journalPath: string): string => {
  const path = paths.secrets[kind]
  if (path === undefined) {
    throw new SettingsStoreError({
      message: `${journalPath} records a save of the key vault, but no key vault was given; start the server (pnpm start serve) to finish it.`
    })
  }
  return path
}

/**
 * Read-only loads (the CLI modes, beside a server that may be saving): the texts of one committed state, read
 * without writing and without the lock. Each attempt reads the journal, settings, secrets and the journal again:
 * - the journal appeared, disappeared or changed during the read: a save was running; read again;
 * - the same journal both times: the state it says is committed (`next` if both files hold it, else `prior`),
 *   exactly what the writer's recovery would choose;
 * - no journal: the two files, if their revisions are equal. A save is written secrets first and read settings
 *   first, so a save that falls between the two reads shows as two different revisions; read again.
 * At most `SNAPSHOT_ATTEMPTS` attempts (about 1 s with the pauses between them). Then it fails, and never returns
 * a mix: with "come from two saves" when the files stayed the same (a writer is needed to settle them), else with
 * "kept changing".
 */
const readSnapshot = async (
  directory: string,
  paths: Paths,
  kind: SecretsKind,
  options: LoadOptions,
  problems: Array<string>
): Promise<{ readonly settings: string | undefined; readonly secrets: string | undefined; readonly kind: SecretsKind }> => {
  const attempts = Math.max(1, options.snapshotAttempts ?? SNAPSHOT_ATTEMPTS)
  let previous: string | undefined
  let stable = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(50, 5 * attempt))
    const journalText = await readText(paths.journal)
    await options.afterRead?.("journal", attempt)
    const journal = journalText === undefined ? undefined : parseOrUndefined(journalText)
    const newer = newerJournal(paths.journal, journal)
    if (newer !== undefined) throw newer
    // The secrets file this attempt compares: the one a valid journal names, else where the secrets are now.
    const readKind = validJournal(journal) ? journalKind(journal) : kind
    const settings = await readText(paths.settings)
    await options.afterRead?.("settings", attempt)
    // A newer format is refused here too (the CLI modes), before any comparison.
    const newerFile = newerSettings(paths.settings, settings)
    if (newerFile !== undefined) throw newerFile
    const secrets = await readText(secretsPathOf(paths, readKind, paths.journal))
    await options.afterRead?.("secrets", attempt)
    const journalAgain = await readText(paths.journal)
    await options.afterRead?.("journal-again", attempt)
    const key = JSON.stringify([journalText, settings, secrets, journalAgain])
    stable = key === previous
    previous = key
    if (journalText !== journalAgain) continue
    if (journalText !== undefined) {
      if (validJournal(journal)) {
        const chosen = settings === journal.next.settings && secrets === journal.next.secrets ? journal.next : journal.prior
        return { ...chosen, kind: readKind }
      }
      // Damaged: the files can be used only if they provably belong to one save.
      if (provenTogether(settings, secrets)) {
        problems.push(`${paths.journal} is damaged (the server sets it aside at its next start); the settings and keys belong to one save`)
        return { settings, secrets, kind: readKind }
      }
      continue
    }
    if (revisionsAgree(readKind, settings, secrets)) return { settings, secrets, kind: readKind }
  }
  throw new SettingsStoreError({
    message: stable
      ? `The settings and the keys in ${directory} come from two different saves, so they were not used. Start the ` +
        "server (pnpm start serve), check Settings and save once; then try again."
      : `The settings in ${directory} kept changing while they were read (a save in progress?); try again.`
  })
}

/**
 * Writer only: resolves a transaction left by a save that did not finish (a crash, or a failure whose rollback
 * failed too). `"damaged"`: the journal could not be used and was set aside; `"vault-restored"`: the vault's file
 * was written back.
 */
const recover = async (
  directory: string,
  paths: Paths,
  options: LoadOptions,
  problems: Array<string>,
  gate: StartupGate
): Promise<"damaged" | "vault-restored" | undefined> => {
  const raw = await readText(paths.journal)
  if (raw === undefined) return undefined
  const journal = parseOrUndefined(raw)
  const newer = newerJournal(paths.journal, journal)
  if (newer !== undefined) throw newer
  if (!validJournal(journal)) {
    // Written atomically, so not a torn write: damaged on disk. Nothing in it can be trusted to write back, and
    // the files may hold different saves (a crash between the two writes). Set aside, 0600: it holds secrets.
    const aside = `${paths.journal}.corrupt-${new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}`
    await gate("set-aside-journal")
    await rename(paths.journal, aside)
    await chmod(aside, 0o600)
    return "damaged"
  }
  const secretsPath = secretsPathOf(paths, journalKind(journal), paths.journal)
  const onDisk = { settings: await readText(paths.settings), secrets: await readText(secretsPath) }
  const completed = onDisk.settings === journal.next.settings && onDisk.secrets === journal.next.secrets
  const keep = completed ? journal.next : journal.prior
  let restoredVault = false
  try {
    if (!completed) {
      options.beforeRecoveryWrite?.()
      if (onDisk.secrets !== keep.secrets) {
        await gate("recover-secrets")
        await writeAtomic(dirname(secretsPath), secretsPath, keep.secrets, 0o600)
        restoredVault = journalKind(journal) === "vault"
      }
      if (onDisk.settings !== keep.settings) {
        await gate("recover-settings")
        await writeAtomic(directory, paths.settings, keep.settings, 0o644)
      }
      problems.push("A settings save had not finished when the assistant stopped; the settings from before it were restored")
    }
    await gate("recover-journal-remove")
    await rm(paths.journal, { force: true })
  } catch (cause) {
    if (cause instanceof SettingsStoreError) throw cause // stopping
    throw new SettingsStoreError({
      message: `A settings save had not finished when the assistant stopped, and finishing it failed (${(cause as Error).message}). ` +
        `Make sure ${directory} is writable and the disk is not full, then start again: ${paths.journal} is kept, ` +
        "so nothing is lost.",
      cause
    })
  }
  return restoredVault ? "vault-restored" : undefined
}

/**
 * Where the migration keeps the original: `settings.json.<tag>-backup`, unless that holds something else already
 * (an earlier migration's original): then with the time after it, so no backup is overwritten.
 */
const backupPath = async (settingsPath: string, tag: string, original: string, options: LoadOptions): Promise<string> => {
  const plainPath = `${settingsPath}.${tag}-backup`
  const existing = await readText(plainPath)
  if (existing === undefined || existing === original) return plainPath
  return `${plainPath}-${new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}`
}

/** A file's text parsed and migrated; a corrupt one is set aside (writer) or reported (read-only). */
const loadFile = async <A>(
  path: string,
  read: (u: unknown) => Read<A> | undefined,
  empty: () => A,
  options: LoadOptions,
  problems: Array<string>,
  text: string | undefined,
  gate: StartupGate
): Promise<{ readonly file: A; readonly migrated: boolean }> => {
  if (text === undefined) return { file: empty(), migrated: false }
  const result = read(parseOrUndefined(text))
  if (result !== undefined) {
    problems.push(...result.problems)
    return { file: result.file, migrated: result.migrated }
  }
  if (options.readOnly === true) {
    problems.push(`${path} is not valid settings JSON; using defaults (the file was left as it is)`)
    return { file: empty(), migrated: false }
  }
  const aside = `${path}.corrupt-${new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-")}`
  await gate("set-aside-file")
  await rename(path, aside)
  problems.push(`${path} could not be read and was renamed to ${aside}; everything starts from the defaults`)
  return { file: empty(), migrated: false }
}

class KeysUnavailable extends Error {}

const text = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`
/** Secrets without their file's version and revision: what a save compares to tell whether a secret changed. */
const plain = (s: { readonly modules: SecretsFile["modules"]; readonly assistant: SecretsFile["assistant"] }) =>
  JSON.stringify({ modules: s.modules, assistant: s.assistant })
const withRevision = <A extends { readonly revision?: number }>(file: A, revision: number | undefined): A => {
  const { revision: _, ...rest } = file
  return (revision === undefined ? rest : { ...rest, revision }) as A
}

export const loadSettingsStore = (directory: string, options: LoadOptions = {}): Effect.Effect<SettingsStore, SettingsStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const problems: Array<string> = []
      const lock = options.lock
      const readOnly = options.readOnly === true
      if (!readOnly && (lock === undefined || !lock.held())) {
        throw new SettingsStoreError({ message: `Cannot write the settings in ${directory} without holding its writer lock` })
      }
      const vault = options.vault
      const vaultInUse = () => vault !== undefined && vault.state() !== "none"
      const settingsPath = join(directory, "settings.json")
      const secretsPath = join(directory, "secrets.json")
      const journalPath = join(directory, "transaction.json")
      const paths: Paths = {
        settings: settingsPath,
        journal: journalPath,
        secrets: { file: secretsPath, ...(vault !== undefined ? { vault: vault.path } : {}) }
      }
      let blockedProblem: string | undefined
      const gate = startupGate(directory, options)
      /**
       * Everything a writable startup writes (temporary files removed, a damaged journal or a corrupt file set
       * aside, a transaction recovered, a version-1 file migrated) runs under the lock's release gate: an
       * interrupted start (its scope closed while a file operation runs) cannot release the lock before that
       * operation has settled, and stops before the next one.
       */
      const startup = async () => {
        let kind: SecretsKind = vaultInUse() ? "vault" : "file"
        let texts: { readonly settings: string | undefined; readonly secrets: string | undefined }
        if (readOnly) {
          const snapshot = await readSnapshot(directory, paths, kind, options, problems)
          kind = snapshot.kind
          texts = snapshot
        } else {
          // A newer format stops the start before anything is written to the data directory (no leftover tidied, no
          // journal recovered, nothing migrated): settings.json itself, and both sides of an unfinished save.
          const refused = await newerOnDisk(settingsPath, journalPath)
          if (refused !== undefined) throw refused
          const asidesBefore = await tidyLeftovers(directory, problems, gate)
          const recovered = await recover(directory, paths, options, problems, gate)
          const damaged = recovered === "damaged"
          if (recovered === "vault-restored" && vault?.state() === "unlocked") {
            // Unlocked before the load: its keys in memory are the ones just undone.
            vault.lock()
            problems.push("The key vault was put back to the keys from before an unfinished save; unlock it again")
          }
          texts = { settings: await readText(settingsPath), secrets: await readText(secretsPathOf(paths, kind, journalPath)) }
          const together = provenTogether(texts.settings, texts.secrets)
          if (damaged) {
            problems.push(
              together
                ? `${journalPath} (an unfinished settings save) is damaged and was set aside; the settings and the keys on disk belong to one save.`
                : `${journalPath} (an unfinished settings save) is damaged and was set aside. The settings and the keys were ` +
                  "loaded as they are, but may come from two different saves: check Settings, and enter again any key you " +
                  "changed or removed just before the assistant stopped."
            )
            if (!together) blockedProblem = twoSaves(directory, "the record of an unfinished save was damaged")
          } else if (asidesBefore > 0 && !together) {
            // A damaged journal was set aside at an earlier start and nothing has been saved since.
            blockedProblem = twoSaves(directory, "the record of an unfinished save was damaged, and nothing was saved since")
          } else if (
            texts.settings !== undefined && texts.secrets !== undefined && parses(texts.settings, validSettings) &&
            validSecretsText(kind, texts.secrets) && !revisionsAgree(kind, texts.settings, texts.secrets)
          ) {
            blockedProblem = twoSaves(
              directory,
              kind === "vault" ? "settings.json and the key vault were written by different saves" : "settings.json and secrets.json were written by different saves"
            )
          }
        }
        const settingsText = texts.settings
        // A newer format stops here, before anything could set the file aside or write over it.
        const newer = newerSettings(settingsPath, settingsText)
        if (newer !== undefined) throw newer
        const loadedSettings = await loadFile(settingsPath, readStoredSettings, emptyStored, options, problems, settingsText, gate)
        // `secrets.json`: the secrets themselves (no vault), or keys left to import into the vault.
        const fileText = kind === "file" ? texts.secrets : await readText(secretsPath)
        const loadedSecrets = await loadFile(secretsPath, readSecretsFile, emptySecrets, options, problems, fileText, gate)
        // A read-only load with the vault: the keys of the vault file the snapshot chose, under the key the CLI
        // unlocked with (else what the vault itself holds).
        const vaultSecrets = readOnly && kind === "vault" && texts.secrets !== undefined
          ? vault?.decode(texts.secrets) ?? vault?.secrets()
          : undefined
        const stored = loadedSettings.file
        let settingsFile: SettingsFile
        if (stored.version === 5) {
          settingsFile = stored.file
          if (stored.from === 4 && !readOnly) {
            // Version 4 → 5: the original next to it, then version 5 with the same revision (one write).
            await gate("migrate-settings-v5")
            const backup = await backupPath(settingsPath, "v4", settingsText ?? "", options)
            await writeFile(backup, settingsText ?? "", { mode: 0o644 })
            await writeAtomic(directory, settingsPath, text(settingsFile), 0o644)
            problems.push(
              `${settingsPath} was migrated to version 5 (people, rooms and device capabilities); the original is in ${backup}. ` +
                "An assistant from before this version cannot read the new file: to go back to one, put the original back first."
            )
          }
        } else {
          // Version 1–3 → 4 (docs/ASSISTANTS.md §6). The keys are read only for whether a module's key is set.
          const keys = kind === "vault" ? (readOnly ? vaultSecrets : vault?.secrets()) : loadedSecrets.file
          settingsFile = migrateToV4({
            file: stored.file,
            from: stored.from,
            secrets: { assistant: keys?.assistant ?? {}, modules: keys?.modules ?? {} },
            context: options.assistants ?? {},
            now: (options.now ?? Date.now)()
          })
          if (stored.from > 0 && !readOnly) {
            // Keep the original next to it, then write the current version with the same revision (secrets.json, if it was
            // version 1, is rewritten at its next save). One write: a reader sees the old file or the new one.
            await gate(stored.from === 1 ? "migrate-settings" : "migrate-assistants")
            const backup = await backupPath(settingsPath, stored.from === 1 ? "v1" : "v3", settingsText ?? "", options)
            await writeFile(backup, settingsText ?? "", { mode: 0o644 })
            await writeAtomic(directory, settingsPath, text(settingsFile), 0o644)
            const notes = settingsFile.migration?.notes ?? []
            problems.push(
              `${settingsPath} was migrated to version ${SETTINGS_VERSION} (assistants and devices); the original is in ${backup}.` +
                (notes.length > 0 ? ` What changed: ${notes.join(" ")}` : "")
            )
          }
        }
        return {
          settings: settingsFile,
          secrets: loadedSecrets.file,
          secretsMigrated: loadedSecrets.migrated,
          secretsText: fileText,
          vaultText: kind === "vault" ? texts.secrets : undefined,
          vaultSecrets
        }
      }
      const loaded = readOnly || lock === undefined ? await startup() : await lock.guard("loading and recovering the settings", startup)
      let settings = loaded.settings
      /** `secrets.json` as committed: the secrets without a vault, else the keys still to import. */
      let secrets = loaded.secrets
      const readOnlyVaultSecrets: SecretsFile | undefined = loaded.vaultText === undefined || !readOnly
        ? undefined
        : { version: 2, modules: loaded.vaultSecrets?.modules ?? {}, assistant: loaded.vaultSecrets?.assistant ?? {} }
      let revision = Math.max(settings.revision ?? 0, secrets.revision ?? 0, revisionOf(loaded.vaultText) ?? 0)
      const unblockListeners: Array<() => void> = []
      /**
       * P5: called synchronously in the step that makes a new state the committed one (before the save's caller runs
       * again, and before any other fiber), with the state before and after. A listener's error is logged, never the
       * save's.
       */
      const commitListeners = new Set<(before: SettingsFile, after: SettingsFile) => void>()
      const notifyCommitted = (before: SettingsFile, after: SettingsFile) => {
        if (before === after) return
        for (const listener of commitListeners) {
          try {
            listener(before, after)
          } catch (error) {
            console.error("settings: a commit listener failed", error)
          }
        }
      }

      const fromVault = (): SecretsFile => {
        const s = vault?.secrets()
        return s === undefined ? emptySecrets() : { version: 2, modules: s.modules, assistant: s.assistant }
      }
      const current = (): SecretsFile =>
        readOnlyVaultSecrets !== undefined ? readOnlyVaultSecrets : !readOnly && vaultInUse() ? fromVault() : secrets
      const countKeys = (file: SecretsFile) =>
        Object.values(file.modules).reduce((n, r) => n + Object.keys(r).length, Object.keys(file.assistant).length)

      /**
       * Every save is one read/modify/persist step under a lock, against the committed state. The new state
       * is published in memory only after both files are written, so a failed save leaves the live settings
       * as they were ("nothing was changed" is true). Each file is written when its content differs from
       * what is known to be on disk (not from what is in memory), so a retry after a failure never skips a
       * file that was not saved. Secrets go first (a key the UI reports saved is never lost); if the
       * settings write then fails, the secrets file is put back, and if even that fails, the content on
       * disk is remembered so the next save rewrites it, and the journal (see above) makes a restart
       * restore the committed state. The disk work cannot be interrupted half way: an interrupted request
       * would release the lock while its writes still run.
       */
      const disk = {
        settings: text(settings),
        // A migrated (version-1) secrets.json is not what `text(secrets)` says: rewritten at the next save.
        secrets: loaded.secretsMigrated ? loaded.secretsText ?? "" : text(secrets)
      }
      /** With the vault: its file may hold secrets that are not the committed ones (a failed rollback). */
      let vaultDirty = false
      const permit = Semaphore.makeUnsafe(1)
      const write = (path: string, content: string, mode: number) => writeAtomic(directory, path, content, mode)
      type State = { settings: SettingsFile; secrets: SecretsFile }
      type Change = (committed: State) => State
      const persist = (what: string, change: Change, after?: () => Promise<void>) =>
        permit.withPermit(Effect.uninterruptible(Effect.tryPromise({
          // Also under the lock's release gate (see DataDirLock): the lock is not released before the save settles.
          try: () =>
            readOnly || lock === undefined
              ? saveNow(change, after)
              : lock.guard(`saving ${what}`, () => saveNow(change, after)),
          catch: (cause): SettingsStoreError | EntitySaveError =>
            cause instanceof EntitySaveError ? cause : new SettingsStoreError({
              message: cause instanceof KeysUnavailable ? cause.message : `Could not save ${what} in ${directory}`,
              cause
            })
        })))
      /** A save whose refusals (`EntitySaveError`) are thrown inside `change`. */
      const persistSettings = (what: string, change: Change, after?: () => Promise<void>) =>
        persist(what, change, after).pipe(Effect.catchTag("EntitySaveError", (e) => Effect.die(e))) as Effect.Effect<void, SettingsStoreError>

      const saveNow = async (change: Change, after?: () => Promise<void>) => {
        if (readOnly) {
          const next = change({ settings, secrets: current() })
          const committedBefore = settings
          settings = next.settings
          notifyCommitted(committedBefore, settings)
          if (readOnlyVaultSecrets === undefined) secrets = next.secrets
          return
        }
        if (lock?.held() !== true) throw new Error(`the writer lock of ${directory} is no longer held`)
        const saved = vaultInUse() ? await vault!.exclusive((writer) => saveToVault(writer, change)) : await saveToFile(change)
        if (saved && !asidesRemoved) {
          // The state on disk is now one the owner saved after the damage: set-aside journals are moot.
          await removeJournalAsides(directory).then(() => void (asidesRemoved = true), () => {})
        }
        await after?.()
        if (blockedProblem !== undefined) {
          blockedProblem = undefined
          for (const listener of unblockListeners.splice(0)) listener()
        }
      }

      /** Without a vault: `secrets.json` and `settings.json`, both with a new revision. `false`: nothing to write. */
      const saveToFile = async (change: Change): Promise<boolean> => {
        let next = change({ settings, secrets })
        const unchanged = text(next.settings) === text(settings) && text(next.secrets) === text(secrets) &&
          disk.settings === text(settings) && disk.secrets === text(secrets)
        // Nothing to write, unless the files may come from two saves: then saving them again is the owner's
        // word that they are right (and gives them one revision).
        if (unchanged && blockedProblem === undefined) return false
        // Every save writes both files with a new revision (see "Revisions"); a failed one uses its number up.
        revision = Math.max(revision + 1, (options.now ?? Date.now)())
        next = { settings: withRevision(next.settings, revision), secrets: withRevision(next.secrets, revision) }
        const wantSecrets = text(next.secrets)
        const wantSettings = text(next.settings)
        // Also while a journal from a failed save is still on disk: it must describe this save, not that one.
        const journaled = journalOnDisk || (wantSecrets !== disk.secrets && wantSettings !== disk.settings)
        if (journaled) {
          await writeJournal({
            version: JOURNAL_VERSION,
            secrets: "file",
            prior: { settings: text(settings), secrets: text(secrets) },
            next: { settings: wantSettings, secrets: wantSecrets }
          })
        }
        if (wantSecrets !== disk.secrets) {
          await options.beforeStep?.("secrets")
          await write(secretsPath, wantSecrets, 0o600)
          disk.secrets = wantSecrets
        }
        if (wantSettings !== disk.settings) {
          try {
            await options.beforeStep?.("settings")
            await write(settingsPath, wantSettings, 0o644)
            disk.settings = wantSettings
          } catch (error) {
            const committedSecrets = text(secrets)
            if (disk.secrets !== committedSecrets) {
              try {
                await options.beforeStep?.("rollback")
                await write(secretsPath, committedSecrets, 0o600)
                disk.secrets = committedSecrets
              } catch {
                // disk.secrets still says what is there: the next save rewrites it, and the journal
                // stays, so a restart before then restores the committed state.
                throw error
              }
            }
            if (journaled) await removeJournal()
            throw error
          }
        }
        if (journaled) await removeJournalAfterSave()
        const committedBefore = settings
        settings = next.settings
        notifyCommitted(committedBefore, settings)
        secrets = next.secrets
        return true
      }

      /**
       * With the vault: its file and `settings.json`. A save that changes no secret (and needs none rewritten)
       * writes `settings.json` alone with the vault's revision, so it works while the keys are locked; one that
       * changes a secret needs them unlocked and writes both with a new revision, journaled. `false`: nothing to write.
       */
      const saveToVault = async (writer: VaultWriter, change: Change): Promise<boolean> => {
        const committed = fromVault()
        const unlocked = vault!.secrets() !== undefined
        const next = change({ settings, secrets: committed })
        const secretsChanged = plain(next.secrets) !== plain(committed) || vaultDirty
        const unchanged = !secretsChanged && text(next.settings) === text(settings) && disk.settings === text(settings)
        if (unchanged && blockedProblem === undefined) return false
        const vaultPath = vault!.path
        const onDiskVault = await readText(vaultPath)
        const writeVault = secretsChanged || (blockedProblem !== undefined && unlocked)
        if (!writeVault) {
          // One file: atomic, no journal. Its revision is the vault's: the pair stays one committed state.
          const wantSettings = text(withRevision(next.settings, revisionOf(onDiskVault)))
          await options.beforeStep?.("settings")
          await write(settingsPath, wantSettings, 0o644)
          disk.settings = wantSettings
          const committedBefore = settings
          settings = JSON.parse(wantSettings) as SettingsFile
          notifyCommitted(committedBefore, settings)
          return true
        }
        if (!unlocked) throw new KeysUnavailable(KEYS_LOCKED_MESSAGE)
        // The committed vault text: the file, unless a failed rollback left other secrets in it.
        const priorVault = vaultDirty || onDiskVault === undefined ? writer.encode(committed, settings.revision) : onDiskVault
        revision = Math.max(revision + 1, (options.now ?? Date.now)())
        const wantVault = writer.encode({ modules: next.secrets.modules, assistant: next.secrets.assistant }, revision)
        if (wantVault === undefined || priorVault === undefined) throw new KeysUnavailable(KEYS_LOCKED_MESSAGE)
        const nextSettings = withRevision(next.settings, revision)
        const wantSettings = text(nextSettings)
        await writeJournal({
          version: JOURNAL_VERSION,
          secrets: "vault",
          prior: { settings: text(settings), secrets: priorVault },
          next: { settings: wantSettings, secrets: wantVault }
        })
        await options.beforeStep?.("secrets")
        await writer.writeText(wantVault)
        vaultDirty = true
        try {
          await options.beforeStep?.("settings")
          await write(settingsPath, wantSettings, 0o644)
          disk.settings = wantSettings
        } catch (error) {
          try {
            await options.beforeStep?.("rollback")
            await writer.writeText(priorVault)
            vaultDirty = false
          } catch {
            // vaultDirty stays: the next save rewrites the vault, and the journal stays, so a restart before
            // then restores the committed state.
            throw error
          }
          await removeJournal()
          throw error
        }
        vaultDirty = false
        await removeJournalAfterSave()
        writer.adopt({ modules: next.secrets.modules, assistant: next.secrets.assistant }, revision)
        const committedBefore = settings
        settings = nextSettings
        notifyCommitted(committedBefore, settings)
        return true
      }

      let journalOnDisk = false
      let asidesRemoved = false
      const writeJournal = async (journal: Journal) => {
        await options.beforeStep?.("journal")
        await write(journalPath, `${JSON.stringify(journal)}\n`, 0o600)
        journalOnDisk = true
      }
      const removeJournal = async () => {
        await options.beforeStep?.("journal-remove")
        await rm(journalPath, { force: true })
        journalOnDisk = false
      }
      // Both files hold the new state: a restart that finds the journal keeps it (see `recover`), and the next
      // save that journals rewrites and removes it. It stays 0600 meanwhile.
      const removeJournalAfterSave = () => removeJournal().catch(() => {})

      type Group = Readonly<Record<string, Readonly<Record<string, string>>>>
      const withSecrets = (group: Group, id: string, values: Readonly<Record<string, string>>): Group => {
        const out = { ...group }
        if (Object.keys(values).length === 0) delete out[id]
        else out[id] = values
        return out
      }

      const context: AssistantContext = options.assistants ?? {}
      /** `file` with the migrated assistant changed by `f` (and its `rev` raised), when it exists and `f` changes it. */
      const withMigrated = (file: SettingsFile, f: (a: Assistant) => Assistant): SettingsFile => {
        const a = file.assistants.byId[MIGRATED_ASSISTANT_ID]
        if (a === undefined) return file
        const next = f(a)
        if (JSON.stringify(next) === JSON.stringify(a)) return file
        return { ...file, assistants: { ...file.assistants, byId: { ...file.assistants.byId, [a.id]: { ...next, rev: a.rev + 1 } } } }
      }

      const saveModule: SettingsStore["saveModule"] = (id, record) =>
        persistSettings(`the settings of module ${id}`, (committed) => ({
          settings: withMigrated(
            { ...committed.settings, modules: { ...committed.settings.modules, [id]: { enabled: record.enabled, settings: record.settings } } },
            (a) => {
              const switched = mirrorModuleSwitch(a, id, record.enabled, context)
              // The Claude subscription agent's per-assistant settings (WP-13a), changed in its module form.
              return id === SUBSCRIPTION_MODULE_ID
                ? mirrorSubscriptionSettings(switched, committed.settings.modules[id]?.settings ?? {}, record.settings, context)
                : switched
            }
          ),
          secrets: { ...committed.secrets, modules: withSecrets(committed.secrets.modules, id, record.secrets) }
        }))

      const replaceKeys = <V>(base: Readonly<Record<string, V>>, keys: ReadonlyArray<string>, next: Readonly<Record<string, V>>) => {
        const out: Record<string, V> = { ...base }
        for (const key of keys) {
          if (Object.hasOwn(next, key)) out[key] = next[key]!
          else delete out[key]
        }
        return out
      }
      const saveAssistant: SettingsStore["saveAssistant"] = (keys, values, assistantSecrets) =>
        persistSettings("the assistant settings", (committed) => {
          const flat = replaceKeys(committed.settings.assistant, keys, values)
          return {
            settings: withMigrated(
              { ...committed.settings, assistant: flat },
              (a) => mirrorFlatKeys(a, keys, flat, committed.settings.modules, context)
            ),
            secrets: { ...committed.secrets, assistant: replaceKeys(committed.secrets.assistant, keys, assistantSecrets) }
          }
        })

      const importLegacySecrets: SettingsStore["importLegacySecrets"] = () =>
        Effect.suspend(() => {
          if (readOnly || vault === undefined) return Effect.succeed(0)
          let count = 0
          const merge = (a: VaultSecrets["modules"], b: VaultSecrets["modules"]) => {
            const out: Record<string, Readonly<Record<string, string>>> = { ...b }
            for (const [id, keys] of Object.entries(a)) out[id] = { ...(b[id] ?? {}), ...keys }
            return out
          }
          const deleteFile = async () => {
            try {
              await unlink(secretsPath)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            }
            secrets = emptySecrets()
            disk.secrets = text(secrets)
          }
          if (vault.secrets() === undefined) {
            return Effect.fail(new SettingsStoreError({ message: KEYS_LOCKED_MESSAGE }))
          }
          if (countKeys(secrets) === 0) {
            return permit.withPermit(Effect.uninterruptible(Effect.tryPromise({
              try: () => (lock === undefined ? deleteFile() : lock.guard(`deleting ${secretsPath}`, deleteFile)),
              catch: (cause) => new SettingsStoreError({ message: `Could not delete ${secretsPath}`, cause })
            }))).pipe(Effect.as(0))
          }
          // Moving keys is not the owner's word that settings from two saves belong together (only a save from the
          // settings screen is): it would give both files one revision, and a restart would no longer block.
          if (blockedProblem !== undefined) {
            return Effect.fail(new SettingsStoreError({
              message: `${secretsPath} still holds ${countKeys(secrets)} key(s); they move into the vault after the settings are saved once`
            }))
          }
          return persistSettings(
            `${secretsPath} into the vault`,
            (committed) => {
              if (vault.secrets() === undefined) throw new KeysUnavailable(KEYS_LOCKED_MESSAGE)
              count = countKeys(secrets)
              if (count === 0) return committed
              // The vault's values win over the file's.
              return {
                settings: committed.settings,
                secrets: {
                  ...committed.secrets,
                  modules: merge(committed.secrets.modules, secrets.modules),
                  assistant: { ...secrets.assistant, ...committed.secrets.assistant }
                }
              }
            },
            // After the vault holds them (a crash before this only leaves the file to import again).
            deleteFile
          ).pipe(Effect.map(() => count))
        })

      const saveDeviceRecords: SettingsStore["saveDeviceRecords"] = (what, change) =>
        Effect.suspend(() =>
          blockedProblem !== undefined
            ? Effect.fail(new SettingsStoreError({ message: `${what} was not saved: ${blockedProblem}` }))
            : persistSettings(what, (committed) => ({
              settings: { ...committed.settings, devices: change(committed.settings.devices) },
              secrets: committed.secrets
            }))
        )

      // -- Entities (docs/ASSISTANTS.md §1.2 "Admin transport"): saved whole, each with its `rev`.
      const refuse = (code: EntitySaveError["code"], message: string) => new EntitySaveError({ code, message })
      const stale = (what: string, rev: number, stored: number) =>
        refuse("stale", `${what} was changed elsewhere (saved ${stored} time${stored === 1 ? "" : "s"}, this page had ${rev}); reload it`)
      /** Run a change of the entities; `change` may throw an `EntitySaveError` (nothing is written then). */
      const persistEntities = <A>(what: string, change: (committed: SettingsFile) => { readonly file: SettingsFile; readonly result: A }) =>
        Effect.suspend(() => {
          let result: A | undefined
          return persist(what, (committed) => {
            const out = change(committed.settings)
            result = out.result
            return { settings: out.file, secrets: committed.secrets }
          }).pipe(Effect.map(() => result as A))
        })
      const withAssistant = (list: AssistantList, a: Assistant): AssistantList => ({
        order: list.order.includes(a.id) ? list.order : [...list.order, a.id],
        byId: { ...list.byId, [a.id]: a }
      })

      const createAssistant: SettingsStore["createAssistant"] = (body) =>
        persistEntities(`the new assistant ${body.name.slice(0, 32)}`, (file) => {
          if (file.assistants.order.length >= MAX_ASSISTANTS) throw refuse("limit_reached", `There can be at most ${MAX_ASSISTANTS} assistants`)
          const assistant: Assistant = { ...body, id: makeAssistantId(body.name, file.assistants.order), rev: 0 }
          return { file: { ...file, assistants: withAssistant(file.assistants, assistant) }, result: assistant }
        })

      const saveAssistantRecord: SettingsStore["saveAssistantRecord"] = (incoming) =>
        persistEntities(`assistant ${incoming.id}`, (file) => {
          const stored = file.assistants.byId[incoming.id]
          if (stored === undefined) throw refuse("unknown_assistant", `There is no assistant ${incoming.id}`)
          if (incoming.rev !== stored.rev) throw stale(`Assistant ${stored.name}`, incoming.rev, stored.rev)
          const { assistant: inEffect, locks } = withEnvironment(stored, context)
          let next: Assistant = { ...incoming, id: stored.id, rev: stored.rev + 1 }
          for (const lock of locks) {
            const value = JSON.stringify(getPath(incoming, lock.field))
            if (value !== JSON.stringify(getPath(inEffect, lock.field)) && value !== JSON.stringify(getPath(stored, lock.field))) {
              throw refuse("locked", `${lock.field} is set by ${lock.key} in the environment; change it there, or move it to the settings first`)
            }
            next = setPath(next, lock.field, getPath(stored, lock.field))
          }
          return { file: { ...file, assistants: withAssistant(file.assistants, next) }, result: next }
        })

      const deleteAssistantRecord: SettingsStore["deleteAssistantRecord"] = (id, rev) =>
        persistEntities(`deleting assistant ${id}`, (file) => {
          const stored = file.assistants.byId[id]
          if (stored === undefined) throw refuse("unknown_assistant", `There is no assistant ${id}`)
          if (rev !== stored.rev) throw stale(`Assistant ${stored.name}`, rev, stored.rev)
          const byId = { ...file.assistants.byId }
          delete byId[id]
          const deviceTypes: Record<string, StoredDeviceType> = {}
          for (const [kind, t] of Object.entries(file.deviceTypes)) {
            const next = removeAssistantFromSettings(t, id)
            deviceTypes[kind] = JSON.stringify(next) === JSON.stringify(t) ? t : { ...next, rev: t.rev + 1 }
          }
          const devices: Record<string, StoredDevice> = {}
          for (const [deviceId, d] of Object.entries(file.devices)) {
            const inherited = (deviceTypes[d.kind] ?? deviceTypeOf(d.kind)?.builtIn)?.assistants ?? []
            const own = removeAssistantFromSettings(d.own, id, inherited)
            devices[deviceId] = JSON.stringify(own) === JSON.stringify(d.own) ? d : { ...d, own, rev: d.rev + 1 }
          }
          return {
            file: { ...file, assistants: { order: file.assistants.order.filter((x) => x !== id), byId }, deviceTypes, devices },
            result: undefined
          }
        })

      const saveDeviceType: SettingsStore["saveDeviceType"] = (kind, rev, deviceSettings) =>
        persistEntities(`the defaults of ${kind}`, (file) => {
          const stored = file.deviceTypes[kind]
          if (stored === undefined && deviceTypeOf(kind) === undefined) throw refuse("unknown_device", `There is no device type ${kind}`)
          const storedRev = stored?.rev ?? 0
          if (rev !== storedRev) throw stale(`The defaults of ${kind}`, rev, storedRev)
          // A type with no stored defaults is reported at rev 0, so its first save stores 1: every save moves the rev on.
          const next: StoredDeviceType = { ...deviceSettings, rev: storedRev + 1 }
          return { file: { ...file, deviceTypes: { ...file.deviceTypes, [kind]: next } }, result: next }
        })

      const saveDevice: SettingsStore["saveDevice"] = (id, rev, change) =>
        persistEntities(`device ${id}`, (file) => {
          const stored = file.devices[id]
          if (stored === undefined) throw refuse("unknown_device", "That device is not known (it may have been forgotten)")
          if (rev !== stored.rev) throw stale(`Device ${stored.name}`, rev, stored.rev)
          const next: StoredDevice = { ...stored, ...(change.name !== undefined ? { name: change.name.trim() } : {}), own: change.own, rev: stored.rev + 1 }
          return { file: { ...file, devices: { ...file.devices, [id]: next } }, result: next }
        })

      const clearDefaultPeople: SettingsStore["clearDefaultPeople"] = (known) =>
        Effect.suspend(() => {
          const dangling = (person: string | null | undefined) => person !== null && person !== undefined && !known.has(person)
          const file = settings
          const any = Object.values(file.deviceTypes).some((t) => dangling(t.place?.defaultPerson)) ||
            Object.values(file.devices).some((d) => dangling(d.own.place?.defaultPerson))
          if (!any) return Effect.succeed(0)
          let count = 0
          return persistEntities("the devices of a removed person", (committed) => {
            const deviceTypes: Record<string, StoredDeviceType> = {}
            for (const [kind, t] of Object.entries(committed.deviceTypes)) {
              if (t.place !== undefined && dangling(t.place.defaultPerson)) {
                deviceTypes[kind] = { ...t, place: { ...t.place, defaultPerson: null }, rev: t.rev + 1 }
                count++
              } else deviceTypes[kind] = t
            }
            const devices: Record<string, StoredDevice> = {}
            for (const [id, d] of Object.entries(committed.devices)) {
              const place = d.own.place
              if (place !== undefined && dangling(place.defaultPerson)) {
                devices[id] = { ...d, own: { ...d.own, place: { ...place, defaultPerson: null } }, rev: d.rev + 1 }
                count++
              } else devices[id] = d
            }
            return { file: { ...committed, deviceTypes, devices }, result: undefined }
          }).pipe(Effect.map(() => count))
        })

      const ordered = () => settings.assistants.order.flatMap((id) => (settings.assistants.byId[id] !== undefined ? [settings.assistants.byId[id]!] : []))

      const store: SettingsStore = {
        directory,
        settings: () => settings,
        onCommitted: (listener) => {
          commitListeners.add(listener)
          return () => commitListeners.delete(listener)
        },
        secrets: current,
        legacySecretCount: () => countKeys(secrets),
        importLegacySecrets,
        revision: () => settings.revision,
        problems,
        blocked: () => blockedProblem,
        onUnblocked: (listener) => {
          if (blockedProblem === undefined) return
          unblockListeners.push(listener)
        },
        saveModule,
        saveAssistant,
        saveDeviceRecords,
        clearDefaultPeople,
        assistants: ordered,
        assistantsInEffect: () => ordered().map((a) => withEnvironment(a, context)),
        createAssistant,
        saveAssistantRecord,
        deleteAssistantRecord,
        saveDeviceType,
        saveDevice,
        modulePersistence: {
          initial: { modules: settings.modules, secrets: current().modules },
          save: saveModule
        },
        saveRouteTokens: (change) =>
          persistSettings("the route tokens", (committed) => ({
            settings: committed.settings,
            secrets: {
              ...committed.secrets,
              modules: withSecrets(committed.secrets.modules, ROUTE_TOKENS_ENTRY, change(committed.secrets.modules[ROUTE_TOKENS_ENTRY] ?? {}))
            }
          }))
      }
      return store
    },
    catch: (cause) =>
      cause instanceof SettingsStoreError ? cause : new SettingsStoreError({ message: `Could not read the settings in ${directory}`, cause })
  })

/**
 * Startup, writer only: removes temporary files of writes that never completed (they were never renamed into
 * place), makes every other leftover that may hold secrets 0600, and counts those in a problem.
 */
const tidyLeftovers = async (directory: string, problems: Array<string>, gate: StartupGate): Promise<number> => {
  let names: Array<string>
  try {
    names = await readdir(directory)
  } catch {
    return 0 // no directory yet
  }
  for (const name of names.filter(leftover.temporary)) {
    await gate("remove-temporary")
    await rm(join(directory, name), { force: true })
  }
  const kept = names.filter((n) => leftover.journalAside(n) || leftover.secretsAside(n) || n === "transaction.json")
  for (const name of kept) await chmod(join(directory, name), 0o600).catch(() => {})
  const asides = kept.filter((n) => n !== "transaction.json")
  if (asides.length > 0) {
    problems.push(
      `${asides.length} set-aside file${asides.length === 1 ? "" : "s"} in ${directory} may hold old keys (${asides.join(", ")}; mode 0600). ` +
        "Set-aside journals are removed after the next successful save; delete the others once you no longer need them."
    )
  }
  return names.filter(leftover.journalAside).length
}

const removeJournalAsides = async (directory: string) => {
  for (const name of (await readdir(directory)).filter(leftover.journalAside)) await rm(join(directory, name), { force: true })
}
