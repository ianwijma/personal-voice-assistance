import { ServiceKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `WebVideos`: a video search of the web through the household's own SearXNG server (docs/modules/media.md §4.7).
 * Provided by `web-search` (`packages/module-web-search`), from its shared part, beside `WebImages` and under the same
 * condition (its SearXNG address is set and valid); used by `media`, which plays a YouTube result on the asking device. So
 * the server's address, the rule that it may be on the home network and the owner's blocked sites live in one module: the
 * consumer never learns the address and never fetches anything itself.
 *
 * **What it does.** One `search` is one request to SearXNG (`categories=videos`, JSON), with the consumer's safe-search
 * level and language, within the consumer's time limit. It is not counted against web-search's daily cap (SearXNG is the
 * household's own server and free). Nothing of it is kept.
 *
 * **What it answers.** At most `maxResults` (default and ceiling `WEB_VIDEOS_LIMITS.results`) results, in SearXNG's order
 * (best first). The provider has checked the shape of each one and dropped what cannot be used; what is left is still
 * **untrusted outside text** that the consumer cleans and marks as outside text before a model or a person sees any of it
 * (a title is data, never an instruction):
 *
 * - `url`: the video's page (the watch address for YouTube), `http:` or `https:`, at most `WEB_VIDEOS_LIMITS.urlChars`
 *   characters with no space or control character. `site` is its host in lower case without a leading `www.`. A result
 *   without such a page is dropped, and so is one on one of the owner's blocked sites.
 * - `title`: SearXNG's title, at most `WEB_VIDEOS_LIMITS.titleChars` (cut, not cleaned). `author`: the channel or uploader
 *   when SearXNG gives one, at most `authorChars`.
 * - `youtubeId`: the 11-character video id when `url` is a YouTube address (`youtubeVideoId`), else absent.
 * - `lengthSeconds`: the length in whole seconds when SearXNG states one in a form that can be read ("12:34", "1:02:03",
 *   or a number of seconds); absent otherwise (many engines give none).
 * - `thumbnailUrl`: the engine's picture, an absolute `https:` address of at most `urlChars` printable ASCII characters
 *   with no space, quote or backslash, no credentials, no fragment (a protocol-relative one is given as `https:`); absent
 *   when there is none, it is not usable or it is on a blocked site.
 * - `publishedDate`: when it was published, as an ISO 8601 UTC time, when SearXNG gives a date that can be read.
 *
 * With `site: "youtube"` only results with a valid `youtubeId` are answered (SearXNG cannot be asked for "YouTube only"
 * here, so the others are dropped after the answer, before the limit is applied). Embedding is not checked: a video that
 * refuses to play in a page is found out by the page.
 *
 * **Errors.** `WebVideosError.reason`: `timeout`, `unreachable`, `rate-limited` (429), `json-off` (403: JSON is not in the
 * server's `search.formats`), `invalid` (not a search answer), `failed` (anything else, including a query outside its
 * bounds). `detail` is for the log only.
 *
 * **Latency.** One request of at most the given `timeoutMs` (500 to 10,000 ms) and `WEB_VIDEOS_LIMITS.answerBytes`.
 *
 * **When web-search is off, or has no valid SearXNG address**: `host.service(WebVideos)` is `undefined`; the consumer
 * goes on without the web, and does not say so in every answer.
 */
export const WEB_VIDEOS_LIMITS = {
  results: 10,
  urlChars: 2_000,
  titleChars: 300,
  authorChars: 100,
  answerBytes: 512 * 1024,
  queryChars: 200
} as const

export interface WebVideoQuery {
  /** What to search for: 1 to `queryChars` characters of one line. */
  readonly query: string
  /** SearXNG's `safesearch`: 0 off, 1 moderate, 2 strict. */
  readonly safeSearch: 0 | 1 | 2
  /** `HOME_LANGUAGE` (`nl-NL`); absent: SearXNG's own default. */
  readonly language?: string
  /** `"youtube"`: only results that are YouTube videos (with a `youtubeId`). */
  readonly site?: "youtube"
  /** 1 to `WEB_VIDEOS_LIMITS.results`; absent: the ceiling. */
  readonly maxResults?: number
  readonly timeoutMs: number
}

export interface WebVideo {
  readonly title: string
  readonly url: string
  readonly site: string
  readonly youtubeId?: string
  readonly lengthSeconds?: number
  readonly thumbnailUrl?: string
  readonly author?: string
  readonly publishedDate?: string
}

export class WebVideosError extends Data.TaggedError("WebVideosError")<{
  readonly reason: "timeout" | "unreachable" | "rate-limited" | "json-off" | "invalid" | "failed"
  readonly detail: string
}> {}

export interface WebVideosService {
  readonly search: (query: WebVideoQuery) => Effect.Effect<ReadonlyArray<WebVideo>, WebVideosError>
}

export const WebVideos = ServiceKey<WebVideosService>("web-search.videos")

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"])
const YOUTUBE_NOCOOKIE_HOSTS: ReadonlySet<string> = new Set(["youtube-nocookie.com", "www.youtube-nocookie.com"])

/**
 * The video id in a YouTube address, or `undefined`: `youtube.com` (also `www.`, `m.`, `music.`) `/watch?v=ID`,
 * `/embed/ID`, `/shorts/ID`; `youtu.be/ID`; `youtube-nocookie.com/embed/ID`. Only `http:` and `https:` addresses without
 * credentials or a port, on exactly these hosts (a look-alike such as `youtube.com.evil.com` is not YouTube), and an id of
 * exactly 11 characters of `A-Z a-z 0-9 _ -`. Pure.
 */
export const youtubeVideoId = (url: string): string | undefined => {
  if (typeof url !== "string") return undefined
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return undefined
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "" || u.port !== "") return undefined
  const host = u.hostname.toLowerCase()
  const segments = u.pathname.split("/").filter((s) => s !== "")
  let id: string | undefined
  if (host === "youtu.be") {
    if (segments.length === 1) id = segments[0]
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v") ?? undefined
    else if (segments.length === 2 && (segments[0] === "embed" || segments[0] === "shorts")) id = segments[1]
  } else if (YOUTUBE_NOCOOKIE_HOSTS.has(host)) {
    if (segments.length === 2 && segments[0] === "embed") id = segments[1]
  }
  return id !== undefined && YOUTUBE_ID.test(id) ? id : undefined
}
