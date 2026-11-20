// The evening-before reminder of bin day ("the paper bin goes out tomorrow") through the real host, scheduler and
// notification service of the test kit: a job of the module's own at the owner's time sends one `normal` notification to
// every screen, once per collection, after an outage within the late rule, and not from a copy too old to trust.
// The calendar is read by real workers (`offThread`), the clock is the test clock (Wednesday 18 November 2026, 10:00 in
// Amsterdam when a test starts).
import { assert, describe, it } from "@effect/vitest"
import { type ModuleDefinition, type ModuleStore, NotifyError, StoreError } from "@pva/core"
import { checkModule, makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { binDayModule, nextLocalMidnight, REMIND_JOB, REMIND_LATE_MS, REMIND_TIMES, reminded, REMINDED_ID, texts } from "../src/binDay.ts"
import { allDay, calendarPath, calendarUrl, householdCalendar, ics, icsHeaders } from "./fixtures.ts"

// Several of these tests run days of test-clock time with a worker for each refresh.
vi.setConfig({ testTimeout: 30_000 })

const HOUR = 3_600_000
const amsterdam = { home: { HOME_TIME_ZONE: "Europe/Amsterdam" } }
const dutch = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } }
/** The default household's three screens (the shared, the private and the public one), and a speaker that cannot show a card. */
const screens = [
  { id: "kitchen-display", name: "Kitchen display", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam" },
  { id: "robins-phone", name: "Robin's phone", room: "Bedroom", privacy: "private", defaultPerson: "p-robin" },
  { id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: null }
] as const
const speaker = { id: "office-speaker", name: "Office speaker", room: "Office", capabilities: { v: 1, speaker: { media: ["speech"] } } } as const
const settings = (remindAt: string) => ({ icsUrl: calendarUrl, remindAt })

/** A calendar served while `up` says so, else 503. */
const switchable = (body: string = householdCalendar) => {
  const state = { up: true }
  const net = makeOfflineNet({ [calendarPath]: () => (state.up ? { body, headers: icsHeaders } : { status: 503, body: "down" }) })
  return { state, net }
}
const moduleOn = (net: ReturnType<typeof makeOfflineNet>) => binDayModule({ resolver: net.resolver, connector: net.connector })

type Kit = Effect.Success<ReturnType<typeof startTestModule>>
type Job = Effect.Success<Kit["jobs"]>[number]
/** What a job's row says of its progress: it changes when a run starts, fails, ends or plans the next occurrence. */
const progress = (j: Job) => JSON.stringify([j.state, j.dueAt, j.attempt, j.lastError, j.failedAt, j.finishedAt, j.rev])
const snapshot = (kit: Kit) => Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.module === "bin-day"))
/**
 * Wait, in real time, until the jobs the clock just made due have had their outcome (their row has moved past what it was
 * before the call, and none is running): a refresh reads the calendar in a worker the test clock does not move, so
 * `advance` returns while a job has not begun or still runs. No fixed sleeps, no raised limit.
 */
const settle = (kit: Kit, before: ReadonlyArray<Job> = []) =>
  Effect.gen(function*() {
    const now = yield* kit.now
    for (let i = 0; i < 600; i++) {
      const jobs = yield* snapshot(kit)
      const due = before.filter((b) => b.state === "scheduled" && b.dueAt <= now)
      const waiting = due.some((b) => {
        const j = jobs.find((x) => x.id === b.id)
        return j !== undefined && progress(j) === progress(b)
      })
      if (!waiting && !jobs.some((j) => j.state === "running")) return
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    }
    assert.fail("a job did not finish")
  })
const advance = (kit: Kit, ms: number) =>
  Effect.gen(function*() {
    const before = yield* snapshot(kit)
    yield* kit.advance(ms)
    yield* settle(kit, before)
  })
/** The test clock at `hour:minute` Amsterdam time on a day of November 2026 (winter time: UTC + 1). */
const atLocal = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute)
const advanceTo = (kit: Kit, at: number) => Effect.flatMap(kit.now, (now) => advance(kit, at - now))
/** The clock on to `at` while the module is stopped: its jobs are due and cannot run, so there is nothing to wait for. */
const quietTo = (kit: Kit, at: number) => Effect.flatMap(kit.now, (now) => kit.advance(at - now))
/** The reminders sent: what each said, and when (a key is one collection). */
const sent = (kit: Kit) => Effect.map(kit.notify.all, (all) => all.map((n) => ({ key: n.key, title: n.title, text: n.text, priority: n.priority, target: n.target, state: n.state, sentAt: n.sentAt })))
/** The test household with its copy read (two seconds after the start). */
const started = (net: ReturnType<typeof makeOfflineNet>, options: Parameters<typeof startTestModule>[1] = { household: amsterdam }) =>
  Effect.gen(function*() {
    const kit = yield* startTestModule(moduleOn(net), { settings: settings("19:00"), ...options })
    yield* advance(kit, 5_000)
    return kit
  })

describe("bin-day: the reminder the evening before", () => {
  it.effect("conformance: its new setting and texts are in both languages, with and without the reminder set", () =>
    Effect.gen(function*() {
      yield* checkModule(binDayModule(), { texts, settings: settings("19:00") })
      yield* checkModule(binDayModule(), { texts, settings: settings("off") })
      assert.strictEqual(REMIND_TIMES.length, 13)
    }))

  it.effect("off by default: no reminder job is made and nothing is sent, however many evenings pass", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net, { household: amsterdam, settings: { icsUrl: calendarUrl } })
      assert.isFalse((yield* kit.jobs).some((j) => j.key === REMIND_JOB))
      yield* advanceTo(kit, atLocal(20, 23))
      assert.deepStrictEqual(yield* sent(kit), [])
    }))

  it.effect("at the owner's time the evening before: one normal notification to every screen, saying which bin goes out tomorrow; a day with no collection tomorrow says nothing", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net, { household: { ...amsterdam, devices: [...screens, speaker] } })
      const job = (yield* kit.jobs).find((j) => j.key === REMIND_JOB)!
      assert.deepStrictEqual([job.cron, job.late], ["0 19 * * *", { withinMs: REMIND_LATE_MS }])
      // Before the set time: nothing.
      yield* advanceTo(kit, atLocal(18, 18, 59))
      assert.deepStrictEqual(yield* sent(kit), [])
      // At 19:00 on the 18th: GFT is tomorrow.
      yield* advanceTo(kit, atLocal(18, 19, 1))
      const [first] = yield* kit.notify.all
      assert.deepStrictEqual(yield* sent(kit), [{ key: "bin-day:20261119", title: "Bin day tomorrow", text: "The green bin (GFT) goes out tomorrow.", priority: "normal", target: "everywhere", state: "open", sentAt: atLocal(18, 19) }])
      // Every device was a candidate: the shared, private and public ones show a silent card, the speaker cannot show it.
      const decided = kit.notify.decisions.filter((d) => d.id === first!.id)
      const verdict = (d: (typeof decided)[number]) => [d.deviceId, d.decision.deliver ? `card${d.decision.sound ? " and ring" : ""}` : d.decision.why]
      assert.deepStrictEqual([...new Set(decided.map((d) => JSON.stringify(verdict(d))))].sort().map((j) => JSON.parse(j)), [
        ["hall-screen", "card"], ["kitchen-display", "card"], ["office-speaker", "cannot-show"], ["robins-phone", "card"]
      ])
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) {
        assert.isTrue(kit.notify.messages.some((m) => m.deviceId === device && m.message.type === "notification.ring"), device)
      }
      // It is silent: nothing rings.
      assert.deepStrictEqual(kit.notify.engine.ringingOn("kitchen-display"), [])
      // The 19th evening: paper is tomorrow (20th). The 20th evening: nothing is collected on the 21st, so nothing is said.
      yield* advanceTo(kit, atLocal(19, 19, 1))
      assert.deepStrictEqual((yield* sent(kit)).filter((n) => n.state === "open").map((n) => [n.key, n.text]), [["bin-day:20261120", "The paper bin goes out tomorrow."]])
      yield* advanceTo(kit, atLocal(20, 19, 1))
      assert.deepStrictEqual((yield* sent(kit)).filter((n) => n.state === "open" || n.key === "bin-day:20261121"), [])
    }))

  it.effect("in Dutch, with several bins on one day named together, and the time chosen decides when", () =>
    Effect.gen(function*() {
      const { net } = switchable(ics([allDay("a", "20261119", "GFT"), allDay("b", "20261119", "Papier")]))
      const kit = yield* started(net, { household: dutch, settings: settings("20:30") })
      assert.strictEqual((yield* kit.jobs).find((j) => j.key === REMIND_JOB)!.cron, "30 20 * * *")
      yield* advanceTo(kit, atLocal(18, 20, 29))
      assert.deepStrictEqual(yield* sent(kit), [])
      yield* advanceTo(kit, atLocal(18, 20, 31))
      assert.deepStrictEqual((yield* sent(kit)).map((n) => [n.title, n.text]), [["Morgen is het afvaldag", "De groene container (GFT) en de papiercontainer gaan morgen aan de weg."]])
    }))

  it.effect("once per collection: the owner dismissing it, moving the time, or a restart in between sends the same collection no second time; the next collection is reminded", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      const [first] = yield* kit.notify.all
      // The person stops the card: it is resolved, so its key is free again, but the collection was reminded.
      assert.deepStrictEqual(yield* kit.notify.press(first!.id, "stop", { device: "kitchen-display" }), { ok: true, say: "Done." })
      yield* kit.restart
      // The restart kept the live job (it was not replaced: an occurrence due while down would be lost), and the owner moves the time later.
      assert.strictEqual((yield* kit.jobs).filter((j) => j.key === REMIND_JOB && j.state === "scheduled").length, 1)
      yield* kit.configure({ remindAt: "21:00" })
      yield* advanceTo(kit, atLocal(18, 21, 5))
      assert.deepStrictEqual((yield* sent(kit)).map((n) => [n.key, n.state]), [["bin-day:20261119", "resolved"]])
      // The next evening the next collection is reminded, once.
      yield* advanceTo(kit, atLocal(19, 21, 5))
      assert.deepStrictEqual((yield* sent(kit)).filter((n) => n.state === "open").map((n) => n.key), ["bin-day:20261120"])
    }))

  it.effect("the notification is true until midnight, then it ends: tomorrow is today", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      const [n] = yield* kit.notify.all
      assert.strictEqual(n!.expiresAt, atLocal(19, 0))
      yield* advanceTo(kit, atLocal(19, 0, 1))
      const [after] = yield* kit.notify.all
      assert.deepStrictEqual([after!.state, after!.outcome], ["resolved", "expired"])
    }))

  it.effect("turning the reminder off calls the job off; one that runs meanwhile does nothing", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net)
      assert.isTrue((yield* kit.jobs).some((j) => j.key === REMIND_JOB && j.state === "scheduled"))
      yield* kit.configure({ remindAt: "off" })
      assert.isFalse((yield* kit.jobs).some((j) => j.key === REMIND_JOB && j.state === "scheduled"))
      yield* advanceTo(kit, atLocal(18, 23))
      assert.deepStrictEqual(yield* sent(kit), [])
    }))

  it.effect("an outage within the late rule: the reminder is sent when the module is back, once; later than the rule, or after midnight, it is not", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      // Down from 18:30 to 20:00 (an hour late): sent on the way back, once.
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 18, 30))
      yield* kit.stop
      yield* quietTo(kit, atLocal(18, 20))
      yield* kit.start
      yield* advance(kit, 60_000)
      assert.deepStrictEqual((yield* sent(kit)).map((n) => n.key), ["bin-day:20261119"])
      // Down from 18:30 to 22:30 (three and a half hours late, past the rule): missed, nothing sent.
      const late = yield* started(net)
      yield* advanceTo(late, atLocal(18, 18, 30))
      yield* late.stop
      yield* quietTo(late, atLocal(18, 22, 30))
      yield* late.start
      yield* advance(late, 60_000)
      assert.deepStrictEqual(yield* sent(late), [])
      // A reminder at 22:00, found at 00:30 (within the rule, but "tomorrow" is another day by then): not sent.
      const night = yield* started(net, { household: amsterdam, settings: settings("22:00") })
      yield* advanceTo(night, atLocal(18, 21, 30))
      yield* night.stop
      yield* quietTo(night, atLocal(19, 0, 30))
      yield* night.start
      yield* advance(night, 60_000)
      assert.deepStrictEqual(yield* sent(night), [])
    }))

  it.effect("a copy too old to trust sends nothing: it is refreshed first, and when that fails nothing is said; a refresh that works sends it", () =>
    Effect.gen(function*() {
      const calendar = ics([allDay("g", "20261122", "GFT"), allDay("p", "20261123", "Papier")])
      const { state, net } = switchable(calendar)
      const kit = yield* started(net)
      const copyReadAt = atLocal(18, 10)
      // The service goes away for three days: the copy of the 18th is older than two days on the evening of the 21st.
      state.up = false
      yield* advanceTo(kit, atLocal(21, 18, 30))
      yield* advanceTo(kit, atLocal(21, 19, 5))
      assert.isAtLeast(atLocal(21, 19) - copyReadAt, 48 * HOUR)
      assert.deepStrictEqual(yield* sent(kit), [])
      // The same evening a day later with the service back: the copy is refreshed first, and then the reminder is true.
      state.up = true
      yield* advanceTo(kit, atLocal(22, 19, 5))
      assert.deepStrictEqual((yield* sent(kit)).map((n) => [n.key, n.text]), [["bin-day:20261123", "The paper bin goes out tomorrow."]])
    }))

  it.effect("a calendar that may not be complete says so in the reminder, and nothing more than is known", () =>
    Effect.gen(function*() {
      const { net } = switchable(ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART:nonsense\r\nSUMMARY:Glas\r\nEND:VEVENT", allDay("g", "20261119", "GFT")]))
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      assert.deepStrictEqual((yield* sent(kit)).map((n) => n.text), ["The green bin (GFT) goes out tomorrow. The calendar may not be complete."])
    }))

  it.effect("the calendar's words are outside text: many bins on one day, long names and an emoji at the limit still give a valid notification of at most 200 characters", () =>
    Effect.gen(function*() {
      const names = Array.from({ length: 12 }, (_, i) => `Special collection number ${i} ${"x".repeat(26)}`)
      const emoji = `${"E".repeat(59)}😀`
      const { net } = switchable(ics([...names.map((n, i) => allDay(`u${i}`, "20261119", n)), allDay("e", "20261119", emoji)]))
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      const [n] = yield* sent(kit)
      assert.isDefined(n, "a notification was sent")
      assert.isAtMost(n!.text!.length, 200)
      assert.isAtMost(n!.title.length, 60)
      assert.match(n!.text!, /and \w+ more go out tomorrow\.$/)
      assert.notMatch(n!.text!, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    }))

  it.effect("no link, or an invalid one: the job finds nothing to remind of and sends nothing", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* startTestModule(moduleOn(net), { settings: { remindAt: "19:00" }, household: amsterdam })
      yield* advanceTo(kit, atLocal(18, 19, 5))
      assert.deepStrictEqual(yield* sent(kit), [])
      assert.strictEqual(net.requests.length, 0)
    }))
})

// ---------------------------------------------------------------------------------------------------------------------
// What the review found (docs/modules/bin-day.md, "Review"): faults between the delivery and its receipt, a calendar that
// changes under a delivered reminder, and decisions that must be taken at the moment of sending. The module's store, settings
// and notification service are wrapped by the test's hooks, between what the module reads and what it does.

interface Hooks {
  /** The next transaction fails with this (the receipt write): once. */
  failNextTransaction?: StoreError | undefined
  /** Every read of the calendar's copy waits for this first, in real time (the handler is "running" meanwhile, after it read the settings). */
  gate?: Promise<void> | undefined
  /** The next `notify.resolve` fails: once. */
  failNextResolve?: boolean | undefined
  /** What the module's live settings say from now on (as the host's latest accepted state would), over its own. */
  settingsOverride?: Record<string, unknown> | undefined
  /** What the module's own job row says its state is (a job called off or replaced meanwhile is `cancelled`). */
  jobState?: "cancelled" | undefined
  failed: number
}

const hookStore = (raw: ModuleStore, hooks: Hooks): ModuleStore => ({
  moduleId: raw.moduleId,
  readOnly: raw.readOnly,
  collection: (c) => {
    const h = raw.collection(c)
    return { ...h, get: (id, o) => Effect.andThen(hooks.gate === undefined || c.name !== "copy" ? Effect.void : Effect.promise(() => hooks.gate!), h.get(id, o)) }
  },
  transaction: (f) =>
    Effect.suspend(() => {
      const fault = hooks.failNextTransaction
      if (fault === undefined) return raw.transaction(f)
      hooks.failNextTransaction = undefined
      hooks.failed++
      return Effect.fail(fault)
    })
})

const hookedOn = (hooks: Hooks, net: ReturnType<typeof makeOfflineNet>): ModuleDefinition<any> => {
  const m = moduleOn(net)
  return {
    ...m,
    shared: (ctx) =>
      m.shared!({
        ...ctx,
        store: hookStore(ctx.store, hooks),
        settingsFor: (assistant) => {
          const v = ctx.settingsFor(assistant)
          return hooks.settingsOverride === undefined || v === undefined ? v : { ...v, ...hooks.settingsOverride }
        },
        scheduler: {
          ...ctx.scheduler,
          get: (id) => (hooks.jobState === undefined ? ctx.scheduler.get(id) : Effect.map(ctx.scheduler.get(id), (row) => (row === undefined ? row : { ...row, state: hooks.jobState! })))
        },
        notify: {
          ...ctx.notify,
          resolve: (target, outcome) => {
            if (hooks.failNextResolve !== true) return ctx.notify.resolve(target, outcome)
            hooks.failNextResolve = false
            hooks.failed++
            return Effect.fail(new NotifyError({ reason: "failed", message: "test: resolve fails" }))
          }
        }
      })
  }
}
const newHooks = (): Hooks => ({ failed: 0 })
const receiptOf = (kit: Kit) => Effect.map(kit.moduleStore().collection(reminded).get(REMINDED_ID), (r) => r?.value)
const hooksKit = (hooks: Hooks, net: ReturnType<typeof makeOfflineNet>, options: Parameters<typeof startTestModule>[1] = { household: amsterdam }) =>
  Effect.gen(function*() {
    const kit = yield* startTestModule(hookedOn(hooks, net), { settings: settings("19:00"), ...options })
    yield* advance(kit, 5_000)
    return kit
  })

describe("review: delivered at least once, with the receipt failing", () => {
  it.effect("the receipt write fails once after delivery, the card still open: the retry only writes the receipt, nothing is shown twice", () =>
    Effect.gen(function*() {
      const hooks = newHooks()
      const { net } = switchable()
      const kit = yield* hooksKit(hooks, net)
      hooks.failNextTransaction = new StoreError({ reason: "failed", message: "test: failed" })
      yield* advanceTo(kit, atLocal(18, 19, 0) + 1_000)
      assert.strictEqual(hooks.failed, 1)
      assert.deepStrictEqual([(yield* sent(kit)).map((n) => n.state), yield* receiptOf(kit)], [["open"], undefined])
      // The scheduler's retry (5 s): the open card with that key is not delivered again, and the receipt is written.
      yield* advance(kit, 6_000)
      assert.deepStrictEqual((yield* sent(kit)).map((n) => [n.key, n.state]), [["bin-day:20261119", "open"]])
      assert.deepStrictEqual((yield* receiptOf(kit))?.state, "sent")
      assert.strictEqual((yield* receiptOf(kit))?.day, 20261119)
    }))

  it.effect("the receipt write fails once and the person dismissed the card meanwhile: the retry shows it again, none is ever lost; then the receipt holds", () =>
    Effect.gen(function*() {
      const hooks = newHooks()
      const { net } = switchable()
      const kit = yield* hooksKit(hooks, net)
      hooks.failNextTransaction = new StoreError({ reason: "failed", message: "test: failed" })
      yield* advanceTo(kit, atLocal(18, 19, 0) + 1_000)
      const [first] = yield* kit.notify.all
      assert.deepStrictEqual(yield* kit.notify.press(first!.id, "stop", { device: "kitchen-display" }), { ok: true, say: "Done." })
      yield* advance(kit, 6_000)
      assert.deepStrictEqual((yield* sent(kit)).map((n) => [n.key, n.state]), [["bin-day:20261119", "resolved"], ["bin-day:20261119", "open"]])
      assert.strictEqual((yield* receiptOf(kit))?.state, "sent")
      // With the receipt written, a dismissed card is not shown again.
      const [, second] = yield* kit.notify.all
      yield* kit.notify.press(second!.id, "stop", { device: "kitchen-display" })
      yield* kit.configure({ remindAt: "21:00" })
      yield* advanceTo(kit, atLocal(18, 21, 5))
      assert.strictEqual((yield* sent(kit)).length, 2)
    }))

  it.effect("the receipt is written as the job: on the row and on the event", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      const job = (yield* kit.jobs).find((j) => j.key === REMIND_JOB && j.state === "scheduled")!
      const row = yield* kit.moduleStore().collection(reminded).get(REMINDED_ID)
      const actor = { kind: "job" as const, jobId: (yield* kit.jobs).filter((j) => j.key === REMIND_JOB).map((j) => j.id).find((id) => JSON.stringify(row?.updatedBy).includes(id)) ?? "none" }
      assert.deepStrictEqual(row?.updatedBy, actor)
      assert.strictEqual(job.handler, "remind")
      const events = kit.events.filter((e) => e.type === "bin-day.reminded.changed")
      assert.isAtLeast(events.length, 1)
      assert.isTrue(events.every((e) => e.actor?.kind === "job"))
      // The update (a withdrawal later) is the job's too: the receipt is written again by the daily job's occurrence.
      assert.strictEqual(row?.value.state, "sent")
    }))
})

describe("review: a reminder that stopped being true is taken away", () => {
  const moved = ics([allDay("g", "20261120", "GFT"), allDay("p", "20261125", "Papier")])
  it.effect("delivered, then the collection moves: the next refresh resolves the card by its key and the receipt says so; a cancelled one too", () =>
    Effect.gen(function*() {
      const calendar = { body: householdCalendar }
      const net = makeOfflineNet({ [calendarPath]: () => ({ body: calendar.body, headers: icsHeaders }) })
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      assert.deepStrictEqual((yield* sent(kit)).map((n) => n.state), ["open"])
      // GFT moves from the 19th to the 20th; the restart's refresh (the copy is more than six hours old) reads it.
      calendar.body = moved
      yield* kit.restart
      yield* advance(kit, 3_000)
      const [card] = yield* kit.notify.all
      assert.deepStrictEqual([card!.state, card!.outcome], ["resolved", "calendar-changed"])
      assert.strictEqual((yield* receiptOf(kit))?.state, "withdrawn")
      // The card was not replaced by another one: the moved collection is reminded on its own evening.
      yield* advanceTo(kit, atLocal(19, 19, 1))
      assert.deepStrictEqual((yield* sent(kit)).filter((n) => n.state === "open").map((n) => n.key), ["bin-day:20261120"])
      // Cancelled: the same evening, the collection is gone from the calendar.
      const gone = ics([allDay("p", "20261125", "Papier")])
      const calendar2 = { body: householdCalendar }
      const net2 = makeOfflineNet({ [calendarPath]: () => ({ body: calendar2.body, headers: icsHeaders }) })
      const kit2 = yield* started(net2)
      yield* advanceTo(kit2, atLocal(18, 19, 1))
      calendar2.body = gone
      yield* kit2.restart
      yield* advance(kit2, 3_000)
      assert.deepStrictEqual((yield* kit2.notify.all).map((n) => [n.state, n.outcome]), [["resolved", "calendar-changed"]])
    }))

  it.effect("a withdrawal that fails stays owed, and is tried again at the next start (a restart in between)", () =>
    Effect.gen(function*() {
      const hooks = newHooks()
      const calendar = { body: householdCalendar }
      const net = makeOfflineNet({ [calendarPath]: () => ({ body: calendar.body, headers: icsHeaders }) })
      const kit = yield* hooksKit(hooks, net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      calendar.body = moved
      hooks.failNextResolve = true
      yield* kit.restart
      yield* advance(kit, 3_000)
      assert.strictEqual(hooks.failed, 1)
      // Still on every screen, and the receipt owes its withdrawal.
      assert.deepStrictEqual((yield* sent(kit)).map((n) => n.state), ["open"])
      assert.strictEqual((yield* receiptOf(kit))?.state, "owed")
      // The next start tries again, with the calendar as it is now, and succeeds.
      yield* kit.restart
      yield* advance(kit, 3_000)
      assert.deepStrictEqual((yield* kit.notify.all).map((n) => [n.state, n.outcome]), [["resolved", "calendar-changed"]])
      assert.strictEqual((yield* receiptOf(kit))?.state, "withdrawn")
    }))

  it.effect("a reminder is not taken away while the calendar still says it: a refresh of the same calendar, or a day the copy cannot speak for", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* started(net)
      yield* advanceTo(kit, atLocal(18, 19, 1))
      yield* kit.restart
      yield* advance(kit, 3_000)
      assert.deepStrictEqual((yield* sent(kit)).map((n) => n.state), ["open"])
      assert.strictEqual((yield* receiptOf(kit))?.state, "sent")
    }))
})

describe("review: everything is decided at the moment of sending", () => {
  /** A gate the handler's read of the copy waits on, in real time; `open()` lets it go on. */
  const gated = (hooks: Hooks) => {
    let open: () => void = () => undefined
    hooks.gate = new Promise<void>((resolve) => (open = resolve))
    return () => {
      hooks.gate = undefined
      open()
    }
  }

  /**
   * The handler waits (on the copy's read) after it read the settings; what the module then sees as its live state changes;
   * the handler goes on. `change` is what the host's latest accepted state or the job's row would say by then.
   */
  const waitingWhile = (change: (hooks: Hooks) => void, net: ReturnType<typeof makeOfflineNet>, run: (kit: Kit) => Effect.Effect<void> = () => Effect.void) =>
    Effect.gen(function*() {
      const hooks = newHooks()
      const kit = yield* hooksKit(hooks, net)
      const open = gated(hooks)
      yield* quietTo(kit, atLocal(18, 19, 0))
      change(hooks)
      open()
      yield* advance(kit, 10_000)
      yield* run(kit)
      return kit
    })

  it.effect("the reminder switched off while the handler waits: nothing is sent; the same wait with nothing changed sends (so it was the check)", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      assert.deepStrictEqual(yield* sent(yield* waitingWhile((h) => void (h.settingsOverride = { remindAt: "off" }), net)), [])
      assert.deepStrictEqual((yield* sent(yield* waitingWhile(() => undefined, net))).map((n) => n.key), ["bin-day:20261119"])
    }))

  it.effect("the time changed while the handler waits ends that run: nothing is sent; the reminder comes at the new time", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* waitingWhile((h) => void (h.settingsOverride = { remindAt: "20:00" }), net)
      assert.deepStrictEqual(yield* sent(kit), [])
    }))

  it.effect("the link changed while the handler waits: the old link's calendar is not announced", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* waitingWhile((h) => void (h.settingsOverride = { icsUrl: `${calendarUrl}&other=1` }), net)
      assert.deepStrictEqual(yield* sent(kit), [])
    }))

  it.effect("the job called off or replaced while its handler runs (its row is no longer the running one): nothing is sent", () =>
    Effect.gen(function*() {
      const { net } = switchable()
      const kit = yield* waitingWhile((h) => void (h.jobState = "cancelled"), net)
      assert.deepStrictEqual(yield* sent(kit), [])
    }))

  it.effect("the real thing: the reminder switched off in the settings while the handler waits sends nothing (the host ends the old run)", () =>
    Effect.gen(function*() {
      const hooks = newHooks()
      const { net } = switchable()
      const kit = yield* hooksKit(hooks, net)
      const open = gated(hooks)
      yield* quietTo(kit, atLocal(18, 19, 0))
      yield* kit.configure({ remindAt: "off" })
      open()
      yield* advance(kit, 10_000)
      assert.deepStrictEqual(yield* sent(kit), [])
    }))

  it.effect("a handler that starts before midnight and would send after it sends nothing: \"tomorrow\" would be another day", () =>
    Effect.gen(function*() {
      const hooks = newHooks()
      const { net } = switchable()
      const kit = yield* hooksKit(hooks, net, { household: amsterdam, settings: settings("22:00") })
      yield* advanceTo(kit, atLocal(18, 21, 30))
      yield* kit.stop
      yield* quietTo(kit, atLocal(18, 23, 59) + 58_000)
      const open = gated(hooks)
      yield* kit.start
      // The handler began at 23:59:58 (within its late rule); the clock reaches midnight while it waits.
      yield* kit.advance(5_000)
      open()
      yield* advance(kit, 1_000)
      assert.isAbove(yield* kit.now, atLocal(19, 0))
      assert.deepStrictEqual(yield* sent(kit), [])
    }))
})

describe("review: the card ends when the next local date begins in the household's zone", () => {
  it("the instant the next local date begins, in zones whose offset changes before that midnight, and at the year's end", () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    // Amsterdam, an ordinary evening and the night the clocks go back.
    assert.strictEqual(iso(nextLocalMidnight(Date.UTC(2026, 10, 18, 18), "Europe/Amsterdam")), "2026-11-18T23:00:00.000Z")
    assert.strictEqual(iso(nextLocalMidnight(Date.UTC(2026, 9, 24, 18), "Europe/Amsterdam")), "2026-10-24T22:00:00.000Z")
    // Nuuk: the clocks go forward on the evening of 28 March, so the date changes an hour earlier than 7 hours on.
    assert.strictEqual(iso(nextLocalMidnight(Date.UTC(2026, 2, 28, 21), "America/Nuuk")), "2026-03-29T01:00:00.000Z")
    // Santiago: the clocks go back at midnight on 5 April, so the day is an hour longer.
    assert.strictEqual(iso(nextLocalMidnight(Date.UTC(2026, 3, 4, 22), "America/Santiago")), "2026-04-05T04:00:00.000Z")
    // The year's end.
    assert.strictEqual(iso(nextLocalMidnight(Date.UTC(2026, 11, 31, 20), "Europe/Amsterdam")), "2026-12-31T23:00:00.000Z")
  })

  const cases = [
    { zone: "Europe/Amsterdam", from: Date.UTC(2026, 10, 18, 9), collection: "20261119", at: Date.UTC(2026, 10, 18, 18), ends: "2026-11-18T23:00:00.000Z" },
    { zone: "America/Nuuk", from: Date.UTC(2026, 2, 28, 19), collection: "20260329", at: Date.UTC(2026, 2, 28, 21), ends: "2026-03-29T01:00:00.000Z" },
    { zone: "America/Santiago", from: Date.UTC(2026, 3, 4, 20), collection: "20260405", at: Date.UTC(2026, 3, 4, 22), ends: "2026-04-05T04:00:00.000Z" }
  ]
  for (const c of cases) {
    it.effect(`${c.zone}: the reminder at 19:00 local ends exactly when the next local date begins`, () =>
      Effect.gen(function*() {
        const { net } = switchable(ics([allDay("g", c.collection, "GFT")]))
        const kit = yield* startTestModule(moduleOn(net), { settings: settings("19:00"), household: { home: { HOME_TIME_ZONE: c.zone } }, startAt: c.from })
        yield* advance(kit, 5_000)
        yield* advanceTo(kit, c.at + 60_000)
        const [n] = yield* kit.notify.all
        assert.isDefined(n, "a reminder was sent")
        assert.strictEqual(new Date(n!.expiresAt).toISOString(), c.ends)
      }))
  }
})
