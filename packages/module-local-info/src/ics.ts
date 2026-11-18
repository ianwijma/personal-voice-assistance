import ICAL from "ical.js"

/**
 * Reading a collection calendar (ICS), with real bounds: the text is cut by `safeFetch`'s `maxBytes` before it gets
 * here (`ICS_MAX_BYTES`), a calendar has at most `MAX_EVENTS` events, a repeating event is expanded at most
 * `MAX_PER_EVENT` times and not past `HORIZON_DAYS`, and the answer is at most `MAX_PICKUPS` pickups. `ICAL.parse` is
 * synchronous: on 256 KiB it takes a few tens of milliseconds, and `ics.test.ts` measures a calendar of that size.
 */
export const ICS_MAX_BYTES = 256 * 1024
export const MAX_EVENTS = 2_000
export const MAX_PER_EVENT = 400
export const MAX_PICKUPS = 500
export const HORIZON_DAYS = 400

/** The kinds of bin the module knows by name; anything else is `other`, with the calendar's own words as its label. */
export const BIN_KINDS = ["gft", "paper", "plastic", "rest", "glass", "other"] as const
export type BinKind = (typeof BIN_KINDS)[number]

/** One day with one bin collected: `day` is the date as the number 20261119. */
export interface Pickup {
  readonly day: number
  readonly kind: BinKind
  /** The calendar's own words (one line, at most 60 characters), kept for `other` and for names the owner mapped. */
  readonly label?: string
}

export interface OwnerRule {
  /** Words that must appear in the calendar's title (any case). */
  readonly match: string
  /** What the bin is called. */
  readonly label: string
}

/** Words (their beginnings) that name a kind, Dutch and English. Checked in this order. */
const KEYWORDS: ReadonlyArray<readonly [Exclude<BinKind, "other">, ReadonlyArray<string>]> = [
  ["gft", ["gft", "groen", "groente", "organic", "green", "compost", "bioafval", "biobak"]],
  ["paper", ["papier", "paper", "karton", "cardboard", "oud-papier"]],
  ["plastic", ["pmd", "plastic", "verpakking", "packag", "drankkarton", "blik"]],
  ["glass", ["glas", "glass"]],
  ["rest", ["rest", "grij", "grey", "gray", "general", "residual", "zwart", "black"]]
]

const tokens = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((t) => t.length > 0)

/** The kind a title names, or `undefined`. */
export const classify = (text: string): Exclude<BinKind, "other"> | undefined => {
  const words = tokens(text)
  for (const [kind, starts] of KEYWORDS) {
    if (words.some((w) => starts.some((s) => w.startsWith(s)))) return kind
  }
  return undefined
}

/** The kind a word the person said names ("pmd", "groen", "papier", "glass"): the same table, also by whole name. */
export const kindOfSpoken = (text: string): BinKind | undefined => classify(text)

const clean = (text: string): string => text.replace(/[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]+/gu, " ").replace(/\s+/g, " ").trim()

/** A calendar's title as a one-line label of at most 60 characters, without lone surrogates; "" when nothing is left. */
export const labelOf = (text: string): string => {
  const one = clean(text).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
  return one.length <= 60 ? one : one.slice(0, 60).replace(/[\ud800-\udbff]$/, "").trimEnd()
}

/** What bin a calendar title is: the owner's mapping first, then the built-in words, else `other` with its own words. */
export const pickupOf = (day: number, summary: string, rules: ReadonlyArray<OwnerRule>): Pickup | undefined => {
  const lower = summary.toLowerCase()
  const rule = rules.find((r) => r.match.trim() !== "" && lower.includes(r.match.trim().toLowerCase()))
  if (rule !== undefined) {
    const label = labelOf(rule.label)
    const kind = classify(label) ?? classify(summary) ?? "other"
    return { day, kind, ...(label === "" ? {} : { label }) }
  }
  const kind = classify(summary)
  if (kind !== undefined) return { day, kind }
  const label = labelOf(summary)
  return label === "" ? undefined : { day, kind: "other", label }
}

export type ParseResult =
  | { readonly _tag: "ok"; readonly pickups: ReadonlyArray<Pickup>; readonly cut: boolean }
  | { readonly _tag: "unreadable" }

const dayNumber = (y: number, m: number, d: number): number => y * 10_000 + m * 100 + d

/** The date a moment falls on in `zone`, as `20261119`. */
export const dayIn = (epochMs: number, zone: string): number => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epochMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return dayNumber(get("year"), get("month"), get("day"))
}

/** `20261119` as `{ year, month, day }`. */
export const localDate = (day: number) => ({ year: Math.floor(day / 10_000), month: Math.floor(day / 100) % 100, day: day % 100 })

/** The day after `day`, in the calendar (no zone needed). */
export const addDays = (day: number, n: number): number => {
  const d = localDate(day)
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return dayNumber(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

const dayOfTime = (t: ICAL.Time, zone: string): number => {
  // A date, or a time with no zone ("floating"): the date as written. A moment in UTC or in a zone: the date in the household's.
  if (t.isDate || t.zone === ICAL.Timezone.localTimezone) return dayNumber(t.year, t.month, t.day)
  return dayIn(t.toUnixTime() * 1000, zone)
}

/**
 * The collections of an ICS text from `from` (a day, inclusive) on for `HORIZON_DAYS`: each event's date, each repeat of a
 * repeating event, the owner's names applied. Never throws: a text that is not a calendar is `unreadable`.
 */
export const parsePickups = (text: string, options: { readonly from: number; readonly zone: string; readonly rules: ReadonlyArray<OwnerRule> }): ParseResult => {
  let calendar: ICAL.Component
  try {
    if (!/^\s*(﻿)?\s*BEGIN:VCALENDAR/i.test(text.slice(0, 200))) return { _tag: "unreadable" }
    calendar = new ICAL.Component(ICAL.parse(text))
  } catch {
    return { _tag: "unreadable" }
  }
  const until = addDays(options.from, HORIZON_DAYS)
  const found = new Map<string, Pickup>()
  let cut = false
  const events = calendar.getAllSubcomponents("vevent")
  if (events.length > MAX_EVENTS) cut = true
  for (const component of events.slice(0, MAX_EVENTS)) {
    try {
      if (component.hasProperty("recurrence-id")) continue // an exception to a repeat: the repeat itself is read
      const event = new ICAL.Event(component)
      const summary = event.summary
      if (typeof summary !== "string" || summary === "" || !event.startDate) continue
      const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase()
      if (status === "CANCELLED") continue
      const add = (day: number) => {
        if (day < options.from || day > until) return
        const pickup = pickupOf(day, summary, options.rules)
        if (pickup === undefined) return
        found.set(`${pickup.day}:${pickup.kind}:${pickup.label ?? ""}`, pickup)
      }
      if (!event.isRecurring()) {
        add(dayOfTime(event.startDate, options.zone))
        continue
      }
      const iterator = event.iterator()
      for (let n = 0; n < MAX_PER_EVENT; n++) {
        const next = iterator.next()
        if (!next) break
        const day = dayOfTime(next, options.zone)
        if (day > until) break
        add(day)
        if (n === MAX_PER_EVENT - 1) cut = true
      }
    } catch {
      // One event that cannot be read is left out; the rest of the calendar is still read.
    }
  }
  const pickups = [...found.values()].sort((a, b) => a.day - b.day || a.kind.localeCompare(b.kind) || (a.label ?? "").localeCompare(b.label ?? ""))
  if (pickups.length > MAX_PICKUPS) return { _tag: "ok", pickups: pickups.slice(0, MAX_PICKUPS), cut: true }
  return { _tag: "ok", pickups, cut }
}
