import { defineCollection, type Row } from "@pva/core"
import { type Language, nextOccurrence, speakMoment, type LocalDate } from "@pva/language"
import { isLine, StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"

const PERSON = /^[a-z0-9][a-z0-9_-]{0,39}$/
const Epoch = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))

export const TEXT_CHARS = 160
export const WHEN_CHARS = 120

/** One line of the person's own words, for a tool's parameter. */
export const Line = (max: number) => StoredText(max).check(Schema.makeFilter((t: string) => isLine(t, max) || "one line, without line breaks"))

/**
 * One reminder. Household data (`whose: "household"`), or personal with its owner (a Members id): a personal one is
 * delivered, read and listed only where `Privacy.mayReveal(owner, device)` says so at that moment.
 */
export const Reminder = Schema.Struct({
  text: Line(TEXT_CHARS),
  whose: Schema.Literals(["household", "personal"]),
  owner: Schema.optionalKey(StoredText(40).check(Schema.isPattern(PERSON))),
  /** `open`: waiting for its moment, or delivered and not yet answered. The others are finished and kept a few days. */
  state: Schema.Literals(["open", "done", "cancelled", "lapsed"]),
  /** The next moment (epoch ms). A repeating reminder: its next occurrence. Indexed with `state`. */
  dueAt: Epoch,
  /** The device it was set on, where it is delivered; the assistant that heard it. */
  deviceId: Schema.optionalKey(StoredText(64)),
  assistantId: Schema.optionalKey(StoredText(40)),
  /** Whose turn set it (for the record: delivery never trusts it). */
  setBy: Schema.optionalKey(StoredText(40)),
  /** A repeating reminder: its rule (`@pva/language`), its start and its zone. */
  rrule: Schema.optionalKey(StoredText(100)),
  dtstart: Schema.optionalKey(StoredText(70)),
  timeZone: Schema.optionalKey(StoredText(64)),
  /** A one-off whose moment was delivered (the `dueAt` it was delivered for). */
  notifiedFor: Schema.optionalKey(Epoch),
  /** A snooze that is waiting, or the retry of a delivery that failed (the time its job is for). */
  snoozeAt: Schema.optionalKey(Epoch),
  /** The notification or presentation whose snooze was handled last: pressing again does not push it further. */
  handled: Schema.optionalKey(StoredText(64)),
  /** When it finished; indexed with `state` so the daily clean-up reads the oldest first. */
  endedAt: Schema.optionalKey(Epoch)
})
export type Reminder = typeof Reminder.Type

export const reminders = defineCollection({
  name: "reminders",
  scope: "household",
  schema: Reminder,
  maxChars: 2_000,
  indexes: [["state", "dueAt"], ["state", "endedAt"]]
})

/** Rows a list reads at once (`maxListRows` for this collection at 2,000 characters). */
export const PAGE = 12
/** The most open reminders one answer reads (17 pages of 12), and it says when there were more. */
export const SCAN_ROWS = 204

export interface Scan<A> {
  readonly rows: ReadonlyArray<Row<A>>
  readonly cut: boolean
}

/** A bounded scan, page by page with a real yield between pages; says when it was cut short. */
export const scanRows = <A, E>(list: (q: { readonly limit: number; readonly after?: Row<A> }) => Effect.Effect<ReadonlyArray<Row<A>>, E>) =>
  Effect.gen(function*() {
    const rows: Array<Row<A>> = []
    let after: Row<A> | undefined
    for (let page = 0; page < SCAN_ROWS / PAGE; page++) {
      const got = yield* list({ limit: PAGE, ...(after !== undefined ? { after } : {}) })
      rows.push(...got)
      if (got.length < PAGE) return { rows, cut: false } satisfies Scan<A>
      after = got.at(-1)
      yield* Effect.yieldNow
    }
    const beyond = yield* list({ limit: 1, ...(after !== undefined ? { after } : {}) })
    return { rows, cut: beyond.length > 0 } satisfies Scan<A>
  })

// ---- time ----------------------------------------------------------------------------------------------------------

export interface Local extends LocalDate {
  readonly hour: number
  readonly minute: number
}

const formats = new Map<string, Intl.DateTimeFormat>()
const formatIn = (zone: string) => {
  let f = formats.get(zone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" })
    formats.set(zone, f)
  }
  return f
}

/** The wall clock of an instant in a zone. */
export const localOf = (ms: number, zone: string): Local => {
  const parts: Record<string, number> = {}
  for (const p of formatIn(zone).formatToParts(ms)) if (p.type !== "literal") parts[p.type] = Number(p.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute! }
}

/** A moment as it is said: "tomorrow at half past five in the evening". */
export const momentText = (ms: number, language: Language, zone: string, now: number): string => {
  const l = localOf(ms, zone)
  const today = localOf(now, zone)
  return speakMoment({ date: l, time: l }, language, today, { period: true }) ?? `${l.year}-${l.month}-${l.day} ${l.hour}:${String(l.minute).padStart(2, "0")}`
}

const cardFormats = new Map<string, Intl.DateTimeFormat>()
/** A moment compactly, for a card or a list on a screen: "Fri 20 Nov, 17:00". */
export const shortMoment = (ms: number, language: Language, zone: string): string => {
  const key = `${language}|${zone}`
  let f = cardFormats.get(key)
  if (f === undefined) {
    f = new Intl.DateTimeFormat(language === "nl" ? "nl-NL" : "en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    cardFormats.set(key, f)
  }
  return f.format(ms)
}

/** The next local midnight after `now`, daylight-saving correct (a daily rule at 00:00 in the zone). */
export const endOfToday = (now: number, zone: string): number =>
  nextOccurrence({ rrule: "FREQ=DAILY", dtstart: `DTSTART;TZID=${zone}:20260101T000000`, timeZone: zone }, now) ?? now + 86_400_000

/** The household's zone: `HOME_TIME_ZONE`, and when it is empty (the default), this machine's. */
export const homeZone = (home: Readonly<Record<string, unknown>>): string => {
  const zone = home.HOME_TIME_ZONE
  return typeof zone === "string" && zone.trim() !== "" ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone
}

// ---- words ---------------------------------------------------------------------------------------------------------

/** A stored reminder must not hold a code or a password: a word for one beside a run of digits is refused. */
const CODE = /(pass(word|code)|pin\s?code|pincode|door\s?code|access\s?code|wachtwoord|deurcode|toegangscode)/i
export const looksLikeCode = (text: string): boolean => CODE.test(text) && /\d{4,}/.test(text)

const words = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "")

/** The reminders whose words contain every word asked for; one whose text is exactly the words wins over longer ones. */
export const matching = <A extends { readonly text: string }>(rows: ReadonlyArray<Row<A>>, which: string): ReadonlyArray<Row<A>> => {
  const wanted = words(which)
  if (wanted.length === 0) return []
  const exact = rows.filter((r) => words(r.value.text).join(" ") === wanted.join(" "))
  if (exact.length === 1) return exact
  return rows.filter((r) => {
    const have = words(r.value.text)
    return wanted.every((w) => have.some((h) => h.includes(w)))
  })
}

export const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`)

/** `value` without the named keys: an optional field is removed, never set to `undefined`. */
export const without = <A extends object, K extends keyof A>(value: A, ...keys: ReadonlyArray<K>): Omit<A, K> => {
  const copy = { ...value }
  for (const k of keys) delete copy[k]
  return copy
}
