import { randomBytes } from "node:crypto"
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Worker } from "node:worker_threads"
import { SQLITE_WARNING } from "./quiet.ts"

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

/** Errors that mean a directory cannot be synced here at all (some file systems); any other is a real failure. */
const SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR"])

/**
 * Sync a directory, so a `rename` into it survives a power loss. Where that is not supported (Windows, file systems
 * that refuse it) it is skipped; any other failure (`EIO`, `EACCES`, …) is thrown: the copy is not known to be durable.
 */
export const fsyncDir = async (dir: string): Promise<void> => {
  if (process.platform === "win32") return
  const unsupported = (e: unknown) => {
    if (SYNC_UNSUPPORTED.has(codeOf(e) ?? "")) return undefined
    throw e
  }
  const handle = await open(dir, "r").catch(unsupported)
  if (handle === undefined) return
  try {
    await handle.sync().catch(unsupported)
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

/**
 * Copy a finished file to `path` the same way (the second backup directory), keeping its time: retention judges a
 * copy by the snapshot's age, not by when it was copied. The directory's problem, if any.
 */
export const copyFilePrivately = async (from: string, path: string): Promise<string | undefined> => {
  const problem = await privateDir(dirname(path))
  const part = await freshFile(path)
  try {
    await copyFile(from, part)
    await chmod(part, 0o600)
    const s = await stat(from)
    await utimes(part, s.atime, s.mtime)
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

/** The size the write-ahead log's file is cut back to when a log starts again (`PRAGMA journal_size_limit`). */
export const JOURNAL_SIZE_LIMIT = 4 * 1024 * 1024

/**
 * The worker's copy of `quiet.ts`: only Node's ExperimentalWarning for `node:sqlite` is dropped; every other warning
 * passes (exported for its test).
 */
export const WORKER_WARNING_FILTER = `
{
  const original = process.emitWarning.bind(process)
  const sqlite = new RegExp(${JSON.stringify(SQLITE_WARNING.source)})
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : ""
    const first = rest[0]
    const type = typeof first === "string" ? first : typeof first === "object" && first !== null && "type" in first ? String(first.type) : warning instanceof Error ? warning.name : ""
    if (type === "ExperimentalWarning" && sqlite.test(text)) return
    original(warning, ...rest)
  }
}
`

const CHECKPOINTER = `
const { parentPort, workerData } = require("node:worker_threads")
${WORKER_WARNING_FILTER}
const { DatabaseSync } = require("node:sqlite")
const { statSync } = require("node:fs")
let db
const open = () => {
  if (db !== undefined) return db
  db = new DatabaseSync(workerData.file)
  db.exec("PRAGMA busy_timeout = 0")
  // The connection that starts a log again cuts its file back to this size: this one does now (startLog), so it
  // has the main connection's limit (SqliteStore.ts).
  db.exec("PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT}")
  return db
}
const walSize = () => {
  try {
    return statSync(workerData.file + "-wal").size
  } catch {
    return 0
  }
}
// Tests only (@pva/store-sqlite/testing): pause between a checkpoint and the start of the new log (gapMs), or while
// holding the write lock for it (holdMs), telling the main thread when the pause begins. Zero: no pause, no message.
const pauses = { gapMs: 0, holdMs: 0 }
const sleeper = new Int32Array(new SharedArrayBuffer(4))
const pause = (what) => {
  const ms = pauses[what]
  if (ms <= 0) return
  parentPort.postMessage({ pausing: what })
  Atomics.wait(sleeper, 0, 0, ms)
}
// After a checkpoint that let the log start again, the next connection to write starts it and syncs its new header
// (SQLite does so even with synchronous = NORMAL). Here that is this connection, with one tiny write right after the
// checkpoint, so the sync is this thread's and not the main thread's next commit. "done": started here; "busy": a
// main-thread write holds the lock (it starts the log); "started": a main-thread commit came first (a log emptied by
// a truncating checkpoint is not empty any more); "failed": the write failed (the main thread starts the log).
const startLog = (c, emptied) => {
  pause("gapMs")
  try {
    c.exec("BEGIN IMMEDIATE")
  } catch {
    return "busy"
  }
  try {
    if (emptied && walSize() > 0) {
      c.exec("ROLLBACK")
      return "started"
    }
    pause("holdMs")
    // The smallest write that is one: the file header's user version set to the value it has (unused by the store).
    // Page 1 is written as the new log's first frame. (An UPDATE to the same value writes nothing.)
    const version = Number(c.prepare("PRAGMA user_version").get().user_version)
    c.exec("PRAGMA user_version = " + version)
    c.exec("COMMIT")
    return "done"
  } catch {
    try {
      c.exec("ROLLBACK")
    } catch {}
    return "failed"
  }
}
parentPort.on("message", (m) => {
  try {
    if (m.op === "pauses") {
      pauses.gapMs = m.gapMs
      pauses.holdMs = m.holdMs
      parentPort.postMessage({ id: m.id, ok: true })
      return
    }
    const c = open()
    if (m.op === "passive") {
      const r = c.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()
      const ok = Number(r.busy) === 0
      // Every frame copied: the next write starts the log from its beginning.
      const start = ok && Number(r.log) > 0 && Number(r.checkpointed) === Number(r.log) ? startLog(c, false) : undefined
      parentPort.postMessage({ id: m.id, ok, log: Number(r.log), done: Number(r.checkpointed), start })
    } else {
      // The bulk of the copying without the writer lock; then the truncation, which takes it briefly.
      c.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()
      const r = c.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
      const ok = Number(r.busy) === 0
      parentPort.postMessage({ id: m.id, ok, start: ok ? startLog(c, true) : undefined })
    }
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: String(e) })
  }
})
`

/** How the worker's start of a new log went (`startLog` in the worker), counted for tests. */
export interface LogStarts {
  /** Started by the worker: the main thread's next commit appends and does not sync. */
  readonly byWorker: number
  /** The window: a main-thread write held the lock or committed first, so the main thread started the log (and synced). */
  readonly byMainThread: number
  /** The worker's write failed (the main thread starts the log). */
  readonly failed: number
}

/** Each serving store's checkpointer, for `@pva/store-sqlite/testing` (set once when the store is made). */
export const checkpointerOf = new WeakMap<object, Checkpointer>()

export interface Checkpointer {
  /** Copy what the log holds into the file without waiting for anyone (`PASSIVE`); `true` when all of it was copied. */
  readonly passive: () => Promise<boolean>
  /** Copy everything and empty the log (`TRUNCATE`, after a removal); `false` when a reader holds an older snapshot. */
  readonly truncate: () => Promise<boolean>
  readonly close: () => Promise<void>
  /** Tests (`@pva/store-sqlite/testing`): how the new logs were started so far. */
  readonly logStarts: () => LogStarts
  /** Tests: make the worker pause before starting a new log (`gapMs`) or while holding the lock for it (`holdMs`). */
  readonly setPauses: (pauses: { readonly gapMs: number; readonly holdMs: number }) => Promise<void>
  /** Tests: resolved when the worker next begins the pause named. */
  readonly nextPause: (what: "gapMs" | "holdMs") => Promise<void>
}

/**
 * The store's checkpoints, on one worker thread with a connection of its own that never waits for a lock
 * (`busy_timeout = 0`): the event loop is never held by the copying, and the main connection makes no checkpoint of
 * its own (`wal_autocheckpoint = 0`). After a checkpoint that copied everything the worker also starts the new log
 * (`startLog`), so the main thread's next commit does not sync its header (docs/STORING-DATA.md "The write-ahead log").
 */
export const makeCheckpointer = (file: string): Checkpointer => {
  let worker: Worker | undefined
  let next = 0
  const waiting = new Map<number, (m: { ok: boolean }) => void>()
  const starts = { byWorker: 0, byMainThread: 0, failed: 0 }
  const pausing: Array<{ readonly what: string; readonly resolve: () => void }> = []
  const failAll = () => {
    for (const f of waiting.values()) f({ ok: false })
    waiting.clear()
    worker = undefined
  }
  const start = () => {
    if (worker !== undefined) return worker
    const w = new Worker(CHECKPOINTER, { eval: true, workerData: { file } })
    w.unref()
    w.on("message", (m: { id: number; ok: boolean; start?: string; pausing?: string }) => {
      if (m.pausing !== undefined) {
        for (const p of pausing.splice(0)) if (p.what === m.pausing) p.resolve(); else pausing.push(p)
        return
      }
      if (m.start === "done") starts.byWorker++
      else if (m.start === "busy" || m.start === "started") starts.byMainThread++
      else if (m.start === "failed") starts.failed++
      const f = waiting.get(m.id)
      waiting.delete(m.id)
      f?.(m)
    })
    w.once("error", failAll)
    w.once("exit", failAll)
    worker = w
    return w
  }
  const ask = (op: "passive" | "truncate" | "pauses", extra: object = {}) =>
    new Promise<boolean>((resolve) => {
      const id = next++
      waiting.set(id, (m) => resolve(m.ok === true))
      try {
        start().postMessage({ ...extra, id, op })
      } catch {
        waiting.delete(id)
        resolve(false)
      }
    })
  return {
    passive: () => ask("passive"),
    truncate: () => ask("truncate"),
    logStarts: () => ({ ...starts }),
    setPauses: async (p) => {
      await ask("pauses", { gapMs: p.gapMs, holdMs: p.holdMs })
    },
    nextPause: (what) => new Promise<void>((resolve) => void pausing.push({ what, resolve })),
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
