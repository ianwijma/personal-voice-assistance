// What the reminders tests share: the household's devices, reading every row, and the module with its store, its
// notifications, its presentations or its privacy answers failing or changing on demand (the kit has no fault-injecting
// store, so a test wraps the handles the module is given; docs/modules/reminders.md lists that as missing below).
import { BriefingSections, type BriefingRequest } from "@pva/module-contracts"
import { type startTestModule } from "@pva/core/testing"
import { NotifyError, PresentError, Privacy, StoreError, type ModuleDefinition, type Row } from "@pva/core"
import { assert } from "@effect/vitest"
import { Deferred, Effect } from "effect"
import { type Reminder, reminders, remindersModule } from "../src/index.ts"

export const SAM = "kitchen-display" // shared, Sam's
export const ROBIN = "robins-phone" // private, Robin's
export const HALL = "hall-screen" // public, nobody's
export const MIN = 60_000
export const H = 60 * MIN
export const DAY = 24 * H

export type Kit = Effect.Success<ReturnType<typeof startTestModule>>

type Store = { list: (q: unknown) => Effect.Effect<ReadonlyArray<Row<Reminder>>> }

/** Every row of the collection, page by page (not only the first page). */
export const allRows = (kit: Kit) =>
  Effect.gen(function*() {
    const store = kit.moduleStore().collection(reminders) as unknown as Store
    const out: Array<Row<Reminder>> = []
    let after: Row<Reminder> | undefined
    for (;;) {
      const page = yield* store.list({ limit: 12, orderBy: { field: "createdAt", direction: "asc" }, ...(after !== undefined ? { after } : {}) })
      out.push(...page)
      if (page.length < 12) return out
      after = page.at(-1)
    }
  })
export const rowByText = (kit: Kit, text: string) => Effect.map(allRows(kit), (rs) => rs.find((r) => r.value.text === text))
export const theRow = (kit: Kit) => Effect.map(allRows(kit), (rs) => rs[0]!)

export const spoken = (r: { readonly value: unknown }) => (r.value as { spoken: string }).spoken
export const liveJobs = (kit: Kit) => Effect.map(kit.jobs, (js) => js.filter((j) => j.state === "scheduled" || j.state === "running"))
export const jobOf = (kit: Kit, id: string) => Effect.map(liveJobs(kit), (js) => js.filter((j) => j.key === `reminder:${id}`))
export const openNotes = (kit: Kit) => Effect.map(kit.notify.all, (ns) => ns.filter((n) => n.state === "open"))

/** The module with its parts' handles wrapped: failures on demand, a slow delivery, the registered handlers captured. */
export interface Faults {
  storeWrites: boolean
  storeReads: boolean
  /** The next N transactions fail (after any other check). */
  failTransactions: number
  onRead?: ((q: any) => void) | undefined
  listFails?: number
  /** Pause one captured notification-list snapshot for each supplied gate. */
  listGate?: Deferred.Deferred<void>
  listEntered?: Deferred.Deferred<void>
  sendFails: number
  /** After a successful send: what to do (e.g. make the next transaction fail: a crash between the send and the write). */
  afterSend?: (() => void) | undefined
  resolveFails: number
  dismissFails: number
  /** The answer of `Privacy.mayReveal` for an owner, when set (a device's default person changed meanwhile). */
  reveal?: (owner: string | undefined, device: unknown) => boolean | undefined
  /** When set, a delivery waits here (a slow delivery, to call the reminder off while its job runs). */
  gate?: Deferred.Deferred<void>
  entered?: Deferred.Deferred<void>
  /** Handlers the module registered, by kind and name, as it gave them. */
  readonly handlers: Record<string, any>
  /** How often each scheduler handler was entered. */
  readonly runs: Record<string, number>
  /** What each tool last returned, as the module gave it (before the gateway splits `{ forModel, present }`). */
  readonly results: Record<string, any>
  /** How often the module itself called `present.show` (a tool's returned presentation is not counted). */
  shows: number
}
export const nofaults = (): Faults => ({ storeWrites: false, storeReads: false, failTransactions: 0, sendFails: 0, resolveFails: 0, dismissFails: 0, handlers: {}, runs: {}, results: {}, shows: 0 })

export const faulty = (faults: Faults): ModuleDefinition<any> => {
  let heldListGate: Deferred.Deferred<void> | undefined
  const bad = (what: string) => Effect.fail(new StoreError({ reason: "busy", message: what }))
  const wrapStore = (store: any) => ({
    ...store,
    transaction: (f: any) => {
      if (faults.storeWrites) return bad("injected")
      if (faults.failTransactions > 0) {
        faults.failTransactions--
        return bad("injected")
      }
      return store.transaction(f)
    },
    collection: (c: any) => {
      const h = store.collection(c)
      return {
        ...h,
        get: (...a: Array<any>) => (faults.storeReads ? bad("injected") : h.get(...a)),
        list: (...a: Array<any>) => (faults.storeReads ? bad("injected") : Effect.tap(h.list(...a), () => Effect.sync(() => faults.onRead?.(a[0])))),
        update: (...a: Array<any>) => (faults.storeWrites ? bad("injected") : h.update(...a))
      }
    }
  })
  const wrapHandle = (handle: any) => ({
    ...handle,
    dismiss: Effect.suspend(() => (faults.dismissFails > 0 ? (faults.dismissFails--, Effect.fail(new PresentError({ reason: "busy", message: "injected" }))) : handle.dismiss))
  })
  const wrap = (ctx: any) => ({
    ...ctx,
    store: wrapStore(ctx.store),
    host: {
      ...ctx.host,
      service: (key: any) => {
        const s = ctx.host.service(key)
        if (key !== Privacy || s === undefined) return s
        return { ...s, mayReveal: (owner: any, device: any) => faults.reveal?.(owner, device) ?? s.mayReveal(owner, device) }
      }
    },
    scheduler: {
      ...ctx.scheduler,
      handle: (name: string, h: any) => {
        const counted = { ...h, run: (...a: Array<any>) => Effect.suspend(() => ((faults.runs[name] = (faults.runs[name] ?? 0) + 1), h.run(...a))) }
        faults.handlers[`job:${name}`] = counted
        return ctx.scheduler.handle(name, counted)
      }
    },
    notify: {
      ...ctx.notify,
      handle: (name: string, h: any) => {
        faults.handlers[`notify:${name}`] = h
        return ctx.notify.handle(name, h)
      },
      list: () => Effect.suspend(() => {
        if ((faults.listFails ?? 0) > 0) {
          faults.listFails!--
          return Effect.fail(new NotifyError({ reason: "busy", message: "injected" }))
        }
        return Effect.flatMap(ctx.notify.list(), (ns: any) => {
          const gate = faults.listGate
          if (gate === undefined || gate === heldListGate) return Effect.succeed(ns)
          heldListGate = gate
          return Effect.andThen(Deferred.succeed(faults.listEntered!, undefined), Effect.as(Deferred.await(gate), ns))
        })
      }),
      resolve: (...a: Array<any>) => (faults.resolveFails > 0 ? (faults.resolveFails--, Effect.fail(new NotifyError({ reason: "busy", message: "injected" }))) : ctx.notify.resolve(...a)),
      send: (r: any) => {
        if (faults.gate !== undefined) return Effect.andThen(Effect.andThen(faults.entered === undefined ? Effect.void : Deferred.succeed(faults.entered, undefined), Deferred.await(faults.gate)), ctx.notify.send(r))
        if (faults.sendFails > 0) {
          faults.sendFails--
          return Effect.fail(new NotifyError({ reason: "failed", message: "injected" }))
        }
        return Effect.tap(ctx.notify.send(r), () => Effect.sync(() => faults.afterSend?.()))
      }
    },
    present: {
      ...ctx.present,
      handle: (name: string, h: any) => {
        faults.handlers[`present:${name}`] = h
        return ctx.present.handle(name, h)
      },
      show: (...a: Array<any>) => {
        faults.shows++
        return Effect.map(ctx.present.show(...a), wrapHandle)
      }
    }
  })
  return {
    ...remindersModule,
    shared: (ctx: any) => remindersModule.shared!(wrap(ctx)),
    start: (ctx: any) =>
      Effect.map(remindersModule.start!(wrap(ctx)) as Effect.Effect<any>, (out: any) => ({
        ...out,
        tools: out.tools.map((t: any) => ({ ...t, execute: (input: unknown) => Effect.tap(t.execute(input), (r: unknown) => Effect.sync(() => void (faults.results[t.name] = r))) }))
      }))
  } as ModuleDefinition<any>
}

/** The briefing's section, gathered as the briefing gathers it, for a turn on `device`. */
export const gather = (kit: Kit, device: string, extra: Partial<BriefingRequest> = {}) =>
  Effect.gen(function*() {
    const turn = kit.turn({ device })
    const sections = yield* kit.contributions(BriefingSections, { device })
    const section = sections.find((s: any) => s.id === "reminders")
    assert.isDefined(section)
    return (yield* section!.gather({ turn, kind: "morning", length: "normal", maxSentences: 2, language: "en", now: yield* kit.now, ...extra })) as any
  })

/** A reminder set on the kitchen display in ten minutes, rung: its notification. */
export const ring = (kit: Kit, text = "call mum", when = "in ten minutes", scope?: "household") =>
  Effect.gen(function*() {
    yield* kit.tool("reminders_set", { text, when, ...(scope !== undefined ? { scope } : {}) }, { device: SAM })
    yield* kit.advance(11 * MIN)
    yield* kit.present.settle
    return (yield* kit.notify.all).filter((n) => n.state === "open").at(-1)!
  })

/** The assertion of the one-job rule: a reminder with anything owed has its one job, planned for its next moment. */
export const assertJob = (kit: Kit, id: string, opts: { readonly future?: boolean } = {}) =>
  Effect.gen(function*() {
    const row = (yield* allRows(kit)).find((r) => r.id === id)!
    const v = row.value
    const owed = v.state === "open" ? v.dueAt !== undefined || v.owed !== undefined || v.ring?.snoozeUntil !== undefined || v.stop !== undefined : v.stop !== undefined
    const jobs = yield* jobOf(kit, id)
    if (!owed) return
    assert.strictEqual(jobs.length, 1, "one live job while anything is owed")
    assert.strictEqual(jobs[0]?.dueAt, v.nextAt, "the job is planned for the row's next moment")
    if (opts.future === true) assert.isAbove(jobs[0]!.dueAt, yield* kit.now, "…which is a future moment")
  })

/** The result the model got from a tool (its first line is the JSON). */
export const forModel = (r: { readonly content: string }) => JSON.parse(r.content.split("\n")[0]!)
