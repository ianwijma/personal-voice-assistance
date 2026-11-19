// Calendars the tests serve through the offline network: what a municipality's export looks like, and what it does not.

const vevent = (lines: ReadonlyArray<string>) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n")
const calendar = (events: ReadonlyArray<string>) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//bins//EN", ...events, "END:VCALENDAR", ""].join("\r\n")

/** An all-day event on a date `YYYYMMDD`. */
export const allDay = (uid: string, date: string, summary: string, extra: ReadonlyArray<string> = []) =>
  vevent([`UID:${uid}`, `DTSTART;VALUE=DATE:${date}`, `SUMMARY:${summary}`, ...extra])

export const ics = calendar

/**
 * The test household's calendar, as of Wednesday 18 November 2026: GFT tomorrow, paper on Friday, general waste and PMD the
 * week after, glass every second week from 2 December, and a Christmas tree round in January.
 */
export const householdCalendar = calendar([
  allDay("gft-1", "20261119", "GFT"),
  allDay("papier-1", "20261120", "Papier"),
  allDay("rest-1", "20261125", "Restafval"),
  allDay("pmd-1", "20261127", "PMD"),
  allDay("glas", "20261202", "Glas", ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4"]),
  allDay("tree", "20270108", "Kerstbomen ophalen"),
  // In the past: never stored.
  allDay("old", "20261101", "GFT")
])

export const icsHeaders = { "content-type": "text/calendar; charset=utf-8" }
export const calendarUrl = "https://afval.example.org/calendar.ics?token=s3cr3t-token"
export const calendarPath = "https://afval.example.org/calendar.ics"

/** The reviewer's hostile calendars (local-info-r1, finding 1). 163 bytes: a repeat every second, every 30 February. */
export const secondlyCalendar = calendar([allDay("x", "20260101", "GFT", ["RRULE:FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30"])])
/** 1,600 distinct daily series of 400 collections each, about 180 KB: valid, and far more repeating than a bin calendar. */
export const denseCalendar = calendar(Array.from({ length: 1_600 }, (_, i) => allDay(`x${i}`, "20261118", `Special ${i}`, ["RRULE:FREQ=DAILY;COUNT=400"])))
/** A daily rule ical.js never finishes expanding (every 30 February): only the reader's time limit stops it. */
export const impossibleCalendar = calendar([allDay("x", "20260101", "GFT", ["RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"])])
