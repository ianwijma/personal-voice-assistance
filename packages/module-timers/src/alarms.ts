import { ActionError, CurrentJob, CurrentTurn, defineAction, defineCollection, defineModule, Devices, Param, type Row, Setting } from "@pva/core"
import {
  describeRRule,
  formatDtstart,
  type LocalDate,
  nextOccurrence,
  parseDateTime,
  parseDtstart,
  parseRecurrence,
  parseTimeOfDay,
  speakMoment,
  speakTime
} from "@pva/language"
import { homeLanguage, type Language, say, StoredText } from "@pva/module-contracts"
import { Clock, Effect, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { capitalise, cleanName, cut, homeZone, isBusy, listOf, localOf, MAX_INSTANT, NAME_CHARS, nameKey, scan, speakLeft } from "./common.ts"
import { alarmTexts as texts } from "./texts.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Data

const ID = StoredText(64)
const Instant = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_INSTANT }))

/**
 * One alarm: household data that rings on one device (`deviceId`, the device it was set on). Its name is shown and
 * spoken only on that device: on every other device an alarm is its time and its device. A repeating alarm keeps its
 * recurrence (`rrule`, `dtstart`, `timeZone`: `@pva/language`'s) and has one job, for its next occurrence; the ring
 * plans the one after. Nothing about a person is stored.
 */
export const Alarm = Schema.Struct({
  name: Schema.optionalKey(StoredText(NAME_CHARS)),
  deviceId: ID,
  phase: Schema.Literals(["set", "ended"]),
  /** The next time it rings (set), epoch ms; indexed with `phase`, so alarms are listed in the order they ring. */
  next: Instant,
  rrule: Schema.optionalKey(StoredText(200)),
  dtstart: Schema.optionalKey(StoredText(80)),
  timeZone: Schema.optionalKey(StoredText(64)),
  /** The job for `next`. */
  job: Schema.optionalKey(ID),
  /** The job of a snooze or "five more minutes" that will ring it again. */
  again: Schema.optionalKey(ID),
  /** Its ringing notification, while or after it rang. */
  notification: Schema.optionalKey(ID),
  /** The notification whose snooze this row has carried out already (idempotent by notification id). */
  press: Schema.optionalKey(ID),
  /** When it ended; 0 while set. */
  endedAt: Instant
})
export type Alarm = typeof Alarm.Type

export const alarms = defineCollection({
  name: "alarms",
  scope: "household",
  schema: Alarm,
  // The worst legal alarm is about 1,750 characters of JSON: one list reads 13 rows.
  maxChars: 1_900,
  indexes: [["phase", "next"], ["phase", "endedAt"]]
})

const PAGE = 12
/** The most alarms that may be set at once. */
export const MAX_ALARMS = 50
/** The most set alarms one answer reads (more than may be set: a read that finds more says it was cut). */
const SCAN_SET = 60
/** An occurrence found later than this (the server was down) is not rung; the person is told it was missed. */
export const DELIVER_WITHIN_MS = 15 * 60_000
const KEEP_ENDED_MS = 24 * 3_600_000
const YEAR_MS = 366 * 24 * 3_600_000
/**
 * The hours a time said without "morning" or "evening" falls in: an alarm "at seven" is 07:00 and "at two" 14:00, never
 * 19:00 or 02:00 (the parser's default band, 07:00–21:00, would read "6:45" as 18:45).
 */
export const ALARM_BAND = { from: "05:00", to: "16:59" } as const
const MORE_MINUTES = 5

// ---------------------------------------------------------------------------------------------------------------------
// Words

const timeWords = (instant: number, zone: string, language: Language): string =>
  speakTime(localOf(instant, zone).time, language, { style: "12h", period: true }) ?? ""

/** "tomorrow at quarter to seven in the morning" (today taken in the household's zone). */
const momentWords = (instant: number, now: number, zone: string, language: Language): string => {
  const at = localOf(instant, zone)
  return speakMoment(at, language, localOf(now, zone).date, { style: "12h", period: true }) ?? timeWords(instant, zone, language)
}

/** "every weekday": the rule without its time (the moment says the time). */
const ruleWords = (value: Alarm, language: Language): string => {
  if (value.rrule === undefined || value.dtstart === undefined) return ""
  const start = parseDtstart(value.dtstart)
  const words = describeRRule(value.rrule, language, { ...(start !== undefined ? { start: start.start as LocalDate } : {}), ...(value.timeZone !== undefined ? { timeZone: value.timeZone } : {}) })
  return words ?? say(texts, language, "ruleUnknown")
}

const isRepeating = (value: Alarm): boolean => value.rrule !== undefined && value.dtstart !== undefined && value.timeZone !== undefined

const specOf = (value: Alarm) => ({ rrule: value.rrule!, dtstart: value.dtstart!, timeZone: value.timeZone! })

/** An instant of a local date and time in a zone, through the recurrence helper (a one-instance series). */
const instantOf = (date: LocalDate, time: { readonly hour: number; readonly minute: number }, zone: string): number | undefined => {
  const dtstart = formatDtstart({ ...date, hour: time.hour, minute: time.minute }, zone)
  return dtstart === undefined ? undefined : nextOccurrence({ rrule: "FREQ=DAILY;COUNT=1", dtstart, timeZone: zone }, 0)
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

type Target =
  | { readonly kind: "one"; readonly row: Row<Alarm> }
  | { readonly kind: "answer"; readonly say: string }

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

      const readSet = scan<Alarm>((q) => store.list({ where: { phase: "set" }, orderBy: { field: "next", direction: "asc" }, ...q }), PAGE, SCAN_SET)

      const ringJob = (id: string, at: number, deviceId: string) => ctx.scheduler.prepare({ handler: "ring", key: `alarm:${id}`, payload: { id }, at, origin: { deviceId } })

      /** The device a call runs for. */
      const callDevice = Effect.gen(function*() {
        const turn = yield* CurrentTurn
        return turn?.deviceId
      })

      const deviceName = (id: string, lang: Language): string => ctx.host.service(Devices)?.get(id)?.name ?? say(texts, lang, "anotherDevice")

      /**
       * One alarm in words, for the device `here`: its name only when it rings on `here` (an alarm's name is shown and
       * spoken only on its own device); elsewhere its time and its device.
       */
      const itemOf = (row: Row<Alarm>, here: string | undefined, now: number, lang: Language): string => {
        const moment = momentWords(row.value.next, now, zone(), lang)
        const rule = ruleWords(row.value, lang)
        const repeat = isRepeating(row.value)
        if (row.value.deviceId !== here) {
          return say(texts, lang, repeat ? "itemElsewhereRepeat" : "itemElsewhere", { moment, rule, device: deviceName(row.value.deviceId, lang) })
        }
        if (row.value.name !== undefined) return say(texts, lang, repeat ? "itemNamedRepeat" : "itemNamed", { name: row.value.name, moment, rule })
        return say(texts, lang, repeat ? "itemRepeat" : "item", { moment, rule })
      }

      /**
       * Which alarm `which` means: a name of an alarm of this device (names are not matched on other devices: they are
       * not told there), or a time ("6:45") of any alarm; with nothing said, the only alarm there is; otherwise a question.
       */
      const one = (row: Row<Alarm>): Target => ({ kind: "one", row })
      const answer = (text: string): Target => ({ kind: "answer", say: text })
      const resolve = (which: string | undefined, here: string | undefined, now: number): Effect.Effect<Target, ActionError> =>
        Effect.gen(function*() {
          const lang = language()
          const read = yield* readSet.pipe(Effect.mapError(unreadable))
          const ask = (rows: ReadonlyArray<Row<Alarm>>, cutShort: boolean): Target =>
            answer(say(texts, lang, cutShort ? "whichCut" : "which", { count: rows.length, list: listOf(rows.map((r) => itemOf(r, here, now, lang)), lang) }))
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
            const z = zone()
            const at = read.rows.filter((r) => {
              const t = localOf(r.value.next, z).time
              return t.hour === time.value.hour && t.minute === time.value.minute
            })
            if (at.length === 1) return one(at[0]!)
            if (at.length > 1) return ask(at, false)
            const words = speakTime({ hour: time.value.hour, minute: time.value.minute }, lang, { style: "12h", period: true }) ?? which!
            return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "noTimeMatch", { time: words }))
          }
          return read.cut ? yield* Effect.fail(unreadable()) : answer(say(texts, lang, "unknown", { name: cut(which!, NAME_CHARS) }))
        })

      /** End an alarm: the row first (a job that still runs finds it ended), then its jobs and its ring. Inside the lock. */
      const endAlarm = (row: Row<Alarm>, now: number) =>
        Effect.gen(function*() {
          const { job: _j, again: _a, ...rest } = row.value
          yield* store.update(row.id, () => ({ ...rest, phase: "ended" as const, endedAt: now }), { expectRev: row.rev })
          if (row.value.job !== undefined) yield* Effect.ignore(ctx.scheduler.cancel(row.value.job))
          if (row.value.again !== undefined) yield* Effect.ignore(ctx.scheduler.cancel(row.value.again))
          if (row.value.notification !== undefined) yield* Effect.ignore(ctx.notify.resolve(row.value.notification))
        })

      /** Move a repeating alarm on to the occurrence after `after` (or end it, when the series has none). Inside the lock. */
      const skipTo = (row: Row<Alarm>, after: number, now: number) =>
        Effect.gen(function*() {
          const next = nextOccurrence(specOf(row.value), after)
          if (next === undefined) {
            yield* endAlarm(row, now)
            return undefined
          }
          const job = yield* ringJob(row.id, next, row.value.deviceId)
          yield* ctx.store.transaction((tx) => {
            tx.collection(alarms).update(row.id, (v) => ({ ...v, next, job: job.id }), { expectRev: row.rev })
            job.writeIn(tx)
          })
          return next
        })

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
            let value: Omit<Alarm, "job"> | undefined
            if (rec.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
            if (rec.kind === "ok") {
              if (rec.value.timeDefaulted) return say(texts, lang, "noTime")
              value = { ...(clean !== undefined ? { name: clean } : {}), deviceId, phase: "set", next: rec.value.startInstant, rrule: rec.value.rrule, dtstart: rec.value.dtstart, timeZone: rec.value.timeZone, endedAt: 0 }
            } else {
              const at = parseDateTime(when, lang, options)
              if (at.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
              if (at.kind !== "ok") return say(texts, lang, "when")
              if (at.value.instant === undefined || at.value.time === undefined) return say(texts, lang, "noTime")
              if (at.value.inPast || at.value.instant <= now) return say(texts, lang, "passed")
              if (at.value.instant > now + YEAR_MS) return say(texts, lang, "tooFar")
              value = { ...(clean !== undefined ? { name: clean } : {}), deviceId, phase: "set", next: at.value.instant, endedAt: 0 }
            }
            const read = yield* readSet.pipe(Effect.mapError(failure))
            if (read.cut || read.rows.length >= MAX_ALARMS) return yield* Effect.fail(fail(say(texts, lang, "full", { count: MAX_ALARMS })))
            const id = randomUUID()
            const job = yield* ringJob(id, value.next, deviceId).pipe(Effect.mapError(failure))
            const row: Alarm = { ...value, job: job.id }
            yield* ctx.store.transaction((tx) => {
              tx.collection(alarms).insert(row, { id })
              job.writeIn(tx)
            }).pipe(Effect.mapError(failure))
            const moment = momentWords(row.next, now, z, lang)
            // Said on the device it was set on, which is the device it rings on: its name may be echoed here.
            if (isRepeating(row)) {
              const rule = ruleWords(row, lang)
              return clean !== undefined ? say(texts, lang, "setRepeatNamed", { Name: capitalise(clean), rule, moment }) : say(texts, lang, "setRepeat", { rule, moment })
            }
            return clean !== undefined ? say(texts, lang, "setNamed", { Name: capitalise(clean), moment }) : say(texts, lang, "set", { moment })
          })),

        list: locked(Effect.gen(function*() {
          const lang = language()
          const now = yield* Clock.currentTimeMillis
          const here = yield* callDevice
          const read = yield* readSet.pipe(Effect.mapError(unreadable))
          if (read.rows.length === 0) return read.cut ? yield* Effect.fail(unreadable()) : say(texts, lang, "none")
          const items = read.rows.map((r) => itemOf(r, here, now, lang))
          if (items.length === 1 && !read.cut) return say(texts, lang, "one", { item: items[0]! })
          return say(texts, lang, read.cut ? "severalCut" : "several", { count: items.length, list: listOf(items, lang) })
        })),

        cancel: (which, scope) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const here = yield* callDevice
            const t = yield* resolve(which, here, now)
            if (t.kind !== "one") return t.say
            const row = t.row
            const moment = momentWords(row.value.next, now, zone(), lang)
            if (!isRepeating(row.value)) {
              yield* endAlarm(row, now).pipe(Effect.mapError(failure))
              return say(texts, lang, "cancelled", { moment })
            }
            const rule = ruleWords(row.value, lang)
            // A repeating alarm: only the next, or all of them. Never guessed (docs/MODULES-PLAN.md §2 row 6).
            if (scope === undefined) return say(texts, lang, "scope", { rule })
            if (scope === "all") {
              yield* endAlarm(row, now).pipe(Effect.mapError(failure))
              return say(texts, lang, "cancelledRepeat", { rule })
            }
            const next = yield* skipTo(row, row.value.next, now).pipe(Effect.mapError(failure))
            return next === undefined ? say(texts, lang, "skippedLast", { moment }) : say(texts, lang, "skipped", { moment, next: momentWords(next, now, zone(), lang) })
          })),

        change: (which, to, scope) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const here = yield* callDevice
            const z = zone()
            const t = yield* resolve(which, here, now)
            if (t.kind !== "one") return t.say
            const row = t.row
            if (!isRepeating(row.value)) {
              const at = parseDateTime(to, lang, { now, timeZone: z, band: ALARM_BAND })
              if (at.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
              if (at.kind !== "ok" || at.value.instant === undefined || at.value.time === undefined) return say(texts, lang, "badTime")
              if (at.value.inPast || at.value.instant <= now) return say(texts, lang, "passed")
              if (at.value.instant > now + YEAR_MS) return say(texts, lang, "tooFar")
              const job = yield* ringJob(row.id, at.value.instant, row.value.deviceId).pipe(Effect.mapError(failure))
              yield* ctx.store.transaction((tx) => {
                tx.collection(alarms).update(row.id, (v) => ({ ...v, next: job.dueAt, job: job.id }), { expectRev: row.rev })
                job.writeIn(tx)
              }).pipe(Effect.mapError(failure))
              return say(texts, lang, "changed", { moment: momentWords(job.dueAt, now, z, lang) })
            }
            const rule = ruleWords(row.value, lang)
            if (scope === undefined) return say(texts, lang, "scope", { rule })
            const time = parseTimeOfDay(to, lang, { band: ALARM_BAND })
            if (time.kind === "ambiguous") return say(texts, lang, "whenAmbiguous")
            if (time.kind !== "ok") return say(texts, lang, "badTime")
            const day = localOf(row.value.next, row.value.timeZone!).date
            if (scope === "all") {
              // The same days, at the new time: DTSTART moves to the next occurrence's day at that time, and the next
              // ring is the first instance of the changed series after now.
              const dtstart = formatDtstart({ ...day, hour: time.value.hour, minute: time.value.minute }, row.value.timeZone!)
              const spec = dtstart === undefined ? undefined : { ...specOf(row.value), dtstart }
              const next = spec === undefined ? undefined : nextOccurrence(spec, now)
              if (spec === undefined || next === undefined) return say(texts, lang, "badTime")
              const job = yield* ringJob(row.id, next, row.value.deviceId).pipe(Effect.mapError(failure))
              yield* ctx.store.transaction((tx) => {
                tx.collection(alarms).update(row.id, (v) => ({ ...v, dtstart: spec.dtstart, next, job: job.id }), { expectRev: row.rev })
                job.writeIn(tx)
              }).pipe(Effect.mapError(failure))
              return say(texts, lang, "changedRepeat", { rule, moment: momentWords(next, now, z, lang) })
            }
            // Only the next: that occurrence is skipped, and a one-off alarm of the same name rings on its day at the new
            // time instead. Both in one transaction.
            const instant = instantOf(day, time.value, row.value.timeZone!)
            if (instant === undefined) return say(texts, lang, "badTime")
            if (instant <= now) return say(texts, lang, "passed")
            const following = nextOccurrence(specOf(row.value), row.value.next)
            const read = yield* readSet.pipe(Effect.mapError(failure))
            if (read.cut || read.rows.length >= MAX_ALARMS) return yield* Effect.fail(fail(say(texts, lang, "full", { count: MAX_ALARMS })))
            const id = randomUUID()
            const once = yield* ringJob(id, instant, row.value.deviceId).pipe(Effect.mapError(failure))
            const seriesJob = following === undefined ? undefined : yield* ringJob(row.id, following, row.value.deviceId).pipe(Effect.mapError(failure))
            yield* ctx.store.transaction((tx) => {
              tx.collection(alarms).insert({ ...(row.value.name !== undefined ? { name: row.value.name } : {}), deviceId: row.value.deviceId, phase: "set", next: instant, job: once.id, endedAt: 0 }, { id })
              once.writeIn(tx)
              if (seriesJob !== undefined) {
                tx.collection(alarms).update(row.id, (v) => ({ ...v, next: seriesJob.dueAt, job: seriesJob.id }), { expectRev: row.rev })
                seriesJob.writeIn(tx)
              } else {
                const { job: _j, ...rest } = row.value
                tx.collection(alarms).update(row.id, () => ({ ...rest, phase: "ended" as const, endedAt: now }), { expectRev: row.rev })
              }
            }).pipe(Effect.mapError(failure))
            if (seriesJob === undefined && row.value.job !== undefined) yield* Effect.ignore(ctx.scheduler.cancel(row.value.job))
            return say(texts, lang, "changedNext", { moment: momentWords(instant, now, z, lang), rule })
          }))
      }

      // -- ringing ---------------------------------------------------------------------------------------------------------

      /** The ringing notification of an alarm (sent on the job's origin: the alarm's own device, the only one told its name). */
      const sendRing = (id: string, value: Alarm, dueAt: number, lateMs: number) => {
        const lang = language()
        const time = timeWords(dueAt, zone(), lang)
        return ctx.notify.send({
          title: value.name !== undefined ? say(texts, lang, "title", { Name: cut(capitalise(value.name), 40), name: cut(value.name, 40) }) : say(texts, lang, "titlePlain"),
          text: lateMs >= 60_000 ? say(texts, lang, "ringTextLate", { time, late: speakLeft(lateMs, lang) }) : say(texts, lang, "ringText", { time }),
          priority: "ring",
          key: `alarm:${id}`,
          expiresInMs: ringMs(),
          actions: [{ id: "snooze", label: say(texts, lang, "snooze") }, { id: "more", label: say(texts, lang, "more") }],
          handler: "alarm"
        })
      }

      // The ring of an occurrence. Always runs (`late: "run"`), so a repeating alarm is never lost to an outage: an
      // occurrence found more than 15 minutes late is not rung (a silent card says it was missed), and the next one is
      // planned after now, never in the past. Idempotent: a run again after a failure finds its ring open by key, and a
      // job that is not the row's any more does nothing.
      yield* ctx.scheduler.handle("ring", {
        payload: Schema.Struct({ id: ID }),
        idempotent: true,
        retries: 5,
        timeoutMs: 10_000,
        run: ({ id }, due) =>
          locked(Effect.gen(function*() {
            const row = yield* store.get(id)
            if (row === undefined || row.value.phase !== "set" || row.value.job !== due.jobId) return
            const job = yield* CurrentJob
            const actor = job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {}
            let notification: string | undefined
            if (due.lateMs <= DELIVER_WITHIN_MS) {
              notification = (yield* sendRing(id, row.value, due.dueAt, due.lateMs)).notification.id
            } else {
              const lang = language()
              yield* Effect.ignore(ctx.notify.send({
                title: say(texts, lang, "missedTitle"),
                text: say(texts, lang, "missedText", { time: momentWords(due.dueAt, due.dueAt, zone(), lang) }),
                key: `alarm-missed:${id}`
              }))
            }
            const now = yield* Clock.currentTimeMillis
            const withRing = (v: Alarm): Alarm => (notification !== undefined ? { ...v, notification } : v)
            const next = isRepeating(row.value) ? nextOccurrence(specOf(row.value), Math.max(now, due.dueAt)) : undefined
            if (next === undefined) {
              const { job: _j, ...rest } = row.value
              yield* store.update(id, () => withRing({ ...rest, phase: "ended", endedAt: now }), { expectRev: row.rev, ...actor })
              return
            }
            const nextJob = yield* ringJob(id, next, row.value.deviceId)
            yield* ctx.store.transaction((tx) => {
              tx.collection(alarms).update(id, (v) => withRing({ ...v, next, job: nextJob.id }), { expectRev: row.rev, ...actor })
              nextJob.writeIn(tx)
            })
          }))
      }).pipe(Effect.orDie)

      // A snooze or "five more minutes": the same alarm rings again, on the same device, without moving the series.
      yield* ctx.scheduler.handle("again", {
        payload: Schema.Struct({ id: ID }),
        idempotent: true,
        retries: 5,
        timeoutMs: 10_000,
        run: ({ id }, due) =>
          locked(Effect.gen(function*() {
            const row = yield* store.get(id)
            if (row === undefined || row.value.again !== due.jobId) return
            const job = yield* CurrentJob
            const sent = yield* sendRing(id, row.value, due.dueAt, due.lateMs)
            const { again: _a, ...rest } = row.value
            yield* store.update(id, () => ({ ...rest, notification: sent.notification.id }), { expectRev: row.rev, ...(job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {}) })
          }))
      }).pipe(Effect.orDie)

      yield* ctx.scheduler.handle("cleanup", {
        payload: Schema.Struct({}),
        idempotent: true,
        run: () =>
          Effect.gen(function*() {
            const job = yield* CurrentJob
            const cutoff = (yield* Clock.currentTimeMillis) - KEEP_ENDED_MS
            for (let batch = 0; batch < 100; batch++) {
              const rows = yield* store.list({ where: { phase: "ended" }, orderBy: { field: "endedAt", direction: "asc" }, limit: PAGE })
              // A row whose snooze is still to ring stays until it has rung.
              const old = rows.filter((r) => r.value.endedAt < cutoff && r.value.again === undefined)
              if (old.length > 0) {
                yield* ctx.store.transaction((tx) => {
                  for (const r of old) tx.collection(alarms).remove(r.id, { expectRev: r.rev, ...(job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {}) })
                })
              }
              if (rows.length < PAGE || old.length < rows.length) return
              yield* Effect.yieldNow
            }
          })
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "cleanup", key: "cleanup", cron: "23 4 * * *" }).pipe(Effect.orDie)

      // Snooze and "Five more minutes" on the ringing card, beside the host's stop. Idempotent by notification id.
      yield* ctx.notify.handle("alarm", {
        run: (press) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const id = press.key?.startsWith("alarm:") === true ? press.key.slice("alarm:".length) : undefined
            const row = id === undefined ? undefined : yield* store.get(id)
            if (row === undefined) return { say: say(texts, lang, "gone") }
            const snooze = press.actionId === "snooze"
            const ms = snooze ? snoozeMs() : MORE_MINUTES * 60_000
            const answer = () => (snooze ? say(texts, lang, "snoozed", { left: speakLeft(ms, lang) }) : say(texts, lang, "moreDone"))
            if (row.value.press === press.notificationId) return { say: answer() }
            if (row.value.notification !== press.notificationId) return { say: say(texts, lang, "gone") }
            const now = yield* Clock.currentTimeMillis
            const job = yield* ctx.scheduler.prepare({ handler: "again", key: `alarm-again:${row.id}`, payload: { id: row.id }, at: now + ms, origin: { deviceId: row.value.deviceId } })
            yield* ctx.store.transaction((tx) => {
              tx.collection(alarms).update(row.id, (v) => ({ ...v, again: job.id, press: press.notificationId }), { expectRev: row.rev })
              job.writeIn(tx)
            })
            return { say: answer() }
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
          description: "Say which alarms are set, the next first. An alarm's name is said only on its own device.",
          examples: ["which alarms are set", "when is my alarm", "welke wekkers staan er"],
          params: {},
          speculative: true,
          run: () => Effect.map(ctx.shared.list, (s) => ({ say: s }))
        }),
        defineAction({
          id: "cancel",
          label: "Cancel an alarm",
          description: "Cancel an alarm, named or by its time. For a repeating alarm the scope must be what the person said: only the next one, or all of them; leave it out otherwise and the person is asked.",
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
