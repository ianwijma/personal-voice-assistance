// parseFeed.task.ts: one feed's answer read into entries. It runs in a fresh worker thread for each call (`offThread` in
// feed.ts): one pure function, plain data in and out; nothing shared, no network, no store.
//
// Everything slow is here: the parse (feedsmith), the choice of the newest entries across the whole feed, and the
// cleaning of their text. What comes back is bounded: at most `maxEntries` entries of bounded fields.
import { createHash } from "node:crypto"
import { parseFeed } from "feedsmith"
import { cleanSummary, cleanTitle } from "./text.ts"

export interface ParseInput {
  /** The answer's text (at most `FEED_MAX_BYTES`). */
  readonly text: string
  /** The address the answer came from, for relative links. */
  readonly base: string
  /** Epoch ms of the fetch: the time of an entry without one, and the latest time an entry may have. */
  readonly now: number
  readonly maxEntries: number
}

export interface ParsedEntry {
  /** The entry's identity in its feed (its id, else its link, else its title), hashed whole: 64 hex characters. */
  readonly key: string
  /** Cleaned for speech; empty when nothing sayable was left (the reader says a neutral fallback). */
  readonly title: string
  readonly summary: string
  /** The article's address; absent when the entry has no usable link of its own. */
  readonly url?: string
  /** Epoch ms; the time of the fetch when the feed gave none. */
  readonly published: number
}

export type ParseOutput =
  | { readonly ok: true; readonly title: string; readonly entries: ReadonlyArray<ParsedEntry> }
  | { readonly ok: false }

type Rec = Record<string, unknown>

const textOf = (v: unknown): string => {
  if (typeof v === "string") return v
  if (typeof v === "object" && v !== null && typeof (v as Rec).value === "string") return (v as { value: string }).value
  return ""
}

const toMs = (v: unknown, now: number): number | undefined => {
  if (typeof v !== "string" && !(v instanceof Date)) return undefined
  const t = new Date(v).getTime()
  // Not in the future (a feed with a wrong clock must not stay on top), and a sane year.
  return Number.isFinite(t) && t > 0 ? Math.min(t, now) : undefined
}

const web = (raw: string, base: URL): string | undefined => {
  const t = raw.trim()
  if (t === "") return undefined
  try {
    const u = new URL(t, base)
    return (u.protocol === "http:" || u.protocol === "https:") && u.href.length <= 300 ? u.href : undefined
  } catch {
    return undefined
  }
}

/** The entry's own article link: RSS `link`, JSON Feed `url`, Atom's `alternate` link, else a permalink guid. Never the feed's address. */
const linkOf = (item: Rec, base: URL): string | undefined => {
  if (typeof item.link === "string") return web(item.link, base)
  if (typeof item.url === "string") return web(item.url, base)
  if (Array.isArray(item.links)) {
    const alternate = (item.links as ReadonlyArray<Rec>).find((l) => (l.rel === undefined || l.rel === "alternate") && typeof l.href === "string")
    if (alternate !== undefined) return web(alternate.href as string, base)
  }
  const guid = item.guid
  if (typeof guid === "object" && guid !== null && (guid as Rec).isPermaLink !== false && /^https?:\/\//i.test(textOf(guid))) return web(textOf(guid), base)
  return undefined
}

const idOf = (item: Rec): string => {
  const guid = item.guid
  if (typeof guid === "object" && guid !== null) return textOf(guid)
  if (typeof guid === "string") return guid
  if (typeof item.id === "string") return item.id
  return ""
}

/** The summary's source text: a summary or description first, else the full content of each format. */
const summaryOf = (item: Rec): string => {
  const content = item.content
  const encoded = typeof content === "object" && content !== null ? (content as Rec).encoded : undefined
  return (
    textOf(item.description) || textOf(item.summary) || textOf(item.content_text) || textOf(item.contentText) || textOf(item.content_html) ||
    textOf(item.contentHtml) || (typeof encoded === "string" ? encoded : "") || textOf(content) || ""
  )
}

export default (input: ParseInput): ParseOutput => {
  let feed: Rec
  try {
    feed = parseFeed(input.text).feed as unknown as Rec
  } catch {
    return { ok: false }
  }
  const base = new URL(input.base)
  // A feed that parses with no entries is a healthy empty feed (feedsmith leaves the absent list out).
  const raw = (Array.isArray(feed.items) ? feed.items : Array.isArray(feed.entries) ? feed.entries : []) as ReadonlyArray<Rec>
  // Every entry, by its whole identity: two entries with one identity are one (the newer wins). Only times and keys
  // here; the text of the newest `maxEntries` is cleaned below.
  const byKey = new Map<string, { readonly item: Rec; readonly url: string | undefined; readonly published: number }>()
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue
    const url = linkOf(item, base)
    const identity = idOf(item) || url || textOf(item.title)
    if (identity === "") continue
    const key = createHash("sha256").update(identity).digest("hex")
    const published = toMs(item.pubDate ?? item.published ?? item.updated ?? item.date_published ?? item.datePublished ?? item.date_modified ?? item.dc_date ?? item.date, input.now) ?? input.now
    const known = byKey.get(key)
    if (known === undefined || published > known.published) byKey.set(key, { item, url, published })
  }
  // The newest across the whole feed (feeds are not always newest first), at most `maxEntries` that have something to say.
  const sorted = [...byKey.entries()].sort((a, b) => b[1].published - a[1].published)
  const entries: Array<ParsedEntry> = []
  for (const [key, e] of sorted) {
    if (entries.length >= input.maxEntries) break
    const title = cleanTitle(textOf(e.item.title))
    const summary = cleanSummary(summaryOf(e.item))
    if (title === "" && summary === "") continue
    entries.push({ key, title, summary, ...(e.url !== undefined ? { url: e.url } : {}), published: e.published })
  }
  return { ok: true, title: cleanTitle(textOf(feed.title), 60), entries }
}
