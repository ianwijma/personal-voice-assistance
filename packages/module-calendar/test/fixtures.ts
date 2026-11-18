// ICS files and a started module for the calendar tests: no test reaches the network (`makeOfflineNet`).
import { makeOfflineNet, type OfflineFixtures, startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { calendarModuleWith, type CalendarDeps } from "../src/index.ts"

export interface Ev {
  readonly uid: string
  readonly summary?: string
  /** `20261118T093000` (with `tz`, or `Z` at the end for UTC), or `20261118` for an all-day event. */
  readonly start: string
  readonly end?: string
  readonly tz?: string
  readonly rrule?: string
  readonly exdate?: string
  readonly recurrenceId?: string
  readonly location?: string
  readonly transp?: "OPAQUE" | "TRANSPARENT"
  readonly status?: string
  readonly extra?: ReadonlyArray<string>
}

const dt = (name: string, value: string, tz: string | undefined) =>
  value.length === 8 ? `${name};VALUE=DATE:${value}` : tz !== undefined ? `${name};TZID=${tz}:${value}` : `${name}:${value}`

export const vevent = (e: Ev): string =>
  [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    dt("DTSTART", e.start, e.tz),
    ...(e.end !== undefined ? [dt("DTEND", e.end, e.tz)] : []),
    ...(e.summary !== undefined ? [`SUMMARY:${e.summary}`] : []),
    ...(e.location !== undefined ? [`LOCATION:${e.location}`] : []),
    ...(e.rrule !== undefined ? [`RRULE:${e.rrule}`] : []),
    ...(e.exdate !== undefined ? [dt("EXDATE", e.exdate, e.tz)] : []),
    ...(e.recurrenceId !== undefined ? [dt("RECURRENCE-ID", e.recurrenceId, e.tz)] : []),
    ...(e.transp !== undefined ? [`TRANSP:${e.transp}`] : []),
    ...(e.status !== undefined ? [`STATUS:${e.status}`] : []),
    ...(e.extra ?? []),
    "END:VEVENT"
  ].join("\r\n")

export const ics = (events: ReadonlyArray<Ev>, head: ReadonlyArray<string> = []): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...head, ...events.map(vevent), "END:VCALENDAR", ""].join("\r\n")

export const served = (body: string, headers: Readonly<Record<string, string>> = {}) => ({ body, headers: { "content-type": "text/calendar; charset=utf-8", ...headers } })

/** Amsterdam, as the default test household; the test clock starts on Wednesday 18 November 2026, 10:00 there. */
export const AMS = "Europe/Amsterdam"

/** The family calendar of most tests: today, tomorrow, and a weekly swim. */
export const FAMILY = ics([
  { uid: "standup", summary: "Standup", start: "20261118T093000", end: "20261118T094500", tz: AMS },
  { uid: "lunch", summary: "Lunch with Marloes", start: "20261118T123000", end: "20261118T133000", tz: AMS, location: "Café de Zon" },
  { uid: "swim", summary: "Swimming lesson", start: "20261118T160000", end: "20261118T170000", tz: AMS, rrule: "FREQ=WEEKLY;COUNT=10" },
  { uid: "bins", summary: "Bins out", start: "20261119", end: "20261120" }
])

export const SAM = ics([
  { uid: "dentist", summary: "Dentist", start: "20261119T143000", end: "20261119T150000", tz: AMS, location: "Tandartspraktijk" },
  { uid: "gym", summary: "Gym", start: "20261118T190000", end: "20261118T200000", tz: AMS }
])

export const ROBIN = ics([
  { uid: "review", summary: "Divorce lawyer", start: "20261118T140000", end: "20261118T150000", tz: AMS },
  { uid: "trip", summary: "Trip to Paris", start: "20261121", end: "20261124" }
])

export const calendar = (name: string, url: string, owner = "") => ({ name, link: "address", url, owner })

/**
 * Wait until no refresh is running: a large calendar's refresh goes on in steps past what `advance` waits for, so the
 * test lets real time pass (a few milliseconds at a time, at most two seconds) until its job has finished.
 */
export const refreshed = (kit: { readonly jobs: Effect.Effect<ReadonlyArray<{ readonly state: string }>>; readonly advance: (ms: number) => Effect.Effect<void> }) =>
  Effect.gen(function*() {
    for (let i = 0; i < 400; i++) {
      if (!(yield* kit.jobs).some((j) => j.state === "running")) return
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      yield* kit.advance(0)
    }
    return yield* Effect.die(new Error("the refresh did not finish"))
  })

/** The module on the test network, its refresh run once (the run at start), with `settings` and `secrets`. */
export const startCalendar = (
  fixtures: OfflineFixtures,
  options: { readonly settings?: Readonly<Record<string, unknown>>; readonly secrets?: Readonly<Record<string, string>>; readonly deps?: CalendarDeps; readonly household?: TestHouseholdInput; readonly startAt?: number } = {}
) =>
  Effect.gen(function*() {
    const net = makeOfflineNet(fixtures)
    const definition = calendarModuleWith({ resolver: net.resolver, connector: net.connector, ...options.deps })
    const kit = yield* startTestModule(definition, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
      ...(options.household !== undefined ? { household: options.household } : {}),
      ...(options.startAt !== undefined ? { startAt: options.startAt } : {})
    })
    // The run at start is due now.
    yield* kit.advance(0)
    yield* refreshed(kit)
    return { kit, net, definition }
  })

export const familyOnly = {
  settings: { calendars: [calendar("Family", "https://cal.example.org/family.ics")] }
}

export const everyone = {
  settings: {
    calendars: [
      calendar("Family", "https://cal.example.org/family.ics"),
      calendar("Sam's", "https://cal.example.org/sam.ics", "Sam"),
      calendar("Robin's work", "https://cal.example.org/robin.ics", "p-robin")
    ]
  }
}

export const allFixtures: OfflineFixtures = {
  "https://cal.example.org/family.ics": served(FAMILY),
  "https://cal.example.org/sam.ics": served(SAM),
  "https://cal.example.org/robin.ics": served(ROBIN)
}
