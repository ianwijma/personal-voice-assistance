import { type Actor, type ModuleHostApi, type ModuleStore, People, type PeopleService } from "@pva/core"
import { userAgent } from "@pva/net"
import { Clock, Effect, Option, Result, Semaphore } from "effect"
import { addressOf, type CalendarConfig, type CalendarSettings, ownerOf, sameName, secretPartsOf } from "./config.ts"
import type { Occ } from "./expand.ts"
import { type CalendarProvider, type IcsDeps, makeIcsProvider } from "./provider.ts"
import { allStates, batchOf, hashId, linkPrint, type Occurrence, occurrences, ownerKey, ROWS_PAGE, type SourceError, sourceId, type SourceState, sources } from "./store.ts"
import { addDays, dateOf, dateOfDayNumber, dayNumber, homeZone, type LocalDate, startOfDay } from "./time.ts"

/**
 * The refresh job (docs/MODULES.md §6, §12, §15): reads every configured calendar through its provider and keeps the
 * store's cache of their occurrences from yesterday to `WINDOW_DAYS` days ahead, so every tool answers from the store
 * and nothing on a turn waits for the network. One refresh runs at a time.
 *
 * **A refresh is published whole or not at all** (store.ts, "Generations"). Per calendar: the provider reads it (the
 * fetch on the main thread, the parsing and expansion in a worker); its rows are written as a new generation,
 * `WRITE_BATCH` rows per transaction with a yield between them; then one transaction makes that generation the
 * calendar's current one, with what it was read from (the link's fingerprint, the owner, the household's zone), when,
 * and how many events could not be read; then the previous generation's rows are removed, a page per transaction. A
 * read that fails, is cut short (a restart, a store failure) or reads nothing from a file that is not a well-formed
 * calendar never replaces the current generation; what it wrote is removed by the next refresh. A "not modified" answer
 * is asked for only on the day the current generation was read, from the same link, for the same owner, in the same zone.
 */

/** Days ahead the cache holds, from today. */
export const WINDOW_DAYS = 62
const WRITE_BATCH = 25
/** What the module takes from its tests: the network that has no network, and shorter limits. */
export type CalendarDeps = IcsDeps

/** The refresh found calendars it could not read (the cron job fails with it: its Health issue names them). */
export class RefreshFailed extends Error {}

/** The cache's window: yesterday to `WINDOW_DAYS` days ahead, in the household's zone, and now. */
export interface Window {
  readonly today: LocalDate
  readonly first: LocalDate
  readonly last: LocalDate
  /** Epoch ms of the first day's midnight, and of the midnight after the last day. */
  readonly from: number
  readonly to: number
  readonly zone: string
  readonly now: number
}

export const windowAt = (now: number, zone: string): Window => {
  const today = dateOf(now, zone)
  const first = addDays(today, -1)
  const last = addDays(today, WINDOW_DAYS)
  return { today, first, last, from: startOfDay(first, zone), to: startOfDay(addDays(last, 1), zone), zone, now }
}

/** What the refresh uses of the shared part: its store, the host, and the shared settings (read at each run). */
export interface RefreshEnv {
  readonly store: ModuleStore
  readonly host: ModuleHostApi
  readonly settings: CalendarSettings
}

/** The rows of one generation, a batch at a time: one per local day of the window each occurrence covers. */
function* rowsOf(occs: ReadonlyArray<Occ>, base: { readonly source: string; readonly batch: string; readonly owner?: string }): Generator<[string, Occurrence]> {
  for (const o of occs) {
    let d = dateOfDayNumber(o.first)
    for (let n = o.first; n <= o.last; d = addDays(d, 1), n = dayNumber(d)) {
      const row: Occurrence = {
        source: base.source,
        batch: base.batch,
        key: o.key,
        day: n,
        start: o.start,
        end: o.end,
        allDay: o.allDay,
        title: o.title,
        ...(o.location !== undefined ? { location: o.location } : {}),
        ...(base.owner !== undefined ? { owner: base.owner } : {}),
        busy: o.busy,
        beyond: o.beyond
      }
      yield [hashId("ev", base.batch, o.key, n), row]
    }
  }
}

export const makeRefresh = (ctx: RefreshEnv, deps: CalendarDeps, provider: CalendarProvider = makeIcsProvider(deps)) =>
  Effect.gen(function*() {
    const lock = yield* Semaphore.make(1)
    const store = ctx.store
    const rows = store.collection(occurrences)
    const states = store.collection(sources)

    /** Remove one generation's rows, a page per transaction, with a yield between them. */
    const prune = (name: string, gen: number, actor: Actor) =>
      Effect.gen(function*() {
        const batch = batchOf(name, gen)
        for (;;) {
          const page = yield* rows.list({ where: { batch }, orderBy: { field: "batch" }, limit: ROWS_PAGE })
          if (page.length === 0) return
          yield* store.transaction((tx) => {
            for (const r of page) tx.collection(occurrences).remove(r.id, { actor })
          })
          yield* Effect.yieldNow
        }
      })

    /** A calendar's state before its first try. */
    const fresh = (name: string, now: number): SourceState => ({ name, triedAt: now, rows: 0 })

    const writeState = (name: string, change: (old: SourceState | undefined) => SourceState, actor: Actor) =>
      store.transaction((tx) => {
        const c = tx.collection(sources)
        const id = sourceId(name)
        const old = c.get(id)
        const next = change(old?.value)
        if (old === undefined) c.insert(next, { id, actor })
        else c.update(id, () => next, { actor })
        return next
      })

    /** Without the fields of an unfinished refresh. */
    const settled = (v: SourceState): SourceState => {
      const { writing: _w, old: _o, ...rest } = v
      return rest
    }

    /** What an interrupted refresh left: a generation being written, older ones not yet removed. */
    const cleanUp = (name: string, state: SourceState | undefined, actor: Actor) =>
      Effect.gen(function*() {
        if (state === undefined || (state.writing === undefined && (state.old ?? []).length === 0)) return state
        for (const g of [...(state.writing !== undefined ? [state.writing] : []), ...(state.old ?? [])]) {
          if (g !== state.gen) yield* prune(name, g, actor)
        }
        return yield* writeState(name, (v) => settled(v ?? state), actor)
      })

    /** Read one calendar; the error, when there was one, is returned. */
    const refreshOne = (c: CalendarConfig, people: PeopleService | undefined, window: Window, actor: Actor) =>
      Effect.gen(function*() {
        const name = c.name.trim()
        const today = dayNumber(window.today)
        const state = yield* cleanUp(name, (yield* states.get(sourceId(name)))?.value, actor)
        const failed = (error: SourceError) =>
          writeState(name, (v) => ({ ...(v ?? fresh(name, window.now)), name, triedAt: window.now, error }), actor).pipe(Effect.as(Option.some(error)))
        const address = addressOf(c, ctx.settings)
        if (address === undefined) return yield* failed("no-link")
        const owner = ownerOf(c, people)
        if (owner.kind === "unknown") return yield* failed("owner")
        const link = linkPrint(address)
        const whose = ownerKey(owner)
        const contact = ctx.host.view().home.HOME_API_CONTACT
        // A conditional request only against a generation read on this day from this link for this owner in this zone:
        // on a later day the window has moved on, and a repeating event's new occurrences must be expanded.
        const conditional = state?.gen !== undefined && state.etag !== undefined && state.readDay === today && state.link === link && state.owner === whose && state.zone === window.zone
        const got = yield* Effect.result(provider.read({
          address,
          forbidden: secretPartsOf(c, address),
          window: { from: window.from, to: window.to, zone: window.zone },
          userAgent: userAgent(typeof contact === "string" && contact.trim() !== "" ? contact : undefined),
          ...(conditional ? { etag: state.etag! } : {})
        }))
        if (Result.isFailure(got)) return yield* failed(got.failure)
        const read = got.success
        if (read.kind === "unchanged") {
          yield* writeState(name, (v) => {
            const { error: _e, ...rest } = v ?? fresh(name, window.now)
            return { ...rest, name, triedAt: window.now, okAt: window.now, readDay: today }
          }, actor)
          return Option.none<SourceError>()
        }
        // The new generation: written first (`writing` says so, for a refresh cut short), published after.
        const gen = Math.max(window.now, (state?.gen ?? 0) + 1)
        const batch = batchOf(name, gen)
        yield* writeState(name, (v) => ({ ...(v ?? fresh(name, window.now)), name, writing: gen }), actor)
        const all = rowsOf(read.occurrences, { source: name, batch, ...(owner.kind === "person" ? { owner: owner.id } : {}) })
        let written = 0
        for (;;) {
          const chunk: Array<[string, Occurrence]> = []
          for (let next = all.next(); !next.done; next = all.next()) {
            chunk.push(next.value)
            if (chunk.length >= WRITE_BATCH) break
          }
          if (chunk.length === 0) break
          yield* store.transaction((tx) => {
            const occ = tx.collection(occurrences)
            for (const [id, row] of chunk) occ.insert(row, { id, actor })
          })
          written += chunk.length
          yield* Effect.yieldNow
        }
        // One transaction: this generation is the calendar's from now on, with what it was read from.
        const previous = yield* writeState(name, (v) => {
          const before = v ?? fresh(name, window.now)
          return {
            name,
            triedAt: window.now,
            okAt: window.now,
            gen,
            link,
            owner: whose,
            zone: window.zone,
            unreadable: read.unreadable,
            rows: written,
            lastDay: dayNumber(window.last),
            readDay: today,
            ...(read.etag !== undefined ? { etag: read.etag } : {}),
            ...(before.gen !== undefined && before.gen !== gen ? { old: [before.gen] } : {})
          }
        }, actor)
        for (const g of previous.old ?? []) yield* prune(name, g, actor)
        yield* writeState(name, (v) => settled(v ?? previous), actor)
        return Option.none<SourceError>()
      })

    /** A calendar no longer configured: every generation of its rows, then its state. */
    const removeSource = (state: SourceState, id: string, actor: Actor) =>
      Effect.gen(function*() {
        for (const g of [state.gen, state.writing, ...(state.old ?? [])]) if (g !== undefined) yield* prune(state.name, g, actor)
        yield* states.remove(id, { actor })
      })

    /** One refresh of every calendar; `failOnError`: fail (for the job's Health issue) when a calendar could not be read. */
    const run = (actor: Actor, failOnError: boolean) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const configs = ctx.settings.calendars ?? []
        const window = windowAt(yield* Clock.currentTimeMillis, homeZone(ctx.host.view()))
        const people = ctx.host.service(People)
        const failures: Array<string> = []
        for (const c of configs) {
          const outcome = yield* Effect.result(refreshOne(c, people, window, actor))
          // A store failure (busy, full, read-only) leaves the current generation as it was; the state says so.
          const error = Result.isFailure(outcome) ? Option.some<SourceError>("store") : outcome.success
          if (Result.isFailure(outcome)) {
            yield* Effect.ignore(writeState(c.name.trim(), (v) => ({ ...(v ?? fresh(c.name.trim(), window.now)), triedAt: window.now, error: "store" }), actor))
          }
          if (Option.isSome(error)) failures.push(`${c.name.trim()} (${error.value})`)
        }
        for (const s of yield* allStates((q) => states.list(q))) {
          if (configs.some((c) => sameName(c.name, s.value.name))) continue
          yield* removeSource(s.value, s.id, actor)
        }
        if (failOnError && failures.length > 0) return yield* Effect.fail(new RefreshFailed(`Could not read: ${failures.join(", ")}`))
      }))

    return { run }
  })
