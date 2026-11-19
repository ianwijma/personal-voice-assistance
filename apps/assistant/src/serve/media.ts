import type { IssueRegistry, MediaOutcome, MediaPort, MediaRefusal } from "@pva/core"
import { type ContentTypePolicy, NetRefused, NetTooLarge, safeFetch, type SafeFetchError, type SafeFetchOptions, type SafeResponse } from "@pva/net"
import { MEDIA_HASH, MEDIA_TOKEN } from "@pva/protocol"
import { Deferred, Effect, Exit, type Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { chmod, mkdir, opendir, readFile, rename, rmdir, stat, unlink as unlinkAsync, utimes, writeFile } from "node:fs/promises"
import type http from "node:http"
import { join } from "node:path"

/**
 * The image cache behind `/media/<token>` (docs/PRESENTING.md "Images"; docs/MODULES-PLAN.md §4 P10, first version). The
 * only way an image reaches a page: the Presenter asks it to `fetch` an address a module gave, off the turn's path, once a
 * page is to show it; it fetches it through `safeFetch` (public addresses only, never the owner-configured helper), with
 * its own image policy (PNG, JPEG, GIF, WebP; never SVG, which can carry script), checks the type it says and the bytes
 * it is, and its size, keeps it under its content hash in a directory of its own for a day, within a bounded number of
 * files and bytes, and serves it, to the page whose own address names it (`PresentEngine.mediaFor`), with headers that
 * make a browser treat it as an image and nothing else and keep it out of every cache. No resizing.
 *
 * What it promises, exactly (review round 1, b8, b9): an address is not fetched again while it is in this run's bounded
 * in-memory index of addresses (at most 1,024, the oldest forgotten first; not kept across a restart); a file is never
 * served after its day, and is removed by the next hourly sweep (or before a write that needs its room).
 *
 * The directory is the truth (review round 2, R6): its inventory (at start, and after any failed file operation, every
 * minute until it succeeds) removes temporary files, foreign files and what is past its age, and rebuilds the counts and
 * bytes from what is there. Any file operation that fails makes the cache "not sure": nothing new is admitted until an
 * inventory has read every entry and what remains is inside the bounds; what is kept is still served while its bytes
 * match its kept size, signature and digest. Every file is written through a temporary file and one `rename`.
 */

/** How long an image is kept (and may be served) after it was fetched. */
export const MEDIA_KEEP_MS = 24 * 3_600_000
/** Images kept at most; one more is refused `full` (what has expired goes first). */
export const MAX_MEDIA_FILES = 256
/** Bytes kept at most, all images together. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024
/** The largest image, in bytes (`safeFetch`'s limit too). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** Fetches under way at most; one more is refused `busy`. */
export const MAX_MEDIA_FETCHES = 4
/** One fetch's time limit, redirects and body included. */
export const MEDIA_FETCH_TIMEOUT_MS = 8_000
/** Addresses remembered with the hash they gave (so the same address is not fetched again within the day). */
const MAX_REMEMBERED_URLS = 1_024
/** How often what has expired is removed without a fetch or a request. */
const SWEEP_EVERY_MS = 3_600_000

/** The image types kept, by media type, with their file extension. SVG is not one. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }
const EXTENSIONS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([t, e]) => [e, t]))
/** `safeFetch`'s policy: these types only, refused before the body is read otherwise. */
export const MEDIA_POLICY: ContentTypePolicy = { name: "image", types: Object.keys(MEDIA_TYPES) }

/** What the bytes are, by their signature, whatever the response said; `undefined`: none of the kept types. */
export const sniffImage = (b: Uint8Array): string | undefined => {
  const at = (i: number, ...xs: ReadonlyArray<number>) => xs.every((x, k) => b[i + k] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return undefined
}

interface Kept {
  readonly hash: string
  readonly type: string
  readonly bytes: number
  /** Epoch ms it was fetched (the file's time after a restart). */
  readonly at: number
}

/** The file operations the cache uses (tests inject failures). */
export interface MediaFs {
  readonly mkdir: typeof mkdir
  readonly chmod: typeof chmod
  readonly opendir: typeof opendir
  readonly stat: (path: string) => Promise<{ readonly size: number; readonly mtimeMs: number; isFile(): boolean }>
  readonly readFile: (path: string) => Promise<Buffer>
  readonly unlink: (path: string) => Promise<void>
  readonly rmdir: (path: string) => Promise<void>
  readonly writeFile: (path: string, body: Uint8Array, options: { readonly mode: number }) => Promise<void>
  readonly utimes: (path: string, at: number, mtime: number) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly mkdirSync: typeof mkdirSync
  readonly chmodSync: typeof chmodSync
  readonly readdirSync: (path: string) => ReadonlyArray<string>
  readonly statSync: (path: string) => { readonly size: number; readonly mtimeMs: number; isFile(): boolean }
  readonly readFileSync: (path: string) => Buffer
  readonly writeFileSync: typeof writeFileSync
  readonly utimesSync: typeof utimesSync
  readonly renameSync: typeof renameSync
  readonly unlinkSync: typeof unlinkSync
}
const NODE_FS: MediaFs = { mkdir, chmod, rmdir, opendir, writeFile, utimes, rename, stat: (p) => stat(p), readFile: (p) => readFile(p), unlink: unlinkAsync, mkdirSync, chmodSync, readdirSync: (p) => readdirSync(p), statSync: (p) => statSync(p), readFileSync: (p) => readFileSync(p), writeFileSync, utimesSync, renameSync, unlinkSync }

/** Entries one inventory looks at, at most (what it removes makes the next one shorter). */
const MAX_INVENTORY_ENTRIES = 4_096
/** How often the cache checks whether an inventory is needed (after a fault) or the hourly removal is due. */
const CHECK_EVERY_MS = 60_000

export interface MediaCacheOptions {
  /** Its own directory (`data/media`): made `0700`, files `0600`. */
  readonly dir: string
  /** The fetch (default `safeFetch`); tests pass a resolver and connector through `fetchOptions` instead. */
  readonly fetch?: (url: string, options: SafeFetchOptions) => Effect.Effect<SafeResponse, SafeFetchError>
  /** Passed to every fetch (tests: `resolver`, `connector`). */
  readonly fetchOptions?: Pick<SafeFetchOptions, "resolver" | "connector">
  readonly now?: () => number
  readonly log?: (line: string) => void
  /** Where its Health issue goes (source `media`): the cache could not be read or cleaned, so nothing new is admitted. */
  readonly issues?: IssueRegistry
  /** Smaller bounds (tests of the full cache). Default `MAX_MEDIA_FILES`, `MAX_MEDIA_BYTES`. */
  readonly limits?: { readonly files?: number; readonly bytes?: number }
  /** The file operations (tests inject failures). Default node:fs. */
  readonly fs?: Partial<MediaFs>
}

export interface MediaCache extends MediaPort {
  /** Answer `GET /media/<token>`: the image `resolve(token)` names (a page's own address, `PresentEngine.mediaFor`) while it is kept; else 404. */
  readonly serve: (req: http.IncomingMessage, res: http.ServerResponse, resolve: (token: string) => string | undefined) => void
  /**
   * What is kept and under way (tests, Health). `sure`: the last inventory of the directory was complete and nothing has
   * failed since; while it is not, nothing new is admitted.
   */
  readonly stats: () => { readonly files: number; readonly bytes: number; readonly inFlight: number; readonly sure: boolean }
  /** Remove what has expired now, or, while the cache is not sure, take an inventory (a fiber does both by itself). */
  readonly sweep: () => Promise<void>
}

export const MEDIA_PREFIX = "/media/"
export const MEDIA_ISSUE_SOURCE = "media"

export const makeMediaCache = (options: MediaCacheOptions): Effect.Effect<MediaCache, never, Scope.Scope> =>
  Effect.gen(function*() {
    const now = options.now ?? Date.now
    const log = options.log ?? (() => undefined)
    const fetch = options.fetch ?? safeFetch
    const fs: MediaFs = { ...NODE_FS, ...options.fs }
    const maxFiles = Math.min(MAX_MEDIA_FILES, options.limits?.files ?? MAX_MEDIA_FILES)
    const maxBytes = Math.min(MAX_MEDIA_BYTES, options.limits?.bytes ?? MAX_MEDIA_BYTES)
    let kept = new Map<string, Kept>()
    const urls = new Map<string, string>()
    const inFlight = new Map<string, Deferred.Deferred<MediaOutcome>>()
    let bytes = 0
    /**
     * Review round 2 (R6): the directory is the truth. `sure` only after a complete inventory of it, with what remains
     * inside the bounds, and nothing has failed since. Any failed file operation makes the cache not sure: nothing new is
     * admitted (a fetch is refused `unavailable`) until an inventory succeeds; what is kept is still served while its bytes
     * match its kept size, signature and digest. There is no list of paths to remove later: an inventory removes what it sees expired at that moment.
     */
    let sure = false
    let lastSweep = now()
    const code = (e: unknown) => String((e as { code?: unknown }).code ?? e)
    let faultVersion = 0
    let issued = false
    const setSure = (value: boolean) => {
      sure = value
      if (issued === !value) return
      issued = !value
      options.issues?.set(MEDIA_ISSUE_SOURCE, value ? [] : [{
        id: "media.cache",
        severity: "warning",
        title: "The image cache could not be read or cleaned",
        detail: "New images are not kept until its directory (data/media) has been read completely; images already kept are still shown. It is tried again every minute."
      }])
    }
    const fault = (why: string) => {
      faultVersion++
      log(`Media: ${why}; no new image is kept until the image directory has been read completely`)
      setSure(false)
    }
    const fileOf = (k: Pick<Kept, "hash" | "type">) => join(options.dir, `${k.hash}.${MEDIA_TYPES[k.type]}`)

    /**
     * Read the directory as it is: remove temporary files, what is not one of its files, and what is past its age; then,
     * oldest first, what is over the bounds. Counts and bytes are rebuilt from what is really there. Sure only when every
     * entry could be read and removed where it had to be, and what remains is inside the bounds. An unreadable entry is
     * never taken as absent: the inventory is then incomplete.
     */
    const inventory = async () => {
      const version = faultVersion
      setSure(false)
      let complete = true
      const t = now()
      const found: Array<Kept> = []
      const remove = async (path: string, directory = false) => {
        try {
          if (directory) await fs.rmdir(path)
          else await fs.unlink(path)
          return true
        }
        catch (e) {
          if ((e as { code?: unknown }).code === "ENOENT") return true
          fault(`${path} could not be removed (${code(e)})`)
          complete = false
          return false
        }
      }
      try {
        await fs.mkdir(options.dir, { recursive: true, mode: 0o700 })
        await fs.chmod(options.dir, 0o700)
        // Streaming directory iteration bounds even the read itself. Only one entry's bytes are read at a time.
        const directory = await fs.opendir(options.dir, { bufferSize: 16 })
        let seen = 0
        for await (const entry of directory) {
          if (++seen > MAX_INVENTORY_ENTRIES) { complete = false; break }
          const name = entry.name
          const path = join(options.dir, name)
          const m = /^([0-9a-f]{64})\.([a-z]+)$/.exec(name)
          const type = m === null ? undefined : EXTENSIONS[m[2]!]
          if (!entry.isFile() || m === null || type === undefined) {
            await remove(path, entry.isDirectory())
          } else {
            try {
              const st = await fs.stat(path)
              if (!st.isFile() || st.size > MAX_IMAGE_BYTES || st.mtimeMs + MEDIA_KEEP_MS <= t) {
                await remove(path)
              } else {
                const body = await fs.readFile(path)
                // A filename and a stat are not proof of an image. Wrong suffixes (including duplicate hashes),
                // truncated files and bytes with a different digest are removed before reopening admission.
                if (body.length !== st.size || sniffImage(body) !== type || createHash("sha256").update(body).digest("hex") !== m[1]) await remove(path)
                else found.push({ hash: m[1]!, type, bytes: body.length, at: st.mtimeMs })
              }
            } catch (e) {
              if ((e as { code?: unknown }).code !== "ENOENT") {
                fault(`${path} could not be read (${code(e)})`)
                complete = false
              }
            }
          }
          // Each step is bounded by one image (2 MiB); a real yield also covers immediately resolved test ports.
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      } catch (e) {
        fault(`the image directory ${options.dir} could not be read (${code(e)})`)
        complete = false
      }
      found.sort((a, b) => a.at - b.at)
      let total = found.reduce((n, k) => n + k.bytes, 0)
      while (found.length > maxFiles || total > maxBytes) {
        const oldest = found[0]!
        if (!await remove(fileOf(oldest))) break
        found.shift()
        total -= oldest.bytes
      }
      if (complete && version === faultVersion) {
        kept = new Map(found.map((k) => [k.hash, k]))
        bytes = total
        lastSweep = t
        setSure(true)
      } else {
        // An incomplete scan may serve what it read, but admits nothing and never calls an unreadable entry absent.
        for (const k of found) kept.set(k.hash, k)
        setSure(false)
      }
    }

    // A disk mutation reserves the single admission lane before awaiting I/O. Inventories cannot miss a write in
    // progress, and concurrent admissions check count and bytes only after the previous reservation has settled.
    let diskTail = Promise.resolve()
    const withDisk = <A>(run: () => Promise<A>): Promise<A> => {
      const result = diskTail.then(run)
      diskTail = result.then(() => undefined, () => undefined)
      return result
    }
    let sweeping: Promise<void> | undefined
    /** Serialize inventories and expiry cleanup; fetch completions wait for this off the turn path. */
    const sweep = (): Promise<void> => {
      if (sweeping !== undefined) return sweeping
      sweeping = withDisk(async () => {
        if (!sure) await inventory()
        else {
          const t = now()
          lastSweep = t
          for (const k of [...kept.values()]) {
            if (k.at + MEDIA_KEEP_MS > t) continue
            kept.delete(k.hash)
            bytes -= k.bytes
            try { await fs.unlink(fileOf(k)) }
            catch (e) {
              if ((e as { code?: unknown }).code !== "ENOENT") fault(`${fileOf(k)} could not be removed (${code(e)})`)
            }
          }
        }
        for (const [url, hash] of urls) if (!kept.has(hash)) urls.delete(url)
      }).finally(() => { sweeping = undefined })
      return sweeping
    }

    // Startup waits for the asynchronous inventory; no admission is possible while it is incomplete.
    yield* Effect.promise(sweep)

    const refusalOf = (e: SafeFetchError): MediaRefusal =>
      e instanceof NetTooLarge ? "size" : e instanceof NetRefused ? (e.rule === "content-type" ? "type" : "blocked") : "fetch"

    const fetchOnce = (url: string): Effect.Effect<MediaOutcome> =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(fetch(url, { accept: MEDIA_POLICY, maxBytes: MAX_IMAGE_BYTES, timeoutMs: MEDIA_FETCH_TIMEOUT_MS, ...options.fetchOptions }))
        if (Exit.isFailure(exit)) {
          const e = exit.cause.reasons.find((r) => r._tag === "Fail")
          return { refused: e !== undefined && e._tag === "Fail" ? refusalOf(e.error as SafeFetchError) : "fetch" } satisfies MediaOutcome
        }
        const r = exit.value
        if (r.status < 200 || r.status > 299) return { refused: "fetch" } satisfies MediaOutcome
        if (r.body.length > MAX_IMAGE_BYTES) return { refused: "size" } satisfies MediaOutcome
        // The type it says and the type its bytes are must agree, and be one of the kept types.
        const said = r.contentType
        const is = sniffImage(r.body)
        if (MEDIA_TYPES[said] === undefined || is !== said) return { refused: "type" } satisfies MediaOutcome
        const hash = createHash("sha256").update(r.body).digest("hex")
        // A sweep may already be running with an earlier clock sample. Recheck expiry in the admission lane:
        // unrelated expired files also make room for the incoming bytes.
        yield* Effect.promise(sweep)
        return yield* Effect.promise(() => withDisk(async (): Promise<MediaOutcome> => {
          if (!sure) return { refused: "unavailable" }
          const version = faultVersion
          for (const expired of kept.values()) {
            if (expired.at + MEDIA_KEEP_MS > now()) continue
            try { await fs.unlink(fileOf(expired)) }
            catch (e) {
              if ((e as { code?: unknown }).code !== "ENOENT") {
                fault(`an expired image could not be removed (${code(e)})`)
                return { refused: "unavailable" }
              }
            }
            kept.delete(expired.hash)
            bytes -= expired.bytes
          }
          if (!sure || version !== faultVersion) return { refused: "unavailable" }
          const already = kept.get(hash)
          if (already === undefined) {
            if (kept.size >= maxFiles || bytes + r.body.length > maxBytes) return { refused: "full" }
            const t = now()
            const k: Kept = { hash, type: said, bytes: r.body.length, at: t }
            const tmp = join(options.dir, `.tmp-${randomBytes(8).toString("hex")}`)
            try {
              await fs.writeFile(tmp, r.body, { mode: 0o600 })
              // The file's time survives a restart; every disk operation yields to unrelated voice work.
              await fs.utimes(tmp, t / 1000, t / 1000)
              await fs.rename(tmp, fileOf(k))
            } catch (e) {
              fault(`an image could not be kept (${code(e)})`)
              try { await fs.unlink(tmp) } catch { /* The inventory removes it. */ }
              return { refused: "fetch" }
            }
            // A concurrent held-image read can fault while disk I/O yields. Inventory must account for this file
            // before its hash or address is published.
            if (!sure || version !== faultVersion) return { refused: "unavailable" }
            kept.set(hash, k)
            bytes += k.bytes
          }
          if (urls.size >= MAX_REMEMBERED_URLS) urls.delete(urls.keys().next().value!)
          urls.set(url, hash)
          return { hash }
        }))
      })

    const cacheFetch = (url: string): Effect.Effect<MediaOutcome> =>
      Effect.suspend(() => {
        // The same address within the day: the image it gave, not fetched again.
        const known = urls.get(url)
        const k = known === undefined ? undefined : kept.get(known)
        if (k !== undefined && k.at + MEDIA_KEEP_MS > now()) return Effect.succeed({ hash: k.hash })
        // The same address under way: one fetch, every asker gets its outcome.
        const running = inFlight.get(url)
        if (running !== undefined) return Deferred.await(running)
        if (inFlight.size >= MAX_MEDIA_FETCHES) return Effect.succeed({ refused: "busy" as const })
        const done = Deferred.makeUnsafe<MediaOutcome>()
        inFlight.set(url, done)
        return fetchOnce(url).pipe(
          Effect.catchCause(() => Effect.succeed({ refused: "fetch" as const })),
          Effect.tap((outcome) => Deferred.succeed(done, outcome)),
          Effect.ensuring(Effect.sync(() => {
            inFlight.delete(url)
            Deferred.doneUnsafe(done, Effect.succeed({ refused: "fetch" }))
          }))
        )
      })

    const notFound = (res: http.ServerResponse) =>
      void res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }).end("Not found")

    const serveAsync = async (req: http.IncomingMessage, res: http.ServerResponse, resolve: (token: string) => string | undefined): Promise<void> => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "X-Content-Type-Options": "nosniff" }).end()
        return
      }
      // A page's own address (review round 1, b1): a token the server made for one connection and one image, which names
      // its image only while that connection is open and holds a presentation with it. Anything else is 404.
      const token = (req.url ?? "").split("?")[0]!.slice(MEDIA_PREFIX.length)
      if (!MEDIA_TOKEN.test(token)) return notFound(res)
      const hash = resolve(token)
      const k = hash === undefined || !MEDIA_HASH.test(hash) ? undefined : kept.get(hash)
      if (k === undefined || k.at + MEDIA_KEEP_MS <= now()) return notFound(res)
      let body: Buffer
      try {
        body = await fs.readFile(fileOf(k))
      } catch (e) {
        // Not served this time. The entry is kept (round 3): the cache is not sure and the inventory decides whether the
        // file is there; a read that works again serves it again without waiting for that.
        fault(`${fileOf(k)} could not be read (${code(e)})`)
        return notFound(res)
      }
      if (body.length !== k.bytes || sniffImage(body) !== k.type || createHash("sha256").update(body).digest("hex") !== k.hash) {
        // A successful read proved this copy is bad. Forget its URL hits; inventory removes the file and repairs the
        // accounting before a fresh fetch can be admitted. A merely failed read above keeps its retryable hit.
        for (const [url, known] of urls) if (known === k.hash) urls.delete(url)
        fault(`${fileOf(k)} no longer matches the kept image`)
        return notFound(res)
      }
      const current = kept.get(k.hash)
      // A clean inventory replaces metadata objects. The authorized, validated image remains usable across it.
      if (resolve(token) !== hash || current === undefined || current.bytes !== body.length || current.type !== k.type || current.at + MEDIA_KEEP_MS <= now()) return notFound(res)
      res.writeHead(200, {
        "Content-Type": k.type,
        "Content-Length": String(body.length),
        // An image and nothing else: never sniffed as another type, never run as a document, never framed or embedded
        // by another site.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `inline; filename="image.${MEDIA_TYPES[k.type]}"`,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        // For that page only, and not kept by any cache: the address is the page's, and stops working when it lets go.
        "Cache-Control": "private, no-store"
      })
      res.end(req.method === "HEAD" ? undefined : body)
    }

    const serve: MediaCache["serve"] = (req, res, resolve) => {
      void serveAsync(req, res, resolve).catch((e) => {
        fault(`an image request could not be completed (${code(e)})`)
        if (!res.headersSent) notFound(res)
      })
    }

    // Every minute: an inventory while the cache is not sure; what has expired goes every hour, not only when something
    // is fetched.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(CHECK_EVERY_MS), Effect.promise(async () => {
      if (!sure || now() - lastSweep >= SWEEP_EVERY_MS) await sweep()
    }))))

    return {
      fetch: cacheFetch,
      serve,
      stats: () => ({ files: kept.size, bytes, inFlight: inFlight.size, sure }),
      sweep
    } satisfies MediaCache
  })
