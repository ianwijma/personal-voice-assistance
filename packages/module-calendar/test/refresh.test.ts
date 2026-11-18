// The refresh job: when it runs, what it writes (a generation, published whole), a restart, a store failure, a
// changed calendar, and an outside service that is down, slow, answers rubbish or echoes the private link (all
// through the offline network: no test reaches the network). And how long the main thread is held while it runs.
import { assert, describe, it } from "@effect/vitest"
import { CurrentJob, type JobOrigin, offThread, offThreadTask } from "@pva/core"
import { makeOfflineNet, offThreadWorkers, startTestModule } from "@pva/core/testing"
import { Effect, Fiber } from "effect"
import { calendarModule, calendarModuleWith, occurrences, sources } from "../src/index.ts"
import { ICS_MAX_BYTES } from "../src/provider.ts"
import { batchOf, linkPrint } from "../src/store.ts"
import {
  advanceAndRefresh,
  advanceToNextJob,
  allFixtures,
  AMS,
  calendar,
  controlledStore,
  everyone,
  FAMILY,
  familyOnly,
  heartbeat,
  ics,
  refreshed,
  served,
  sleepReal,
  startCalendar
} from "./fixtures.ts"
import { vi } from "vitest"

// These tests expand whole calendars (and some start real workers): on a slow two-core CI runner one of them can take
// longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 })

const titlesOf = (rows: ReadonlyArray<{ readonly value: { readonly title: string } }>) => [...new Set(rows.map((r) => r.value.title))]
const eventsOf = (value: unknown) => ((value as { events?: Array<{ title: string; time?: string }> }).events ?? []).map((e) => `${e.title}${e.time !== undefined ? ` ${e.time}` : ""}`)

/** Every row of the module's occurrences, page by page. */
const allRows = (kit: Effect.Success<ReturnType<typeof startCalendar>>["kit"]) =>
  Effect.gen(function*() {
    const store = kit.moduleStore().collection(occurrences)
    const out: Array<Effect.Success<ReturnType<typeof store.list>>[number]> = []
    let after: (typeof out)[number] | undefined
    for (;;) {
      const page = yield* store.list({ orderBy: { field: "start" }, limit: 20, ...(after !== undefined ? { after } : {}) })
      out.push(...page)
      if (page.length < 20) return out
      after = page.at(-1)
    }
  })

const stateOf = (kit: Effect.Success<ReturnType<typeof startCalendar>>["kit"], name = "Family") =>
  Effect.map(kit.moduleStore().collection(sources).list({}), (rows) => rows.find((r) => r.value.name === name)?.value)

/** Wait (real time, at most 20 s) until `check` holds. */
const until = (check: () => boolean) =>
  Effect.gen(function*() {
    for (let i = 0; i < 4_000 && !check(); i++) yield* sleepReal(5)
    assert.isTrue(check(), "the condition was never met")
  })

describe("calendar: the refresh job", () => {
  it.effect("a repeating refresh by the setting and one run at start; the repeating job outlives a restart and runs as the job", () =>
    Effect.gen(function*() {
      const seen: Array<JobOrigin | undefined> = []
      const net = makeOfflineNet(allFixtures)
      const base = calendarModuleWith({ resolver: net.resolver, connector: net.connector })
      // The module with what its handler sees as `CurrentJob`, recorded (a test's own wrapper).
      const recording: typeof base = {
        ...base,
        shared: (ctx) =>
          base.shared!({
            ...ctx,
            scheduler: {
              ...ctx.scheduler,
              handle: (name, handler) => ctx.scheduler.handle(name, { ...handler, run: (p, due) => Effect.andThen(Effect.flatMap(CurrentJob, (j) => Effect.sync(() => void seen.push(j))), handler.run(p, due)) })
            }
          })
      }
      const kit = yield* startTestModule(recording, { settings: familyOnly.settings })
      yield* advanceAndRefresh(kit, 0)
      const jobs = yield* kit.jobs
      const cron = jobs.find((j) => j.key === "refresh")!
      assert.strictEqual(cron.cron, "7 * * * *")
      assert.strictEqual(cron.state, "scheduled")
      assert.strictEqual(jobs.find((j) => j.key === "refresh-start")?.state, "done")
      assert.strictEqual((yield* allRows(kit)).length, 12)
      // A restart keeps the repeating job (scheduling the same key again replaces it) and reads again at start.
      yield* kit.restart
      yield* advanceAndRefresh(kit, 0)
      const again = (yield* kit.jobs).find((j) => j.key === "refresh" && j.state === "scheduled")!
      assert.strictEqual(again.cron, "7 * * * *")
      const before = net.requests.length
      yield* kit.runJob(again.id)
      yield* refreshed(kit)
      assert.isAbove(net.requests.length, before)
      const ran = seen.filter((j) => j?.jobId === again.id)
      assert.strictEqual(ran.length, 1)
      // A system job: no assistant, device or person.
      assert.isUndefined(ran[0]?.person)
      const [row] = yield* kit.moduleStore().collection(sources).list({})
      assert.strictEqual(row?.updatedBy?.kind, "job")
      // One generation's rows only, whatever ran before.
      assert.strictEqual((yield* allRows(kit)).length, 12)
      // Every 15 minutes, by the setting.
      yield* kit.configure({ refresh: "15" })
      assert.strictEqual((yield* kit.jobs).find((j) => j.key === "refresh" && j.state === "scheduled")?.cron, "*/15 * * * *")
    }))

  it.effect("a changed calendar: new, moved and gone events after the next refresh; a calendar taken out of the settings takes its rows", () =>
    Effect.gen(function*() {
      let body = FAMILY
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body), "https://cal.example.org/sam.ics": served(ics([{ uid: "g", summary: "Gym", start: "20261118T190000", end: "20261118T200000", tz: AMS }])) }, {
        settings: { calendars: [calendar("Family", "https://cal.example.org/family.ics"), calendar("Sam's", "https://cal.example.org/sam.ics", "Sam")] }
      })
      const store = kit.moduleStore().collection(occurrences)
      const today = () => store.list({ where: { day: 20261118 }, orderBy: { field: "start" } })
      assert.deepStrictEqual(titlesOf(yield* today()), ["Standup", "Lunch with Marloes", "Swimming lesson", "Gym"])
      body = ics([
        { uid: "lunch", summary: "Lunch with Marloes", start: "20261118T130000", end: "20261118T140000", tz: AMS },
        { uid: "film", summary: "Film night", start: "20261118T200000", end: "20261118T220000", tz: AMS }
      ])
      yield* advanceAndRefresh(kit, 3_600_000)
      const rows = yield* today()
      assert.deepStrictEqual(titlesOf(rows), ["Lunch with Marloes", "Gym", "Film night"])
      assert.strictEqual(new Date(rows[0]!.value.start).toISOString(), "2026-11-18T12:00:00.000Z")
      assert.deepStrictEqual((yield* allRows(kit)).filter((r) => r.value.title === "Swimming lesson"), [])
      // Sam's calendar out of the settings: its rows and its state go at the run that follows the change.
      yield* kit.configure({ calendars: [calendar("Family", "https://cal.example.org/family.ics")] })
      yield* advanceAndRefresh(kit, 0)
      assert.deepStrictEqual(titlesOf(yield* today()), ["Lunch with Marloes", "Film night"])
      assert.deepStrictEqual((yield* kit.moduleStore().collection(sources).list({})).map((s) => s.value.name), ["Family"])
    }))

  it.effect("the server unreachable: the last generation stays, answers say since when, the repeating job fails naming the calendar", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(allFixtures)
      let down = false
      const connector: typeof net.connector = (req) => (down ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) : net.connector(req))
      const kit = yield* startTestModule(calendarModuleWith({ resolver: net.resolver, connector }), { settings: familyOnly.settings })
      yield* advanceAndRefresh(kit, 0)
      down = true
      yield* advanceAndRefresh(kit, 3_600_000)
      const state = (yield* kit.moduleStore().collection(sources).list({}))[0]!.value
      assert.strictEqual(state.error, "unreachable")
      const job = (yield* kit.jobs).find((j) => j.key === "refresh")!
      assert.strictEqual(job.state, "scheduled")
      assert.strictEqual(job.lastError, "Could not read: Family (unreachable)")
      const today = yield* kit.tool("calendar_agenda", {})
      assert.strictEqual((today.value as { stale?: string }).stale, "Family could not be refreshed since today at ten o'clock; this is what I had then.")
      assert.strictEqual((today.value as { events: Array<unknown> }).events.length, 3)
      assert.deepStrictEqual(yield* kit.action("tomorrow"), { ok: true, say: "Tomorrow: Bins out, all day. Family could not be refreshed since today at ten o'clock; this is what I had then." })
      // Back up: the next refresh clears it.
      down = false
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.isUndefined((yield* kit.moduleStore().collection(sources).list({}))[0]!.value.error)
      assert.isUndefined(((yield* kit.tool("calendar_agenda", {})).value as { stale?: string }).stale)
    }))

  it.effect("a slow server: the fetch's time limit ends the request, and the calendar is marked unreachable", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(allFixtures)
      // A server that accepts the connection and never answers, until the request is given up.
      const silent: typeof net.connector = (req) => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true }))
      const kit = yield* startTestModule(calendarModuleWith({ resolver: net.resolver, connector: silent, fetchTimeoutMs: 50 }), { settings: familyOnly.settings })
      for (let i = 0; i < 50 && (yield* kit.moduleStore().collection(sources).list({})).length === 0; i++) {
        yield* kit.advance(0)
        yield* sleepReal(20)
      }
      assert.strictEqual((yield* kit.moduleStore().collection(sources).list({}))[0]?.value.error, "unreachable")
      assert.deepStrictEqual((yield* kit.tool("calendar_agenda", {})).value, { spoken: "The calendars have not been read yet. Try again in a minute." })
    }))

  it.effect("rubbish: a web page, JSON, text that is no calendar, a server error and a file too large are each a reason of their own", () =>
    Effect.gen(function*() {
      const fixtures = {
        "https://a.example.org/page.ics": { body: "<html><body>Log in</body></html>", headers: { "content-type": "text/html" } },
        "https://a.example.org/data.ics": { body: { events: [] } },
        "https://a.example.org/text.ics": served("this is not a calendar"),
        "https://a.example.org/error.ics": { status: 500, ...served("BEGIN:VCALENDAR") },
        "https://a.example.org/huge.ics": served(ics([]) + "X".repeat(ICS_MAX_BYTES)),
        "https://a.example.org/ok.ics": served(FAMILY)
      }
      const names = ["page", "data", "text", "error", "huge", "ok"]
      const { kit } = yield* startCalendar(fixtures, { settings: { calendars: names.map((n) => calendar(n, `https://a.example.org/${n}.ics`)) } })
      const states = new Map((yield* kit.moduleStore().collection(sources).list({})).map((s) => [s.value.name, s.value.error ?? "ok"]))
      assert.deepStrictEqual(Object.fromEntries(states), { page: "not-calendar", data: "not-calendar", text: "not-calendar", error: "status", huge: "too-large", ok: "ok" })
      // The good calendar is read; what the others said is never stored or repeated; the others are named as not read.
      const today = yield* kit.tool("calendar_agenda", {})
      assert.strictEqual((today.value as { events: Array<unknown> }).events.length, 3)
      assert.strictEqual((today.value as { notRead?: string }).notRead, "page, data, text and two more has not been read yet, so its events are not in this.")
      assert.notInclude(today.content, "Log in")
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.strictEqual((yield* kit.jobs).find((j) => j.key === "refresh")?.lastError, "Could not read: page (not-calendar), data (not-calendar), text (not-calendar), error (status), huge (too-large)")
    }))

  it.effect("finding 13: a file cut off after a good read is a failed refresh; the last good generation stays and the answer says so", () =>
    Effect.gen(function*() {
      const good = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000Z", end: "20261118T150000Z" }])
      let body = good
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, familyOnly)
      const okAt = (yield* stateOf(kit))!.okAt
      for (const cut of ["BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:unfinished\r\nDTSTART:20261118T140000Z\r\n", good.replace("END:VCALENDAR\r\n", "")]) {
        body = cut
        yield* advanceAndRefresh(kit, 3_600_000)
        const state = (yield* stateOf(kit))!
        assert.strictEqual(state.error, "not-calendar")
        assert.strictEqual(state.okAt, okAt)
        const today = (yield* kit.tool("calendar_agenda", {})).value as { events: Array<{ title: string }>; stale?: string }
        assert.deepStrictEqual(today.events.map((e) => e.title), ["Dentist"])
        assert.include(today.stale!, "Family could not be refreshed since today at ten o'clock")
      }
    }))

  it.effect("finding 14 and 15: events that could not be read are counted and said; a calendar over a limit is a failed refresh, never a part of it", () =>
    Effect.gen(function*() {
      const partial = ics([
        { uid: "bad", summary: "Bad", start: "2026-11-20 nonsense" },
        { uid: "dentist", summary: "Dentist", start: "20261120T100000", end: "20261120T110000", tz: AMS }
      ])
      let body = partial
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, familyOnly)
      assert.strictEqual((yield* stateOf(kit))!.unreadable, 1)
      const friday = (yield* kit.tool("calendar_agenda", { day: "Friday" })).value as { events: Array<unknown>; incomplete?: string }
      assert.strictEqual(friday.incomplete, "Family could be read only in part: 1 events could not be read.")
      assert.deepStrictEqual(yield* kit.action("today"), { ok: true, say: "Today: nothing on the calendar. Family could be read only in part: 1 events could not be read." })
      // 3,100 events: more occurrences than a calendar keeps. Not the first 3,000 as if they were all: a failed refresh.
      body = ics(Array.from({ length: 3_100 }, (_, i) => ({ uid: `e${i}`, summary: `E${i}`, start: i < 3_000 ? "20261119T100000Z" : "20261120T100000Z", end: i < 3_000 ? "20261119T101000Z" : "20261120T101000Z" })))
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.strictEqual((yield* stateOf(kit))!.error, "too-many")
      const after = (yield* kit.tool("calendar_agenda", { day: "Friday" })).value as { events: Array<{ title: string }>; stale?: string }
      assert.deepStrictEqual(after.events.map((e) => e.title), ["Dentist"])
      assert.include(after.stale!, "could not be refreshed since")
      // Never read whole: nothing is said to be on it, or free.
      const first = yield* startCalendar({ "https://cal.example.org/family.ics": served(body) }, familyOnly)
      assert.deepStrictEqual((yield* first.kit.tool("calendar_agenda", { day: "Friday" })).value, { spoken: "The calendars have not been read yet. Try again in a minute." })
      assert.deepStrictEqual((yield* first.kit.tool("calendar_free", { day: "Friday" })).value, { spoken: "The calendars have not been read yet. Try again in a minute." })
    }))

  it.effect("finding 16: an event is on every day of the window it covers, and one going on after the last day kept says so", () =>
    Effect.gen(function*() {
      const body = ics([
        { uid: "trip", summary: "Trip", start: "20261118", end: "20261215" },
        { uid: "since", summary: "Exhibition", start: "20261101", end: "20261125" },
        { uid: "long", summary: "Course", start: "20261201", end: "20270315" }
      ])
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": served(body) }, familyOnly)
      for (const day of ["2026-12-01", "2026-12-02", "2026-12-10", "2026-12-14"]) {
        assert.include(eventsOf((yield* kit.tool("calendar_agenda", { day })).value), "Trip", day)
      }
      assert.notInclude(eventsOf((yield* kit.tool("calendar_agenda", { day: "2026-12-15" })).value), "Trip")
      const today = (yield* kit.tool("calendar_agenda", {})).value as { events: Array<unknown> }
      assert.deepStrictEqual(today.events, [
        { title: "Exhibition", allDay: true, from: "Sunday the first of November 2026", to: "Tuesday", calendar: "Family" },
        { title: "Trip", allDay: true, from: "today", to: "Monday the fourteenth of December", calendar: "Family" }
      ])
      const later = (yield* kit.tool("calendar_agenda", { day: "2027-01-19" })).value as { events: Array<unknown>; continues?: string }
      assert.deepStrictEqual(later.events, [{ title: "Course", allDay: true, from: "Tuesday the first of December", continuesAfter: "Tuesday the nineteenth of January 2027", calendar: "Family" }])
      assert.strictEqual(later.continues, "Some of these go on after Tuesday the nineteenth of January 2027, the last day I have.")
      assert.strictEqual((yield* allRows(kit)).filter((r) => r.value.title === "Trip").length, 27)
    }))

  it.effect("finding 18: a refresh is published whole: while it writes, answers are of the last generation; after it, of the new one only", () =>
    Effect.gen(function*() {
      let body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS }])
      const { control, store } = controlledStore()
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, { ...familyOnly, wrap: { store } })
      body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T160000", end: "20261118T170000", tz: AMS }])
      // Hold the first transaction after the new generation's rows were written (its publication).
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      let held = false
      const base = control.insertedRows
      control.beforeTransaction = ({ insertedRows }) => {
        if (insertedRows > base && !held) {
          held = true
          return gate
        }
        return undefined
      }
      yield* advanceToNextJob(kit)
      yield* until(() => held)
      assert.isAbove(control.insertedRows, base)
      // The new row is written, not published: the answer is the last generation's, whole.
      assert.deepStrictEqual(eventsOf((yield* kit.tool("calendar_agenda", {})).value), ["Dentist two o'clock"])
      release()
      yield* refreshed(kit)
      assert.deepStrictEqual(eventsOf((yield* kit.tool("calendar_agenda", {})).value), ["Dentist four o'clock"])
      const rows = yield* allRows(kit)
      const state = (yield* stateOf(kit))!
      assert.deepStrictEqual(rows.map((r) => r.value.batch), [batchOf("Family", state.gen!)])
      assert.isUndefined(state.writing)
      assert.isUndefined(state.old)
    }))

  it.effect("finding 26: a store failure in the middle of a refresh leaves the last generation; the next refresh removes what it wrote", () =>
    Effect.gen(function*() {
      let body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS }])
      const { control, store } = controlledStore()
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, { ...familyOnly, wrap: { store } })
      body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T160000", end: "20261118T170000", tz: AMS }])
      const base = control.insertedRows
      let failed = false
      control.beforeTransaction = ({ insertedRows }) => {
        if (insertedRows > base && !failed) {
          failed = true
          return "fail"
        }
        return undefined
      }
      // The run at 10:07, and nothing after it (its retry comes five seconds later).
      yield* advanceToNextJob(kit)
      yield* refreshed(kit)
      assert.isTrue(failed)
      const state = (yield* stateOf(kit))!
      assert.strictEqual(state.error, "store")
      assert.isDefined(state.writing)
      const today = (yield* kit.tool("calendar_agenda", {})).value as { events: Array<{ title: string; time: string }>; stale?: string }
      assert.deepStrictEqual(eventsOf(today), ["Dentist two o'clock"])
      assert.include(today.stale!, "could not be refreshed")
      assert.strictEqual((yield* kit.jobs).find((j) => j.key === "refresh")?.lastError, "Could not read: Family (store)")
      // The store works again: the next run (the job's retry) removes the half-written generation and publishes a new one.
      yield* advanceAndRefresh(kit, 60_000)
      const after = (yield* stateOf(kit))!
      assert.isUndefined(after.error)
      assert.isUndefined(after.writing)
      assert.deepStrictEqual((yield* allRows(kit)).map((r) => r.value.batch), [batchOf("Family", after.gen!)])
      assert.deepStrictEqual(eventsOf((yield* kit.tool("calendar_agenda", {})).value), ["Dentist four o'clock"])
    }))

  it.effect("finding 26: a restart between writing a generation and publishing it; the refresh after the restart cleans up and publishes", () =>
    Effect.gen(function*() {
      let body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS }])
      const { control, store } = controlledStore()
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, { ...familyOnly, wrap: { store } })
      body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T160000", end: "20261118T170000", tz: AMS }])
      const base = control.insertedRows
      let held = false
      control.beforeTransaction = ({ insertedRows }) => {
        if (insertedRows > base && !held) {
          held = true
          return new Promise<void>(() => undefined) // never: the restart cuts the refresh short here
        }
        return undefined
      }
      yield* advanceToNextJob(kit)
      yield* until(() => held)
      const written = (yield* stateOf(kit))!
      assert.isDefined(written.writing)
      assert.notStrictEqual(written.writing, written.gen)
      // Between writing and publishing: the old generation is the answer, the new one is in the store unseen.
      assert.deepStrictEqual(eventsOf((yield* kit.tool("calendar_agenda", {})).value), ["Dentist two o'clock"])
      assert.strictEqual(new Set((yield* allRows(kit)).map((r) => r.value.batch)).size, 2)
      yield* kit.restart
      yield* advanceAndRefresh(kit, 0)
      yield* advanceAndRefresh(kit, 0)
      const state = (yield* stateOf(kit))!
      assert.isUndefined(state.writing)
      assert.deepStrictEqual((yield* allRows(kit)).map((r) => r.value.batch), [batchOf("Family", state.gen!)])
      assert.deepStrictEqual(eventsOf((yield* kit.tool("calendar_agenda", {})).value), ["Dentist four o'clock"])
    }), 60_000)

  it.effect("finding 19: a conditional request only against a generation of the same link, owner and zone; on a new day read whole again", () =>
    Effect.gen(function*() {
      const seen: Array<string | undefined> = []
      const answer = (req: { readonly headers: Readonly<Record<string, string>> }) => {
        seen.push(req.headers["if-none-match"])
        return req.headers["if-none-match"] === "\"v1\"" ? { status: 304 } : served(FAMILY, { etag: "\"v1\"" })
      }
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": answer, "https://cal.example.org/other.ics": answer }, familyOnly)
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.deepStrictEqual(seen, [undefined, "\"v1\""])
      const state = (yield* stateOf(kit))!
      // Read at 10:00 (the run at start) and asked again at 10:07 (the repeating job): unchanged, so read then.
      assert.strictEqual(state.okAt, (yield* kit.now) - 53 * 60_000)
      assert.strictEqual(state.rows, 12)
      // The owner changes on the same day: the validator is not used, the calendar is read whole for Sam.
      yield* kit.configure({ calendars: [calendar("Family", "https://cal.example.org/family.ics", "Sam")] })
      yield* advanceAndRefresh(kit, 0)
      assert.strictEqual(seen.at(-1), undefined)
      const sam = (yield* kit.tool("calendar_agenda", { who: "me" }, { device: "kitchen-display" })).value as { events: Array<unknown>; owner?: string }
      assert.strictEqual(sam.events.length, 3)
      assert.strictEqual(sam.owner, "p-sam")
      // The address changes: read whole too.
      yield* kit.configure({ calendars: [calendar("Family", "https://cal.example.org/other.ics", "Sam")] })
      yield* advanceAndRefresh(kit, 0)
      assert.strictEqual(seen.at(-1), undefined)
      // From the same address for the same owner on the same day, the validator is used again.
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.strictEqual(seen.at(-1), "\"v1\"")
      // Every hour until midnight with the validator; the first run of the next day whole again (the window moved on, and
      // a series' new occurrences enter it); then with the validator again.
      const mark = seen.length
      yield* advanceAndRefresh(kit, 14 * 3_600_000)
      assert.deepStrictEqual(seen.slice(mark), [...Array.from({ length: 12 }, () => "\"v1\""), undefined, "\"v1\""])
    }))

  it.effect("finding 3: a calendar whose owner changed is not read out under its old owner, also while it cannot be read again", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(allFixtures)
      let down = false
      const connector: typeof net.connector = (req) => (down ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) : net.connector(req))
      const kit = yield* startTestModule(calendarModuleWith({ resolver: net.resolver, connector }), { settings: familyOnly.settings })
      yield* advanceAndRefresh(kit, 0)
      assert.strictEqual(eventsOf((yield* kit.tool("calendar_agenda", {}, { device: "hall-screen" })).value).length, 3)
      // The family calendar becomes Sam's while its server is down: nothing of it is read out as the household's.
      down = true
      yield* kit.configure({ calendars: [calendar("Family", "https://cal.example.org/family.ics", "Sam")] })
      yield* advanceAndRefresh(kit, 0)
      for (const device of ["hall-screen", "robins-phone", "kitchen-display"]) {
        const r = yield* kit.tool("calendar_agenda", {}, { device })
        assert.deepStrictEqual(r.value, { spoken: "The calendars have not been read yet. Try again in a minute." }, device)
      }
      // No ambient line holds the calendar: the module declares none.
      for (const c of calendarModule.storage?.collections ?? []) assert.isUndefined((c as { ambient?: unknown }).ambient, c.name)
      assert.sameMembers((calendarModule.storage?.collections ?? []).map((c) => c.name), ["occurrences", "sources"])
    }))

  it.effect("finding 2: a private link the server echoes (in the calendar's name, a title, a place, a UID, its ETag, an error page) is never stored, said or reported", () =>
    Effect.gen(function*() {
      const secret = "https://cal.example.org/private-token-9f8e7d6c5b4a.ics"
      const echo = ics([
        { uid: "r", summary: `Review ${secret}`, start: "20261118T140000", end: "20261118T150000", tz: AMS, location: `${"x".repeat(70)} ${secret}` },
        { uid: secret, summary: "Its UID", start: "20261118T160000", end: "20261118T170000", tz: AMS },
        { uid: "e", summary: "Encoded https%3A%2F%2Fcal.example.org%2Fprivate-token-9f8e7d6c5b4a.ics", start: "20261118T180000", end: "20261118T190000", tz: AMS }
      ], [`X-WR-CALNAME:${secret}`])
      let failing = false
      const settings = { calendars: [{ name: "Robin's work", link: "private1", url: "", owner: "Robin" }] }
      const { kit } = yield* startCalendar({
        [secret]: () => (failing ? { status: 500, ...served(`<html>${secret} is not here</html>`) } : served(echo, { etag: `"${secret}"` }))
      }, { settings, secrets: { privateLink1: secret } })
      assert.deepStrictEqual(yield* kit.checkHealth, [])
      const today = yield* kit.tool("calendar_agenda", {}, { device: "robins-phone" })
      assert.deepStrictEqual(eventsOf(today.value), ["an event two o'clock", "an event six o'clock"])
      const said = yield* kit.action("today", {}, { device: "robins-phone" })
      failing = true
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.strictEqual((yield* stateOf(kit, "Robin's work"))?.error, "status")
      const rows = yield* allRows(kit)
      const states = yield* kit.moduleStore().collection(sources).list({})
      assert.isUndefined(states[0]?.value.etag)
      yield* kit.expectNoSecrets(today, said, yield* kit.tool("calendar_find", { text: "token" }, { device: "robins-phone" }), rows, states, yield* kit.jobs, kit.issues())
      for (const text of [JSON.stringify(rows), JSON.stringify(states), JSON.stringify(yield* kit.jobs)]) assert.notInclude(text, "9f8e7d6c5b4a")
      // What is kept of the link: 16 hex digits of SHA-256 over a label and the address, in the state row only (and so
      // in that row's change on the in-process bus, which no page is sent), never in what a tool, an action, a job or
      // Health says, nor in an occurrence row.
      const print = linkPrint(secret)
      assert.match(print, /^[0-9a-f]{16}$/)
      assert.strictEqual(states[0]?.value.link, print)
      for (const text of [today.content, JSON.stringify(said), JSON.stringify(yield* kit.jobs), JSON.stringify(kit.issues()), JSON.stringify(rows)]) assert.notInclude(text, print)
      assert.isTrue(kit.events.filter((e) => JSON.stringify(e).includes(print)).every((e) => e.type === "calendar.sources.changed"))
      // Without the secret: Health names the calendar and the link, and the refresh says why it could not read it.
      const unset = yield* startCalendar({}, { settings })
      assert.deepStrictEqual((yield* unset.kit.checkHealth).map((i) => i.id), ["calendar.no-private-link-1"])
      assert.strictEqual((yield* unset.kit.moduleStore().collection(sources).list({}))[0]?.value.error, "no-link")
      const none = yield* startCalendar({}, {})
      assert.deepStrictEqual((yield* none.kit.checkHealth).map((i) => i.id), ["calendar.no-calendars"])
    }))

  it.effect("deciding review 1: a private link's file-name stem and query value, reflected without the rest of the link, are never stored, said or kept as a validator", () =>
    Effect.gen(function*() {
      for (const [secret, parts] of [
        ["https://cal.example.org/private/long-secret-123456789.ics", ["long-secret-123456789"]],
        ["https://cal.example.org/p/abcd1234.ics", ["abcd1234"]],
        ["https://cal.example.org/private/k3y-1234567.ics", ["k3y-1234567"]],
        ["https://cal.example.org/feed.ics?token=tok-98765", ["tok-98765"]]
      ] as const) {
        const part = parts[0]
        const echo = ics([
          { uid: "one", summary: `Token ${part}`, location: part, start: "20261118T140000", end: "20261118T150000", tz: AMS },
          { uid: "two", summary: `Upper ${part.toUpperCase()}`, start: "20261118T160000", end: "20261118T170000", tz: AMS }
        ])
        const seen: Array<string | undefined> = []
        const settings = { calendars: [{ name: "Robin's work", link: "private1", url: "", owner: "Robin" }] }
        const { kit } = yield* startCalendar({
          [secret]: (req: { readonly headers: Readonly<Record<string, string>> }) => {
            seen.push(req.headers["if-none-match"])
            return served(echo, { etag: `"${part}"` })
          }
        }, { settings, secrets: { privateLink1: secret } })
        const phone = { device: "robins-phone" }
        const today = yield* kit.tool("calendar_agenda", {}, phone)
        assert.deepStrictEqual(eventsOf(today.value), ["an event two o'clock", "an event four o'clock"], secret)
        const said = yield* kit.action("today", {}, phone)
        assert.deepStrictEqual(said, { ok: true, say: "Today: an event at two o'clock and an event at four o'clock." }, secret)
        const next = yield* kit.tool("calendar_next", {}, phone)
        const rows = yield* allRows(kit)
        const states = yield* kit.moduleStore().collection(sources).list({})
        assert.isUndefined(states[0]?.value.etag, secret)
        // No validator kept: the next refresh asks unconditionally.
        yield* advanceAndRefresh(kit, 3_600_000)
        assert.deepStrictEqual(seen, [undefined, undefined], secret)
        for (const text of [today.content, JSON.stringify(said), next.content, JSON.stringify(rows), JSON.stringify(states), JSON.stringify(yield* kit.jobs), JSON.stringify(kit.issues())]) {
          assert.notInclude(text.toLowerCase(), part.toLowerCase(), secret)
        }
      }
    }), 60_000)

  it.effect("a calendar whose owner is nobody in Members is not read at all", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* startCalendar(allFixtures, { settings: { calendars: [calendar("Kim's", "https://cal.example.org/sam.ics", "Kim")] } })
      assert.strictEqual(net.requests.length, 0)
      assert.strictEqual((yield* kit.moduleStore().collection(sources).list({}))[0]?.value.error, "owner")
      assert.deepStrictEqual(yield* kit.moduleStore().collection(occurrences).list({}), [])
    }))

  it.effect("settings that are not valid are refused: two calendars of one name, no address, an address that is not http(s)", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, familyOnly)
      for (const calendars of [
        [calendar("Family", "https://a.example.org/1.ics"), calendar("family", "https://a.example.org/2.ics")],
        [calendar("Family", "")],
        [calendar("Family", "ftp://a.example.org/x.ics")],
        [calendar("Family", "https://user:pw@a.example.org/x.ics")],
        [calendar("", "https://a.example.org/x.ics")],
        [calendar("Two\nlines", "https://a.example.org/x.ics")]
      ]) {
        const result = yield* kit.configure({ calendars })
        assert.isFalse(result.ok, JSON.stringify(calendars))
      }
      // The saved settings are unchanged, and the module still answers.
      assert.strictEqual(((yield* kit.tool("calendar_agenda", {})).value as { events: Array<unknown> }).events.length, 3)
      // A webcal:// address is read as https://.
      const webcal = yield* startCalendar(allFixtures, { settings: { calendars: [calendar("Family", "webcal://cal.example.org/family.ics")] } })
      assert.strictEqual(webcal.net.requests[0]?.url, "https://cal.example.org/family.ics")
    }))

  it.effect("a row with every indexed field at its largest is stored", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, familyOnly)
      const store = kit.moduleStore().collection(occurrences)
      yield* store.insert({
        source: "\"".repeat(40),
        batch: "\"".repeat(40),
        key: "\\".repeat(24),
        day: 29_991_231,
        start: 8_640_000_000_000_000,
        end: 8_640_000_000_000_000,
        allDay: true,
        title: "\"".repeat(120),
        location: "\\".repeat(80),
        owner: "p-" + "a".repeat(38),
        busy: true,
        beyond: true
      })
      assert.strictEqual((yield* store.list({ where: { day: 29_991_231 }, orderBy: { field: "start" } })).length, 1)
      assert.strictEqual((yield* store.list({ where: { day: 29_991_231 }, orderBy: { field: "end" } })).length, 1)
      assert.strictEqual((yield* store.list({ where: { batch: "\"".repeat(40) }, orderBy: { field: "batch" } })).length, 1)
    }))
})

describe("calendar: the reading task as the reworked offThread wants it", () => {
  /** A calendar of one event, then the file the test serves instead. */
  const one = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS }])

  /** The last good generation is still the answer, and it says it could not be refreshed. */
  const keptLast = (kit: Effect.Success<ReturnType<typeof startCalendar>>["kit"]) =>
    Effect.gen(function*() {
      const today = (yield* kit.tool("calendar_agenda", {})).value as { stale?: string }
      assert.deepStrictEqual(eventsOf(today), ["Dentist two o'clock"])
      assert.include(today.stale!, "could not be refreshed")
      const state = (yield* stateOf(kit))!
      assert.isUndefined(state.writing)
      assert.deepStrictEqual([...new Set((yield* allRows(kit)).map((r) => r.value.batch))], [batchOf("Family", state.gen!)])
    })

  it.effect("an answer far over the 128 KiB a structure may be (1,000 events) is read whole", () =>
    Effect.gen(function*() {
      const body = ics(Array.from({ length: 1_000 }, (_, i) => ({ uid: `e${i}`, summary: `${"Rehearsal ".repeat(11)}${i}`, location: "Hall ".repeat(15), start: "20261119T100000", end: "20261119T110000", tz: AMS })))
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": served(body) }, familyOnly)
      const state = (yield* stateOf(kit))!
      assert.isUndefined(state.error)
      assert.strictEqual(state.rows, 1_000)
      assert.strictEqual((yield* allRows(kit)).length, 1_000)
      // A day reads at most 200 rows, and says so.
      const tomorrow = (yield* kit.tool("calendar_agenda", { day: "tomorrow" })).value as { more: number; cut?: string }
      assert.strictEqual(tomorrow.more, 200 - 12)
      assert.isDefined(tomorrow.cut)
    }), 60_000)

  it.effect("busy: with the helper's waiting line full, the refresh fails as busy and keeps the last generation", () =>
    Effect.gen(function*() {
      let body = one
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, familyOnly)
      body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T160000", end: "20261118T170000", tz: AMS }])
      // Two slots held and 32 calls waiting: the next call is refused at once.
      const nap = offThreadTask<(input: { readonly ms: number }) => Promise<string>>(new URL("./nap.task.mjs", import.meta.url))
      const fibers = yield* Effect.forEach(Array.from({ length: 34 }), () => Effect.forkDetach(offThread(nap, { ms: 30_000 }, { timeoutMs: 40_000 })))
      const refused = yield* Effect.gen(function*() {
        yield* until(() => offThreadWorkers().queued === 32)
        yield* advanceToNextJob(kit)
        yield* refreshed(kit)
        return (yield* stateOf(kit))!.error
      }).pipe(Effect.ensuring(Effect.andThen(Fiber.interruptAll(fibers), until(() => offThreadWorkers().running === 0 && offThreadWorkers().queued === 0))))
      assert.strictEqual(refused, "busy")
      yield* keptLast(kit)
      // Tried again at the next refresh, with the slots free: read.
      yield* advanceAndRefresh(kit, 3_600_000)
      assert.isUndefined((yield* stateOf(kit))!.error)
      assert.deepStrictEqual(eventsOf((yield* kit.tool("calendar_agenda", {})).value), ["Dentist four o'clock"])
    }), 60_000)

  it.effect("input: a call the helper refuses for its input fails the refresh and keeps the last generation", () =>
    Effect.gen(function*() {
      let body = one
      // A small input limit for the test: the first file fits, a longer one does not.
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, { ...familyOnly, deps: { maxInputBytes: 4_000 } })
      assert.isUndefined((yield* stateOf(kit))!.error)
      body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T160000", end: "20261118T170000", tz: AMS, extra: [`DESCRIPTION:${"d".repeat(3_000)}`] }])
      yield* advanceToNextJob(kit)
      yield* refreshed(kit)
      assert.strictEqual((yield* stateOf(kit))!.error, "failed")
      yield* keptLast(kit)
    }), 60_000)

  it.effect("a line of the answer that cannot be read fails the whole refresh: nothing of it is written or published", () =>
    Effect.gen(function*() {
      let body = one
      const readTask = offThreadTask<typeof import("./badAnswer.task.ts").default>(new URL("./badAnswer.task.ts", import.meta.url))
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => served(body) }, { ...familyOnly, deps: { readTask } })
      assert.isUndefined((yield* stateOf(kit))!.error)
      body = ics([
        { uid: "dentist", summary: "Dentist", start: "20261118T160000", end: "20261118T170000", tz: AMS },
        { uid: "gym", summary: "Gym", start: "20261118T190000", end: "20261118T200000", tz: AMS }
      ], ["X-BROKEN:1"])
      yield* advanceToNextJob(kit)
      yield* refreshed(kit)
      assert.strictEqual((yield* stateOf(kit))!.error, "failed")
      yield* keptLast(kit)
    }), 60_000)
})
