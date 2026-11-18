import { normalizeTimeZone } from "@pva/language"
import { Effect } from "effect"
import type ICALModule from "ical.js"
import { instantOf, startOfDay } from "./time.ts"

/**
 * Reading an ICS file (RFC 5545) into the occurrences of a time window, with `ical.js` for the parsing and the
 * expansion of repeating events (RRULE, RDATE, EXDATE, RECURRENCE-ID overrides). Events from outside are expanded here,
 * not with `@pva/language` (docs/MODULES-PLAN.md Appendix A).
 *
 * **Bounded, in small steps** (docs/MODULES.md §14): the file is at most `ICS_MAX_BYTES` (the fetch refuses more). It is
 * cut into its events with a plain line scan that keeps only the properties the module uses (no descriptions, no
 * attachments, no alarms), each kept line at most `MAX_LINE_CHARS`; then each event is parsed on its own, a batch of
 * `PARSE_BATCH` at a time with a yield to the event loop between batches, and each repeating event is expanded at most
 * `MAX_SERIES_STEPS` steps, with a yield every `STEP_BATCH` steps and at most `MAX_STEPS` in all. At most `MAX_EVENTS`
 * events and `MAX_OCCURRENCES` occurrences are kept (the earliest), and the result says when that cut anything. A
 * malformed event is skipped and counted; it never fails the file.
 */

export type ICAL = typeof ICALModule

export const ICS_MAX_BYTES = 1024 * 1024
const MAX_LINE_CHARS = 8_000
const MAX_TEXT_CHARS = 1_000
const MAX_EVENTS = 5_000
const MAX_TIMEZONES = 40
const MAX_TIMEZONE_LINES = 400
const PARSE_BATCH = 10
export const MAX_SERIES_STEPS = 20_000
export const MAX_STEPS = 200_000
const STEP_BATCH = 1_000
export const MAX_OCCURRENCES = 3_000

/** The properties of an event the module reads; every other one is dropped before parsing. */
const KEPT = new Set(["UID", "DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "SUMMARY", "LOCATION", "STATUS", "TRANSP"])
const TEXT_PROPS = new Set(["SUMMARY", "LOCATION"])

export interface IcsOccurrence {
  readonly uid: string
  /** Epoch ms; an all-day event's local midnight in the household's zone. */
  readonly start: number
  /** Epoch ms, exclusive. */
  readonly end: number
  readonly allDay: boolean
  readonly title: string
  readonly location?: string
  readonly busy: boolean
}

export interface IcsResult {
  readonly occurrences: ReadonlyArray<IcsOccurrence>
  /** Events that could not be read (malformed), or repeat too often to expand (every minute or second). */
  readonly skipped: number
  /** Something was left out because of a bound: more events, steps or occurrences than kept. */
  readonly cut: boolean
}

export interface IcsWindow {
  /** Epoch ms: occurrences that end at or before it are left out. */
  readonly from: number
  /** Epoch ms: occurrences that start at or after it are left out. */
  readonly to: number
}

/** The property name of a content line ("DTSTART;TZID=…:…" is DTSTART). */
const nameOf = (line: string): string => {
  const end = line.search(/[;:]/)
  return (end < 0 ? line : line.slice(0, end)).toUpperCase()
}

interface Blocks {
  readonly events: ReadonlyArray<string>
  readonly timezones: ReadonlyMap<string, string>
  readonly cut: boolean
}

/** A text property's line cut to a bound, never ending in half an escape. */
const cutText = (line: string): string => {
  if (line.length <= MAX_TEXT_CHARS) return line
  return line.slice(0, MAX_TEXT_CHARS).replace(/\\+$/, (s) => (s.length % 2 === 0 ? s : s.slice(0, -1)))
}

/**
 * The events and time zones of the file, as small texts: lines unfolded, only the kept properties of each event at
 * its own level (nested alarms dropped), bounded. One pass over the lines, in steps with a yield between them.
 */
const splitBlocks = (text: string): Effect.Effect<Blocks> =>
  Effect.gen(function*() {
    const raw = text.split(/\r?\n/)
    const events: Array<string> = []
    const timezones = new Map<string, string>()
    let cut = false
    let event: Array<string> | undefined
    let zone: Array<string> | undefined
    let nested = 0
    let line: string | undefined
    const take = (l: string) => {
      if (zone !== undefined) {
        if (zone.length < MAX_TIMEZONE_LINES) zone.push(l)
        const name = nameOf(l)
        if (name === "END" && l.slice(4).trim().toUpperCase() === "VTIMEZONE" && nested === 0) {
          const id = zone.find((z) => nameOf(z) === "TZID")?.slice(5).trim()
          if (id !== undefined && id !== "" && timezones.size < MAX_TIMEZONES) timezones.set(id, zone.join("\r\n"))
          zone = undefined
        } else if (name === "BEGIN" && l.slice(6).trim().toUpperCase() !== "VTIMEZONE") nested++
        else if (name === "END") nested = Math.max(0, nested - 1)
        return
      }
      const name = nameOf(l)
      if (event !== undefined) {
        if (name === "BEGIN") nested++
        else if (name === "END" && nested > 0) nested--
        else if (name === "END") {
          event.push("END:VEVENT")
          if (events.length < MAX_EVENTS) events.push(event.join("\r\n"))
          else cut = true
          event = undefined
        } else if (nested === 0 && KEPT.has(name)) {
          if (TEXT_PROPS.has(name)) event.push(cutText(l))
          else if (l.length <= MAX_LINE_CHARS) event.push(l)
        }
        return
      }
      const value = l.slice(6).trim().toUpperCase()
      if (name === "BEGIN" && value === "VEVENT") {
        event = ["BEGIN:VEVENT"]
        nested = 0
      } else if (name === "BEGIN" && value === "VTIMEZONE") {
        zone = ["BEGIN:VTIMEZONE"]
        nested = 0
      }
    }
    for (let i = 0; i < raw.length; i++) {
      const l = raw[i]!
      // A line that starts with a space or a tab continues the one before it (RFC 5545 §3.1).
      if ((l.startsWith(" ") || l.startsWith("\t")) && line !== undefined) {
        if (line.length <= MAX_LINE_CHARS) line += l.slice(1)
        continue
      }
      if (line !== undefined) take(line)
      line = l
      if (i % 5_000 === 4_999) yield* Effect.yieldNow
    }
    if (line !== undefined) take(line)
    return { events, timezones, cut }
  })

/** The TZIDs an event names. */
const zonesNamed = (block: string): ReadonlyArray<string> => {
  const out = new Set<string>()
  for (const m of block.matchAll(/;TZID=("?)([^:;"]+)\1/gi)) out.add(m[2]!)
  return [...out]
}

type Time = InstanceType<ICAL["Time"]>
type Component = InstanceType<ICAL["Component"]>

/** The instant of an ICS time: UTC and VTIMEZONE times by `ical.js`; a floating time in the IANA zone its TZID names, else the household's. */
const instantOfTime = (t: Time, zoneName: string | undefined, home: string): number => {
  if (t.isDate) return startOfDay({ year: t.year, month: t.month, day: t.day }, home)
  const tzid = t.zone?.tzid
  if (tzid !== undefined && tzid !== "floating") return t.toUnixTime() * 1000
  const named = (t as unknown as { readonly timezone?: unknown }).timezone
  const zone = (typeof named === "string" ? normalizeTimeZone(named) : undefined) ?? (zoneName !== undefined ? normalizeTimeZone(zoneName) : undefined) ?? home
  return instantOf({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }, zone)
}

const textOf = (c: Component, name: string): string => {
  const v = c.getFirstPropertyValue(name)
  return typeof v === "string" ? v : ""
}

const byStart = (a: IcsOccurrence, b: IcsOccurrence) => a.start - b.start || a.end - b.end

/** One line, trimmed, single-spaced, without control characters, at most `max`. */
export const cleanLine = (text: string, max: number): string =>
  text
    .replace(LONE_SURROGATE, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[\ud800-\udbff]$/, "")
    .trim()

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * The occurrences of `text` in `window`. Fails only when the text is not a calendar (`"not-calendar"`); everything
 * inside it that cannot be read is skipped and counted.
 */
export const expandIcs = (
  ICAL: ICAL,
  text: string,
  window: IcsWindow,
  home: string,
  bounds: { readonly titleChars: number; readonly placeChars: number }
): Effect.Effect<IcsResult, "not-calendar"> =>
  Effect.gen(function*() {
    const firstLine = text.replace(/^﻿/, "").trimStart().split(/\r?\n/, 1)[0] ?? ""
    if (firstLine.trim().toUpperCase() !== "BEGIN:VCALENDAR") return yield* Effect.fail("not-calendar" as const)
    const blocks = yield* splitBlocks(text)
    let cut = blocks.cut
    let skipped = 0
    // Parse each event on its own, with the time zones it names.
    const parsed: Array<Component> = []
    for (let i = 0; i < blocks.events.length; i++) {
      if (i % PARSE_BATCH === PARSE_BATCH - 1) yield* Effect.yieldNow
      const block = blocks.events[i]!
      const zones = zonesNamed(block).flatMap((z) => {
        const vt = blocks.timezones.get(z)
        return vt === undefined ? [] : [vt]
      })
      try {
        const root = new ICAL.Component(ICAL.parse(["BEGIN:VCALENDAR", "VERSION:2.0", ...zones, block, "END:VCALENDAR"].join("\r\n")))
        const vevent = root.getFirstSubcomponent("vevent")
        if (vevent === null || vevent.getFirstProperty("dtstart") === null) skipped++
        else parsed.push(vevent)
      } catch {
        skipped++
      }
    }
    // Group by UID: the master event and the overrides of its occurrences (RECURRENCE-ID).
    const groups = new Map<string, { master?: Component; overrides: Array<Component> }>()
    parsed.forEach((c, i) => {
      const uid = textOf(c, "uid") || `no-uid-${i}`
      const g = groups.get(uid) ?? { overrides: [] }
      if (c.getFirstProperty("recurrence-id") !== null) g.overrides.push(c)
      else if (g.master === undefined) g.master = c
      groups.set(uid, g)
    })
    const out: Array<IcsOccurrence> = []
    let steps = 0
    const emit = (uid: string, item: Component, start: number, end: number, allDay: boolean) => {
      if (end <= window.from || start >= window.to) return
      if (textOf(item, "status").toUpperCase() === "CANCELLED") return
      const title = cleanLine(textOf(item, "summary"), bounds.titleChars)
      const location = cleanLine(textOf(item, "location"), bounds.placeChars)
      out.push({
        uid,
        start,
        end: Math.max(end, start),
        allDay,
        title,
        ...(location !== "" ? { location } : {}),
        busy: !allDay && textOf(item, "transp").toUpperCase() !== "TRANSPARENT"
      })
    }
    // The earliest `MAX_OCCURRENCES` are kept: past twice that, sort and cut, so no sort is ever of more than that.
    const compact = () => {
      if (out.length < 2 * MAX_OCCURRENCES) return
      out.sort(byStart)
      out.length = MAX_OCCURRENCES
      cut = true
    }
    let n = 0
    for (const [uid, g] of groups) {
      if (n++ % PARSE_BATCH === PARSE_BATCH - 1) {
        compact()
        yield* Effect.yieldNow
      }
      if (steps >= MAX_STEPS) {
        cut = true
        break
      }
      try {
        // Overrides whose master is not in the file are events of their own.
        const singles = g.master === undefined ? g.overrides : []
        for (const c of singles) {
          const e = new ICAL.Event(c)
          const zone = (e.startDate as unknown as { timezone?: string }).timezone
          emit(uid, c, instantOfTime(e.startDate, zone, home), instantOfTime(e.endDate, zone, home), e.startDate.isDate)
        }
        if (g.master === undefined) continue
        const event = new ICAL.Event(g.master, { exceptions: g.overrides })
        const zone = (event.startDate as unknown as { timezone?: string }).timezone
        if (!event.isRecurring()) {
          emit(uid, g.master, instantOfTime(event.startDate, zone, home), instantOfTime(event.endDate, zone, home), event.startDate.isDate)
          continue
        }
        const rule = g.master.getFirstPropertyValue("rrule") as { freq?: string } | null
        if (rule !== null && (rule.freq === "SECONDLY" || rule.freq === "MINUTELY")) {
          skipped++
          continue
        }
        const it = event.iterator()
        for (let k = 0; k < MAX_SERIES_STEPS; k++) {
          if (++steps % STEP_BATCH === 0) {
            compact()
            yield* Effect.yieldNow
          }
          if (steps >= MAX_STEPS) {
            cut = true
            break
          }
          const t = it.next()
          if (t === undefined || t === null) break
          // The occurrence's own place in the series: past the window, the series is done here.
          if (instantOfTime(t, zone, home) >= window.to) break
          const d = event.getOccurrenceDetails(t)
          emit(uid, d.item.component, instantOfTime(d.startDate, zone, home), instantOfTime(d.endDate, zone, home), d.startDate.isDate)
          if (k === MAX_SERIES_STEPS - 1) cut = true
        }
      } catch {
        skipped++
      }
    }
    out.sort(byStart)
    if (out.length > MAX_OCCURRENCES) {
      cut = true
      out.length = MAX_OCCURRENCES
    }
    return { occurrences: out, skipped, cut }
  })
