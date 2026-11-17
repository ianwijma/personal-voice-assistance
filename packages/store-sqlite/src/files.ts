import { randomBytes } from "node:crypto"
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"

/**
 * Files of the household store (docs/STORING-DATA.md "Backups"): everything private to the user (directories `0700`,
 * files `0600`, whatever the umask), every copy written to a temporary file of its own and published with one
 * `rename`, the retention of every backup the store makes, and the checkpoints (on a worker thread of their own).
 */

/** Run `run` while the data directory's writer lock cannot be released (serve); default: just run it. */
export type FileGuard = <A>(what: string, run: () => Promise<A>) => Promise<A>
export const unguarded: FileGuard = (_what, run) => run()

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Make `dir` (and its missing parents) with mode 0700, and check the directory itself: one that others may write to
 * (group or world write) is narrowed to the user (`0700`) when the user owns it; otherwise it is reported (the
 * returned problem; serve mode shows it on the Health page as an error) and used anyway. Ancestors are not touched.
 */
export const privateDir = async (dir: string): Promise<string | undefined> => {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const s = await stat(dir)
  if ((s.mode & 0o022) === 0) return undefined
  const mine = process.getuid === undefined || s.uid === process.getuid()
  if (mine) {
    try {
      await chmod(dir, s.mode & 0o700)
      return undefined
    } catch (e) {
      return `${dir} can be written by other users (mode ${(s.mode & 0o777).toString(8)}) and could not be made private: ${messageOf(e)}`
    }
  }
  return `${dir} can be written by other users (mode ${(s.mode & 0o777).toString(8)}) and belongs to another user, so the store cannot make it private; another local user could replace or remove the household data or its backups there. Make it the assistant user's own, mode 700.`
}

/** Narrow an existing file to 0600 (the database and its sidecars, a backup made by an older version or by hand). */
export const narrow = async (path: string): Promise<void> => {
  const s = await stat(path).catch((e: unknown) => {
    if (codeOf(e) === "ENOENT") return undefined
    throw e
  })
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
 * it), synced, published with one `rename`. The directory's problem (`privateDir`), if any, is returned.
 */
export const copyDatabase = async (source: string, path: string): Promise<string | undefined> => {
  const { DatabaseSync, backup } = await sqlite()
  const problem = await privateDir(dirname(path))
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
  return problem
}

/** Copy a finished file to `path` the same way (the second backup directory). The directory's problem, if any. */
export const copyFilePrivately = async (from: string, path: string): Promise<string | undefined> => {
  const problem = await privateDir(dirname(path))
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
  return problem
}

// ---- Checkpoints: a worker thread with a connection of its own

const CHECKPOINTER = `
const { parentPort, workerData } = require("node:worker_threads")
process.emitWarning = () => {}
const { DatabaseSync } = require("node:sqlite")
let db
const open = () => {
  if (db !== undefined) return db
  db = new DatabaseSync(workerData.file)
  db.exec("PRAGMA busy_timeout = 0")
  return db
}
parentPort.on("message", (m) => {
  try {
    const c = open()
    if (m.op === "passive") {
      const r = c.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()
      parentPort.postMessage({ id: m.id, ok: Number(r.busy) === 0, log: Number(r.log), done: Number(r.checkpointed) })
    } else {
      // The bulk of the copying without the writer lock; then the truncation, which takes it briefly.
      c.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()
      const r = c.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
      parentPort.postMessage({ id: m.id, ok: Number(r.busy) === 0 })
    }
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e) })
  }
})
`

export interface Checkpointer {
  /** Copy what the log holds into the file without waiting for anyone (`PASSIVE`); `true` when all of it was copied. */
  readonly passive: () => Promise<boolean>
  /** Copy everything and empty the log (`TRUNCATE`, after a removal); `false` when a reader holds an older snapshot. */
  readonly truncate: () => Promise<boolean>
  readonly close: () => Promise<void>
}

/**
 * The store's checkpoints, on one worker thread with a connection of its own that never waits for a lock
 * (`busy_timeout = 0`): the event loop is never held by the copying, and the main connection makes no checkpoint of
 * its own (`wal_autocheckpoint = 0`).
 */
export const makeCheckpointer = (file: string): Checkpointer => {
  let worker: Worker | undefined
  let next = 0
  const waiting = new Map<number, (m: { ok: boolean }) => void>()
  const failAll = () => {
    for (const f of waiting.values()) f({ ok: false })
    waiting.clear()
    worker = undefined
  }
  const start = () => {
    if (worker !== undefined) return worker
    const w = new Worker(CHECKPOINTER, { eval: true, workerData: { file } })
    w.unref()
    w.on("message", (m: { id: number; ok: boolean }) => {
      const f = waiting.get(m.id)
      waiting.delete(m.id)
      f?.(m)
    })
    w.once("error", failAll)
    w.once("exit", failAll)
    worker = w
    return w
  }
  const ask = (op: "passive" | "truncate") =>
    new Promise<boolean>((resolve) => {
      const id = next++
      waiting.set(id, (m) => resolve(m.ok === true))
      try {
        start().postMessage({ id, op })
      } catch {
        waiting.delete(id)
        resolve(false)
      }
    })
  return {
    passive: () => ask("passive"),
    truncate: () => ask("truncate"),
    close: async () => {
      const w = worker
      worker = undefined
      if (w !== undefined) await w.terminate().catch(() => undefined)
      failAll()
    }
  }
}

/** The size of the write-ahead log beside `file` in bytes (0 when there is none). */
export const walBytes = async (file: string): Promise<number> => {
  const s = await stat(`${file}-wal`).catch((e: unknown) => {
    if (codeOf(e) === "ENOENT") return undefined
    throw e
  })
  return s?.size ?? 0
}

// ---- Retention

/** Daily backups: `household-<date>.db`. */
export const DAILY = /^household-(\d{4}-\d{2}-\d{2})\.db$/
/** Before an upgrade: `household-<date>-before-<what>.db`. */
export const BEFORE = /^household-(\d{4}-\d{2}-\d{2})-before-[a-z0-9.-]+\.db$/
/** A temporary file of an unfinished copy (another process may still be writing it). */
const PART = /\.part-\d+-[0-9a-f]{12}$/

const DAY = 24 * 60 * 60 * 1000

export interface PruneResult {
  /** Files removed. */
  readonly removed: ReadonlyArray<string>
  /** What could not be done (with why): a directory that could not be listed, a file that could not be checked or removed. */
  readonly failed: ReadonlyArray<string>
}

/** The newest daily backup's time in `dir`, or `undefined` when there is none (a directory that does not exist has none). */
export const lastBackupIn = async (dir: string): Promise<number | undefined> => {
  let names: Array<string>
  try {
    names = await readdir(dir)
  } catch (e) {
    if (codeOf(e) === "ENOENT") return undefined
    throw e
  }
  let newest: number | undefined
  for (const n of names) {
    if (!DAILY.test(n)) continue
    const s = await stat(join(dir, n))
    if (newest === undefined || s.mtimeMs > newest) newest = s.mtimeMs
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
 * without exception; a temporary file of a copy older than a day (a copy that died) too. Every backup that stays is
 * narrowed to `0600` (one made by an older version, or copied by hand). Nothing else is touched. Only a removal that
 * succeeded is reported as removed; a directory that cannot be listed (other than one that does not exist), a file
 * that cannot be checked, removed or narrowed is `failed`.
 */
export const pruneArchives = async (dir: string, now: number, keep: number): Promise<PruneResult> => {
  let names: Array<string>
  try {
    names = await readdir(dir)
  } catch (e) {
    if (codeOf(e) === "ENOENT") return { removed: [], failed: [] }
    return { removed: [], failed: [`${dir}: could not be listed (${messageOf(e)})`] }
  }
  const removed: Array<string> = []
  const failed: Array<string> = []
  for (const name of names) {
    const managed = DAILY.test(name) || BEFORE.test(name)
    const part = PART.test(name)
    if (!managed && !part) continue
    const path = join(dir, name)
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(path)
    } catch (e) {
      if (codeOf(e) === "ENOENT") continue
      failed.push(`${name}: could not be checked (${messageOf(e)})`)
      continue
    }
    const age = Math.max(now - s.mtimeMs, now - (endOfNamedDay(name) ?? Infinity))
    if ((managed && age > keep * DAY) || (part && now - s.mtimeMs > DAY)) {
      try {
        await rm(path)
        removed.push(name)
      } catch (e) {
        failed.push(`${name}: ${messageOf(e)}`)
      }
    } else if (managed) {
      await narrow(path).catch((e) => failed.push(`${name}: could not be made private (${messageOf(e)})`))
    }
  }
  return { removed, failed }
}
