import { CurrentJob, defineModule, type ModuleDefinition, type SchedulerError } from "@pva/core"
import { BriefingSections, homeLanguage } from "@pva/module-contracts"
import { Effect, Schema } from "effect"
import { makeBriefingSection } from "./briefing.ts"
import { LINK_SLOTS, refreshCron, settings } from "./config.ts"
import { makeReader, type Reader } from "./read.ts"
import { makeScreen, type Screen } from "./screen.ts"
import { type CalendarDeps, makeRefresh } from "./refresh.ts"
import { allStates, occurrences, sources } from "./store.ts"
import { makeTools } from "./tools.ts"

/**
 * Calendars from ICS links: what is on, what is next, finding an event and free time, answered from a cache that a
 * scheduled job keeps (docs/modules/calendar.md; docs/MODULES-PLAN.md §5.1 row 12, wave A, ICS only).
 *
 * - `shared`: the refresh job's handler (a cron job by the "Read the calendars every" setting, and one run at start),
 *   which reads each calendar off the main thread and publishes it as a new generation; the reader over the store;
 *   and the briefing section (`BriefingSections`). Nothing of the calendars goes into the prompt (no ambient line).
 * - `start`: the read tools and the typed actions, all plain reads of the store; nothing on a turn reaches the network.
 *
 * Off by default; with it off, nothing changes for anyone.
 */

export { texts } from "./texts.ts"
export { occurrences, sources } from "./store.ts"
export type { CalendarDeps } from "./refresh.ts"

const SLOT_SETTING = { private1: "privateLink1", private2: "privateLink2", private3: "privateLink3" } as const

/** The module, with what its tests give it (the network that has no network, a shorter fetch limit). */
export const calendarModuleWith = (deps: CalendarDeps = {}) =>
  defineModule({
    apiVersion: 2,
    id: "calendar",
    name: "Calendar",
    description: "Calendars from ICS links: what is on, what is next, finding an event and free time.",
    enabledByDefault: false,
    version: "0.1.0",
    settings,
    storage: { version: 1, collections: [occurrences, sources] },
    requires: [{ network: "internet", why: "Reads the ICS calendar addresses set on the module's page" }],
    health: ({ settings: s }) =>
      Effect.sync(() => {
        const calendars = s?.calendars ?? []
        if (calendars.length === 0) {
          return [{ id: "calendar.no-calendars", severity: "info" as const, title: "No calendars are set up", detail: "Add an ICS address on the Calendar module's page." }]
        }
        return calendars.flatMap((c) => {
          if (c.link === "address" || !LINK_SLOTS.includes(c.link)) return []
          const key = SLOT_SETTING[c.link]
          if (s?.[key] !== undefined) return []
          const n = c.link.slice(-1)
          return [{
            id: `calendar.no-private-link-${n}`,
            severity: "warning" as const,
            title: `"${c.name.trim()}" has no private link`,
            detail: `It reads Private link ${n}, which is not set. Set it on the module's page, or type the address instead.`
          }]
        })
      }),
    shared: (ctx) =>
      Effect.gen(function*() {
        const screen = makeScreen()
        const sourceRows = ctx.store.collection(sources)
        /** Which generation, error and unreadable count each calendar has: what a refresh may change in an answer. */
        const fingerprint = Effect.map(
          allStates((q) => sourceRows.list(q)),
          (rows) => rows.map((r) => `${r.id}:${r.value.gen ?? ""}:${r.value.error ?? ""}:${r.value.unreadable ?? 0}`).sort().join(",")
        )
        const refresh = yield* makeRefresh({ store: ctx.store, host: ctx.host, settings: ctx.settings }, deps)
        // One handler for both jobs; idempotent (a second run reads the calendars again and writes the same rows).
        yield* ctx.scheduler.handle("refresh", {
          payload: Schema.Struct({ report: Schema.optionalKey(Schema.Boolean) }),
          idempotent: true,
          retries: 1,
          timeoutMs: 5 * 60_000,
          run: ({ report }) =>
            Effect.gen(function*() {
              const job = yield* CurrentJob
              if (job === undefined) return yield* Effect.die(new Error("refresh runs only as a job"))
              // The run at start never fails (its Health issue would stay until dismissed); the repeating one does, so a
              // calendar that cannot be read shows on the Health page until a refresh succeeds.
              // What a screen shows follows the calendars: when a refresh changed what they say, the lists and cards
              // this module showed are taken down (a transient one ends by itself after 30 seconds anyway).
              const before = yield* fingerprint
              yield* refresh.run({ kind: "job", jobId: job.jobId }, report !== false).pipe(
                Effect.ensuring(Effect.flatMap(Effect.orElseSucceed(fingerprint, () => before), (after) => (after === before ? Effect.void : screen.dismissAll)))
              )
            })
        }).pipe(Effect.orDie)
        // The CLI modes have no scheduler (every call but `handle` is `unavailable`): there the tools answer from the
        // store as the server left it. Any other refusal is a start error.
        const orCli = <A>(e: Effect.Effect<A, SchedulerError>) => e.pipe(Effect.asVoid, Effect.catchTag("SchedulerError", (err) => (err.reason === "unavailable" ? Effect.void : Effect.die(err))))
        yield* orCli(ctx.scheduler.schedule({ handler: "refresh", key: "refresh", cron: refreshCron(ctx.settings.refresh) }))
        // Read once now: after a start or a change of the settings the cache is brought up to date at once.
        yield* orCli(ctx.scheduler.schedule({ handler: "refresh", key: "refresh-start", inMs: 0, payload: { report: false } }))
        const reader = makeReader({ host: ctx.host, store: ctx.store, settings: () => ctx.settings, language: () => homeLanguage(ctx.host.view()) })
        return { value: { reader, screen }, contributions: [BriefingSections.of(makeBriefingSection(reader))] }
      }),
    start: (ctx) =>
      Effect.sync(() => {
        const { reader, screen } = ctx.shared as { readonly reader: Reader; readonly screen: Screen }
        const { tools, actions } = makeTools(reader, (presentation) => screen.show(ctx.present, presentation))
        return {
          tools,
          actions,
          instructions:
            "For the household's calendars use calendar_agenda (a day or a few), calendar_next, calendar_find and calendar_free. They answer from the calendars as last read; events cannot be added, changed or deleted here."
        }
      })
  })

/** The production module. */
export const calendarModule = calendarModuleWith()

/**
 * What the app runs from this package (`apps/assistant/src/modules.ts` lists it once, so this package's pull request
 * never edits the catalogue): the production definition of every module id the package has, in this order.
 */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [calendarModule]
