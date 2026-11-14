/**
 * The installed releases of the node program and their start bookkeeping (docs/VOICE-NODES.md §7.1, §7.3).
 *
 *   /opt/pva-node/releases/
 *     <sha256>/pva-node.mjs   one directory per bundle, named by the bundle's SHA-256
 *     current  -> <sha256>    what the unit runs (through the boot guard)
 *     previous -> <sha256>    the release before it, kept for rollback
 *     state.json              { pending?, bad, lastError? }
 *
 * A switch (`installRelease`) records the new release as *pending* before it moves `current`. Every start of a
 * pending release counts (`bootStart`, run by the boot guard before the bundle is even loaded, so a bundle that
 * crashes at load is counted too). The first `welcome` from the server confirms it (`confirmRelease`). A pending
 * release that has started `MAX_FAILED_STARTS` times without a welcome is rolled back on the next start: `current`
 * goes back to `previous`, the release is marked bad (never switched to again) and `lastError` says why.
 *
 * Plain synchronous `node:fs` and no other imports: the boot guard (`boot.ts`) is bundled from this file alone and
 * must keep working whatever the bundle does. Links are switched atomically (a new symlink renamed over the old).
 */
import { createHash } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs"
import { basename, join } from "node:path"

export const RELEASE_FILE = "pva-node.mjs"
export const STATE_FILE = "state.json"
/** Starts without a welcome after which a new release is rolled back (§7.3). */
export const MAX_FAILED_STARTS = 3
const MAX_BAD = 8

export interface ReleaseError {
  readonly message: string
  readonly at: number
}

export interface ReleaseState {
  /** A release switched to and not yet confirmed by a `welcome`. */
  readonly pending?: {
    readonly sha256: string
    readonly previous?: string
    /** Starts of this release so far (the boot guard counts each one before loading it). */
    readonly starts: number
    readonly since: number
  }
  /** Releases that were rolled back; an update never switches to them again. Newest last. */
  readonly bad: ReadonlyArray<string>
  readonly lastError?: ReleaseError
}

export const emptyState: ReleaseState = { bad: [] }

export const isSha256 = (s: string): boolean => /^[0-9a-f]{64}$/.test(s)

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export const releaseFile = (dir: string, sha: string): string => join(dir, sha, RELEASE_FILE)

/** The release a link (`current` / `previous`) points at, if it is a well-formed release link. */
export const linkedRelease = (dir: string, name: "current" | "previous"): string | undefined => {
  try {
    const target = basename(readlinkSync(join(dir, name)))
    return isSha256(target) ? target : undefined
  } catch {
    return undefined
  }
}

/** Point `name` at release `sha` atomically (or remove the link for `undefined`). */
export const pointTo = (dir: string, name: "current" | "previous", sha: string | undefined): void => {
  const link = join(dir, name)
  if (sha === undefined) {
    rmSync(link, { force: true })
    return
  }
  const temporary = join(dir, `.${name}.${process.pid}.tmp`)
  rmSync(temporary, { force: true })
  symlinkSync(sha, temporary)
  renameSync(temporary, link)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** The state file; a missing or unreadable one is the empty state (never throws). */
export const readState = (dir: string): ReleaseState => {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"))
  } catch {
    return emptyState
  }
  if (!isRecord(json)) return emptyState
  const bad = Array.isArray(json["bad"]) ? json["bad"].filter((s): s is string => typeof s === "string" && isSha256(s)) : []
  const p = json["pending"]
  const pending = isRecord(p) && typeof p["sha256"] === "string" && isSha256(p["sha256"]) && typeof p["starts"] === "number"
    ? {
      sha256: p["sha256"],
      ...(typeof p["previous"] === "string" && isSha256(p["previous"]) ? { previous: p["previous"] } : {}),
      starts: p["starts"],
      since: typeof p["since"] === "number" ? p["since"] : 0
    }
    : undefined
  const e = json["lastError"]
  const lastError = isRecord(e) && typeof e["message"] === "string" && typeof e["at"] === "number"
    ? { message: e["message"], at: e["at"] }
    : undefined
  return { bad, ...(pending !== undefined ? { pending } : {}), ...(lastError !== undefined ? { lastError } : {}) }
}

/** Write a file durably and atomically (temporary file, fsync, rename). */
export const writeFileAtomic = (path: string, data: string | Uint8Array, mode = 0o644): void => {
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, "w", mode)
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
}

export const writeState = (dir: string, state: ReleaseState): void =>
  writeFileAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)

export type BootDecision =
  | { readonly _tag: "Run"; readonly sha256: string; readonly start?: number }
  | { readonly _tag: "RolledBack"; readonly from: string; readonly to: string; readonly message: string }
  | { readonly _tag: "GaveUp"; readonly sha256: string; readonly message: string }
  | { readonly _tag: "NoRelease" }

/**
 * Called once per process start, before the bundle is loaded. Counts a start of a pending release, and rolls back
 * one that has had `MAX_FAILED_STARTS` starts without a welcome. Returns what to run (`current` afterwards).
 */
export const bootStart = (dir: string, now = Date.now()): BootDecision => {
  const current = linkedRelease(dir, "current")
  if (current === undefined || !existsSync(releaseFile(dir, current))) return { _tag: "NoRelease" }
  const state = readState(dir)
  const pending = state.pending
  if (pending === undefined) return { _tag: "Run", sha256: current }
  if (pending.sha256 !== current) {
    // A switch that never completed (or `current` was moved by hand): nothing to watch.
    const { pending: _, ...rest } = state
    writeState(dir, rest)
    return { _tag: "Run", sha256: current }
  }
  if (pending.starts < MAX_FAILED_STARTS) {
    writeState(dir, { ...state, pending: { ...pending, starts: pending.starts + 1 } })
    return { _tag: "Run", sha256: current, start: pending.starts + 1 }
  }
  const previous = pending.previous ?? linkedRelease(dir, "previous")
  const bad = [...state.bad.filter((s) => s !== current), current].slice(-MAX_BAD)
  if (previous === undefined || previous === current || !existsSync(releaseFile(dir, previous))) {
    const message = `release ${current.slice(0, 12)} did not reach the server's welcome in ${MAX_FAILED_STARTS} starts, and there is no previous release to go back to`
    writeState(dir, { bad, lastError: { message, at: now } })
    return { _tag: "GaveUp", sha256: current, message }
  }
  const message = `release ${current.slice(0, 12)} did not reach the server's welcome in ${MAX_FAILED_STARTS} starts; rolled back to ${previous.slice(0, 12)}`
  // State first: if we die between the two steps, the next start runs `previous` with nothing pending.
  writeState(dir, { bad, lastError: { message, at: now } })
  pointTo(dir, "current", previous)
  pointTo(dir, "previous", undefined)
  return { _tag: "RolledBack", from: current, to: previous, message }
}

/**
 * The running release reached `welcome`: it is good. Clears `pending` and removes releases other than `current`
 * and `previous`. Returns whether anything changed.
 */
export const confirmRelease = (dir: string, sha: string): boolean => {
  const state = readState(dir)
  if (state.pending?.sha256 !== sha) return false
  const { pending: _, ...rest } = state
  writeState(dir, rest)
  pruneReleases(dir)
  return true
}

/** Remove release directories that neither `current` nor `previous` points at. */
export const pruneReleases = (dir: string): void => {
  const keep = new Set([linkedRelease(dir, "current"), linkedRelease(dir, "previous")])
  for (const entry of readdirSync(dir)) {
    if (isSha256(entry) && !keep.has(entry)) rmSync(join(dir, entry), { recursive: true, force: true })
  }
}

export class ReleaseInstallError extends Error {}

/**
 * Store a downloaded bundle as release `sha` and switch to it (atomically), keeping the running release as
 * `previous`. Refuses bytes whose SHA-256 is not `sha` (nothing is written then). The caller exits afterwards so
 * the service manager starts the new release.
 */
export const installRelease = (dir: string, sha: string, bytes: Uint8Array, now = Date.now()): void => {
  if (!isSha256(sha)) throw new ReleaseInstallError(`not a SHA-256: ${sha}`)
  const actual = sha256Hex(bytes)
  if (actual !== sha) throw new ReleaseInstallError(`the downloaded bundle has SHA-256 ${actual}, the manifest says ${sha}`)
  mkdirSync(join(dir, sha), { recursive: true, mode: 0o755 })
  writeFileAtomic(releaseFile(dir, sha), bytes, 0o644)
  const running = linkedRelease(dir, "current")
  const state = readState(dir)
  // The release to go back to is the last confirmed one: when the running release is itself still pending (it
  // never reached `welcome`), keep the `previous` it would have gone back to.
  const fallback = state.pending !== undefined && state.pending.sha256 === running
    ? state.pending.previous ?? linkedRelease(dir, "previous")
    : running
  const previous = fallback !== sha ? fallback : undefined
  // Order: pending first (a pending that does not match `current` is dropped at the next start), then the links.
  writeState(dir, {
    ...state,
    bad: state.bad.filter((s) => s !== sha),
    pending: { sha256: sha, ...(previous !== undefined ? { previous } : {}), starts: 0, since: now }
  })
  if (previous !== undefined) pointTo(dir, "previous", previous)
  pointTo(dir, "current", sha)
}

/** Record an error for the node's status (`lastError`, WP-10 reports it in `node.status`). */
export const recordError = (dir: string, message: string, now = Date.now()): void => {
  writeState(dir, { ...readState(dir), lastError: { message, at: now } })
}
