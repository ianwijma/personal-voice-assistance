import { Effect } from "effect"
import { NetRefused, type SafeFetchError } from "./Errors.ts"
import { fetchCheckedForHost, type JsonBody, type SafeFetchOptions, type SafeResponse, shownUrl } from "./SafeFetch.ts"

/**
 * `@pva/net/host`: what only the host's own code may use. A module imports `@pva/net` (docs/MODULES.md §12), never this
 * entry; `test/hostEntry.test.ts` fails when a module package's source does.
 */

/** `postFixedPublicJson`'s options: `safeFetch`'s, with a JSON body and its limit (as `fetchOwnerConfiguredLan`'s POST). */
export interface FixedPublicPostOptions extends Omit<SafeFetchOptions, "method"> {
  readonly body: JsonBody
  /** The largest serialised body in bytes, checked before anything is connected. Default 64 KiB, at most 128 KiB. */
  readonly maxRequestBytes?: number
}

/**
 * A POST with a JSON body to **a fixed public API address written in the host's own code** (the app's GitHub issue
 * filing: `https://api.github.com/repos/<repository>/issues`): never an address a model, a page or the owner chose.
 * `https:` only. Every rule of `safeFetch` holds (public addresses only, checked on the address it connects to; port
 * 443, no credentials in the URL, the response types `accept` lists, `maxBytes`, the one `timeoutMs`, interruption),
 * and every rule of `fetchOwnerConfiguredLan`'s POST: the helper serialises `json` and sets its type and length, refuses
 * a body over `maxRequestBytes` before connecting, **sends it once** (every 3xx answer is `NetRefused(post-redirect)`,
 * never retried, another address only when nothing was written), so a POST that failed may or may not have been
 * carried out (`NetFailure.requestSent` says when it was written). No loopback option.
 */
export const postFixedPublicJson = (url: string, options: FixedPublicPostOptions): Effect.Effect<SafeResponse, SafeFetchError> => {
  if (!/^https:\/\//i.test(url)) return Effect.fail(new NetRefused({ rule: "scheme", url: shownUrl(url), detail: "postFixedPublicJson sends to https: addresses only" }))
  return fetchCheckedForHost(url, { ...options, method: "POST" })
}
