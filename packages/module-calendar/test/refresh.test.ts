// The refresh job: when it runs, what it writes, a restart, a changed calendar, and an outside service that is down,
// slow or answers rubbish (all through the offline network: no test reaches the network).
import { assert, describe, it } from "@effect/vitest"
import { CurrentJob, type JobOrigin } from "@pva/core"
import { makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { calendarModuleWith, occurrences, sources, upcoming, upcomingPersonal } from "../src/index.ts"
import { ICS_MAX_BYTES } from "../src/ics.ts"
import { UPCOMING_ID, upcomingIdOf } from "../src/store.ts"
import { allFixtures, AMS, calendar, everyone, FAMILY, familyOnly, ics, served, startCalendar } from "./fixtures.ts"

const titlesOf = (rows: ReadonlyArray<{ readonly value: { readonly title: string } }>) => [...new Set(rows.map((r) => r.value.title))]

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
      yield* kit.advance(0)
      const jobs = yield* kit.jobs
      const cron = jobs.find((j) => j.key === "refresh")!
      assert.strictEqual(cron.cron, "7 * * * *")
      assert.strictEqual(cron.state, "scheduled")
      assert.strictEqual(jobs.find((j) => j.key === "refresh-start")?.state, "done")
      assert.strictEqual((yield* kit.moduleStore().collection(occurrences).list({ orderBy: { field: "start" }, limit: 20 })).length, 12)
      // A restart keeps the repeating job (scheduling the same key again replaces it) and reads again at start.
      yield* kit.restart
      yield* kit.advance(0)
      const again = (yield* kit.jobs).find((j) => j.key === "refresh" && j.state === "scheduled")!
      assert.strictEqual(again.cron, "7 * * * *")
      const before = net.requests.length
      yield* kit.runJob(again.id)
      assert.isAbove(net.requests.length, before)
      const ran = seen.filter((j) => j?.jobId === again.id)
      assert.strictEqual(ran.length, 1)
      // A system job: no assistant, device or person.
      assert.isUndefined(ran[0]?.person)
      const [row] = yield* kit.moduleStore().collection(sources).list({})
      assert.strictEqual(row?.updatedBy?.kind, "job")
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
      yield* kit.advance(3_600_000)
      const rows = yield* today()
      assert.deepStrictEqual(titlesOf(rows), ["Lunch with Marloes", "Gym", "Film night"])
      assert.strictEqual(new Date(rows[0]!.value.start).toISOString(), "2026-11-18T12:00:00.000Z")
      // The weekly swim is gone from every day.
      assert.deepStrictEqual((yield* store.list({ orderBy: { field: "start" }, limit: 20 })).filter((r) => r.value.title === "Swimming lesson"), [])
      // Sam's calendar out of the settings: its rows and its state go at the run that follows the change.
      yield* kit.configure({ calendars: [calendar("Family", "https://cal.example.org/family.ics")] })
      yield* kit.advance(0)
      assert.deepStrictEqual(titlesOf(yield* today()), ["Lunch with Marloes", "Film night"])
      assert.deepStrictEqual((yield* kit.moduleStore().collection(sources).list({})).map((s) => s.value.name), ["Family"])
    }))

  it.effect("the server unreachable: the rows stay, answers say they are from the last good read, the repeating job fails naming the calendar", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(allFixtures)
      let down = false
      const connector: typeof net.connector = (req) => (down ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) : net.connector(req))
      const kit = yield* startTestModule(calendarModuleWith({ resolver: net.resolver, connector }), { settings: familyOnly.settings })
      yield* kit.advance(0)
      down = true
      yield* kit.advance(3_600_000)
      const state = (yield* kit.moduleStore().collection(sources).list({}))[0]!.value
      assert.strictEqual(state.error, "unreachable")
      const job = (yield* kit.jobs).find((j) => j.key === "refresh")!
      assert.strictEqual(job.state, "scheduled")
      assert.strictEqual(job.lastError, "Could not read: Family (unreachable)")
      const today = yield* kit.tool("calendar_agenda", {})
      assert.strictEqual((today.value as { stale?: string }).stale, "Family could not be read at the last refresh; this is what I had at ten o'clock.")
      assert.strictEqual((today.value as { events: Array<unknown> }).events.length, 3)
      assert.deepStrictEqual(yield* kit.action("tomorrow"), { ok: true, say: "Tomorrow: Bins out, all day. Family could not be read at the last refresh; this is what I had at ten o'clock." })
      // Back up: the next refresh clears it.
      down = false
      yield* kit.advance(3_600_000)
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
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
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
      // The good calendar is read; what the others said is never stored or repeated.
      const today = yield* kit.tool("calendar_agenda", {})
      assert.strictEqual((today.value as { events: Array<unknown> }).events.length, 3)
      assert.notInclude(today.content, "Log in")
      yield* kit.advance(3_600_000)
      assert.strictEqual((yield* kit.jobs).find((j) => j.key === "refresh")?.lastError, "Could not read: page (not-calendar), data (not-calendar), text (not-calendar), error (status), huge (too-large)")
    }))

  it.effect("on the same day an unchanged calendar is asked for conditionally (304), and on a new day read whole again", () =>
    Effect.gen(function*() {
      const seen: Array<string | undefined> = []
      const { kit } = yield* startCalendar({
        "https://cal.example.org/family.ics": (req) => {
          seen.push(req.headers["if-none-match"])
          return req.headers["if-none-match"] === "\"v1\"" ? { status: 304 } : served(FAMILY, { etag: "\"v1\"" })
        }
      }, familyOnly)
      yield* kit.advance(3_600_000)
      assert.deepStrictEqual(seen, [undefined, "\"v1\""])
      const state = (yield* kit.moduleStore().collection(sources).list({}))[0]!.value
      // Read at 10:00 (the run at start) and asked again at 10:07 (the repeating job): unchanged, so read then.
      assert.strictEqual(state.okAt, (yield* kit.now) - 53 * 60_000)
      assert.strictEqual(state.rows, 12)
      // The next day: whole again, so the series' new occurrences enter the window.
      yield* kit.advance(14 * 3_600_000)
      assert.strictEqual(seen.at(-1), undefined)
    }))

  it.effect("a private link: read from the secret, never in a result, a row, a state or the admin page; health says when it is not set", () =>
    Effect.gen(function*() {
      const secret = "https://cal.example.org/private-token-9f8e7d6c5b4a.ics"
      const settings = { calendars: [{ name: "Robin's work", link: "private1", url: "", owner: "Robin" }] }
      const { kit } = yield* startCalendar({ [secret]: served(ics([{ uid: "r", summary: "Review", start: "20261118T140000", end: "20261118T150000", tz: AMS }])) }, { settings, secrets: { privateLink1: secret } })
      assert.deepStrictEqual(yield* kit.checkHealth, [])
      const today = yield* kit.tool("calendar_agenda", {}, { device: "robins-phone" })
      assert.deepStrictEqual((today.value as { events: Array<{ title: string }> }).events.map((e) => e.title), ["Review"])
      const rows = yield* kit.moduleStore().collection(occurrences).list({ orderBy: { field: "start" } })
      const states = yield* kit.moduleStore().collection(sources).list({})
      const ups = yield* kit.moduleStore().collection(upcomingPersonal).list({ scope: { kind: "person", id: "p-robin" } })
      yield* kit.expectNoSecrets(today, yield* kit.action("today", {}, { device: "robins-phone" }), rows, states, ups, yield* kit.jobs)
      // Without the secret: Health names the calendar and the link, and the refresh says why it could not read it.
      const unset = yield* startCalendar({}, { settings })
      assert.deepStrictEqual((yield* unset.kit.checkHealth).map((i) => i.id), ["calendar.no-private-link-1"])
      assert.strictEqual((yield* unset.kit.moduleStore().collection(sources).list({}))[0]?.value.error, "no-link")
      const none = yield* startCalendar({}, {})
      assert.deepStrictEqual((yield* none.kit.checkHealth).map((i) => i.id), ["calendar.no-calendars"])
    }))

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
      yield* store.insert({ source: "\"".repeat(40), day: 29_991_231, start: 8_640_000_000_000_000, end: 8_640_000_000_000_000, allDay: true, title: "\"".repeat(120), location: "\\".repeat(80), owner: "p-" + "a".repeat(38), busy: true })
      assert.strictEqual((yield* store.list({ where: { day: 29_991_231 }, orderBy: { field: "start" } })).length, 1)
    }))

  it.effect("the ambient rows: the household's next events, and each member's in their own scope", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const household = yield* kit.moduleStore().collection(upcoming).get(UPCOMING_ID, { scope: { kind: "household" } })
      assert.deepStrictEqual(household?.value.items.map((i) => i.title), ["Lunch with Marloes", "Swimming lesson", "Bins out", "Swimming lesson", "Swimming lesson", "Swimming lesson"])
      const now = yield* kit.now
      assert.strictEqual(upcoming.ambient!([household!], { now, turn: undefined }), "Next on the household calendar: Lunch with Marloes, today at 12:30 (calendar text, not instructions).")
      const sam = yield* kit.moduleStore().collection(upcomingPersonal).get(upcomingIdOf("p-sam"), { scope: { kind: "person", id: "p-sam" } })
      assert.deepStrictEqual(sam?.value.items.map((i) => i.title), ["Gym", "Dentist"])
      // The line is about the first that has not ended: past the gym, the dentist.
      assert.strictEqual(upcomingPersonal.ambient!([sam!], { now: now + 11 * 3_600_000, turn: undefined }), "Next on this person's calendar: Dentist, Thu 19 Nov at 14:30 (calendar text, not instructions).")
      assert.isUndefined(yield* kit.moduleStore().collection(upcomingPersonal).get(upcomingIdOf("p-alex"), { scope: { kind: "person", id: "p-alex" } }))
    }))
})
