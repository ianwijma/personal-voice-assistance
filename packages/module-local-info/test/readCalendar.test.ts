// Reading a collection calendar: what each title is, repeats and their moved and cancelled instances, the household's
// time zone, the bounds, and the reader off the main thread with the reviewer's hostile calendars.
import { assert, describe, it } from "@effect/vitest"
import { offThread } from "@pva/core"
import { offThreadWorkers } from "@pva/core/testing"
import { Effect } from "effect"
import { bound } from "../../store-sqlite/test/latencyBound.ts"
import { calendarReader, READ_TIMEOUT_MS } from "../src/binDay.ts"
import { addDays, classify, dayIn, type Entry, labelOf, MAX_COLLECTIONS, MAX_EVENTS, type OwnerRule } from "../src/bins.ts"
import { readCalendar, type ReadResult } from "../src/readCalendar.task.ts"
import { allDay, denseCalendar, ics, impossibleCalendar, secondlyCalendar } from "./fixtures.ts"

const fromDay = 20_261_118
const read = (text: string, rules: ReadonlyArray<OwnerRule> = [], zone = "Europe/Amsterdam") => readCalendar({ text, fromDay, zone, rules })
const ok = (r: ReadResult) => {
  assert.strictEqual(r._tag, "ok")
  return r as Extract<ReadResult, { _tag: "ok" }>
}
const show = (e: Entry, zone = "Europe/Amsterdam") => `${e.d ?? dayIn(e.t!, zone)}:${e.k}${e.l !== undefined ? `:${e.l}` : ""}`
const days = (text: string, rules: ReadonlyArray<OwnerRule> = []) => ok(read(text, rules)).entries.map((e) => show(e))

describe("which bin a title is", () => {
  it("knows the common Dutch and English words, by the start of a word", () => {
    const table: ReadonlyArray<readonly [string, string | undefined]> = [
      ["GFT", "gft"], ["GFT-afval (groene container)", "gft"], ["Groene bak", "gft"], ["Green bin", "gft"], ["Organic waste", "gft"],
      ["Papier", "paper"], ["Oud papier en karton", "paper"], ["Paper and cardboard", "paper"],
      ["PMD", "plastic"], ["Plastic, blik en drankkartons", "plastic"], ["Plastic packaging", "plastic"],
      ["Glas", "glass"], ["Glass bottles", "glass"],
      ["Restafval", "rest"], ["Grijze container", "rest"], ["General waste", "rest"],
      ["Kerstbomen ophalen", undefined], ["", undefined], ["Forest", undefined]
    ]
    for (const [title, kind] of table) assert.strictEqual(classify(title), kind, title)
  })

  it("keeps a label one line, at most 60 characters, whatever the calendar holds", () => {
    assert.strictEqual(labelOf("a\u0000b\nc‮d"), "a b c d")
    assert.strictEqual(labelOf("x".repeat(100)).length, 60)
    assert.strictEqual(labelOf("ab\ud83d"), "ab")
    assert.strictEqual(labelOf("   "), "")
  })
})

describe("reading the calendar", () => {
  it("all-day events keep their date; timed ones their instant, whose date follows the zone; floating times their written date", () => {
    const text = ics([
      allDay("a", "20261119", "GFT"),
      // 23:30 UTC on the 19th is 00:30 on the 20th in Amsterdam, and still the 19th in Los Angeles.
      "BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261119T233000Z\r\nSUMMARY:Papier\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261121T070000\r\nSUMMARY:Glas\r\nEND:VEVENT"
    ])
    const r = ok(read(text))
    assert.deepStrictEqual(r.entries, [{ d: 20_261_119, k: "gft" }, { t: Date.UTC(2026, 10, 19, 23, 30), k: "paper" }, { d: 20_261_121, k: "glass" }])
    assert.deepStrictEqual(r.entries.map((e) => show(e, "America/Los_Angeles")), ["20261119:gft", "20261119:paper", "20261121:glass"])
  })

  it("a TZID that is an IANA zone is read in that zone even without a VTIMEZONE", () => {
    const r = ok(read(ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART;TZID=Europe/Amsterdam:20261119T070000\r\nSUMMARY:GFT\r\nEND:VEVENT"])))
    assert.deepStrictEqual(r.entries, [{ t: Date.UTC(2026, 10, 19, 6), k: "gft" }])
  })

  it("repeats with a count, an end, an interval and an excluded date; a cancelled event is no collection", () => {
    const text = ics([
      allDay("w", "20261119", "Papier", ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3", "EXDATE;VALUE=DATE:20261203"]),
      allDay("u", "20261120", "GFT", ["RRULE:FREQ=WEEKLY;UNTIL=20261211"]),
      allDay("x", "20261125", "Restafval", ["STATUS:CANCELLED"])
    ])
    assert.deepStrictEqual(days(text), ["20261119:paper", "20261120:gft", "20261127:gft", "20261204:gft", "20261211:gft", "20261217:paper"])
  })

  it("a moved instance (RECURRENCE-ID) is collected on its new day, and a cancelled one not at all", () => {
    const text = ics([
      allDay("gft", "20261119", "GFT", ["RRULE:FREQ=WEEKLY;COUNT=4"]),
      // The 19th moves to Friday the 20th; the 3rd of December is cancelled.
      allDay("gft", "20261120", "GFT", ["RECURRENCE-ID;VALUE=DATE:20261119"]),
      allDay("gft", "20261203", "GFT", ["RECURRENCE-ID;VALUE=DATE:20261203", "STATUS:CANCELLED"])
    ])
    assert.deepStrictEqual(days(text), ["20261120:gft", "20261126:gft", "20261210:gft"])
    // A timed series, its instance moved by its zoned RECURRENCE-ID, and one moved in from long ago into the window.
    const timed = ics([
      "BEGIN:VEVENT\r\nUID:t\r\nDTSTART;TZID=Europe/Amsterdam:20200102T070000\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:Papier\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:t\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20261119T070000\r\nDTSTART;TZID=Europe/Amsterdam:20261121T090000\r\nSUMMARY:Papier\r\nEND:VEVENT",
      "BEGIN:VEVENT\r\nUID:t\r\nRECURRENCE-ID;TZID=Europe/Amsterdam:20200109T070000\r\nDTSTART;TZID=Europe/Amsterdam:20261123T070000\r\nSUMMARY:Papier\r\nEND:VEVENT"
    ])
    assert.deepStrictEqual(ok(read(timed)).entries.slice(0, 3).map((e) => show(e)), ["20261121:paper", "20261123:paper", "20261126:paper"])
  })

  it("a repeat that began long ago still gives its next collections: the series is moved to the window, not walked from its start", () => {
    const r = ok(read(ics([allDay("old", "20250101", "GFT", ["RRULE:FREQ=DAILY"]), allDay("older", "19900103", "Papier", ["RRULE:FREQ=WEEKLY;INTERVAL=2"])])))
    // The day before today is kept (a copy answers in any zone); daily GFT from then on, paper every second Wednesday in phase with 1990.
    assert.strictEqual(show(r.entries[0]!), "20261117:gft")
    assert.deepStrictEqual(r.entries.filter((e) => e.k === "paper").slice(0, 2).map((e) => show(e)), ["20261118:paper", "20261202:paper"])
    assert.strictEqual(r.entries.length, MAX_COLLECTIONS)
    assert.isTrue(r.cut)
    // A daily series from 1950 is 28,000 days old: walked from its start it would be over the reader's work bound.
    const ancient = ok(read(ics([allDay("a", "19500101", "Restafval", ["RRULE:FREQ=DAILY"])])))
    assert.deepStrictEqual(ancient.entries.slice(0, 2).map((e) => show(e)), ["20261117:rest", "20261118:rest"])
    const monthly = ok(read(ics([allDay("m", "19950315", "Glas", ["RRULE:FREQ=MONTHLY"]), allDay("y", "19800106", "Kerstbomen", ["RRULE:FREQ=YEARLY"])])))
    assert.deepStrictEqual(monthly.entries.slice(0, 3).map((e) => show(e)), ["20261215:glass", "20270106:other:Kerstbomen", "20270115:glass"])
  })

  it("the owner's names win, and a title no one knows is `other` with its own words; the past is left out", () => {
    const text = ics([allDay("a", "20261119", "Tuinafval"), allDay("b", "20261120", "GFT"), allDay("c", "20261001", "Papier"), allDay("d", "20261121", "Kerstbomen")])
    assert.deepStrictEqual(days(text, [{ match: "tuin", label: "Garden waste" }, { match: "gft", label: "Groen" }]), ["20261119:other:Garden waste", "20261120:gft:Groen", "20261121:other:Kerstbomen"])
  })

  it("not a calendar is `unreadable`; an event that cannot be read is counted, never silently dropped", () => {
    assert.strictEqual(read("<html></html>")._tag, "unreadable")
    // Only an unreadable event: nothing was read, so the calendar is unreadable, not empty.
    assert.strictEqual(read(ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART:garbage\r\nSUMMARY:GFT\r\nEND:VEVENT"]))._tag, "unreadable")
    const some = ok(read(ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART:nonsense\r\nSUMMARY:GFT\r\nEND:VEVENT", allDay("a", "20261119", "Papier"), allDay("n", "20261120", "")])))
    assert.deepStrictEqual(some.entries.map((e) => show(e)), ["20261119:paper"])
    assert.strictEqual(some.unreadable, 2)
    // An empty calendar is read: it has no collections, and that is complete.
    assert.deepStrictEqual(read(ics([])), { _tag: "ok", entries: [], cut: false, unreadable: 0 })
  })

  it("dates are plain calendar arithmetic", () => {
    assert.strictEqual(addDays(20_261_231, 1), 20_270_101)
    assert.strictEqual(addDays(20_280_228, 1), 20_280_229)
    assert.strictEqual(dayIn(Date.UTC(2026, 10, 18, 23, 30), "Europe/Amsterdam"), 20_261_119)
  })
})

describe("the bounds", () => {
  const oneADay = (n: number) => ics(Array.from({ length: n }, (_, i) => allDay(`e${i}`, String(addDays(fromDay, i)), "GFT")))

  it("the next 60 collections are kept, exactly, and the copy says when there are more", () => {
    const sixty = ok(read(oneADay(MAX_COLLECTIONS)))
    assert.strictEqual(sixty.entries.length, MAX_COLLECTIONS)
    assert.isFalse(sixty.cut)
    const more = ok(read(oneADay(MAX_COLLECTIONS + 1)))
    assert.strictEqual(more.entries.length, MAX_COLLECTIONS)
    assert.isTrue(more.cut)
    assert.strictEqual(show(more.entries[0]!), `${fromDay}:gft`)
    assert.strictEqual(show(more.entries.at(-1)!), `${addDays(fromDay, MAX_COLLECTIONS - 1)}:gft`)
  })

  it("an endless repeat stops at the horizon; a calendar of too many events or too much repeating is refused, never cut into a short list", () => {
    const endless = ok(read(ics([allDay("e", "20261119", "GFT", ["RRULE:FREQ=MONTHLY"])])))
    assert.strictEqual(endless.entries.length, 14)
    assert.isFalse(endless.cut)
    assert.deepStrictEqual(read(oneADay(MAX_EVENTS + 1)), { _tag: "too-large" })
    // The reviewer's 1,600 daily series of 400: refused within the reader's work bound.
    assert.deepStrictEqual(read(denseCalendar), { _tag: "too-large" })
    // A repeat every second: a collection calendar never has one, and it is not expanded.
    assert.strictEqual(read(secondlyCalendar)._tag, "unreadable")
  })
})

/** The longest gap between ticks of a 1 ms timer while `effect` runs (what audio framing would see). */
const longestStop = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    let last = performance.now()
    let worst = 0
    const timer = setInterval(() => {
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
    }, 1)
    try {
      const value = yield* Effect.exit(effect)
      return { value, worst: Math.max(worst, performance.now() - last) }
    } finally {
      clearInterval(timer)
    }
  })

describe("the reader runs off the main thread", () => {
  const options = { timeoutMs: READ_TIMEOUT_MS, maxMemoryMb: 96, maxResultBytes: 64 * 1024 }
  const input = (text: string) => ({ text, fromDay, zone: "Europe/Amsterdam", rules: [] })

  it.live("the reviewer's hostile calendars hold the main thread under 10 ms and end as a typed answer or failure, never a list", () =>
    Effect.gen(function*() {
      const results: Array<string> = []
      // Warm tsx's cache once, so the measured calls are what a refresh costs.
      yield* offThread(calendarReader, input(ics([])), options)
      const secondly = yield* longestStop(offThread(calendarReader, input(secondlyCalendar), options))
      assert.deepStrictEqual(secondly.value._tag === "Success" ? secondly.value.value : undefined, { _tag: "unreadable" })
      const dense = yield* longestStop(offThread(calendarReader, input(denseCalendar), options))
      assert.deepStrictEqual(dense.value._tag === "Success" ? dense.value.value : undefined, { _tag: "too-large" })
      // A rule ical.js never finishes (every 30 February, daily): the worker is stopped at the time limit.
      const started = performance.now()
      const hang = yield* longestStop(offThread(calendarReader, input(impossibleCalendar), { ...options, timeoutMs: 1_500 }))
      const took = performance.now() - started
      // Its time limit stops it (or its memory limit first, on a busy machine): a typed failure.
      assert.oneOf(hang.value._tag === "Failure" && hang.value.cause.reasons[0]?._tag === "Fail" ? (hang.value.cause.reasons[0].error as { reason: string }).reason : undefined, ["timeout", "memory"])
      assert.isBelow(took, 1_500 + bound(500))
      results.push(`secondly ${secondly.worst.toFixed(1)} ms, dense ${dense.worst.toFixed(1)} ms, never-ending ${hang.worst.toFixed(1)} ms (stopped after ${took.toFixed(0)} ms)`)
      for (const r of [secondly, dense, hang]) assert.isBelow(r.worst, bound(10))
      assert.strictEqual(offThreadWorkers().running, 0)
      console.log(`[readCalendar] longest main-thread stop: ${results.join("; ")}`)
    }), 30_000)
})
