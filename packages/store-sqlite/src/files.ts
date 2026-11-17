import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

/**
 * Files of the household store (docs/STORING-DATA.md "Backups"): everything private to the user (directories
 * `0700`, files `0600`, whatever the umask), every copy written to a temporary file of its own and published with one
 * `rename`, and the retention of every archive the store makes.
 */

/** Run `run` while the data directory's writer lock cannot be released (serve); default: just run it. */
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
    selfContained(DatabaseSync, part)
    await narrow(part)
    await fsyncFile(part)
    await rename(part, path)
    await fsyncDir(dirname(path))
  } catch (e) {
    await rm(part, { force: true }).catch(() => undefined)
    throw e
  }
}

/**
 * Make a fresh copy one file with no log of its own: the backup API copies the source's WAL flag, and a WAL-mode file
 * leaves `-wal` and `-shm` files beside it whenever it is read. The server switches the database back to WAL.
 */
const selfContained = (DatabaseSync: typeof import("node:sqlite").DatabaseSync, file: string) => {
  const db = new DatabaseSync(file)
  try {
    db.exec("PRAGMA journal_mode = DELETE")
  } finally {
    db.close()
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
/** A temporary file of an unfinished copy (another process may still be writing it). */
const PART = /\.part-\d+-[0-9a-f]{12}$/

const DAY = 24 * 60 * 60 * 1000

/**
 * Remove what is too old in `dir`, as docs/STORING-DATA.md "What is kept how long" says: daily backups beyond the
 * newest `keep` and every one older than `keep` days except the newest; pre-upgrade backups
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
    if (BEFORE.test(name) && (await ageOf(name)) > keep * DAY) await drop(name)
    else if (PART.test(name) && (await ageOf(name)) > DAY) await drop(name)
  }
  return removed
}
