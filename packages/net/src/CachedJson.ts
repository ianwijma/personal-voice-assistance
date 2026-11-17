import { Deferred, Effect, Exit } from "effect"
import { createHash } from "node:crypto"
import { NetAborted, NetBadJson, NetHttpStatus, NetRefused, type CachedJsonError, type SafeFetchError } from "./Errors.ts"
import { canonicalHeaders, checkHeaders, contentTypes, safeFetch, type SafeFetchOptions, type SafeResponse } from "./SafeFetch.ts"

export interface JsonCacheEntry {
  readonly value: unknown
  readonly etag?: string
  /**
   * The URL the body came from, after redirects. The ETag is that resource's: a conditional request is sent only when the request
   * goes to exactly this URL, and a 304 counts as a revalidation only when it comes from it (review round 3, finding 1). An entry
   * without it is never revalidated.
   */
  readonly url?: string
  /** When the value was fetched or last confirmed (clock milliseconds): for the TTL and the age only, never for ordering. */
  readonly storedAt: number
  /** The `sequence()` number taken when the request that produced this entry started. */
  readonly sequence: number
}

/**
 * Where fetched values live. The in-memory one below is the default; a store-backed one can implement this. `sequence` hands out
 * strictly increasing numbers (per cache, shared by every client of it); `setIfNewer` stores the entry only when no entry with the
 * same or a higher `sequence` was stored for the key, and says whether it did. A cache shared by several processes must make
 * `setIfNewer` one atomic step (a transaction), and `sequence` monotonic across them. A cache that evicts must remember, for an
 * evicted key, the sequence it held (or a bound above it), and refuse older writes to it: otherwise a slow refresh that started
 * before the eviction would store an older value after it. The in-memory cache keeps such a fence (review round 3, finding 4).
 */
export interface JsonCache {
  readonly get: (key: string) => JsonCacheEntry | undefined
  readonly setIfNewer: (key: string, entry: JsonCacheEntry) => boolean
  readonly delete: (key: string) => void
  readonly sequence: () => number
}

/**
 * A bounded in-memory cache: the oldest-stored entry goes when `maxEntries` is exceeded. `maxEntries` is a whole number from 1 to
 * 1 000 000; anything else is a `RangeError` (a negative or fractional bound would never be met, `NaN` or `Infinity` would be none).
 *
 * The order of writes survives eviction: an evicted key's sequence is kept as a fence (at most `maxEntries` of them, oldest first);
 * when a fence goes too, its sequence raises a floor that every write to a key without an entry or a fence must exceed. A write that
 * a fence or the floor refuses is only a value not cached; it is never an older value served (review round 3, finding 4).
 */
export const makeMemoryJsonCache = (maxEntries = 200): JsonCache => {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) throw new RangeError(`maxEntries must be a whole number from 1 to 1000000, not ${maxEntries}`)
  const map = new Map<string, JsonCacheEntry>()
  const fences = new Map<string, number>()
  let floor = 0
  let counter = 0
  const fenceOf = (key: string): number => fences.get(key) ?? floor
  return {
    get: (key) => map.get(key),
    setIfNewer: (key, entry) => {
      const current = map.get(key)
      if (current !== undefined ? current.sequence >= entry.sequence : fenceOf(key) >= entry.sequence) return false
      map.delete(key)
      fences.delete(key)
      map.set(key, entry)
      while (map.size > maxEntries) {
        const [oldKey, old] = map.entries().next().value!
        map.delete(oldKey)
        fences.set(oldKey, old.sequence)
        while (fences.size > maxEntries) {
          const [fencedKey, fenced] = fences.entries().next().value!
          fences.delete(fencedKey)
          floor = Math.max(floor, fenced)
        }
      }
      return true
    },
    delete: (key) => {
      const current = map.get(key)
      if (current === undefined) return
      map.delete(key)
      fences.set(key, Math.max(current.sequence, fences.get(key) ?? 0))
      while (fences.size > maxEntries) {
        const [fencedKey, fenced] = fences.entries().next().value!
        fences.delete(fencedKey)
        floor = Math.max(floor, fenced)
      }
    },
    sequence: () => ++counter
  }
}

export type JsonSource = "cache" | "network" | "revalidated" | "stale"

export interface JsonResult<A = unknown> {
  readonly value: A
  readonly source: JsonSource
  /** How old the value is (ms since it was fetched or last confirmed by the server), at the moment it is returned. */
  readonly ageMs: number
  /** For `stale`: why the network failed. */
  readonly error?: CachedJsonError
}

export interface GetJsonOptions {
  /** How long a value is served without asking. Not a number (a string, `NaN`, …) or below 0 counts as 0; `Infinity` is allowed. */
  readonly ttlMs: number
  /** After the TTL, how long a failed refresh may fall back to the old value. Default 0 (never); not a number or below 0 counts as 0. A caller's abort never falls back. */
  readonly staleIfErrorMs?: number
  /**
   * Request headers (checked as `safeFetch` checks them). They are part of the cache key: Alice's `Authorization` never serves Bob.
   * Names are compared without case: each map is checked and lower-cased on its own (a name twice in one map is refused), then these
   * override the client's `headers` name by name ("authorization" here replaces "Authorization" there).
   */
  readonly headers?: Readonly<Record<string, string>>
  /** Options for the fetch (limits, signal, resolver, connector). The response type is always JSON. */
  readonly fetch?: Omit<SafeFetchOptions, "headers" | "method" | "accept">
}

export interface CachedJsonDeps {
  readonly cache?: JsonCache
  /** Milliseconds; default `Date.now`. */
  readonly now?: () => number
  /** Default `safeFetch`; inject a fake in tests. */
  readonly fetch?: (url: string, options: SafeFetchOptions) => Effect.Effect<SafeResponse, SafeFetchError>
  /** Sent on every request (the `User-Agent` from `userAgent()`, say). */
  readonly headers?: Readonly<Record<string, string>>
}

export interface CachedJson {
  readonly getJson: <A = unknown>(url: string, options: GetJsonOptions) => Effect.Effect<JsonResult<A>, CachedJsonError>
}

/** Headers that only make a request conditional; the cache sets `If-None-Match` itself. */
const conditional: ReadonlySet<string> = new Set(["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"])

/**
 * The cache key of a representation: the URL and every request header that can change what the server answers (all of them except
 * the conditional ones), hashed so a credential never sits in a key a store might persist or log. Review round 1, finding 1.
 */
export const representationKey = (url: string, headers: Readonly<Record<string, string>>): string => {
  const pairs = Object.keys(headers).filter((k) => !conditional.has(k)).sort().map((k) => [k, headers[k]!])
  if (pairs.length === 0) return url
  return `${url}#${createHash("sha256").update(JSON.stringify(pairs)).digest("base64url").slice(0, 32)}`
}

/** Function options (resolver, connector) are told apart by identity in the key of a shared request. */
const ids = new WeakMap<object, number>()
let nextId = 1
const idOf = (f: object | undefined): number => {
  if (f === undefined) return 0
  let id = ids.get(f)
  if (id === undefined) { id = nextId++; ids.set(f, id) }
  return id
}

/** A duration option: a number from 0 (`Infinity` included), anything else — a string, a boolean, `NaN`, a negative number — 0. */
const nonNegative = (v: unknown): number => (typeof v === "number" && v >= 0 ? v : 0)

type Outcome = { readonly kind: "value"; readonly value: unknown; readonly ageMs: number; readonly source: "network" | "revalidated" }

interface Shared {
  readonly deferred: Deferred.Deferred<Outcome, CachedJsonError>
  readonly interrupt: () => void
  waiters: number
  settled: boolean
}

/** Wait for `effect`, or fail with `NetAborted` as soon as `signal` fires; nothing else is interrupted by it. */
const untilAborted = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal | undefined, url: string): Effect.Effect<A, E | NetAborted> => {
  if (signal === undefined) return effect
  const aborted = Effect.callback<never, NetAborted>((resume) => {
    const fire = () => resume(Effect.fail(new NetAborted({ url })))
    if (signal.aborted) fire()
    else signal.addEventListener("abort", fire, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", fire))
  })
  return Effect.raceFirst(effect, aborted)
}

/**
 * The identity of the resource a URL names, for binding a validator to it: the URL as the WHATWG parser serialises it (lower-case
 * scheme and host, no default port, dot segments resolved, `/` for a bare origin) without its fragment, which is never sent. Two
 * spellings of one resource have the same identity (review round 4, finding 2); a string that is not a URL has none.
 */
const resourceIdentity = (url: string): string | undefined => {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.href
  } catch {
    return undefined
  }
}

const sameResource = (a: string | undefined, b: string | undefined): boolean => {
  if (a === undefined || b === undefined) return false
  const x = resourceIdentity(a)
  return x !== undefined && x === resourceIdentity(b)
}

/**
 * A GET of JSON behind `safeFetch` (response type JSON only), cached: served from the cache within the TTL; after it, revalidated
 * with `If-None-Match` when the server gave an ETag (a 304 renews the entry without a body); when the refresh fails, the old value is
 * served for up to `staleIfErrorMs` more, its age taken when the failure is known. The key is the URL with the request headers
 * (`representationKey`). Callers that miss the cache at the same time share one request: each waits on its own terms (its signal
 * makes it fail with `NetAborted`, its interruption only stops its wait), and the request is cancelled when no one waits for it any
 * more. A request never overwrites an entry stored by a request that started after it (the cache's `sequence`, not the clock).
 */
export const makeCachedJson = (deps: CachedJsonDeps = {}): CachedJson => {
  const cache = deps.cache ?? makeMemoryJsonCache()
  const now = deps.now ?? Date.now
  const fetch = deps.fetch ?? safeFetch
  const inflight = new Map<string, Shared>()

  const refresh = (url: string, key: string, headers: Record<string, string>, options: GetJsonOptions): Effect.Effect<Outcome, CachedJsonError> =>
    Effect.gen(function* () {
      // The order of refreshes is the order they started in, by the cache's sequence: a slower, older request never replaces what a
      // newer one stored, whatever the clocks say (review round 2, finding 18).
      const sequence = cache.sequence()
      const entry = cache.get(key)
      const { signal: _signal, ...limits } = options.fetch ?? {}
      // A validator belongs to the resource it came from (review round 3, finding 1): it is sent only when this request goes to the
      // URL the cached body came from (compared as resource identities: review round 4, finding 2), and `safeFetch` drops it on any redirect, so it never reaches another resource.
      const validator = entry?.etag !== undefined && sameResource(entry.url, url) ? entry.etag : undefined
      const ask = (conditional: boolean) => {
        const sent: Record<string, string> = { ...headers }
        if (conditional && validator !== undefined) sent["if-none-match"] = validator
        return fetch(url, { ...limits, accept: contentTypes.json, method: "GET", headers: sent })
      }
      let response = yield* ask(true)
      if (response.status === 304) {
        // A revalidation only when the 304 answers the conditional request for the cached body's own URL; any other 304 (a redirect
        // that ended elsewhere, a server that answers 304 unasked) says nothing about the cached value: ask again without conditions.
        if (entry !== undefined && validator !== undefined && sameResource(response.url, entry.url) && response.redirects.length === 0) {
          const etag = response.headers["etag"] ?? entry.etag
          cache.setIfNewer(key, { value: entry.value, ...(etag !== undefined ? { etag } : {}), url: entry.url ?? response.url, storedAt: now(), sequence })
          return { kind: "value", value: entry.value, ageMs: 0, source: "revalidated" } satisfies Outcome
        }
        response = yield* ask(false)
        if (response.status === 304) return yield* Effect.fail(new NetHttpStatus({ url, status: 304 }))
      }
      if (response.status < 200 || response.status > 299) return yield* Effect.fail(new NetHttpStatus({ url, status: response.status }))
      let value: unknown
      try {
        value = JSON.parse(response.text().replace(/^\uFEFF/, ""))
      } catch {
        return yield* Effect.fail(new NetBadJson({ url, detail: "the response is not valid JSON" }))
      }
      const etag = response.headers["etag"]
      cache.setIfNewer(key, { value, ...(etag !== undefined ? { etag } : {}), url: response.url, storedAt: now(), sequence })
      return { kind: "value", value, ageMs: 0, source: "network" } satisfies Outcome
    })

  const getJson = <A>(url: string, options: GetJsonOptions): Effect.Effect<JsonResult<A>, CachedJsonError> =>
    Effect.gen(function* () {
      // An already-aborted call fails as it would on a miss, also when the cache holds a fresh value (review round 3, finding 5).
      if (options.fetch?.signal?.aborted === true) return yield* Effect.fail(new NetAborted({ url }))
      const ttl = nonNegative(options.ttlMs)
      const staleWindow = nonNegative(options.staleIfErrorMs)
      // Each map is checked and lower-cased on its own, then merged name by name, the call's over the client's (finding 3).
      const defaults = canonicalHeaders(url, deps.headers)
      if (defaults instanceof NetRefused) return yield* Effect.fail(defaults)
      const own = canonicalHeaders(url, options.headers)
      if (own instanceof NetRefused) return yield* Effect.fail(own)
      const merged: Record<string, string> = { ...defaults, ...own }
      for (const k of Object.keys(merged)) if (conditional.has(k)) delete merged[k]
      const headers = checkHeaders(url, merged, contentTypes.json)
      if (headers instanceof NetRefused) return yield* Effect.fail(headers)
      const plain: Record<string, string> = { ...headers }
      const key = representationKey(url, plain)
      const fresh = (e: JsonCacheEntry | undefined) => {
        if (e === undefined) return undefined
        const age = now() - e.storedAt
        return age >= 0 && age < ttl ? { value: e.value as A, source: "cache", ageMs: age } satisfies JsonResult<A> : undefined
      }
      const hit = fresh(cache.get(key))
      if (hit !== undefined) return hit
      // One request per representation and fetch setup; the caller's own signal is not part of it.
      const f = options.fetch
      const flightKey = `${key}\n${f?.maxBytes ?? ""}|${f?.timeoutMs ?? ""}|${f?.maxRedirects ?? ""}|${idOf(f?.resolver)}|${idOf(f?.connector)}`
      // Joining or starting the flight, and registering this caller as a waiter with its cleanup, is one uninterruptible step; only the
      // wait itself is interruptible (review round 5, finding 1). The slot is published in the same synchronous step that creates it,
      // before its refresh can run, so a refresh that settles removes exactly its own slot and a settled slot is never inserted.
      const outcome = yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        let s = inflight.get(flightKey)
        const created = s === undefined
        if (s === undefined) {
          s = { deferred: Deferred.makeUnsafe<Outcome, CachedJsonError>(), interrupt: () => undefined, waiters: 0, settled: false }
          inflight.set(flightKey, s)
        }
        const own = s
        own.waiters++
        if (created) {
          const settle = Effect.sync(() => { own.settled = true; if (inflight.get(flightKey) === own) inflight.delete(flightKey) })
          const fiber = yield* refresh(url, key, plain, options).pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle.pipe(Effect.andThen(Deferred.done(own.deferred, exit)))),
            // Interrupted (no one waits, or the runtime stops): anyone still waiting is told, never left hanging.
            Effect.onInterrupt(() => settle.pipe(Effect.andThen(Deferred.interrupt(own.deferred)))),
            Effect.forkDetach
          )
          // This caller is a waiter until its `leave`, so nobody can find the flight without waiters before the handle is set.
          ;(own as { interrupt: () => void }).interrupt = () => fiber.interruptUnsafe()
        }
        const leave = Effect.sync(() => {
          own.waiters--
          // Nobody waits any more: cancel the request, and let the next caller start a new one.
          if (own.waiters === 0 && !own.settled) {
            if (inflight.get(flightKey) === own) inflight.delete(flightKey)
            own.interrupt()
          }
        })
        return yield* restore(untilAborted(Deferred.await(own.deferred), options.fetch?.signal, url)).pipe(Effect.exit, Effect.ensuring(leave))
      }))
      if (Exit.isSuccess(outcome)) {
        const o = outcome.value
        return { value: o.value as A, source: o.source, ageMs: o.ageMs } satisfies JsonResult<A>
      }
      const error = outcome.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : undefined)).find((e) => e !== undefined)
      // The caller's abort is not a network failure: no stale fallback (review round 1, finding 25). Interruption is not an error.
      if (error === undefined) return yield* Effect.failCause(outcome.cause)
      if (error instanceof NetAborted) return yield* Effect.fail(error)
      // Stale-if-error, with the age the value has now, after the failed request (finding 24).
      const old = cache.get(key)
      if (old !== undefined) {
        const age = now() - old.storedAt
        if (age >= 0 && age < ttl) return { value: old.value as A, source: "cache", ageMs: age } satisfies JsonResult<A>
        if (age >= 0 && age < ttl + staleWindow) return { value: old.value as A, source: "stale", ageMs: age, error } satisfies JsonResult<A>
      }
      return yield* Effect.fail(error)
    })
  return { getJson }
}
