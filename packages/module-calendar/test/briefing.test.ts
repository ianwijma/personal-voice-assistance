// The calendar's briefing section (`BriefingSections`), as the briefing module would gather it for the asking turn.
import { assert, describe, it } from "@effect/vitest"
import type { TestHouseholdInput } from "@pva/core/testing"
import { BRIEFING_LIMITS, type BriefingRequest, type BriefingSectionResult, BriefingSections } from "@pva/module-contracts"
import { Effect, Exit } from "effect"
import { advanceAndRefresh, allFixtures, AMS, calendar, everyone, ics, served, startCalendar, answerOf } from "./fixtures.ts"
import { vi } from "vitest"

// Several test households are started per test here: on a loaded CI machine one test can pass the default 5 s.
vi.setConfig({ testTimeout: 30_000 })

const sentencesOf = (r: BriefingSectionResult) => (r._tag === "section" ? r.sentences : [])

const sectionOf = (kit: Effect.Success<ReturnType<typeof startCalendar>>["kit"], device: string) =>
  Effect.gen(function*() {
    const sections = yield* kit.contributions(BriefingSections, { device })
    assert.deepStrictEqual(sections.map((s) => s.id), ["calendar"])
    const turn = kit.turn({ device })
    const now = yield* kit.now
    const gather = (request: Partial<BriefingRequest> = {}) =>
      kit.asTurn(sections[0]!.gather({ turn, kind: "morning", length: "normal", maxSentences: 2, language: "en", now, ...request }), { device })
    return gather
  })

describe("calendar: the briefing section", () => {
  it.effect("on the kitchen display: the household's and Sam's events still to come today; Robin's are not Sam's briefing's", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const gather = yield* sectionOf(kit, "kitchen-display")
      assert.deepStrictEqual(yield* gather(), {
        _tag: "section",
        sentences: ["Today on the calendar: Lunch with Marloes at half past twelve, Swimming lesson at four o'clock and Gym at seven o'clock."],
        priority: "normal",
        withheld: 0,
        owner: "p-sam"
      })
      // Short: the lead items only, one sentence.
      assert.deepStrictEqual(sentencesOf(yield* gather({ length: "short", maxSentences: 1 })), ["Today on the calendar: Lunch with Marloes at half past twelve and two more."])
      // In the evening: tomorrow.
      assert.deepStrictEqual(sentencesOf(yield* gather({ kind: "evening" })), ["Tomorrow on the calendar: Bins out, all day and Dentist at half past two."])
    }))

  it.effect("on the public hall screen: the household's only, no owner, nobody's personal events gathered", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const gather = yield* sectionOf(kit, "hall-screen")
      const r = yield* gather()
      assert.deepStrictEqual(r, { _tag: "section", sentences: ["Today on the calendar: Lunch with Marloes at half past twelve and Swimming lesson at four o'clock."], priority: "normal", withheld: 0 })
      assert.notInclude(JSON.stringify(r), "Gym")
    }))

  it.effect("a public screen whose default person is Sam: Sam's own events are counted, not read; Robin's are not gathered", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, {
        ...everyone,
        household: { devices: [{ id: "hall-screen", name: "Hall screen", room: "Hall", privacy: "public", defaultPerson: "p-sam" }] }
      })
      const r = yield* (yield* sectionOf(kit, "hall-screen"))()
      assert.deepStrictEqual(r, { _tag: "section", sentences: ["Today on the calendar: Lunch with Marloes at half past twelve and Swimming lesson at four o'clock."], priority: "normal", withheld: 1 })
    }))

  it.effect("on Robin's phone: Robin's own events; Sam's are not Robin's briefing's", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const r = yield* (yield* sectionOf(kit, "robins-phone"))()
      assert.strictEqual(r._tag, "section")
      if (r._tag !== "section") return
      assert.strictEqual(r.owner, "p-robin")
      assert.include(r.sentences[0]!, "Divorce lawyer at two o'clock")
      assert.notInclude(r.sentences[0]!, "Gym")
      assert.strictEqual(r.withheld, 0)
    }))

  it.effect("empty when there is nothing; unavailable before the first read", () =>
    Effect.gen(function*() {
      const empty = yield* startCalendar(allFixtures, { settings: { calendars: [calendar("Quiet", "https://cal.example.org/quiet.ics")] } })
      // The quiet calendar has no fixture: never read.
      const unread = yield* Effect.exit((yield* sectionOf(empty.kit, "kitchen-display"))())
      assert.isTrue(Exit.isFailure(unread))
      assert.include(JSON.stringify(unread), "unavailable")
      const none = yield* startCalendar({ "https://cal.example.org/quiet.ics": served(ics([])) }, { settings: { calendars: [calendar("Quiet", "https://cal.example.org/quiet.ics")] } })
      assert.deepStrictEqual(yield* (yield* sectionOf(none.kit, "kitchen-display"))(), { _tag: "empty" })
      const off = yield* startCalendar({}, {})
      assert.deepStrictEqual(yield* (yield* sectionOf(off.kit, "kitchen-display"))(), { _tag: "empty" })
    }))

  it.effect("finding 21: a calendar that could not be refreshed is said in the briefing, in its only sentence too, and with no events left", () =>
    Effect.gen(function*() {
      let down = false
      let body = ics([{ uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS }])
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": () => (down ? { status: 500, ...served("") } : served(body)) }, { settings: { calendars: [calendar("Family", "https://cal.example.org/family.ics")] } })
      down = true
      yield* advanceAndRefresh(kit, 3_600_000)
      const gather = yield* sectionOf(kit, "kitchen-display")
      assert.deepStrictEqual(sentencesOf(yield* gather()), [
        "Today on the calendar: Dentist at two o'clock.",
        "Family could not be refreshed since today at ten o'clock; this is what I had then."
      ])
      assert.deepStrictEqual(sentencesOf(yield* gather({ length: "short", maxSentences: 1 })), [
        "Today on the calendar: Dentist at two o'clock; Family could not be refreshed since today at ten o'clock; this is what I had then."
      ])
      // The last good read had nothing left today: still said, never `empty`.
      yield* kit.advance(5 * 3_600_000) // 16:00, the dentist is over
      assert.deepStrictEqual(sentencesOf(yield* gather({ maxSentences: 1, now: yield* kit.now })), ["Today: nothing on the calendar; Family could not be refreshed since today at ten o'clock; this is what I had then."])
      // The calendar has nothing on it at all, as last read: the same.
      down = false
      body = ics([])
      yield* advanceAndRefresh(kit, 3_600_000)
      down = true
      yield* advanceAndRefresh(kit, 3_600_000)
      const r = yield* gather({ now: yield* kit.now })
      assert.strictEqual(r._tag, "section")
      assert.include(sentencesOf(r).join(" "), "could not be refreshed")
    }))

  it.effect("finding 17: a day read only in part is said, not a briefing of nothing", () =>
    Effect.gen(function*() {
      const robin = ics(Array.from({ length: 200 }, (_, i) => ({ uid: `r${i}`, summary: `R${i}`, start: "20261118T110000", end: "20261118T113000", tz: AMS })))
      const family = ics([{ uid: "f", summary: "School play", start: "20261118T150000", end: "20261118T160000", tz: AMS }])
      const { kit } = yield* startCalendar({ "https://cal.example.org/family.ics": served(family), "https://cal.example.org/robin.ics": served(robin) }, {
        settings: { calendars: [calendar("Family", "https://cal.example.org/family.ics"), calendar("Robin's", "https://cal.example.org/robin.ics", "Robin")] }
      })
      const r = yield* (yield* sectionOf(kit, "hall-screen"))()
      assert.deepStrictEqual(sentencesOf(r), ["Today: nothing on the calendar.", "There are more events than I read; this is the first part."])
      assert.deepStrictEqual((yield* answerOf(kit, "calendar_agenda", { who: "household" }, { device: "hall-screen" })).value, {
        spoken: "Today: nothing on the calendar. There are more events than I read; this is the first part."
      })
    }))

  it.effect("sentences stay within the contract's bound with long titles, and are Dutch in a Dutch household", () =>
    Effect.gen(function*() {
      const long = ics(Array.from({ length: 8 }, (_, i) => ({ uid: `l${i}`, summary: `${"Very long meeting title ".repeat(6)}${i}`, start: `20261118T1${i}0000`, end: `20261118T1${i}3000`, tz: AMS })))
      const nl: TestHouseholdInput = { home: { HOME_LANGUAGE: "nl-NL", HOME_TIME_ZONE: AMS } }
      const { kit } = yield* startCalendar({ "https://cal.example.org/long.ics": served(long) }, { settings: { calendars: [calendar("Werk", "https://cal.example.org/long.ics")] }, household: nl })
      const gather = yield* sectionOf(kit, "kitchen-display")
      for (const length of ["short", "normal", "long"] as const) {
        const r = yield* gather({ length, language: "nl" })
        assert.strictEqual(r._tag, "section")
        if (r._tag !== "section") continue
        for (const s of r.sentences) assert.isAtMost(s.length, BRIEFING_LIMITS.sentenceChars)
        assert.isTrue(r.sentences[0]!.startsWith("Vandaag in de agenda: "))
      }
    }))
})
