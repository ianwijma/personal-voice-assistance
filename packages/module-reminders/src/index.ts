import {
  ActionError, type Actor, CurrentJob, CurrentTurn, defineAction, defineModule, makeTool, type ModuleDefinition, Param, type PresentHandle,
  type Presentation, Privacy, type Row, type ScheduleOrigin, Setting, StoreError, ToolError, type TurnContext
} from "@pva/core"
import {
  describeRRule, type Language, parseDateTime, parseDtstart, parseRecurrence, speakDuration, speakList, speakNumber, speakTime
} from "@pva/language"
import { BriefingSectionError, BriefingSections, homeLanguage, isLine, say } from "@pva/module-contracts"
import { Cause, Clock, Effect, Exit, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import {
  cut, endOfToday, holdsSecret, homeZone, isRepeat, Line, localOf, matching, momentText, nextOf, type Owed, PAGE, planOf, Reminder, reminders,
  SCAN_ROWS, scanRows, shortMoment, speaksAt, type Stop, STOP_NOTES, TEXT_CHARS, WHEN_CHARS, without
} from "./model.ts"
import { texts } from "./texts.ts"

export { holdsSecret, planOf, Reminder, reminders, SCAN_ROWS, texts }

const DAY = 86_400_000
/** A repeating reminder's occurrence (or snooze) found later than this is not delivered (the moment has passed); the series goes on. */
export const REPEAT_DELIVER_WITHIN_MS = 6 * 3_600_000
/** A reminder found more than this late says so. */
const LATE_NOTE_MS = 2 * 60_000
/** How far ahead a reminder may be set. */
const MAX_AHEAD_MS = 366 * DAY
const RING_EXPIRES_MS = 30 * 60_000
const NORMAL_EXPIRES_MS = DAY
const CARD_MS = 5 * 60_000
const LIST_MS = 2 * 60_000
/** A delivery is tried at most this often; the second try 30 s after the first, then twice as long each time. */
export const MAX_TRIES = 5
export const RETRY_MS = 30_000
/** Cleanup (a notification resolved, a card dismissed) is tried at most this often, 5 s after the first, doubling. */
export const MAX_STOP_TRIES = 5
export const STOP_RETRY_MS = 5_000
/** A delivered reminder nobody answered ends this long after its delivery. */
export const UNANSWERED_MS = 7 * DAY
/** The daily clean-up reads at most this many pages of open reminders (far above what the job limit lets exist). */
const TIDY_PAGES = 100

const settings = {
  snoozeMinutes: Setting.number({ label: "Snooze for", description: "Minutes a reminder is put off when someone says snooze.", default: 10, integer: true, min: 1, max: 240, unit: "minutes" }),
  priority: Setting.choice({
    label: "How a reminder arrives",
    description: "A reminder the person asked for at a moment rings on the device it was set on until it is answered; do not disturb keeps it silent. Or only a silent card.",
    default: "ring",
    options: [{ value: "ring", label: "Rings until answered" }, { value: "normal", label: "A silent card" }]
  }),
  keepDays: Setting.number({ label: "Keep finished reminders", description: "Days a finished or cancelled reminder is kept before it is removed.", default: 7, integer: true, min: 1, max: 90, unit: "days" })
}

// ---- what was said ---------------------------------------------------------------------------------------------------

type When =
  | { readonly kind: "once"; readonly at: number }
  | { readonly kind: "repeat"; readonly at: number; readonly rrule: string; readonly dtstart: string; readonly timeZone: string; readonly rule: string | undefined }
  | { readonly kind: "ask"; readonly key: "when" | "whenAmbiguous" | "atTime" | "past" | "tooFar" }

/** A phrase of time: a repeat, or one moment. Never guessed: what is not clear becomes a question, a missing clock time too. */
export const parseWhen = (text: string, language: Language, zone: string, now: number): When => {
  const rec = parseRecurrence(text, language, { now, timeZone: zone })
  if (rec.kind === "ok") {
    const r = rec.value
    // "every Monday": the helper would put it at its default time; the module asks instead, as for one moment.
    if (r.timeDefaulted) return { kind: "ask", key: "atTime" }
    if (r.rrule.length > 100 || r.dtstart.length > 70 || r.timeZone.length > 64) return { kind: "ask", key: "when" }
    return { kind: "repeat", at: r.startInstant, rrule: r.rrule, dtstart: r.dtstart, timeZone: r.timeZone, rule: describeRRule(r.rrule, language, { time: r.start, start: r.start, timeZone: r.timeZone }) }
  }
  if (rec.kind === "ambiguous") return { kind: "ask", key: "whenAmbiguous" }
  const dt = parseDateTime(text, language, { now, timeZone: zone })
  if (dt.kind === "ambiguous") return { kind: "ask", key: "whenAmbiguous" }
  if (dt.kind !== "ok") return { kind: "ask", key: "when" }
  const v = dt.value
  if (v.instant === undefined) return { kind: "ask", key: "atTime" }
  if (v.inPast || v.instant <= now) return { kind: "ask", key: "past" }
  if (v.instant > now + MAX_AHEAD_MS) return { kind: "ask", key: "tooFar" }
  return { kind: "once", at: v.instant }
}

/** A stored repeat in words ("every Monday at seven"), or what it can be said as. */
const ruleText = (rem: Reminder, language: Language): string => {
  if (rem.rrule === undefined || rem.dtstart === undefined) return say(texts, language, "repeating")
  const start = parseDtstart(rem.dtstart)
  if (start === undefined) return say(texts, language, "repeating")
  return describeRRule(rem.rrule, language, { time: start.start, start: start.start, timeZone: start.timeZone }) ?? say(texts, language, "repeating")
}

const originOf = (rem: Reminder): ScheduleOrigin => ({
  ...(rem.assistantId !== undefined ? { assistantId: rem.assistantId } : {}),
  ...(rem.deviceId !== undefined ? { deviceId: rem.deviceId } : {})
})

/** The one job of a reminder, the key of the notification of one of its occurrences, the key of its card. */
export const jobKey = (id: string) => `reminder:${id}`
export const noteKey = (id: string, at: number) => `rem:${id}:${at}`
const NOTE_KEY = /^rem:([A-Za-z0-9_-]{1,40}):(\d{1,16})$/
const cardKey = (id: string) => `due:${id}`

/** Cleanup owed, with more to take down: tried at once (`tryAt` now), notes merged, at most `STOP_NOTES` (an older one has expired by then). */
const addStop = (stop: Stop | undefined, notes: ReadonlyArray<number>, card: boolean, now: number): Stop | undefined => {
  const all = [...(stop?.notes ?? [])]
  for (const n of notes) if (!all.includes(n)) all.push(n)
  const kept = all.slice(-STOP_NOTES)
  const withCard = card || stop?.card === true
  if (kept.length === 0 && !withCard) return stop
  return { notes: kept, card: withCard, attempts: stop?.attempts ?? 0, tryAt: now }
}
const withStop = (value: Reminder, stop: Stop | undefined): Reminder => (stop === undefined ? without(value, "stop") : { ...value, stop })

type Kind = "done" | "snooze"

interface By {
  /** The occurrence a button was pressed for (from its key). */
  readonly at?: number
  /** The notification or card pressed (a snooze of the same one is not pushed further). */
  readonly pressId?: string
  /** Pressed on the notification: the service resolves that notification itself after the handler. */
  readonly viaNotification?: boolean
  readonly ms?: number
  readonly actor?: Actor
}

interface ShownList {
  readonly handle: PresentHandle
  readonly ids: ReadonlyArray<string>
  readonly person: string | undefined
  readonly owner: string | undefined
  readonly deviceId: string
  readonly until: number
}

export const remindersModule = defineModule({
  apiVersion: 2,
  id: "reminders",
  name: "Reminders",
  description: "Reminders at a time or repeating, for the household or for one person.",
  enabledByDefault: false,
  settings,
  storage: { version: 1, collections: [reminders] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const board = ctx.store.collection(reminders)
      const lang = () => homeLanguage(ctx.host.view())
      const zone = () => homeZone(ctx.host.view().home)
      const snoozeMs = () => {
        const m = ctx.settingsFor(undefined)?.snoozeMinutes
        return (typeof m === "number" ? m : 10) * 60_000
      }
      /** The cards of due reminders this part is showing (a transient card ends with the part, so this is all of them). */
      const cards = new Map<string, PresentHandle>()
      /** The list this part showed on each device, so a change to a reminder on it replaces or dismisses it. */
      const lists = new Map<string, ShownList>()
      /** Reminders written in the present locked step: the lists showing them are brought up to date at its end. */
      const touched = new Set<string>()

      // ---- one at a time -------------------------------------------------------------------------------------------

      const lock = Semaphore.makeUnsafe(1)

      const listPresentation = (rows: ReadonlyArray<Row<Reminder>>, owner: string | undefined): Presentation => {
        const l = lang()
        const z = zone()
        return {
          kind: "list",
          title: say(texts, l, "listTitle"),
          style: "bullets",
          items: rows.slice(0, 12).map((r) => ({ id: r.id, text: cut(`${shortMoment(speaksAt(r.value) ?? r.value.ring?.at ?? 0, l, z)} · ${r.value.text}`, 80) })),
          spoken: say(texts, l, "spokenList", { count: rows.length }),
          ...(owner !== undefined ? { sensitivity: { personal: owner } } : {})
        }
      }
      const bySpeaking = (a: Row<Reminder>, b: Row<Reminder>) => (speaksAt(a.value) ?? -1) - (speaksAt(b.value) ?? -1)

      /** A list on a screen showing a reminder that changed: shown again from the rows as they are now, or dismissed when none is left. */
      const refreshList = (shown: ShownList) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          if (now >= shown.until) return void lists.delete(shown.deviceId)
          const privacy = ctx.host.service(Privacy)
          const rows: Array<Row<Reminder>> = []
          for (const id of shown.ids) {
            const row = yield* board.get(id)
            if (row === undefined || row.value.state !== "open") continue
            const owner = row.value.owner
            // Asked again now, for that device: a person's own only where it may be shown there at this moment.
            if (owner === undefined || (owner === shown.person && privacy?.mayReveal(owner, shown.deviceId) === true)) rows.push(row)
          }
          rows.sort(bySpeaking)
          if (rows.length === 0) {
            const gone = yield* Effect.exit(shown.handle.dismiss)
            if (Exit.isSuccess(gone)) lists.delete(shown.deviceId)
            return
          }
          const updated = yield* shown.handle.update(listPresentation(rows, shown.owner))
          if (updated === undefined) lists.delete(shown.deviceId)
          else lists.set(shown.deviceId, { ...shown, ids: rows.map((r) => r.id) })
        }).pipe(Effect.ignore)

      const flushLists = Effect.gen(function*() {
        if (touched.size === 0) return
        const changed = new Set(touched)
        touched.clear()
        for (const shown of [...lists.values()]) if (shown.ids.some((id) => changed.has(id))) yield* refreshList(shown)
      })

      /** Every change of a reminder goes one at a time: a tool, a job and a press never read and write over each other. */
      const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(Effect.ensuring(effect, flushLists))

      // ---- writing a row and planning its one job ------------------------------------------------------------------

      /**
       * Writes the row (from the revision read) with its `nextAt`, and its one job planned for that moment in the same
       * transaction (no job when nothing is planned: the old one is cancelled after the commit, and one left over finds
       * nothing to do). A problem to report becomes a job that fails at once: a Health issue (left out at the job limit).
       */
      const write = (row: Row<Reminder>, f: (v: Reminder) => Reminder, opts: { readonly actor?: Actor | undefined; readonly report?: string } = {}) =>
        Effect.gen(function*() {
          const value0 = f(row.value)
          const nextAt = planOf(value0)
          const value: Reminder = nextAt === undefined ? without(value0, "nextAt") : { ...value0, nextAt }
          const job = nextAt === undefined
            ? undefined
            : yield* ctx.scheduler.prepare({ handler: "due", key: jobKey(row.id), payload: { id: row.id }, at: nextAt, late: "run", origin: originOf(value) })
          const report = opts.report === undefined
            ? undefined
            : yield* ctx.scheduler.prepare({ handler: "problem", key: `problem:${row.id}`, payload: { reason: cut(opts.report, 200) }, inMs: 0, origin: {} }).pipe(
              Effect.orElseSucceed(() => undefined)
            )
          const written = yield* ctx.store.transaction((tx) => {
            const w = tx.collection(reminders).update(row.id, () => value, { expectRev: row.rev, ...(opts.actor !== undefined ? { actor: opts.actor } : {}) })
            job?.writeIn(tx)
            if (report !== undefined) {
              try {
                report.writeIn(tx)
              } catch (e) {
                // Refused before anything of it was written (the job limit): the row is kept, without the report.
                if (!(e instanceof StoreError && e.reason === "invalid")) throw e
              }
            }
            return w
          })
          if (job === undefined) yield* Effect.ignore(ctx.scheduler.cancel({ key: jobKey(row.id) }))
          touched.add(row.id)
          return written
        })

      // ---- delivering ----------------------------------------------------------------------------------------------

      /** The card of a delivered reminder on the device it was set on, with the same two answers (its key replaces an older one). */
      const showCard = (id: string, rem: Reminder, at: number) =>
        Effect.gen(function*() {
          if (rem.deviceId === undefined) return
          const l = lang()
          const owner = rem.owner
          const present: Presentation = {
            kind: "card",
            title: say(texts, l, "notificationTitle"),
            text: rem.text,
            facts: [
              { label: say(texts, l, "cardDue"), value: shortMoment(at, l, zone()) },
              ...(rem.rrule !== undefined ? [{ label: say(texts, l, "cardRepeats"), value: cut(ruleText(rem, l), 60) }] : []),
              { label: say(texts, l, "cardFor"), value: say(texts, l, owner === undefined ? "forHousehold" : "forYou") }
            ],
            spoken: say(texts, l, owner === undefined ? "spokenCard" : "spokenCardPrivate", { text: cut(rem.text, 200) }),
            buttons: [{ id: "done", label: say(texts, l, "labelDone") }, { id: "snooze", label: say(texts, l, "labelSnooze") }],
            handler: "reminders",
            ...(owner !== undefined ? { sensitivity: { personal: owner } } : {})
          }
          const handle = yield* ctx.present.show({ device: rem.deviceId }, present, { lifetime: "transient", expiresInMs: CARD_MS, key: cardKey(id) })
          cards.set(id, handle)
        }).pipe(Effect.ignore)

      /**
       * The ring on the device the reminder was set on (its job's origin), under a key of the reminder and the occurrence:
       * one still open with that key answers the send without ringing again. Priority `ring` by default, because the
       * person asked for this moment. Then the card.
       */
      const deliver = (id: string, rem: Reminder, owed: Owed, now: number) =>
        Effect.gen(function*() {
          const l = lang()
          const priority = ctx.settingsFor(undefined)?.priority === "normal" ? "normal" : "ring"
          const late = now - owed.from > LATE_NOTE_MS ? ` (${say(texts, l, "late", { when: momentText(owed.at, l, zone(), now) })})` : ""
          yield* ctx.notify.send({
            title: say(texts, l, "notificationTitle"),
            text: cut(`${rem.text}${late}`, 200),
            priority,
            key: noteKey(id, owed.at),
            expiresInMs: priority === "ring" ? RING_EXPIRES_MS : NORMAL_EXPIRES_MS,
            actions: [{ id: "done", label: say(texts, l, "labelDone") }, { id: "snooze", label: say(texts, l, "labelSnooze") }],
            handler: "reminders",
            target: rem.deviceId !== undefined ? "origin" : "everywhere",
            ...(rem.owner !== undefined ? { owner: rem.owner } : {})
          })
          yield* showCard(id, rem, owed.at)
        })

      const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ")

      // ---- reconciling one row -------------------------------------------------------------------------------------

      interface Opts {
        readonly actor?: Actor | undefined
        /** Only the reminder's own job sends: its origin is the reminder's device. */
        readonly send: boolean
        /** Try the cleanup owed now, whatever its time (a tool or a button tries it once, in line). */
        readonly forceStop?: boolean
      }

      /** Takes down the notifications and the card still owed; what fails is tried again later, a bounded number of times. */
      const takeDown = (row: Row<Reminder>, now: number, actor: Actor | undefined) =>
        Effect.gen(function*() {
          const s = row.value.stop!
          const left: Array<number> = []
          let why = ""
          for (const at of s.notes) {
            const failed = yield* ctx.notify.resolve({ key: noteKey(row.id, at) }).pipe(Effect.as(undefined), Effect.catchTag("NotifyError", (e) => Effect.succeed(e.reason)))
            if (failed !== undefined) {
              left.push(at)
              why = failed
            }
          }
          let card = false
          const shown = s.card ? cards.get(row.id) : undefined
          if (shown !== undefined) {
            const failed = yield* shown.dismiss.pipe(Effect.as(undefined), Effect.catchTag("PresentError", (e) => Effect.succeed(e.reason)))
            if (failed === undefined) cards.delete(row.id)
            else {
              card = true
              why = failed
            }
          }
          if (left.length === 0 && !card) return yield* write(row, (v) => without(v, "stop"), { actor })
          const attempts = s.attempts + 1
          if (attempts >= MAX_STOP_TRIES) {
            return yield* write(row, (v) => without(v, "stop"), {
              actor,
              report: `A reminder's ring or card could not be taken down after ${attempts} tries (${why}); it ends by itself when it expires. Reminder ${row.id}.`
            })
          }
          return yield* write(row, (v) => ({ ...v, stop: { notes: left, card, attempts, tryAt: now + STOP_RETRY_MS * 2 ** (attempts - 1) } }), { actor })
        })

      /** An occurrence that is due moves from the series to `owed`, and the series advances, in one write. */
      const takeOccurrence = (row: Row<Reminder>, now: number, actor: Actor | undefined) => {
        const r = row.value
        const at = r.dueAt!
        // Always the next occurrence after now: one missed during an outage is skipped, never planned in the past.
        const next = isRepeat(r) ? nextOf(r, Math.max(now, at)) : undefined
        const series = (v: Reminder): Reminder => (next !== undefined ? { ...without(v, "dueAt"), dueAt: next } : without(v, "dueAt"))
        if (isRepeat(r) && now - at > REPEAT_DELIVER_WITHIN_MS) {
          return write(row, (v) => ({ ...series(v), dropped: { at, why: "late" as const, when: now } }), { actor })
        }
        const old = r.owed
        return write(row, (v) => ({
          ...withStop(series(without(v, "owed")), old !== undefined && old.attempts > 0 ? addStop(v.stop, [old.at], false, now) : v.stop),
          owed: { at, from: at, attempts: 0, tryAt: now },
          ...(old !== undefined ? { dropped: { at: old.at, why: "superseded" as const, when: now } } : {})
        }), { actor })
      }

      /** One try of the owed delivery: written before it is made, then sent, then the ring written. */
      const attempt = (row: Row<Reminder>, now: number, actor: Actor | undefined) =>
        Effect.gen(function*() {
          const r = row.value
          const o = r.owed!
          // The late rule, on every try, from the occurrence's own time (or the snooze's end): a repeat at most six hours late.
          if (isRepeat(r) && now - o.from > REPEAT_DELIVER_WITHIN_MS) {
            return yield* write(row, (v) => ({ ...without(v, "owed"), dropped: { at: o.at, why: "late" as const, when: now } }), { actor })
          }
          const tries = o.attempts + 1
          const tried = yield* write(row, (v) => ({ ...v, owed: { ...o, attempts: tries, tryAt: now + RETRY_MS * 2 ** (tries - 1) } }), { actor })
          const failed = yield* deliver(row.id, tried.value, o, now).pipe(Effect.as(undefined), Effect.catchTag("NotifyError", (e) => Effect.succeed(e)))
          if (failed === undefined) {
            // Delivered: it becomes the ring, replacing an older ring of the same reminder, whose notification is taken
            // down; the card was replaced by the new one.
            return yield* write(tried, (v) => {
              const prev = v.ring
              const stop0 = prev !== undefined && prev.at !== o.at ? addStop(v.stop, [prev.at], false, now) : v.stop
              const stop = stop0 === undefined ? undefined : stop0.notes.length === 0 ? undefined : { ...stop0, card: false }
              return withStop({ ...without(v, "owed", "ring"), ring: { at: o.at, deliveredAt: now } }, stop)
            }, { actor })
          }
          if (tries < MAX_TRIES) return tried
          return yield* write(tried, (v) => ({ ...without(v, "owed"), dropped: { at: o.at, why: "failed" as const, when: now } }), {
            actor,
            report: `A reminder due ${when(o.at)} UTC could not be delivered after ${tries} tries (${failed.reason}). It was set on device ${r.deviceId ?? "(none)"}. Reminder ${row.id}.`
          })
        })

      /**
       * Brings one reminder up to date at this moment, and plans its job again. In order: cleanup owed; a ring unanswered
       * for a week ends; (only in its own job) an occurrence that is due moves to `owed` while the series advances, a
       * snooze that has come is owed again, an owed delivery is tried; a row with nothing left is finished. Run twice,
       * late, or after the row changed, it does only what the row says is owed now.
       */
      const reconcileLocked = (id: string, opts: Opts) =>
        Effect.gen(function*() {
          let row = yield* board.get(id)
          if (row === undefined) return undefined
          let force = opts.forceStop === true
          for (let step = 0; step < 16; step++) {
            const now = yield* Clock.currentTimeMillis
            const r: Reminder = row.value
            if (r.stop !== undefined && (force || r.stop.tryAt <= now)) {
              force = false
              row = yield* takeDown(row, now, opts.actor)
              continue
            }
            if (r.state !== "open") break
            if (r.ring !== undefined && r.ring.snoozeUntil === undefined && r.ring.deliveredAt + UNANSWERED_MS <= now) {
              // Its notification and card have expired long since; the take-down is asked for anyway, as for every ending.
              const at = r.ring.at
              row = yield* write(row, (v) => withStop({ ...without(v, "ring"), dropped: { at, why: "unanswered" as const, when: now } }, addStop(v.stop, [at], true, now)), { actor: opts.actor })
              continue
            }
            if (opts.send) {
              if (r.dueAt !== undefined && r.dueAt <= now) {
                row = yield* takeOccurrence(row, now, opts.actor)
                continue
              }
              const snoozed = r.ring?.snoozeUntil
              if (r.ring !== undefined && snoozed !== undefined && snoozed <= now) {
                const ring = r.ring
                // A newer occurrence is owed already: it replaces this ring, so the snooze is dropped.
                row = yield* write(row, (v) => (v.owed !== undefined ? without(v, "ring") : { ...without(v, "ring"), owed: { at: ring.at, from: snoozed, attempts: 0, tryAt: now } }), { actor: opts.actor })
                continue
              }
              // An owed delivery waits for the take-down of a notification with its own key (a change of words while it rang).
              if (r.owed !== undefined && r.owed.tryAt <= now && r.stop?.notes.includes(r.owed.at) !== true) {
                const before = r.owed.attempts
                row = yield* attempt(row, now, opts.actor)
                if (row.value.owed !== undefined && row.value.owed.attempts !== before && row.value.owed.tryAt > now) break
                continue
              }
            }
            if (r.dueAt === undefined && r.owed === undefined && r.ring === undefined) {
              row = yield* write(row, (v) => ({ ...v, state: "lapsed" as const, endedAt: now }), { actor: opts.actor })
              continue
            }
            break
          }
          return row
        })

      const actorOf = Effect.gen(function*() {
        const job = yield* CurrentJob
        return job === undefined ? undefined : ({ kind: "job", jobId: job.jobId } as const)
      })

      // ---- jobs ----------------------------------------------------------------------------------------------------

      // One job per open reminder, planned for its `nextAt` with every write of the row. Its handler reconciles the row:
      // it runs however late (`late: "run"`), because the series must go on, and decides inside what is still owed.
      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: Schema.String.check(Schema.isMaxLength(60)) }),
        // Run again, it does only what the row says is owed at that moment.
        idempotent: true,
        retries: 5,
        run: ({ id }) =>
          exclusive(Effect.gen(function*() {
            const actor = yield* actorOf
            yield* reconcileLocked(id, { actor, send: true })
          }))
      }).pipe(Effect.orDie)

      // A problem the household owner should see (a delivery or a cleanup given up): a job that fails at once is a Health issue.
      yield* ctx.scheduler.handle("problem", {
        payload: Schema.Struct({ reason: Schema.String.check(Schema.isMaxLength(200)) }),
        run: ({ reason }) => Effect.fail(new Error(reason))
      }).pipe(Effect.orDie)

      // The daily clean-up (04:00): a ring unanswered for a week ends (every open row is looked at, page by page with a
      // yield between), and finished rows older than the setting are removed, oldest first, until the cutoff is passed.
      yield* ctx.scheduler.handle("tidy", {
        payload: Schema.Struct({}),
        idempotent: true,
        run: () =>
          Effect.gen(function*() {
            const actor = yield* actorOf
            if (actor === undefined) return yield* Effect.die(new Error("tidy runs only as a job"))
            const keepDays = ctx.settingsFor(undefined)?.keepDays
            const now = yield* Clock.currentTimeMillis
            const removeBefore = now - (typeof keepDays === "number" ? keepDays : 7) * DAY
            let after: Row<Reminder> | undefined
            for (let batch = 0; batch < TIDY_PAGES; batch++) {
              const page: ReadonlyArray<Row<Reminder>> = yield* board.list({ where: { state: "open" }, orderBy: { field: "nextAt", direction: "asc" }, limit: PAGE, ...(after !== undefined ? { after } : {}) })
              for (const r of page) {
                const ring = r.value.ring
                if (ring !== undefined && ring.snoozeUntil === undefined && ring.deliveredAt + UNANSWERED_MS <= now) yield* exclusive(reconcileLocked(r.id, { actor, send: false }))
              }
              if (page.length < PAGE) break
              after = page.at(-1)
              yield* Effect.yieldNow
            }
            for (const state of ["done", "cancelled", "lapsed"] as const) {
              let from: Row<Reminder> | undefined
              for (let batch = 0; batch < TIDY_PAGES; batch++) {
                const passed = yield* exclusive(Effect.gen(function*() {
                  const page: ReadonlyArray<Row<Reminder>> = yield* board.list({ where: { state }, orderBy: { field: "endedAt", direction: "asc" }, limit: PAGE, ...(from !== undefined ? { after: from } : {}) })
                  // A row whose cleanup is still owed stays until it is done; the rows after it are read on.
                  const old = page.filter((r) => (r.value.endedAt ?? 0) < removeBefore && r.value.stop === undefined)
                  yield* ctx.store.transaction((tx) => {
                    for (const r of old) tx.collection(reminders).remove(r.id, { expectRev: r.rev, actor })
                  })
                  from = page.at(-1)
                  return page.length < PAGE || page.some((r) => (r.value.endedAt ?? 0) >= removeBefore)
                }))
                if (passed) break
                yield* Effect.yieldNow
              }
            }
          })
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "tidy", key: "tidy", cron: "0 4 * * *" }).pipe(Effect.orDie)

      // ---- reading -------------------------------------------------------------------------------------------------

      /**
       * The open reminders the asking device may be told of now, by `nextAt` (the index): the household's, and the asking
       * person's own where `Privacy.mayReveal` says so at this moment. Another person's are not looked at (nor counted); the
       * asking person's own that cannot be revealed here are only kept aside (`hidden`, counted). Says when the read was cut.
       */
      const readVisible = (turn: TurnContext | undefined) =>
        Effect.gen(function*() {
          const privacy = ctx.host.service(Privacy)
          const person = turn?.person?.id
          const scan = yield* scanRows<Reminder, unknown>((p) => board.list({ where: { state: "open" }, orderBy: { field: "nextAt", direction: "asc" }, ...p }))
          const rows: Array<Row<Reminder>> = []
          const hidden: Array<Row<Reminder>> = []
          for (const row of scan.rows) {
            const owner = row.value.owner
            if (owner === undefined) rows.push(row)
            else if (owner === person) {
              if (privacy?.mayReveal(owner, turn) === true) rows.push(row)
              else hidden.push(row)
            }
          }
          return { rows, hidden, cut: scan.cut, person }
        })

      /** Finished reminders whose cleanup is still owed (they have a `nextAt`), that the asking device may be told of. */
      const readStopping = (turn: TurnContext | undefined) =>
        Effect.gen(function*() {
          const privacy = ctx.host.service(Privacy)
          const person = turn?.person?.id
          const found: Array<Row<Reminder>> = []
          for (const state of ["done", "cancelled", "lapsed"] as const) {
            const page = yield* board.list({ where: { state }, orderBy: { field: "nextAt", direction: "desc" }, limit: PAGE })
            for (const row of page) {
              if (row.value.nextAt === undefined) break
              const owner = row.value.owner
              if (owner === undefined || (owner === person && privacy?.mayReveal(owner, turn) === true)) found.push(row)
            }
          }
          return found
        })

      /** Which reminder is meant by its words: exactly one match, else a sentence that asks or says there is none. */
      const pick = (which: string, turn: TurnContext | undefined, l: Language) =>
        Effect.gen(function*() {
          const seen = yield* readVisible(turn)
          const stopping = yield* readStopping(turn)
          const found = matching([...seen.rows, ...stopping], which)
          if (found.rows.length === 0) {
            if (seen.cut) return { spoken: say(texts, l, "cutNone", { count: SCAN_ROWS }) }
            return { spoken: `${say(texts, l, "noMatch", { which: cut(which, 60) })}${seen.hidden.length > 0 ? ` ${say(texts, l, "unreadableHere")}` : ""}` }
          }
          // A cut read cannot say a partial match is the only one: one beyond the bound could match too.
          if (found.rows.length === 1 && (!seen.cut || found.exact)) return { row: found.rows[0]! }
          if (found.rows.length === 1) return { spoken: say(texts, l, "cutAsk", { count: SCAN_ROWS }) }
          return { spoken: say(texts, l, "ask", { list: speakList(found.rows.slice(0, 4).map((r) => cut(r.value.text, 50)), l, { max: 4 }) ?? "" }) }
        })

      /** The reminder that rang on this device: the one reminder with an open ring of this module there that may be told here. */
      const ringing = (turn: TurnContext | undefined, l: Language) =>
        Effect.gen(function*() {
          const privacy = ctx.host.service(Privacy)
          const open = yield* ctx.notify.list()
          const ids = new Map<string, number>()
          for (const n of open) {
            const m = n.key === undefined ? null : NOTE_KEY.exec(n.key)
            if (m === null) continue
            if (n.deviceId !== undefined && n.deviceId !== turn?.deviceId) continue
            if (n.owner !== undefined && privacy?.mayReveal(n.owner, turn) !== true) continue
            ids.set(m[1]!, Math.max(ids.get(m[1]!) ?? 0, Number(m[2])))
          }
          if (ids.size === 0) return { spoken: say(texts, l, "nothingRang") }
          if (ids.size > 1) return { spoken: say(texts, l, "askRang") }
          return { id: [...ids.keys()][0]! }
        })

      /** Whether the notification of an occurrence is open now. A read that fails counts as open (it is taken down and sent again). */
      const isOpen = (id: string, at: number) =>
        ctx.notify.list().pipe(
          Effect.map((open) => open.some((n) => n.key === noteKey(id, at))),
          Effect.orElseSucceed(() => true)
        )

      const stopping = (row: Row<Reminder> | undefined, l: Language) => (row?.value.stop !== undefined ? ` ${say(texts, l, "stopping")}` : "")

      // ---- answering: done, snooze ---------------------------------------------------------------------------------

      /**
       * Done, or snooze, for one reminder, as a tool, a typed action, a notification button or a card's button. The row is
       * read again here, after any wait, and its state decides. Done answers the ring; on a repeat that is not ringing it
       * skips the next occurrence. A snooze of the same press is not pushed further. Cleanup is tried once, in line.
       */
      const answerLocked = (kind: Kind, id: string, by: By) =>
        Effect.gen(function*() {
          const l = lang()
          const z = zone()
          const actor = by.actor
          let row = yield* reconcileLocked(id, { actor, send: false })
          if (row === undefined) return say(texts, l, "gone")
          const now = yield* Clock.currentTimeMillis
          const r: Reminder = row.value
          if (r.state !== "open") {
            // Finished already (twice, or cancelled meanwhile): nothing is written again; cleanup still owed is finished.
            if (r.stop !== undefined) row = yield* reconcileLocked(id, { actor, send: false, forceStop: true })
            return `${say(texts, l, kind === "done" ? "doneAgain" : "snoozeEnded")}${stopping(row, l)}`
          }
          const pressed = by.viaNotification === true && by.at !== undefined ? by.at : undefined
          const current = r.ring?.at ?? r.owed?.at
          if (kind === "done") {
            if (current !== undefined && (by.at === undefined || by.at === current)) {
              const notes = [r.ring?.at, r.owed !== undefined && r.owed.attempts > 0 ? r.owed.at : undefined].filter((x): x is number => x !== undefined && x !== pressed)
              const goesOn = r.dueAt !== undefined
              row = yield* write(row, (v) => withStop(goesOn ? without(v, "ring", "owed", "handled") : { ...without(v, "ring", "owed", "handled"), state: "done" as const, endedAt: now }, addStop(v.stop, notes, true, now)), { actor })
              row = yield* reconcileLocked(id, { actor, send: false, forceStop: true })
              const next = row?.value.dueAt
              return `${next !== undefined ? say(texts, l, "doneRepeat", { when: momentText(next, l, z, now) }) : say(texts, l, "done")}${stopping(row, l)}`
            }
            if (by.at !== undefined) return say(texts, l, "answeredAlready")
            if (!isRepeat(r) || r.dueAt === undefined) {
              row = yield* write(row, (v) => ({ ...without(v, "dueAt"), state: "done" as const, endedAt: now }), { actor })
              row = yield* reconcileLocked(id, { actor, send: false })
              return `${say(texts, l, "done")}${stopping(row, l)}`
            }
            // A repeat that is not ringing: done for its next time, which is skipped; the series goes on after it.
            const skipped = r.dueAt
            const next = nextOf(r, skipped)
            row = yield* write(row, (v) => (next !== undefined ? { ...v, dueAt: next } : { ...without(v, "dueAt"), state: "done" as const, endedAt: now }), { actor })
            const said = momentText(skipped, l, z, now)
            return next !== undefined ? say(texts, l, "doneSkipped", { skipped: said, when: momentText(next, l, z, now) }) : say(texts, l, "doneSkippedLast", { skipped: said })
          }
          const ring = r.ring
          if (ring === undefined) return say(texts, l, "notRinging")
          if (by.at !== undefined && by.at !== ring.at) return say(texts, l, "answeredAlready")
          // The same press again: it has been put off already, and is not put off further.
          if (by.pressId !== undefined && r.handled === by.pressId && ring.snoozeUntil !== undefined) return say(texts, l, "snoozedAlready")
          const ms = by.ms ?? snoozeMs()
          const until = now + ms
          row = yield* write(row, (v) => withStop({ ...v, ring: { ...ring, snoozeUntil: until }, ...(by.pressId !== undefined ? { handled: by.pressId } : {}) }, addStop(v.stop, ring.at === pressed ? [] : [ring.at], true, now)), { actor })
          row = yield* reconcileLocked(id, { actor, send: false, forceStop: true })
          return `${say(texts, l, "snoozed", { duration: speakDuration(ms, l, { natural: true }) ?? `${Math.round(ms / 60_000)}` })}${stopping(row, l)}`
        })

      const answer = (kind: Kind, id: string, by: By) => exclusive(answerLocked(kind, id, by))

      /** A button's press: the occurrence from its key, the pressing device as the writer. */
      const press = (kind: Kind, key: string | undefined, by: Omit<By, "at" | "actor">, deviceId: string) => {
        const m = key === undefined ? null : NOTE_KEY.exec(key)
        const id = m?.[1] ?? (key?.startsWith("due:") === true ? key.slice(4) : undefined)
        if (id === undefined) return Effect.succeed(say(texts, lang(), "gone"))
        return answer(kind, id, { ...by, ...(m !== null ? { at: Number(m[2]) } : {}), actor: { kind: "ui", deviceId } })
      }

      // A button on a due reminder's notification, and on its card: the same two answers, registered in `shared`.
      yield* ctx.notify.handle("reminders", {
        run: (p) =>
          press(p.actionId === "snooze" ? "snooze" : "done", p.key, { pressId: p.notificationId, viaNotification: true }, p.deviceId).pipe(
            Effect.map((text) => ({ say: text })),
            Effect.catch(() => Effect.succeed({ say: say(texts, lang(), "cantNow"), keepOpen: true }))
          )
      }).pipe(Effect.orDie)
      yield* ctx.present.handle("reminders", {
        run: (p) =>
          press(p.action === "snooze" ? "snooze" : "done", p.key, { pressId: p.presentationId }, p.deviceId).pipe(
            Effect.map((text) => ({ say: text })),
            Effect.catch(() => Effect.succeed({ say: say(texts, lang(), "cantNow") }))
          )
      }).pipe(Effect.orDie)

      // ---- the briefing's section ----------------------------------------------------------------------------------

      /**
       * What is coming today, for the asking person: the household's reminders and their own where the privacy rule allows it
       * on the asking device now; their own that it does not allow are only counted, within the same day. Read from the
       * store, bounded; a cut read says so in every shape of answer. Whole items are fitted into the sentence, never sliced.
       */
      const section = {
        id: "reminders",
        title: "Reminders",
        gather: (request: { readonly turn: TurnContext; readonly language: Language; readonly maxSentences: number; readonly now: number }) =>
          Effect.gen(function*() {
            const l = request.language
            const z = zone()
            const end = endOfToday(request.now, z)
            const inDay = (r: Row<Reminder>) => {
              const t = speaksAt(r.value)
              return t !== undefined && t >= request.now && t < end
            }
            const seen = yield* readVisible(request.turn)
            const today = seen.rows.filter(inDay).sort(bySpeaking)
            const withheld = seen.hidden.filter(inDay).length
            if (today.length === 0) {
              if (seen.cut) return { _tag: "section", sentences: [say(texts, l, "briefCutNone")], priority: "normal", withheld } as const
              if (withheld === 0) return { _tag: "empty" } as const
              return { _tag: "section", sentences: [], priority: "normal", withheld } as const
            }
            const owner = today.some((r) => r.value.owner !== undefined) ? seen.person : undefined
            const items = today.map((r) => {
              const at = localOf(speaksAt(r.value)!, z)
              return say(texts, l, "briefAt", { text: cut(r.value.text, 60), time: speakTime(at, l) ?? `${at.hour}:${String(at.minute).padStart(2, "0")}` })
            })
            const count = today.length
            const counted = speakNumber(count, l, { words: true }) ?? String(count)
            const sentenceWith = (list: string) =>
              seen.cut
                ? say(texts, l, count === 1 ? "briefAtLeastOne" : "briefAtLeast", { count: counted, list })
                : say(texts, l, count === 1 ? "briefOne" : "briefMany", { count: counted, list })
            let sentence = sentenceWith(items[0]!)
            for (const max of [3, 2]) {
              const list = items.length === 1 ? items[0]! : speakList(items, l, { max })
              if (list === undefined) continue
              sentence = sentenceWith(list)
              if (sentence.length <= 300) break
            }
            return { _tag: "section", sentences: [sentence], priority: "normal", withheld, ...(owner !== undefined ? { owner } : {}) } as const
          }).pipe(Effect.mapError(() => new BriefingSectionError({ reason: "failed", detail: "the reminders could not be read" })))
      }

      return {
        value: { board, exclusive, lang, zone, write, reconcileLocked, readVisible, pick, ringing, isOpen, answerLocked, answer, stopping, lists, listPresentation, bySpeaking, originOf },
        contributions: [BriefingSections.of(section)]
      }
    }),
  start: (ctx) => {
    const sh = ctx.shared
    const failed = (l: Language, key: "unsaved" | "unread" = "unsaved") => new ToolError({ message: say(texts, l, key) })
    const personalQuiet = (owner: string | undefined, turn: TurnContext | undefined) => owner !== undefined && ctx.host.service(Privacy)?.mayReveal(owner, turn) !== true
    const ownerOf = (result: unknown) => {
      const owner = (result as { readonly owner?: string }).owner
      return owner === undefined ? { kind: "household" as const } : { kind: "personal" as const, owner }
    }

    /** Writes the reminder and its job in one transaction, and says what was set from the row as written (nothing personal where it may not be told). */
    const create = (text: string, said: Exclude<When, { kind: "ask" }>, scope: "me" | "household" | undefined, now: number) =>
      Effect.gen(function*() {
        const turn = yield* CurrentTurn
        const l = sh.lang()
        const person = turn?.person?.id
        const personal = scope === "me" ? true : scope === "household" ? false : person !== undefined
        // Personal content needs an owner: nobody known is asking, so ask whose, write nothing, repeat nothing.
        if (personal && person === undefined) return { spoken: say(texts, l, "whose") }
        const z = sh.zone()
        const owner = personal ? person : undefined
        const rem: Reminder = {
          text, whose: owner === undefined ? "household" : "personal", state: "open", dueAt: said.at, nextAt: said.at,
          ...(owner !== undefined ? { owner } : {}),
          ...(turn?.deviceId !== undefined ? { deviceId: turn.deviceId } : {}),
          ...(turn?.assistantId !== undefined ? { assistantId: turn.assistantId } : {}),
          ...(person !== undefined ? { setBy: person } : {}),
          ...(said.kind === "repeat" ? { rrule: said.rrule, dtstart: said.dtstart, timeZone: said.timeZone } : {})
        }
        const id = randomUUID()
        const quiet = personalQuiet(owner, turn)
        const written = yield* sh.exclusive(Effect.gen(function*() {
          const job = yield* ctx.scheduler.prepare({ handler: "due", key: jobKey(id), payload: { id }, at: said.at, late: "run", origin: sh.originOf(rem) })
          return yield* ctx.store.transaction((tx) => {
            const row = tx.collection(reminders).insert(rem, { id })
            job.writeIn(tx)
            return row
          })
        })).pipe(Effect.mapError((e) => new ToolError({ message: say(texts, l, "reason" in e && e.reason === "limit" || ("message" in e && /live jobs|limit/i.test(String(e.message))) ? "tooMany" : "unsaved") })))
        const v = written.value
        const at = momentText(v.dueAt ?? said.at, l, z, now)
        const rule = said.kind === "repeat" ? (said.rule ?? say(texts, l, "repeating")) : ""
        const spoken = said.kind === "once"
          ? say(texts, l, quiet ? "setOncePrivate" : owner === undefined ? "setOnceHousehold" : "setOnce", { when: at, text: v.text })
          : say(texts, l, quiet ? "setRepeatPrivate" : owner === undefined ? "setRepeatHousehold" : "setRepeat", { when: at, text: v.text, rule })
        return { spoken, ...(owner !== undefined ? { owner } : {}) }
      })

    const setTool = makeTool({
      name: "reminders_set",
      description:
        "Set a reminder at a time or repeating (\"in ten minutes\", \"tomorrow at five\", \"every Monday at seven\"), for the person asking (scope me, the default when a person is known) or for the household (scope household). It rings on this device. Time reminders only: not 'when I get home', and not for another person. Put the time in `when` and what to be reminded of in `text`. Never put a password or a code in it.",
      parameters: Schema.Struct({
        text: Line(TEXT_CHARS).annotate({ description: "What to remind of, one short line: \"call mum\"" }),
        when: Line(WHEN_CHARS).annotate({ description: "The time, as said: \"in ten minutes\", \"tomorrow at five\", \"every Monday at seven\"" }),
        scope: Schema.optionalKey(Schema.Literals(["me", "household"]).annotate({ description: "me: only for the person asking; household: for the whole house" }))
      }),
      risk: "change",
      latency: "instant",
      sensitivity: ownerOf,
      execute: ({ text, when, scope }) =>
        Effect.gen(function*() {
          const l = sh.lang()
          // A secret is refused without repeating the words, and nothing is stored.
          if (holdsSecret(text)) return { spoken: say(texts, l, "code") }
          const now = yield* Clock.currentTimeMillis
          const said = parseWhen(when, l, sh.zone(), now)
          if (said.kind === "ask") return { spoken: say(texts, l, said.key) }
          return yield* create(text, said, scope, now)
        })
    })

    const listTool = makeTool({
      name: "reminders_list",
      description: "List the open reminders, soonest first: the household's and the asking person's own. Say what it covers; at most five are given, with a count of the rest.",
      parameters: Schema.Struct({}),
      speculative: true,
      latency: "quick",
      sensitivity: ownerOf,
      execute: () =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const z = sh.zone()
          return yield* sh.exclusive(Effect.gen(function*() {
            const seen = yield* sh.readVisible(turn).pipe(Effect.mapError(() => failed(l, "unread")))
            const deviceId = turn?.deviceId
            const rows = [...seen.rows].sort(sh.bySpeaking)
            if (rows.length === 0) {
              // Nothing to show here: a list this part showed on this device goes.
              const shown = deviceId === undefined ? undefined : sh.lists.get(deviceId)
              if (shown !== undefined) {
                sh.lists.delete(shown.deviceId)
                yield* Effect.ignore(shown.handle.dismiss)
              }
              if (seen.cut) return { spoken: say(texts, l, "cutNone", { count: SCAN_ROWS }) }
              if (seen.hidden.length > 0) return { spoken: say(texts, l, "withheld", { count: seen.hidden.length }) }
              return { spoken: say(texts, l, seen.person === undefined ? "nothingHousehold" : "nothing") }
            }
            const now = yield* Clock.currentTimeMillis
            const item = (r: Row<Reminder>) => {
              const rem = r.value
              const t = speaksAt(rem)
              return {
                text: rem.text,
                when: t === undefined ? say(texts, l, "wasDue", { when: momentText(rem.ring?.at ?? 0, l, z, now) }) : momentText(t, l, z, now),
                ...(rem.rrule !== undefined ? { repeats: ruleText(rem, l) } : {}),
                ...(rem.owner !== undefined ? { personal: true } : {})
              }
            }
            const owner = rows.some((r) => r.value.owner !== undefined) ? seen.person : undefined
            let screen: string | undefined
            if (deviceId !== undefined) {
              const shownRows = rows.slice(0, 12)
              const shown = yield* Effect.exit(ctx.present.show({ device: deviceId }, sh.listPresentation(shownRows, owner), { lifetime: "transient", expiresInMs: LIST_MS }))
              if (Exit.isSuccess(shown)) {
                sh.lists.set(deviceId, { handle: shown.value, ids: shownRows.map((r) => r.id), person: seen.person, owner, deviceId, until: now + LIST_MS })
                screen = shown.value.outcome.note
              } else {
                const e = Cause.squash(shown.cause)
                screen = `Not shown: ${e instanceof Error ? e.message : "the screen refused it"}`
              }
            }
            return {
              covers: say(texts, l, seen.person === undefined ? "coversHousehold" : seen.hidden.length > 0 ? "coversHouseholdHere" : "coversYours"),
              count: rows.length,
              reminders: rows.slice(0, 5).map(item),
              more: Math.max(0, rows.length - 5),
              ...(seen.hidden.length > 0 ? { withheld: say(texts, l, "withheld", { count: seen.hidden.length }) } : {}),
              ...(seen.cut ? { cut: say(texts, l, "cutRead", { count: SCAN_ROWS }) } : {}),
              ...(screen !== undefined ? { screen } : {}),
              ...(owner !== undefined ? { owner } : {})
            }
          }))
        })
    })

    const changeTool = makeTool({
      name: "reminders_change",
      description: "Change one reminder found by its words: new words (`text`), a new time (`when`, one moment or a repeat), or both. If the words match more than one reminder it asks which.",
      parameters: Schema.Struct({
        which: Line(TEXT_CHARS).annotate({ description: "Words that find the reminder: \"call mum\"" }),
        text: Schema.optionalKey(Line(TEXT_CHARS).annotate({ description: "The new words" })),
        when: Schema.optionalKey(Line(WHEN_CHARS).annotate({ description: "The new time, as said" }))
      }),
      risk: "change",
      sensitivity: ownerOf,
      execute: ({ which, text, when }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          if (text === undefined && when === undefined) return { spoken: say(texts, l, "changeWhat") }
          if (text !== undefined && holdsSecret(text)) return { spoken: say(texts, l, "code") }
          const z = sh.zone()
          const now = yield* Clock.currentTimeMillis
          const said = when === undefined ? undefined : parseWhen(when, l, z, now)
          if (said?.kind === "ask") return { spoken: say(texts, l, said.key) }
          return yield* sh.exclusive(Effect.gen(function*() {
            const picked = yield* sh.pick(which, turn, l)
            if ("spoken" in picked) return { spoken: picked.spoken }
            let row: Row<Reminder> | undefined = picked.row
            const id = row.id
            const owner = row.value.owner
            const quiet = personalQuiet(owner, turn)
            if (row.value.state !== "open") {
              row = yield* sh.reconcileLocked(id, { send: false, forceStop: true })
              return { spoken: `${say(texts, l, "snoozeEnded")}${sh.stopping(row, l)}`, ...(owner !== undefined ? { owner } : {}) }
            }
            const r = row.value
            const ring = r.ring
            let resend = false
            if (said !== undefined) {
              // A new time ends a ring (its notification and card go) and an owed delivery, and replaces the series.
              const notes = [ring?.at, r.owed !== undefined && r.owed.attempts > 0 ? r.owed.at : undefined].filter((x): x is number => x !== undefined)
              row = yield* sh.write(row, (v) => withStop({
                ...without(v, "owed", "ring", "handled", "rrule", "dtstart", "timeZone", "dropped"),
                text: text ?? v.text,
                dueAt: said.at,
                ...(said.kind === "repeat" ? { rrule: said.rrule, dtstart: said.dtstart, timeZone: said.timeZone } : {})
              }, notes.length > 0 || ring !== undefined ? addStop(v.stop, notes, true, now) : v.stop))
            } else if (ring !== undefined && ring.snoozeUntil === undefined && (yield* sh.isOpen(id, ring.at))) {
              // New words while it rings: its notification and card go, and the same occurrence is sent again with them.
              resend = true
              row = yield* sh.write(row, (v) => withStop({ ...without(v, "ring"), text: text!, owed: { at: ring.at, from: now, attempts: 0, tryAt: now } }, addStop(v.stop, [ring.at], true, now)))
            } else {
              row = yield* sh.write(row, (v) => ({ ...v, text: text! }))
            }
            row = yield* sh.reconcileLocked(id, { send: false, forceStop: true })
            // The confirmation is built from the row as it was written.
            const v = row?.value ?? r
            const t = speaksAt(v)
            const whenSaid = t !== undefined ? momentText(t, l, z, now) : say(texts, l, "wasDue", { when: momentText(v.ring?.at ?? 0, l, z, now) })
            const spoken = resend
              ? say(texts, l, quiet ? "changedRingingPrivate" : "changedRinging", { text: v.text })
              : quiet
              ? say(texts, l, "changedPrivate")
              : v.rrule !== undefined
              ? say(texts, l, "changedRepeat", { text: v.text, rule: ruleText(v, l), when: whenSaid })
              : say(texts, l, "changed", { text: v.text, when: whenSaid })
            return { spoken: `${spoken}${sh.stopping(row, l)}`, ...(owner !== undefined ? { owner } : {}) }
          }))
        }).pipe(Effect.mapError((e) => (e instanceof ToolError ? e : failed(sh.lang()))))
    })

    const cancelTool = makeTool({
      name: "reminders_cancel",
      description: "Cancel one reminder, found by its words. A repeating reminder is cancelled for good, every occurrence. If the words match more than one reminder it asks which.",
      parameters: Schema.Struct({ which: Line(TEXT_CHARS).annotate({ description: "Words that find the reminder: \"call mum\"" }) }),
      risk: "change",
      sensitivity: ownerOf,
      execute: ({ which }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          return yield* sh.exclusive(Effect.gen(function*() {
            const picked = yield* sh.pick(which, turn, l)
            if ("spoken" in picked) return { spoken: picked.spoken }
            let row: Row<Reminder> | undefined = picked.row
            const id = row.id
            const owner = row.value.owner
            const text = row.value.text
            const now = yield* Clock.currentTimeMillis
            const done = (row: Row<Reminder> | undefined, state: Reminder["state"]) => ({
              spoken: `${
                state === "cancelled"
                  ? personalQuiet(owner, turn) ? say(texts, l, "cancelledPrivate") : say(texts, l, "cancelled", { text })
                  : say(texts, l, "snoozeEnded")
              }${sh.stopping(row, l)}`,
              ...(owner !== undefined ? { owner } : {})
            })
            if (row.value.state !== "open") {
              // Finished already, its cleanup still owed: this finishes the cleanup.
              const state = row.value.state
              row = yield* sh.reconcileLocked(id, { send: false, forceStop: true })
              return done(row, state)
            }
            const r = row.value
            const notes = [r.ring?.at, r.owed !== undefined && r.owed.attempts > 0 ? r.owed.at : undefined].filter((x): x is number => x !== undefined)
            // Marked, not removed: the daily clean-up removes it later, off this turn's path.
            row = yield* sh.write(row, (v) => withStop({ ...without(v, "dueAt", "owed", "ring", "handled"), state: "cancelled" as const, endedAt: now }, addStop(v.stop, notes, true, now)))
            row = yield* sh.reconcileLocked(id, { send: false, forceStop: true })
            return done(row, "cancelled")
          }))
        }).pipe(Effect.mapError((e) => (e instanceof ToolError ? e : failed(sh.lang()))))
    })

    const doneTool = makeTool({
      name: "reminders_done",
      description:
        "Mark a reminder done. With `which` (words that find it) it is that reminder; without, it is the one that is ringing or waiting on this device. Done on a repeating reminder that is not ringing skips its next time; the series goes on.",
      parameters: Schema.Struct({ which: Schema.optionalKey(Line(TEXT_CHARS).annotate({ description: "Words that find the reminder; leave out for the one that just rang here" })) }),
      risk: "change",
      execute: ({ which }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          if (which === undefined) {
            const found = yield* sh.ringing(turn, l)
            if ("spoken" in found) return { spoken: found.spoken }
            return { spoken: yield* sh.answer("done", found.id, {}) }
          }
          return yield* sh.exclusive(Effect.gen(function*() {
            const picked = yield* sh.pick(which, turn, l)
            if ("spoken" in picked) return { spoken: picked.spoken }
            return { spoken: yield* sh.answerLocked("done", picked.row.id, {}) }
          }))
        }).pipe(Effect.mapError((e) => (e instanceof ToolError ? e : failed(sh.lang()))))
    })

    const remindIn = defineAction({
      id: "remind_in",
      label: "Remind me in a while",
      description: "Set a reminder a said time from now (\"remind me in ten minutes to call mum\"), for the person asking, or the household when nobody is known. A clock time or a repeat is reminders_set.",
      examples: ["remind me in ten minutes to take the pizza out", "remind me in an hour to call mum", "herinner me over tien minuten om te bellen"],
      params: {
        delay: Param.duration({ label: "In how long", minMs: 60_000, maxMs: MAX_AHEAD_MS }),
        text: Param.text({ label: "What to remind of", after: ["to", "om"], maxWords: 8 })
      },
      // The moment is a duration (never a clock time, which would have to be guessed), the words are the one text slot at
      // the end; a clock time or a repeat goes to the model.
      phrases: { en: ["remind me in {delay} to {text}"], nl: ["herinner me over {delay} om {text}"] },
      risk: "change",
      run: ({ delay, text }) =>
        Effect.gen(function*() {
          const l = sh.lang()
          if (!isLine(text, TEXT_CHARS)) return { say: say(texts, l, "unsaved") }
          if (holdsSecret(text)) return { say: say(texts, l, "code") }
          const now = yield* Clock.currentTimeMillis
          const made = yield* create(text, { kind: "once", at: now + delay }, undefined, now)
          return { say: made.spoken }
        }).pipe(Effect.mapError((e) => new ActionError({ message: e instanceof ToolError ? e.message : say(texts, sh.lang(), "unsaved") })))
    })

    const ringingDone = defineAction({
      id: "ringing_done",
      label: "Reminder done",
      description: "The reminder that is ringing or waiting on this device is done. Not for finding a reminder by its words: that is reminders_done.",
      examples: ["done", "that's done", "I've done it", "klaar", "dat is gedaan"],
      params: {},
      // No slot: a reminder's words are free text, so these name the reminder only as "the reminder". "done" alone is a
      // button's label while it rings (the ringing window takes it without the wake phrase) and is not a phrase here,
      // where another module's "done" could meet it.
      phrases: { en: ["reminder done", "mark the reminder as done", "that reminder is done"], nl: ["herinnering klaar", "markeer de herinnering als klaar", "die herinnering is klaar"] },
      risk: "change",
      offerAsTool: false,
      run: () =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const found = yield* sh.ringing(turn, l)
          if ("spoken" in found) return { say: found.spoken }
          return { say: yield* sh.answer("done", found.id, {}) }
        }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, sh.lang(), "cantNow") })))
    })

    const ringingSnooze = defineAction({
      id: "ringing_snooze",
      label: "Snooze the reminder",
      description: "Put off the reminder that is ringing or waiting on this device, for some minutes (the setting's default when none is said).",
      examples: ["snooze", "snooze it for ten minutes", "remind me again in half an hour", "uitstellen", "herinner me over tien minuten nog eens"],
      params: { for: Param.duration({ label: "For how long", optional: true, minMs: 60_000, maxMs: DAY }) },
      // The duration is the only slot, and optional: without it the setting's default is used.
      phrases: { en: ["snooze the reminder", "snooze the reminder for {for}"], nl: ["stel de herinnering uit", "stel de herinnering {for} uit"] },
      risk: "change",
      run: ({ for: ms }) =>
        Effect.gen(function*() {
          const turn = yield* CurrentTurn
          const l = sh.lang()
          const found = yield* sh.ringing(turn, l)
          if ("spoken" in found) return { say: found.spoken }
          return { say: yield* sh.answer("snooze", found.id, { ...(ms !== undefined ? { ms } : {}) }) }
        }).pipe(Effect.mapError(() => new ActionError({ message: say(texts, sh.lang(), "cantNow") })))
    })

    return Effect.succeed({
      tools: [setTool, listTool, changeTool, cancelTool, doneTool],
      actions: [remindIn, ringingDone, ringingSnooze],
      instructions: "Reminders: a task at a moment (a time, or a repeat) is a reminder; a bare duration is a timer; a task without a moment is a list item. Never guess a time that was not said: ask."
    })
  }
})

/** What the app runs from this package (`apps/assistant/src/modules.ts` lists it once): the production definition of each module id. */
export const catalog: ReadonlyArray<ModuleDefinition<any>> = [remindersModule]
