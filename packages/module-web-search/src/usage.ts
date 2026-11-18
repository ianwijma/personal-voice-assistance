// What the module stores: how many searches were made (the counter the caps read) and a ten-minute cache of search answers.
// Nothing here is about a person: a count has no query, and the cache holds only a hash of the query with public web results.
import { defineCollection, type StoreTx } from "@pva/core"
import { StoredText } from "@pva/module-contracts"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { MAX_RESULTS, PUBLISHED_MAX, SITE_MAX, SNIPPET_MAX, TITLE_MAX, URL_MAX, type RawResult } from "./providers.ts"

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }))

/**
 * One row per month and kind: `<month>:searxng`, `<month>:brave`, `<month>:pages`. The rows of a month are read by their
 * ids (at most three), never by a list. `dayQueries` is the count of `day` (it starts again when the day changes).
 */
export const Usage = Schema.Struct({
  /** `YYYY-MM` in the household's time zone; indexed, so old months can be cleared oldest first. */
  month: StoredText(7),
  provider: Schema.Literals(["searxng", "brave", "pages"]),
  /** Searches (or page reads for `pages`) this month. */
  queries: Count,
  /** `YYYY-MM-DD` of `dayQueries`. */
  day: StoredText(10),
  dayQueries: Count,
  /** Estimated cost this month in millionths of a US dollar (paid providers only). */
  microUsd: Count
})
export type Usage = typeof Usage.Type

export const usage = defineCollection({
  name: "usage",
  scope: "household",
  schema: Usage,
  // The worst legal row is about 230 characters of JSON (checkModule computes it): 300 lets a list read 83 rows.
  maxChars: 300,
  indexes: ["month"]
})

const CachedResult = Schema.Struct({
  title: StoredText(TITLE_MAX),
  url: StoredText(URL_MAX),
  snippet: StoredText(SNIPPET_MAX),
  site: StoredText(SITE_MAX),
  published: Schema.optionalKey(StoredText(PUBLISHED_MAX))
})

/** One cached answer; its row id is `cacheId(...)`: a hash, so the query itself is not stored. */
export const SearchCache = Schema.Struct({
  /** Epoch ms of the search; indexed, so expired answers are removed oldest first. */
  at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 })),
  provider: Schema.Literals(["searxng", "brave"]),
  results: Schema.Array(CachedResult).check(Schema.isMaxLength(MAX_RESULTS))
})
export type SearchCache = typeof SearchCache.Type

export const searchCache = defineCollection({
  name: "search_cache",
  scope: "household",
  schema: SearchCache,
  // The worst legal answer is about 7,300 characters of JSON (checkModule computes it): 7,500 lets a list read 3 rows.
  maxChars: 7_500,
  indexes: ["at"]
})

/** How long an answer is reused. */
export const CACHE_TTL_MS = 10 * 60_000
/** How long the monthly counters are kept. */
export const KEEP_MONTHS = 14

export const cacheId = (parts: ReadonlyArray<string | undefined>): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40)

export const asCached = (results: ReadonlyArray<RawResult>): SearchCache["results"] => results.map((r) => ({ ...r }))

// ---------------------------------------------------------------------------------------------------------------------
// Days and months

/** `YYYY-MM-DD` of `now` in `timeZone` (this machine's when it is not a zone the runtime knows). */
export const dayKey = (now: number, timeZone: string): string => {
  const format = (zone: string | undefined) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now))
  try {
    return format(timeZone)
  } catch {
    return format(undefined)
  }
}

/** The household's zone: `HOME_TIME_ZONE`, and when it is empty, this machine's (as the Home section means). */
export const zoneOf = (home: Readonly<Record<string, unknown>>): string => {
  const zone = home.HOME_TIME_ZONE
  return typeof zone === "string" && zone.trim() !== "" ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone
}

// ---------------------------------------------------------------------------------------------------------------------
// The counter

export type Kind = "searxng" | "brave" | "pages"
export type Reservation = "ok" | "daily" | "monthly"

/**
 * Every write names the module, not the turn: the store records who last wrote a row, and a shared counter or a cached answer
 * must not say which person (or which device) searched last.
 */
export const ACTOR = { kind: "module", moduleId: "web-search" } as const

const rowId = (month: string, kind: Kind) => `${month}:${kind}`

/**
 * Check the caps and count one search, in the transaction `tx` (synchronous, nothing awaits): the day's total over both
 * providers against `dailyCap`, and for a paid provider this month's estimate plus this search against `monthlyCapMicro`.
 * Counted before the call, so a runaway loop meets the cap, and a search that fails still counts (the provider may have billed it).
 */
export const reserve = (
  tx: StoreTx,
  o: { readonly day: string; readonly kind: "searxng" | "brave"; readonly priceMicro: number; readonly dailyCap: number; readonly monthlyCapMicro: number }
): Reservation => {
  const month = o.day.slice(0, 7)
  const rows = tx.collection(usage)
  const dayCount = (kind: Kind) => {
    const r = rows.get(rowId(month, kind))
    return r !== undefined && r.value.day === o.day ? r.value.dayQueries : 0
  }
  if (dayCount("searxng") + dayCount("brave") >= o.dailyCap) return "daily"
  const paid = o.kind === "brave"
  if (paid) {
    const spent = rows.get(rowId(month, "brave"))?.value.microUsd ?? 0
    if (spent + o.priceMicro > o.monthlyCapMicro) return "monthly"
  }
  bump(tx, month, o.day, o.kind, paid ? o.priceMicro : 0)
  return "ok"
}

/** Count one more of `kind` today. */
export const bump = (tx: StoreTx, month: string, day: string, kind: Kind, microUsd: number): void => {
  const rows = tx.collection(usage)
  const id = rowId(month, kind)
  const existing = rows.get(id)
  if (existing === undefined) {
    rows.insert({ month, provider: kind, queries: 1, day, dayQueries: 1, microUsd }, { id, actor: ACTOR })
    return
  }
  rows.update(
    id,
    (v) => ({
      ...v,
      queries: Math.min(1_000_000_000, v.queries + 1),
      day,
      dayQueries: Math.min(1_000_000_000, (v.day === day ? v.dayQueries : 0) + 1),
      microUsd: Math.min(1_000_000_000, v.microUsd + microUsd)
    }),
    { actor: ACTOR }
  )
}

export interface UsageSummary {
  readonly today: number
  readonly month: number
  readonly pagesMonth: number
  readonly microUsd: number
}

/** The counts read by id (three rows). */
export const summarize = (tx: StoreTx, day: string): UsageSummary => {
  const month = day.slice(0, 7)
  const rows = tx.collection(usage)
  let today = 0
  let total = 0
  let micro = 0
  for (const kind of ["searxng", "brave"] as const) {
    const r = rows.get(rowId(month, kind))
    if (r === undefined) continue
    total += r.value.queries
    micro += r.value.microUsd
    if (r.value.day === day) today += r.value.dayQueries
  }
  return { today, month: total, pagesMonth: rows.get(rowId(month, "pages"))?.value.queries ?? 0, microUsd: micro }
}
