import { defineCollection, type Row } from "@pva/core"
import { StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"

/**
 * The calendar module's data (docs/MODULES.md §5; docs/modules/calendar.md, "What it stores"). Everything here is a
 * cache of the configured ICS calendars: the refresh job writes it, the tools read it. Nothing is typed in by a person.
 *
 * **Generations.** Each successful read of a calendar is written as a new generation (its rows carry the calendar's
 * `batch`, `<source id>.<generation>`), and then, in one transaction, made the calendar's current one in its `sources`
 * row, with what it was read from. Readers use only rows of a calendar's current generation, and only while that row's
 * provenance (the link's fingerprint, the owner, the household's zone) still equals the settings; rows of older
 * generations are removed afterwards in bounded steps. So an answer is always of one accepted read per calendar.
 */

/** A Members id, as the privacy rule knows it. */
const PERSON_ID = Schema.String.check(Schema.isMaxLength(40), Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,39}$/))
const INSTANT = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
/** A local date as a number, `YYYYMMDD` (20261118), in the household's zone when the row was written. */
const DAY = Schema.Int.check(Schema.isBetween({ minimum: 19_000_101, maximum: 29_991_231 }))
const COUNT = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const GENERATION = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8_640_000_000_000_000 }))

/** The longest title and place kept (cut in the reading task); a calendar's own name. */
export const TITLE_CHARS = 120
export const PLACE_CHARS = 80
export const NAME_CHARS = 40
/** A generation's batch: `s` and 16 hex digits of the calendar's id, a dot, the generation in base 36. */
const BATCH_CHARS = 40
/** An occurrence's identity: 24 hex digits of a hash of its event's UID and its recurrence id. */
const KEY_CHARS = 24

/**
 * One occurrence of an event, on one local day it touches: an event of three days is three rows, one per `day`, each
 * with the occurrence's whole `start` and `end`, so "what's on Friday" is one indexed range (`[day, start]`). Every day
 * of the kept window an occurrence covers has its row (a trip of four weeks has 28).
 */
export const Occurrence = Schema.Struct({
  /** The calendar's name as the owner typed it (the module's key for a calendar; it is not secret). */
  source: StoredText(NAME_CHARS),
  /** The generation the row belongs to (`batchOf`). */
  batch: StoredText(BATCH_CHARS),
  /** The occurrence's identity: the same on every day row of it, different for any other occurrence or event. */
  key: StoredText(KEY_CHARS),
  day: DAY,
  /** Epoch ms. An all-day event starts at the local midnight of its first day. */
  start: INSTANT,
  /** Epoch ms, exclusive. */
  end: INSTANT,
  allDay: Schema.Boolean,
  title: StoredText(TITLE_CHARS),
  location: Schema.optionalKey(StoredText(PLACE_CHARS)),
  /** Absent: a household calendar's. Present: the calendar is this member's, revealed only by `Privacy.mayReveal`. */
  owner: Schema.optionalKey(PERSON_ID),
  /** It blocks time (not `TRANSP:TRANSPARENT`, not all-day). */
  busy: Schema.Boolean,
  /** It goes on after the last day the generation keeps. */
  beyond: Schema.Boolean
})
export type Occurrence = typeof Occurrence.Type

export const occurrences = defineCollection({
  name: "occurrences",
  scope: "household",
  schema: Occurrence,
  // The worst legal row is under 1,250 characters of JSON (checkModule computes it): a list reads 20 rows.
  maxChars: 1_250,
  indexes: [["day", "start"], ["day", "end"], "start", "batch"]
})

/** The rows one list of `occurrences` reads (`maxListRows`: 25,000 / 1,250). */
export const ROWS_PAGE = 20

/**
 * Why a calendar could not be read at its last refresh (never a URL, never a server's own words):
 * `too-many` and `too-slow` are the reading's own limits (events, occurrences, rows; its time limit); `busy`: too
 * many readings were waiting for a worker (tried again at the next refresh).
 */
export const SourceError = Schema.Literals(["unreachable", "refused", "too-large", "status", "not-calendar", "too-many", "too-slow", "busy", "failed", "owner", "no-link", "store"])
export type SourceError = typeof SourceError.Type

/** How one calendar fared, and which generation of its rows is current, read from what. */
export const SourceState = Schema.Struct({
  name: StoredText(NAME_CHARS),
  triedAt: INSTANT,
  /** When the current generation was last confirmed (read, or "not modified"). */
  okAt: Schema.optionalKey(INSTANT),
  /** Why the last try failed; absent when it succeeded. */
  error: Schema.optionalKey(SourceError),
  /** The current generation: the only one readers use. */
  gen: Schema.optionalKey(GENERATION),
  /** What the current generation was read from: the link's fingerprint (`linkPrint`), the owner, the household's zone. */
  link: Schema.optionalKey(StoredText(16)),
  owner: Schema.optionalKey(StoredText(40)),
  zone: Schema.optionalKey(StoredText(64)),
  /** Events of the file that could not be read and were left out of the current generation. */
  unreadable: Schema.optionalKey(COUNT),
  /** Rows of the current generation. */
  rows: COUNT,
  /** The last day the current generation keeps (`YYYYMMDD`): events going on after it say so. */
  lastDay: Schema.optionalKey(DAY),
  /** The server's `ETag` of the current generation and the day it was read (a conditional request only that day). */
  etag: Schema.optionalKey(StoredText(200)),
  readDay: Schema.optionalKey(DAY),
  /** A generation being written (not yet current), and older ones still to remove: cleaned up by the next refresh. */
  writing: Schema.optionalKey(GENERATION),
  old: Schema.optionalKey(Schema.Array(GENERATION).check(Schema.isMaxLength(8)))
})
export type SourceState = typeof SourceState.Type

export const sources = defineCollection({ name: "sources", scope: "household", schema: SourceState, maxChars: 1_600 })

/** The rows one list of `sources` reads (`maxListRows`: 25,000 / 1,600). */
export const STATES_PAGE = 15
/** At most this many states are read (ten calendars, and those of calendars just taken out of the settings). */
const MAX_STATES = 60

/** Every calendar's state, page by page (`list` is one page of the store's list). */
export const allStates = <E>(list: (q: { readonly limit: number; readonly after?: Row<SourceState> }) => Effect.Effect<ReadonlyArray<Row<SourceState>>, E>) =>
  Effect.gen(function*() {
    const out: Array<Row<SourceState>> = []
    let after: Row<SourceState> | undefined
    while (out.length < MAX_STATES) {
      const page = yield* list({ limit: STATES_PAGE, ...(after !== undefined ? { after } : {}) })
      out.push(...page)
      if (page.length < STATES_PAGE) break
      after = page.at(-1)
    }
    return out
  })

/** A row id from parts that are not secret (a calendar's name, an event's UID, times): hashed, so no text shows in it. */
export const hashId = (prefix: string, ...parts: ReadonlyArray<string | number>): string =>
  `${prefix}-${createHash("sha256").update(parts.map(String).join("\u0000")).digest("hex").slice(0, 32)}`

export const sourceId = (name: string) => hashId("src", name.trim().toLowerCase())

/** The batch of a calendar's generation (indexed: a generation's rows are listed, and removed, by it). */
export const batchOf = (name: string, gen: number) =>
  `s${createHash("sha256").update(name.trim().toLowerCase()).digest("hex").slice(0, 16)}.${gen.toString(36)}`

/**
 * The fingerprint of the address a generation was read from, so a changed address (or private link) is noticed without
 * the address being kept: the first 16 hex digits (64 bits) of SHA-256 over a fixed label and the address. It cannot
 * be turned back into the address (a private link is a long random token), says nothing about it to anyone who reads
 * the row, and is only ever compared with the fingerprint of the address in the settings now: no tool, action, Health
 * issue or log line holds it. The decision to keep it is the lead's (the review's fix round, decision 2).
 */
export const linkPrint = (address: string) => createHash("sha256").update(`pva-calendar-link\u0000${address}`).digest("hex").slice(0, 16)

/** Whose a calendar's rows are, as a source row records it: `household`, or the member's id. */
export const ownerKey = (owner: { readonly kind: "household" } | { readonly kind: "person"; readonly id: string }) => (owner.kind === "household" ? "household" : owner.id)
