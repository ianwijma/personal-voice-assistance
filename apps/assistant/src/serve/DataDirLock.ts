import { Effect, Schema, type Scope } from "effect"
import { spawnSync } from "node:child_process"
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

/**
 * The data directory's single-writer lock (docs/UI-AND-MODULES.md, "Changes since the design").
 *
 * `serve` is the only writer of `settings.json`, `secrets.json`, `transaction.json` and `recordings/`. It takes
 * this lock before it reads or recovers anything there and keeps it until it stops, so a second server on the
 * same directory (on another port, or started while the first is in the middle of a save) refuses to start
 * instead of recovering a transaction that is still running or writing back a stale copy of the settings.
 * The command-line modes only read the directory and never take it.
 *
 * Mechanism: an advisory `flock(2)` lock on `writer.lock`, a file that is created once and never removed or
 * replaced. Node has no `flock`, so the `flock` program (util-linux) takes it on this process's open file
 * descriptor, passed to it as its fd 3, and exits: a `flock` lock belongs to the open file description, which
 * this process keeps open, so the lock stays held after the program exits and until this process closes the
 * descriptor or dies (for any reason, SIGKILL included: the kernel releases it). Taking it is one atomic
 * operation of the kernel (`LOCK_EX | LOCK_NB`); there is no stale state to judge and no takeover. The
 * descriptor is opened close-on-exec, so programs the server starts later do not inherit it. `flock` works across
 * mount, PID and network namespaces (a container sharing the directory with the host contends for the same
 * lock) and over NFS. Where the `flock` program is missing the start fails, saying so; there is no fallback.
 *
 * `writer.holder` names the holder (process id, host, kernel boot id, start time) for error messages. It is
 * written only by the process that holds the lock, after taking it, and removed when it releases it. A process
 * that died leaves it behind; the next holder overwrites it. It never decides who holds the lock, with one
 * exception that can only refuse: a holder file from another machine (another host name and another kernel)
 * stops the start, because a shared directory on a file system that does not pass locks between machines would
 * not show that machine's lock here; the error says to delete that file if nothing runs there.
 *
 * Release gate: the lock is never released while an operation that can write into the directory is still
 * running. Every write path (settings and secrets saves with their journal and temporary files, startup recovery
 * and its clean-up of corrupt and temporary files, recordings and their rotation) registers with `begin` (or
 * `guard`) before its first file operation and ends its registration once its last one has settled, however it
 * ends: success, failure, or a fiber that was interrupted while the promise it started kept running. Release
 * first refuses new registrations (`held()` turns false, `begin` returns `undefined`), then waits for the
 * registered operations to settle, at most `drainTimeoutMs` (default 10 s), and only then closes the descriptor.
 * If they do not settle in time, the scope's release returns without releasing: it logs which operations are
 * still running and the lock is released when the last of them settles, or by the kernel when the process exits
 * (shutdown continues meanwhile). `writer.holder` is written and removed synchronously by the acquire and the
 * release themselves, so it needs no registration.
 */

export class DataDirLockError extends Schema.TaggedError<DataDirLockError>()("DataDirLockError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export interface DataDirLock {
  readonly directory: string
  readonly path: string
  /**
   * False once its release has begun (the scope is closing), or once `writer.lock` no longer names the locked
   * file. Writers check it before every write.
   *
   * Limit: this is this process's own bookkeeping plus a check that the lock file's path still refers to the same
   * device and inode; it does not ask the kernel whether the `flock` lock is still owned (nothing in this process
   * gives it up except the release, and the kernel keeps it while the descriptor is open).
   */
  readonly held: () => boolean
  /**
   * Registers a write operation about to start (`what` names it in the log if it holds up the release). Returns
   * the function to call once its last file operation has settled (calling it again does nothing), or `undefined`
   * when the lock is not held or its release has begun: then the operation must not start.
   */
  readonly begin: (what: string) => (() => void) | undefined
  /** `begin`, `run`, and the end of the registration once `run`'s promise settles. Rejects without running `run` when `begin` refuses. */
  readonly guard: <A>(what: string, run: () => Promise<A>) => Promise<A>
}

export interface Holder {
  readonly pid: number
  readonly host: string
  /** `/proc/sys/kernel/random/boot_id`: the same for every container on one kernel, new at every boot. */
  readonly bootId: string | null
  readonly since: string
}

export const LOCK_FILE = "writer.lock"
export const HOLDER_FILE = "writer.holder"

/** Exit code the `flock` program is told to use when the lock is held by someone else. */
const CONFLICT = 75

const bootId = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null
  } catch {
    return null
  }
}

const parseHolder = (text: string | undefined): Holder | undefined => {
  if (text === undefined) return undefined
  try {
    const u = JSON.parse(text) as Partial<Holder>
    return typeof u.pid === "number" && typeof u.host === "string"
      ? { pid: u.pid, host: u.host, bootId: typeof u.bootId === "string" ? u.bootId : null, since: String(u.since ?? "") }
      : undefined
  } catch {
    return undefined
  }
}

const readOrUndefined = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** A holder file written on another machine: another host name and (where both are known) another kernel. */
const fromAnotherMachine = (holder: Holder, me: Holder) =>
  holder.host !== me.host && (holder.bootId === null || me.bootId === null || holder.bootId !== me.bootId)

const describe = (holder: Holder | undefined) =>
  holder === undefined ? "another assistant is using it" : `another assistant is using it (process ${holder.pid} on ${holder.host}, since ${holder.since})`

/** For tests: the `flock` program to run (a missing one shows the error a host without util-linux gets). */
let flockProgram = "flock"
export const setFlockProgramForTests = (program: string) => {
  flockProgram = program
}

/** Begins a release: returns the operations still running and a promise that settles once the lock is released. */
const releasers = new WeakMap<DataDirLock, () => { readonly running: ReadonlyArray<string>; readonly released: Promise<void> }>()

/** How long a release waits for registered write operations to settle (`DataDirLock`, "Release gate"). */
export const DRAIN_TIMEOUT_MS = 10_000

export interface Acquired {
  readonly lock: DataDirLock
  /** A holder file left by a process that did not release the lock (it died); informational. */
  readonly previous?: Holder
}

const tryAcquire = (directory: string): Acquired => {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, LOCK_FILE)
  const holderPath = join(directory, HOLDER_FILE)
  const me: Holder = { pid: process.pid, host: hostname(), bootId: bootId(), since: new Date().toISOString() }
  const refuse = (holder: Holder | undefined): never => {
    throw new DataDirLockError({
      message: `Cannot use the data directory ${directory}: ${describe(holder)}. Stop that assistant first, or set PVA_DATA_DIR to another directory.`
    })
  }
  // At most a few rounds: another round only when someone deleted writer.lock between our open and our lock.
  for (let round = 0; round < 3; round++) {
    // O_CLOEXEC is added by Node; O_NOFOLLOW: a symbolic link planted in its place is not followed.
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o644)
    let keep = false
    try {
      const result = spawnSync(flockProgram, ["--nonblock", "--exclusive", "--conflict-exit-code", String(CONFLICT), "3"], {
        stdio: ["ignore", "ignore", "pipe", fd],
        timeout: 10_000
      })
      if (result.error !== undefined) {
        const code = (result.error as NodeJS.ErrnoException).code
        throw new DataDirLockError({
          message: code === "ENOENT"
            ? `Cannot lock the data directory ${directory}: the "flock" program (util-linux) was not found. ` +
              "The assistant needs it to make sure only one server writes the settings; install util-linux " +
              "(it is part of every common Linux distribution)."
            : `Cannot lock the data directory ${directory}: running "flock" failed (${result.error.message})`,
          cause: result.error
        })
      }
      if (result.status === CONFLICT) return refuse(parseHolder(readOrUndefined(holderPath)))
      if (result.status !== 0) {
        throw new DataDirLockError({
          message: `Cannot lock the data directory ${directory}: "flock" failed (exit ${result.status ?? result.signal}): ` +
            `${result.stderr?.toString().trim() || "no message"}. The file system may not support locks.`
        })
      }
      // Locked. The name must still lead to the file we locked: this code never removes it, but a person may have.
      const locked = fstatSync(fd)
      let named: ReturnType<typeof statSync> | undefined
      try {
        named = statSync(path)
      } catch {
        named = undefined
      }
      if (named === undefined || named.ino !== locked.ino || named.dev !== locked.dev) continue
      const previousText = readOrUndefined(holderPath)
      const previous = parseHolder(previousText)
      if (previous !== undefined && fromAnotherMachine(previous, me)) {
        throw new DataDirLockError({
          message: `Cannot use the data directory ${directory}: it was last used by an assistant on another machine ` +
            `(process ${previous.pid} on ${previous.host}, since ${previous.since}), which this machine cannot see. ` +
            `Stop that assistant first. If none is running there, delete ${holderPath} and start again.`
        })
      }
      const content = `${JSON.stringify(me)}\n`
      const tmp = `${holderPath}.${process.pid}.tmp`
      writeFileSync(tmp, content, { mode: 0o644 })
      renameSync(tmp, holderPath)
      keep = true
      let held = true
      // Also false if writer.lock was deleted or replaced meanwhile (a person did it): a server started after that
      // locks the new file, and this one must not write beside it.
      const stillNamed = () => {
        try {
          const now = statSync(path)
          return now.ino === locked.ino && now.dev === locked.dev
        } catch {
          return false
        }
      }
      /** Registered write operations, by registration. */
      const running = new Map<number, string>()
      let registrations = 0
      let releasing = false
      let markReleased: () => void = () => {}
      const released = new Promise<void>((resolve) => {
        markReleased = resolve
      })
      const closeNow = () => {
        if (!held) return
        held = false
        // While still holding the lock, so nobody else's holder file can be removed. writer.lock itself stays.
        try {
          if (readOrUndefined(holderPath) === content) rmSync(holderPath, { force: true })
        } finally {
          closeSync(fd)
          markReleased()
        }
      }
      const begin = (what: string) => {
        if (releasing || !held) return undefined
        const id = registrations++
        running.set(id, what)
        return () => {
          if (!running.delete(id)) return
          if (releasing && running.size === 0) closeNow()
        }
      }
      const lock: DataDirLock = {
        directory,
        path,
        held: () => held && !releasing && stillNamed(),
        begin,
        guard: async (what, run) => {
          const end = begin(what)
          if (end === undefined) {
            throw new DataDirLockError({ message: `Not writing ${directory} (${what}): its writer lock is no longer held` })
          }
          try {
            return await run()
          } finally {
            end()
          }
        }
      }
      releasers.set(lock, () => {
        releasing = true
        const still = [...running.values()]
        if (still.length === 0) closeNow()
        return { running: still, released }
      })
      return previous === undefined ? { lock } : { lock, previous }
    } finally {
      if (!keep) closeSync(fd)
    }
  }
  throw new DataDirLockError({ message: `Cannot lock the data directory ${directory}: ${path} keeps being removed` })
}

/** Takes the lock synchronously (also usable from a test's step hook). Release with `releaseDataDirLock`. */
export const acquireDataDirLockSync = (directory: string): Acquired => tryAcquire(directory)

/**
 * Begins the release without waiting: the lock is released now if no registered write operation is running,
 * else as soon as the last one settles. Returns the operations still running.
 */
export const releaseDataDirLock = (lock: DataDirLock): ReadonlyArray<string> => releasers.get(lock)?.().running ?? []

export interface AcquireOptions {
  /** How long the release waits for registered write operations. Default `DRAIN_TIMEOUT_MS`. */
  readonly drainTimeoutMs?: number
}

/**
 * Takes the data directory's writer lock for the life of the scope. Closing the scope releases it once the
 * registered write operations have settled (see "Release gate" above).
 */
export const acquireDataDirLock = (directory: string, options: AcquireOptions = {}): Effect.Effect<DataDirLock, DataDirLockError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => tryAcquire(directory),
      catch: (cause) =>
        cause instanceof DataDirLockError ? cause : new DataDirLockError({ message: `Cannot lock the data directory ${directory}: ${(cause as Error).message}`, cause })
    }).pipe(Effect.tap(({ previous }) =>
      previous === undefined
        ? Effect.void
        : Effect.logInfo(`The previous assistant on ${directory} (process ${previous.pid} on ${previous.host}, since ${previous.since}) did not stop cleanly`)
    ), Effect.map(({ lock }) => lock)),
    (lock) =>
      Effect.suspend(() => {
        const release = releasers.get(lock)?.()
        if (release === undefined || release.running.length === 0) return Effect.void
        const bound = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS
        return Effect.promise(() => release.released).pipe(
          Effect.timeoutOrElse({
            duration: bound,
            orElse: () =>
              Effect.logError(
                `The data directory ${directory} stays locked: ${release.running.join(", ")} had not finished ` +
                  `after ${bound / 1000} s (the disk does not answer?). It is released when that ends, or when the process exits.`
              )
          })
        )
      })
  )
