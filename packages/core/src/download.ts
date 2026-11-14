/**
 * Downloading model archives (docs/SETTINGS-UI.md §5.4), shared by the speech
 * packages: each package owns its URLs and presets and calls `downloadArchives`
 * with them. Node only, so it is a separate entry (`@pva/core/download`) that
 * nothing in the browser imports.
 *
 * Per archive: skipped when its files are there; otherwise fetched into
 * `<modelDir>/.downloads/<name>.part` (a stall of `stallMs` without bytes
 * fails it), checked against the `Content-Length`, renamed, unpacked under
 * `nice` into `<modelDir>/.unpack-<id>/` (bzip2 is CPU heavy and runs on the
 * machine that decodes speech), checked for the expected files, and only then
 * moved into place. Before anything is fetched the free space of the models
 * folder is checked against the download plus the unpacked size. Cancelling
 * (the `signal`) or any failure removes the partial files.
 */
import { spawn } from "node:child_process"
import { createReadStream, createWriteStream, existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, stat, statfs } from "node:fs/promises"
import { join } from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

/** One thing to download. */
export interface ArchiveSpec {
  /** Display name and file name, e.g. `sherpa-onnx-whisper-turbo` (or `silero_vad.onnx` for a plain file). */
  readonly name: string
  readonly url: string
  /** `tar.bz2`: unpacked into the models folder (it holds `<name>/…`); `file`: saved as `<modelDir>/<name>`. */
  readonly kind: "tar.bz2" | "file"
  /** Paths relative to the models folder that must exist afterwards (and that mean "already there"). */
  readonly expect: ReadonlyArray<string>
  /** Download size in MB (10^6 bytes), for the disk check and progress before the server says. */
  readonly sizeMb: number
  /** Unpacked size in MB. */
  readonly diskMb: number
}

export type DownloadPhase = "check" | "download" | "unpack"

export interface DownloadProgress {
  readonly phase: DownloadPhase
  /** Bytes downloaded (download) or archive bytes read by the unpacker (unpack), over all archives of the call. */
  readonly done: number
  readonly total?: number
  /** The archive being worked on. */
  readonly archive: string
}

export interface DownloadOptions {
  readonly modelDir: string
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: DownloadProgress) => void
  /** One line per step ("Downloading …"), for a log. Never contains secrets. */
  readonly onLog?: (line: string) => void
  /** Fail when no bytes arrive for this long. Default 60 s. */
  readonly stallMs?: number
  /** For tests. */
  readonly fetch?: typeof globalThis.fetch
  /** For tests: free bytes in a folder. Default `fs.statfs`. */
  readonly freeBytes?: (dir: string) => Promise<number>
  /** Run the unpacker under `nice -n 10`. Default true (falls back to plain `tar` when `nice` is missing). */
  readonly nice?: boolean
  /** Extra free space kept, MB. Default 50. */
  readonly marginMb?: number
}

export type DownloadErrorReason = "cancelled" | "disk" | "http" | "stalled" | "network" | "unpack" | "incomplete" | "io"

export class DownloadError extends Error {
  readonly reason: DownloadErrorReason
  constructor(reason: DownloadErrorReason, message: string) {
    super(message)
    this.name = "DownloadError"
    this.reason = reason
  }
}

export const MB = 1_000_000

const gb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / MB)} MB`)

const defaultFreeBytes = async (dir: string): Promise<number> => {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Whether every expected file of an archive exists. */
export const isPresent = (spec: ArchiveSpec, modelDir: string): boolean => spec.expect.every((p) => existsSync(join(modelDir, p)))

/** Bytes needed to download and unpack the missing archives (plus the margin). */
export const requiredBytes = (specs: ReadonlyArray<ArchiveSpec>, marginMb = 50): number =>
  specs.reduce((n, s) => n + (s.sizeMb + (s.kind === "file" ? 0 : s.diskMb)) * MB, specs.length === 0 ? 0 : marginMb * MB)

const DOWNLOADS = ".downloads"
const UNPACK_PREFIX = ".unpack-"

/** Remove what an interrupted run left behind: `.downloads/*.part` and `.unpack-*` folders. At start, with no download running. */
export const cleanPartials = async (modelDir: string): Promise<ReadonlyArray<string>> => {
  const removed: Array<string> = []
  const drop = async (path: string) => {
    await rm(path, { recursive: true, force: true })
    removed.push(path)
  }
  let entries: Array<string>
  try {
    entries = await readdir(modelDir)
  } catch {
    return removed
  }
  for (const name of entries) if (name.startsWith(UNPACK_PREFIX)) await drop(join(modelDir, name))
  try {
    for (const name of await readdir(join(modelDir, DOWNLOADS))) {
      if (name.endsWith(".part")) await drop(join(modelDir, DOWNLOADS, name))
    }
  } catch {
    // no downloads folder
  }
  return removed
}

let counter = 0

const describeFsError = (error: unknown, dir: string): DownloadError => {
  const code = (error as NodeJS.ErrnoException).code
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new DownloadError("io", `The models folder ${dir} is not writable (${code})`)
  if (code === "ENOSPC") return new DownloadError("disk", `The disk of ${dir} is full`)
  return new DownloadError("io", `${dir}: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * Download and unpack the archives that are not complete yet, in order. Resolves when all are in place; rejects with
 * a `DownloadError` (reason `cancelled` after the signal fired). Partial files are removed in every failure case.
 */
export const downloadArchives = async (specs: ReadonlyArray<ArchiveSpec>, options: DownloadOptions): Promise<void> => {
  const { modelDir } = options
  const log = options.onLog ?? (() => {})
  const signal = options.signal
  const stallMs = options.stallMs ?? 60_000
  const fetchFn = options.fetch ?? globalThis.fetch
  const cancelled = () => new DownloadError("cancelled", "Cancelled")
  const aborted = (): boolean => signal?.aborted === true
  if (aborted()) throw cancelled()

  try {
    await mkdir(join(modelDir, DOWNLOADS), { recursive: true })
  } catch (error) {
    throw describeFsError(error, modelDir)
  }
  const missing = specs.filter((s) => !isPresent(s, modelDir))
  if (missing.length === 0) {
    log("Already downloaded")
    return
  }

  // Disk space: the download and the unpacked files are both on disk until the archive is deleted.
  options.onProgress?.({ phase: "check", done: 0, archive: missing[0]!.name })
  const needed = requiredBytes(missing, options.marginMb)
  let free: number
  try {
    free = await (options.freeBytes ?? defaultFreeBytes)(modelDir)
  } catch (error) {
    throw describeFsError(error, modelDir)
  }
  if (free < needed) throw new DownloadError("disk", `Needs about ${gb(needed)} free in ${modelDir}; ${gb(free)} free`)
  log(`Needs about ${gb(needed)}; ${gb(free)} free`)

  let estimate = missing.reduce((n, s) => n + s.sizeMb * MB, 0)
  let downloaded = 0
  for (const spec of missing) {
    if (aborted()) throw cancelled()
    const id = `${process.pid}-${Date.now()}-${++counter}`
    const archivePath = join(modelDir, DOWNLOADS, spec.kind === "file" ? `${spec.name}.${id}` : `${spec.name}.tar.bz2`)
    const part = `${archivePath}.part`
    const unpackDir = join(modelDir, `${UNPACK_PREFIX}${id}`)
    const cleanup = async () => {
      await Promise.all([rm(part, { force: true }), rm(archivePath, { force: true }), rm(unpackDir, { recursive: true, force: true })])
    }
    try {
      // ---- download
      log(`Downloading ${spec.url}`)
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal?.addEventListener("abort", onAbort, { once: true })
      let stalled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const arm = () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          stalled = true
          controller.abort()
        }, stallMs)
      }
      let expected: number | undefined
      try {
        arm()
        let response: Response
        try {
          response = await fetchFn(spec.url, { signal: controller.signal, redirect: "follow" })
        } catch (error) {
          if (aborted()) throw cancelled()
          if (stalled) throw new DownloadError("stalled", `No answer from ${new URL(spec.url).host} for ${Math.round(stallMs / 1000)} s`)
          throw new DownloadError("network", `Could not reach ${new URL(spec.url).host}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok || response.body === null) {
          throw new DownloadError("http", `${spec.url} answered HTTP ${response.status}${response.status === 404 ? " (the file has moved upstream)" : ""}`)
        }
        const length = Number(response.headers.get("content-length") ?? "")
        expected = Number.isFinite(length) && length > 0 ? length : undefined
        if (expected !== undefined) estimate += expected - spec.sizeMb * MB
        let lastReport = 0
        const counting = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            downloaded += chunk.length
            arm()
            const now = Date.now()
            if (now - lastReport >= 100) {
              lastReport = now
              options.onProgress?.({ phase: "download", done: downloaded, total: estimate, archive: spec.name })
            }
            callback(null, chunk)
          }
        })
        try {
          await pipeline(Readable.fromWeb(response.body as never), counting, createWriteStream(part))
        } catch (error) {
          if (aborted()) throw cancelled()
          if (stalled) throw new DownloadError("stalled", `The download of ${spec.name} stalled (no data for ${Math.round(stallMs / 1000)} s)`)
          if ((error as NodeJS.ErrnoException).code !== undefined) throw describeFsError(error, modelDir)
          throw new DownloadError("network", `The download of ${spec.name} broke off: ${error instanceof Error ? error.message : String(error)}`)
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const got = (await stat(part)).size
      if (expected !== undefined && got !== expected) {
        throw new DownloadError("incomplete", `The download of ${spec.name} is incomplete (${got} of ${expected} bytes)`)
      }
      options.onProgress?.({ phase: "download", done: downloaded, total: estimate, archive: spec.name })
      await rename(part, archivePath)
      if (aborted()) throw cancelled()

      if (spec.kind === "file") {
        await rename(archivePath, join(modelDir, spec.name))
      } else {
        // ---- unpack, then check, then move into place
        log(`Unpacking ${spec.name}`)
        await mkdir(unpackDir, { recursive: true })
        await unpack(archivePath, unpackDir, got, {
          nice: options.nice ?? true,
          ...(signal !== undefined ? { signal } : {}),
          onRead: (bytes) => options.onProgress?.({ phase: "unpack", done: bytes, total: got, archive: spec.name })
        })
        const absent = spec.expect.find((p) => !existsSync(join(unpackDir, p)))
        if (absent !== undefined) throw new DownloadError("incomplete", `The archive ${spec.name} does not contain ${absent}`)
        // Move every top-level entry the archive made (normally the one folder `<name>`).
        for (const entry of await readdir(unpackDir)) {
          const target = join(modelDir, entry)
          await rm(target, { recursive: true, force: true })
          await rename(join(unpackDir, entry), target)
        }
      }
      await cleanup()
      log(`${spec.name}: ready`)
    } catch (error) {
      await cleanup().catch(() => {})
      if (error instanceof DownloadError) throw error
      if (aborted()) throw cancelled()
      throw describeFsError(error, modelDir)
    }
  }
}

/** `[nice -n 10] tar -xjf - -C <dir>`, fed from the archive so the bytes read give progress. */
const unpack = (
  archive: string,
  dir: string,
  size: number,
  options: { readonly nice: boolean; readonly signal?: AbortSignal; readonly onRead: (bytes: number) => void }
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const tarArgs = ["-xjf", "-", "-C", dir]
    const start = (useNice: boolean) => {
      const child = useNice
        ? spawn("nice", ["-n", "10", "tar", ...tarArgs], { stdio: ["pipe", "ignore", "pipe"] })
        : spawn("tar", tarArgs, { stdio: ["pipe", "ignore", "pipe"] })
      let stderr = ""
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener("abort", onAbort)
        if (error === undefined) resolvePromise()
        else reject(error)
      }
      const onAbort = () => {
        child.kill("SIGTERM")
        input.destroy()
        finish(new DownloadError("cancelled", "Cancelled"))
      }
      options.signal?.addEventListener("abort", onAbort, { once: true })
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < 2000) stderr += d.toString()
      })
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && useNice && !settled) {
          settled = true
          options.signal?.removeEventListener("abort", onAbort)
          input.destroy()
          start(false)
          return
        }
        finish(new DownloadError("unpack", error.code === "ENOENT" ? "tar is not installed (it needs bzip2 support)" : `tar failed: ${error.message}`))
      })
      child.on("close", (code, signal) => {
        if (code === 0) finish()
        else if (code === null) finish(new DownloadError("unpack", `Unpacking was stopped (${signal ?? "signal"})`))
        else finish(new DownloadError("unpack", `Unpacking failed (tar exit ${code}): ${stderr.trim().split("\n").slice(-1)[0] ?? ""}`.trim()))
      })
      let read = 0
      let last = 0
      const input = createReadStream(archive)
      input.on("data", (chunk) => {
        read += chunk.length
        const now = Date.now()
        if (now - last >= 100 || read === size) {
          last = now
          options.onRead(read)
        }
      })
      input.on("error", (error) => finish(new DownloadError("io", `Could not read ${archive}: ${error.message}`)))
      child.stdin?.on("error", () => {
        // tar exited early; its exit code says why
      })
      input.pipe(child.stdin!)
    }
    start(options.nice)
  })
