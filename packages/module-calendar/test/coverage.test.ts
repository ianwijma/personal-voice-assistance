// Decision 4 of the review's fix round: every answer says what it covers. One function (`coverage` in read.ts) decides
// what must be said beside the events, and every tool, typed action and the briefing section says it: a calendar that
// could not be refreshed since when, one read only in part, one not read, events withheld (a count), a scan cut short,
// and an event going on after the last day kept.
import { assert, describe, it } from "@effect/vitest"
import { BriefingSections } from "@pva/module-contracts"
import { Effect } from "effect"
import { advanceAndRefresh, AMS, calendar, ics, sayOf, served, startCalendar } from "./fixtures.ts"

const STALE = "Family could not be refreshed since today at ten o'clock; this is what I had then."
const NOT_READ = "School has not been read yet, so its events are not in this."
const INCOMPLETE = "Family could be read only in part: 1 events could not be read."
const WITHHELD = "1 personal events are not read out here."
const CONTINUES = "Some of these go on after Tuesday the nineteenth of January 2027, the last day I have."
const CUT = "There are more events than I read; this is the first part."

const hall = { device: "hall-screen" }

const text = (v: unknown) => JSON.stringify(v)

describe("calendar: every answer says what it covers", () => {
  it.effect("stale, read in part, not read, withheld and going on: through every tool, action and the briefing", () =>
    Effect.gen(function*() {
      let down = false
      const family = ics([
        { uid: "dentist", summary: "Dentist", start: "20261118T140000", end: "20261118T150000", tz: AMS },
        { uid: "course", summary: "Course", start: "20261118", end: "20270315" },
        { uid: "bad", summary: "Bad", start: "2026-11-18 nonsense" }
      ])
      const robin = ics([{ uid: "lawyer", summary: "Lawyer", start: "20261118T120000", end: "20261118T130000", tz: AMS }])
      const { kit } = yield* startCalendar({
        "https://cal.example.org/family.ics": () => (down ? { status: 503, ...served("") } : served(family)),
        "https://cal.example.org/robin.ics": served(robin)
      }, {
        settings: {
          calendars: [
            calendar("Family", "https://cal.example.org/family.ics"),
            calendar("Robin's", "https://cal.example.org/robin.ics", "Robin"),
            calendar("School", "https://cal.example.org/school.ics")
          ]
        }
      })
      down = true
      yield* advanceAndRefresh(kit, 30 * 60_000) // the refresh at 10:07 fails; it is 10:30
      const every = [STALE, NOT_READ, INCOMPLETE]

      const agenda = (yield* kit.tool("calendar_agenda", {}, hall)).value as Record<string, unknown>
      assert.deepStrictEqual([agenda.stale, agenda.notRead, agenda.incomplete, agenda.withheld, agenda.continues], [STALE, NOT_READ, INCOMPLETE, WITHHELD, CONTINUES])
      const week = (yield* kit.tool("calendar_agenda", { days: 3 }, hall)).value
      for (const s of [...every, WITHHELD, CONTINUES]) assert.include(text(week), s, "agenda, three days")

      // Next: the dentist, past Robin's twelve o'clock (withheld here).
      const next = (yield* kit.tool("calendar_next", {}, hall)).value as Record<string, unknown>
      assert.deepStrictEqual((next.next as { title: string }).title, "Dentist")
      assert.deepStrictEqual([next.stale, next.notRead, next.incomplete, next.withheld], [STALE, NOT_READ, INCOMPLETE, WITHHELD])
      const course = (yield* kit.tool("calendar_next", { match: "course" }, hall)).value as Record<string, unknown>
      assert.deepStrictEqual(course.next, { title: "Course", when: "today, all day until after Tuesday the nineteenth of January 2027", calendar: "Family" })
      for (const s of [...every, CONTINUES, "Personal calendars are not searched here."]) assert.include(text(course), s, "next with words")
      const none = (yield* kit.tool("calendar_next", { match: "opera" }, hall)).value
      for (const s of every) assert.include(text(none), s, "next, nothing found")

      const found = (yield* kit.tool("calendar_find", { text: "course" }, hall)).value as { notes: string }
      for (const s of [...every, CONTINUES, "Personal calendars are not searched here."]) assert.include(found.notes, s, "find")
      const notFound = (yield* kit.tool("calendar_find", { text: "opera" }, hall)).value
      for (const s of every) assert.include(text(notFound), s, "find, nothing found")

      const free = (yield* kit.tool("calendar_free", {}, hall)).value as { spoken: string }
      for (const s of [...every, WITHHELD]) assert.include(free.spoken, s, "free")

      const today = sayOf(yield* kit.action("today", {}, hall))
      for (const s of [...every, WITHHELD, CONTINUES]) assert.include(today, s, "today")
      const tomorrow = sayOf(yield* kit.action("tomorrow", {}, hall))
      for (const s of [...every, CONTINUES]) assert.include(tomorrow, s, "tomorrow")
      const nextEvent = sayOf(yield* kit.action("next_event", {}, hall))
      for (const s of [...every, WITHHELD]) assert.include(nextEvent, s, "next_event")
      const myNext = sayOf(yield* kit.action("my_next", {}, { device: "robins-phone" }))
      assert.include(myNext, "Next: Lawyer, today at noon.")
      const whenIs = sayOf(yield* kit.action("when_is", { match: "course" }, hall))
      assert.include(whenIs, "Next: Course, today, all day until after Tuesday the nineteenth of January 2027.")
      for (const s of [...every, CONTINUES]) assert.include(whenIs, s, "when_is")

      const [section] = yield* kit.contributions(BriefingSections, hall)
      const turn = kit.turn(hall)
      const now = yield* kit.now
      const gather = (maxSentences: number) => kit.asTurn(section!.gather({ turn, kind: "morning", length: "normal", maxSentences, language: "en", now }), hall)
      // One sentence cannot hold the events and all four notes: the section is unavailable, never said without them.
      const one = yield* Effect.exit(gather(1))
      assert.include(JSON.stringify(one), "unavailable")
      for (const maxSentences of [2, 4]) {
        const r = yield* gather(maxSentences)
        assert.strictEqual(r._tag, "section")
        if (r._tag !== "section") continue
        assert.isAtMost(r.sentences.length, maxSentences)
        const said = r.sentences.join(" ")
        assert.include(said, "Course")
        for (const s of [STALE, NOT_READ, INCOMPLETE, CONTINUES]) assert.include(said, s.replace(/\.$/, ""), `briefing of ${maxSentences}`)
        for (const sentence of r.sentences) assert.isAtMost(sentence.length, 300)
      }
    }), 60_000)

  it.effect("a day read only in part: said by every answer that reads a day", () =>
    Effect.gen(function*() {
      const crowded = ics(Array.from({ length: 205 }, (_, i) => ({ uid: `c${i}`, summary: `Slot ${i}`, start: "20261118T110000", end: "20261118T111000", tz: AMS })))
      const { kit } = yield* startCalendar({ "https://cal.example.org/c.ics": served(crowded) }, { settings: { calendars: [calendar("Slots", "https://cal.example.org/c.ics")] } })
      assert.include(text((yield* kit.tool("calendar_agenda", {})).value), CUT)
      assert.include(text((yield* kit.tool("calendar_free", {})).value), CUT)
      assert.include(sayOf(yield* kit.action("today")), CUT)
      const [section] = yield* kit.contributions(BriefingSections, hall)
      const r = yield* kit.asTurn(section!.gather({ turn: kit.turn(hall), kind: "morning", length: "normal", maxSentences: 2, language: "en", now: yield* kit.now }), hall)
      assert.include(text(r), CUT.replace(/\.$/, ""))
      // "Next" from now: the day's rows that have not ended are more than it reads, so it says it looked and stopped.
      assert.deepStrictEqual((yield* kit.tool("calendar_next", {})).value, { spoken: "I looked through the next 1000 events and found nothing; there are more." })
    }), 60_000)
})
