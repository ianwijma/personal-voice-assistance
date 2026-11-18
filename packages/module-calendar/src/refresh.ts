import { type Actor, type ModuleHostApi, type ModuleStore, People, type PeopleService, type Row } from "@pva/core"
import { userAgent } from "@pva/net"
import { Clock, Effect, Option, Result, Semaphore } from "effect"
import { addressOf, type CalendarConfig, type CalendarSettings, ownerOf, sameName } from "./config.ts"
import type { IcsOccurrence } from "./ics.ts"
import { type CalendarProvider, type IcsDeps, makeIcsProvider } from "./provider.ts"
import {
  hashId,
  type Occurrence,
  occurrences,
  PLACE_CHARS,
  type SourceError,
  sourceId,
  type SourceState,
  sources,
  TITLE_CHARS,
  type Upcoming,
  upcoming,
  UPCOMING_ID,
  upcomingIdOf,
  UPCOMING_ITEMS,
  upcomingPersonal
} from "./store.ts"
import { addDays, dateOf, dayNumber, daysBetween, homeZone, type LocalDate, startOfDay } from "./time.ts"

/**
 * The refresh job (docs/MODULES.md §6, §12, §15): reads every configured calendar through its provider and keeps the
 * store's cache of their occurrences from yesterday to `WINDOW_DAYS` days ahead, so every tool answers from the store
 * and nothing on a turn waits for the network. One refresh runs at a time.
 *
 * Per calendar: its provider reads it (`provider.ts`: ICS through `safeFetch`, expanded by `ics.ts` in bounded
 * steps), then its rows are brought to what was read: its rows read page by page, what changed inserted or updated,
 * what is gone removed, `WRITE_BATCH` rows per transaction with a yield between them. A calendar that cannot be read
 * keeps its rows (answers say they are from the last good read) and records why. Then rows that ended before the
 * window or belong to no configured calendar are removed, and the ambient rows (`upcoming`) are written again.
 */

/** Days ahead the cache holds, from today. */
export const WINDOW_DAYS = 62
/** Days a long event is kept on (a holiday of three weeks is on its first 14 days). */
const MAX_EVENT_DAYS = 14
/** Rows one calendar may keep. */
export const MAX_SOURCE_ROWS = 3_000
const PAGE = 20
const WRITE_BATCH = 50
/** Rows the closing pass reads (pruning and the ambient rows), from the earliest. */
const SCAN_LIMIT = 4_000
/** What the module takes from its tests: the network that has no network, and a shorter time limit. */
export type CalendarDeps = IcsDeps

/** The refresh found calendars it could not read (the cron job fails with it: its Health issue names them). */
export class RefreshFailed extends Error {}

const sameValue = (a: Occurrence, b: Occurrence) => JSON.stringify(a) === JSON.stringify(b)

/** Rows of one occurrence: one per local day it touches, inside the window, at most `MAX_EVENT_DAYS`. */
const rowsOf = (o: IcsOccurrence, base: Omit<Occurrence, "day" | "start" | "end" | "allDay" | "title" | "location" | "busy">, zone: string, first: LocalDate, last: LocalDate) => {
  const from = dateOf(o.start, zone)
  const to = dateOf(o.end > o.start ? o.end - 1 : o.start, zone)
  const out: Array<Occurrence> = []
  let d = daysBetween(first, from) > 0 ? from : first
  for (let k = 0; k < MAX_EVENT_DAYS && daysBetween(d, to) >= 0 && daysBetween(d, last) >= 0; k++, d = addDays(d, 1)) {
    out.push({
      ...base,
      day: dayNumber(d),
      start: o.start,
      end: o.end,
      allDay: o.allDay,
      title: o.title,
      ...(o.location !== undefined ? { location: o.location } : {}),
      busy: o.busy
    })
  }
  return out
}

/** The cache's window: yesterday to `WINDOW_DAYS` days ahead, in the household's zone, and now. */
interface Window {
  readonly today: LocalDate
  readonly first: LocalDate
  readonly last: LocalDate
  /** Epoch ms of the first day's midnight, and of the midnight after the last day. */
  readonly from: number
  readonly to: number
  readonly zone: string
  readonly now: number
}

/** What the refresh uses of the shared part: its store, the host, and the shared settings (read at each run). */
export interface RefreshEnv {
  readonly store: ModuleStore
  readonly host: ModuleHostApi
  readonly settings: CalendarSettings
}

export const makeRefresh = (ctx: RefreshEnv, deps: CalendarDeps, provider: CalendarProvider = makeIcsProvider(deps)) =>
  Effect.gen(function*() {
    const lock = yield* Semaphore.make(1)
    const store = ctx.store
    const rows = store.collection(occurrences)
    const states = store.collection(sources)

    /** Every row of one calendar, page by page (a job: no bound but the calendar's own, `MAX_SOURCE_ROWS` and what is left from before). */
    const rowsOfSource = (name: string) =>
      Effect.gen(function*() {
        const found = new Map<string, Row<Occurrence>>()
        let after: Row<Occurrence> | undefined
        for (;;) {
          const page = yield* rows.list({ where: { source: name }, orderBy: { field: "day" }, limit: PAGE, ...(after !== undefined ? { after } : {}) })
          for (const r of page) found.set(r.id, r)
          if (page.length < PAGE) return found
          after = page.at(-1)
          yield* Effect.yieldNow
        }
      })

    /** Apply writes in batches, each its own transaction, with a yield between them. */
    const inBatches = <T>(items: ReadonlyArray<T>, write: (tx: Parameters<Parameters<typeof store.transaction>[0]>[0], item: T) => void) =>
      Effect.gen(function*() {
        for (let i = 0; i < items.length; i += WRITE_BATCH) {
          const batch = items.slice(i, i + WRITE_BATCH)
          yield* store.transaction((tx) => {
            for (const item of batch) write(tx, item)
          })
          yield* Effect.yieldNow
        }
      })

    /** Bring one calendar's rows to `wanted`. */
    const sync = (name: string, wanted: ReadonlyMap<string, Occurrence>, actor: Actor) =>
      Effect.gen(function*() {
        const existing = yield* rowsOfSource(name)
        const writes: Array<[string, Occurrence, boolean]> = []
        for (const [id, value] of wanted) {
          const old = existing.get(id)
          if (old === undefined) writes.push([id, value, true])
          else if (!sameValue(old.value, value)) writes.push([id, value, false])
        }
        yield* inBatches(writes, (tx, [id, value, isNew]) => {
          const c = tx.collection(occurrences)
          if (isNew) c.insert(value, { id, actor })
          else c.update(id, () => value, { actor })
        })
        const gone = [...existing.keys()].filter((id) => !wanted.has(id))
        yield* inBatches(gone, (tx, id) => void tx.collection(occurrences).remove(id, { actor }))
      })

    const removeSource = (name: string, actor: Actor) => sync(name, new Map(), actor)

    const writeState = (name: string, change: (old: SourceState | undefined) => SourceState, actor: Actor) =>
      store.transaction((tx) => {
        const c = tx.collection(sources)
        const id = sourceId(name)
        const old = c.get(id)
        if (old === undefined) c.insert(change(undefined), { id, actor })
        else c.update(id, (v) => change(v), { actor })
      })

    /** Read one calendar; its rows and state are written; the error, when there was one, is returned. */
    const refreshOne = (c: CalendarConfig, people: PeopleService | undefined, window: Window, actor: Actor) =>
      Effect.gen(function*() {
        const name = c.name.trim()
        const old = (yield* states.get(sourceId(name)))?.value
        const today = dayNumber(window.today)
        const failed = (error: SourceError) =>
          writeState(name, (v) => ({ name, triedAt: window.now, error, rows: v?.rows ?? 0, cut: v?.cut ?? false, ...(v?.okAt !== undefined ? { okAt: v.okAt } : {}) }), actor).pipe(
            Effect.as(Option.some(error))
          )
        const address = addressOf(c, ctx.settings)
        if (address === undefined) return yield* failed("no-link")
        const owner = ownerOf(c, people)
        if (owner.kind === "unknown") return yield* failed("owner")
        const contact = ctx.host.view().home.HOME_API_CONTACT
        // A conditional request only on the day the rows were read: on a later day the window has moved on, and a
        // repeating event's new occurrences must be expanded although the file did not change.
        const conditional = old?.etag !== undefined && old.readDay === today && old.okAt !== undefined && old.error === undefined
        const got = yield* Effect.result(provider.read({
          address,
          window: { from: window.from, to: window.to, zone: window.zone },
          userAgent: userAgent(typeof contact === "string" && contact.trim() !== "" ? contact : undefined),
          ...(conditional ? { etag: old.etag! } : {})
        }, { titleChars: TITLE_CHARS, placeChars: PLACE_CHARS }))
        if (Result.isFailure(got)) return yield* failed(got.failure)
        const read = got.success
        if (read.kind === "unchanged") {
          yield* writeState(name, (v) => ({ ...(v ?? { name, rows: 0, cut: false }), name, triedAt: window.now, okAt: window.now, readDay: today, ...(v?.etag !== undefined ? { etag: v.etag } : {}) }), actor)
          return Option.none()
        }
        const base = { source: name, ...(owner.kind === "person" ? { owner: owner.id } : {}) }
        const wanted = new Map<string, Occurrence>()
        let cut = read.cut
        for (const o of read.occurrences) {
          for (const row of rowsOf(o, base, window.zone, window.first, window.last)) {
            if (wanted.size >= MAX_SOURCE_ROWS) {
              cut = true
              break
            }
            wanted.set(hashId("ev", name.toLowerCase(), o.uid, row.start, row.day), row)
          }
        }
        yield* sync(name, wanted, actor)
        yield* writeState(name, () => ({
          name,
          triedAt: window.now,
          okAt: window.now,
          rows: wanted.size,
          cut,
          readDay: today,
          ...(read.etag !== undefined ? { etag: read.etag } : {})
        }), actor)
        return Option.none<SourceError>()
      })

    /**
     * The closing pass, from the earliest row: remove rows that ended before the window or belong to no configured
     * calendar (or to another owner than it has now), and collect the next few events for the ambient rows.
     */
    const closingPass = (configs: ReadonlyArray<CalendarConfig>, people: PeopleService | undefined, window: { from: number; now: number; zone: string }, actor: Actor) =>
      Effect.gen(function*() {
        const owners = new Map(configs.map((c) => [c.name.trim().toLowerCase(), ownerOf(c, people)]))
        const gone: Array<string> = []
        const household: Array<Upcoming["items"][number]> = []
        const personal = new Map<string, Array<Upcoming["items"][number]>>()
        const seen = new Set<string>()
        let after: Row<Occurrence> | undefined
        let read = 0
        while (read < SCAN_LIMIT) {
          const page = yield* rows.list({ orderBy: { field: "start" }, limit: PAGE, ...(after !== undefined ? { after } : {}) })
          read += page.length
          for (const r of page) {
            const o = owners.get(r.value.source.toLowerCase())
            const fits = o !== undefined && o.kind !== "unknown" && (o.kind === "household" ? r.value.owner === undefined : r.value.owner === o.id)
            if (!fits || r.value.end <= window.from) {
              gone.push(r.id)
              continue
            }
            if (r.value.end <= window.now) continue
            // One item per occurrence (a long event has a row for each of its days).
            const key = `${r.value.source}\u0000${r.value.start}\u0000${r.value.title}`
            if (seen.has(key)) continue
            seen.add(key)
            const item = { title: r.value.title.slice(0, 80), start: r.value.start, end: r.value.end, allDay: r.value.allDay }
            const list = r.value.owner === undefined ? household : (personal.get(r.value.owner) ?? personal.set(r.value.owner, []).get(r.value.owner)!)
            if (list.length < UPCOMING_ITEMS) list.push(item)
          }
          if (page.length < PAGE) break
          after = page.at(-1)
          yield* Effect.yieldNow
        }
        yield* inBatches(gone, (tx, id) => void tx.collection(occurrences).remove(id, { actor }))
        const value = (items: ReadonlyArray<Upcoming["items"][number]>): Upcoming => ({ items, timeZone: window.zone })
        yield* store.transaction((tx) => {
          const h = tx.collection(upcoming)
          const scope = { kind: "household" as const }
          const old = h.get(UPCOMING_ID, { scope })
          if (household.length === 0) {
            if (old !== undefined) h.remove(UPCOMING_ID, { scope, actor })
          } else if (old === undefined) h.insert(value(household), { id: UPCOMING_ID, scope, actor })
          else h.update(UPCOMING_ID, () => value(household), { scope, actor })
          const p = tx.collection(upcomingPersonal)
          for (const person of people?.list() ?? []) {
            const items = personal.get(person.id) ?? []
            const pscope = { kind: "person" as const, id: person.id }
            const pid = upcomingIdOf(person.id)
            const was = p.get(pid, { scope: pscope })
            if (items.length === 0) {
              if (was !== undefined) p.remove(pid, { scope: pscope, actor })
            } else if (was === undefined) p.insert(value(items), { id: pid, scope: pscope, actor })
            else p.update(pid, () => value(items), { scope: pscope, actor })
          }
        })
      })

    /** One refresh of every calendar; `failOnError`: fail (for the job's Health issue) when a calendar could not be read. */
    const run = (actor: Actor, failOnError: boolean) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const settings = ctx.settings
        const configs = settings.calendars ?? []
        const now = yield* Clock.currentTimeMillis
        const zone = homeZone(ctx.host.view())
        const today = dateOf(now, zone)
        const first = addDays(today, -1)
        const last = addDays(today, WINDOW_DAYS)
        const window: Window = { today, first, last, from: startOfDay(first, zone), to: startOfDay(addDays(last, 1), zone), zone, now }
        const people = ctx.host.service(People)
        const failures: Array<string> = []
        for (const c of configs) {
          const error = yield* refreshOne(c, people, window, actor)
          if (Option.isSome(error)) failures.push(`${c.name.trim()} (${error.value})`)
        }
        // Calendars no longer configured: their rows and their state go.
        for (const s of yield* states.list({ limit: 35 })) {
          if (configs.some((c) => sameName(c.name, s.value.name))) continue
          yield* removeSource(s.value.name, actor)
          yield* states.remove(s.id, { actor })
        }
        yield* closingPass(configs, people, window, actor)
        if (failOnError && failures.length > 0) return yield* Effect.fail(new RefreshFailed(`Could not read: ${failures.join(", ")}`))
      }))

    return { run }
  })
