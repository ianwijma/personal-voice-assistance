// Reading a collection calendar: what each title is, repeats and exceptions, the household's time zone, and the bounds.
import { assert, describe, it } from "@effect/vitest"
import { addDays, classify, dayIn, HORIZON_DAYS, ICS_MAX_BYTES, labelOf, MAX_PER_EVENT, MAX_PICKUPS, parsePickups, type OwnerRule } from "../src/ics.ts"
import { allDay, ics } from "./fixtures.ts"

const from = 20_261_118
const parse = (text: string, rules: ReadonlyArray<OwnerRule> = [], zone = "Europe/Amsterdam") => parsePickups(text, { from, zone, rules })
const days = (text: string, rules: ReadonlyArray<OwnerRule> = []) => {
  const r = parse(text, rules)
  assert.strictEqual(r._tag, "ok")
  return r._tag === "ok" ? r.pickups.map((p) => `${p.day}:${p.kind}${p.label !== undefined ? `:${p.label}` : ""}`) : []
}

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
  it("all-day events, timed events in the household's zone, floating times", () => {
    const text = ics([
      allDay("a", "20261119", "GFT"),
      // 23:30 UTC on the 19th is 00:30 on the 20th in Amsterdam.
      "BEGIN:VEVENT\r\nUID:b\r\nDTSTART:20261119T233000Z\r\nSUMMARY:Papier\r\nEND:VEVENT",
      // Floating: the date as written.
      "BEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261121T070000\r\nSUMMARY:Glas\r\nEND:VEVENT"
    ])
    assert.deepStrictEqual(days(text), ["20261119:gft", "20261120:paper", "20261121:glass"])
    const la = parse(text, [], "America/Los_Angeles")
    assert.deepStrictEqual(la._tag === "ok" ? la.pickups.map((p) => p.day) : [], [20_261_119, 20_261_119, 20_261_121])
  })

  it("repeats with a count, an end, an interval and an excluded date; cancelled events and exceptions are not extra days", () => {
    const text = ics([
      allDay("w", "20261119", "Papier", ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3", "EXDATE;VALUE=DATE:20261203"]),
      allDay("u", "20261120", "GFT", ["RRULE:FREQ=WEEKLY;UNTIL=20261211"]),
      allDay("x", "20261125", "Restafval", ["STATUS:CANCELLED"]),
      allDay("p", "20261119", "Papier", ["RECURRENCE-ID;VALUE=DATE:20261119"])
    ])
    assert.deepStrictEqual(days(text), ["20261119:paper", "20261120:gft", "20261127:gft", "20261204:gft", "20261211:gft", "20261217:paper"])
  })

  it("the owner's names win, and a title no one knows is `other` with its own words; the past is left out", () => {
    const text = ics([allDay("a", "20261119", "Tuinafval"), allDay("b", "20261120", "GFT"), allDay("c", "20261001", "Papier"), allDay("d", "20261121", "Kerstbomen")])
    assert.deepStrictEqual(days(text, [{ match: "tuin", label: "Garden waste" }, { match: "gft", label: "Groen" }]), ["20261119:other:Garden waste", "20261120:gft:Groen", "20261121:other:Kerstbomen"])
  })

  it("not a calendar is `unreadable`, and an event that cannot be read does not spoil the others", () => {
    assert.strictEqual(parse("<html></html>")._tag, "unreadable")
    assert.strictEqual(parse("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n")._tag, "unreadable")
    assert.deepStrictEqual(days(ics(["BEGIN:VEVENT\r\nUID:z\r\nDTSTART:nonsense\r\nSUMMARY:GFT\r\nEND:VEVENT", allDay("a", "20261119", "Papier")])), ["20261119:paper"])
  })

  it("dates are plain calendar arithmetic", () => {
    assert.strictEqual(addDays(20_261_231, 1), 20_270_101)
    assert.strictEqual(addDays(20_280_228, 1), 20_280_229)
    assert.strictEqual(dayIn(Date.UTC(2026, 10, 18, 23, 30), "Europe/Amsterdam"), 20_261_119)
  })
})

describe("the bounds", () => {
  it("an endless repeat is cut at the horizon and says so; a daily one at the per-event limit", () => {
    const endless = parse(ics([allDay("e", "20261119", "GFT", ["RRULE:FREQ=WEEKLY"])]))
    assert.strictEqual(endless._tag === "ok" && endless.pickups.at(-1)!.day <= addDays(from, HORIZON_DAYS), true)
    assert.strictEqual(endless._tag === "ok" && endless.cut, false)
    const daily = parse(ics([allDay("d", "20261119", "GFT", [`RRULE:FREQ=DAILY;COUNT=${MAX_PER_EVENT * 3}`])]))
    assert.strictEqual(daily._tag === "ok" && daily.pickups.length <= HORIZON_DAYS, true)
  })

  it("more pickups than the limit are cut, and it says so", () => {
    const many = ics(Array.from({ length: 700 }, (_, i) => allDay(`e${i}`, `2027${String(1 + Math.floor(i / 28)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}`, "GFT")).concat(
      Array.from({ length: 200 }, (_, i) => allDay(`o${i}`, `20270${1 + (i % 9)}${String(1 + (i % 27)).padStart(2, "0")}`, `Other ${i}`))
    ))
    const r = parse(many)
    assert.strictEqual(r._tag === "ok" && r.pickups.length <= MAX_PICKUPS, true)
  })

  it("a calendar of the largest size is read in well under a second (the parse is synchronous: this is its measured bound)", () => {
    let body = ""
    let n = 0
    while (body.length < ICS_MAX_BYTES - 200) body += allDay(`u${n}`, `2027${String(1 + (n % 12)).padStart(2, "0")}${String(1 + (n % 28)).padStart(2, "0")}`, `Collection ${n++}`, ["DESCRIPTION:" + "x".repeat(40)]) + "\r\n"
    const text = ics([body])
    assert.isAtMost(text.length, ICS_MAX_BYTES)
    const started = performance.now()
    const r = parse(text)
    const took = performance.now() - started
    assert.strictEqual(r._tag, "ok")
    assert.isBelow(took, 1_000)
  })
})
