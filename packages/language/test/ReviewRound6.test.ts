// Review round 6 of the language package: the reviewer's inputs.
import { describe, expect, it } from "@effect/vitest"
import { normalizeTimeZone, parseDtstart, parseRecurrence, parseRRule, readSeries } from "../src/index.ts"

describe("round 6 findings", () => {
  it("1: a spoken recurrence looks from today's civil date on (README: 'on or after today's civil date'); yesterday's date pushed into today is not considered", () => {
    // Nuuk, Sunday 29 March 2026 00:15 local: Saturday's 23:30 (read before the gap) is still 15 minutes ahead, but it is yesterday's date.
    const now = Date.parse("2026-03-29T01:15:00Z")
    for (const [text, language, day] of [
      ["every Saturday at 23:30", "en", 4], ["elke zaterdag om 23:30", "nl", 4], ["every day at 23:30", "en", 29], ["elke dag om 23:30", "nl", 29]
    ] as const) {
      const r = parseRecurrence(text, language, { now, timeZone: "America/Nuuk" })
      expect(r.kind, text).toBe("ok")
      if (r.kind !== "ok") continue
      expect(r.value.start.month, text).toBe(day === 4 ? 4 : 3)
      expect(r.value.start.day, text).toBe(day)
    }
  })

  it("2: rule text is folded for ASCII letters only", () => {
    for (const text of ["FREQ=DAıLY", "FREQ=WEEKLY;BYDAY=ſA", "FREQ=DAILY;ıNTERVAL=2"]) {
      expect(parseRRule(text).kind, text).not.toBe("ok")
    }
    const lower = parseRRule("freq=daily;interval=2")
    expect(lower.kind).toBe("ok")
  })
})

describe("round 7 findings", () => {
  it("1: rule text outside printable ASCII is refused before trimming", () => {
    for (const ch of [" ", " ", "﻿"]) {
      for (const text of [`FREQ=DAILY${ch}`, `${ch}FREQ=DAILY`, `RRULE:FREQ=DAILY${ch}`, `${ch}RRULE:FREQ=DAILY`]) {
        expect(parseRRule(text).kind, JSON.stringify(text)).not.toBe("ok")
      }
    }
    for (const text of ["FREQ=DAILY", "freq=daily", "RRULE:FREQ=DAILY", "rrule:freq=daily;interval=2", " FREQ=DAILY "]) {
      expect(parseRRule(text).kind, text).toBe("ok")
    }
  })

  it("1: DTSTART and time zone text are not trimmed of Unicode whitespace", () => {
    const line = "DTSTART;TZID=Europe/Amsterdam:20261120T090000"
    expect(parseDtstart(line)).toBeDefined()
    for (const ch of [" ", " ", "﻿"]) {
      expect(parseDtstart(line + ch), JSON.stringify(ch)).toBeUndefined()
      expect(parseDtstart(ch + line), JSON.stringify(ch)).toBeUndefined()
      expect(normalizeTimeZone(`Europe/Amsterdam${ch}`), JSON.stringify(ch)).toBeUndefined()
      expect(readSeries({ rrule: "FREQ=DAILY", dtstart: line, timeZone: `${ch}Europe/Amsterdam` }).kind).not.toBe("ok")
    }
    expect(readSeries({ rrule: "FREQ=DAILY", dtstart: line, timeZone: "Europe/Amsterdam" }).kind).toBe("ok")
  })
})
