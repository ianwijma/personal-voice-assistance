import { offThread, type OffThreadError, type OffThreadTask, offThreadTask } from "@pva/core"
import { type Connector, type ContentTypePolicy, type Resolver, safeFetch, type SafeFetchError } from "@pva/net"
import { Effect, Result } from "effect"
import { readAnswer, type TaskInput, taskInput } from "./answer.ts"
import type { ExpandLimits, Occ } from "./expand.ts"
import { PLACE_CHARS, type SourceError, TITLE_CHARS } from "./store.ts"

/**
 * Where a calendar's events come from (docs/MODULES.md §13: the calendar keeps its provider interface inside its
 * package; no other module provides a calendar in this wave). The refresh job asks a provider for one calendar's
 * occurrences in the cache's window and does the rest itself (owners, generations, the store). This version has one
 * provider, ICS over `safeFetch`; CalDAV and Google are later providers of the same interface (docs/modules/calendar.md).
 */

export interface CalendarWindow {
  /** Epoch ms: occurrences that end at or before it are left out. */
  readonly from: number
  /** Epoch ms: occurrences that start at or after it are left out. */
  readonly to: number
  /** The household's zone (floating times and all-day events are in it). */
  readonly zone: string
}

export interface ProviderRequest {
  /** The address to read (from the settings, or a private link from the vault): never logged, stored or returned. */
  readonly address: string
  /** Lower-case text nothing read may contain (the private link and its secret parts: `secretPartsOf`). */
  readonly forbidden: ReadonlyArray<string>
  readonly window: CalendarWindow
  /** The validator of the current generation, when a conditional request may be made (same link, owner, zone, day). */
  readonly etag?: string
  /** The User-Agent (the owner's contact only when the owner set one). */
  readonly userAgent: string
}

export type ProviderRead =
  /** The calendar did not change since the read `etag` names. */
  | { readonly kind: "unchanged" }
  /** Every occurrence in the window, complete but for `unreadable` events left out. */
  | { readonly kind: "read"; readonly occurrences: ReadonlyArray<Occ>; readonly unreadable: number; readonly etag?: string }

export interface CalendarProvider {
  readonly id: string
  /** One calendar's occurrences in the window; a failure is a `SourceError` (never the server's own words). */
  readonly read: (request: ProviderRequest) => Effect.Effect<ProviderRead, SourceError>
}

/** What the ICS provider takes from its tests: the network that has no network, shorter limits. */
export interface IcsDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
  readonly fetchTimeoutMs?: number
  /** The reading task's time limit (real time). */
  readonly readTimeoutMs?: number
  /** The reading task's input limit (tests: a refusal with `input`). */
  readonly maxInputBytes?: number
  /** Another reading task (tests: an answer the main thread cannot read). */
  readonly readTask?: OffThreadTask<TaskInput, string>
}

export const ICS_MAX_BYTES = 1024 * 1024
export const FETCH_TIMEOUT_MS = 15_000
/** The reading task's limits: a few seconds of real time, its own heap, a bounded answer. */
export const READ_TIMEOUT_MS = 5_000
const READ_MEMORY_MB = 256
/** The answer is one string (`answer.ts`), so it may be larger than a structure's 128 KiB: at most 4 MiB. */
const READ_RESULT_BYTES = 4 * 1024 * 1024

/** Events a file may have, occurrences a calendar may keep, rows they may make, steps of one series. */
export const LIMITS: ExpandLimits = { events: 5_000, occurrences: 3_000, rows: 6_000, seriesSteps: 200_000, titleChars: TITLE_CHARS, placeChars: PLACE_CHARS }

/** What a calendar is served as: `text/calendar`, and the plain types some servers use for it. Never HTML. */
export const calendarTypes: ContentTypePolicy = { name: "calendar", types: ["text/calendar", "application/ics", "text/plain", "application/octet-stream"] }

/** The reading task, named once (nothing of it is loaded on the main thread). */
const readIcs = offThreadTask<typeof import("./ics.task.ts").default>(new URL("./ics.task.ts", import.meta.url))

const fetchError = (e: SafeFetchError): SourceError => {
  switch (e._tag) {
    case "NetRefused":
      return e.rule === "content-type" ? "not-calendar" : "refused"
    case "NetTooLarge":
      return "too-large"
    default:
      return "unreachable"
  }
}

/**
 * Every reason of the helper as one of the module's reasons; any other (a reason added later) is `failed`. `busy`
 * (too many calls waiting) is a failed refresh like any other, tried again at the next one.
 */
const readError = (e: OffThreadError): SourceError => {
  switch (e.reason) {
    case "timeout":
      return "too-slow"
    case "memory":
      return "too-large"
    case "too-large":
      return "too-many"
    case "busy":
      return "busy"
    default:
      return "failed"
  }
}

/** Whether a server's text holds the private link or a secret part of it (lower-cased and decoded). */
const holdsSecret = (text: string, forbidden: ReadonlyArray<string>) => {
  if (forbidden.length === 0) return false
  let decoded = text
  try {
    decoded = decodeURIComponent(text)
  } catch {
    decoded = text
  }
  const forms = [text.toLowerCase(), decoded.toLowerCase()]
  return forms.some((f) => forbidden.some((x) => f.includes(x)))
}

/**
 * ICS links: one `GET` through `safeFetch` (the calendar types only, `ICS_MAX_BYTES`, `FETCH_TIMEOUT_MS`, public
 * addresses only, ports 80 and 443), then the reading task off the main thread (`ics.task.ts`, `READ_TIMEOUT_MS`).
 */
export const makeIcsProvider = (deps: IcsDeps): CalendarProvider => ({
  id: "ics",
  read: (request) =>
    Effect.gen(function*() {
      const response = yield* Effect.result(safeFetch(request.address, {
        accept: calendarTypes,
        maxBytes: ICS_MAX_BYTES,
        timeoutMs: deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
        headers: { "user-agent": request.userAgent, ...(request.etag !== undefined ? { "if-none-match": request.etag } : {}) },
        ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
        ...(deps.connector !== undefined ? { connector: deps.connector } : {})
      }))
      if (Result.isFailure(response)) return yield* Effect.fail(fetchError(response.failure))
      const r = response.success
      if (r.status === 304 && request.etag !== undefined) return { kind: "unchanged" } as const
      // A server's error page is never read: its status is the reason.
      if (r.status < 200 || r.status > 299) return yield* Effect.fail("status" as const)
      const answer = yield* offThread(deps.readTask ?? readIcs, taskInput({
        text: r.text(),
        from: request.window.from,
        to: request.window.to,
        zone: request.window.zone,
        forbidden: request.forbidden,
        limits: LIMITS
      }), {
        timeoutMs: deps.readTimeoutMs ?? READ_TIMEOUT_MS,
        maxMemoryMb: READ_MEMORY_MB,
        maxResultBytes: READ_RESULT_BYTES,
        ...(deps.maxInputBytes !== undefined ? { maxInputBytes: deps.maxInputBytes } : {})
      }).pipe(
        Effect.mapError(readError),
        // No reason of the helper escapes as a defect: a broken call is a failed refresh, which says so on Health.
        Effect.catchDefect(() => Effect.fail("failed" as const))
      )
      // Read in batches with a real yield between them; a line it cannot read fails the whole read.
      const read = yield* readAnswer(answer, LIMITS).pipe(Effect.mapError(() => "failed" as const))
      if (!read.ok) return yield* Effect.fail(read.reason)
      // Kept only when it is a short, plain validator that holds nothing of a private link (it is the server's text).
      const etag = r.headers["etag"]
      const keep = etag !== undefined && etag.length <= 200 && /^[\x20-\x7e]+$/.test(etag) && !holdsSecret(etag, request.forbidden)
      return { kind: "read", occurrences: read.occurrences, unreadable: read.unreadable, ...(keep ? { etag } : {}) } as const
    })
})
