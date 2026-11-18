// The bin-day module through the real host, gateway and scheduler of the test kit: no tool call, action, job or section
// reaches the network (the kit's offline network serves the calendars), and the clock is the test clock.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, makeOfflineNet, startTestModule } from "@pva/core/testing"
import { type BriefingRequest, type BriefingSection, BriefingSections } from "@pva/module-contracts"
import { Effect, Fiber } from "effect"
import { binDayModule, collections, explainLink, feed, STALE_AFTER_MS, texts } from "../src/binDay.ts"
import { allDay, calendarPath, calendarUrl, householdCalendar, ics, icsHeaders } from "./fixtures.ts"

const serve = (body: unknown = householdCalendar, headers: Record<string, string> = icsHeaders) =>
  makeOfflineNet({ [calendarPath]: { body, headers } })
type Net = ReturnType<typeof makeOfflineNet>
const moduleOn = (net: Net) => binDayModule({ resolver: net.resolver, connector: net.connector })
const settings = { icsUrl: calendarUrl }
const dutch = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: "Europe/Amsterdam" } }
type Said = { spoken: string; items: Array<{ bin: string; date: string; when: string }> }

describe("bin-day: tools and actions", () => {
  it.effect("passes the conformance check, with its texts in both languages, with and without a link", () =>
    Effect.gen(function*() {
      yield* checkModule(binDayModule(), { texts, settings })
      yield* checkModule(binDayModule(), { texts })
    }))

  it.effect("bin_next: the next collection and the one after it, in words; the calendar's past is never stored", () =>
    Effect.gen(function*() {
      const net = serve()
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const r = yield* kit.tool("bin_next", {})
      assert.isTrue(r.ok)
      const value = r.value as Said
      assert.strictEqual(value.spoken, "Tomorrow: the green bin (GFT). After that, Friday: the paper bin.")
      assert.deepStrictEqual(value.items.map((i) => [i.bin, i.date]), [["the green bin (GFT)", "2026-11-19"], ["the paper bin", "2026-11-20"]])
      const rows = yield* kit.moduleStore().collection(collections).list({ orderBy: { field: "day", direction: "asc" }, limit: 50 })
      // 18 November on: GFT, paper, general waste, PMD, four glass rounds, the tree round; the 1 November GFT is not kept.
      assert.deepStrictEqual(rows.map((x) => x.value.day), [20261119, 20261120, 20261125, 20261127, 20261202, 20261216, 20261230, 20270108, 20270113])
      // The link is not in what the model reads, and was fetched once through the safe path, with only the product token as User-Agent.
      assert.notInclude(r.content, "s3cr3t-token")
      assert.strictEqual(net.requests.length, 1)
      assert.strictEqual(net.requests[0]!.headers["user-agent"], "personal-voice-assistance/1")
    }))

  it.effect("bin_next with a kind: the next collection of that bin, by the words people use in either language", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings })
      const say = (type: string) => kit.tool("bin_next", { type }).pipe(Effect.map((r) => (r.value as Said).spoken))
      assert.strictEqual(yield* say("paper"), "Friday: the paper bin.")
      assert.strictEqual(yield* say("papier"), "Friday: the paper bin.")
      assert.strictEqual(yield* say("pmd"), "Friday the twenty seventh: the plastic bin (PMD).")
      assert.strictEqual(yield* say("restafval"), "Wednesday the twenty fifth: the general waste bin.")
      assert.strictEqual(yield* say("groen"), "Tomorrow: the green bin (GFT).")
    }))

  it.effect("an unknown bin, a bin the calendar does not have, and a bin the household named itself", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve(ics([allDay("g", "20261119", "GFT"), allDay("t", "20270108", "Kerstbomen ophalen")]))), {
        settings: { ...settings, names: [{ match: "kerstbomen", label: "Christmas tree" }] }
      })
      const say = (type: string) => kit.tool("bin_next", { type }).pipe(Effect.map((r) => (r.value as Said).spoken))
      assert.strictEqual(yield* say("batteries"), "I don't know a bin called batteries. The calendar has the green bin (GFT) and Christmas tree.")
      assert.strictEqual(yield* say("glass"), "I don't see the glass collection coming up in the calendar.")
      assert.strictEqual(yield* say("christmas"), "Friday the eighth of January 2027: Christmas tree.")
    }))

  it.effect("the typed action answers the same with no model, in Dutch too", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings, household: dutch })
      assert.deepStrictEqual(yield* kit.action("next", {}), { ok: true, say: "Morgen: de groene container (GFT). Daarna, overmorgen: de papiercontainer." })
      assert.deepStrictEqual(yield* kit.action("next", { type: "paper" }), { ok: true, say: "Overmorgen: de papiercontainer." })
      const tool = yield* kit.tool("bin_next", { type: "pmd" })
      assert.strictEqual((tool.value as Said).spoken, "Vrijdag de zevenentwintigste: de plasticcontainer (PMD).")
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

  it.effect("answering rubbish (not a calendar, a web page, an error status, far too large, a calendar with junk events)", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [string, unknown, Record<string, string>, number | undefined, string]> = [
        ["plain text", "hello, this is not a calendar", { "content-type": "text/calendar" }, undefined, "doesn't give me a calendar I can read"],
        ["a web page", "<html>sign in</html>", { "content-type": "text/html" }, undefined, "can't reach the bin calendar"],
        ["a server error", "oops", { "content-type": "text/calendar" }, 500, "can't reach the bin calendar"],
        ["not found", "no", { "content-type": "text/calendar" }, 404, "can't reach the bin calendar"],
        ["too large", "BEGIN:VCALENDAR\r\n" + "X-JUNK:" + "a".repeat(300 * 1024) + "\r\nEND:VCALENDAR", { "content-type": "text/calendar" }, undefined, "can't reach the bin calendar"],
        ["a calendar that stops in the middle", "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:garbage\r\n", { "content-type": "text/calendar" }, undefined, "doesn't give me a calendar I can read"],
        ["events with junk in them", ics(["BEGIN:VEVENT\r\nUID:1\r\nDTSTART:garbage\r\nSUMMARY:GFT\r\nEND:VEVENT", "BEGIN:VEVENT\r\nEND:VEVENT"]), { "content-type": "text/calendar" }, undefined, "I don't see any bin collections coming up"]
      ]
      for (const [name, body, headers, status, expected] of cases) {
        const net = makeOfflineNet({ [calendarPath]: { body, headers, ...(status !== undefined ? { status } : {}) } })
        const kit = yield* startTestModule(moduleOn(net), { settings })
        const r = yield* kit.tool("bin_next", {})
        assert.include(r.content, expected, name)
        assert.deepStrictEqual(yield* kit.moduleStore().collection(collections).list({}), [], name)
      }
    }))

  it.effect("slow: an answer that never comes is given up on after three seconds, and the person is told", () =>
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

  it.effect("a copy older than two days is refreshed on the question; when that fails the last copy answers, and says so", () =>
    Effect.gen(function*() {
      let up = true
      const net = makeOfflineNet({ [calendarPath]: () => (up ? { body: householdCalendar, headers: icsHeaders } : { status: 503, body: "down" }) })
      const kit = yield* startTestModule(moduleOn(net), { settings })
      assert.isTrue((yield* kit.tool("bin_next", {})).ok)
      up = false
      yield* kit.advance(STALE_AFTER_MS + 3_600_000)
      const r = yield* kit.tool("bin_next", {})
      assert.isTrue(r.ok)
      assert.include((r.value as Said).spoken, "I couldn't refresh the calendar, so this is from my last copy.")
      up = true
      const fresh = yield* kit.tool("bin_next", {})
      assert.notInclude((fresh.value as Said).spoken, "last copy")
    }))
})

describe("bin-day: settings", () => {
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

  it.effect("changing the link: the old link's rows are not used, and the new link's replace them", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({
        [calendarPath]: { body: householdCalendar, headers: icsHeaders },
        "https://other.example.org/c.ics": { body: ics([allDay("p", "20261124", "Papier")]), headers: icsHeaders }
      })
      const kit = yield* startTestModule(moduleOn(net), { settings })
      assert.include(((yield* kit.tool("bin_next", {})).value as Said).spoken, "green bin")
      yield* kit.configure({ icsUrl: "https://other.example.org/c.ics" })
      const r = yield* kit.tool("bin_next", {})
      assert.strictEqual((r.value as Said).spoken, "Tuesday: the paper bin.")
      const rows = yield* kit.moduleStore().collection(collections).list({})
      assert.strictEqual(rows.length, 1)
    }))
})

describe("bin-day: the stored copy, the jobs and the briefing section", () => {
  it.effect("the daily refresh and the first one are scheduled, and run again after a restart", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings })
      const jobs = yield* kit.jobs
      const daily = jobs.find((j) => j.key === "refresh-daily")
      assert.strictEqual(daily?.cron, "0 3 * * *")
      assert.isDefined(jobs.find((j) => j.key === "refresh-start"))
      // The first refresh runs on its own soon after the start.
      yield* kit.advance(5_000)
      assert.strictEqual((yield* kit.moduleStore().collection(feed).get("state"))?.value.ok, true)
      yield* kit.restart
      yield* kit.runJob(daily!.id)
      const rows = yield* kit.moduleStore().collection(collections).list({})
      assert.strictEqual(rows.length, 9)
      // A second run writes the same pickups again: nothing doubles.
      yield* kit.runJob(daily!.id)
      assert.strictEqual((yield* kit.moduleStore().collection(collections).list({})).length, 9)
    }))

  it.effect("a refresh that fails fails the run (retried, a Health issue until one works); the copy it has stays", () =>
    Effect.gen(function*() {
      let up = true
      const net = makeOfflineNet({ [calendarPath]: () => (up ? { body: householdCalendar, headers: icsHeaders } : { status: 500, body: "x" }) })
      const kit = yield* startTestModule(moduleOn(net), { settings })
      yield* kit.advance(5_000)
      up = false
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      yield* kit.runJob(daily.id).pipe(Effect.ignore)
      const state = yield* kit.moduleStore().collection(feed).get("state")
      assert.strictEqual(state?.value.ok, false)
      assert.strictEqual((yield* kit.moduleStore().collection(collections).list({})).length, 9)
    }))

  it.effect("a refresh called off while it runs writes nothing: the link changed under it", () =>
    Effect.gen(function*() {
      const net = serve()
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      const slow = binDayModule({ resolver: net.resolver, connector: async (request) => (request.url.pathname === "/calendar.ics" ? (await gate, net.connector(request)) : net.connector(request)) })
      const kit = yield* startTestModule(slow, { settings, started: true })
      const daily = (yield* kit.jobs).find((j) => j.key === "refresh-daily")!
      const run = yield* Effect.forkChild(Effect.exit(kit.runJob(daily.id)))
      yield* kit.advance(100)
      // The owner points the module at another link while the fetch is still waiting: the module restarts with it.
      yield* kit.configure({ icsUrl: "https://other.example.org/c.ics" })
      release()
      yield* kit.advance(10_000)
      yield* Fiber.join(run)
      assert.deepStrictEqual(yield* kit.moduleStore().collection(collections).list({}), [])
    }))

  const section = (kit: { readonly contributions: any }) =>
    Effect.map(kit.contributions(BriefingSections) as Effect.Effect<ReadonlyArray<BriefingSection>>, (all) => all.find((s) => s.id === "bin-day")!)
  const request = (kit: { readonly turn: () => any }, over: Partial<BriefingRequest>, now: number): BriefingRequest => ({
    turn: kit.turn(), kind: "morning", length: "normal", maxSentences: 2, language: "en", now, ...over
  })

  it.effect("the briefing section: today's and tomorrow's bins from the stored copy, nothing on other days, a count of nothing personal", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(moduleOn(serve()), { settings })
      yield* kit.advance(5_000)
      const s = yield* section(kit)
      assert.strictEqual(s.title, "Bin day")
      const now = yield* kit.now
      const morning = yield* s.gather(request(kit, {}, now))
      assert.deepStrictEqual(morning, { _tag: "section", sentences: ["Bin day tomorrow: the green bin (GFT)."], priority: "lead", withheld: 0 })
      const nl = yield* s.gather(request(kit, { language: "nl" }, now))
      assert.deepStrictEqual(nl, { _tag: "section", sentences: ["Morgen is het afvaldag: de groene container (GFT)."], priority: "lead", withheld: 0 })
      // Two days on, Friday's paper is tomorrow and Thursday's GFT is today: two sentences, in order.
      const later = yield* s.gather(request(kit, {}, now + 86_400_000))
      assert.deepStrictEqual((later as { sentences: ReadonlyArray<string> }).sentences, ["Bin day today: the green bin (GFT).", "Bin day tomorrow: the paper bin."])
      const capped = yield* s.gather(request(kit, { maxSentences: 1 }, now + 86_400_000))
      assert.strictEqual((capped as { sentences: ReadonlyArray<string> }).sentences.length, 1)
      // In the evening only tomorrow is said; a day with no collection is silent.
      const evening = yield* s.gather(request(kit, { kind: "evening" }, now + 86_400_000))
      assert.deepStrictEqual((evening as { sentences: ReadonlyArray<string> }).sentences, ["Bin day tomorrow: the paper bin."])
      assert.deepStrictEqual(yield* s.gather(request(kit, {}, now + 86_400_000 * 3)), { _tag: "empty" })
    }))

  it.effect("the briefing section: empty with no link, unavailable before the first copy, and it never touches the network", () =>
    Effect.gen(function*() {
      const net = serve()
      const none = yield* startTestModule(moduleOn(net))
      const noneSection = yield* section(none)
      assert.deepStrictEqual(yield* noneSection.gather(request(none, {}, yield* none.now)), { _tag: "empty" })
      // A link, but the start job has not run and nothing has asked: no copy, and the briefing does not wait for one.
      const kit = yield* startTestModule(moduleOn(net), { settings })
      const s = yield* section(kit)
      const failed = yield* Effect.flip(s.gather(request(kit, {}, yield* kit.now)))
      assert.strictEqual(failed.reason, "unavailable")
      assert.strictEqual(net.requests.length, 0)
    }))

  it.effect("a long list: more than one page of pickups is stored and read to the end", () =>
    Effect.gen(function*() {
      // 120 weekly rounds of paper, then one round of glass at the very end: the answer for glass is past four pages.
      const body = ics([allDay("weekly", "20261119", "Papier", ["RRULE:FREQ=DAILY;COUNT=120"]), allDay("glass", "20271201", "Glas")])
      const kit = yield* startTestModule(moduleOn(serve(body)), { settings })
      const r = yield* kit.tool("bin_next", { type: "glass" })
      assert.strictEqual((r.value as Said).spoken, "Wednesday the first of December 2027: the glass collection.")
      // Stored: 121 rows, which is two pages of the store's largest list (83 rows of at most 300 characters).
      const store = kit.moduleStore().collection(collections)
      const first = yield* store.list({ orderBy: { field: "day", direction: "asc" }, limit: 83 })
      const second = yield* store.list({ orderBy: { field: "day", direction: "asc" }, limit: 83, after: first.at(-1)! })
      assert.deepStrictEqual([first.length, second.length], [83, 38])
    }))

  it.effect("every indexed field at its largest is stored, and the worst label fits", () =>
    Effect.gen(function*() {
      const kit = yield* startTestModule(binDayModule(), { settings })
      const store = kit.moduleStore().collection(collections)
      yield* store.insert({ day: 20_991_231, kind: "other", label: "\"".repeat(60) })
      yield* store.insert({ day: 20_200_101, kind: "gft" })
      assert.strictEqual((yield* store.list({ orderBy: { field: "day", direction: "desc" } }))[0]!.value.day, 20_991_231)
    }))
})
