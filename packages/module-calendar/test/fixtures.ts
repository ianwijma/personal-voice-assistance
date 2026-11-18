// ICS files and a started module for the calendar tests: no test reaches the network (`makeOfflineNet`).
import { type ModuleHostApi, type ModuleStore, People, type PeopleService, Privacy, type PrivacyService, StoreError } from "@pva/core"
import { makeOfflineNet, type OfflineFixtures, startTestModule, type TestHouseholdInput } from "@pva/core/testing"
import { Effect } from "effect"
import { calendarModuleWith, type CalendarDeps } from "../src/index.ts"

export interface Ev {
  readonly uid: string
  readonly summary?: string
  /** `20261118T093000` (with `tz`, or `Z` at the end for UTC), or `20261118` for an all-day event. */
  readonly start?: string
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
  value.length === 8 ? `${name};VALUE=DATE:${value}` : tz !== undefined && !value.endsWith("Z") ? `${name};TZID=${tz}:${value}` : `${name}:${value}`

export const vevent = (e: Ev): string =>
  [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    ...(e.start !== undefined ? [dt("DTSTART", e.start, e.tz)] : []),
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

interface Kitlike {
  readonly jobs: Effect.Effect<ReadonlyArray<{ readonly state: string; readonly dueAt: number }>>
  readonly advance: (ms: number) => Effect.Effect<void>
  readonly now: Effect.Effect<number>
}

/**
 * Wait until no refresh is running or due: a refresh reads each calendar in a worker thread (real time) and writes in
 * steps past what `advance` waits for, so the test lets real time pass (a few milliseconds at a time, at most 30
 * seconds) until its job has finished.
 */
export const refreshed = (kit: Kitlike) =>
  Effect.gen(function*() {
    for (let i = 0; i < 6_000; i++) {
      const now = yield* kit.now
      // Done when nothing runs and nothing that is due waits to start.
      if (!(yield* kit.jobs).some((j) => j.state === "running" || (j.state === "scheduled" && j.dueAt <= now))) return
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      yield* kit.advance(0)
    }
    return yield* Effect.die(new Error("the refresh did not finish"))
  })

/**
 * Move the clock by `ms`, stopping at each job that comes due on the way and waiting (real time) for it to finish: a
 * refresh reads in a worker, and a clock moved on past it would run into the handler's time limit (test-clock time).
 */
export const advanceAndRefresh = (kit: Kitlike, ms: number) =>
  Effect.gen(function*() {
    const target = (yield* kit.now) + ms
    for (;;) {
      const now = yield* kit.now
      const next = Math.min(target, ...(yield* kit.jobs).filter((j) => j.state === "scheduled" && j.dueAt > now).map((j) => j.dueAt))
      yield* kit.advance(Math.max(0, next - now))
      yield* refreshed(kit)
      if ((yield* kit.now) >= target) return
    }
  })

/** Move the clock to the next job that is due (and no further), without waiting for it. */
export const advanceToNextJob = (kit: Kitlike) =>
  Effect.gen(function*() {
    const now = yield* kit.now
    const next = Math.min(...(yield* kit.jobs).filter((j) => j.state === "scheduled" && j.dueAt > now).map((j) => j.dueAt))
    yield* kit.advance(Number.isFinite(next) ? next - now : 0)
  })

/** The sentence of a typed action that answered (`{ ok: true, say }`). */
export const sayOf = (r: unknown): string => {
  const said = (r as { readonly say?: unknown }).say
  if (typeof said !== "string") throw new Error(`the action did not answer: ${JSON.stringify(r)}`)
  return said
}

/** Real time passing (for a worker or a paused write). */
export const sleepReal = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

/** What a test's own wrapper may change of the module's shared part: its store and its host. */
export interface Wrap {
  readonly store?: (store: ModuleStore) => ModuleStore
  readonly host?: (host: ModuleHostApi) => ModuleHostApi
}

/** The module with its shared part given a wrapped store or host (a test's own wrapper, as the kit's examples do). */
export const wrapped = (definition: ReturnType<typeof calendarModuleWith>, wrap: Wrap): ReturnType<typeof calendarModuleWith> => ({
  ...definition,
  shared: (ctx) =>
    definition.shared!({
      ...ctx,
      ...(wrap.store !== undefined ? { store: wrap.store(ctx.store) } : {}),
      ...(wrap.host !== undefined ? { host: wrap.host(ctx.host) } : {})
    })
})

/**
 * People and Privacy that can lose a member while the module runs (the kit's household is fixed): a removed person is
 * found by nobody, is no member, and nothing of theirs may be revealed. Looked up from the real host at each call.
 */
export const mutablePeople = () => {
  const removed = new Set<string>()
  const host = (h: ModuleHostApi): ModuleHostApi => ({
    ...h,
    service: ((key: unknown) => {
      if (key === People) {
        const real = h.service(People)
        if (real === undefined) return undefined
        const people: PeopleService = {
          ...real,
          list: () => real.list().filter((p) => !removed.has(p.id)),
          get: (id) => (removed.has(id) ? undefined : real.get(id)),
          find: (spoken) => {
            const f = real.find(spoken)
            if (f.kind === "found") return removed.has(f.person.id) ? { kind: "none" } : f
            if (f.kind === "ambiguous") {
              const left = f.people.filter((p) => !removed.has(p.id))
              return left.length === 0 ? { kind: "none" } : left.length === 1 ? { kind: "found", person: left[0]! } : { ...f, people: left }
            }
            return f
          }
        }
        return people
      }
      if (key === Privacy) {
        const real = h.service(Privacy)
        if (real === undefined) return undefined
        const privacy: PrivacyService = { ...real, mayReveal: (owner, device) => owner !== undefined && !removed.has(owner) && real.mayReveal(owner, device) }
        return privacy
      }
      return h.service(key as never)
    }) as ModuleHostApi["service"]
  })
  return { removed, host }
}

/**
 * A store whose reads of `occurrences` can run something before a given read (to change things while an answer
 * reads), and whose transactions can be held or failed (to cut a refresh short at a chosen point).
 */
export const controlledStore = () => {
  const control = {
    /** Called before each list of occurrences, with its number (from 1). */
    beforeRead: undefined as ((n: number) => void) | undefined,
    reads: 0,
    /** Every list of occurrences fails (the store busy). */
    failReads: false,
    /** Decides, before each transaction, whether to hold it (a promise it waits for) or fail it. */
    beforeTransaction: undefined as ((info: { readonly insertedRows: number; readonly n: number }) => "fail" | Promise<void> | undefined) | undefined,
    insertedRows: 0,
    transactions: 0
  }
  const store = (s: ModuleStore): ModuleStore => ({
    ...s,
    collection: ((c: { readonly name: string }) => {
      const h = s.collection(c as never) as unknown as Record<string, unknown> & { list: (...a: Array<unknown>) => Effect.Effect<unknown, unknown> }
      if (c.name !== "occurrences") return h
      return {
        ...h,
        list: (...a: Array<unknown>) =>
          Effect.suspend(() => {
            control.reads++
            control.beforeRead?.(control.reads)
            if (control.failReads) return Effect.fail(new StoreError({ reason: "busy", message: "the store is busy (a test)" }))
            return h.list(...a)
          })
      }
    }) as unknown as ModuleStore["collection"],
    transaction: ((f: (tx: unknown) => unknown) =>
      Effect.suspend(() => {
        control.transactions++
        const decision = control.beforeTransaction?.({ insertedRows: control.insertedRows, n: control.transactions })
        if (decision === "fail") return Effect.fail(new StoreError({ reason: "failed", message: "the store failed (a test)" }))
        const run = s.transaction((tx) => {
          const counting = {
            ...tx,
            collection: (c: { readonly name: string }) => {
              const h = tx.collection(c as never) as unknown as Record<string, unknown> & { insert: (...a: Array<unknown>) => unknown }
              if (c.name !== "occurrences") return h
              return { ...h, insert: (...a: Array<unknown>) => (control.insertedRows++, h.insert(...a)) }
            }
          }
          return f(counting) as never
        })
        return decision === undefined ? run : Effect.andThen(Effect.promise(() => decision), run)
      })) as ModuleStore["transaction"]
  })
  return { control, store }
}

/** The longest stop of the main thread while `effect` runs: the longest gap between two ticks of a 1 ms timer, the last one included. */
export const heartbeat = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let longest = 0
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    const value = yield* effect.pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))
    // The tail: the gap from the last tick to now counts too.
    longest = Math.max(longest, performance.now() - last)
    return { value, longest }
  })

/** The module on the test network, its refresh run once (the run at start), with `settings` and `secrets`. */
export const startCalendar = (
  fixtures: OfflineFixtures,
  options: {
    readonly settings?: Readonly<Record<string, unknown>>
    readonly secrets?: Readonly<Record<string, string>>
    readonly deps?: CalendarDeps
    readonly household?: TestHouseholdInput
    readonly startAt?: number
    readonly wrap?: Wrap
  } = {}
) =>
  Effect.gen(function*() {
    const net = makeOfflineNet(fixtures)
    const base = calendarModuleWith({ resolver: net.resolver, connector: net.connector, ...options.deps })
    const definition = options.wrap !== undefined ? wrapped(base, options.wrap) : base
    const kit = yield* startTestModule(definition, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      ...(options.secrets !== undefined ? { secrets: options.secrets } : {}),
      ...(options.household !== undefined ? { household: options.household } : {}),
      ...(options.startAt !== undefined ? { startAt: options.startAt } : {})
    })
    // The run at start is due now.
    yield* advanceAndRefresh(kit, 0)
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
