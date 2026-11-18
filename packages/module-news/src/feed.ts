// Reading one feed: the request (through `safeFetch`, with the feed content-type policy, a time limit and a size limit,
// one request at a time to one host), then the parse in a worker thread (`offThread`: feedsmith, the newest entries,
// their text cleaned), which returns a bounded answer. Nothing here touches the store.
import { offThread, type OffThreadError, offThreadTask } from "@pva/core"
import { contentTypes, safeFetch, userAgent, type Connector, type Resolver } from "@pva/net"
import { Clock, Data, Effect, Semaphore } from "effect"

/** What a module that fetches takes from its tests: the resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** A parse's limits in its worker (`offThread`). */
export interface ParseLimits {
  readonly timeoutMs: number
  readonly maxMemoryMb: number
  readonly maxResultBytes: number
}

/** What the module takes from its tests: the network, and (to reach them in a test) smaller parse limits. */
export interface NewsDeps extends NetDeps {
  readonly feedParse?: Partial<ParseLimits>
  readonly articleParse?: Partial<ParseLimits>
}

/** The resolver and connector only, for `safeFetch`. */
export const netOf = (deps: NetDeps): NetDeps => ({ ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}), ...(deps.connector !== undefined ? { connector: deps.connector } : {}) })

/** The most a feed's answer may be (after decompression). */
export const FEED_MAX_BYTES = 1_024 * 1_024
/** Each request's whole time: redirects and body included. */
export const FEED_TIMEOUT_MS = 6_000
/** The newest entries kept from one answer, chosen across the whole feed. */
export const MAX_ENTRIES = 25
/** The parse's limits: real time from the call (a worker's start included), its heap, and its answer. */
export const FEED_PARSE: ParseLimits = { timeoutMs: 5_000, maxMemoryMb: 192, maxResultBytes: 128 * 1024 }
/** The longest address kept, as the address is written once it is read (`URL.href`). */
export const MAX_URL_CHARS = 300
/** The least time between two requests of the refresh to one host. */
export const HOST_GAP_MS = 2_000
/** The longest a host's `Retry-After` is honoured; a longer one is cut to this. */
export const MAX_RETRY_AFTER_MS = 6 * 3_600_000

/** Why a feed could not be read. `limit`: its parse went past a limit (time, memory, size); `wait`: the site asked to wait. */
export const FEED_FAILURES = ["unreachable", "slow", "refused", "too-large", "not-a-feed", "http", "limit", "wait"] as const
export type FeedFailure = typeof FEED_FAILURES[number]

export interface Entry {
  /** The entry's whole identity in its feed, hashed. */
  readonly key: string
  /** Cleaned for speech; empty when nothing sayable was left. */
  readonly title: string
  readonly summary: string
  /** Absent: the entry has no article link of its own. */
  readonly url?: string
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

/** The parse, named once: its file beside this one (nothing of it is loaded on the main thread). */
const parseTask = offThreadTask<typeof import("./parseFeed.task.ts").default>(new URL("./parseFeed.task.ts", import.meta.url))

export type AddressCheck = { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly why: "bad" | "long" }

/**
 * A web address a person may subscribe to: http or https, one line, no credentials, and at most `MAX_URL_CHARS` as it
 * is written once read (`é` in a path becomes `%C3%A9`, so the stored address can be longer than the one said).
 */
export const checkFeedUrl = (text: string): AddressCheck => {
  const t = text.trim()
  if (t.length === 0 || t.length > 2_000 || /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/.test(t)) return { ok: false, why: "bad" }
  try {
    const u = new URL(t)
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "") return { ok: false, why: "bad" }
    u.hash = ""
    return u.href.length > MAX_URL_CHARS ? { ok: false, why: "long" } : { ok: true, url: u }
  } catch {
    return { ok: false, why: "bad" }
  }
}

export const parseFeedUrl = (text: string): URL | undefined => {
  const c = checkFeedUrl(text)
  return c.ok ? c.url : undefined
}

// ---------------------------------------------------------------------------------------------------------------------
// One host at a time

/**
 * The module's requests per host, shared by the refresh, subscribing and articles: one request at a time to one host,
 * and a host that answered `Retry-After` is not asked again before then (at most `MAX_RETRY_AFTER_MS`).
 */
export interface HostGate {
  readonly serial: <A, E, R>(host: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** When the host may be asked again, if it asked to wait; `undefined` otherwise. */
  readonly blockedUntil: (host: string, now: number) => number | undefined
  readonly block: (host: string, until: number) => void
}

export const makeHostGate = (): HostGate => {
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>()
  const blocked = new Map<string, number>()
  return {
    serial: (host, effect) =>
      Effect.suspend(() => {
        const entry = locks.get(host) ?? { lock: Semaphore.makeUnsafe(1), users: 0 }
        entry.users++
        locks.set(host, entry)
        return entry.lock.withPermits(1)(effect).pipe(Effect.ensuring(Effect.sync(() => {
          if (--entry.users === 0) locks.delete(host)
        })))
      }),
    blockedUntil: (host, now) => {
      const until = blocked.get(host)
      if (until === undefined) return undefined
      if (until <= now) {
        blocked.delete(host)
        return undefined
      }
      return until
    },
    block: (host, until) => {
      // Bounded: the oldest is forgotten first (a forgotten host is only asked a little early).
      if (blocked.size >= 500 && !blocked.has(host)) blocked.delete(blocked.keys().next().value!)
      blocked.set(host, until)
    }
  }
}

/** A `Retry-After` value (seconds or an HTTP date) as milliseconds from `now`, bounded; `undefined` when absent or unreadable. */
export const retryAfterMs = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined) return undefined
  const t = value.trim()
  const ms = /^\d{1,10}$/.test(t) ? Number(t) * 1_000 : Date.parse(t) - now
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms)) : undefined
}

const failureOf = (e: unknown): FeedError => {
  const tag = (e as { _tag?: string })._tag
  if (tag === "NetTimeout") return new FeedError({ reason: "slow", detail: "no complete answer in time" })
  if (tag === "NetTooLarge") return new FeedError({ reason: "too-large", detail: "the answer was larger than the limit" })
  if (tag === "NetRefused") return new FeedError({ reason: (e as { rule?: string }).rule === "content-type" ? "not-a-feed" : "refused", detail: String((e as { detail?: string }).detail ?? "refused") })
  return new FeedError({ reason: "unreachable", detail: "no connection" })
}

/** A parse that went past a limit is `limit`; one that failed otherwise could not be read as a feed. */
const parseFailure = (e: OffThreadError): FeedError =>
  new FeedError({ reason: e.reason === "timeout" || e.reason === "memory" || e.reason === "too-large" ? "limit" : "not-a-feed", detail: e.message })

/** A host without "www.", as the name of a feed without a title of its own. */
const hostLabel = (u: URL): string => u.hostname.replace(/^www\./, "").slice(0, 60)

/**
 * One conditional GET of a feed. `etag` and `lastModified` from the last answer make a feed that has not changed cost
 * one small request (304). Every request is bounded (6 s, 1 MiB), and so is the parse (`FEED_PARSE`, in a worker). A page
 * that is not a feed and an answer that is not 2xx or 304 are failures with a reason, never a half result; a feed with
 * no entries is a feed.
 */
export const fetchFeed = (
  deps: NewsDeps,
  gate: HostGate,
  contact: string | undefined,
  url: string,
  conditions: { readonly etag?: string | undefined; readonly lastModified?: string | undefined }
): Effect.Effect<Fetched, FeedError> =>
  Effect.gen(function*() {
    const base = parseFeedUrl(url)
    if (base === undefined) return yield* Effect.fail(new FeedError({ reason: "refused", detail: "not a web address" }))
    const asked = yield* Clock.currentTimeMillis
    if (gate.blockedUntil(base.hostname, asked) !== undefined) return yield* Effect.fail(new FeedError({ reason: "wait", detail: "the site asked to wait" }))
    const response = yield* gate.serial(
      base.hostname,
      safeFetch(base.href, {
        accept: contentTypes.feed,
        maxBytes: FEED_MAX_BYTES,
        timeoutMs: FEED_TIMEOUT_MS,
        headers: {
          "user-agent": userAgent(contact),
          ...(conditions.etag !== undefined ? { "if-none-match": conditions.etag } : {}),
          ...(conditions.lastModified !== undefined ? { "if-modified-since": conditions.lastModified } : {})
        },
        ...netOf(deps)
      })
    ).pipe(Effect.mapError(failureOf))
    const now = yield* Clock.currentTimeMillis
    if (response.status === 429 || response.status === 503) {
      const wait = retryAfterMs(response.headers["retry-after"], now)
      if (wait !== undefined && wait > 0) gate.block(base.hostname, now + wait)
      return yield* Effect.fail(new FeedError({ reason: "wait", detail: `status ${response.status}` }))
    }
    if (response.status === 304) return { _tag: "notModified" } as const
    if (response.status < 200 || response.status > 299) return yield* Effect.fail(new FeedError({ reason: "http", detail: `status ${response.status}` }))
    const parsed = yield* offThread(parseTask, { text: response.text(), base: response.url, now, maxEntries: MAX_ENTRIES }, { ...FEED_PARSE, ...deps.feedParse }).pipe(
      Effect.mapError(parseFailure)
    )
    if (!parsed.ok) return yield* Effect.fail(new FeedError({ reason: "not-a-feed", detail: "not RSS, Atom or JSON Feed" }))
    const etag = response.headers["etag"]
    const lastModified = response.headers["last-modified"]
    return {
      _tag: "ok",
      title: parsed.title === "" ? hostLabel(new URL(response.url)) : parsed.title,
      entries: parsed.entries,
      ...(etag !== undefined && etag.length <= 100 && !/[\u0000-\u001f]/.test(etag) ? { etag } : {}),
      ...(lastModified !== undefined && lastModified.length <= 40 && !/[\u0000-\u001f]/.test(lastModified) ? { lastModified } : {})
    } as const
  })
