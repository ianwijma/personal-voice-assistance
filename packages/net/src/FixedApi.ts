import { Effect } from "effect"
import { classifyAddress } from "./Address.ts"
import { NetRefused, type SafeFetchError } from "./Errors.ts"
import { fetchCheckedFixed, type SafeFetchOptions, type SafeResponse, shownUrl } from "./SafeFetch.ts"

/** At most this many hosts in one `makeFixedApi`. */
export const maxFixedApiHosts = 8

export interface FixedApiOptions {
  /** The DNS names this API may be called on, written in the module's own code (`"api.spotify.com"`). Exact names, any case. */
  readonly hosts: ReadonlyArray<string>
}

/** One call: `safeFetch`'s options, a method, and at most one body (`json` or `form`; only PUT, POST and DELETE take one). */
export interface FixedApiCall extends Omit<SafeFetchOptions, "method"> {
  readonly method: "GET" | "PUT" | "POST" | "DELETE"
  /** Serialised by the helper (`JSON.stringify`), sent as `application/json` with its length. */
  readonly json?: unknown
  /** Sent as `application/x-www-form-urlencoded` with its length: names and values are percent-encoded by the helper. */
  readonly form?: Readonly<Record<string, string>>
  /** The largest serialised body in bytes, checked before anything is connected. Default 64 KiB, at most 128 KiB. */
  readonly maxRequestBytes?: number
}

export interface FixedApi {
  /**
   * A call to `url`, whose host must be one of the API's hosts (rule `host-list` otherwise, on the first hop and in every redirect).
   * `https:` only, port 443, every other rule of `safeFetch` (public addresses checked on the address it connects to, no credentials
   * in the URL, `accept`, `maxBytes`, the one `timeoutMs`, interruption). `Authorization` and other headers `safeFetch` allows may be
   * given; the helper owns `Content-Type` and `Content-Length`. A PUT, POST or DELETE with no body is sent with `Content-Length: 0`.
   * **A PUT, POST or DELETE is sent once, to one server**: every 3xx answer is `NetRefused(post-redirect)`, it is never retried, and
   * it moves to the host's next address only when nothing was written; one that failed may or may not have been carried out
   * (`NetFailure.requestSent`). A GET follows redirects only to listed hosts, and drops the credentials when the origin changes.
   * A non-2xx answer is returned like `safeFetch`'s (its body only when its type is accepted); 204 has an empty body.
   */
  readonly call: (url: string, options: FixedApiCall) => Effect.Effect<SafeResponse, SafeFetchError>
}

const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/**
 * A fixed public API: calls to `https:` hosts named in the module's own code (`makeFixedApi({ hosts: ["api.spotify.com",
 * "accounts.spotify.com"] })`), never to an address a model, a page or the owner chose. Throws at construction when `hosts` is empty,
 * has more than `maxFixedApiHosts`, or holds anything but a plain DNS name (an IP literal, a name without a dot, a wildcard, a port).
 * The match is exact (no suffix matching), without case.
 */
export const makeFixedApi = (options: FixedApiOptions): FixedApi => {
  const given = options?.hosts
  if (!Array.isArray(given) || given.length === 0) throw new TypeError("makeFixedApi needs at least one host")
  if (given.length > maxFixedApiHosts) throw new TypeError(`makeFixedApi takes at most ${maxFixedApiHosts} hosts`)
  const hosts = new Set<string>()
  for (const host of given) {
    const lower = typeof host === "string" ? host.toLowerCase() : ""
    if (!hostPattern.test(lower) || classifyAddress(lower) !== undefined) throw new TypeError("makeFixedApi hosts are plain DNS names such as \"api.example.org\"")
    hosts.add(lower)
  }
  const rules = { hosts }
  return {
    call: (url, call) => {
      const shown = shownUrl(url)
      if (typeof url !== "string") return Effect.fail(new NetRefused({ rule: "scheme", url: shown, detail: "A fixed API is called with an https: address as text" }))
      const { json, form, ...rest } = call
      if (json !== undefined && form !== undefined) return Effect.fail(new NetRefused({ rule: "body", url: shown, detail: "A body is { json } or { form }, not both" }))
      if (call.method === "GET" && (json !== undefined || form !== undefined)) return Effect.fail(new NetRefused({ rule: "body", url: shown, detail: "A GET has no body" }))
      const body = json !== undefined ? { json } : form !== undefined ? { form } : undefined
      return fetchCheckedFixed(url, { ...rest, ...(body === undefined ? {} : { body }) }, rules)
    }
  }
}
