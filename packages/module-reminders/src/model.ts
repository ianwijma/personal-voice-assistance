import { defineCollection, type Row } from "@pva/core"
import { type Language, nextOccurrence, speakMoment, type LocalDate } from "@pva/language"
import { isLine, StoredText } from "@pva/module-contracts"
import { Effect, Schema } from "effect"

const PERSON = /^[a-z0-9][a-z0-9_-]{0,39}$/
const Epoch = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8_640_000_000_000_000 }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))

export const TEXT_CHARS = 160
export const WHEN_CHARS = 120
/** The most notifications one row may still owe a take-down for (an older ring and the present one, with room). */
export const STOP_NOTES = 4

/** One line of the person's own words, for a tool's parameter. */
export const Line = (max: number) => StoredText(max).check(Schema.makeFilter((t: string) => isLine(t, max) || "one line, without line breaks"))

/** An occurrence handed to delivery and not yet delivered: its time, the moment the late rule counts from, the tries. */
export const Owed = Schema.Struct({
  /** The occurrence (the notification's key is made of the reminder's id and this). */
  at: Epoch,
  /** What the late rule is applied to: the occurrence itself, or the end of a snooze, or a change of words while it rang. */
  from: Epoch,
  /** Tries made so far (each written before it is made). */
  attempts: Count,
  /** When to try again if this try is not written as delivered. */
  tryAt: Epoch
})
export type Owed = typeof Owed.Type

/** A delivered occurrence nobody has answered yet. */
export const Ring = Schema.Struct({
  at: Epoch,
  deliveredAt: Epoch,
  /** Effective deadline displayed after a snooze; `at` remains the stable occurrence key. */
  from: Schema.optionalKey(Epoch),
  /** Put off until then: its notification and card were taken down, and it is sent again at that moment. */
  snoozeUntil: Schema.optionalKey(Epoch)
})
export type Ring = typeof Ring.Type

/** Cleanup owed: notifications (by occurrence) and the card still to be taken down, and when to try again. */
export const Stop = Schema.Struct({
  notes: Schema.Array(Epoch).check(Schema.isMaxLength(STOP_NOTES)),
  card: Schema.Boolean,
  /** When present, only the card of this occurrence is owed cleanup. */
  cardAt: Schema.optionalKey(Epoch),
  attempts: Count,
  tryAt: Epoch
})
export type Stop = typeof Stop.Type

/** The last occurrence that was given up, and why (for the record; never spoken). */
export const Dropped = Schema.Struct({
  at: Epoch,
  why: Schema.Literals(["late", "failed", "superseded", "unanswered"]),
  when: Epoch
})

/**
 * One reminder. Household data (`whose: "household"`), or personal with its owner (a Members id): a personal one is
 * delivered, read and listed only where `Privacy.mayReveal(owner, device)` says so at that moment.
 *
 * Its state is the series (`dueAt` and the rule), at most one owed delivery, at most one outstanding ring and the
 * cleanup still owed; `nextAt` is the next moment anything happens for the row, and its one job is planned for it.
 */
export const Reminder = Schema.Struct({
  text: Line(TEXT_CHARS),
  whose: Schema.Literals(["household", "personal"]),
  owner: Schema.optionalKey(StoredText(40).check(Schema.isPattern(PERSON))),
  /** `open`: a series, an owed delivery or a ring is left. The others are finished and kept a few days. */
  state: Schema.Literals(["open", "done", "cancelled", "lapsed"]),
  /** The next occurrence not yet handed to delivery; absent once a one-off was handed over or a finite series ended. */
  dueAt: Schema.optionalKey(Epoch),
  owed: Schema.optionalKey(Owed),
  ring: Schema.optionalKey(Ring),
  stop: Schema.optionalKey(Stop),
  /** Cleanup was given up after its tries: a ring or card may still be open and ends by itself when it expires. */
  stopFailed: Schema.optionalKey(Schema.Boolean),
  /** The next moment anything happens for this row (`planOf`); indexed with `state`. Absent: nothing is planned. */
  nextAt: Schema.optionalKey(Epoch),
  /** The device it was set on, where it is delivered; the assistant that heard it. */
  deviceId: Schema.optionalKey(StoredText(64)),
  assistantId: Schema.optionalKey(StoredText(40)),
  /** Whose turn set it (for the record: delivery never trusts it). */
  setBy: Schema.optionalKey(StoredText(40)),
  /** A repeating reminder: its rule (`@pva/language`), its start and its zone. */
  rrule: Schema.optionalKey(StoredText(100)),
  dtstart: Schema.optionalKey(StoredText(70)),
  timeZone: Schema.optionalKey(StoredText(64)),
  /** The notification or card whose snooze was handled last: pressing it again does not push it further. */
  handled: Schema.optionalKey(StoredText(64)),
  dropped: Schema.optionalKey(Dropped),
  /** When it finished; indexed with `state` so the daily clean-up reads the oldest first. */
  endedAt: Schema.optionalKey(Epoch)
})
export type Reminder = typeof Reminder.Type

export const reminders = defineCollection({
  name: "reminders",
  scope: "household",
  schema: Reminder,
  maxChars: 2_000,
  indexes: [["state", "nextAt"], ["state", "endedAt"]]
})

/** An owed delivery cannot be tried while a take-down of the notification with its own key is still owed (a change of words while it rang). */
export const blocked = (r: Reminder): boolean => r.owed !== undefined && r.stop?.notes.includes(r.owed.at) === true

/** When the owed delivery can next be tried: its own time, and never before the take-down it waits for is tried again. */
export const owedTryAt = (r: Reminder): number | undefined =>
  r.owed === undefined ? undefined : blocked(r) ? Math.max(r.owed.tryAt, r.stop!.tryAt) : r.owed.tryAt

/** The next moment anything happens for a row: its series, its owed delivery's next try, its snooze, its cleanup. */
export const planOf = (r: Reminder): number | undefined => {
  const times = r.state === "open"
    ? [r.dueAt, owedTryAt(r), r.ring?.snoozeUntil, r.stop?.tryAt]
    : [r.stop?.tryAt]
  let min: number | undefined
  for (const t of times) if (t !== undefined && (min === undefined || t < min)) min = t
  return min
}

/** A resend retains its delivered ring's effective due time while `owed.from` starts the new lateness window. */
export const owedDueAt = (r: Reminder, o: Owed): number => r.ring?.at === o.at ? r.ring.from ?? r.ring.at : o.from

/** The moment a reminder next speaks (its owed occurrence, its snooze, its next occurrence); absent when it only waits for an answer. */
export const speaksAt = (r: Reminder): number | undefined => {
  let min: number | undefined
  for (const t of [r.owed === undefined ? undefined : owedDueAt(r, r.owed), r.ring?.snoozeUntil, r.dueAt]) if (t !== undefined && (min === undefined || t < min)) min = t
  return min
}

export const isRepeat = (r: Reminder): boolean => r.rrule !== undefined

export const nextOf = (r: Reminder, after: number): number | undefined =>
  r.rrule === undefined || r.dtstart === undefined || r.timeZone === undefined ? undefined : nextOccurrence({ rrule: r.rrule, dtstart: r.dtstart, timeZone: r.timeZone }, after)

/** Rows a list reads at once (`maxListRows` for this collection at 2,000 characters). */
export const PAGE = 12
/** The most open reminders one answer reads (17 pages of 12), and it says when there were more. */
export const SCAN_ROWS = 204

export interface Scan<A> {
  readonly rows: ReadonlyArray<Row<A>>
  readonly cut: boolean
}

/** A bounded scan, page by page with a real yield between pages; says when it was cut short. */
export const scanRows = <A, E>(list: (q: { readonly limit: number; readonly after?: Row<A> }) => Effect.Effect<ReadonlyArray<Row<A>>, E>, max = SCAN_ROWS) =>
  Effect.gen(function*() {
    const rows: Array<Row<A>> = []
    let after: Row<A> | undefined
    for (let page = 0; page < max / PAGE; page++) {
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
  return typeof zone === "string" && zone.trim() !== "" ? zone.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone
}

// ---- words ---------------------------------------------------------------------------------------------------------

/** A word for a credential (English and Dutch), as a whole word: "password", "PIN", "door code", "wachtwoord", "pincode". */
const CREDENTIAL = String.raw`(?<![\p{L}\p{N}])(?:pass(?:word|code|phrase)|pin(?:[\s-]?code)?|\p{L}*code|\p{L}*wachtwoord|wachtzin)(?![\p{L}\p{N}])`
/** The word followed by "is", ":" or "=" and a value: "my password is violet-badger", "PIN: 1234", "code = x". */
const STATED = new RegExp(String.raw`${CREDENTIAL}\s*(?:is(?![\p{L}\p{N}])|[:=])\s*\S`, "iu")
const WORD = new RegExp(CREDENTIAL, "giu")

/**
 * A stored reminder must not hold a secret. Refused: a credential word followed by "is", ":" or "=" and a value, whatever
 * the value looks like; and a credential word followed by text that is mostly digits ("door code 12 34").
 * "Change my password" and "change my password for the 2027 account" are ordinary reminders: a number is a value only
 * when it is stated or makes up the text after the word.
 */
export const holdsSecret = (text: string): boolean => {
  if (STATED.test(text)) return true
  WORD.lastIndex = 0
  for (let m = WORD.exec(text); m !== null; m = WORD.exec(text)) {
    const rest = text.slice(m.index + m[0].length).replace(/\s+/gu, "")
    const digits = [...rest].filter((c) => /\p{Nd}/u.test(c)).length
    if (digits >= 1 && digits * 2 >= [...rest].length) return true
  }
  return false
}

const words = (text: string): ReadonlyArray<string> => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "")

export interface Matches<A> {
  readonly rows: ReadonlyArray<Row<A>>
  /** One row whose words are exactly the words asked for. */
  readonly exact: boolean
}

/** The reminders whose words contain every word asked for; one whose text is exactly the words wins over longer ones. */
export const matching = <A extends { readonly text: string }>(rows: ReadonlyArray<Row<A>>, which: string): Matches<A> => {
  const literal = rows.filter((r) => r.value.text.toLowerCase() === which.toLowerCase())
  if (literal.length > 0) return { rows: literal, exact: literal.length === 1 }
  const wanted = words(which)
  if (wanted.length === 0) return { rows: [], exact: false }
  const exact = rows.filter((r) => words(r.value.text).join(" ") === wanted.join(" "))
  if (exact.length === 1) return { rows: exact, exact: true }
  return {
    rows: rows.filter((r) => {
      const have = words(r.value.text)
      return wanted.every((w) => have.some((h) => h.includes(w)))
    }),
    exact: false
  }
}

/**
 * Text cut to at most `max` UTF-16 units, at a code point boundary (a surrogate pair is never split), with "…" when it
 * was cut. Every limit in the module goes through this.
 */
export const cut = (text: string, max: number): string => {
  if (text.length <= max) return text
  if (max <= 1) return max === 1 ? "…" : ""
  let end = max - 1
  const before = text.charCodeAt(end - 1)
  if (before >= 0xd800 && before <= 0xdbff) end--
  return `${text.slice(0, end)}…`
}

/** `value` without the named keys: an optional field is removed, never set to `undefined`. */
export const without = <A extends object, K extends keyof A>(value: A, ...keys: ReadonlyArray<K>): Omit<A, K> => {
  const copy = { ...value }
  for (const k of keys) delete copy[k]
  return copy
}
