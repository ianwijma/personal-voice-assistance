import { type Actor, ActionError, CurrentJob, CurrentTurn, defineAction, defineCollection, defineModule, Devices, Param, type Row, Setting } from "@pva/core"
import { describeRRule, formatDtstart, nextOccurrence, occurrencesAfter, parseDateTime, parseDtstart, parseRecurrence, parseTimeOfDay, speakMoment, speakTime } from "@pva/language"
import { homeLanguage, type Language, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import {
  capitalise,
  type ClockTime,
  cleanName,
  cut,
  dateOf,
  dateText,
  homeZone,
  instantOf,
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
/** An occurrence whose ring is owed: which (`n`), the tries so far and when to try again. */
const Owed = Schema.Struct({ n: Count, date: DateText, time: TimeText, at: Instant, attempts: Count, retryAt: Instant })
/** The ring delivered last; `again` is the instant a snooze or "five more minutes" rings it again. */
const Ring = Schema.Struct({
  n: Count,
  notification: NOTE,
  at: Instant,
  until: Instant,
  again: Schema.optionalKey(Instant),
  pressed: Schema.optionalKey(NOTE)
})
const Withdraw = Schema.Struct({ notification: NOTE, until: Instant, retryAt: Instant })

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
  withdraw: Schema.Array(Withdraw).check(Schema.isMaxLength(3)),
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
const YEAR_MS = 366 * 24 * 3_600_000
/** The most past occurrences one late ring looks through to find the latest (an outage of years is not expected). */
const CATCH_UP = 1_000
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
  const later = occurrencesAfter(specOf(value), from.at, CATCH_UP)?.instants.filter((i) => i <= now) ?? []
  return later.length === 0 ? from : occurrenceAt(value, later.at(-1)!)
}

// ---------------------------------------------------------------------------------------------------------------------
// The row's plan

/** The next moment anything happens for the row, or `undefined`. */
export const nextAtOf = (v: Alarm): number | undefined => {
  const at: Array<number> = []
  if (v.next !== undefined) at.push(v.next.at)
  if (v.owed !== undefined) at.push(v.owed.retryAt)
  if (v.ring !== undefined) at.push(v.ring.again ?? v.ring.until)
  for (const w of v.withdraw) at.push(Math.min(w.retryAt, w.until))
  return at.length === 0 ? undefined : Math.max(0, Math.min(...at))
}

const withPhase = (v: Alarm, now: number): Alarm => {
  const set = v.next !== undefined || v.owed !== undefined || v.ring?.again !== undefined
  if (set) return v.phase === "set" ? v : { ...v, phase: "set", endedAt: 0 }
  return v.phase === "ended" ? v : { ...v, phase: "ended", endedAt: now }
}

const withdrawing = (v: Alarm, ring: { readonly notification: string; readonly until: number }, now: number): Alarm => ({
  ...v,
  withdraw: [...v.withdraw.filter((w) => w.notification !== ring.notification), { notification: ring.notification, until: ring.until, retryAt: now }].slice(-3)
})

const withoutRing = (v: Alarm, now: number): Alarm => {
  if (v.ring === undefined) return v
  const { ring, ...rest } = v
  return withdrawing(rest, ring, now)
}

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
    const l = localOf(again, out.timeZone)
    out = { ...out, ring, n: out.n + 1, owed: { n: out.n + 1, date: dateText(l.date), time: timeText(l.time), at: again, attempts: 0, retryAt: now } }
  }
  if (out.ring !== undefined && out.ring.again === undefined && out.ring.until <= now) {
    const { ring: _r, ...rest } = out
    out = rest
  }
  if (out.withdraw.some((w) => w.until <= now)) out = { ...out, withdraw: out.withdraw.filter((w) => w.until > now) }
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
  readonly change: (which: string | undefined, to: string, scope: Scope) => Effect.Effect<string, ActionError>
}

type Target = { readonly kind: "one"; readonly row: Row<Alarm> } | { readonly kind: "answer"; readonly say: string }

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
      const commit = (row: Row<Alarm> | undefined, id: string, value: Alarm, actor?: Actor) =>
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
            return out
          })
          if (job === undefined && row?.value.pending === true) yield* Effect.ignore(ctx.scheduler.cancel({ key: `alarm:${id}` }))
          return written
        })

      // -- reconcile -------------------------------------------------------------------------------------------------------

      /** Send the owed ring, or, when its time has passed by more than the late rule, the silent card saying it was missed. */
      const deliver = (id: string, v: Alarm, now: number): Effect.Effect<Alarm> =>
        Effect.gen(function*() {
          const owed = v.owed!
          const lang = language()
          const { owed: _o, ...rest } = v
          if (now - owed.at > DELIVER_WITHIN_MS) {
            // Missed (the server was down, or the notification service refused it all that time): worded from today.
            const missed = yield* Effect.result(ctx.notify.send({
              title: say(texts, lang, "missedTitle"),
              text: say(texts, lang, "missedText", { time: momentOf(owed.date, owed.time, now, v.timeZone, lang) }),
              key: `alarm-missed:${id}:${owed.n}`,
              target: "origin"
            }))
            if (missed._tag === "Failure") {
              yield* Effect.ignore(ctx.scheduler.schedule({
                handler: "trouble",
                key: `trouble:${id}:${owed.n}`,
                inMs: 0,
                payload: { message: `An alarm could not ring, and the card saying so could not be sent either (${owed.date} ${owed.time}).` }
              }))
            }
            return rest
          }
          // A newer occurrence first withdraws the older ring of the same alarm.
          const base = v.ring !== undefined && v.ring.n < owed.n ? withoutRing(rest, now) : rest
          const time = timeWords(timeOf(owed.time), lang)
          const late = now - owed.at
          const sent = yield* Effect.result(ctx.notify.send({
            title: v.name !== undefined ? say(texts, lang, "title", { Name: cut(capitalise(v.name), 40) }) : say(texts, lang, "titlePlain"),
            text: late >= 60_000 ? say(texts, lang, "ringTextLate", { time, late: speakLeft(late, lang) }) : say(texts, lang, "ringText", { time }),
            priority: "ring",
            key: `alarm:${id}:${owed.n}`,
            expiresInMs: ringMs(),
            actions: [{ id: "snooze", label: say(texts, lang, "snooze") }, { id: "more", label: say(texts, lang, "more") }],
            handler: "alarm",
            target: "origin"
          }))
          if (sent._tag === "Failure") return { ...v, owed: { ...owed, attempts: owed.attempts + 1, retryAt: now + RETRY_RING_MS } }
          return { ...base, ring: { n: owed.n, notification: sent.success.notification.id, at: now, until: sent.success.notification.expiresAt } }
        })

      const withdrawRings = (v: Alarm, now: number): Effect.Effect<Alarm> =>
        Effect.gen(function*() {
          if (v.withdraw.length === 0) return v
          const kept: Array<typeof Withdraw.Type> = []
          for (const w of v.withdraw) {
            if (w.retryAt > now) {
              kept.push(w)
              continue
            }
            const done = yield* Effect.result(ctx.notify.resolve(w.notification))
            if (done._tag === "Failure") kept.push({ ...w, retryAt: now + RETRY_CLEANUP_MS })
          }
          return { ...v, withdraw: kept }
        })

      /**
       * Do what is owed for one alarm at this moment, and plan what comes next. Inside the lock. What is due without an
       * outside call (an occurrence or a snooze becomes an owed ring; the series moves on) is written first, so the owed
       * ring is recorded before it is sent; then it is sent, old rings are withdrawn, and the outcome is written with the
       * next plan. Fails only when the store does.
       */
      const reconcile = (id: string, actor?: Actor) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          let row = yield* store.get(id)
          if (row === undefined) return undefined
          const first = advance(row.value, now)
          if (first !== row.value) row = yield* commit(row, id, first, actor)
          let v = row.value
          if (v.owed !== undefined && v.owed.retryAt <= now) v = yield* deliver(id, v, now)
          v = yield* withdrawRings(v, now)
          if (v !== row.value || nextAtOf(v) !== (row.value.pending ? row.value.nextAt : undefined)) row = yield* commit(row, id, v, actor)
          return row
        })

      const change = (row: Row<Alarm>, value: Alarm, actor?: Actor) => Effect.andThen(commit(row, row.id, value, actor), () => reconcile(row.id, actor))

      // -- reading ---------------------------------------------------------------------------------------------------------

      const readSet = scan<Alarm>((q) => store.list({ where: { phase: "set" }, orderBy: { field: "createdAt", direction: "asc" }, ...q }), PAGE, SCAN_SET)
      const readPending = scan<Alarm>((q) => store.list({ where: { pending: true }, orderBy: { field: "nextAt", direction: "asc" }, ...q }), PAGE, SCAN_PENDING)

      /** What a person can still act on: alarms set (with their snoozes), and ended ones whose ring is open now. */
      const readLive = Effect.gen(function*() {
        const set = yield* readSet
        const open = new Set((yield* ctx.notify.list()).map((n) => n.id))
        const pending = yield* readPending
        const ringing = pending.rows.filter((r) => r.value.phase === "ended" && r.value.ring !== undefined && open.has(r.value.ring.notification))
        const all = [...set.rows, ...ringing]
        const upcoming = (r: Row<Alarm>) => Math.min(r.value.next?.at ?? Infinity, r.value.ring?.again ?? Infinity, r.value.owed?.at ?? Infinity)
        return { rows: all.sort((a, b) => upcoming(a) - upcoming(b)), open, cut: set.cut || pending.cut }
      })

      const callDevice = Effect.map(CurrentTurn, (turn) => turn?.deviceId)
      const deviceName = (id: string, lang: Language): string => ctx.host.service(Devices)?.get(id)?.name ?? say(texts, lang, "anotherDevice")

      /**
       * One alarm in words, for the device `here`: its name only when it rings on `here`; elsewhere its time and device.
       * A snooze still to ring and a ring sounding now are said too.
       */
      const itemOf = (row: Row<Alarm>, here: string | undefined, open: ReadonlySet<string>, now: number, lang: Language): string => {
        const v = row.value
        const z = v.timeZone
        const mine = v.deviceId === here
        const device = deviceName(v.deviceId, lang)
        const rule = ruleWords(v, lang)
        let what: string
        if (v.next !== undefined) {
          const moment = momentOf(v.next.date, v.next.time, now, z, lang)
          const repeat = isRepeating(v)
          what = !mine
            ? say(texts, lang, repeat ? "itemElsewhereRepeat" : "itemElsewhere", { moment, rule, device })
            : v.name !== undefined
            ? say(texts, lang, repeat ? "itemNamedRepeat" : "itemNamed", { name: v.name, moment, rule })
            : say(texts, lang, repeat ? "itemRepeat" : "item", { moment, rule })
        } else {
          what = !mine ? say(texts, lang, "alarmOn", { device }) : v.name ?? say(texts, lang, "alarmWord")
        }
        if (v.ring?.again !== undefined) return say(texts, lang, "itemAgain", { what, moment: instantWords(v.ring.again, now, z, lang) })
        if (v.ring !== undefined && open.has(v.ring.notification)) return say(texts, lang, "itemRinging", { what })
        return what
      }

      const one = (row: Row<Alarm>): Target => ({ kind: "one", row })
      const answer = (text: string): Target => ({ kind: "answer", say: text })

      /** The local clock times an alarm rings at next: its next occurrence, its snooze, its owed ring. */
      const timesOf = (v: Alarm): Array<ClockTime> => [
        ...(v.next !== undefined ? [timeOf(v.next.time)] : []),
        ...(v.ring?.again !== undefined ? [localOf(v.ring.again, v.timeZone).time] : []),
        ...(v.owed !== undefined ? [timeOf(v.owed.time)] : [])
      ]

      /**
       * Which alarm `which` means: a name of an alarm of this device (names are not matched on other devices: they are not
       * told there), or a time ("6:45") of any alarm; with nothing said, the only one there is; otherwise a question.
       */
      const resolve = (which: string | undefined, here: string | undefined, now: number): Effect.Effect<Target, ActionError> =>
        Effect.gen(function*() {
          const lang = language()
          const read = yield* readLive.pipe(Effect.mapError(unreadable))
          const ask = (rows: ReadonlyArray<Row<Alarm>>, cutShort: boolean): Target =>
            answer(say(texts, lang, cutShort ? "whichCut" : "which", { count: rows.length, list: listOf(rows.map((r) => itemOf(r, here, read.open, now, lang)), lang) }))
          const key = which === undefined ? "" : nameKey(which)
          if (key === "") {
            if (read.rows.length === 1 && !read.cut) return one(read.rows[0]!)
            if (read.rows.length === 0) return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "none"))
            return ask(read.rows, read.cut)
          }
          const byName = read.rows.filter((r) => r.value.deviceId === here && r.value.name !== undefined && nameKey(r.value.name) === key)
          if (byName.length === 1) return one(byName[0]!)
          if (byName.length > 1) return ask(byName, false)
          const time = parseTimeOfDay(which!, lang, { band: ALARM_BAND })
          if (time.kind === "ok") {
            const at = read.rows.filter((r) => timesOf(r.value).some((t) => t.hour === time.value.hour && t.minute === time.value.minute))
            if (at.length === 1) return one(at[0]!)
            if (at.length > 1) return ask(at, false)
            const words = timeWords({ hour: time.value.hour, minute: time.value.minute }, lang)
            return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "noTimeMatch", { time: words }))
          }
          return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "unknown", { name: cut(which!, NAME_CHARS) }))
        })

      /** Whether a ring of the row is still to be withdrawn. */
      const ringLeft = (row: Row<Alarm> | undefined) => row !== undefined && row.value.withdraw.length > 0

      /**
       * The alarm with nothing more to ring: no next occurrence, no owed ring, no snooze; its ring withdrawn. A ring sent but
       * not recorded (the write after the send failed) is found by its occurrence's key among the open notifications.
       */
      const ended = (row: Row<Alarm>, now: number) =>
        Effect.gen(function*() {
          const { next: _n, owed, ...rest } = row.value
          let out = withoutRing(rest, now)
          if (owed !== undefined) {
            const sent = (yield* ctx.notify.list()).find((n) => n.key === `alarm:${row.id}:${owed.n}`)
            if (sent !== undefined) out = withdrawing(out, { notification: sent.id, until: sent.expiresAt }, now)
          }
          return out
        })

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
            const base = { ...(clean !== undefined ? { name: clean } : {}), deviceId, timeZone: z, n: 0, withdraw: [], phase: "set" as const, pending: true, nextAt: 0, endedAt: 0 }
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
              if (at.value.instant > now + YEAR_MS) return say(texts, lang, "tooFar")
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
          const read = yield* readLive.pipe(Effect.mapError(unreadable))
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
            const t = yield* resolve(which, here, now)
            if (t.kind !== "one") {
              // Nothing is set: an alarm whose ring is still being withdrawn is finished now.
              const leftover = (yield* readPending.pipe(Effect.mapError(unreadable))).rows.filter((r) => r.value.phase === "ended" && ringLeft(r))
              if (which === undefined && leftover.length > 0) {
                let still = false
                for (const row of leftover) still ||= ringLeft(yield* reconcile(row.id).pipe(Effect.mapError(failure)))
                return say(texts, lang, still ? "ringPending" : "finished")
              }
              return t.say
            }
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
            if (v.ring?.again !== undefined) {
              // "Only the next": the next ring is the snooze still to come; the series stays as it is.
              const after = yield* change(row, withoutRing(v, now)).pipe(Effect.mapError(failure))
              return pendingSay(after, say(texts, lang, "cancelledAgainNext", { next: momentOf(v.next.date, v.next.time, now, z, lang) }))
            }
            const moment = momentOf(v.next.date, v.next.time, now, z, lang)
            const following = nextOf(v, v.next.at)
            const { next: _n, ...rest } = v
            yield* change(row, following !== undefined ? { ...rest, next: following } : rest).pipe(Effect.mapError(failure))
            return following === undefined
              ? say(texts, lang, "skippedLast", { moment })
              : say(texts, lang, "skipped", { moment, next: momentOf(following.date, following.time, now, z, lang) })
          })),

        change: (which, to, scope) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const here = yield* callDevice
            const t = yield* resolve(which, here, now)
            if (t.kind !== "one") return t.say
            const row = t.row
            const v = row.value
            const z = v.timeZone
            if (!isRepeating(v) || v.next === undefined) {
              const at = parseDateTime(to, lang, { now, timeZone: z, band: ALARM_BAND })
              if (at.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
              if (at.kind !== "ok" || at.value.instant === undefined || at.value.time === undefined) return say(texts, lang, "badTime")
              if (at.value.inPast || at.value.instant <= now) return say(texts, lang, "passed")
              if (at.value.instant > now + YEAR_MS) return say(texts, lang, "tooFar")
              const next = { date: dateText(at.value.date), time: timeText(at.value.time), at: at.value.instant }
              // A snooze still to come is replaced by the new time.
              yield* change(row, { ...withoutRing(v, now), next }).pipe(Effect.mapError(failure))
              return say(texts, lang, "changed", { moment: momentOf(next.date, next.time, now, z, lang) })
            }
            const rule = ruleWords(v, lang)
            if (scope === undefined) return say(texts, lang, "scope", { rule })
            const time = parseTimeOfDay(to, lang, { band: ALARM_BAND })
            if (time.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
            if (time.kind !== "ok") return say(texts, lang, "badTime")
            const newTime = { hour: time.value.hour, minute: time.value.minute }
            // The next occurrence's nominal date (finding 8): the day it stands for, also when its instant was moved by a gap.
            const day = dateOf(v.next.date)
            if (scope === "all") {
              // The same days at the new time: DTSTART moves to the next occurrence's day at that time; the next ring is the
              // first occurrence of the changed series after now.
              const dtstart = formatDtstart({ ...day, hour: newTime.hour, minute: newTime.minute }, z)
              if (dtstart === undefined) return say(texts, lang, "badTime")
              const changed: Alarm = { ...v, dtstart }
              const next = nextOf(changed, now)
              if (next === undefined) return say(texts, lang, "badTime")
              yield* change(row, { ...changed, next }).pipe(Effect.mapError(failure))
              return say(texts, lang, "changedRepeat", { rule, moment: momentOf(next.date, next.time, now, z, lang) })
            }
            // Only the next: that occurrence is skipped, and a one-off alarm of the same name rings on its day at the new
            // time instead.
            const instant = instantOf(day, newTime, z)
            if (instant === undefined) return say(texts, lang, "badTime")
            if (instant <= now) return say(texts, lang, "passed")
            const read = yield* readSet.pipe(Effect.mapError(failure))
            if (read.cut || read.rows.length >= MAX_ALARMS) return yield* Effect.fail(fail(say(texts, lang, "full", { count: MAX_ALARMS })))
            const once: Alarm = {
              ...(v.name !== undefined ? { name: v.name } : {}),
              deviceId: v.deviceId,
              timeZone: z,
              next: { date: v.next.date, time: timeText(newTime), at: instant },
              n: 0,
              withdraw: [],
              phase: "set",
              pending: true,
              nextAt: 0,
              endedAt: 0
            }
            yield* commit(undefined, randomUUID(), once).pipe(Effect.mapError(failure))
            const following = nextOf(v, v.next.at)
            const { next: _n, ...rest } = v
            yield* change(row, following !== undefined ? { ...rest, next: following } : rest).pipe(Effect.mapError(failure))
            return say(texts, lang, "changedNext", { moment: momentOf(once.next!.date, once.next!.time, now, z, lang), rule })
          }))
      }

      // -- jobs ------------------------------------------------------------------------------------------------------------

      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: StoredText(64) }),
        idempotent: true,
        retries: 5,
        timeoutMs: 15_000,
        run: ({ id }) => Effect.asVoid(locked(reconcile(id)))
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
              if (row.value.nextAt <= now) yield* locked(reconcile(row.id))
              else {
                const live = yield* ctx.scheduler.list({ key: `alarm:${row.id}` })
                if (live.length === 0) {
                  yield* locked(Effect.gen(function*() {
                    const fresh = yield* store.get(row.id)
                    if (fresh !== undefined) yield* commit(fresh, row.id, fresh.value)
                  }))
                }
              }
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
      // Idempotent by notification id; after its write it looks at its notification once more and takes the snooze back
      // when something else (the host's Stop) ended it meanwhile.
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
            if (row.value.ring.pressed === press.notificationId) return { say: row.value.ring.again !== undefined ? reply() : say(texts, lang, "ringEnded") }
            const now = yield* Clock.currentTimeMillis
            const after = yield* change(row, { ...row.value, ring: { ...row.value.ring, again: now + ms, pressed: press.notificationId } }, actor)
            const open = yield* Effect.result(ctx.notify.list())
            if (open._tag === "Success" && !open.success.some((n) => n.id === press.notificationId) && after?.value.ring !== undefined) {
              const { again: _a, ...ring } = after.value.ring
              yield* change(after, { ...after.value, ring }, actor)
              return { say: say(texts, lang, "stoppedMeanwhile") }
            }
            return { say: reply() }
          })).pipe(Effect.catch((e) => Effect.succeed({ say: say(texts, language(), isBusy(e) ? "busy" : "failed"), keepOpen: true })))
      }).pipe(Effect.orDie)

      return { value: ops }
    }),
  start: (ctx) =>
    Effect.succeed({
      instructions: "Alarms ring on the device they are set on. When cancelling or changing a repeating alarm, pass scope only when the person said \"only the next\" or \"all\".",
      actions: [
        defineAction({
          id: "set",
          label: "Set an alarm",
          description:
            "Set an alarm on this device, once (\"seven\", \"tomorrow at 6:30\") or repeating (\"every weekday at 6:45\"). Pass when exactly as said. A time without morning or evening is between 05:00 and 16:59.",
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
            "Cancel an alarm (a snoozed one too), named or by its time. For a repeating alarm the scope must be what the person said: only the next one, or all of them; leave it out otherwise and the person is asked.",
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
        }),
        defineAction({
          id: "change",
          label: "Change an alarm's time",
          description: "Move an alarm to another time. For a repeating alarm the scope must be what the person said: only the next one, or all of them; leave it out otherwise and the person is asked.",
          examples: ["move my alarm to seven fifteen", "change the weekday alarm to 7:00 for all of them", "zet de wekker op kwart over zeven"],
          params: {
            to: Param.text({ label: "New time", after: ["to", "naar", "op"], maxWords: 8 }),
            which: Param.text({ label: "Which alarm", after: ["the", "de"], optional: true, maxWords: 4 }),
            scope: Param.choice({
              label: "Only the next or all",
              options: [{ value: "next", label: "only the next one", aliases: ["alleen de volgende"] }, { value: "all", label: "all of them", aliases: ["allemaal", "for good"] }],
              optional: true
            })
          },
          risk: "change",
          run: ({ to, which, scope }) => Effect.map(ctx.shared.change(which, to, scope), (s) => ({ say: s }))
        })
      ]
    })
})
