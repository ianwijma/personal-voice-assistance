import { Effect } from "effect"
import { NetBadJson, NetHttpStatus, type CachedJsonError, type SafeFetchError } from "./Errors.ts"
import { safeFetch, type SafeFetchOptions, type SafeResponse } from "./SafeFetch.ts"

export interface JsonCacheEntry {
  readonly value: unknown
  readonly etag?: string
  /** When the value was fetched or last confirmed (clock milliseconds). */
  readonly storedAt: number
}

/** Where fetched values live. The in-memory one below is the default; a store-backed one can implement this. */
export interface JsonCache {
  readonly get: (key: string) => JsonCacheEntry | undefined
  readonly set: (key: string, entry: JsonCacheEntry) => void
  readonly delete: (key: string) => void
}

/** A bounded in-memory cache: the oldest-stored entry goes when `maxEntries` is exceeded. */
export const makeMemoryJsonCache = (maxEntries = 200): JsonCache => {
  const map = new Map<string, JsonCacheEntry>()
  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.delete(key)
      map.set(key, entry)
      while (map.size > maxEntries) map.delete(map.keys().next().value!)
    },
    delete: (key) => void map.delete(key)
  }
}

export type JsonSource = "cache" | "network" | "revalidated" | "stale"

export interface JsonResult<A = unknown> {
  readonly value: A
  readonly source: JsonSource
  /** How old the value is (ms since it was fetched or last confirmed by the server). */
  readonly ageMs: number
  /** For `stale`: why the network failed. */
  readonly error?: CachedJsonError
}

export interface GetJsonOptions {
  /** How long a value is served without asking. */
  readonly ttlMs: number
  /** After the TTL, how long a failed refresh may fall back to the old value. Default 0 (never). */
  readonly staleIfErrorMs?: number
  readonly headers?: Readonly<Record<string, string>>
  /** Options for the fetch (limits, signal, allowLan, resolver, connector). */
  readonly fetch?: Omit<SafeFetchOptions, "headers" | "method">
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

/**
 * A GET of JSON behind `safeFetch`, cached in memory: served from the cache within the TTL; after it, revalidated
 * with `If-None-Match` when the server gave an ETag (a 304 renews the entry without a body); when the refresh fails,
 * the old value is served for up to `staleIfErrorMs` more. The cache key is the URL.
 */
export const makeCachedJson = (deps: CachedJsonDeps = {}): CachedJson => {
  const cache = deps.cache ?? makeMemoryJsonCache()
  const now = deps.now ?? Date.now
  const fetch = deps.fetch ?? safeFetch
  const getJson = <A>(url: string, options: GetJsonOptions): Effect.Effect<JsonResult<A>, CachedJsonError> =>
    Effect.gen(function* () {
      const entry = cache.get(url)
      const age = entry === undefined ? Infinity : now() - entry.storedAt
      if (entry !== undefined && age >= 0 && age < options.ttlMs) return { value: entry.value as A, source: "cache", ageMs: age } satisfies JsonResult<A>
      const headers: Record<string, string> = { accept: "application/json", ...deps.headers, ...options.headers }
      if (entry?.etag !== undefined) headers["if-none-match"] = entry.etag
      const attempt = Effect.gen(function* () {
        const response = yield* fetch(url, { ...options.fetch, method: "GET", headers })
        if (response.status === 304 && entry !== undefined) {
          cache.set(url, { ...entry, storedAt: now() })
          return { value: entry.value as A, source: "revalidated", ageMs: 0 } satisfies JsonResult<A>
        }
        if (response.status < 200 || response.status > 299) return yield* Effect.fail(new NetHttpStatus({ url, status: response.status }))
        let value: unknown
        try {
          value = JSON.parse(response.text())
        } catch (e) {
          return yield* Effect.fail(new NetBadJson({ url, detail: e instanceof Error ? e.message : String(e) }))
        }
        const etag = response.headers["etag"]
        cache.set(url, { value, ...(etag !== undefined ? { etag } : {}), storedAt: now() })
        return { value: value as A, source: "network", ageMs: 0 } satisfies JsonResult<A>
      })
      return yield* attempt.pipe(
        Effect.catch((error: CachedJsonError) =>
          entry !== undefined && age >= 0 && age < options.ttlMs + (options.staleIfErrorMs ?? 0)
            ? Effect.succeed({ value: entry.value as A, source: "stale", ageMs: age, error } satisfies JsonResult<A>)
            : Effect.fail(error)
        )
      )
    })
  return { getJson }
}
