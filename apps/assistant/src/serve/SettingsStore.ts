import type { ModulePersistence } from "@pva/core"
import type { SettingValue } from "@pva/protocol"
import { Config, Effect, Schema, Semaphore } from "effect"
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { userCwd } from "../env.ts"
import type { DataDirLock } from "./DataDirLock.ts"

/**
 * `data/settings.json` (module intent and values, assistant settings sections)
 * and `data/secrets.json` (mode 0600, secrets only) — docs/UI-AND-MODULES.md §1.6.
 * Only values the owner set are stored. Both files are read once at startup;
 * the server is their only writer. Writes are atomic (temporary file, then
 * rename) and serialised; memory changes only after a successful write.
 *
 * A save that changes both files is a transaction recorded in `data/transaction.json` (mode 0600: it holds
 * secrets), written before either file is replaced: the committed state (`prior`) and the state being saved
 * (`next`). It is removed when the save ends. At load an unfinished one is resolved before anything is read:
 * if both files hold `next` the save had completed (only the journal's removal was missed) and it stands;
 * otherwise both files are put back to `prior`, the state the failed save reported it kept.
 *
 * One writer: a writable store needs the data directory's lock (`DataDirLock.ts`), taken before anything is read
 * or recovered, and checks it before every save. A second server on the same directory therefore refuses to
 * start; it can neither recover a transaction that is still running nor save over the first one's changes from
 * its own stale copy. Read-only loads (the CLI modes) take no lock and never write.
 *
 * A journal that cannot be used (unreadable, or its contents are not valid settings) is set aside as
 * `transaction.json.corrupt-<time>` (0600) and the two files are loaded as they are, with a startup problem
 * saying they may come from different saves. One from a newer version of the assistant stops the start (this
 * version cannot tell what it means). Leftovers that may hold secrets (set-aside journals, a journal whose
 * removal failed, temporary files) are kept 0600, counted in a startup problem, and removed: temporary files at
 * startup, set-aside journals after the next successful save.
 *
 * Revisions: every save writes both files, each with the save's `revision` (one more than any before; a failed
 * save uses one up too), after the journal and in the order secrets, then settings. Two files with the same
 * revision are therefore one committed save, and two with different ones are not. This is what lets a reader
 * that takes no lock see one save (`readSnapshot`), and lets the writer tell, after a damaged journal, whether the
 * two files belong together. Files from before revisions (none in either) are taken as they are.
 *
 * Settings and keys that may come from two saves (a damaged journal, unless the revisions prove the files belong
 * together; or two files with different revisions) are not used to start anything: `blocked()` says why, and the
 * next successful save clears it (the owner has then looked at and saved the settings).
 */

export interface SettingsFile {
  readonly version: 1
  /** The save that wrote this file; both files of one save carry the same one (see "Revisions" above). */
  readonly revision?: number
  readonly modules: Readonly<Record<string, { readonly enabled?: boolean; readonly settings?: Readonly<Record<string, unknown>> }>>
  readonly sections: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export interface SecretsFile {
  readonly version: 1
  readonly revision?: number
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
  /** Required unless `readOnly`: the data directory's writer lock, held for as long as the store is used. */
  readonly lock?: DataDirLock
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
   * the journal. A test pauses the startup there.
   */
  readonly beforeStartupStep?: (step: StartupStep) => void | Promise<void>
  /**
   * For tests, read-only loads: called after each file a snapshot reads (`journal`, `settings`, `secrets`,
   * `journal-again`), so a test can run a whole save between two reads.
   */
  readonly afterRead?: (file: "journal" | "settings" | "secrets" | "journal-again", attempt: number) => void | Promise<void>
  /** For tests, read-only loads: attempts before giving up (default `SNAPSHOT_ATTEMPTS`). */
  readonly snapshotAttempts?: number
}

/** A read-only load reads the files at most this many times while they keep changing (about 1 s in all). */
export const SNAPSHOT_ATTEMPTS = 20

export type SaveStep = "journal" | "secrets" | "settings" | "rollback" | "journal-remove"
export type StartupStep = "remove-temporary" | "set-aside-journal" | "recover-secrets" | "recover-settings" | "recover-journal-remove" | "set-aside-file"

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

interface Journal {
  readonly version: 1
  readonly prior: { readonly settings: string; readonly secrets: string }
  readonly next: { readonly settings: string; readonly secrets: string }
}

const parses = <A>(text: string, valid: (u: unknown) => u is A) => {
  try {
    return valid(JSON.parse(text))
  } catch {
    return false
  }
}

/** A journal whose four texts are each valid files: only such a journal is ever written back. */
const validJournal = (u: unknown): u is Journal => {
  const pair = (p: unknown) =>
    isRecord(p) && typeof p.settings === "string" && typeof p.secrets === "string" &&
    parses(p.settings, validSettings) && parses(p.secrets, validSecrets)
  return isRecord(u) && u.version === 1 && pair(u.prior) && pair(u.next)
}

/** Files a crash or a failed save may leave behind that can hold secrets. */
const leftover = {
  temporary: (name: string) => /^(settings|secrets|transaction)\.json\.tmp$/.test(name),
  journalAside: (name: string) => name.startsWith("transaction.json.corrupt-"),
  secretsAside: (name: string) => name.startsWith("secrets.json.corrupt-")
}

/** The `revision` of a file's text (`undefined`: none, missing, or not valid JSON). */
const revisionOf = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined
  try {
    const u = JSON.parse(text) as unknown
    return isRecord(u) && typeof u.revision === "number" ? u.revision : undefined
  } catch {
    return undefined
  }
}

/** Both files carry the same revision: written by one save. */
const provenTogether = (settings: string | undefined, secrets: string | undefined) => {
  const a = revisionOf(settings)
  return a !== undefined && a === revisionOf(secrets)
}

const twoSaves = (directory: string, why: string) =>
  `The settings and the keys in ${directory} may come from two different saves (${why}), so the engines and the ` +
  "modules were not started. Check every page of Options (keys included: enter again any key you changed or " +
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
  isRecord(journal) && typeof journal.version === "number" && journal.version > 1
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
  paths: { readonly settings: string; readonly secrets: string; readonly journal: string },
  options: LoadOptions,
  problems: Array<string>
): Promise<{ readonly settings: string | undefined; readonly secrets: string | undefined }> => {
  const attempts = Math.max(1, options.snapshotAttempts ?? SNAPSHOT_ATTEMPTS)
  let previous: string | undefined
  let stable = false
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(50, 5 * attempt))
    const journalText = await readText(paths.journal)
    await options.afterRead?.("journal", attempt)
    const settings = await readText(paths.settings)
    await options.afterRead?.("settings", attempt)
    const secrets = await readText(paths.secrets)
    await options.afterRead?.("secrets", attempt)
    const journalAgain = await readText(paths.journal)
    await options.afterRead?.("journal-again", attempt)
    const key = JSON.stringify([journalText, settings, secrets, journalAgain])
    stable = key === previous
    previous = key
    if (journalText !== journalAgain) continue
    if (journalText !== undefined) {
      const journal = parseOrUndefined(journalText)
      const newer = newerJournal(paths.journal, journal)
      if (newer !== undefined) throw newer
      if (validJournal(journal)) {
        return settings === journal.next.settings && secrets === journal.next.secrets ? journal.next : journal.prior
      }
      // Damaged: the files can be used only if they provably belong to one save.
      if (provenTogether(settings, secrets)) {
        problems.push(`${paths.journal} is damaged (the server sets it aside at its next start); the settings and keys belong to one save`)
        return { settings, secrets }
      }
      continue
    }
    if (revisionOf(settings) === revisionOf(secrets)) return { settings, secrets }
  }
  throw new SettingsStoreError({
    message: stable
      ? `The settings and the keys in ${directory} come from two different saves, so they were not used. Start the ` +
        "server (pnpm start serve), check Options and save once; then try again."
      : `The settings in ${directory} kept changing while they were read (a save in progress?); try again.`
  })
}

/**
 * Writer only: resolves a transaction left by a save that did not finish (a crash, or a failure whose rollback
 * failed too). `"damaged"`: the journal could not be used and was set aside.
 */
const recover = async (
  directory: string,
  paths: { readonly settings: string; readonly secrets: string; readonly journal: string },
  options: LoadOptions,
  problems: Array<string>,
  gate: StartupGate
): Promise<{ readonly settings: string; readonly secrets: string } | "damaged" | undefined> => {
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
  const onDisk = { settings: await readText(paths.settings), secrets: await readText(paths.secrets) }
  const completed = onDisk.settings === journal.next.settings && onDisk.secrets === journal.next.secrets
  const keep = completed ? journal.next : journal.prior
  try {
    if (!completed) {
      options.beforeRecoveryWrite?.()
      if (onDisk.secrets !== keep.secrets) {
        await gate("recover-secrets")
        await writeAtomic(directory, paths.secrets, keep.secrets, 0o600)
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
  return undefined
}

const loadFile = async <A>(
  path: string,
  valid: (u: unknown) => u is A,
  empty: () => A,
  options: LoadOptions,
  problems: Array<string>,
  text: string | undefined,
  gate: StartupGate
): Promise<A> => {
  if (text === undefined) return empty()
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
  await gate("set-aside-file")
  await rename(path, aside)
  problems.push(`${path} could not be read and was renamed to ${aside}; everything starts from the defaults`)
  return empty()
}

export const loadSettingsStore = (directory: string, options: LoadOptions = {}): Effect.Effect<SettingsStore, SettingsStoreError> =>
  Effect.tryPromise({
    try: async () => {
      const problems: Array<string> = []
      const lock = options.lock
      if (options.readOnly !== true && (lock === undefined || !lock.held())) {
        throw new SettingsStoreError({ message: `Cannot write the settings in ${directory} without holding its writer lock` })
      }
      const settingsPath = join(directory, "settings.json")
      const secretsPath = join(directory, "secrets.json")
      const journalPath = join(directory, "transaction.json")
      const paths = { settings: settingsPath, secrets: secretsPath, journal: journalPath }
      let blockedProblem: string | undefined
      const gate = startupGate(directory, options)
      /**
       * Everything a writable startup writes (temporary files removed, a damaged journal or a corrupt file set
       * aside, a transaction recovered) runs under the lock's release gate: an interrupted start (its scope closed
       * while a file operation runs) cannot release the lock before that operation has settled, and stops before
       * the next one.
       */
      const startup = async () => {
        let texts: { readonly settings: string | undefined; readonly secrets: string | undefined }
        if (options.readOnly === true) {
          texts = await readSnapshot(directory, paths, options, problems)
        } else {
          const asidesBefore = await tidyLeftovers(directory, problems, gate)
          const damaged = (await recover(directory, paths, options, problems, gate)) === "damaged"
          texts = { settings: await readText(settingsPath), secrets: await readText(secretsPath) }
          const together = provenTogether(texts.settings, texts.secrets)
          if (damaged) {
            problems.push(
              together
                ? `${journalPath} (an unfinished settings save) is damaged and was set aside; the settings and the keys on disk belong to one save.`
                : `${journalPath} (an unfinished settings save) is damaged and was set aside. The settings and the keys were ` +
                  "loaded as they are, but may come from two different saves: check Options, and enter again any key you " +
                  "changed or removed just before the assistant stopped."
            )
            if (!together) blockedProblem = twoSaves(directory, "the record of an unfinished save was damaged")
          } else if (asidesBefore > 0 && !together) {
            // A damaged journal was set aside at an earlier start and nothing has been saved since.
            blockedProblem = twoSaves(directory, "the record of an unfinished save was damaged, and nothing was saved since")
          } else if (
            texts.settings !== undefined && texts.secrets !== undefined && parses(texts.settings, validSettings) &&
            parses(texts.secrets, validSecrets) && revisionOf(texts.settings) !== revisionOf(texts.secrets)
          ) {
            blockedProblem = twoSaves(directory, "settings.json and secrets.json were written by different saves")
          }
        }
        return {
          settings: await loadFile(settingsPath, validSettings, emptySettings, options, problems, texts.settings, gate),
          secrets: await loadFile(secretsPath, validSecrets, emptySecrets, options, problems, texts.secrets, gate)
        }
      }
      const loaded = options.readOnly === true || lock === undefined ? await startup() : await lock.guard("loading and recovering the settings", startup)
      let settings = loaded.settings
      let secrets = loaded.secrets
      let revision = Math.max(settings.revision ?? 0, secrets.revision ?? 0)
      const unblockListeners: Array<() => void> = []

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
      const text = (data: unknown) => `${JSON.stringify(data, null, 2)}\n`
      const disk = { settings: text(settings), secrets: text(secrets) }
      const permit = Semaphore.makeUnsafe(1)
      const write = (path: string, content: string, mode: number) => writeAtomic(directory, path, content, mode)
      type Change = (committed: { settings: SettingsFile; secrets: SecretsFile }) => { settings: SettingsFile; secrets: SecretsFile }
      const persist = (what: string, change: Change) =>
        permit.withPermit(Effect.uninterruptible(Effect.tryPromise({
          // Also under the lock's release gate (see DataDirLock): the lock is not released before the save settles.
          try: () => options.readOnly === true || lock === undefined ? saveNow(change) : lock.guard(`saving ${what}`, () => saveNow(change)),
          catch: (cause) => new SettingsStoreError({ message: `Could not save ${what} in ${directory}`, cause })
        })))
      const saveNow = async (change: Change) => {
            let next = change({ settings, secrets })
            if (options.readOnly !== true) {
              if (lock?.held() !== true) throw new Error(`the writer lock of ${directory} is no longer held`)
              const unchanged = text(next.settings) === text(settings) && text(next.secrets) === text(secrets) &&
                disk.settings === text(settings) && disk.secrets === text(secrets)
              // Nothing to write, unless the files may come from two saves: then saving them again is the owner's
              // word that they are right (and gives them one revision).
              if (unchanged && blockedProblem === undefined) return
              // Every save writes both files with a new revision (see "Revisions"); a failed one uses its number up.
              revision = Math.max(revision + 1, (options.now ?? Date.now)())
              next = { settings: { ...next.settings, revision }, secrets: { ...next.secrets, revision } }
              const wantSecrets = text(next.secrets)
              const wantSettings = text(next.settings)
              // Also while a journal from a failed save is still on disk: it must describe this save, not that one.
              const journaled = journalOnDisk || (wantSecrets !== disk.secrets && wantSettings !== disk.settings)
              if (journaled) {
                const journal: Journal = {
                  version: 1,
                  prior: { settings: text(settings), secrets: text(secrets) },
                  next: { settings: wantSettings, secrets: wantSecrets }
                }
                await options.beforeStep?.("journal")
                await write(journalPath, `${JSON.stringify(journal)}\n`, 0o600)
                journalOnDisk = true
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
              if (journaled) await removeJournal().catch(() => {
                // Both files hold the new state: a restart that finds the journal keeps it (see `recover`), and
                // the next save that journals rewrites and removes it. It stays 0600 meanwhile.
              })
              if (!asidesRemoved) {
                // The state on disk is now one the owner saved after the damage: set-aside journals are moot.
                await removeJournalAsides(directory).then(() => void (asidesRemoved = true), () => {})
              }
            }
            settings = next.settings
            secrets = next.secrets
            if (options.readOnly !== true && blockedProblem !== undefined) {
              blockedProblem = undefined
              for (const listener of unblockListeners.splice(0)) listener()
            }
          }
      let journalOnDisk = false
      let asidesRemoved = false
      const removeJournal = async () => {
        await options.beforeStep?.("journal-remove")
        await rm(journalPath, { force: true })
        journalOnDisk = false
      }

      const saveModule: SettingsStore["saveModule"] = (id, record) =>
        persist(`the settings of module ${id}`, (committed) => {
          const modules = { ...committed.secrets.modules }
          if (Object.keys(record.secrets).length === 0) delete modules[id]
          else modules[id] = record.secrets
          return {
            settings: { ...committed.settings, modules: { ...committed.settings.modules, [id]: { enabled: record.enabled, settings: record.settings } } },
            secrets: { ...committed.secrets, modules }
          }
        })

      const saveSection: SettingsStore["saveSection"] = (id, values, sectionSecrets) =>
        persist(`the ${id} settings`, (committed) => {
          const sections = { ...committed.secrets.sections }
          if (Object.keys(sectionSecrets).length === 0) delete sections[id]
          else sections[id] = sectionSecrets
          return {
            settings: { ...committed.settings, sections: { ...committed.settings.sections, [id]: values } },
            secrets: { ...committed.secrets, sections }
          }
        })

      const store: SettingsStore = {
        directory,
        settings: () => settings,
        secrets: () => secrets,
        problems,
        blocked: () => blockedProblem,
        onUnblocked: (listener) => {
          if (blockedProblem === undefined) return
          unblockListeners.push(listener)
        },
        saveModule,
        saveSection,
        modulePersistence: {
          initial: { modules: settings.modules, secrets: secrets.modules },
          save: saveModule
        }
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
