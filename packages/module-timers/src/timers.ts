import {
  type Actor,
  ActionError,
  CurrentJob,
  CurrentTurn,
  defineAction,
  defineCollection,
  defineModule,
  Devices,
  Param,
  type PreparedJob,
  type PresentHandle,
  type Row,
  Setting
} from "@pva/core"
import { speakDuration } from "@pva/language"
import { homeLanguage, isLine, type Language, say, StoredText, Timers, TIMERS_LIMITS, TimersError, type TimerInfo, type TimersService } from "@pva/module-contracts"
import { Clock, Effect, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { capitalise, cleanName, cut, isBusy, listOf, MAX_INSTANT, NAME_CHARS, nameKey, scan, speakLeft } from "./common.ts"
import { timerTexts as texts } from "./texts.ts"

// ---------------------------------------------------------------------------------------------------------------------
// Data

const DEVICE = StoredText(64)
const NOTE = StoredText(40)
const Instant = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_INSTANT }))
const Span = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: TIMERS_LIMITS.maxMs }))
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))

/** A ring that is owed: the occurrence (`n`, its due instant), the tries so far and when to try again. */
const Owed = Schema.Struct({ n: Count, at: Instant, attempts: Count, retryAt: Instant })
/** The ring delivered last: its occurrence, its notification, when it was sent and when it stops by itself. */
const Ring = Schema.Struct({ n: Count, notification: NOTE, at: Instant, until: Instant, pressed: Schema.optionalKey(NOTE) })
/** The row's previous ring, still to be taken away: its notification, when it stops by itself anyway, and when to try again. */
const Withdraw = Schema.Struct({ notification: NOTE, until: Instant, retryAt: Instant })
/**
 * A countdown that may be on a screen: written before it is shown, kept until it is known to be gone (dismissed, replaced by
 * its key and dismissed, or ended by its lifetime at `until`). `shown`: the countdown to `endsAt` is known to be shown;
 * `earlier`: an earlier countdown of the timer may still be on a screen (this one is to replace it).
 */
const Screen = Schema.Struct({ endsAt: Instant, until: Instant, shown: Schema.Boolean, earlier: Schema.Boolean })

/**
 * One timer: household data (no owner, no person). What it is (`state`, its due instant or what it has left) and what is
 * owed for it (a ring to deliver, rings to withdraw, the countdown to match its state) are one row; `nextAt` is the next
 * moment anything happens for it, and one scheduler job (key `timer:<id>`) is planned for that moment in every write.
 * The job, every action, every button and the hourly sweep do the same thing: `reconcile` the row at that moment.
 */
export const Timer = Schema.Struct({
  name: Schema.optionalKey(StoredText(NAME_CHARS)),
  durationMs: Span,
  deviceId: DEVICE,
  room: Schema.optionalKey(StoredText(60)),
  /** `running` (counting down to `dueAt`), `paused` (`leftMs` left), `done` (it came due), `cancelled`. */
  state: Schema.Literals(["running", "paused", "done", "cancelled"]),
  /** `active`: running or paused (it counts toward the limit and is listed); `ended`: done or cancelled. */
  phase: Schema.Literals(["active", "ended"]),
  /** Running again after a snooze: no countdown. */
  snoozed: Schema.optionalKey(Schema.Boolean),
  dueAt: Instant,
  leftMs: Schema.optionalKey(Span),
  /** Occurrences so far: the ring number, part of each ring's notification key. */
  n: Count,
  owed: Schema.optionalKey(Owed),
  ring: Schema.optionalKey(Ring),
  /** At most one: a row never has two notifications of its own open (a new ring is sent only once this is gone). */
  withdraw: Schema.optionalKey(Withdraw),
  screen: Schema.optionalKey(Screen),
  screenTries: Schema.optionalKey(Count),
  screenRetryAt: Schema.optionalKey(Instant),
  /** A countdown that could not be shown after a few tries: not tried again for this instant. */
  screenSkip: Schema.optionalKey(Instant),
  /** Whether anything is still to happen for the row, and when (indexed together: the sweep reads them in order). */
  pending: Schema.Boolean,
  nextAt: Instant,
  endedAt: Instant
})
export type Timer = typeof Timer.Type

export const timers = defineCollection({
  name: "timers",
  scope: "household",
  schema: Timer,
  // The worst legal timer is about 1,750 characters of JSON: one list reads 13 rows.
  maxChars: 1_900,
  indexes: ["phase", ["phase", "endedAt"], ["pending", "nextAt"]],
  // The per-turn household facts (behind the Home setting): the running timers among the most recently changed rows.
  ambient: (rows, { now }) => ambientLine(rows, now),
  ambientRows: 10
})

const PAGE = 12
/** The most active timers one answer reads: the contract's 50, and room for the few a snooze may bring back. */
const SCAN_ACTIVE = 64
/** The most rows with work owed one read takes. */
const SCAN_PENDING = 200
const KEEP_ENDED_MS = 24 * 3_600_000
const MORE_MINUTES = 5
/** How soon a ring the notification service refused is tried again. */
export const RETRY_RING_MS = 30_000
/** How soon a withdrawal or a countdown that failed is tried again. */
export const RETRY_CLEANUP_MS = 60_000
/** Tries to show a countdown before it is left out (the Presenter's bound of 8 per module, a store that keeps failing). */
const SCREEN_TRIES = 3
/** A pinned timer presentation without an expiry ends this long after its instant (docs/PRESENTING.md). */
const SCREEN_GRACE_MS = 10 * 60_000

// ---------------------------------------------------------------------------------------------------------------------
// Words

const displayName = (value: Pick<Timer, "name" | "durationMs">, language: Language): string =>
  value.name !== undefined ? say(texts, language, "named", { name: value.name }) : say(texts, language, "unnamed", { duration: speakDuration(value.durationMs, language) ?? "" })

const leftOf = (value: Timer, now: number): number => (value.state === "paused" ? (value.leftMs ?? 0) : Math.max(0, value.dueAt - now))

type Shown = "active" | "ringing" | "waiting" | "cleanup"

const itemOf = (row: Row<Timer>, shown: Shown, now: number, language: Language): string => {
  const name = displayName(row.value, language)
  const left = speakLeft(leftOf(row.value, now), language)
  if (shown === "ringing") return say(texts, language, "itemRinging", { name })
  if (shown === "waiting") return say(texts, language, "itemWaiting", { name })
  if (shown === "cleanup") return say(texts, language, row.value.withdraw !== undefined ? "itemCleanup" : "itemScreenCleanup", { name })
  if (row.value.state === "paused") return say(texts, language, "itemPaused", { name, left })
  if (row.value.snoozed === true) return say(texts, language, "itemSnoozed", { name, left })
  return say(texts, language, "itemLeft", { name, left })
}

/** The ambient line: at most three running timers among the rows the host read (the most recently changed ones). */
const ambientLine = (rows: ReadonlyArray<Row<Timer>>, now: number): string | undefined => {
  const active = rows.filter((r) => r.value.phase === "active")
  if (active.length === 0) return undefined
  const items = active.slice(0, 3).map((r) => itemOf(r, "active", now, "en"))
  const more = active.length > 3 ? `, and ${active.length - 3} more` : ""
  return say(texts, "en", "ambient", { list: items.join(", "), more })
}

// ---------------------------------------------------------------------------------------------------------------------
// The row's plan: what it wants and when anything happens next

/** The countdown the timer's state asks for: the instant to count down to, or none. */
const wantedScreen = (v: Timer): number | undefined => (v.state === "running" && v.snoozed !== true && v.screenSkip !== v.dueAt ? v.dueAt : undefined)

const screenOwed = (v: Timer): boolean => {
  const want = wantedScreen(v)
  return want !== undefined ? !(v.screen?.endsAt === want && v.screen.shown) : v.screen !== undefined
}

/** The next moment anything happens for the row, or `undefined`: nothing is left to do. */
export const nextAtOf = (v: Timer, now: number): number | undefined => {
  const at: Array<number> = []
  if (v.state === "running") at.push(v.dueAt)
  if (v.owed !== undefined) at.push(v.owed.retryAt)
  if (v.ring !== undefined) at.push(v.ring.until)
  if (v.withdraw !== undefined) at.push(Math.min(v.withdraw.retryAt, v.withdraw.until))
  if (screenOwed(v)) at.push(Math.max(now, v.screenRetryAt ?? now))
  if (v.screen !== undefined && wantedScreen(v) === undefined) at.push(v.screen.until)
  return at.length === 0 ? undefined : Math.max(0, Math.min(...at))
}

/** What is due at `now` without any outside call: an occurrence becomes owed, what ended by itself is let go. */
const advance = (v: Timer, now: number): Timer => {
  let out = v
  if (out.state === "running" && out.dueAt <= now) {
    const { snoozed: _s, ...rest } = out
    out = { ...rest, state: "done", phase: "ended", endedAt: now, n: out.n + 1, owed: { n: out.n + 1, at: out.dueAt, attempts: 0, retryAt: now } }
  }
  if (out.ring !== undefined && out.ring.until <= now) {
    const { ring: _r, ...rest } = out
    out = rest
  }
  if (out.withdraw !== undefined && out.withdraw.until <= now) {
    const { withdraw: _w, ...rest } = out
    out = rest
  }
  if (out.screen !== undefined && out.screen.until <= now) {
    const { screen: _x, ...rest } = out
    out = rest
  }
  return withScreenOwed(out, now)
}

/**
 * The countdown the state wants, recorded as possibly on a screen before it is shown: written in the same step as the
 * change that wants it, so a show whose outcome is not recorded is still known and taken away later (finding 11).
 */
export const withScreenOwed = (v: Timer, now: number): Timer => {
  const want = wantedScreen(v)
  // Not yet when a refused show is to be tried again later: it is recorded in the step that tries it.
  if (want === undefined || v.screen?.endsAt === want || (v.screenRetryAt ?? 0) > now) return v
  return { ...v, screen: { endsAt: want, until: Math.max(v.screen?.until ?? 0, want + SCREEN_GRACE_MS), shown: false, earlier: v.screen !== undefined } }
}

/**
 * The ring that is to be taken away. A row holds at most one: a new ring is sent only once the previous one is gone, so
 * a second one never exists to be dropped (finding 3). Should it ever, the one already owed is kept and `undefined` says so.
 */
const withdrawing = (v: Timer, ring: { readonly notification: string; readonly until: number }, now: number): Timer | undefined =>
  v.withdraw === undefined || v.withdraw.notification === ring.notification ? { ...v, withdraw: { notification: ring.notification, until: ring.until, retryAt: now } } : undefined

/** A value without one optional member. */
const withoutKey = <K extends "ring" | "withdraw" | "owed" | "screen">(v: Timer, key: K): Timer => {
  const { [key]: _x, ...rest } = v
  return rest as Timer
}

// ---------------------------------------------------------------------------------------------------------------------
// The module

const settings = {
  snoozeMinutes: Setting.number({ label: "Snooze for", description: "Minutes a ringing timer waits when someone says snooze.", default: 5, integer: true, min: 1, max: 30, unit: "minutes" }),
  ringMinutes: Setting.number({ label: "Ring for", description: "Minutes a timer rings before it stops by itself.", default: 15, integer: true, min: 1, max: 120, unit: "minutes" })
}

type Target =
  | { readonly kind: "one"; readonly row: Row<Timer>; readonly shown: Shown }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "ask"; readonly say: string }

const fail = (message: string) => new ActionError({ message })

/** The shared part's operations (`ctx.shared`): every read and change of a timer goes through them, one at a time. */
export interface TimersOps {
  readonly start: (input: { readonly durationMs: number; readonly name?: string | undefined }) => Effect.Effect<string, ActionError>
  readonly list: (name: string | undefined) => Effect.Effect<string, ActionError>
  readonly adjust: (name: string | undefined, deltaMs: number) => Effect.Effect<string, ActionError>
  readonly pause: (name: string | undefined) => Effect.Effect<string, ActionError>
  readonly resume: (name: string | undefined) => Effect.Effect<string, ActionError>
  readonly cancel: (name: string | undefined, all: boolean) => Effect.Effect<string, ActionError>
}

export const timersModule = defineModule({
  apiVersion: 2,
  id: "timers",
  name: "Timers",
  description: "Named countdown timers that ring on the device that set them.",
  enabledByDefault: false,
  settings,
  storage: { version: 1, collections: [timers] },
  shared: (ctx) =>
    Effect.gen(function*() {
      const store = ctx.store.collection(timers)
      // One change at a time (an action, a button, the job, the sweep, the service); each reads its row again inside.
      const lock = yield* Semaphore.make(1)
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect)
      // The countdowns this part showed, by timer id, kept until their dismissal succeeded.
      const countdowns = new Map<string, PresentHandle>()
      const language = (): Language => homeLanguage(ctx.host.view())
      const snoozeMs = () => (ctx.settings.snoozeMinutes ?? 5) * 60_000
      const ringMs = () => (ctx.settings.ringMinutes ?? 15) * 60_000
      const unreadable = () => fail(say(texts, language(), "unreadable"))
      const failure = (e: unknown) => fail(say(texts, language(), isBusy(e) ? "busy" : "failed"))

      /** The actor of a write made now: the given one (a button's device), else the job's, else the turn's (the store's default). */
      const actorNow = (given?: Actor) =>
        Effect.map(CurrentJob, (job): { readonly actor?: Actor } => (given !== undefined ? { actor: given } : job !== undefined ? { actor: { kind: "job", jobId: job.jobId } } : {}))

      // -- writing: the one place a row and its job are written --------------------------------------------------------

      /**
       * Write timers' new values with their plans: `pending`/`nextAt` from each value, and each row's one job (key
       * `timer:<id>`) for its `nextAt`, all in one transaction. A row with nothing left to do has its job cancelled after
       * the commit (a job left over finds nothing to do).
       */
      const commitAll = (entries: ReadonlyArray<{ readonly row: Row<Timer> | undefined; readonly id: string; readonly value: Timer }>, actor?: Actor, extra: ReadonlyArray<PreparedJob> = []) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const prepared: Array<{ readonly row: Row<Timer> | undefined; readonly id: string; readonly planned: Timer; readonly job: PreparedJob | undefined }> = []
          for (const e of entries) {
            const next = nextAtOf(e.value, now)
            const job = next === undefined ? undefined : yield* ctx.scheduler.prepare({ handler: "due", key: `timer:${e.id}`, payload: { id: e.id }, at: next, origin: { deviceId: e.value.deviceId } })
            prepared.push({ row: e.row, id: e.id, planned: { ...e.value, pending: next !== undefined, nextAt: next ?? 0 }, job })
          }
          const options = yield* actorNow(actor)
          const written = yield* ctx.store.transaction((tx) => {
            const c = tx.collection(timers)
            const rows = prepared.map((p) => {
              const out = p.row === undefined ? c.insert(p.planned, { id: p.id, ...options }) : c.update(p.id, () => p.planned, { expectRev: p.row.rev, ...options })
              p.job?.writeIn(tx)
              return out
            })
            // A job that goes with these writes (the Health report of a missed ring): both or neither.
            for (const j of extra) j.writeIn(tx)
            return rows
          })
          for (const p of prepared) if (p.job === undefined && p.row?.value.pending === true) yield* Effect.ignore(ctx.scheduler.cancel({ key: `timer:${p.id}` }))
          return written
        })

      const commit = (row: Row<Timer> | undefined, id: string, value: Timer, actor?: Actor, extra: ReadonlyArray<PreparedJob> = []) =>
        Effect.map(commitAll([{ row, id, value }], actor, extra), (rows) => rows[0]!)

      // -- what screens show -----------------------------------------------------------------------------------------------

      const targetOf = (value: Timer) => (value.room !== undefined ? { room: value.room } : { device: value.deviceId })

      /** Show (or replace, by its key) the countdown; the handle is kept until its dismissal succeeded. */
      const showCountdown = (id: string, value: Timer, endsAt: number) =>
        Effect.gen(function*() {
          const lang = language()
          const now = yield* Clock.currentTimeMillis
          const name = capitalise(displayName(value, lang))
          const handle = yield* ctx.present.show(
            targetOf(value),
            { kind: "timer", label: cut(name, 40), endsAt, spoken: say(texts, lang, "spoken", { Name: name, left: speakLeft(Math.max(1_000, endsAt - now), lang) }) },
            { lifetime: "pinned", key: `timer:${id}` }
          )
          countdowns.set(id, handle)
        })

      /**
       * Take the countdown down: by the handle this part holds, or, after a restart (no handle), by replacing its key with
       * a countdown ending now and dismissing that. A handle whose show was replaced or ended answers `false`: nothing of it
       * is on screen any more either.
       */
      const dismissCountdown = (id: string, value: Timer) =>
        Effect.gen(function*() {
          const held = countdowns.get(id)
          if (held !== undefined) {
            yield* held.dismiss
            countdowns.delete(id)
            return
          }
          const now = yield* Clock.currentTimeMillis
          const name = capitalise(displayName(value, language()))
          const replaced = yield* ctx.present.show(targetOf(value), { kind: "timer", label: cut(name, 40), endsAt: now, spoken: name }, { lifetime: "pinned", key: `timer:${id}` })
          countdowns.set(id, replaced)
          yield* replaced.dismiss
          countdowns.delete(id)
        })

      // -- reconcile: the one function -------------------------------------------------------------------------------------

      /**
       * Send the owed ring. First the row's previous ring is resolved: a row never has two of its own open (finding 5); while
       * that fails the new ring stays owed and is tried again. When its whole ring time has passed it is given up, and the
       * job that reports it on the Health page is written in the same transaction that gives it up (finding 12): when that
       * job cannot be prepared, it is not given up.
       */
      const deliver = (id: string, v: Timer, now: number): Effect.Effect<{ readonly value: Timer; readonly jobs: ReadonlyArray<PreparedJob> }> =>
        Effect.gen(function*() {
          const owed = v.owed!
          const later = (x: Timer) => ({ value: { ...x, owed: { ...owed, attempts: owed.attempts + 1, retryAt: now + RETRY_RING_MS } }, jobs: [] })
          if (now - owed.at >= ringMs()) {
            const report = yield* Effect.result(ctx.scheduler.prepare({
              handler: "trouble",
              key: `trouble:${id}:${owed.n}`,
              inMs: 0,
              payload: { message: `A timer could not ring within its delivery window (${cut(displayName(v, "en"), 80)}).` }
            }))
            if (report._tag === "Failure") return later(v)
            const { owed: _o, ...rest } = v
            return { value: rest, jobs: [report.success] }
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
          const lang = language()
          const name = displayName(out, lang)
          const duration = speakDuration(out.durationMs, lang) ?? ""
          const late = now - owed.at
          const sent = yield* Effect.result(ctx.notify.send({
            title: out.name !== undefined ? say(texts, lang, "title", { Name: cut(capitalise(name), 40) }) : say(texts, lang, "titlePlain"),
            text: late >= 60_000 ? say(texts, lang, "ringTextLate", { duration, late: speakLeft(late, lang) }) : say(texts, lang, "ringText", { duration }),
            priority: "ring",
            key: `timer:${id}:${owed.n}`,
            expiresInMs: ringMs(),
            actions: [{ id: "snooze", label: say(texts, lang, "snooze") }, { id: "more", label: say(texts, lang, "more") }],
            handler: "timer",
            target: "origin"
          }))
          if (sent._tag === "Failure") return later(out)
          const { owed: _o, ...rest } = out
          return { value: { ...rest, ring: { n: owed.n, notification: sent.success.notification.id, at: now, until: sent.success.notification.expiresAt } }, jobs: [] }
        })

      /** Take away the row's previous ring (a failure is tried again a minute later, until the ring stops by itself). */
      const withdrawRings = (v: Timer, now: number, force = false): Effect.Effect<Timer> =>
        Effect.gen(function*() {
          const w = v.withdraw
          if (w === undefined || (w.retryAt > now && !force)) return v
          const done = yield* Effect.result(ctx.notify.resolve(w.notification))
          return done._tag === "Failure" ? { ...v, withdraw: { ...w, retryAt: now + RETRY_CLEANUP_MS } } : withoutKey(v, "withdraw")
        })

      /** Make the screen match the state: show or replace the countdown, or take it down. */
      const syncScreen = (id: string, v: Timer, now: number, force = false): Effect.Effect<Timer> =>
        Effect.gen(function*() {
          if (!screenOwed(v) || ((v.screenRetryAt ?? 0) > now && !force)) return v
          const want = wantedScreen(v)
          const { screenTries: _t, screenRetryAt: _r, ...base } = v
          const tries = (v.screenTries ?? 0) + 1
          if (want !== undefined) {
            // Recorded as possibly shown before this call (`withScreenOwed`, written in an earlier step); now known shown.
            if (v.screen?.endsAt !== want) return v
            const shown = yield* Effect.result(showCountdown(id, v, want))
            if (shown._tag === "Success") return { ...base, screen: { ...v.screen, shown: true, earlier: false } }
            // Refused: nothing new was shown. With no earlier countdown, nothing of it is on a screen (the record goes); an
            // earlier one stays recorded, to be replaced or taken down. After a few tries the timer runs and rings without it.
            const unshown = v.screen.earlier ? base : withoutKey(base, "screen")
            if (tries >= SCREEN_TRIES) return { ...unshown, screenSkip: want }
            return { ...unshown, screenTries: tries, screenRetryAt: now + RETRY_CLEANUP_MS }
          }
          const gone = yield* Effect.result(dismissCountdown(id, v))
          if (gone._tag === "Success") {
            const { screen: _x, ...rest } = base
            return rest
          }
          return { ...base, screenTries: tries, screenRetryAt: now + RETRY_CLEANUP_MS }
        })

      /**
       * Do what is owed for one timer at this moment, and plan what comes next. Inside the lock. First what is due without
       * an outside call (an occurrence becomes an owed ring) is written, so the owed work is recorded before it is tried;
       * then the ring is sent, old rings withdrawn and the countdown matched, and the outcome written with the next plan.
       * Fails only when the store does (the job is then run again).
       */
      const reconcile = (id: string, actor?: Actor, force = false, own = false) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          let row = yield* store.get(id)
          if (row === undefined) return undefined
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
          v = yield* syncScreen(id, v, now, force)
          if (v !== row.value || jobs.length > 0 || nextAtOf(v, now) !== (row.value.pending ? row.value.nextAt : undefined)) row = yield* commit(row, id, v, actor, jobs)
          return row
        })

      // -- reading ---------------------------------------------------------------------------------------------------------

      const readActive = scan<Timer>((q) => store.list({ where: { phase: "active" }, orderBy: { field: "createdAt", direction: "asc" }, ...q }), PAGE, SCAN_ACTIVE)
      const readPending = scan<Timer>((q) => store.list({ where: { pending: true }, orderBy: { field: "nextAt", direction: "asc" }, ...q }), PAGE, SCAN_PENDING)

      /**
       * Timers that came due: ringing now (their ring's notification is open), or with their ring owed and not sent yet; and
       * timers that ended but still owe clean-up (a ring or a countdown to take away), which only a cancel looks at.
       */
      const readRinging = Effect.gen(function*() {
        const notifications = yield* ctx.notify.list()
        const open = new Set(notifications.map((n) => n.id))
        const pending = yield* readPending
        const ringing: Array<Row<Timer>> = []
        const waiting: Array<Row<Timer>> = []
        const cleanup: Array<Row<Timer>> = []
        for (const row of pending.rows) {
          if (row.value.phase !== "ended") continue
          if (row.value.state === "done" && row.value.owed !== undefined) waiting.push(row)
          else if (row.value.state === "done" && row.value.ring !== undefined && open.has(row.value.ring.notification)) ringing.push(row)
          else if (row.value.withdraw !== undefined || row.value.screen !== undefined) cleanup.push(row)
        }
        return { ringing, waiting, cleanup, notifications, cut: pending.cut }
      })

      const readAll = Effect.gen(function*() {
        const active = yield* readActive
        const r = yield* readRinging
        return { active: active.rows, ringing: r.ringing, waiting: r.waiting, cleanup: r.cleanup, notifications: r.notifications, cut: active.cut || r.cut }
      })

      /** What a request can mean: listed timers; for a cancel, also timers that still owe clean-up (finding 9). */
      const candidatesOf = (
        all: { readonly active: ReadonlyArray<Row<Timer>>; readonly ringing: ReadonlyArray<Row<Timer>>; readonly waiting: ReadonlyArray<Row<Timer>>; readonly cleanup: ReadonlyArray<Row<Timer>> },
        now: number,
        forCancel = false
      ) => [
        ...all.ringing.map((row) => ({ row, shown: "ringing" as Shown })),
        ...all.waiting.map((row) => ({ row, shown: "waiting" as Shown })),
        ...[...all.active].sort((x, y) => leftOf(x.value, now) - leftOf(y.value, now)).map((row) => ({ row, shown: "active" as Shown })),
        ...(forCancel ? all.cleanup.map((row) => ({ row, shown: "cleanup" as Shown })) : [])
      ]

      /** Which timer `name` means: by name; with no name, the only one; otherwise a question. Never the first of several. */
      const resolve = (name: string | undefined, now: number, forCancel = false): Effect.Effect<Target, ActionError> =>
        Effect.gen(function*() {
          const lang = language()
          const all = yield* readAll.pipe(Effect.mapError(unreadable))
          const candidates = candidatesOf(all, now, forCancel)
          const key = name === undefined ? undefined : nameKey(name)
          const matches = key === undefined ? candidates : candidates.filter((c) => c.row.value.name !== undefined && nameKey(c.row.value.name) === key)
          if (matches.length === 1) return { kind: "one", row: matches[0]!.row, shown: matches[0]!.shown }
          if (matches.length === 0) {
            if (key !== undefined) return { kind: "unknown", name: name! }
            if (all.cut) return yield* Effect.fail(unreadable())
            return { kind: "none" }
          }
          const list = listOf(matches.map((c) => itemOf(c.row, c.shown, now, lang)), lang)
          return { kind: "ask", say: say(texts, lang, key === undefined && all.cut ? "whichCut" : "which", { count: matches.length, list }) }
        })

      const notOne = (t: Exclude<Target, { kind: "one" }>): string => {
        const lang = language()
        switch (t.kind) {
          case "none":
            return say(texts, lang, "none")
          case "unknown":
            return say(texts, lang, "unknown", { name: cut(t.name, NAME_CHARS) })
          case "ask":
            return t.say
        }
      }

      const oneAnswer = (row: Row<Timer>, shown: Shown, now: number, lang: Language): string => {
        const Name = capitalise(displayName(row.value, lang))
        const left = speakLeft(leftOf(row.value, now), lang)
        if (shown === "ringing") return say(texts, lang, "oneRinging", { Name })
        if (shown === "waiting") return say(texts, lang, "oneWaiting", { Name })
        if (row.value.state === "paused") return say(texts, lang, "onePaused", { Name, left })
        if (row.value.snoozed === true) return say(texts, lang, "oneSnoozed", { Name, left })
        return say(texts, lang, "oneLeft", { Name, left })
      }

      /** Whether a ring of the row is still to be withdrawn, and whether its countdown is still to come down. */
      const leftovers = (row: Row<Timer> | undefined) => ({
        ring: row !== undefined && row.value.withdraw !== undefined,
        screen: row !== undefined && wantedScreen(row.value) === undefined && row.value.screen !== undefined
      })

      // -- changing ------------------------------------------------------------------------------------------------------

      const callDevice = Effect.gen(function*() {
        const turn = yield* CurrentTurn
        if (turn?.deviceId !== undefined) return { deviceId: turn.deviceId, room: turn.room }
        const job = yield* CurrentJob
        return job?.deviceId !== undefined ? { deviceId: job.deviceId, room: undefined } : undefined
      })

      type StartOutcome =
        | { readonly kind: "started"; readonly id: string; readonly value: Timer }
        | { readonly kind: "duplicate"; readonly row: Row<Timer> }
        | { readonly kind: "limit" }

      /** Start a timer: its row and its job in one transaction, then its countdown by reconciling it. */
      const startTimer = (input: { readonly durationMs: number; readonly name?: string | undefined; readonly deviceId: string; readonly room?: string | undefined }) =>
        locked(Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const active = yield* readActive
          if (active.cut || active.rows.length >= TIMERS_LIMITS.running) return { kind: "limit" } satisfies StartOutcome as StartOutcome
          if (input.name !== undefined) {
            const key = nameKey(input.name)
            const same = active.rows.find((r) => r.value.name !== undefined && nameKey(r.value.name) === key)
            if (same !== undefined) return { kind: "duplicate", row: same } satisfies StartOutcome as StartOutcome
          }
          const id = randomUUID()
          const room = input.room !== undefined && input.room.length <= 60 && input.room.trim() !== "" ? input.room : undefined
          const value: Timer = withScreenOwed({
            ...(input.name !== undefined ? { name: input.name } : {}),
            durationMs: input.durationMs,
            deviceId: input.deviceId,
            ...(room !== undefined ? { room } : {}),
            state: "running",
            phase: "active",
            dueAt: now + input.durationMs,
            n: 0,
            pending: true,
            nextAt: now,
            endedAt: 0
          }, now)
          const row = yield* commit(undefined, id, value)
          // Committed: the timer is started (finding 10). Its countdown is owed work of the row (written above, before it is
          // shown): shown now, or by the row's job when this fails; a failure here never turns the start into an error.
          const done = yield* reconcile(id).pipe(Effect.catch(() => Effect.succeed(undefined)))
          return { kind: "started", id, value: (done ?? row).value } satisfies StartOutcome as StartOutcome
        }))

      /** A change of a timer, then everything owed after it done at once. Inside the lock. */
      const change = (row: Row<Timer>, value: Timer, actor?: Actor) => Effect.flatMap(commit(row, row.id, value, actor), (committed) =>
        reconcile(row.id, actor, true).pipe(Effect.catch(() => Effect.succeed(committed))))

      /**
       * Let go of the row's current occurrence (finding 2): the one way cancel, more time, pause and a button's follow-up
       * leave it. Its recorded ring becomes the ring to take away; an owed ring whose send may have succeeded before its
       * record failed is looked for among the open notifications by its occurrence's key and becomes the ring to take away;
       * only then is the owed delivery forgotten. Fails (and nothing is changed) when the open notifications cannot be read.
       */
      const letGo = (id: string, v: Timer, now: number, keepRing = false, snapshot?: ReadonlyArray<{ readonly id: string; readonly key?: string; readonly expiresAt: number }>) =>
        Effect.gen(function*() {
          const notifications = snapshot ?? (yield* ctx.notify.list())
          const open = new Set(notifications.map((n) => n.id))
          let out = v.withdraw !== undefined && !open.has(v.withdraw.notification) ? withoutKey(v, "withdraw") : v
          if (out.ring !== undefined && !open.has(out.ring.notification) && !keepRing) out = withoutKey(out, "ring")
          if (out.ring !== undefined && !keepRing) out = withdrawing(withoutKey(out, "ring"), out.ring, now) ?? out
          if (out.owed !== undefined) {
            const key = `timer:${id}:${out.owed.n}`
            const sent = notifications.find((n) => n.key === key)
            if (sent !== undefined) {
              const taken = withdrawing(out, { notification: sent.id, until: sent.expiresAt }, now)
              if (taken === undefined) return yield* Effect.fail(new Error("a second ring to take away"))
              out = taken
            }
            out = withoutKey(out, "owed")
          }
          return out
        })

      /**
       * A timer that came due given more time (`ms`): it runs again. Its occurrence is let go; a button's own follow-up
       * keeps its ring (the notification service resolves it with the press), to be resolved before the next ring is sent.
       */
      const rearmed = (id: string, v: Timer, now: number, ms: number, options: { readonly snoozed: boolean; readonly pressed?: string }) =>
        Effect.gen(function*() {
          const keep = options.pressed !== undefined && v.ring !== undefined
          const left = yield* letGo(id, v, now, keep)
          const { leftMs: _l, snoozed: _s, screenSkip: _k, ...rest } = left
          const base: Timer = keep && rest.ring !== undefined ? { ...rest, ring: { ...rest.ring, pressed: options.pressed! } } : rest
          return withScreenOwed({ ...base, state: "running", phase: "active", dueAt: now + ms, endedAt: 0, ...(options.snoozed ? { snoozed: true } : {}) }, now)
        })

      /** The timer cancelled: nothing more rings; its occurrence is let go. */
      const cancelled = (row: Row<Timer>, now: number, snapshot?: ReadonlyArray<{ readonly id: string; readonly key?: string; readonly expiresAt: number }>) =>
        Effect.map(letGo(row.id, row.value, now, false, snapshot), (v) => {
          const { snoozed: _s, ...rest } = v
          return { ...rest, state: "cancelled" as const, phase: "ended" as const, endedAt: row.value.phase === "ended" ? row.value.endedAt : now }
        })

      const ops: TimersOps = {
        start: ({ durationMs, name }) =>
          Effect.gen(function*() {
            const lang = language()
            const clean = cleanName(name)
            if (clean === false) return yield* Effect.fail(fail(say(texts, lang, "badName")))
            if (!Number.isInteger(durationMs) || durationMs < TIMERS_LIMITS.minMs || durationMs > TIMERS_LIMITS.maxMs) return yield* Effect.fail(fail(say(texts, lang, "tooLong")))
            const device = yield* callDevice
            if (device === undefined) return yield* Effect.fail(fail(say(texts, lang, "noDevice")))
            const outcome = yield* startTimer({ durationMs, name: clean, deviceId: device.deviceId, room: device.room }).pipe(Effect.mapError(failure))
            const now = yield* Clock.currentTimeMillis
            switch (outcome.kind) {
              case "limit":
                return yield* Effect.fail(fail(say(texts, lang, "full", { count: TIMERS_LIMITS.running })))
              case "duplicate":
                return say(texts, lang, "duplicate", { name: outcome.row.value.name ?? "", left: speakLeft(leftOf(outcome.row.value, now), lang) })
              case "started":
                return clean === undefined
                  ? say(texts, lang, "startedPlain", { duration: speakDuration(durationMs, lang) ?? "" })
                  : say(texts, lang, "started", { Name: capitalise(displayName(outcome.value, lang)), duration: speakDuration(durationMs, lang) ?? "" })
            }
          }),

        list: (name) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            if (name !== undefined) {
              const t = yield* resolve(name, now)
              return t.kind === "one" ? oneAnswer(t.row, t.shown, now, lang) : notOne(t)
            }
            const all = yield* readAll.pipe(Effect.mapError(unreadable))
            const items = candidatesOf(all, now)
            if (items.length === 0) return all.cut ? yield* Effect.fail(unreadable()) : say(texts, lang, "none")
            if (items.length === 1 && !all.cut) return oneAnswer(items[0]!.row, items[0]!.shown, now, lang)
            const list = listOf(items.map((i) => itemOf(i.row, i.shown, now, lang)), lang)
            return say(texts, lang, all.cut ? "severalCut" : "several", { count: items.length, list })
          })),

        adjust: (name, deltaMs) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const t = yield* resolve(name, now)
            if (t.kind !== "one") return notOne(t)
            const row = t.row
            const Name = capitalise(displayName(row.value, lang))
            if (t.shown !== "active") {
              // A timer that came due given more time runs again for that long; its ring is withdrawn.
              if (deltaMs <= 0) return say(texts, lang, "notPausedRinging", { Name })
              const active = yield* readActive.pipe(Effect.mapError(failure))
              if (active.cut || active.rows.length >= TIMERS_LIMITS.running) return yield* Effect.fail(fail(say(texts, lang, "full", { count: TIMERS_LIMITS.running })))
              const after = yield* Effect.flatMap(rearmed(row.id, row.value, now, deltaMs, { snoozed: false }), (value) => change(row, value)).pipe(Effect.mapError(failure))
              return say(texts, lang, leftovers(after).ring ? "restartedPending" : "restarted", { Name, left: speakLeft(deltaMs, lang) })
            }
            const left = leftOf(row.value, now) + deltaMs
            if (left < 1_000) return say(texts, lang, "wouldEnd", { name: displayName(row.value, lang), left: speakLeft(leftOf(row.value, now), lang) })
            if (left > TIMERS_LIMITS.maxMs) return yield* Effect.fail(fail(say(texts, lang, "tooLong")))
            if (row.value.state === "paused") {
              yield* change(row, { ...row.value, leftMs: left }).pipe(Effect.mapError(failure))
              return say(texts, lang, "adjustedPaused", { Name, left: speakLeft(left, lang) })
            }
            const { screenSkip: _k, ...rest } = row.value
            yield* change(row, { ...rest, dueAt: now + left }).pipe(Effect.mapError(failure))
            return say(texts, lang, "adjusted", { Name, left: speakLeft(left, lang) })
          })),

        pause: (name) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const t = yield* resolve(name, now)
            if (t.kind !== "one") return notOne(t)
            const row = t.row
            const Name = capitalise(displayName(row.value, lang))
            if (t.shown !== "active") return say(texts, lang, t.shown === "waiting" ? "oneWaiting" : "notPausedRinging", { Name })
            if (row.value.state === "paused") {
              // Already paused: what is still owed for it (a countdown to take down) is done now.
              const after = yield* reconcile(row.id, undefined, true).pipe(Effect.mapError(failure))
              const left = speakLeft(leftOf(row.value, now), lang)
              return say(texts, lang, leftovers(after).screen ? "pausedScreenPending" : "alreadyPaused", { Name, left })
            }
            const left = Math.max(1_000, row.value.dueAt - now)
            const after = yield* Effect.flatMap(letGo(row.id, row.value, now), (v) => {
              const { snoozed: _s, ...rest } = v
              return change(row, { ...rest, state: "paused", leftMs: left })
            }).pipe(Effect.mapError(failure))
            return say(texts, lang, leftovers(after).screen ? "pausedScreenPending" : "paused", { Name, left: speakLeft(left, lang) })
          })),

        resume: (name) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const t = yield* resolve(name, now)
            if (t.kind !== "one") return notOne(t)
            const row = t.row
            const Name = capitalise(displayName(row.value, lang))
            if (t.shown !== "active") return say(texts, lang, t.shown === "waiting" ? "oneWaiting" : "notPausedRinging", { Name })
            if (row.value.state !== "paused") return say(texts, lang, "notPaused", { Name, left: speakLeft(leftOf(row.value, now), lang) })
            const left = row.value.leftMs ?? 1_000
            const { leftMs: _l, screenSkip: _k, ...rest } = row.value
            yield* change(row, { ...rest, state: "running", dueAt: now + left }).pipe(Effect.mapError(failure))
            return say(texts, lang, "resumed", { Name, left: speakLeft(left, lang) })
          })),

        cancel: (name, all) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            if (all) {
              const read = yield* readAll.pipe(Effect.mapError(unreadable))
              // Timers still owing clean-up are cancelled again too: their clean-up is tried now (finding 9).
              const rows = [...read.active, ...read.ringing, ...read.waiting, ...read.cleanup]
              if (rows.length === 0) return say(texts, lang, "cancelledNone")
              // Every row in one transaction (all or none), then what is owed for each done.
              const values: Array<{ readonly row: Row<Timer>; readonly id: string; readonly value: Timer }> = []
              for (const row of rows) values.push({ row, id: row.id, value: yield* cancelled(row, now, read.notifications).pipe(Effect.mapError(failure)) })
              yield* commitAll(values).pipe(Effect.mapError(failure))
              let pending = false
              for (const row of rows) {
                const after = yield* reconcile(row.id, undefined, true).pipe(Effect.mapError(failure))
                const l = leftovers(after)
                pending ||= l.ring || l.screen
              }
              if (pending) return say(texts, lang, "cancelledAllPending", { count: rows.length })
              return say(texts, lang, read.cut ? "cancelledAllCut" : "cancelledAll", { count: rows.length })
            }
            // A timer that is cancelled but still owes clean-up is a candidate too: cancelling it again finishes it.
            const t = yield* resolve(name, now, true)
            if (t.kind !== "one") return notOne(t)
            const row = t.row
            const Name = capitalise(displayName(row.value, lang))
            const after = yield* Effect.flatMap(cancelled(row, now), (value) => change(row, value)).pipe(Effect.mapError(failure))
            const l = leftovers(after)
            if (t.shown === "cleanup") return say(texts, lang, l.ring ? "stoppedPending" : l.screen ? "screenPending" : "finished", { Name })
            if (l.ring) return say(texts, lang, "ringPending", { Name })
            if (l.screen) return say(texts, lang, "screenPending", { Name })
            return say(texts, lang, t.shown === "active" ? "cancelled" : "cancelledRinging", { Name })
          }))
      }

      // -- jobs ----------------------------------------------------------------------------------------------------------

      // The row's one job: it reconciles the row at `nextAt`. Idempotent by construction (it does what the row owes now);
      // it fails only when the store does, and is then run again; the hourly sweep plans it again if it was lost.
      yield* ctx.scheduler.handle("due", {
        payload: Schema.Struct({ id: StoredText(64) }),
        idempotent: true,
        retries: 5,
        timeoutMs: 15_000,
        run: ({ id }) => Effect.asVoid(locked(reconcile(id, undefined, false, true)))
      }).pipe(Effect.orDie)

      // The hourly sweep (and once at start): reconciles every row with something overdue, plans the job of every row with
      // something to come that has none (a job that failed for good, a lost plan), and removes timers that ended over a
      // day ago with nothing owed, a page per transaction with a yield between.
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
              const live = yield* ctx.scheduler.list({ key: `timer:${row.id}` })
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
                  for (const r of old) tx.collection(timers).remove(r.id, { expectRev: r.rev, ...(job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {}) })
                }))
              }
              if (rows.length < PAGE || rows.some((r) => r.value.endedAt >= cutoff)) return
              yield* Effect.yieldNow
            }
          })
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "sweep", key: "sweep", cron: "17 * * * *" }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "sweep", key: "sweep-start", inMs: 0 }).pipe(Effect.orDie)

      // A ring that could not be delivered in its whole ring time: this job fails on purpose, so the Health page says so.
      yield* ctx.scheduler.handle("trouble", {
        payload: Schema.Struct({ message: StoredText(300) }),
        retries: 0,
        run: ({ message }) => Effect.fail(new Error(message))
      }).pipe(Effect.orDie)

      // -- the ringing card's buttons --------------------------------------------------------------------------------------

      // Snooze and "Five more minutes", beside the host's stop. They act on the row's ring of this notification only: a
      // press of any other notification (an older ring, one not recorded yet) is answered that the ring has ended and
      // changes nothing. Idempotent by notification id (`ring.pressed`).
      yield* ctx.notify.handle("timer", {
        run: (press) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const actor: Actor = { kind: "ui", deviceId: press.deviceId }
            const id = press.key?.match(/^timer:(.+):\d+$/)?.[1]
            const row = id === undefined ? undefined : yield* store.get(id)
            if (row === undefined || row.value.ring?.notification !== press.notificationId) return { say: say(texts, lang, "ringEnded") }
            const Name = capitalise(displayName(row.value, lang))
            const snooze = press.actionId === "snooze"
            const now = yield* Clock.currentTimeMillis
            const answer = (v: Timer) => (snooze ? say(texts, lang, "snoozed", { Name, left: speakLeft(leftOf(v, now), lang) }) : say(texts, lang, "moreDone", { Name }))
            if (row.value.ring.pressed === press.notificationId) {
              if (row.value.phase !== "active") return { say: say(texts, lang, "ringEnded") }
              const left = leftOf(row.value, now)
              return { say: !snooze && left === MORE_MINUTES * 60_000 ? say(texts, lang, "moreDone", { Name }) : say(texts, lang, "snoozed", { Name, left: speakLeft(left, lang) }) }
            }
            const active = yield* readActive
            if (active.cut || active.rows.length >= TIMERS_LIMITS.running) return { say: say(texts, lang, "full", { count: TIMERS_LIMITS.running }), keepOpen: true }
            const duplicate = row.value.name === undefined ? undefined : active.rows.find((r) => r.id !== row.id && r.value.name !== undefined && nameKey(r.value.name) === nameKey(row.value.name!))
            if (duplicate !== undefined) return { say: say(texts, lang, "duplicate", { name: duplicate.value.name!, left: speakLeft(leftOf(duplicate.value, now), lang) }), keepOpen: true }
            const after = yield* Effect.flatMap(
              rearmed(row.id, row.value, now, snooze ? snoozeMs() : MORE_MINUTES * 60_000, { snoozed: snooze, pressed: press.notificationId }),
              (value) => change(row, value, actor)
            )
            // When Stop is pressed for this ring at the same moment, the card follows whichever the notification service
            // recorded first, and the timer may still ring again once; saying stop or cancel again ends it (the pages say so).
            return { say: answer(after?.value ?? row.value) }
          })).pipe(Effect.catch((e) => Effect.succeed({ say: say(texts, language(), isBusy(e) ? "busy" : "failed"), keepOpen: true })))
      }).pipe(Effect.orDie)

      // -- the service ---------------------------------------------------------------------------------------------------

      const service: TimersService = {
        start: (request) =>
          Effect.gen(function*() {
            const invalid = (detail: string) => new TimersError({ reason: "invalid", detail })
            if (typeof request !== "object" || request === null) return yield* Effect.fail(invalid("not a request"))
            const { durationMs, label, ringOn } = request
            if (!Number.isInteger(durationMs) || durationMs < TIMERS_LIMITS.minMs || durationMs > TIMERS_LIMITS.maxMs) return yield* Effect.fail(invalid("durationMs out of bounds"))
            // One line as given (a line break is not collapsed away here: the contract refuses it), 1 to 60 characters.
            if (label !== undefined && (!isLine(label, TIMERS_LIMITS.labelChars) || label.trim() === "")) return yield* Effect.fail(invalid("label is not one line of 1 to 60 characters"))
            if (ringOn !== undefined && (typeof ringOn !== "object" || ringOn === null || typeof ringOn.deviceId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(ringOn.deviceId))) {
              return yield* Effect.fail(invalid("ringOn.deviceId is not a device id"))
            }
            const call = yield* callDevice
            const deviceId = ringOn?.deviceId ?? call?.deviceId
            if (deviceId === undefined) return yield* Effect.fail(new TimersError({ reason: "no_device", detail: "no device in the call and none given" }))
            const known = ctx.host.service(Devices)?.get(deviceId)
            if (known === undefined) return yield* Effect.fail(new TimersError({ reason: "unknown_device", detail: "the server does not know that device" }))
            const name = cleanName(label)
            const outcome = yield* startTimer({ durationMs, name: name === false ? undefined : name, deviceId, room: known.room }).pipe(
              Effect.mapError((e) => new TimersError({ reason: isBusy(e) ? "busy" : "failed", detail: e instanceof Error ? e.message : "the store failed" }))
            )
            if (outcome.kind === "limit") return yield* Effect.fail(new TimersError({ reason: "limit", detail: `${TIMERS_LIMITS.running} running timers` }))
            // A second timer of a label that runs already: refused as outside the bounds, since names must tell timers apart.
            if (outcome.kind === "duplicate") return yield* Effect.fail(invalid("a running timer has that label already"))
            const info: TimerInfo = { id: outcome.id, label: outcome.value.name ?? "timer", durationMs, dueAt: outcome.value.dueAt, ringOn: { deviceId } }
            return info
          })
      }

      return { value: ops, services: [Timers.of(service)] }
    }),
  start: (ctx) =>
    Effect.succeed({
      instructions:
        "A bare duration (\"ten minutes\") is a timer: use timers_start. A task said with a time is a reminder, not a timer. Timers are the household's: any device may ask about them.",
      actions: [
        defineAction({
          id: "start",
          label: "Start a timer",
          description: "Start a countdown timer of a duration, optionally with a name (\"pasta\"). It rings on this device; its countdown shows on the screens of this room.",
          examples: ["set a timer for ten minutes", "set a pasta timer for 8 minutes", "zet een timer op tien minuten", "zet een eieren timer op zes minuten"],
          params: {
            duration: Param.duration({ label: "Duration", minMs: TIMERS_LIMITS.minMs, maxMs: TIMERS_LIMITS.maxMs }),
            name: Param.text({ label: "Name", after: ["called", "named", "genaamd"], optional: true, maxWords: 3 })
          },
          phrases: {
            en: ["set a timer for {duration}", "set a {name} timer for {duration}", "start a timer for {duration}", "timer for {duration}", "set the timer for {duration}"],
            nl: ["zet een timer op {duration}", "zet een timer van {duration}", "zet een timer voor {duration}", "timer van {duration}", "timer op {duration}", "zet een {name} timer op {duration}"]
          },
          risk: "change",
          run: ({ duration, name }) => Effect.map(ctx.shared.start({ durationMs: duration, name }), (s) => ({ say: s }))
        }),
        defineAction({
          id: "list",
          label: "How long is left",
          description: "Say which timers run and how long each has left, or how long one named timer has left.",
          examples: ["how long is left on the pasta", "how much time is left", "hoe lang duurt de timer nog"],
          params: { name: Param.text({ label: "Name", after: ["on", "of", "van"], optional: true, maxWords: 3 }) },
          phrases: {
            en: ["how long is left", "how much time is left", "how long is left on the timer", "how long is left on the {name}", "how long is left on the {name} timer"],
            nl: ["hoe lang nog", "hoeveel tijd is er nog", "hoe lang duurt de timer nog", "hoe lang duurt de {name} nog", "hoe lang duurt de {name} timer nog", "hoeveel tijd heeft de {name} timer nog"]
          },
          speculative: true,
          run: ({ name }) => Effect.map(ctx.shared.list(name), (s) => ({ say: s }))
        }),
        defineAction({
          id: "adjust",
          label: "Change a timer's time",
          description: "Add time to a timer, or take time off it. A ringing timer given more time runs again for that long.",
          examples: ["add five minutes to the pasta timer", "take a minute off the timer", "doe er vijf minuten bij"],
          params: {
            amount: Param.duration({ label: "Amount", minMs: 1_000, maxMs: TIMERS_LIMITS.maxMs }),
            change: Param.choice({ label: "Add or take off", options: [{ value: "add", label: "add", aliases: ["erbij"] }, { value: "remove", label: "take off", aliases: ["eraf", "minder"] }], default: "add", optional: true }),
            name: Param.text({ label: "Name", after: ["to", "from", "off", "bij", "van"], optional: true, maxWords: 3 })
          },
          risk: "change",
          run: ({ amount, change, name }) => Effect.map(ctx.shared.adjust(name, change === "remove" ? -amount : amount), (s) => ({ say: s }))
        }),
        defineAction({
          id: "pause",
          label: "Pause a timer",
          description: "Pause a running timer; it keeps what it has left until it is resumed.",
          examples: ["pause the timer", "pause the pasta timer", "pauzeer de timer"],
          params: { name: Param.text({ label: "Name", after: ["the"], optional: true, maxWords: 3 }) },
          risk: "change",
          run: ({ name }) => Effect.map(ctx.shared.pause(name), (s) => ({ say: s }))
        }),
        defineAction({
          id: "resume",
          label: "Resume a timer",
          description: "Let a paused timer run again from what it had left.",
          examples: ["resume the timer", "start the pasta timer again", "laat de timer weer lopen"],
          params: { name: Param.text({ label: "Name", after: ["the"], optional: true, maxWords: 3 }) },
          risk: "change",
          run: ({ name }) => Effect.map(ctx.shared.resume(name), (s) => ({ say: s }))
        }),
        defineAction({
          id: "cancel",
          label: "Cancel a timer",
          description: "Cancel a timer (a ringing one stops), or every timer when all is asked for.",
          examples: ["cancel the timer", "cancel the eggs timer", "cancel all timers", "annuleer de timer"],
          params: {
            name: Param.text({ label: "Name", after: ["the"], optional: true, maxWords: 3 }),
            all: Param.boolean({ label: "All timers", question: "Does the speaker want every timer cancelled?" })
          },
          phrases: {
            en: ["cancel the timer", "cancel the {name} timer", "cancel timer", "stop the timer", "stop the {name} timer", "delete the timer"],
            nl: ["annuleer de timer", "annuleer de {name} timer", "annuleer de timer {name}", "stop de timer", "zet de timer uit", "zet de {name} timer uit"]
          },
          risk: "change",
          run: ({ name, all }) => Effect.map(ctx.shared.cancel(name, all), (s) => ({ say: s }))
        })
      ]
    })
})
