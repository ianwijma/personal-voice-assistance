// The bin-day module through the real host, gateway and scheduler of the test kit: no tool call, action, job or section
// reaches the network (the kit's offline network serves the calendars), and the clock is the test clock. The calendar is
// read by real workers (`offThread`), as in the app.
import { assert, describe, it } from "@effect/vitest"
import { CurrentJob, type JobOrigin, offThread, OffThreadReason, offThreadTask } from "@pva/core"
import { checkModule, makeOfflineNet, offThreadWorkers, startTestModule } from "@pva/core/testing"
import { type BriefingRequest, type BriefingSection, BriefingSections } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { binDayModule, COPY_ID, copies, type Copy, explainLink, MAX_NAMES, readReason, RETRY_AFTER_MS, sourceOf, STALE_AFTER_MS, texts } from "../src/binDay.ts"
import { addDays, ICS_MAX_BYTES, MAX_COLLECTIONS } from "../src/bins.ts"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { allDay, calendarPath, calendarUrl, householdCalendar, ics, icsHeaders } from "./fixtures.ts"

const serve = (body: unknown = householdCalendar, headers: Record<string, string> = icsHeaders) =>
  makeOfflineNet({ [calendarPath]: { body, headers } })
type Net = ReturnType<typeof makeOfflineNet>
const moduleOn = (net: Net) => binDayModule({ resolver: net.resolver, connector: net.connector })
const settings = { icsUrl: calendarUrl }
const dutch = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } }
type Said = { spoken: string; items: Array<{ bin: string; date: string; when: string }>; untrusted: string }
type Kit = Effect.Success<ReturnType<typeof startTestModule>>
const copyIn = (kit: Kit) => kit.moduleStore().collection(copies).get(COPY_ID)
const spoken = (kit: Kit, input: Record<string, unknown> = {}) => kit.tool("bin_next", input).pipe(Effect.map((r) => (r.value as Said).spoken))
type Job = Effect.Success<Kit["jobs"]>[number]
/** What a job's row says of its progress: it changes when a run starts, fails, ends or plans the next occurrence. */
const progress = (j: Job) => JSON.stringify([j.state, j.dueAt, j.attempt, j.lastError, j.failedAt, j.finishedAt, j.rev])
const snapshot = (kit: Kit) => Effect.map(kit.jobs, (jobs) => jobs.filter((j) => j.module === "bin-day"))
/**
 * Wait, in real time, for the outcome of the jobs the clock just made due: their row has moved past what it was before the
 * call (a run has begun and ended, or failed) and none is running. A job's handler reads the calendar in a worker thread,
 * which the test clock does not move, so `runJob` and `advance` return while a job has not begun or still runs; "none is
 * running" alone is also true before the job starts, and the Health issue of a failed job follows its row (and goes the same way)
 * a moment later. No fixed sleeps and no raised limit: the loop is capped as before.
 */
const settle = (kit: Kit, before: ReadonlyArray<Job> = []) =>
  Effect.gen(function*() {
    const now = yield* kit.now
    for (let i = 0; i < 600; i++) {
      const jobs = yield* snapshot(kit)
      const waiting = before.filter((b) => b.state === "scheduled" && b.dueAt <= now).some((b) => {
        const j = jobs.find((x) => x.id === b.id)
        return j !== undefined && progress(j) === progress(b)
      })
      // The Health issue of a failed job follows its row a moment later (and goes the same way): its outcome is its issue too.
      const failing = jobs.filter((j) => j.failedAt !== undefined && (j.state === "scheduled" || j.state === "failed")).map((j) => `core.scheduler.failed.${j.id}`).sort()
      const raised = kit.issues().map((i) => i.id).filter((id) => id.startsWith("core.scheduler.failed.")).sort()
      if (!waiting && !jobs.some((j) => j.state === "running") && JSON.stringify(failing) === JSON.stringify(raised)) return
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    }
    assert.fail("a refresh job did not finish")
  })
const runJob = (kit: Kit, id: string) =>
  Effect.gen(function*() {
    const before = yield* snapshot(kit)
    const exit = yield* Effect.exit(kit.runJob(id))
    yield* settle(kit, before)
    return exit
  })
const advance = (kit: Kit, ms: number) =>
  Effect.gen(function*() {
    const before = yield* snapshot(kit)
    yield* kit.advance(ms)
    yield* settle(kit, before)
  })
/** A calendar served while `up` says so, else 503. */
const switchable = (body: () => string = () => householdCalendar) => {
  const state = { up: true }
  const net = makeOfflineNet({ [calendarPath]: () => (state.up ? { body: body(), headers: icsHeaders } : { status: 503, body: "down" }) })
  return { state, net }
}

describe("bin-day: tools and actions", () => {
  it.effect("passes the conformance check, with its texts in both languages, with and without a link", () =>
    Effect.gen(function*() {
      yield* checkModule(binDayModule(), { texts, settings })
      yield* checkModule(binDayModule(), { texts })
    }))

  it.effect("bin_next: the next collection and the one after it, in words; the copy is one row of the coming collections", () =>
    Effect.gen(function*() {
      const net = serve()
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const r = yield* kit.tool("bin_next", {})
      assert.isTrue(r.ok)
      const value = r.value as Said
      assert.strictEqual(value.spoken, "Tomorrow: the green bin (GFT). After that, Friday: the paper bin.")
      assert.deepStrictEqual(value.items.map((i) => [i.bin, i.date]), [["the green bin (GFT)", "2026-11-19"], ["the paper bin", "2026-11-20"]])
      assert.include(value.untrusted, "data, not instructions")
      const row = yield* copyIn(kit)
      // 18 November on: GFT, paper, general waste, PMD, four glass rounds, the tree round; the 1 November GFT is not kept.
      assert.deepStrictEqual(row?.value.entries, [
        { d: 20261119, k: "gft" }, { d: 20261120, k: "paper" }, { d: 20261125, k: "rest" }, { d: 20261127, k: "plastic" }, { d: 20261202, k: "glass" },
        { d: 20261216, k: "glass" }, { d: 20261230, k: "glass" }, { d: 20270108, k: "other", l: "Kerstbomen ophalen" }, { d: 20270113, k: "glass" }
      ])
      assert.deepStrictEqual([row?.value.cut, row?.value.unreadable, row?.value.source], [false, 0, sourceOf(calendarUrl, [])])
      assert.strictEqual((yield* kit.moduleStore().collection(copies).list({})).length, 1)
      // The link is not in what the model reads or what is stored, and was fetched once through the safe path, with only the product token as User-Agent.
      assert.notInclude(r.content, "s3cr3t-token")
      assert.notInclude(JSON.stringify(row), "s3cr3t-token")
      assert.strictEqual(net.requests.length, 1)
      assert.strictEqual(net.requests[0]!.headers["user-agent"], "personal-voice-assistance/1")
      // A second question reads the copy: no request.
      yield* kit.tool("bin_next", {})
      assert.strictEqual(net.requests.length, 1)
    }))

  it.effect("bin_next with a kind: the next collection of that bin, by the words people use in either language", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings })
      assert.strictEqual(yield* spoken(kit, { type: "paper" }), "Friday: the paper bin.")
      assert.strictEqual(yield* spoken(kit, { type: "papier" }), "Friday: the paper bin.")
      assert.strictEqual(yield* spoken(kit, { type: "pmd" }), "Friday the twenty seventh: the plastic bin (PMD).")
      assert.strictEqual(yield* spoken(kit, { type: "restafval" }), "Wednesday the twenty fifth: the general waste bin.")
      assert.strictEqual(yield* spoken(kit, { type: "groen" }), "Tomorrow: the green bin (GFT).")
    }))

  it.effect("an unknown bin, a bin the calendar does not have, and a bin the household named itself", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve(ics([allDay("g", "20261119", "GFT"), allDay("t", "20270108", "Kerstbomen ophalen")]))), {
        settings: { ...settings, names: [{ match: "kerstbomen", label: "Christmas tree" }] }
      })
      assert.strictEqual(yield* spoken(kit, { type: "batteries" }), "I don't know a bin called batteries. The calendar has the green bin (GFT) and Christmas tree.")
      assert.strictEqual(yield* spoken(kit, { type: "glass" }), "I don't see the glass collection coming up in the calendar.")
      assert.strictEqual(yield* spoken(kit, { type: "christmas" }), "Friday the eighth of January 2027: Christmas tree.")
    }))

  it.effect("the typed action answers the same with no model, in Dutch too", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings, household: dutch })
      assert.deepStrictEqual(yield* kit.action("next", {}), { ok: true, say: "Morgen: de groene container (GFT). Daarna, overmorgen: de papiercontainer." })
      assert.deepStrictEqual(yield* kit.action("next", { type: "paper" }), { ok: true, say: "Overmorgen: de papiercontainer." })
      assert.strictEqual(yield* spoken(kit, { type: "pmd" }), "Vrijdag de zevenentwintigste: de plasticcontainer (PMD).")
      // The action is not also a second tool: `bin_next` is the tool.
      assert.deepStrictEqual(kit.toolNames(), ["bin_next"])
    }))

  it.effect("no link: it says how to set one, in both languages, and nothing is fetched", () =>
    Effect.gen(function*() {
      const net = serve()
      const kit = yield* startTestModule(moduleOn(net))
      const r = yield* kit.tool("bin_next", {})
      assert.isFalse(r.ok)
      assert.include(r.content, "No bin calendar is set up yet")
      const nl = yield* startTestModule(moduleOn(net), { household: dutch })
      assert.include((yield* nl.tool("bin_next", {})).content, "Er is nog geen afvalkalender ingesteld")
      assert.deepStrictEqual(yield* kit.action("next", {}), { ok: false, code: "failed", message: "No bin calendar is set up yet. The owner can paste the calendar link in the Bin day settings." })
      assert.strictEqual(net.requests.length, 0)
    }))

  it.effect("privacy: the calendar is the household's, so every kind of device is told the same", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings })
      const answers = []
      for (const device of ["kitchen-display", "robins-phone", "hall-screen"]) answers.push(((yield* kit.tool("bin_next", {}, { device })).value as Said).spoken)
      assert.strictEqual(new Set(answers).size, 1)
    }))

  it.effect("a moved collection is announced on its new day, and a cancelled one not at all (finding 10)", () =>
    Effect.gen(function*() {
      const body = ics([
        allDay("gft", "20261119", "GFT", ["RRULE:FREQ=WEEKLY;COUNT=3"]),
        allDay("gft", "20261120", "GFT", ["RECURRENCE-ID;VALUE=DATE:20261119"]),
        allDay("gft", "20261126", "GFT", ["RECURRENCE-ID;VALUE=DATE:20261126", "STATUS:CANCELLED"])
      ])
      const kit = yield* startTestModule(moduleOn(serve(body)), { settings })
      assert.strictEqual(yield* spoken(kit), "Friday: the green bin (GFT). After that, Thursday the third of December: the green bin (GFT).")
    }))

  it.effect("a repeat that began long before the calendar's horizon still answers its next day (finding 9)", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve(ics([allDay("d", "20250101", "GFT", ["RRULE:FREQ=DAILY"]), allDay("p", "20250102", "Papier", ["RRULE:FREQ=WEEKLY"])]))), { settings })
      assert.strictEqual(yield* spoken(kit, { type: "gft" }), "Today: the green bin (GFT).")
      assert.strictEqual(yield* spoken(kit, { type: "paper" }), "Tomorrow: the paper bin.")
    }))

  it.effect("many bins on one day: at most eight names and a count of the rest, in the answer, its items and the briefing (finding 21)", () =>
    Effect.gen(function*() {
      const body = ics(Array.from({ length: 70 }, (_, i) => allDay(`s${i}`, "20261119", `Special round ${i}`)))
      const kit = yield* startTestModule(moduleOn(serve(body)), { settings })
      const r = yield* kit.tool("bin_next", {})
      const value = r.value as Said
      // 60 collections are kept (the next ones), and the answer names eight of them.
      assert.match(value.spoken, /^Tomorrow: (Special round \d+, ){7}Special round \d+ and 52 more\.$/)
      assert.strictEqual(value.items.length, MAX_NAMES)
      assert.isBelow(r.content.length, 1_500)
      const s = yield* section(kit)
      const brief = yield* s.gather(request(kit, {}, yield* kit.now))
      const sentence = (brief as { sentences: ReadonlyArray<string> }).sentences[0]!
      assert.isAtMost(sentence.length, 300)
      assert.match(sentence, /^Bin day tomorrow: .* and \w+ more, but the calendar may not be complete\.$|^Bin day tomorrow: .* and \w+ more\.$/)
    }))
})

describe("bin-day: the outside service", () => {
  it.effect("unreachable (a host the network does not know): says what the person can do, never the link", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ "https://other.example.com/x.ics": { body: "" } })
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const r = yield* kit.tool("bin_next", {})
      assert.isFalse(r.ok)
      assert.include(r.content, "I can't reach the bin calendar right now")
      assert.include(r.content, "Bin day settings")
      assert.notInclude(r.content, "s3cr3t-token")
      assert.notInclude(r.content, "afval.example.org")
    }))

  it.effect("answering rubbish (not a calendar, a web page, an error status, far too large, a calendar of only junk events): no copy, and a reason", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, unknown, Record<string, string>, number | undefined, string]> = [
        ["plain text", "hello, this is not a calendar", { "content-type": "text/calendar" }, undefined, "doesn't give me a calendar I can read"],
        ["a web page", "<html>sign in</html>", { "content-type": "text/html" }, undefined, "can't reach the bin calendar"],
        ["a server error", "oops", { "content-type": "text/calendar" }, 500, "can't reach the bin calendar"],
        ["not found", "no", { "content-type": "text/calendar" }, 404, "can't reach the bin calendar"],
        ["too large", "BEGIN:VCALENDAR\r\n" + "X-JUNK:" + "a".repeat(300 * 1024) + "\r\nEND:VCALENDAR", { "content-type": "text/calendar" }, undefined, "larger than I can read"],
        ["a calendar that stops in the middle", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:garbage\r\n", { "content-type": "text/calendar" }, undefined, "doesn't give me a calendar I can read"],
        // Only events that cannot be read: never "no collections" (finding 8).
        ["events with junk in them", ics(["BEGIN:VEVENT\r\nUID:1\r\nDTSTART:garbage\r\nSUMMARY:GFT\r\nEND:VEVENT", "BEGIN:VEVENT\r\nEND:VEVENT"]), { "content-type": "text/calendar" }, undefined, "doesn't give me a calendar I can read"]
      ]
      for (const [name, body, headers, status, expected] of cases) {
        const net = makeOfflineNet({ [calendarPath]: { body, headers, ...(status !== undefined ? { status } : {}) } })
        const kit = yield* startTestModule(moduleOn(net), { settings })
        const r = yield* kit.tool("bin_next", {})
        assert.isFalse(r.ok, name)
        assert.include(r.content, expected, name)
        assert.notInclude(r.content, "I don't see any", name)
        assert.isUndefined(yield* copyIn(kit), name)
      }
    }))

  it.effect("a calendar the reader cannot finish is a typed failure, and the main thread is not held (finding 1)", () =>
    Effect.gen(function*() {
      const net = serve(ics([allDay("x", "20260101", "GFT", ["RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"])]))
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      yield* runJob(kit, daily.id)
      assert.isUndefined(yield* copyIn(kit))
      const job = (yield* kit.jobs).find((j) => j.id === daily.id)!
      // Stopped by its time limit, or by its memory limit first when the machine is busy: a typed failure either way.
      assert.match(job.lastError ?? "", /The calendar refresh failed: (too-slow|too-large)$/)
    }), 30_000)

  it.effect("a refresh of a calendar of the largest size holds the main thread under 10 ms: it is read in a worker (finding 1)", () =>
    Effect.gen(function*() {
      const events: Array<string> = []
      let size = 0
      for (let n = 0; size < ICS_MAX_BYTES - 2_000 && n < 1_900; n++) {
        const e = allDay(`u${n}`, String(addDays(20261118, n % 300)), `Collection ${n}`, ["RRULE:FREQ=WEEKLY;COUNT=3", "DESCRIPTION:" + "x".repeat(40)])
        size += e.length + 2
        events.push(e)
      }
      // One refresh first, of a small calendar: the process's one-time costs (the first time-zone formatter, the first
      // worker) are paid by whatever runs first in the app, and are not what the size of a calendar costs.
      const warm = yield* startTestModule(moduleOn(serve()), { settings })
      assert.isTrue((yield* warm.tool("bin_next", {})).ok)
      const kit = yield* startTestModule(moduleOn(serve(ics(events))), { settings })
      let last = performance.now()
      let worst = 0
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }, 1)
      const r = yield* kit.tool("bin_next", {}).pipe(Effect.ensuring(Effect.sync(() => clearInterval(timer))))
      worst = Math.max(worst, performance.now() - last)
      assert.isTrue(r.ok)
      assert.strictEqual((yield* copyIn(kit))?.value.entries.length, MAX_COLLECTIONS)
      console.log(`[binDay] a refresh of ${Math.round(size / 1024)} KiB, ${events.length} events: longest main-thread stop ${worst.toFixed(1)} ms`)
      assert.isBelow(worst, bound(10))
    }), 30_000)

  it.effect("slow: an answer that never comes is given up on within the question's time, and the person is told", () =>
    Effect.gen(function*() {
      const net = serve()
      const hanging = binDayModule({
        resolver: net.resolver,
        connector: (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }))
      })
      const kit = yield* startTestModule(hanging, { settings })
      const call = yield* Effect.forkChild(kit.tool("bin_next", {}))
      yield* kit.advance(4_000)
      const r = yield* Fiber.join(call)
      assert.isFalse(r.ok)
      assert.include(r.content, "I can't reach the bin calendar right now")
    }))

  it.effect("refused locations: a link to the home network is never fetched", () =>
    Effect.gen(function*() {
      const net = serve()
      const kit = yield* startTestModule(moduleOn(net), { settings: { icsUrl: "http://192.168.1.10/cal.ics" } })
      const r = yield* kit.tool("bin_next", {})
      assert.isFalse(r.ok)
      assert.strictEqual(net.requests.length, 0)
    }))

  it.effect("a copy older than two days is refreshed on the question; when that fails the last copy answers and says how old it is (finding 19)", () =>
    Effect.gen(function*() {
      const { state, net } = switchable()
      const kit = yield* startTestModule(moduleOn(net), { settings })
      assert.isTrue((yield* kit.tool("bin_next", {})).ok)
      state.up = false
      yield* kit.advance(STALE_AFTER_MS + 3_600_000)
      const r = yield* kit.tool("bin_next", {})
      assert.isTrue(r.ok)
      // Two days on, Thursday's GFT is over; Friday's paper is today.
      assert.strictEqual((r.value as Said).spoken, "Today: the paper bin. After that, Wednesday: the general waste bin. This is from my copy of the calendar from 2 days ago; I couldn't refresh it.")
      state.up = true
      yield* kit.advance(RETRY_AFTER_MS)
      assert.notInclude(yield* spoken(kit), "my copy")
    }))

  it.effect("a failed refresh leaves the last good copy as it was: a down service and a replacement that cannot be read (finding 6)", () =>
    Effect.gen(function*() {
      let body = householdCalendar
      const { state, net } = switchable(() => body)
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      yield* runJob(kit, daily.id)
      const good = (yield* copyIn(kit))!
      assert.isDefined(good)
      state.up = false
      yield* runJob(kit, daily.id)
      state.up = true
      body = ics(["BEGIN:VEVENT\r\nUID:1\r\nDTSTART:garbage\r\nSUMMARY:GFT\r\nEND:VEVENT"])
      yield* runJob(kit, daily.id)
      assert.include((yield* kit.jobs).find((j) => j.id === daily.id)?.lastError ?? "", "unreadable")
      // Not one write: the same row at the same revision.
      assert.deepStrictEqual(yield* copyIn(kit), good)
      // Each run was the next night's: it is now Friday 03:00, and the good copy still answers.
      assert.strictEqual(yield* spoken(kit), "Today: the paper bin. After that, Wednesday: the general waste bin.")
    }))

  it.effect("a first fetch that fails is never a copy, also asked again; a new link that cannot be reached never answers from the old link's copy (finding 7)", () =>
    Effect.gen(function*() {
      const { state, net } = switchable()
      state.up = false
      const kit = yield* startTestModule(moduleOn(net), { settings })
      for (let i = 0; i < 2; i++) {
        const r = yield* kit.tool("bin_next", {})
        assert.isFalse(r.ok)
        assert.include(r.content, "I can't reach the bin calendar")
      }
      yield* kit.advance(RETRY_AFTER_MS)
      assert.include((yield* kit.tool("bin_next", {})).content, "I can't reach the bin calendar")
      assert.isUndefined(yield* copyIn(kit))
      // A copy of the first link, then the owner changes to a link that cannot be reached.
      state.up = true
      yield* kit.advance(RETRY_AFTER_MS)
      assert.isTrue((yield* kit.tool("bin_next", {})).ok)
      yield* kit.configure({ icsUrl: "https://unreachable.example.org/c.ics" })
      for (let i = 0; i < 2; i++) {
        const r = yield* kit.tool("bin_next", {})
        assert.isFalse(r.ok)
        assert.include(r.content, "I can't reach the bin calendar")
      }
    }))

  it.effect("a partly unreadable calendar says the answer may be incomplete; a bin beyond a cut copy is not called absent (finding 8)", () =>
    Effect.gen(function*() {
      const partial = yield* startTestModule(moduleOn(serve(ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART:nonsense\r\nSUMMARY:Glas\r\nEND:VEVENT", allDay("g", "20261119", "GFT")]))), { settings })
      assert.strictEqual(yield* spoken(partial), "Tomorrow: the green bin (GFT). Part of the calendar couldn't be read, so this may not be complete.")
      assert.strictEqual(yield* spoken(partial, { type: "glass" }), "I don't see the glass collection coming up in the calendar. Part of the calendar couldn't be read, so this may not be complete.")
      // 61 daily paper rounds, and glass after them: the copy keeps the next 60, and glass is not among them.
      const cut = ics([allDay("p", "20261118", "Papier", [`RRULE:FREQ=DAILY;COUNT=${MAX_COLLECTIONS + 1}`]), allDay("g", String(addDays(20261118, 90)), "Glas")])
      const kit = yield* startTestModule(moduleOn(serve(cut)), { settings })
      assert.strictEqual(yield* spoken(kit, { type: "glass" }), "I don't see the glass collection in the next 60 collections of the calendar; it has more after those.")
      const row = (yield* copyIn(kit))!
      assert.deepStrictEqual([row.value.entries.length, row.value.cut, row.value.entries.at(-1)], [MAX_COLLECTIONS, true, { d: addDays(20261118, MAX_COLLECTIONS - 1), k: "paper" }])
    }))

  it.effect("a change of the household's zone changes the answer from the same copy, without a refresh (finding 20)", () =>
    Effect.gen(function*() {
      // 23:30 UTC on Thursday the 19th: Friday the 20th in Amsterdam, still Thursday in Los Angeles.
      const body = ics(["BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261119T233000Z\r\nSUMMARY:Papier\r\nEND:VEVENT"])
      const amsterdam = yield* startTestModule(moduleOn(serve(body)), { settings })
      assert.strictEqual(yield* spoken(amsterdam), "Friday: the paper bin.")
      const copy = (yield* copyIn(amsterdam))!.value
      assert.deepStrictEqual(copy.entries, [{ t: Date.UTC(2026, 10, 19, 23, 30), k: "paper" }])
      // The same copy in a household in Los Angeles; the calendar cannot be fetched there, and need not be.
      const net = makeOfflineNet({})
      const la = yield* startTestModule(moduleOn(net), { settings, household: { home: { HOME_TIME_ZONE: "America/Los_Angeles" } }, started: false })
      yield* la.moduleStore().collection(copies).insert(copy, { id: COPY_ID })
      yield* la.start
      assert.strictEqual(yield* spoken(la), "Tomorrow: the paper bin.")
      assert.strictEqual(net.requests.length, 0)
    }))
})

describe("bin-day: the reworked off-thread helper", () => {
  it.effect("the refresh goes through the real helper with the owner's names, and they are applied", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve(ics([allDay("t", "20261119", "Tuinafval")]))), { settings: { ...settings, names: [{ match: "tuin", label: "Garden waste" }] } })
      assert.strictEqual(yield* spoken(kit), "Tomorrow: Garden waste.")
      assert.deepStrictEqual((yield* copyIn(kit))?.value.entries, [{ d: 20261119, k: "other", l: "Garden waste" }])
    }))

  it("every reason of the helper is a failed refresh with its own reason, never a defect", () => {
    const expected: Record<string, string> = {
      timeout: "too-slow", memory: "too-large", "too-large": "too-large", failed: "unreadable", exited: "unreadable", load: "internal", input: "internal", busy: "busy", nested: "internal"
    }
    for (const reason of OffThreadReason.literals) assert.strictEqual(readReason(reason), expected[reason], reason)
  })

  it.effect("a busy helper: the refresh fails with `busy`, the last copy stays, and the next refresh simply tries again", () =>
    Effect.gen(function*() {
      const { state, net } = switchable()
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      yield* runJob(kit, daily.id)
      const good = (yield* copyIn(kit))!
      assert.isDefined(good)
      // Two calls running and 32 waiting fill the helper; the refresh's call is one more.
      const wait = offThreadTask<(input: { readonly ms: number }) => Promise<string>>(new URL("./wait.task.mjs", import.meta.url))
      const fill = Effect.gen(function*() {
        const fibers = yield* Effect.forEach(Array.from({ length: 34 }), () => Effect.forkChild(Effect.exit(offThread(wait, { ms: 20_000 }, { timeoutMs: 30_000 }))))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        return fibers
      })
      const fillers = yield* fill
      yield* runJob(kit, daily.id)
      assert.strictEqual((yield* kit.jobs).find((j) => j.id === daily.id)!.lastError, "The calendar refresh failed: busy")
      assert.deepStrictEqual(yield* copyIn(kit), good)
      yield* Fiber.interruptAll(fillers)
      // Two days on with the service down (the nightly runs fail), then up again: the copy is old.
      state.up = false
      yield* advance(kit, STALE_AFTER_MS + RETRY_AFTER_MS)
      state.up = true
      // Past the five minutes in which a question does not retry after the down service's last failure.
      yield* advance(kit, RETRY_AFTER_MS + 60_000)
      // A question while the helper is busy answers from the old copy and says how old it is.
      const again = yield* fill
      assert.match(yield* spoken(kit), / This is from my copy of the calendar from 3 days ago; I couldn't refresh it\.$/)
      assert.deepStrictEqual(yield* copyIn(kit), good)
      yield* Fiber.interruptAll(again)
      assert.strictEqual(offThreadWorkers().running, 0)
      // Busy is not remembered: the next question refreshes at once (no five-minute wait), and the copy is new.
      assert.notInclude(yield* spoken(kit), "my copy")
      assert.isAbove((yield* copyIn(kit))!.value.readAt, good.value.readAt)
    }), 60_000)
})

describe("bin-day: settings and the Test button", () => {
  it("the link is checked as it is typed, without quoting it", () => {
    assert.strictEqual(explainLink(""), undefined)
    assert.strictEqual(explainLink("https://example.org/a.ics"), undefined)
    assert.strictEqual(explainLink("webcal://example.org/a.ics"), undefined)
    assert.include(explainLink("not a link")!, "not a web address")
    assert.include(explainLink("ftp://example.org/a.ics")!, "https://")
    assert.include(explainLink("https://user:pw@example.org/a.ics")!, "user name")
    assert.notInclude(explainLink("https://user:pw@example.org/a.ics")!, "pw")
  })

  it.effect("health: no link is a hint, a bad link a warning, a good one nothing; invalid settings are refused when saved", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(binDayModule())
      assert.deepStrictEqual((yield* kit.checkHealth).map((i) => [i.id, i.severity]), [["bin-day.no-calendar", "info"]])
      const good = yield* startTestModule(moduleOn(serve()), { settings })
      assert.deepStrictEqual(yield* good.checkHealth, [])
      const refused = yield* good.configure({ icsUrl: "ftp://example.org/a.ics" })
      assert.isFalse((refused as { ok: boolean }).ok)
      assert.include(JSON.stringify(refused), "The link must start with https://")
    }))

  it.effect("the Test button: what it found, a cut and an unreadable part, each failure, and it writes nothing (finding 22)", () =>
    Effect.gen(function*() {
      const press = (net: Net, icsUrl = calendarUrl) => moduleOn(net).fieldActions!.test!({ settings: { icsUrl, names: [] } as never, draft: false })
      // The running module, its clock at Wednesday 18 November 2026: a press writes no copy (checked at the end).
      const net = serve()
      const kit = yield* startTestModule(moduleOn(net), { settings })
      assert.deepStrictEqual(yield* press(serve()), { ok: true, text: "Found 9 collections coming up.", tone: "ok" })
      const many = ics([allDay("p", "20261118", "Papier", ["RRULE:FREQ=DAILY;COUNT=80"])])
      assert.deepStrictEqual(yield* press(serve(many)), { ok: true, text: "Found more than 60 collections coming up (the module keeps the next 60).", tone: "ok" })
      const partial = ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART:nonsense\r\nSUMMARY:Glas\r\nEND:VEVENT", allDay("g", "20261119", "GFT")])
      assert.deepStrictEqual(yield* press(serve(partial)), { ok: true, text: "Found 1 collections coming up. 1 events could not be read and are left out.", tone: "warning" })
      assert.deepStrictEqual(yield* press(serve("<html></html>", { "content-type": "text/calendar" })), { ok: false, text: "That link is not a calendar I can read.", tone: "error" })
      assert.deepStrictEqual(yield* press(makeOfflineNet({ [calendarPath]: { status: 503, body: "x" } })), { ok: false, text: "I couldn't fetch the calendar from that link.", tone: "error" })
      assert.deepStrictEqual(yield* press(serve(), ""), { ok: false, text: "Paste the calendar link first.", tone: "warning" })
      assert.deepStrictEqual((yield* press(serve(), "ftp://x.example/a.ics")).ok, false)
      yield* press(net)
      assert.isUndefined(yield* copyIn(kit))
      assert.strictEqual(net.requests.length, 1)
    }))

  it.effect("changing the link: the old link's copy is not used, and the new link's replaces it", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({
        [calendarPath]: { body: householdCalendar, headers: icsHeaders },
        "https://other.example.org/c.ics": { body: ics([allDay("p", "20261124", "Papier")]), headers: icsHeaders }
      })
      const kit = yield* startTestModule(moduleOn(net), { settings })
      assert.include(yield* spoken(kit), "green bin")
      yield* kit.configure({ icsUrl: "https://other.example.org/c.ics" })
      assert.strictEqual(yield* spoken(kit), "Tuesday: the paper bin.")
      const rows = yield* kit.moduleStore().collection(copies).list({})
      assert.deepStrictEqual(rows.map((r) => r.value.entries), [[{ d: 20261124, k: "paper" }]])
    }))
})

/** The module with its shared part's `settingsFor` replaced while `over.value` is set: the owner's link as the refresh sees it. */
const withSettings = (net: Net, over: { value: Record<string, unknown> | undefined }, connector = net.connector) => {
  const definition = binDayModule({ resolver: net.resolver, connector })
  return {
    ...definition,
    shared: (ctx: Parameters<NonNullable<typeof definition.shared>>[0]) =>
      definition.shared!({ ...ctx, settingsFor: (id) => (over.value !== undefined ? over.value as never : ctx.settingsFor(id)) })
  } as typeof definition
}

/** The module with what each of its job handlers sees as `CurrentJob` while it runs, recorded. */
const recordingJobs = (net: Net, seen: Array<JobOrigin | undefined>) => {
  const definition = moduleOn(net)
  return {
    ...definition,
    shared: (ctx: Parameters<NonNullable<typeof definition.shared>>[0]) =>
      definition.shared!({
        ...ctx,
        scheduler: {
          ...ctx.scheduler,
          handle: (name, handler) => ctx.scheduler.handle(name, { ...handler, run: (payload, due) => Effect.andThen(Effect.flatMap(CurrentJob, (job) => Effect.sync(() => void seen.push(job))), handler.run(payload, due)) })
        }
      })
  } as typeof definition
}

const section = (kit: Kit) => Effect.map(kit.contributions(BriefingSections), (all: ReadonlyArray<BriefingSection>) => all.find((s) => s.id === "bin-day")!)
const request = (kit: Kit, over: Partial<BriefingRequest>, now: number): BriefingRequest => ({
  turn: kit.turn(), kind: "morning", length: "normal", maxSentences: 2, language: "en", now, ...over
})

describe("bin-day: the copy, the jobs and the briefing section", () => {
  it.effect("the daily refresh and the first one are scheduled, write as the job, and run again after a restart (finding 23)", () =>
    Effect.gen(function*() {
      const seen: Array<JobOrigin | undefined> = []
      const kit = yield* startTestModule(recordingJobs(serve(), seen), { settings })
      const jobs = yield* kit.jobs
      const daily = jobs.find((j) => j.key === "refresh-daily")!
      assert.strictEqual(daily.cron, "0 3 * * *")
      const start = jobs.find((j) => j.key === "refresh-start")!
      yield* runJob(kit, start.id)
      assert.strictEqual((yield* copyIn(kit))?.value.entries.length, 9)
      const written = kit.events.filter((e) => e.type === "bin-day.copy.changed")
      assert.deepStrictEqual(written.map((e) => e.actor), [{ kind: "job", jobId: start.id }])
      yield* kit.restart
      // The restart scheduled the daily job again (the same key: a new job), and a start job that finds the copy fresh.
      const again = (yield* kit.jobs).find((j) => j.key === "refresh-daily" && j.state === "scheduled")!
      yield* runJob(kit, again.id)
      assert.deepStrictEqual(kit.events.filter((e) => e.type === "bin-day.copy.changed").map((e) => e.actor), [{ kind: "job", jobId: start.id }, { kind: "job", jobId: again.id }])
      // The handlers saw their own job as `CurrentJob`.
      assert.includeMembers(seen.map((j) => j?.jobId), [start.id, again.id])
      assert.strictEqual(daily.cron, again.cron)
      // A refresh on a question writes as that turn, not as a job.
      const turnKit = yield* startTestModule(moduleOn(serve()), { settings })
      yield* turnKit.tool("bin_next", {})
      assert.strictEqual(turnKit.events.find((e) => e.type === "bin-day.copy.changed")?.actor?.kind, "turn")
    }))

  it.effect("a refresh that fails fails the run: retried, the job's error and a Health issue until one works; the copy stays (finding 22)", () =>
    Effect.gen(function*() {
      const { state, net } = switchable()
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      yield* runJob(kit, daily.id)
      const good = yield* copyIn(kit)
      assert.isDefined(good)
      state.up = false
      const before = net.requests.length
      yield* runJob(kit, daily.id)
      // The retries (5, 10 and 20 s) all fail: the repeating job moves on, with its error, and Health says so.
      for (const wait of [5_000, 10_000, 20_000, 40_000]) yield* advance(kit, wait)
      const failed = (yield* kit.jobs).find((j) => j.id === daily.id)!
      assert.strictEqual(failed.state, "scheduled")
      assert.isDefined(failed.failedAt)
      assert.include(failed.lastError ?? "", "unreachable")
      assert.strictEqual(net.requests.length - before, 4)
      assert.isTrue(kit.issues().some((i) => i.module === "bin-day"))
      assert.deepStrictEqual(yield* copyIn(kit), good)
      state.up = true
      yield* runJob(kit, daily.id)
      // A run asked for by id is not due by the clock, so `settle` cannot tell that it has begun; and the Health issue goes
      // a moment after the row. Wait, bounded, for the outcome this test is about: the error gone and the issue with it.
      for (let i = 0; i < 600; i++) {
        const now = (yield* kit.jobs).find((j) => j.id === daily.id)!
        if (now.lastError === undefined && !kit.issues().some((issue) => issue.module === "bin-day")) break
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
      }
      const ok = (yield* kit.jobs).find((j) => j.id === daily.id)!
      assert.isUndefined(ok.lastError)
      assert.isFalse(kit.issues().some((i) => i.module === "bin-day"))
    }))

  it.effect("the refresh's own check: a link changed while it fetched writes nothing, and the same refresh without the change writes (finding 22)", () =>
    Effect.gen(function*() {
      const net = serve()
      let release: () => void = () => undefined
      let gate = new Promise<void>((resolve) => (release = resolve))
      const over: { value: Record<string, unknown> | undefined } = { value: undefined }
      const kit = yield* startTestModule(withSettings(net, over, async (request) => (await gate, net.connector(request))), { settings })
      const jobs = yield* kit.jobs
      const start = jobs.find((j) => j.key === "refresh-start")!
      const daily = jobs.find((j) => j.key === "refresh-daily")!
      // The fetch waits; while it waits the owner's link becomes another one; then the answer comes, and is read.
      yield* kit.runJob(start.id)
      over.value = { icsUrl: "https://other.example.org/c.ics", names: [] }
      release()
      yield* settle(kit)
      assert.isUndefined(yield* copyIn(kit))
      assert.strictEqual(net.requests.length, 1)
      // Not a failure: the run that changed nothing is done.
      assert.isUndefined((yield* kit.jobs).find((j) => j.id === start.id)?.lastError)
      // The control: the same steps with the link unchanged write the copy, so it was the check that kept the first one out.
      over.value = undefined
      gate = new Promise<void>((resolve) => (release = resolve))
      yield* kit.runJob(daily.id)
      release()
      yield* settle(kit)
      assert.strictEqual(net.requests.length, 2)
      assert.strictEqual((yield* copyIn(kit))?.value.entries.length, 9)
    }))

  it.effect("a refresh called off by a restart while it fetches writes nothing", () =>
    Effect.gen(function*() {
      const net = serve()
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      const slow = binDayModule({ resolver: net.resolver, connector: async (request) => (request.url.pathname === "/calendar.ics" ? (await gate, net.connector(request)) : net.connector(request)) })
      const kit = yield* startTestModule(slow, { settings, started: true })
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      const run = yield* Effect.forkChild(Effect.exit(kit.runJob(daily.id)))
      yield* kit.advance(100)
      yield* kit.configure({ icsUrl: "https://other.example.org/c.ics" })
      release()
      yield* kit.advance(10_000)
      yield* Fiber.join(run)
      assert.isUndefined(yield* copyIn(kit))
    }))

  it.effect("the briefing section: today's and tomorrow's bins from the copy, in the request's language and at the request's time", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings })
      yield* runJob(kit, (yield* kit.jobs).find((j) => j.key === "refresh-start")!.id)
      const s = yield* section(kit)
      assert.strictEqual(s.title, "Bin day")
      const now = yield* kit.now
      assert.deepStrictEqual(yield* s.gather(request(kit, {}, now)), { _tag: "section", sentences: ["Bin day tomorrow: the green bin (GFT)."], priority: "lead", withheld: 0 })
      assert.deepStrictEqual(yield* s.gather(request(kit, { language: "nl" }, now)), { _tag: "section", sentences: ["Morgen is het afvaldag: de groene container (GFT)."], priority: "lead", withheld: 0 })
      // A day on, Friday's paper is tomorrow and Thursday's GFT is today: two sentences, in order.
      const later = yield* s.gather(request(kit, {}, now + 86_400_000))
      assert.deepStrictEqual((later as { sentences: ReadonlyArray<string> }).sentences, ["Bin day today: the green bin (GFT).", "Bin day tomorrow: the paper bin."])
      const capped = yield* s.gather(request(kit, { maxSentences: 1 }, now + 86_400_000))
      assert.deepStrictEqual((capped as { sentences: ReadonlyArray<string> }).sentences, ["Bin day today: the green bin (GFT)."])
      // In the evening only tomorrow is said; a day with no collection is silent from a fresh, complete copy.
      const evening = yield* s.gather(request(kit, { kind: "evening" }, now + 86_400_000))
      assert.deepStrictEqual((evening as { sentences: ReadonlyArray<string> }).sentences, ["Bin day tomorrow: the paper bin."])
      const quiet = yield* startTestModule(moduleOn(serve(ics([allDay("r", "20261125", "Restafval")]))), { settings })
      yield* runJob(quiet, (yield* quiet.jobs).find((j) => j.key === "refresh-start")!.id)
      assert.deepStrictEqual(yield* (yield* section(quiet)).gather(request(quiet, {}, yield* quiet.now)), { _tag: "empty" })
    }))

  it.effect("the briefing section: a copy older than two days says how old it is, and is never silence; no copy is unavailable (finding 19)", () =>
    Effect.gen(function*() {
      const net = serve()
      const none = yield* startTestModule(moduleOn(net))
      assert.deepStrictEqual(yield* (yield* section(none)).gather(request(none, {}, yield* none.now)), { _tag: "empty" })
      // A link, but nothing has been read yet: no copy, and the briefing does not wait for one.
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const s = yield* section(kit)
      const failed = yield* Effect.flip(s.gather(request(kit, {}, yield* kit.now)))
      assert.strictEqual(failed.reason, "unavailable")
      assert.strictEqual(net.requests.length, 0)
      yield* runJob(kit, (yield* kit.jobs).find((j) => j.key === "refresh-start")!.id)
      const now = yield* kit.now
      // Three days on: Saturday the 21st, nothing today or tomorrow in the copy, but the copy is old: not "nothing".
      const old = now + 3 * 86_400_000
      assert.strictEqual((yield* Effect.flip(s.gather(request(kit, {}, old)))).reason, "unavailable")
      // Six days on, Tuesday the 24th: Wednesday's general waste is tomorrow, said with the copy's age.
      assert.deepStrictEqual(((yield* s.gather(request(kit, {}, now + 6 * 86_400_000))) as { sentences: ReadonlyArray<string> }).sentences, [
        "Bin day tomorrow: the general waste bin, from my copy of the calendar from 6 days ago."
      ])
      assert.deepStrictEqual(((yield* s.gather(request(kit, { language: "nl" }, now + 6 * 86_400_000))) as { sentences: ReadonlyArray<string> }).sentences, [
        "Morgen is het afvaldag: de restafvalcontainer, volgens mijn kopie van de kalender van 6 dagen geleden."
      ])
    }))

  it.effect("the worst legal copy fits its row and is stored", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(binDayModule(), { settings })
      const worst: Copy = {
        source: "f".repeat(16),
        readAt: 8_640_000_000_000_000,
        cut: true,
        unreadable: 2_000,
        entries: Array.from({ length: MAX_COLLECTIONS }, (_, i) => (i % 2 === 0 ? { t: 8_640_000_000_000_000, k: "plastic" as const, l: "\"".repeat(60) } : { d: 21_001_231, k: "plastic" as const, l: "\\".repeat(60) }))
      }
      yield* kit.moduleStore().collection(copies).insert(worst, { id: COPY_ID })
      assert.deepStrictEqual((yield* copyIn(kit))?.value, worst)
    }))
})
