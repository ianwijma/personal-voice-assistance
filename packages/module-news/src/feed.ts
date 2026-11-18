// Reading one feed: the request (through `safeFetch`, with the feed content-type policy, a time limit and a size limit),
// the parse (feedsmith, loaded when first used so a module that is off costs the app nothing), and the entries cut to
// what the store keeps. Nothing here touches the store.
import { contentTypes, safeFetch, userAgent, type Connector, type Resolver } from "@pva/net"
import { Data, Effect } from "effect"
import { cleanSummary, cleanTitle, stripMarkup } from "./text.ts"

/** What a module that fetches takes from its tests: the resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** The most a feed's answer may be (after decompression). Parsing is synchronous, so this is also the parse's bound. */
export const FEED_MAX_BYTES = 1_024 * 1_024
/** Each request's whole time: redirects and body included. */
export const FEED_TIMEOUT_MS = 6_000
/** The newest entries kept from one answer. */
export const MAX_ENTRIES = 25

export type FeedFailure = "unreachable" | "slow" | "refused" | "too-large" | "not-a-feed" | "http"

export interface Entry {
  /** What identifies the entry in its feed: the guid, else the link. */
  readonly key: string
  /** Cleaned for speech: no markup, emoji, links or "LIVE:" labels. */
  readonly title: string
  readonly summary: string
  readonly url: string
  /** Epoch ms; the time of the fetch when the feed gave none. */
  readonly published: number
}

export type Fetched =
  | { readonly _tag: "notModified" }
  | {
    readonly _tag: "ok"
    readonly title: string
    readonly entries: ReadonlyArray<Entry>
    readonly etag?: string
    readonly lastModified?: string
  }

export class FeedError extends Data.TaggedError("FeedError")<{ readonly reason: FeedFailure; readonly detail: string }> {}

/** A web address a person may subscribe to: http or https, at most 300 characters, one line, no credentials. */
export const parseFeedUrl = (text: string): URL | undefined => {
  const t = text.trim()
  if (t.length === 0 || t.length > 300 || /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(t)) return undefined
  try {
    const u = new URL(t)
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "") return undefined
    u.hash = ""
    return u
  } catch {
    return undefined
  }
}

const textOf = (v: unknown): string => {
  if (typeof v === "string") return v
  if (typeof v === "object" && v !== null && "value" in v && typeof (v as { value: unknown }).value === "string") return (v as { value: string }).value
  return ""
}

const toMs = (v: unknown, fallback: number): number => {
  if (typeof v !== "string" && !(v instanceof Date)) return fallback
  const t = new Date(v).getTime()
  // Not in the future (a feed with a wrong clock must not stay on top), and a sane year.
  return Number.isFinite(t) && t > 0 ? Math.min(t, fallback) : fallback
}

const linkOf = (item: Record<string, unknown>): string => {
  if (typeof item.link === "string") return item.link
  if (typeof item.url === "string") return item.url
  if (Array.isArray(item.links)) {
    const links = item.links as ReadonlyArray<{ href?: unknown; rel?: unknown }>
    const pick = links.find((l) => l.rel === undefined || l.rel === "alternate") ?? links[0]
    if (typeof pick?.href === "string") return pick.href
  }
  return ""
}

/** The entries of any parsed feed (RSS, Atom, RDF, JSON Feed) as ours; those without a usable title or link are dropped. */
const entriesOf = (feed: Record<string, unknown>, base: URL, now: number): ReadonlyArray<Entry> => {
  const raw = (Array.isArray(feed.items) ? feed.items : Array.isArray(feed.entries) ? feed.entries : []) as ReadonlyArray<Record<string, unknown>>
  const out: Array<Entry> = []
  for (const item of raw.slice(0, MAX_ENTRIES * 2)) {
    const title = cleanTitle(textOf(item.title))
    let url = ""
    try {
      const u = new URL(linkOf(item).trim(), base)
      if ((u.protocol === "http:" || u.protocol === "https:") && u.href.length <= 300) url = u.href
    } catch { /* no usable link */ }
    if (title === "" || url === "") continue
    const guid = typeof item.guid === "object" && item.guid !== null ? textOf(item.guid) : typeof item.guid === "string" ? item.guid : typeof item.id === "string" ? item.id : ""
    const summary = cleanSummary(textOf(item.description) || textOf(item.summary) || textOf(item.content_text) || textOf(item.contentText) || "")
    const published = toMs(item.pubDate ?? item.published ?? item.updated ?? item.date_published ?? item.date, now)
    out.push({ key: (guid === "" ? url : guid).slice(0, 300), title, summary, url, published })
  }
  // Newest first, at most MAX_ENTRIES.
  return out.sort((a, b) => b.published - a.published).slice(0, MAX_ENTRIES)
}

const failureOf = (e: unknown): FeedError => {
  const tag = (e as { _tag?: string })._tag
  if (tag === "NetTimeout") return new FeedError({ reason: "slow", detail: "no complete answer in time" })
  if (tag === "NetTooLarge") return new FeedError({ reason: "too-large", detail: "the answer was larger than the limit" })
  if (tag === "NetRefused") return new FeedError({ reason: (e as { rule?: string }).rule === "content-type" ? "not-a-feed" : "refused", detail: String((e as { detail?: string }).detail ?? "refused") })
  return new FeedError({ reason: "unreachable", detail: "no connection" })
}

/**
 * One conditional GET of a feed. `etag` and `lastModified` from the last answer make a feed that has not changed cost
 * one small request (304). Every request is bounded: 6 s, 1 MiB. A page that is not a feed, an answer that is
 * not 2xx or 304 and a feed with no usable entry are failures with a reason, never a half result.
 */
export const fetchFeed = (
  deps: NetDeps,
  contact: string | undefined,
  url: string,
  conditions: { readonly etag?: string | undefined; readonly lastModified?: string | undefined },
  now: number
): Effect.Effect<Fetched, FeedError> =>
  Effect.gen(function*() {
    const base = parseFeedUrl(url)
    if (base === undefined) return yield* Effect.fail(new FeedError({ reason: "refused", detail: "not a web address" }))
    const response = yield* safeFetch(base.href, {
      accept: contentTypes.feed,
      maxBytes: FEED_MAX_BYTES,
      timeoutMs: FEED_TIMEOUT_MS,
      headers: {
        "user-agent": userAgent(contact),
        ...(conditions.etag !== undefined ? { "if-none-match": conditions.etag } : {}),
        ...(conditions.lastModified !== undefined ? { "if-modified-since": conditions.lastModified } : {})
      },
      ...deps
    }).pipe(Effect.mapError(failureOf))
    if (response.status === 304) return { _tag: "notModified" } as const
    if (response.status < 200 || response.status > 299) return yield* Effect.fail(new FeedError({ reason: "http", detail: `status ${response.status}` }))
    const { parseFeed } = yield* Effect.promise(() => import("feedsmith"))
    const parsed = yield* Effect.try({
      try: () => parseFeed(response.text()),
      catch: () => new FeedError({ reason: "not-a-feed", detail: "not RSS, Atom or JSON Feed" })
    })
    const feed = parsed.feed as unknown as Record<string, unknown>
    const entries = entriesOf(feed, new URL(response.url), now)
    if (entries.length === 0 && !(Array.isArray(feed.items) || Array.isArray(feed.entries))) return yield* Effect.fail(new FeedError({ reason: "not-a-feed", detail: "no entries" }))
    const etag = response.headers["etag"]
    const lastModified = response.headers["last-modified"]
    const title = cleanTitle(textOf(feed.title), 60)
    return {
      _tag: "ok",
      title: title === "" ? stripMarkup(new URL(response.url).hostname, 60) : title,
      entries,
      ...(etag !== undefined && etag.length <= 100 && !/[\u0000-\u001f]/.test(etag) ? { etag } : {}),
      ...(lastModified !== undefined && lastModified.length <= 40 && !/[\u0000-\u001f]/.test(lastModified) ? { lastModified } : {})
    } as const
  })
