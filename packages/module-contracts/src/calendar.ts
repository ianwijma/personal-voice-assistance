import { ContributionKey } from "@pva/core"
import { Data, type Effect } from "effect"

/**
 * `CalendarProviders`: where calendar events come from (docs/MODULES-PLAN.md §5.2 and §5.1 row 12;
 * docs/research/modules/calendar.md §4–§6, §13). A **contribution**: any number of modules contribute providers; the
 * calendar module collects them (`host.contributions(CalendarProviders)`) and is the only consumer. Contributed by
 * `calendar` itself (its ICS and CalDAV providers, whose sources are in its own settings) and later by `google`.
 *
 * **What a provider does.** It names its sources (one calendar each: "Family", "Sam's work"), reads a window of one
 * source's events with every repeating event expanded into its occurrences, and, for a writable source, adds a single
 * event and removes one it added (the calendar module's undo). It does not cache, rank, word or filter anything: the
 * calendar module keeps the cache (refreshed by its job), answers the tools, and decides what may be said where.
 *
 * **Owners and privacy.** Every source has an owner: the household, or one person (`{ person }`, a Members id). Every
 * event a provider returns carries its source's owner, unchanged. The provider never decides who may hear an event;
 * the calendar module asks `Privacy.mayReveal(owner, device)` at the moment it reveals one, on the device that will
 * speak or show it, and reduces a personal event on a shared device that is not its owner's ("Sam: busy 12:30 to
 * 13:30") or leaves it out (§2 row 8). A provider is called outside any turn (the refresh job), so it never reads
 * `CurrentTurn`.
 *
 * **Untrusted text.** Titles, locations and descriptions come from outside (an invitation can carry instructions):
 * the provider cuts them to the bounds below and the calendar module presents them as data.
 *
 * **Repeating events.** `repeats` says an occurrence belongs to a series. `add` never makes a series in this stack
 * (§2 row 6: a repeating event cannot be added by voice), and `remove` takes only an event this provider added
 * (`eventRef` from `add`), never a series.
 *
 * **Bounds.** A window at most `CALENDAR_LIMITS.windowDays` long; at most `CALENDAR_LIMITS.events` occurrences a call
 * (the earliest; `cut` says when there were more); a provider at most `CALENDAR_LIMITS.sources` sources; `title`,
 * `location` at most `CALENDAR_LIMITS.titleChars`, `description` at most `CALENDAR_LIMITS.descriptionChars`, one line
 * each. Each call answers within `CALENDAR_LIMITS.callTimeoutMs` or fails `timeout` (the calendar module also applies
 * the limit). Times: an event is at instants (`{ at }`, epoch ms) or on dates (`{ date }`, all-day, never midnight
 * instants).
 *
 * **Ids.** A provider's `id` is `/^[a-z][a-z0-9-]{0,39}$/` and unique among providers ("ics", "caldav", "google"); a
 * source's id begins with its provider's id and a colon ("caldav:family"), at most 100 of `[A-Za-z0-9_.:-]`.
 *
 * **When a contributing module is off or stops**, its providers are simply not in the list (inside a turn the list
 * holds only the contributions of modules the turn's assistant has on); a call in progress may fail or die with
 * `ModuleStopped`: the calendar module keeps that source's last cache and marks it stale.
 */
export const CALENDAR_LIMITS = {
  windowDays: 62,
  events: 500,
  sources: 50,
  titleChars: 200,
  descriptionChars: 200,
  callTimeoutMs: 10_000
} as const

/** Whose a calendar is: the household's, or one person's. */
export type CalendarOwner = "household" | { readonly person: string }

export interface CalendarSource {
  readonly id: string
  /** "Family", "Sam's work". */
  readonly label: string
  readonly owner: CalendarOwner
  readonly writable: boolean
}

/** An instant (epoch ms) or a date in the calendar's own day ("2026-11-18"), for all-day events. */
export type EventTime = { readonly at: number } | { readonly date: string }

export interface CalendarEvent {
  readonly sourceId: string
  readonly uid: string
  /** For an occurrence of a series: which one (its original start, as the source gives it). */
  readonly recurrenceId?: string
  readonly title: string
  readonly start: EventTime
  readonly end: EventTime
  readonly location?: string
  readonly description?: string
  readonly status: "confirmed" | "tentative" | "cancelled"
  readonly owner: CalendarOwner
  readonly repeats: boolean
}

export interface EventWindow {
  /** Epoch ms, inclusive. */
  readonly from: number
  /** Epoch ms, exclusive; at most `windowDays` after `from`. */
  readonly to: number
}

export interface EventsRead {
  readonly events: ReadonlyArray<CalendarEvent>
  /** More occurrences were in the window than `CALENDAR_LIMITS.events`. */
  readonly cut: boolean
}

export interface NewEvent {
  readonly title: string
  readonly start: EventTime
  readonly end: EventTime
  readonly location?: string
}

/** A refusal or failure; `message` is one sentence that can be spoken, never a password or a private URL. */
export class CalendarError extends Data.TaggedError("CalendarError")<{
  /**
   * `unknown_source`, `read_only` (add to a source that is not writable), `invalid` (out of bounds), `unreachable`,
   * `unauthorized` (the source refused its credentials), `timeout`, `failed`.
   */
  readonly reason: "unknown_source" | "read_only" | "invalid" | "unreachable" | "unauthorized" | "timeout" | "failed"
  readonly message: string
}> {}

export interface CalendarProvider {
  readonly id: string
  /** For the owner: "ICS link", "CalDAV". */
  readonly label: string
  readonly sources: () => Effect.Effect<ReadonlyArray<CalendarSource>, CalendarError>
  readonly events: (sourceId: string, window: EventWindow) => Effect.Effect<EventsRead, CalendarError>
  /** Only providers with writable sources have it. Adds one single event; answers the reference `remove` takes. */
  readonly add?: (sourceId: string, event: NewEvent) => Effect.Effect<{ readonly eventRef: string; readonly event: CalendarEvent }, CalendarError>
  /** Remove an event this provider added (undo). `false`: it was not there any more. */
  readonly remove?: (sourceId: string, eventRef: string) => Effect.Effect<boolean, CalendarError>
}

export const CalendarProviders = ContributionKey<CalendarProvider>("calendar.providers")
