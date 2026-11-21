import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `WebImages`: an image search of the web through the household's own SearXNG server (issue #150). Provided by
 * `web-search` (`packages/module-web-search`), from its shared part, while its SearXNG address is set and valid; used by
 * `images`, which shows one of the pictures. So the server's address, the rule that it may be on the home network and
 * the owner's blocked sites live in one module: the consumer never learns the address and never fetches anything itself.
 *
 * **What it does.** One `search` is one request to SearXNG (`categories=images`, JSON), with the consumer's safe-search
 * level and language, within the consumer's time limit. It is not counted against web-search's daily cap (SearXNG is
 * the household's own server and free). Nothing of it is kept.
 *
 * **What it answers.** At most `WEB_IMAGES_LIMITS.results` results, in SearXNG's order (best first). The provider has
 * checked the shape of each one and dropped what cannot be used; what is left is still **untrusted outside text** that the
 * consumer cleans and marks as outside text before a model or a person sees any of it:
 *
 * - `imageUrl`: the picture itself, an absolute `https:` address of at most `WEB_IMAGES_LIMITS.urlChars` printable ASCII
 *   characters with no space, quote or backslash, no credentials, no fragment; a protocol-relative address (`//host/…`) is
 *   given as `https:`. A result without such an address is dropped.
 * - `thumbnailUrl`: the search engine's own small copy (Bing, Qwant…), under the same rules; absent when there is none
 *   or it is not one (SearXNG sometimes gives a `data:` address).
 * - `pageUrl`: the page the picture is on, `http:` or `https:`, at most `urlChars`; `site` is that page's host in lower
 *   case without a leading `www.` (what a credit names). A result without a page is dropped.
 * - `title`: SearXNG's title for it, at most `WEB_IMAGES_LIMITS.titleChars` (cut, not cleaned). `format`: its stated
 *   format in lower case ("jpeg", "png", "svg+xml"…) at most 20 characters, when SearXNG gives one.
 * - A result whose page, picture or thumbnail is on one of the owner's blocked sites does not have that address: a blocked
 *   page or picture drops the result, a blocked thumbnail is left out.
 *
 * The addresses are not fetched by the provider: the server's media route fetches the one the consumer shows (public
 * addresses only, its own type and size limits). An empty list is an answer: nothing matched.
 *
 * **Errors.** `WebImagesError.reason`: `timeout`, `unreachable`, `rate-limited` (429), `json-off` (403: JSON is not in the
 * server's `search.formats`), `invalid` (not a search answer), `failed` (anything else). `detail` is for the log only.
 *
 * **Latency.** One request of at most the given `timeoutMs` (500 to 10,000 ms) and `WEB_IMAGES_LIMITS.answerBytes`.
 *
 * **When web-search is off, or has no valid SearXNG address**: `host.service(WebImages)` is `undefined`; the consumer
 * goes on without the web, and does not say so in every answer.
 */
export const WEB_IMAGES_LIMITS = {
  results: 10,
  urlChars: 2_000,
  titleChars: 300,
  answerBytes: 512 * 1024,
  queryChars: 200
} as const

export interface WebImageQuery {
  /** What to search for: 1 to `queryChars` characters of one line. */
  readonly query: string
  /** SearXNG's `safesearch`: 0 off, 1 moderate, 2 strict. */
  readonly safeSearch: 0 | 1 | 2
  /** `HOME_LANGUAGE` (`nl-NL`); absent: SearXNG's own default. */
  readonly language?: string
  readonly timeoutMs: number
}

export interface WebImage {
  readonly imageUrl: string
  readonly thumbnailUrl?: string
  readonly pageUrl: string
  readonly site: string
  readonly title: string
  readonly format?: string
}

export class WebImagesError extends Data.TaggedError("WebImagesError")<{
  readonly reason: "timeout" | "unreachable" | "rate-limited" | "json-off" | "invalid" | "failed"
  readonly detail: string
}> {}

export interface WebImagesService {
  readonly search: (query: WebImageQuery) => Effect.Effect<ReadonlyArray<WebImage>, WebImagesError>
}

export const WebImages = ServiceKey<WebImagesService>("web-search.images")
