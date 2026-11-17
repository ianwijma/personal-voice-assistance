import { randomBytes } from "node:crypto"
import { chmod, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"

/**
 * Files of the household store (docs/STORING-DATA.md "Backups"): everything private to the user (directories `0700`,
 * files `0600`, whatever the umask), every copy written to a temporary file of its own and published with one
 * `rename`, the retention of every backup the store makes, and the checkpoint after a removal.
 */

/** Run `run` while the data directory's writer lock cannot be released (serve); default: just run it. */
export type FileGuard = <A>(what: string, run: () => Promise<A>) => Promise<A>
export const unguarded: FileGuard = (_what, run) => run()

/** Make `dir` (and its parents) with mode 0700; an existing directory the store made keeps its mode. */
export const privateDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/** Narrow an existing file to 0600 (the database and its sidecars, a backup made by an older version or by hand). */
export const narrow = async (path: string): Promise<void> => {
  const s = await stat(path).catch(() => undefined)
  if (s !== undefined && (s.mode & 0o077) !== 0) await chmod(path, s.mode & 0o700)
}

/** An empty new file of our own beside `path` (`<path>.part-<pid>-<random>`), mode 0600. */
export const freshFile = async (path: string): Promise<string> => {
  const file = `${path}.part-${process.pid}-${randomBytes(6).toString("hex")}`
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
 * connection of its own with SQLite's backup API in one step on SQLite's worker thread: the store's connection, and
 * with it every turn, is never held. Written to a fresh temporary file, made one self-contained file (no log beside
 * it), synced, published with one `rename`.
 */
export const copyDatabase = async (source: string, path: string): Promise<void> => {
  const { DatabaseSync, backup } = await sqlite()
  await privateDir(dirname(path))
  const part = await freshFile(path)
  try {
    const from = new DatabaseSync(source, { readOnly: true })
    try {
      await backup(from, part, { rate: -1 })
    } finally {
      from.close()
    }
    const copy = new DatabaseSync(part)
    try {
      copy.exec("PRAGMA journal_mode = DELETE")
    } finally {
      copy.close()
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

/**
 * Run `run` while holding the backup lock of `dir` (`<dir>/.backup.lock`, holding the holder's pid): one backup at a
 * time across processes (the server's daily one and `pnpm start household backup`) and stores. A backup that finds the
 * lock held by a live process waits for it (polling, at most `waitMs`); a lock left by a process that died is taken
 * over.
 */
export const withBackupLock = async <A>(dir: string, run: () => Promise<A>, waitMs = 10 * 60_000): Promise<A> => {
  await privateDir(dir)
  const lock = join(dir, ".backup.lock")
  const until = Date.now() + waitMs
  for (;;) {
    try {
      const handle = await open(lock, "wx", 0o600)
      try {
        await handle.writeFile(String(process.pid))
      } finally {
        await handle.close()
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      const text = (await readFile(lock, "utf8").catch(() => "")).trim()
      const holder = Number(text)
      const alive = text === "" || (Number.isInteger(holder) && holder > 0 && (() => {
        try {
          process.kill(holder, 0)
          return true
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === "EPERM"
        }
      })())
      if (!alive) {
        await rm(lock, { force: true })
        continue
      }
      if (Date.now() > until) throw new Error(`another backup is still running (process ${text || "?"})`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  try {
    return await run()
  } finally {
    await rm(lock, { force: true }).catch(() => undefined)
  }
}

/** Copy a finished file to `path` the same way (the second backup directory). */
export const copyFilePrivately = async (from: string, path: string): Promise<void> => {
  const { copyFile } = await import("node:fs/promises")
  await privateDir(dirname(path))
  const part = await freshFile(path)
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

// ---- The checkpoint after a removal

const CHECKPOINT = `
const { parentPort, workerData } = require("node:worker_threads")
process.emitWarning = () => {}
const { DatabaseSync } = require("node:sqlite")
let db
try {
  db = new DatabaseSync(workerData.file)
  db.exec("PRAGMA busy_timeout = 0")
  // The bulk of the copying without the writer lock; then the truncation, which takes it briefly.
  db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()
  const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
  parentPort.postMessage({ ok: Number(r.busy) === 0 })
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e) })
} finally {
  try { db?.close() } catch {}
}
`

/**
 * Checkpoint the database's write-ahead log into the file and empty it (`wal_checkpoint(TRUNCATE)`), on a worker
 * thread with a connection of its own that never waits: the event loop is not held by the copying. `true` when the
 * log is empty afterwards; `false` when a reader holds an older snapshot (try again later).
 */
export const checkpointFile = (file: string): Promise<boolean> =>
  new Promise((resolve) => {
    const worker = new Worker(CHECKPOINT, { eval: true, workerData: { file } })
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
      void worker.terminate().catch(() => undefined)
    }
    worker.once("message", (m: { ok: boolean }) => done(m.ok === true))
    worker.once("error", () => done(false))
    worker.once("exit", () => done(false))
  })

// ---- Retention

/** Daily backups: `household-<date>.db`. */
export const DAILY = /^household-(\d{4}-\d{2}-\d{2})\.db$/
/** Before an upgrade: `household-<date>-before-<what>.db`. */
export const BEFORE = /^household-(\d{4}-\d{2}-\d{2})-before-[a-z0-9-]+\.db$/
/** A temporary file of an unfinished copy (another process may still be writing it). */
const PART = /\.part-\d+-[0-9a-f]{12}$/

const DAY = 24 * 60 * 60 * 1000

export interface PruneResult {
  /** Files removed. */
  readonly removed: ReadonlyArray<string>
  /** Files that should have gone and could not be removed (with why). */
  readonly failed: ReadonlyArray<string>
}

/** The newest daily or pre-upgrade backup's time in `dir`, or `undefined`. */
export const lastBackupIn = async (dir: string): Promise<number | undefined> => {
  let newest: number | undefined
  for (const n of await readdir(dir).catch(() => [] as Array<string>)) {
    if (!DAILY.test(n) && !BEFORE.test(n)) continue
    const s = await stat(join(dir, n)).catch(() => undefined)
    if (s !== undefined && (newest === undefined || s.mtimeMs > newest)) newest = s.mtimeMs
  }
  return newest
}

/** The end of the local day a backup's name gives (`household-<date>….db`), in epoch ms. */
const endOfNamedDay = (name: string): number | undefined => {
  const m = /^household-(\d{4})-(\d{2})-(\d{2})/.exec(name)
  return m === null ? undefined : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime()
}

/**
 * Apply docs/STORING-DATA.md "What is kept how long" to `dir`: every backup the store makes (daily, before an upgrade)
 * is removed once it is older than `keep` days, by the day in its name or by its file time, whichever is older,
 * without exception; daily backups beyond the newest `keep` too; a temporary file of a copy older than a day (a copy
 * that died) too. Every backup that stays is narrowed to `0600` (one made by an older version, or copied by hand).
 * Nothing else is touched. Only a removal that succeeded is reported as removed; the others are `failed`.
 */
export const pruneArchives = async (dir: string, now: number, keep: number): Promise<PruneResult> => {
  const names = await readdir(dir).catch(() => [] as Array<string>)
  const removed: Array<string> = []
  const failed: Array<string> = []
  const beyondNewest = new Set(names.filter((n) => DAILY.test(n)).sort().reverse().slice(keep))
  for (const name of names) {
    const managed = DAILY.test(name) || BEFORE.test(name)
    const part = PART.test(name)
    if (!managed && !part) continue
    const path = join(dir, name)
    const s = await stat(path).catch(() => undefined)
    if (s === undefined) continue
    const age = Math.max(now - s.mtimeMs, now - (endOfNamedDay(name) ?? Infinity))
    if ((managed && (age > keep * DAY || beyondNewest.has(name))) || (part && now - s.mtimeMs > DAY)) {
      try {
        await rm(path)
        removed.push(name)
      } catch (e) {
        failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else if (managed) {
      await narrow(path).catch((e) => failed.push(`${name}: could not be made private (${e instanceof Error ? e.message : String(e)})`))
    }
  }
  return { removed, failed }
}
