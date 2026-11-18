import { type Connector, type ContentTypePolicy, type Resolver, safeFetch, type SafeFetchError } from "@pva/net"
import { Effect, Result } from "effect"
import { expandIcs, type ICAL, ICS_MAX_BYTES, type IcsOccurrence } from "./ics.ts"
import type { SourceError } from "./store.ts"

/**
 * Where a calendar's events come from (docs/MODULES.md §13: the calendar keeps its provider interface inside its
 * package; no other module provides a calendar in this wave). The refresh job asks a provider for one calendar's
 * occurrences in the cache's window and does the rest itself (owners, rows, the store). This version has one provider,
 * ICS over `safeFetch`; CalDAV and Google are later providers of the same interface (docs/modules/calendar.md).
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
  readonly window: CalendarWindow
  /** The validator of the last good read, when a conditional request may be made (only on the day it was read). */
  readonly etag?: string
  /** The User-Agent (the owner's contact only when the owner set one). */
  readonly userAgent: string
}

export type ProviderRead =
  /** The calendar did not change since the read `etag` names. */
  | { readonly kind: "unchanged" }
  | { readonly kind: "read"; readonly occurrences: ReadonlyArray<IcsOccurrence>; readonly cut: boolean; readonly etag?: string }

export interface CalendarProvider {
  readonly id: string
  /** One calendar's occurrences in the window; a failure is a `SourceError` (never the server's own words). */
  readonly read: (request: ProviderRequest, bounds: { readonly titleChars: number; readonly placeChars: number }) => Effect.Effect<ProviderRead, SourceError>
}

/** What the ICS provider takes from its tests: the network that has no network, a shorter time limit. */
export interface IcsDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
  readonly fetchTimeoutMs?: number
}

export const FETCH_TIMEOUT_MS = 15_000

/** What a calendar is served as: `text/calendar`, and the plain types some servers use for it. Never HTML. */
export const calendarTypes: ContentTypePolicy = { name: "calendar", types: ["text/calendar", "application/ics", "text/plain", "application/octet-stream"] }

const errorOf = (e: SafeFetchError): SourceError => {
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
 * ICS links: one `GET` through `safeFetch` (the calendar types only, `ICS_MAX_BYTES`, `FETCH_TIMEOUT_MS`, public
 * addresses only, ports 80 and 443), then `expandIcs`. `ical.js` is loaded on the first read, not when the app starts.
 */
export const makeIcsProvider = (deps: IcsDeps): CalendarProvider => {
  let ical: ICAL | undefined
  const load = Effect.suspend(() => (ical !== undefined ? Effect.succeed(ical) : Effect.map(Effect.promise(() => import("ical.js")), (m) => (ical = m.default))))
  return {
    id: "ics",
    read: (request, bounds) =>
      Effect.gen(function*() {
        const response = yield* Effect.result(safeFetch(request.address, {
          accept: calendarTypes,
          maxBytes: ICS_MAX_BYTES,
          timeoutMs: deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
          headers: { "user-agent": request.userAgent, ...(request.etag !== undefined ? { "if-none-match": request.etag } : {}) },
          ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
          ...(deps.connector !== undefined ? { connector: deps.connector } : {})
        }))
        if (Result.isFailure(response)) return yield* Effect.fail(errorOf(response.failure))
        const r = response.success
        if (r.status === 304 && request.etag !== undefined) return { kind: "unchanged" } as const
        if (r.status < 200 || r.status > 299) return yield* Effect.fail("status" as const)
        const ICAL = yield* load
        const read = yield* Effect.result(expandIcs(ICAL, r.text(), request.window, request.window.zone, bounds))
        if (Result.isFailure(read)) return yield* Effect.fail("not-calendar" as const)
        // Kept only when it is a short, plain validator (it is the server's text).
        const etag = r.headers["etag"]
        const keep = etag !== undefined && etag.length <= 200 && /^[\x20-\x7e]+$/.test(etag)
        return { kind: "read", occurrences: read.success.occurrences, cut: read.success.cut, ...(keep ? { etag } : {}) } as const
      })
  }
}
