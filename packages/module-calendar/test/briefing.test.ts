// The calendar's briefing section (`BriefingSections`), as the briefing module would gather it for the asking turn.
import { assert, describe, it } from "@effect/vitest"
import type { TestHouseholdInput } from "@pva/core/testing"
import { BRIEFING_LIMITS, type BriefingRequest, type BriefingSectionResult, BriefingSections } from "@pva/module-contracts"
import { Effect, Exit } from "effect"
import { allFixtures, AMS, calendar, everyone, ics, served, startCalendar } from "./fixtures.ts"

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
  it.effect("on the kitchen display: the household's and Sam's events still to come today; Robin's only counted", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const gather = yield* sectionOf(kit, "kitchen-display")
      assert.deepStrictEqual(yield* gather(), {
        _tag: "section",
        sentences: ["Today on the calendar: Lunch with Marloes at half past twelve, Swimming lesson at four o'clock and Gym at seven o'clock."],
        priority: "normal",
        withheld: 1,
        owner: "p-sam"
      })
      // Short: the lead items only, one sentence.
      assert.deepStrictEqual(sentencesOf(yield* gather({ length: "short", maxSentences: 1 })), ["Today on the calendar: Lunch with Marloes at half past twelve and two more."])
      // In the evening: tomorrow.
      assert.deepStrictEqual(sentencesOf(yield* gather({ kind: "evening" })), ["Tomorrow on the calendar: Bins out, all day and Dentist at half past two."])
    }))

  it.effect("on the public hall screen: the household's only, no owner, the personal ones counted", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const gather = yield* sectionOf(kit, "hall-screen")
      const r = yield* gather()
      assert.deepStrictEqual(r, { _tag: "section", sentences: ["Today on the calendar: Lunch with Marloes at half past twelve and Swimming lesson at four o'clock."], priority: "normal", withheld: 2 })
      assert.notInclude(JSON.stringify(r), "Gym")
    }))

  it.effect("on Robin's phone: one person's content at most, so Sam's events are counted, not read", () =>
    Effect.gen(function*() {
      const { kit } = yield* startCalendar(allFixtures, everyone)
      const r = yield* (yield* sectionOf(kit, "robins-phone"))()
      assert.strictEqual(r._tag, "section")
      if (r._tag !== "section") return
      assert.strictEqual(r.owner, "p-robin")
      assert.include(r.sentences[0]!, "Divorce lawyer at two o'clock")
      assert.notInclude(r.sentences[0]!, "Gym")
      assert.strictEqual(r.withheld, 1)
    }))

  it.effect("empty when there is nothing; unavailable before the first read; the stale line when a calendar could not be read", () =>
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
