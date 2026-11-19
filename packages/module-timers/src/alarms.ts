import { type Actor, ActionError, CurrentJob, CurrentTurn, defineAction, defineCollection, defineModule, Devices, Param, type PreparedJob, type Row, Setting } from "@pva/core"
import { describeRRule, nextOccurrence, parseDateTime, parseDtstart, parseRecurrence, parseTimeOfDay, speakMoment, speakTime } from "@pva/language"
import { homeLanguage, type Language, say, StoredText } from "@pva/module-contracts"
import { Clock, DateTime, Effect, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import {
  capitalise,
  type ClockTime,
  cleanName,
  cut,
  dateOf,
  dateText,
  homeZone,
  isBusy,
  listOf,
  localOf,
  MAX_INSTANT,
  NAME_CHARS,
  nameKey,
  nominalDateOf,
  scan,
  speakLeft,
  timeOf,
  timeText
} from "./common.ts"
import { alarmTexts as texts } from "./texts.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Data

const DEVICE = StoredText(64)
const NOTE = StoredText(40)
const Instant = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_INSTANT }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const DateText = Schema.String.check(Schema.isMaxLength(10), Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
const TimeText = Schema.String.check(Schema.isMaxLength(5), Schema.isPattern(/^\d{2}:\d{2}$/))

/** An occurrence: its nominal local date and time (what the person set), and its instant in the alarm's zone. */
const Occurrence = Schema.Struct({ date: DateText, time: TimeText, at: Instant })
/**
 * A ring that is owed: which (`n`), the occurrence it is for (its nominal date and time; a snooze keeps its occurrence's),
 * the instant it is due, the tries so far and when to try again.
 */
const Owed = Schema.Struct({ n: Count, date: DateText, time: TimeText, at: Instant, snoozed: Schema.optionalKey(Schema.Boolean), attempts: Count, retryAt: Instant })
/**
 * The ring delivered last, with the nominal date and time of the occurrence it is for (finding 8: it is selected by that
 * time); `again` is the instant a snooze or "five more minutes" rings it again.
 */
const Ring = Schema.Struct({
  n: Count,
  notification: NOTE,
  date: DateText,
  time: TimeText,
  at: Instant,
  until: Instant,
  /** Effective due instant of a delivered snooze, retained for selection; `at` is when it was sent. */
  snoozedAt: Schema.optionalKey(Instant),
  again: Schema.optionalKey(Instant),
  pressed: Schema.optionalKey(NOTE)
})
/** The row's previous ring, still to be taken away, with the occurrence it was for. */
const Withdraw = Schema.Struct({ notification: NOTE, date: DateText, time: TimeText, at: Schema.optionalKey(Instant), until: Instant, retryAt: Instant })

/**
 * One alarm: household data that rings on one device (`deviceId`); its name is shown and spoken only there. A repeating
 * alarm keeps its recurrence (`rrule`, `dtstart`) and its `next` occurrence not yet handed to delivery, kept as the
 * nominal local date and time with the instant derived from them. What is owed for it (a ring to deliver, a snooze to
 * ring again, rings to withdraw) is in the same row, `nextAt` is the next moment anything happens, and one scheduler job
 * (key `alarm:<id>`) is planned for that moment in every write.
 */
export const Alarm = Schema.Struct({
  name: Schema.optionalKey(StoredText(NAME_CHARS)),
  deviceId: DEVICE,
  /** The zone the alarm was set in, canonical (`homeZone`). */
  timeZone: StoredText(64),
  rrule: Schema.optionalKey(StoredText(200)),
  dtstart: Schema.optionalKey(StoredText(80)),
  next: Schema.optionalKey(Occurrence),
  /** Occurrences handed to delivery so far: part of each ring's notification key. */
  n: Count,
  owed: Schema.optionalKey(Owed),
  ring: Schema.optionalKey(Ring),
  /** At most one: a row never has two notifications of its own open (a new ring is sent only once this is gone). */
  withdraw: Schema.optionalKey(Withdraw),
  /** `set`: something is still to ring (an occurrence, an owed ring, a snooze); `ended`: nothing. */
  phase: Schema.Literals(["set", "ended"]),
  pending: Schema.Boolean,
  nextAt: Instant,
  endedAt: Instant
})
export type Alarm = typeof Alarm.Type

export const alarms = defineCollection({
  name: "alarms",
  scope: "household",
  schema: Alarm,
  // The worst legal alarm is about 2,200 characters of JSON: one list reads 10 rows.
  maxChars: 2_300,
  indexes: ["phase", ["phase", "endedAt"], ["pending", "nextAt"]]
})

const PAGE = 10
/** The most alarms that may be set at once. */
export const MAX_ALARMS = 50
const SCAN_SET = 60
const SCAN_PENDING = 200
/** An occurrence whose ring could not be sent within this long of its time is not rung; the person is told it was missed. */
export const DELIVER_WITHIN_MS = 15 * 60_000
export const RETRY_RING_MS = 30_000
export const RETRY_CLEANUP_MS = 60_000
const KEEP_ENDED_MS = 24 * 3_600_000
/**
 * The hours a time said without "morning" or "evening" falls in: an alarm "at seven" is 07:00 and "at two" 14:00, never
 * 19:00 or 02:00 (the parser's default band, 07:00–21:00, would read "6:45" as 18:45).
 */
export const ALARM_BAND = { from: "05:00", to: "16:59" } as const
const MORE_MINUTES = 5

// ---------------------------------------------------------------------------------------------------------------------
// Words and dates

const timeWords = (time: ClockTime, language: Language): string => speakTime(time, language, { style: "12h", period: true }) ?? timeText(time)

/** "tomorrow at quarter to seven in the morning": a nominal date and time, said relative to `now` in the zone. */
const momentOf = (date: string, time: string, now: number, zone: string, language: Language): string =>
  speakMoment({ date: dateOf(date), time: timeOf(time) }, language, localOf(now, zone).date, { style: "12h", period: true }) ?? `${date} ${time}`

/** An instant said relative to now (a snooze's instant: it is never in a gap of its own). */
const instantWords = (at: number, now: number, zone: string, language: Language): string => {
  const l = localOf(at, zone)
  return momentOf(dateText(l.date), timeText(l.time), now, zone, language)
}

const isRepeating = (value: Alarm): boolean => value.rrule !== undefined && value.dtstart !== undefined
const specOf = (value: Alarm) => ({ rrule: value.rrule!, dtstart: value.dtstart!, timeZone: value.timeZone })

/** "every weekday": the rule without its time (a moment says the time). */
const ruleWords = (value: Alarm, language: Language): string => {
  if (!isRepeating(value)) return ""
  const start = parseDtstart(value.dtstart!)
  const words = describeRRule(value.rrule!, language, { ...(start !== undefined ? { start: { year: start.start.year, month: start.start.month, day: start.start.day } } : {}), timeZone: value.timeZone })
  return words ?? say(texts, language, "ruleUnknown")
}

/** The clock time a series rings at: its DTSTART's. */
const seriesTime = (value: Alarm): ClockTime => {
  const start = parseDtstart(value.dtstart!)!
  return { hour: start.start.hour, minute: start.start.minute }
}

/** The occurrence of a series at `instant`, with its nominal date (finding 8: never the gap-shifted instant's date). */
const occurrenceAt = (value: Alarm, instant: number): typeof Occurrence.Type => {
  const time = seriesTime(value)
  return { date: dateText(nominalDateOf(instant, time, value.timeZone)), time: timeText(time), at: instant }
}

/** The series' first occurrence strictly after `after`, or none (the series ended). */
const nextOf = (value: Alarm, after: number): typeof Occurrence.Type | undefined => {
  const at = nextOccurrence(specOf(value), after)
  return at === undefined ? undefined : occurrenceAt(value, at)
}

/** The latest occurrence of a series at or before `now`, from `from` (an occurrence at or before now) on. */
const latestUpTo = (value: Alarm, from: typeof Occurrence.Type, now: number): typeof Occurrence.Type => {
  if (from.at === now) return from
  let latest = nextOf(value, from.at)
  if (latest === undefined || latest.at > now) return from
  // Search the instant range, not every day since the outage. nextOccurrence jumps from the supplied instant;
  // at most 54 probes for the stored instant range, and only one on an ordinary on-time occurrence.
  let low = latest.at
  let high = now
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2)
    const candidate = nextOf(value, mid)
    if (candidate !== undefined && candidate.at <= now) {
      latest = candidate
      low = candidate.at
    } else high = mid
  }
  return latest
}

// ---------------------------------------------------------------------------------------------------------------------
// The row's plan

/** The next moment anything happens for the row, or `undefined`. */
export const nextAtOf = (v: Alarm): number | undefined => {
  const at: Array<number> = []
  if (v.next !== undefined) at.push(v.next.at)
  if (v.owed !== undefined) at.push(v.owed.retryAt)
  if (v.ring !== undefined) at.push(v.ring.again ?? v.ring.until)
  if (v.withdraw !== undefined) at.push(Math.min(v.withdraw.retryAt, v.withdraw.until))
  return at.length === 0 ? undefined : Math.max(0, Math.min(...at))
}

const withPhase = (v: Alarm, now: number): Alarm => {
  const set = v.next !== undefined || v.owed !== undefined || v.ring?.again !== undefined
  if (set) return v.phase === "set" ? v : { ...v, phase: "set", endedAt: 0 }
  return v.phase === "ended" ? v : { ...v, phase: "ended", endedAt: now }
}

/** A value without one optional member. */
const withoutKey = <K extends "ring" | "withdraw" | "owed" | "next">(v: Alarm, key: K): Alarm => {
  const { [key]: _x, ...rest } = v
  return rest as Alarm
}

/**
 * The ring that is to be taken away. A row holds at most one: a new ring is sent only once the previous one is gone
 * (finding 3). Should a second ever come, `undefined` says so and the one already owed is kept.
 */
const withdrawing = (
  v: Alarm,
  ring: { readonly notification: string; readonly until: number; readonly date: string; readonly time: string; readonly again?: number; readonly snoozedAt?: number },
  now: number
): Alarm | undefined =>
  v.withdraw === undefined || v.withdraw.notification === ring.notification
    ? { ...v, withdraw: { notification: ring.notification, date: ring.date, time: ring.time, ...(ring.again !== undefined ? { at: ring.again } : ring.snoozedAt !== undefined ? { at: ring.snoozedAt } : {}), until: ring.until, retryAt: now } }
    : undefined

/** What is due at `now` without an outside call: an occurrence or a snooze becomes an owed ring, the series moves on. */
const advance = (v: Alarm, now: number): Alarm => {
  let out = v
  if (out.next !== undefined && out.next.at <= now) {
    const due = isRepeating(out) ? latestUpTo(out, out.next, now) : out.next
    const { next: _n, ...rest } = out
    // The series moves on in the same write, whatever becomes of the delivery (finding 1).
    const following = isRepeating(out) ? nextOf(out, now) : undefined
    out = { ...rest, ...(following !== undefined ? { next: following } : {}), n: out.n + 1, owed: { n: out.n + 1, date: due.date, time: due.time, at: due.at, attempts: 0, retryAt: now } }
  }
  if (out.ring?.again !== undefined && out.ring.again <= now) {
    const again = out.ring.again
    const { again: _a, ...ring } = out.ring
    // The snooze rings for the same occurrence: it keeps that occurrence's nominal date and time.
    // A newer series occurrence wins over an old snooze when both became due during an outage.
    out = out.owed !== undefined && out.owed.at >= again ? { ...out, ring } : { ...out, ring, n: out.n + 1, owed: { n: out.n + 1, date: ring.date, time: ring.time, at: again, snoozed: true, attempts: 0, retryAt: now } }
  }
  if (out.ring !== undefined && out.ring.again === undefined && out.ring.until <= now) {
    const { ring: _r, ...rest } = out
    out = rest
  }
  if (out.withdraw !== undefined && out.withdraw.until <= now) out = withoutKey(out, "withdraw")
  return withPhase(out, now)
}

// ---------------------------------------------------------------------------------------------------------------------
// The module

const settings = {
  snoozeMinutes: Setting.number({ label: "Snooze for", description: "Minutes a ringing alarm waits when someone says snooze.", default: 9, integer: true, min: 1, max: 30, unit: "minutes" }),
  ringMinutes: Setting.number({ label: "Ring for", description: "Minutes an alarm rings before it stops by itself.", default: 15, integer: true, min: 1, max: 120, unit: "minutes" })
}

const fail = (message: string) => new ActionError({ message })

type Scope = "next" | "all" | undefined

/** The shared part's operations (`ctx.shared`), one at a time. */
export interface AlarmsOps {
  readonly set: (when: string, name: string | undefined) => Effect.Effect<string, ActionError>
  readonly list: Effect.Effect<string, ActionError>
  readonly cancel: (which: string | undefined, scope: Scope) => Effect.Effect<string, ActionError>
}

type Target = { readonly kind: "one"; readonly row: Row<Alarm>; readonly snoozed: boolean; readonly ringing: boolean } | { readonly kind: "answer"; readonly say: string }

export const alarmsModule = defineModule({
  apiVersion: 2,
  id: "alarms",
  name: "Alarms",
  description: "One-off and repeating alarms that ring on the device they were set for.",
  enabledByDefault: false,
  settings,
  storage: { version: 1, collections: [alarms] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const store = ctx.store.collection(alarms)
      const lock = yield* Semaphore.make(1)
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect)
      const language = (): Language => homeLanguage(ctx.host.view())
      const zone = () => homeZone(ctx.host.view())
      const snoozeMs = () => (ctx.settings.snoozeMinutes ?? 9) * 60_000
      const ringMs = () => (ctx.settings.ringMinutes ?? 15) * 60_000
      const failure = (e: unknown) => fail(say(texts, language(), isBusy(e) ? "busy" : "failed"))
      const unreadable = () => fail(say(texts, language(), "unreadable"))

      const actorNow = (given?: Actor) =>
        Effect.map(CurrentJob, (job): { readonly actor?: Actor } => (given !== undefined ? { actor: given } : job !== undefined ? { actor: { kind: "job", jobId: job.jobId } } : {}))

      // -- writing: the one place a row and its job are written --------------------------------------------------------

      /** Write an alarm with its plan and its one job (key `alarm:<id>`, origin the alarm's device) in one transaction. */
      const commit = (row: Row<Alarm> | undefined, id: string, value: Alarm, actor?: Actor, extra: ReadonlyArray<PreparedJob> = []) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const phased = withPhase(value, now)
          const next = nextAtOf(phased)
          const planned: Alarm = { ...phased, pending: next !== undefined, nextAt: next ?? 0 }
          const job = next === undefined ? undefined : yield* ctx.scheduler.prepare({ handler: "due", key: `alarm:${id}`, payload: { id }, at: next, origin: { deviceId: value.deviceId } })
          const options = yield* actorNow(actor)
          const written = yield* ctx.store.transaction((tx) => {
            const c = tx.collection(alarms)
            const out = row === undefined ? c.insert(planned, { id, ...options }) : c.update(id, () => planned, { expectRev: row.rev, ...options })
            job?.writeIn(tx)
            // A job that goes with this write (the Health report of a missed ring): both or neither.
            for (const j of extra) j.writeIn(tx)
            return out
          })
          if (job === undefined && row?.value.pending === true) yield* Effect.ignore(ctx.scheduler.cancel({ key: `alarm:${id}` }))
          return written
        })

      // -- reconcile -------------------------------------------------------------------------------------------------------

      /**
       * Send the owed ring. Past the late rule it is given up: the silent card saying it was missed is sent (it names no
       * cause: finding 13), and when that is refused too, the job that reports it on the Health page is written in the
       * transaction that gives it up (finding 12); when neither can be done it stays owed. Before a ring is sent, the row's
       * previous ring is resolved: a row never has two of its own open (finding 5); while that fails it stays owed.
       */
      const deliver = (id: string, v: Alarm, now: number): Effect.Effect<{ readonly value: Alarm; readonly jobs: ReadonlyArray<PreparedJob> }> =>
        Effect.gen(function*() {
          const owed = v.owed!
          const lang = language()
          const later = (x: Alarm) => ({ value: { ...x, owed: { ...owed, attempts: owed.attempts + 1, retryAt: now + RETRY_RING_MS } }, jobs: [] })
          if (now - owed.at > DELIVER_WITHIN_MS) {
            // The send may have succeeded just before the deadline and lost its outcome write. Recover that open ring.
            const open = yield* Effect.result(ctx.notify.list())
            if (open._tag === "Failure") return later(v)
            const sent = open.success.find((n) => n.key === `alarm:${id}:${owed.n}`)
            if (sent !== undefined) {
              const ring = { n: owed.n, notification: sent.id, date: owed.date, time: owed.time, at: sent.sentAt, until: sent.expiresAt, ...(owed.snoozed === true ? { snoozedAt: owed.at } : {}) }
              return { value: { ...withoutKey(v, "owed"), ring }, jobs: [] }
            }
            const due = localOf(owed.at, v.timeZone)
            const date = owed.snoozed === true ? dateText(due.date) : owed.date
            const time = owed.snoozed === true ? timeText(due.time) : owed.time
            const missed = yield* Effect.result(ctx.notify.send({
              title: say(texts, lang, "missedTitle"),
              text: say(texts, lang, "missedText", { time: momentOf(date, time, now, v.timeZone, lang) }),
              key: `alarm-missed:${id}:${owed.n}`,
              target: "origin"
            }))
            if (missed._tag === "Success") return { value: withoutKey(v, "owed"), jobs: [] }
            const report = yield* Effect.result(ctx.scheduler.prepare({
              handler: "trouble",
              key: `trouble:${id}:${owed.n}`,
              inMs: 0,
              payload: { message: `An alarm could not ring, and the card saying so could not be sent either (${date} ${time}).` }
            }))
            if (report._tag === "Failure") return later(v)
            return { value: withoutKey(v, "owed"), jobs: [report.success] }
          }
          let out = v
          const previous = out.withdraw?.notification ?? out.ring?.notification
          if (previous !== undefined) {
            const gone = yield* Effect.result(ctx.notify.resolve(previous))
            if (gone._tag === "Failure") {
              const kept = out.ring !== undefined && out.withdraw === undefined ? withdrawing(withoutKey(out, "ring"), out.ring, now) ?? out : out
              return later(kept.withdraw !== undefined ? { ...kept, withdraw: { ...kept.withdraw, retryAt: now + RETRY_CLEANUP_MS } } : kept)
            }
            out = withoutKey(withoutKey(out, "ring"), "withdraw")
          }
          // What the clock says when it rings (the occurrence's own time, unless the clocks skipped it or it is a snooze).
          const time = timeWords(localOf(owed.at, v.timeZone).time, lang)
          const late = now - owed.at
          const sent = yield* Effect.result(ctx.notify.send({
            title: v.name !== undefined ? say(texts, lang, "title", { Name: cut(capitalise(v.name), 40) }) : say(texts, lang, "titlePlain"),
            text: late > 0 ? say(texts, lang, "ringTextLate", { time, late: speakLeft(late, lang) }) : say(texts, lang, "ringText", { time }),
            priority: "ring",
            key: `alarm:${id}:${owed.n}`,
            expiresInMs: ringMs(),
            actions: [{ id: "snooze", label: say(texts, lang, "snooze") }, { id: "more", label: say(texts, lang, "more") }],
            handler: "alarm",
            target: "origin"
          }))
          if (sent._tag === "Failure") return later(out)
          const ring = { n: owed.n, notification: sent.success.notification.id, date: owed.date, time: owed.time, at: now, until: sent.success.notification.expiresAt, ...(owed.snoozed === true ? { snoozedAt: owed.at } : {}) }
          return { value: { ...withoutKey(out, "owed"), ring }, jobs: [] }
        })

      /** Take away the row's previous ring (a failure is tried again a minute later, until the ring stops by itself). */
      const withdrawRings = (v: Alarm, now: number, force = false): Effect.Effect<Alarm> =>
        Effect.gen(function*() {
          const w = v.withdraw
          if (w === undefined || (w.retryAt > now && !force)) return v
          const done = yield* Effect.result(ctx.notify.resolve(w.notification))
          return done._tag === "Failure" ? { ...v, withdraw: { ...w, retryAt: now + RETRY_CLEANUP_MS } } : withoutKey(v, "withdraw")
        })

      /**
       * Let go of the row's owed ring or recorded ring (finding 2): the ring becomes the one to take away; an owed ring whose
       * send may have succeeded before its record failed is looked for among the open notifications by its key and becomes
       * the one to take away; only then is the owed delivery forgotten. Fails when the open notifications cannot be read.
       */
      const letGo = (id: string, v: Alarm, now: number) =>
        Effect.gen(function*() {
          const notifications = yield* ctx.notify.list()
          const open = new Set(notifications.map((n) => n.id))
          let out = v.withdraw !== undefined && !open.has(v.withdraw.notification) ? withoutKey(v, "withdraw") : v
          if (out.ring !== undefined && !open.has(out.ring.notification)) out = withoutKey(out, "ring")
          if (out.ring !== undefined) out = withdrawing(withoutKey(out, "ring"), out.ring, now) ?? out
          if (out.owed !== undefined) {
            const owed = out.owed
            const sent = notifications.find((n) => n.key === `alarm:${id}:${owed.n}`)
            if (sent !== undefined) {
              const taken = withdrawing(out, { notification: sent.id, until: sent.expiresAt, date: owed.date, time: owed.time, ...(owed.snoozed === true ? { snoozedAt: owed.at } : {}) }, now)
              if (taken === undefined) return yield* Effect.fail(new Error("a second ring to take away"))
              out = taken
            }
            out = withoutKey(out, "owed")
          }
          return out
        })

      /**
       * Do what is owed for one alarm at this moment, and plan what comes next. Inside the lock. What is due without an
       * outside call (an occurrence or a snooze becomes an owed ring; the series moves on) is written first, so the owed
       * ring is recorded before it is sent; then it is sent, old rings are withdrawn, and the outcome is written with the
       * next plan. Fails only when the store does.
       */
      const reconcile = (id: string, actor?: Actor, force = false, own = false) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          let row = yield* store.get(id)
          if (row === undefined) return undefined
          // A new occurrence or a snooze that comes due while an older ring is still owed replaces it: that one is let go
          // first (an open notification under its key becomes the ring to take away).
          const superseding = row.value.owed !== undefined && ((row.value.next !== undefined && row.value.next.at <= now) || (row.value.ring?.again !== undefined && row.value.ring.again <= now))
          if (superseding) row = yield* commit(row, id, yield* letGo(id, row.value, now), actor)
          const first = advance(row.value, now)
          if (first !== row.value) row = yield* commit(row, id, first, actor)
          let v = row.value
          let jobs: ReadonlyArray<PreparedJob> = []
          // A ring is sent only by the row's own job, whose origin is the row's device (where `target: "origin"` rings);
          // anything else that finds a ring owed leaves it to that job, planned for now.
          if (own && v.owed !== undefined && v.owed.retryAt <= now) {
            const d = yield* deliver(id, v, now)
            v = d.value
            jobs = d.jobs
          }
          v = yield* withdrawRings(v, now, force)
          if (v !== row.value || jobs.length > 0 || nextAtOf(v) !== (row.value.pending ? row.value.nextAt : undefined)) row = yield* commit(row, id, v, actor, jobs)
          return row
        })

      // The mutation is committed even when its immediate cleanup cannot be read or written; its keyed job retries.
      const change = (row: Row<Alarm>, value: Alarm, actor?: Actor) =>
        Effect.flatMap(commit(row, row.id, value, actor), (committed) => reconcile(row.id, actor, true).pipe(Effect.catch(() => Effect.succeed(committed))))

      // -- reading ---------------------------------------------------------------------------------------------------------

      const readSet = scan<Alarm>((q) => store.list({ where: { phase: "set" }, orderBy: { field: "createdAt", direction: "asc" }, ...q }), PAGE, SCAN_SET)
      const readPending = scan<Alarm>((q) => store.list({ where: { pending: true }, orderBy: { field: "nextAt", direction: "asc" }, ...q }), PAGE, SCAN_PENDING)

      /**
       * What a person can still act on: alarms set (with their snoozes), and ended ones whose ring is open now; for a cancel,
       * also ended ones whose ring is still being taken away (finding 9), which lists do not show.
       */
      type Open = { readonly ids: ReadonlySet<string>; readonly keys: ReadonlySet<string | undefined> }
      const ringingNow = (row: Row<Alarm>, open: Open): boolean => row.value.owed !== undefined
        ? open.keys.has(`alarm:${row.id}:${row.value.owed.n}`)
        : row.value.ring !== undefined && open.ids.has(row.value.ring.notification)

      const readLive = (forCancel = false) =>
        Effect.gen(function*() {
          const set = yield* readSet
          const notifications = yield* ctx.notify.list()
          const open: Open = { ids: new Set(notifications.map((n) => n.id)), keys: new Set(notifications.map((n) => n.key)) }
          const pending = yield* readPending
          const ended = pending.rows.filter((r) => r.value.phase === "ended")
          const ringing = ended.filter((r) => ringingNow(r, open))
          const cleanup = forCancel ? ended.filter((r) => !ringing.includes(r) && r.value.withdraw !== undefined) : []
          const all = [...set.rows, ...ringing, ...cleanup]
          const upcoming = (r: Row<Alarm>) => Math.min(r.value.next?.at ?? Infinity, r.value.ring?.again ?? Infinity, r.value.owed?.at ?? Infinity)
          return { rows: all.sort((a, b) => upcoming(a) - upcoming(b)), open, cut: set.cut || pending.cut }
        })

      const callDevice = Effect.map(CurrentTurn, (turn) => turn?.deviceId)
      const deviceName = (id: string, lang: Language): string => ctx.host.service(Devices)?.get(id)?.name ?? say(texts, lang, "anotherDevice")

      /**
       * One alarm in words, for the device `here`: its name only when it rings on `here`; elsewhere its time and device.
       * A snooze still to ring and a ring sounding now are said too.
       */
      const itemOf = (row: Row<Alarm>, here: string | undefined, open: Open, now: number, lang: Language): string => {
        const v = row.value
        const z = v.timeZone
        const mine = v.deviceId === here
        const device = deviceName(v.deviceId, lang)
        const rule = ruleWords(v, lang)
        const ringing = ringingNow(row, open)
        // A current ring or snooze belongs to its own occurrence, even when the series already has a next date.
        const occurrence = v.owed ?? (v.ring !== undefined && (v.ring.again !== undefined || ringing) ? v.ring : v.next) ?? v.withdraw
        const moment = occurrence === undefined ? "" : momentOf(occurrence.date, occurrence.time, now, z, lang)
        const repeat = isRepeating(v)
        const what = !mine
          ? say(texts, lang, repeat ? "itemElsewhereRepeat" : "itemElsewhere", { moment, rule, device })
          : v.name !== undefined
          ? say(texts, lang, repeat ? "itemNamedRepeat" : "itemNamed", { name: v.name, moment, rule })
          : repeat ? say(texts, lang, "itemRepeat", { moment, rule }) : moment
        if (v.ring?.again !== undefined) return say(texts, lang, "itemAgain", { what, moment: instantWords(v.ring.again, now, z, lang) })
        if (ringing) return say(texts, lang, "itemRinging", { what })
        if (v.next === undefined && v.withdraw !== undefined) return say(texts, lang, "itemCleanup", { what })
        return what
      }

      const answer = (text: string): Target => ({ kind: "answer", say: text })

      /**
       * The times an alarm is known by: its next occurrence, its snooze, and the nominal time of the occurrence its owed ring,
       * its ring or its ring being taken away is for (finding 8: the time it was set for, not when the ring was sent).
       */
      const timesOf = (v: Alarm, open: Open): Array<ClockTime> => [
        ...(v.next !== undefined ? [timeOf(v.next.time)] : []),
        ...(v.ring?.again !== undefined ? [localOf(v.ring.again, v.timeZone).time] : []),
        ...(v.owed !== undefined ? [timeOf(v.owed.time), ...(v.owed.snoozed === true ? [localOf(v.owed.at, v.timeZone).time] : [])] : []),
        ...(v.ring !== undefined ? [timeOf(v.ring.time), ...(v.ring.snoozedAt !== undefined && open.ids.has(v.ring.notification) ? [localOf(v.ring.snoozedAt, v.timeZone).time] : [])] : []),
        ...(v.withdraw !== undefined ? [timeOf(v.withdraw.time), ...(v.withdraw.at !== undefined ? [localOf(v.withdraw.at, v.timeZone).time] : [])] : [])
      ]

      /**
       * Which alarm `which` means: a name of an alarm of this device (names are not matched on other devices: they are not
       * told there), or a time ("6:45") of any alarm; with nothing said, the only one there is; otherwise a question.
       */
      const resolve = (which: string | undefined, here: string | undefined, now: number, forCancel = false): Effect.Effect<Target, ActionError> =>
        Effect.gen(function*() {
          const lang = language()
          const read = yield* readLive(forCancel).pipe(Effect.mapError(unreadable))
          const one = (row: Row<Alarm>, snoozed = false): Target => ({ kind: "one", row, snoozed, ringing: ringingNow(row, read.open) })
          const ask = (rows: ReadonlyArray<Row<Alarm>>, cutShort: boolean): Target =>
            answer(say(texts, lang, cutShort ? "whichCut" : "which", { count: rows.length, list: listOf(rows.map((r) => itemOf(r, here, read.open, now, lang)), lang) }))
          const key = which === undefined ? "" : nameKey(which)
          if (which === undefined) {
            if (read.rows.length === 1 && !read.cut) return one(read.rows[0]!)
            if (read.rows.length === 0) return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "none"))
            return ask(read.rows, read.cut)
          }
          const byName = read.rows.filter((r) => r.value.deviceId === here && r.value.name !== undefined && nameKey(r.value.name) === key)
          if (byName.length === 1) return one(byName[0]!)
          if (byName.length > 1) return ask(byName, false)
          const time = parseTimeOfDay(which!, lang, { band: ALARM_BAND })
          if (time.kind === "ok") {
            const at = read.rows.filter((r) => timesOf(r.value, read.open).some((t) => t.hour === time.value.hour && t.minute === time.value.minute))
            if (at.length === 1) {
              const row = at[0]!
              const ring = row.value.ring
              // A delivered snooze selected only by its effective time is the occurrence to stop, not the next series day.
              const snoozedAt = row.value.owed?.snoozed === true && ringingNow(row, read.open) ? row.value.owed.at
                : ring?.snoozedAt !== undefined && read.open.ids.has(ring.notification) ? ring.snoozedAt : undefined
              const snoozed = snoozedAt !== undefined && timeText(localOf(snoozedAt, row.value.timeZone).time) === timeText(time.value)
                && row.value.next?.time !== timeText(time.value)
              return one(row, snoozed)
            }
            if (at.length > 1) return ask(at, false)
            const words = timeWords({ hour: time.value.hour, minute: time.value.minute }, lang)
            return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "noTimeMatch", { time: words }))
          }
          return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "unknown", { name: cut(which!, NAME_CHARS) }))
        })

      /** Whether a ring of the row is still to be taken away. */
      const ringLeft = (row: Row<Alarm> | undefined) => row !== undefined && row.value.withdraw !== undefined

      /** The alarm with nothing more to ring: no next occurrence, no snooze; its owed ring and its ring let go. */
      const ended = (row: Row<Alarm>, now: number) => letGo(row.id, withoutKey(row.value, "next"), now)

      // -- the operations --------------------------------------------------------------------------------------------------

      const ops: AlarmsOps = {
        set: (when, name) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const clean = cleanName(name)
            if (clean === false) return yield* Effect.fail(fail(say(texts, lang, "badName")))
            const deviceId = yield* callDevice
            if (deviceId === undefined) return yield* Effect.fail(fail(say(texts, lang, "noDevice")))
            const now = yield* Clock.currentTimeMillis
            const z = zone()
            const options = { now, timeZone: z, band: ALARM_BAND }
            // A repeating alarm first ("every weekday at 6:45", also with the time first), then one moment ("seven").
            let rec = parseRecurrence(when, lang, options)
            if (rec.kind === "not-understood") rec = parseRecurrence(`${lang === "nl" ? "om" : "at"} ${when}`, lang, options)
            let value: Alarm
            const base = { ...(clean !== undefined ? { name: clean } : {}), deviceId, timeZone: z, n: 0, phase: "set" as const, pending: true, nextAt: 0, endedAt: 0 }
            if (rec.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
            if (rec.kind === "ok") {
              if (rec.value.timeDefaulted) return say(texts, lang, "noTime")
              const s = rec.value.start
              value = { ...base, rrule: rec.value.rrule, dtstart: rec.value.dtstart, next: { date: dateText(s), time: timeText({ hour: s.hour, minute: s.minute }), at: rec.value.startInstant } }
            } else {
              const at = parseDateTime(when, lang, options)
              if (at.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
              if (at.kind !== "ok") return say(texts, lang, "when")
              if (at.value.instant === undefined || at.value.time === undefined) return say(texts, lang, "noTime")
              if (at.value.inPast || at.value.instant <= now) return say(texts, lang, "passed")
              if (at.value.instant > DateTime.toEpochMillis(DateTime.add(DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(now), z), { years: 1 }))) return say(texts, lang, "tooFar")
              value = { ...base, next: { date: dateText(at.value.date), time: timeText(at.value.time), at: at.value.instant } }
            }
            const read = yield* readSet.pipe(Effect.mapError(failure))
            if (read.cut || read.rows.length >= MAX_ALARMS) return yield* Effect.fail(fail(say(texts, lang, "full", { count: MAX_ALARMS })))
            yield* commit(undefined, randomUUID(), value).pipe(Effect.mapError(failure))
            const moment = momentOf(value.next!.date, value.next!.time, now, z, lang)
            // Said on the device it was set on, which is the device it rings on: its name may be echoed here.
            if (isRepeating(value)) {
              const rule = ruleWords(value, lang)
              return clean !== undefined ? say(texts, lang, "setRepeatNamed", { Name: capitalise(clean), rule, moment }) : say(texts, lang, "setRepeat", { rule, moment })
            }
            return clean !== undefined ? say(texts, lang, "setNamed", { Name: capitalise(clean), moment }) : say(texts, lang, "set", { moment })
          })),

        list: locked(Effect.gen(function*() {
          const lang = language()
          const now = yield* Clock.currentTimeMillis
          const here = yield* callDevice
          const read = yield* readLive().pipe(Effect.mapError(unreadable))
          if (read.rows.length === 0) return read.cut ? yield* Effect.fail(unreadable()) : say(texts, lang, "none")
          const items = read.rows.map((r) => itemOf(r, here, read.open, now, lang))
          if (items.length === 1 && !read.cut) return say(texts, lang, "one", { item: items[0]! })
          return say(texts, lang, read.cut ? "severalCut" : "several", { count: items.length, list: listOf(items, lang) })
        })),

        cancel: (which, scope) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const here = yield* callDevice
            // An alarm whose ring is still being taken away is a candidate too (by name on its device, or by time): cancelling
            // it again finishes that.
            const t = yield* resolve(which, here, now, true)
            if (t.kind !== "one") return t.say
            const row = t.row
            const v = row.value
            const z = v.timeZone
            const pendingSay = (after: Row<Alarm> | undefined, text: string) => (ringLeft(after) ? say(texts, lang, "ringPending") : text)
            if (!isRepeating(v) || v.next === undefined) {
              const after = yield* Effect.flatMap(ended(row, now), (value) => change(row, value)).pipe(Effect.mapError(failure))
              const text = v.next !== undefined ? say(texts, lang, "cancelled", { moment: momentOf(v.next.date, v.next.time, now, z, lang) }) : v.ring?.again !== undefined
                ? say(texts, lang, "cancelledAgain")
                : say(texts, lang, "finished")
              return pendingSay(after, text)
            }
            const rule = ruleWords(v, lang)
            // A repeating alarm: only the next, or all of them. Never guessed (docs/MODULES-PLAN.md §2 row 6).
            if (scope === undefined) return say(texts, lang, "scope", { rule })
            if (scope === "all") {
              const after = yield* Effect.flatMap(ended(row, now), (value) => change(row, value)).pipe(Effect.mapError(failure))
              return pendingSay(after, say(texts, lang, "cancelledRepeat", { rule }))
            }
            if (t.snoozed || v.ring?.again !== undefined || (v.owed !== undefined && !t.ringing) || v.withdraw !== undefined) {
              // The current occurrence (including an owed snooze or its unfinished withdrawal) comes before the series.
              const occurrence = v.owed ?? v.ring ?? v.withdraw!
              const next = momentOf(v.next.date, v.next.time, now, z, lang)
              const moment = momentOf(occurrence.date, occurrence.time, now, z, lang)
              const cleanup = v.withdraw !== undefined && v.owed === undefined && v.ring?.again === undefined
              const snoozed = t.snoozed || v.ring?.again !== undefined || v.owed?.snoozed === true
              const after = yield* Effect.flatMap(letGo(row.id, v, now), (value) => change(row, value)).pipe(Effect.mapError(failure))
              return say(texts, lang, ringLeft(after) ? (snoozed ? "cancelledAgainPendingNext" : "occurrencePendingNext") : cleanup ? "cleanupNext" : snoozed ? "cancelledAgainNext" : "occurrenceCancelledNext", { moment, next })
            }
            const moment = momentOf(v.next.date, v.next.time, now, z, lang)
            const following = nextOf(v, v.next.at)
            const { next: _n, ...rest } = v
            yield* change(row, following !== undefined ? { ...rest, next: following } : rest).pipe(Effect.mapError(failure))
            return following === undefined
              ? say(texts, lang, "skippedLast", { moment })
              : say(texts, lang, "skipped", { moment, next: momentOf(following.date, following.time, now, z, lang) })
          }))
      }

      // -- jobs ------------------------------------------------------------------------------------------------------------

      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: StoredText(64) }),
        idempotent: true,
        retries: 5,
        timeoutMs: 15_000,
        run: ({ id }) => Effect.asVoid(locked(reconcile(id, undefined, false, true)))
      }).pipe(Effect.orDie)

      yield* ctx.scheduler.handle("sweep", {
        payload: Schema.Struct({}),
        idempotent: true,
        timeoutMs: 60_000,
        run: () =>
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            const pending = yield* readPending
            for (const row of pending.rows) {
              // A row whose job was lost (it failed for good, a plan was lost) gets it planned again; an overdue one has
              // its clean-up done now (a ring that is owed is left to its own job, which sends it on the row's device).
              const live = yield* ctx.scheduler.list({ key: `alarm:${row.id}` })
              if (live.length === 0) {
                yield* locked(Effect.gen(function*() {
                  const fresh = yield* store.get(row.id)
                  if (fresh !== undefined && fresh.value.pending) yield* commit(fresh, row.id, fresh.value)
                }))
              } else if (row.value.nextAt <= now) yield* locked(reconcile(row.id, undefined, true))
              yield* Effect.yieldNow
            }
            const job = yield* CurrentJob
            const cutoff = now - KEEP_ENDED_MS
            for (let batch = 0; batch < 100; batch++) {
              const rows = yield* store.list({ where: { phase: "ended" }, orderBy: { field: "endedAt", direction: "asc" }, limit: PAGE })
              const old = rows.filter((r) => r.value.endedAt < cutoff && !r.value.pending)
              if (old.length > 0) {
                yield* locked(ctx.store.transaction((tx) => {
                  for (const r of old) tx.collection(alarms).remove(r.id, { expectRev: r.rev, ...(job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {}) })
                }))
              }
              if (rows.length < PAGE || rows.some((r) => r.value.endedAt >= cutoff)) return
              yield* Effect.yieldNow
            }
          })
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "sweep", key: "sweep", cron: "23 * * * *" }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "sweep", key: "sweep-start", inMs: 0 }).pipe(Effect.orDie)

      yield* ctx.scheduler.handle("trouble", {
        payload: Schema.Struct({ message: StoredText(300) }),
        retries: 0,
        run: ({ message }) => Effect.fail(new Error(message))
      }).pipe(Effect.orDie)

      // Snooze and "Five more minutes" on the ringing card, beside the host's stop: they set the row's ring to ring again.
      // A press of any notification but the row's current ring is answered that the ring has ended and changes nothing.
      // Idempotent by notification id. When Stop is pressed for this ring at the same moment, the card follows whichever the
      // notification service recorded first, and the alarm may still ring again once; saying stop or cancel again ends it.
      yield* ctx.notify.handle("alarm", {
        run: (press) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const actor: Actor = { kind: "ui", deviceId: press.deviceId }
            const id = press.key?.match(/^alarm:(.+):\d+$/)?.[1]
            const row = id === undefined ? undefined : yield* store.get(id)
            if (row === undefined || row.value.ring?.notification !== press.notificationId) return { say: say(texts, lang, "ringEnded") }
            const snooze = press.actionId === "snooze"
            const ms = snooze ? snoozeMs() : MORE_MINUTES * 60_000
            const reply = () => (snooze ? say(texts, lang, "snoozed", { left: speakLeft(ms, lang) }) : say(texts, lang, "moreDone"))
            const now = yield* Clock.currentTimeMillis
            if (row.value.ring.pressed === press.notificationId) {
              const again = row.value.ring.again
              return { say: again !== undefined && again > now ? say(texts, lang, "snoozed", { left: speakLeft(again - now, lang) }) : say(texts, lang, "ringEnded") }
            }
            if (row.value.phase !== "set") {
              const active = yield* readSet
              if (active.cut || active.rows.length >= MAX_ALARMS) return { say: say(texts, lang, "full", { count: MAX_ALARMS }), keepOpen: true }
            }
            yield* change(row, { ...row.value, ring: { ...row.value.ring, again: now + ms, pressed: press.notificationId } }, actor)
            return { say: reply() }
          })).pipe(Effect.catch((e) => Effect.succeed({ say: say(texts, language(), isBusy(e) ? "busy" : "failed"), keepOpen: true })))
      }).pipe(Effect.orDie)

      return { value: ops }
    }),
  start: (ctx) =>
    Effect.succeed({
      instructions:
        "Alarms ring on the device they are set on. An alarm is not changed: to move one, cancel it and set it again. When cancelling a repeating alarm, pass scope only when the person said \"only the next\" or \"all\".",
      actions: [
        defineAction({
          id: "set",
          label: "Set an alarm",
          description:
            "Set an alarm on this device, once (\"seven\", \"tomorrow at 6:30\") or repeating (\"every weekday at 6:45\"). Pass when exactly as said. A time without morning or evening is between 05:00 and 16:59. To move an alarm, cancel it first and then set it again.",
          examples: ["wake me at seven", "set an alarm for every weekday at quarter to seven", "zet een wekker om half acht", "maak me elke werkdag om zeven uur wakker"],
          params: {
            when: Param.text({ label: "When", after: ["at", "for", "om", "op"], maxWords: 8 }),
            name: Param.text({ label: "Name", after: ["called", "named", "genaamd"], optional: true, maxWords: 3 })
          },
          risk: "change",
          run: ({ when, name }) => Effect.map(ctx.shared.set(when, name), (s) => ({ say: s }))
        }),
        defineAction({
          id: "list",
          label: "List the alarms",
          description: "Say which alarms are set, the next first, with a snooze still to ring. An alarm's name is said only on its own device.",
          examples: ["which alarms are set", "when is my alarm", "welke wekkers staan er"],
          params: {},
          speculative: true,
          run: () => Effect.map(ctx.shared.list, (s) => ({ say: s }))
        }),
        defineAction({
          id: "cancel",
          label: "Cancel an alarm",
          description:
            "Cancel an alarm (a snoozed or ringing one too), named or by its time. For a repeating alarm the scope must be what the person said: only the next one, or all of them; leave it out otherwise and the person is asked. To move an alarm: cancel it, then set it again at the new time.",
          examples: ["cancel the alarm", "cancel tomorrow's alarm only", "cancel the weekday alarm for good", "annuleer de wekker"],
          params: {
            which: Param.text({ label: "Which alarm", after: ["the", "de"], optional: true, maxWords: 4 }),
            scope: Param.choice({
              label: "Only the next or all",
              options: [{ value: "next", label: "only the next one", aliases: ["alleen de volgende"] }, { value: "all", label: "all of them", aliases: ["allemaal", "for good"] }],
              optional: true
            })
          },
          risk: "change",
          run: ({ which, scope }) => Effect.map(ctx.shared.cancel(which, scope), (s) => ({ say: s }))
        })
      ]
    })
})
