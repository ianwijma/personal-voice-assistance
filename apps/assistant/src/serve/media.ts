import type { MediaOutcome, MediaPort, MediaRefusal } from "@pva/core"
import { type ContentTypePolicy, NetRefused, NetTooLarge, safeFetch, type SafeFetchError, type SafeFetchOptions, type SafeResponse } from "@pva/net"
import { MEDIA_HASH, MEDIA_TOKEN } from "@pva/protocol"
import { Deferred, Effect, Exit, type Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
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
 * served after its day, and is removed by the next hourly sweep (or before a write that needs its room). A file whose
 * removal fails stays counted against the bounds and is tried again.
 *
 * The files survive a restart: the directory is read at start (what has expired, or is not one of its files, is
 * removed) and every file is written through a temporary file and one `rename`.
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

export interface MediaCacheOptions {
  /** Its own directory (`data/media`): made `0700`, files `0600`. */
  readonly dir: string
  /** The fetch (default `safeFetch`); tests pass a resolver and connector through `fetchOptions` instead. */
  readonly fetch?: (url: string, options: SafeFetchOptions) => Effect.Effect<SafeResponse, SafeFetchError>
  /** Passed to every fetch (tests: `resolver`, `connector`). */
  readonly fetchOptions?: Pick<SafeFetchOptions, "resolver" | "connector">
  readonly now?: () => number
  readonly log?: (line: string) => void
  /** Smaller bounds (tests of the full cache). Default `MAX_MEDIA_FILES`, `MAX_MEDIA_BYTES`. */
  readonly limits?: { readonly files?: number; readonly bytes?: number }
}

export interface MediaCache extends MediaPort {
  /** Answer `GET /media/<token>`: the image `resolve(token)` names (a page's own address, `PresentEngine.mediaFor`) while it is kept; else 404. */
  readonly serve: (req: http.IncomingMessage, res: http.ServerResponse, resolve: (token: string) => string | undefined) => void
  /** What is kept and under way (tests, Health). */
  readonly stats: () => { readonly files: number; readonly bytes: number; readonly inFlight: number; readonly stale: number }
  /** Remove what has expired now (an hourly fiber does it by itself). */
  readonly sweep: () => void
}

export const MEDIA_PREFIX = "/media/"

export const makeMediaCache = (options: MediaCacheOptions): Effect.Effect<MediaCache, never, Scope.Scope> =>
  Effect.gen(function*() {
    const now = options.now ?? Date.now
    const log = options.log ?? (() => undefined)
    const fetch = options.fetch ?? safeFetch
    const maxFiles = Math.min(MAX_MEDIA_FILES, options.limits?.files ?? MAX_MEDIA_FILES)
    const maxBytes = Math.min(MAX_MEDIA_BYTES, options.limits?.bytes ?? MAX_MEDIA_BYTES)
    const kept = new Map<string, Kept>()
    const urls = new Map<string, string>()
    const inFlight = new Map<string, Deferred.Deferred<MediaOutcome>>()
    let bytes = 0
    /**
     * Files whose removal failed (other than "not there"): never served, still counted against the bounds until their
     * removal succeeds, tried again at every sweep and before every write (review round 1, b4).
     */
    const stale = new Map<string, number>()
    let staleBytes = 0
    const fileOf = (k: Pick<Kept, "hash" | "type">) => join(options.dir, `${k.hash}.${MEDIA_TYPES[k.type]}`)
    /** Remove a file; true when it is gone (removed, or not there). */
    const unlink = (path: string): boolean => {
      try {
        unlinkSync(path)
        return true
      } catch (e) {
        if ((e as { code?: unknown }).code === "ENOENT") return true
        log(`Media: ${path} could not be removed (${String((e as { code?: unknown }).code ?? e)}); tried again`)
        return false
      }
    }
    const removeLater = (path: string, size: number) => {
      if (stale.has(path)) return
      stale.set(path, size)
      staleBytes += size
    }
    const retryStale = () => {
      for (const [path, size] of [...stale]) {
        if (!unlink(path)) continue
        stale.delete(path)
        staleBytes -= size
      }
    }
    const remove = (k: Kept) => {
      // Not served from now on; its place in the bounds is given back only once the file is gone.
      kept.delete(k.hash)
      bytes -= k.bytes
      const path = fileOf(k)
      if (!unlink(path)) removeLater(path, k.bytes)
    }
    const sweep = () => {
      const t = now()
      retryStale()
      for (const k of [...kept.values()]) if (k.at + MEDIA_KEEP_MS <= t) remove(k)
      for (const [url, hash] of urls) if (!kept.has(hash)) urls.delete(url)
    }

    // The directory: its own, private; what is there is read back (the cache survives a restart).
    try {
      mkdirSync(options.dir, { recursive: true, mode: 0o700 })
      chmodSync(options.dir, 0o700)
      for (const name of readdirSync(options.dir)) {
        const path = join(options.dir, name)
        const m = /^([0-9a-f]{64})\.([a-z]+)$/.exec(name)
        const type = m === null ? undefined : EXTENSIONS[m[2]!]
        try {
          const st = statSync(path)
          if (m === null || type === undefined || !st.isFile() || st.size > MAX_IMAGE_BYTES || st.mtimeMs + MEDIA_KEEP_MS <= now() || kept.size >= maxFiles || bytes + st.size > maxBytes) {
            // Debris (an interrupted write, a foreign file), an expired or an over-bound file: removed; if that fails,
            // counted against the bounds and tried again.
            if (!unlink(path)) removeLater(path, st.isFile() ? st.size : 0)
            continue
          }
          kept.set(m[1]!, { hash: m[1]!, type, bytes: st.size, at: st.mtimeMs })
          bytes += st.size
        } catch {
          // Unreadable: left alone, not served.
        }
      }
    } catch (e) {
      log(`Media: the image directory ${options.dir} could not be read (${String(e)}); images are fetched again`)
    }

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
        const t = now()
        // What has expired is dealt with before the same bytes are matched against it (b5): an expired copy is a new admission.
        sweep()
        const already = kept.get(hash)
        if (already === undefined) {
          if (kept.size + stale.size >= maxFiles || bytes + staleBytes + r.body.length > maxBytes) return { refused: "full" } satisfies MediaOutcome
          const k: Kept = { hash, type: said, bytes: r.body.length, at: t }
          const tmp = join(options.dir, `.tmp-${randomBytes(8).toString("hex")}`)
          try {
            writeFileSync(tmp, r.body, { mode: 0o600 })
            // The file's time is when it was fetched: what a restart reads back to keep it for the rest of its day.
            utimesSync(tmp, t / 1000, t / 1000)
            renameSync(tmp, fileOf(k))
          } catch (e) {
            try {
              unlinkSync(tmp)
            } catch {
              // Not written.
            }
            log(`Media: an image could not be kept (${String(e)})`)
            return { refused: "fetch" } satisfies MediaOutcome
          }
          kept.set(hash, k)
          bytes += k.bytes
        }
        if (urls.size >= MAX_REMEMBERED_URLS) urls.delete(urls.keys().next().value!)
        urls.set(url, hash)
        return { hash } satisfies MediaOutcome
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

    const serve: MediaCache["serve"] = (req, res, resolve) => {
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
        body = readFileSync(fileOf(k))
      } catch {
        remove(k)
        return notFound(res)
      }
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

    // What has expired goes every hour too, not only when something is fetched.
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(SWEEP_EVERY_MS), Effect.sync(sweep))))

    return {
      fetch: cacheFetch,
      serve,
      stats: () => ({ files: kept.size, bytes, inFlight: inFlight.size, stale: stale.size }),
      sweep
    } satisfies MediaCache
  })
