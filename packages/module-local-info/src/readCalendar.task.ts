// readCalendar.task.ts: a collection calendar (ICS text from outside) read into its next collections. One pure function,
// plain data in and out, run in a fresh worker thread for each call (`offThread` in binDay.ts) with a time, memory and
// result limit; `ical.js` is imported here only, so it is never loaded on the main thread.
import ICAL from "ical.js"
import { addDays, binOf, dayIn, dayNumber, type Entry, epochDay, HORIZON_DAYS, MAX_COLLECTIONS, MAX_EVENTS, MAX_WORK, rulesFromJson } from "./bins.ts"

/**
 * The input, in the one shape `offThread` takes (a flat record of strings and numbers). The owner's names are a JSON
 * text (`rulesJson`), decoded and checked here: at most 12, each `{ match, label }` of strings of at most 40 characters,
 * as the settings form allows.
 */
export interface ReadInput {
  readonly text: string
  /** Today in the household's zone (20261118): collections from the day before it on are kept. */
  readonly fromDay: number
  /** The household's zone: timed collections are ordered by their date there. */
  readonly zone: string
  readonly rulesJson: string
}

export type ReadResult =
  /** `entries`: the next `MAX_COLLECTIONS` collections, in order. `cut`: there are more after them. `unreadable`: events left out because they could not be read. */
  | { readonly _tag: "ok"; readonly entries: ReadonlyArray<Entry>; readonly cut: boolean; readonly unreadable: number }
  /** Not a calendar, or a calendar none of whose events could be read. */
  | { readonly _tag: "unreadable" }
  /** Over `MAX_EVENTS` events or `MAX_WORK` steps: never cut short into a list that looks complete. */
  | { readonly _tag: "too-large" }
  /** The input itself is not of the allowed shape (the owner's names): a bug of the caller, never read as a calendar. */
  | { readonly _tag: "bad-input" }

class TooLarge extends Error {}

const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The offset of `zone` from UTC at an instant, in ms. */
const offsetAt = (ms: number, zone: string): number => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value)
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000
}

/** A wall-clock time in an IANA zone as an instant (a time the clocks skip is taken at the offset from before). */
const wallToEpoch = (t: ICAL.Time, zone: string): number => {
  const guess = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)
  const first = offsetAt(guess - 12 * 3_600_000, zone)
  const at = guess - first
  const second = offsetAt(at, zone)
  return second === first ? at : guess - second
}

/** The TZID a time was written with, if any. */
const tzidOf = (t: ICAL.Time): string | undefined => {
  const tzid = (t as unknown as { readonly timezone?: unknown }).timezone
  return typeof tzid === "string" && tzid !== "" ? tzid : undefined
}

/**
 * The instant of a time, or `undefined` for a date or a floating time (read as the date it is written on). `series` is
 * the TZID of the series' DTSTART: its expanded occurrences are wall times in that zone, which ical.js does not carry over.
 */
const instantOf = (t: ICAL.Time, series?: string): number | undefined => {
  if (t.isDate) return undefined
  if (t.zone === ICAL.Timezone.utcTimezone) return t.toUnixTime() * 1000
  const tzid = tzidOf(t) ?? series
  if (tzid !== undefined && isZone(tzid)) return wallToEpoch(t, tzid)
  if (t.zone !== undefined && t.zone !== null && t.zone !== ICAL.Timezone.localTimezone && typeof t.zone.tzid === "string" && t.zone.tzid !== "floating") return t.toUnixTime() * 1000
  return undefined
}

const written = (t: ICAL.Time): number => dayNumber(t.year, t.month, t.day)

/** The occurrence as an entry's date or instant, and the date it falls on in the household's zone. */
const placeOf = (t: ICAL.Time, zone: string, series?: string): { readonly d?: number; readonly t?: number; readonly day: number } => {
  const at = instantOf(t, series)
  return at === undefined ? { d: written(t), day: written(t) } : { t: at, day: dayIn(at, zone) }
}

/** How an occurrence and a RECURRENCE-ID are matched: the date of a date, the instant of a zoned time, the written time of a floating one. */
const keyOf = (t: ICAL.Time, series?: string): string => {
  if (t.isDate) return `d${written(t)}`
  const at = instantOf(t, series)
  return at !== undefined ? `t${at}` : `f${written(t)}T${t.hour}:${t.minute}:${t.second}`
}

/**
 * The first start the expansion needs: a series without COUNT is moved forward by whole periods to just before the
 * window (at least two periods before it), so a series that began long ago costs no more than one that begins today.
 * Moved by whole periods of its own interval, it keeps its phase; the moved start itself, emitted by the expansion, lies
 * before the window and is never kept. A series with COUNT (its instances are counted from its start) is not moved.
 */
const seekStart = (component: ICAL.Component, start: ICAL.Time, fromDay: number): ICAL.Time => {
  const rules = component.getAllProperties("rrule")
  if (rules.length !== 1) return start
  const rule = rules[0]!.getFirstValue() as ICAL.Recur
  if (rule.count !== null && rule.count !== undefined) return start
  const interval = Math.max(1, rule.interval ?? 1)
  const at = (year: number, month: number, day: number) =>
    new ICAL.Time({ year, month, day, hour: start.hour, minute: start.minute, second: start.second, isDate: start.isDate }, start.zone)
  const from = { year: Math.floor(fromDay / 10_000), month: Math.floor(fromDay / 100) % 100 }
  if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
    const period = rule.freq === "DAILY" ? interval : 7 * interval
    const k = Math.floor((epochDay(fromDay) - epochDay(written(start))) / period) - 2
    if (k <= 0) return start
    const moved = start.clone()
    moved.adjust(k * period, 0, 0, 0)
    return moved
  }
  if (rule.freq === "MONTHLY" && start.day <= 28) {
    const months = (from.year * 12 + from.month) - (start.year * 12 + start.month)
    const k = Math.floor(months / interval) - 2
    if (k <= 0) return start
    const total = start.year * 12 + (start.month - 1) + k * interval
    return at(Math.floor(total / 12), (total % 12) + 1, start.day)
  }
  if (rule.freq === "YEARLY" && !(start.month === 2 && start.day === 29)) {
    const k = Math.floor((from.year - start.year) / interval) - 2
    return k <= 0 ? start : at(start.year + k * interval, start.month, start.day)
  }
  return start
}

const SUB_DAILY = new Set(["SECONDLY", "MINUTELY", "HOURLY"])

const isCancelled = (c: ICAL.Component) => String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED"

export const readCalendar = (input: ReadInput): ReadResult => {
  const { text, fromDay, zone } = input
  const rules = typeof input.rulesJson === "string" ? rulesFromJson(input.rulesJson) : undefined
  if (rules === undefined || typeof text !== "string" || !Number.isInteger(fromDay) || typeof zone !== "string") return { _tag: "bad-input" }
  let calendar: ICAL.Component
  try {
    if (!/^\s*(﻿)?\s*BEGIN:VCALENDAR/i.test(text.slice(0, 200))) return { _tag: "unreadable" }
    const parsed = ICAL.parse(text) as unknown
    const first = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : parsed
    calendar = new ICAL.Component(first as ConstructorParameters<typeof ICAL.Component>[0])
    if (calendar.name !== "vcalendar") return { _tag: "unreadable" }
  } catch {
    return { _tag: "unreadable" }
  }
  // A calendar's own zones, for TZIDs that are not IANA names (an export from Outlook names "W. Europe Standard Time").
  for (const vtz of calendar.getAllSubcomponents("vtimezone")) {
    try {
      ICAL.TimezoneService.register(vtz)
    } catch {
      // A zone that cannot be read: its events fall back to their written dates.
    }
  }
  const events = calendar.getAllSubcomponents("vevent")
  if (events.length > MAX_EVENTS) return { _tag: "too-large" }

  // Events by UID: the series (no RECURRENCE-ID) and its moved or cancelled instances.
  const groups = new Map<string, { master?: ICAL.Component; overrides: Array<ICAL.Component> }>()
  events.forEach((c, i) => {
    const uid = c.getFirstPropertyValue("uid")
    const key = typeof uid === "string" && uid !== "" ? `u${uid}` : `#${i}`
    const group = groups.get(key) ?? { overrides: [] }
    if (c.hasProperty("recurrence-id")) group.overrides.push(c)
    else if (group.master === undefined) group.master = c
    else group.overrides.push(c) // a second event with the same UID and no RECURRENCE-ID: read as an event of its own
    groups.set(key, group)
  })

  const until = addDays(fromDay, HORIZON_DAYS)
  const keepFrom = addDays(fromDay, -1)
  const found = new Map<string, Entry & { readonly day: number }>()
  let work = 0
  let readable = 0
  let unreadable = 0
  const step = () => {
    if (++work > MAX_WORK) throw new TooLarge()
  }
  const add = (time: ICAL.Time, summary: string, series?: string): boolean => {
    const place = placeOf(time, zone, series)
    if (place.day < keepFrom || place.day > until) return false
    const bin = binOf(summary, rules)
    if (bin === undefined) throw new Error("no title")
    const entry = { ...(place.d !== undefined ? { d: place.d } : { t: place.t! }), ...bin, day: place.day }
    found.set(`${place.day}:${bin.k}:${bin.l ?? ""}`, entry)
    return true
  }
  const titleOf = (c: ICAL.Component, fallback?: string): string => {
    const s = c.getFirstPropertyValue("summary")
    const title = typeof s === "string" && s.trim() !== "" ? s : fallback
    if (title === undefined) throw new Error("no title")
    return title
  }

  try {
    for (const group of groups.values()) {
      step()
      try {
        const { master, overrides } = group
        if (overrides.some((o) => o.getFirstProperty("recurrence-id")?.getParameter("range") !== undefined)) throw new Error("RANGE")
        if (master === undefined) {
          // Instances without their series: each is read as an event of its own.
          for (const o of overrides) {
            step()
            if (!isCancelled(o)) add(new ICAL.Event(o).startDate, titleOf(o))
          }
          readable++
          continue
        }
        if (isCancelled(master)) {
          readable++
          continue
        }
        const event = new ICAL.Event(master)
        const title = titleOf(master)
        const start = event.startDate
        if (start === null || start === undefined) throw new Error("no start")
        // Moved and cancelled instances, by their RECURRENCE-ID: the series' own occurrence is left out for each.
        const replaced = new Set<string>()
        const moved: Array<{ readonly start: ICAL.Time; readonly title: string }> = []
        for (const o of overrides) {
          step()
          if (!o.hasProperty("recurrence-id")) {
            if (!isCancelled(o)) moved.push({ start: new ICAL.Event(o).startDate, title: titleOf(o, title) })
            continue
          }
          const rid = o.getFirstPropertyValue("recurrence-id") as ICAL.Time
          replaced.add(keyOf(rid, tzidOf(start)))
          if (!isCancelled(o)) moved.push({ start: new ICAL.Event(o).startDate, title: titleOf(o, title) })
        }
        const tzid = tzidOf(start)
        const isReplaced = (t: ICAL.Time) => replaced.has(keyOf(t, tzid)) || replaced.has(`d${written(t)}`)
        if (!event.isRecurring()) {
          if (!isReplaced(start)) add(start, title)
        } else {
          for (const r of master.getAllProperties("rrule")) {
            const freq = (r.getFirstValue() as ICAL.Recur).freq
            if (SUB_DAILY.has(freq)) throw new Error("sub-daily")
          }
          const expansion = new ICAL.RecurExpansion({ component: master, dtstart: seekStart(master, start, fromDay) })
          let kept = 0
          for (;;) {
            step()
            const next = expansion.next()
            if (next === undefined || next === null) break
            const day = placeOf(next, zone, tzid).day
            if (day > until) break
            if (day < keepFrom || isReplaced(next)) continue
            if (add(next, title, tzid)) kept++
            // A series' later occurrences cannot be among the next collections once it has more than that many of its own.
            if (kept > MAX_COLLECTIONS) break
          }
        }
        for (const m of moved) add(m.start, m.title)
        readable++
      } catch (e) {
        if (e instanceof TooLarge) throw e
        unreadable++
      }
    }
  } catch (e) {
    if (e instanceof TooLarge) return { _tag: "too-large" }
    throw e
  }
  if (readable === 0 && unreadable > 0) return { _tag: "unreadable" }
  const all = [...found.values()].sort((a, b) => a.day - b.day || a.k.localeCompare(b.k) || (a.l ?? "").localeCompare(b.l ?? ""))
  const entries = all.slice(0, MAX_COLLECTIONS).map(({ day: _day, ...entry }) => entry)
  return { _tag: "ok", entries, cut: all.length > MAX_COLLECTIONS, unreadable }
}

export default readCalendar
