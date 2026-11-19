// The evening-before reminder of bin day ("the paper bin goes out tomorrow") through the real host, scheduler and
// notification service of the test kit: a job of the module's own at the owner's time sends one `normal` notification to
// every screen, once per collection, after an outage within the late rule, and not from a copy too old to trust.
// The calendar is read by real workers (`offThread`), the clock is the test clock (Wednesday 18 November 2026, 10:00 in
// Amsterdam when a test starts).
import { assert, describe, it } from "@effect/vitest"
import { checkModule, makeOfflineNet, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { vi } from "vitest"
import { binDayModule, REMIND_JOB, REMIND_LATE_MS, REMIND_TIMES, texts } from "../src/binDay.ts"
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
/** Wait, in real time, until no job of the module is running: a refresh reads the calendar in a worker the test clock does not move. */
const settle = (kit: Kit) =>
  Effect.gen(function*() {
    for (let i = 0; i < 600; i++) {
      if (!(yield* kit.jobs).some((j) => j.module === "bin-day" && j.state === "running")) return
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
    }
    assert.fail("a job did not finish")
  })
const advance = (kit: Kit, ms: number) => Effect.andThen(kit.advance(ms), settle(kit))
/** The test clock at `hour:minute` Amsterdam time on a day of November 2026 (winter time: UTC + 1). */
const atLocal = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour - 1, minute)
const advanceTo = (kit: Kit, at: number) => Effect.flatMap(kit.now, (now) => advance(kit, at - now))
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
      yield* advanceTo(kit, atLocal(18, 20))
      yield* kit.start
      yield* advance(kit, 60_000)
      assert.deepStrictEqual((yield* sent(kit)).map((n) => n.key), ["bin-day:20261119"])
      // Down from 18:30 to 22:30 (three and a half hours late, past the rule): missed, nothing sent.
      const late = yield* started(net)
      yield* advanceTo(late, atLocal(18, 18, 30))
      yield* late.stop
      yield* advanceTo(late, atLocal(18, 22, 30))
      yield* late.start
      yield* advance(late, 60_000)
      assert.deepStrictEqual(yield* sent(late), [])
      // A reminder at 22:00, found at 00:30 (within the rule, but "tomorrow" is another day by then): not sent.
      const night = yield* started(net, { household: amsterdam, settings: settings("22:00") })
      yield* advanceTo(night, atLocal(18, 21, 30))
      yield* night.stop
      yield* advanceTo(night, atLocal(19, 0, 30))
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
