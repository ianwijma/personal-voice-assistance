import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { DatabaseSync } from "node:sqlite"

/**
 * Files of the household store (docs/STORING-DATA.md "Backups", "Restore"): everything private to the user (directories
 * `0700`, files `0600`, whatever the umask), every copy written to a temporary file of its own and published with one
 * `rename`, and the retention of every archive the store makes.
 */

/** Run `run` while the data directory's writer lock cannot be released (serve, restore); default: just run it. */
export type FileGuard = <A>(what: string, run: () => Promise<A>) => Promise<A>
export const unguarded: FileGuard = (_what, run) => run()

/** Make `dir` (and its parents) with mode 0700; an existing directory the store made keeps its mode. */
export const privateDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** Narrow an existing file to 0600 (the database and its sidecars, made by an older version or by hand). */
export const narrow = async (path: string): Promise<void> => {
  const s = await stat(path).catch(() => undefined)
  if (s !== undefined && (s.mode & 0o077) !== 0) await chmod(path, s.mode & 0o700)
}

/** An empty new file of our own beside `path` (`<path>.<tag>-<pid>-<random>`), mode 0600. */
export const freshFile = async (path: string, tag: string): Promise<string> => {
  const file = `${path}.${tag}-${process.pid}-${randomBytes(6).toString("hex")}`
  const handle = await open(file, "wx", 0o600)
  await handle.close()
  return file
}

const fsyncFile = async (path: string) => {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const fsyncDir = async (dir: string) => {
  const handle = await open(dir, "r").catch(() => undefined)
  if (handle === undefined) return
  try {
    await handle.sync().catch(() => undefined)
  } finally {
    await handle.close()
  }
}

/** Load `node:sqlite` (after the warning filter, `quiet.ts`). */
export const sqlite = () => import("node:sqlite")

/**
 * A consistent copy of the database `source` (with what its write-ahead log holds) at `path`, made from a read
 * connection of its own with SQLite's backup API in one step on a worker thread: the store's connection, and with it
 * every turn, is never held. Written to a fresh temporary file, synced, published with one `rename`.
 */
export const copyDatabase = async (source: string, path: string): Promise<void> => {
  const { DatabaseSync, backup } = await sqlite()
  await privateDir(dirname(path))
  const part = await freshFile(path, "part")
  try {
    const from = new DatabaseSync(source, { readOnly: true })
    try {
      await backup(from, part, { rate: -1 })
    } finally {
      from.close()
    }
    await narrow(part)
    await fsyncFile(part)
    await rename(part, path)
    await fsyncDir(dirname(path))
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined)
    throw e
  }
}

/** Copy a finished file to `path` the same way (the second backup directory). */
export const copyFilePrivately = async (from: string, path: string): Promise<void> => {
  const { copyFile } = await import("node:fs/promises")
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const part = await freshFile(path, "part")
  try {
    await copyFile(from, part)
    await chmod(part, 0o600)
    await fsyncFile(part)
    await rename(part, path)
    await fsyncDir(dirname(path))
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined)
    throw e
  }
}

// ---- Retention

/** Daily backups: `household-<date>.db`. */
export const DAILY = /^household-(\d{4}-\d{2}-\d{2})\.db$/
/** Before an upgrade: `household-<date>-before-<what>.db`. */
export const BEFORE = /^household-(\d{4}-\d{2}-\d{2})-before-[a-z0-9-]+\.db$/
/** The previous database set aside by a restore: `household.db.before-restore-<time>`. */
export const ASIDE = /^household\.db\.before-restore-[0-9TZ-]+$/
/** A temporary file of an unfinished copy (another process may still be writing it). */
const PART = /\.(part|restore)-\d+-[0-9a-f]{12}$/

const DAY = 24 * 60 * 60 * 1000

/**
 * Remove what is too old in `dir`, as docs/STORING-DATA.md "What is kept how long" says: daily backups beyond the
 * newest `keep` and every one older than `keep` days except the newest; pre-upgrade backups and restore-aside copies
 * older than `keep` days; temporary files of copies older than a day (a copy that died). Never anything else.
 */
export const pruneArchives = async (dir: string, now: number, keep: number): Promise<ReadonlyArray<string>> => {
  const names = await readdir(dir).catch(() => [] as Array<string>)
  const removed: Array<string> = []
  const drop = async (name: string) => {
    await rm(join(dir, name), { force: true }).catch(() => undefined)
    removed.push(name)
  }
  const ageOf = async (name: string) => {
    const s = await stat(join(dir, name)).catch(() => undefined)
    return s === undefined ? 0 : now - s.mtimeMs
  }
  const daily = names.filter((n) => DAILY.test(n)).sort().reverse()
  for (const [i, name] of daily.entries()) {
    if (i === 0) continue
    if (i >= keep || (await ageOf(name)) > keep * DAY) await drop(name)
  }
  for (const name of names) {
    if ((BEFORE.test(name) || ASIDE.test(name)) && (await ageOf(name)) > keep * DAY) await drop(name)
    else if (PART.test(name) && (await ageOf(name)) > DAY) await drop(name)
  }
  return removed
}

// ---- Restore

export interface RestoreResult {
  readonly restored: string
  /** The previous database (with its log folded in), when there was one. */
  readonly aside: string | undefined
}

const quickCheck = (db: DatabaseSync) => (db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0])).join("; ")

const schemaOf = (db: DatabaseSync): number | undefined => {
  const meta = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = 'pva_meta'").get() as { n: number }
  if (Number(meta.n) === 0) return undefined
  const row = db.prepare("SELECT value FROM pva_meta WHERE key = 'schema'").get() as { value: string } | undefined
  return Number(row?.value ?? "0")
}

/**
 * Restore `source` as the database at `target` (the server stopped; the caller holds the writer lock and passes its
 * guard, so the lock is not released before this has settled, even when the command is interrupted):
 *
 * 1. refuse a source that is the target itself (or its log);
 * 2. check the source as SQLite reads it, with its write-ahead log: quick check, household data, a schema this
 *    version knows;
 * 3. copy it, log included, to a new file beside the target (backup API), and check the copy;
 * 4. copy the current database, log included, aside (`household.db.before-restore-<time>`);
 * 5. fold the current log into the current file and close it (so no stale log can be applied to the new file);
 * 6. publish the copy with one `rename` and sync the directory.
 *
 * Until step 6 the current database is untouched in content; a failure before it removes the new copy and leaves
 * everything as it was.
 */
export const restoreDatabase = async (options: { readonly source: string; readonly target: string; readonly knownSchema: number; readonly now: number }): Promise<RestoreResult> => {
  const { DatabaseSync, backup } = await sqlite()
  const source = resolve(options.source)
  const target = resolve(options.target)
  const real = async (p: string) => realpath(p).catch(() => resolve(p))
  const sourceReal = await real(source)
  for (const t of [target, `${target}-wal`, `${target}-shm`]) {
    if (sourceReal === (await real(t))) throw new Error(`${source} is the household database itself; restore a backup of it instead`)
  }
  if ((await stat(source).catch(() => undefined))?.isFile() !== true) throw new Error(`${source} is not a file`)
  // 2. The source as SQLite reads it (its log too).
  const check = (file: string, what: string) => {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const ok = quickCheck(db)
      if (ok !== "ok") throw new Error(`${what} does not pass SQLite's check: ${ok.slice(0, 500)}`)
      const schema = schemaOf(db)
      if (schema === undefined) throw new Error(`${what} holds no household data`)
      if (schema > options.knownSchema) throw new Error(`${what} was written by a newer version of the assistant (household schema ${schema}; this version knows ${options.knownSchema})`)
    } finally {
      db.close()
    }
  }
  check(source, source)
  // 3. A copy beside the target, checked.
  await privateDir(dirname(target))
  const staged = await freshFile(target, "restore")
  try {
    const from = new DatabaseSync(source, { readOnly: true })
    try {
      await backup(from, staged, { rate: -1 })
    } finally {
      from.close()
    }
    await narrow(staged)
    check(staged, `The copy of ${source}`)
    await fsyncFile(staged)
    // 4. The current database aside, with its log.
    let aside: string | undefined
    if ((await stat(target).catch(() => undefined)) !== undefined) {
      aside = join(dirname(target), `${basename(target)}.before-restore-${new Date(options.now).toISOString().replace(/[:.]/g, "-")}`)
      await copyDatabase(target, aside)
      // 5. Fold the log into the file, then leave the log behind: no stale log may meet the new file.
      const live = new DatabaseSync(target)
      try {
        live.exec("PRAGMA busy_timeout = 2000")
        const r = live.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined
        if (r !== undefined && Number(r.busy) !== 0) throw new Error(`${target} is in use (its log could not be folded in); stop the server first`)
        live.exec("PRAGMA journal_mode = DELETE")
      } finally {
        live.close()
      }
      for (const extra of ["-wal", "-shm"]) await rm(`${target}${extra}`, { force: true })
    }
    // 6. Publish.
    await rename(staged, target)
    await fsyncDir(dirname(target))
    return { restored: target, aside }
  } catch (e) {
    await rm(staged, { force: true }).catch(() => undefined)
    throw e
  }
}
