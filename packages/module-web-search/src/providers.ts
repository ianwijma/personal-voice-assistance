// The search providers: one interface, SearXNG (the owner's own server) and Brave (a key). Plain HTTP through `@pva/net`,
// never an SDK. Everything a provider answers is untrusted text: it is cleaned, cut and bounded here, before anything else
// sees it.
import { contentTypes, fetchOwnerConfiguredLan, type NetRefused, safeFetch, type SafeFetchError, type SafeFetchOptions, type SafeResponse } from "@pva/net"
import { Data, Effect } from "effect"
import { cleanText, HAS_UNWANTED, hostOf, isBlocked, siteOf } from "./clean.ts"

export { cleanText, siteOf } from "./clean.ts"

/** What a net call takes from tests: the resolver and connector (absent: the real ones). */
export type NetDeps = Pick<SafeFetchOptions, "resolver" | "connector">

export type Recency = "day" | "week" | "month" | "year"
export type SafeSearch = "off" | "moderate" | "strict"

/** How many results one search keeps at most. */
export const MAX_RESULTS = 5
/** The bounds of one result. */
export const TITLE_MAX = 100
export const URL_MAX = 300
export const SNIPPET_MAX = 200
export const SITE_MAX = 60
export const PUBLISHED_MAX = 10
/** A provider's answer is read up to this many bytes (a search answer is a few KiB; anything bigger is rubbish). */
export const ANSWER_MAX_BYTES = 256 * 1024

export interface RawResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
  readonly site: string
  /** `YYYY-MM-DD`, or absent. */
  readonly published?: string
}

export interface SearchQuery {
  readonly query: string
  readonly recency?: Recency
  /** A domain the answer is limited to. */
  readonly site?: string
  /** `HOME_LANGUAGE`, e.g. `nl-NL`; `undefined` when it is not a language tag. */
  readonly language?: string
  readonly safeSearch: SafeSearch
  readonly timeoutMs: number
}

export type SearchFailure = "timeout" | "unreachable" | "key-refused" | "rate-limited" | "json-off" | "invalid" | "failed"

/** Why a search failed, in the module's own terms; `detail` is for the log, never spoken and never holds the key. */
export class SearchError extends Data.TaggedError("SearchError")<{ readonly reason: SearchFailure; readonly detail: string }> {}

export interface SearchProvider {
  readonly id: "searxng" | "brave"
  /** A paid provider counts against the monthly budget. */
  readonly paid: boolean
  readonly search: (q: SearchQuery, net: NetDeps) => Effect.Effect<ReadonlyArray<RawResult>, SearchError>
}

// ---------------------------------------------------------------------------------------------------------------------
// Cleaning

const isoDay = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (m === null) return undefined
  const month = Number(m[2])
  const day = Number(m[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

/**
 * Raw items to results: an address that is not a plain http(s) address of at most `URL_MAX` characters is dropped (an address
 * is never cut), so is a blocked domain (`blocked` holds canonical entries, `blockEntry`), so is a second result from a host
 * already shown; at most `MAX_RESULTS` stay.
 */
export const toResults = (items: ReadonlyArray<{ readonly title: unknown; readonly url: unknown; readonly snippet: unknown; readonly published?: unknown }>, blocked: ReadonlyArray<string>): ReadonlyArray<RawResult> => {
  const out: Array<RawResult> = []
  const seen = new Set<string>()
  for (const item of items.slice(0, 50)) {
    const url = typeof item.url === "string" ? item.url.trim() : ""
    if (url === "" || url.length > URL_MAX || HAS_UNWANTED.test(url) || /\s/.test(url)) continue
    // The block list is compared with the canonical host (lower case, IDNA, no terminal dot), as every page request is.
    const host = hostOf(url)
    const site = siteOf(url)
    if (host === undefined || site === undefined || seen.has(site) || isBlocked(host, blocked)) continue
    const title = cleanText(item.title, TITLE_MAX)
    const snippet = cleanText(item.snippet, SNIPPET_MAX)
    if (title === "" && snippet === "") continue
    seen.add(site)
    const published = isoDay(item.published)
    out.push({ title: title === "" ? site : title, url, snippet, site: cleanText(site, SITE_MAX), ...(published !== undefined ? { published } : {}) })
    if (out.length >= MAX_RESULTS) break
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// The network

const failureOf = (e: SafeFetchError): SearchError => {
  switch (e._tag) {
    case "NetTimeout":
      return new SearchError({ reason: "timeout", detail: e.message })
    case "NetTooLarge":
      return new SearchError({ reason: "invalid", detail: "the answer was too large" })
    case "NetRefused": {
      // A JSON answer is the only type accepted: another type is an answer that is not a search answer.
      const refused = e as NetRefused
      return new SearchError({ reason: refused.rule === "content-type" ? "invalid" : "failed", detail: refused.message })
    }
    case "NetAborted":
      return new SearchError({ reason: "failed", detail: "aborted" })
    case "NetFailure":
      return new SearchError({ reason: "unreachable", detail: e.message })
  }
}

const parseJson = (response: SafeResponse): Effect.Effect<unknown, SearchError> =>
  Effect.try({
    try: () => JSON.parse(response.text()) as unknown,
    catch: () => new SearchError({ reason: "invalid", detail: "the answer is not JSON" })
  })

const objectOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : undefined

// ---------------------------------------------------------------------------------------------------------------------
// SearXNG

const SEARX_RANGE: Readonly<Record<Recency, string>> = { day: "day", week: "month", month: "month", year: "year" }
const SEARX_SAFE: Readonly<Record<SafeSearch, string>> = { off: "0", moderate: "1", strict: "2" }

/** `nl-NL` → `nl-NL`; anything that is not a language tag → `all` (SearXNG's own default). */
const searxLanguage = (language: string | undefined): string => (language !== undefined && /^[a-z]{2,3}(-[A-Za-z]{2})?$/.test(language) ? language : "all")

/** The address of the search endpoint of a SearXNG server given by its base address. */
export const searxEndpoint = (baseUrl: string, query: string, params: Readonly<Record<string, string>>): string => {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`
  url.search = ""
  url.hash = ""
  url.searchParams.set("q", query)
  url.searchParams.set("format", "json")
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.href
}

/** SearXNG at an address the owner typed (the owner-configured function: it may be on the LAN, and is never given a model's address). */
export const makeSearxng = (baseUrl: string, blocked: ReadonlyArray<string>): SearchProvider => ({
  id: "searxng",
  paid: false,
  search: (q, net) =>
    Effect.gen(function*() {
      const text = q.site !== undefined ? `${q.query} site:${q.site}` : q.query
      const url = searxEndpoint(baseUrl, text, {
        safesearch: SEARX_SAFE[q.safeSearch],
        language: searxLanguage(q.language),
        ...(q.recency !== undefined ? { time_range: SEARX_RANGE[q.recency] } : {})
      })
      const response = yield* fetchOwnerConfiguredLan(url, { accept: contentTypes.json, maxBytes: ANSWER_MAX_BYTES, timeoutMs: q.timeoutMs, ...net }).pipe(
        Effect.mapError((e) => failureOf(e))
      )
      if (response.status === 403) return yield* new SearchError({ reason: "json-off", detail: "403: JSON output is not enabled in search.formats" })
      if (response.status === 429) return yield* new SearchError({ reason: "rate-limited", detail: "429" })
      if (response.status < 200 || response.status > 299) return yield* new SearchError({ reason: "failed", detail: `status ${response.status}` })
      const body = objectOf(yield* parseJson(response))
      if (body === undefined || !Array.isArray(body.results)) return yield* new SearchError({ reason: "invalid", detail: "no results list" })
      const items = (body.results as ReadonlyArray<unknown>).map((r) => objectOf(r)).filter((r): r is Readonly<Record<string, unknown>> => r !== undefined)
      return toResults(items.map((r) => ({ title: r.title, url: r.url, snippet: r.content, published: r.publishedDate })), blocked)
    })
})

// ---------------------------------------------------------------------------------------------------------------------
// Brave

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search"
const BRAVE_FRESH: Readonly<Record<Recency, string>> = { day: "pd", week: "pw", month: "pm", year: "py" }

/** Brave Search with a key. The key goes in a request header only: never in an address, an error, a log line or a result. */
export const makeBrave = (key: string, blocked: ReadonlyArray<string>, userAgent: string): SearchProvider => ({
  id: "brave",
  paid: true,
  search: (q, net) =>
    Effect.gen(function*() {
      const url = new URL(BRAVE_URL)
      url.searchParams.set("q", q.site !== undefined ? `${q.query} site:${q.site}` : q.query)
      url.searchParams.set("count", "10")
      url.searchParams.set("safesearch", q.safeSearch)
      url.searchParams.set("text_decorations", "false")
      if (q.recency !== undefined) url.searchParams.set("freshness", BRAVE_FRESH[q.recency])
      const lang = q.language?.slice(0, 2).toLowerCase()
      if (lang !== undefined && /^[a-z]{2}$/.test(lang)) url.searchParams.set("search_lang", lang)
      const response = yield* safeFetch(url.href, {
        accept: contentTypes.json,
        maxBytes: ANSWER_MAX_BYTES,
        timeoutMs: q.timeoutMs,
        headers: { "x-subscription-token": key, "user-agent": userAgent },
        ...net
      }).pipe(Effect.mapError((e) => failureOf(e)))
      if (response.status === 401 || response.status === 403 || response.status === 422) return yield* new SearchError({ reason: "key-refused", detail: `status ${response.status}` })
      if (response.status === 429) return yield* new SearchError({ reason: "rate-limited", detail: "429" })
      if (response.status < 200 || response.status > 299) return yield* new SearchError({ reason: "failed", detail: `status ${response.status}` })
      const body = objectOf(yield* parseJson(response))
      if (body === undefined) return yield* new SearchError({ reason: "invalid", detail: "not an object" })
      // No `web` part at all is an answer for a query nothing matched, which Brave sends without one. A `web` part that is
      // there with the wrong type (a list, a string, null) is a malformed answer: a failure of this provider, so the fallback runs.
      if (!Object.hasOwn(body, "web")) return []
      const web = objectOf(body.web)
      if (web === undefined) return yield* new SearchError({ reason: "invalid", detail: "the web part is not an object" })
      if (!Array.isArray(web.results)) return yield* new SearchError({ reason: "invalid", detail: "no results list" })
      const items = (web.results as ReadonlyArray<unknown>).map((r) => objectOf(r)).filter((r): r is Readonly<Record<string, unknown>> => r !== undefined)
      return toResults(items.map((r) => ({ title: r.title, url: r.url, snippet: r.description, published: r.page_age })), blocked)
    })
})
