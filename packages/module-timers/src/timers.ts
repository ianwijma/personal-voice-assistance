import {
  ActionError,
  CurrentJob,
  CurrentTurn,
  defineAction,
  defineCollection,
  defineModule,
  Devices,
  Param,
  type PresentHandle,
  type Row,
  Setting
} from "@pva/core"
import { homeLanguage, type Language, say, StoredText, Timers, TIMERS_LIMITS, TimersError, type TimersService, type TimerInfo } from "@pva/module-contracts"
import { Clock, Effect, Option, Schema, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import { capitalise, cleanName, cut, isBusy, listOf, MAX_INSTANT, NAME_CHARS, nameKey, scan, speakLeft } from "./common.ts"
import { timerTexts as texts } from "./texts.ts"
import { speakDuration } from "@pva/language"

// ---------------------------------------------------------------------------------------------------------------------
// Data

const ID = StoredText(64)
const Instant = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_INSTANT }))
const Span = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: TIMERS_LIMITS.maxMs }))

/**
 * One timer: household data (no owner, no person), shown on every screen of its room and listed from any device.
 * `phase` says whether it still counts (`active`: running, snoozed or paused) or has ended (`ended`: it rang, or was
 * cancelled; removed by the daily clean-up a day later). The scheduler job that rings it is `job`; a job whose id is
 * not the row's any more (replaced by an adjust, a pause, a cancel) finds that and does nothing.
 */
export const Timer = Schema.Struct({
  /** As said ("pasta"), one line; absent: an unnamed timer. */
  name: Schema.optionalKey(StoredText(NAME_CHARS)),
  /** The length it was set for (its echo, and "the timer of 10 minutes"). */
  durationMs: Span,
  state: Schema.Literals(["running", "paused", "rang", "cancelled"]),
  phase: Schema.Literals(["active", "ended"]),
  /** Running again after a snooze (it shows no countdown). */
  snoozed: Schema.optionalKey(Schema.Boolean),
  /** When it rings (running), epoch ms. */
  dueAt: Instant,
  /** What is left (paused). */
  leftMs: Schema.optionalKey(Span),
  /** The device it rings on. */
  deviceId: ID,
  /** That device's room when it was set: its countdown shows on every screen there. */
  room: Schema.optionalKey(StoredText(60)),
  /** The scheduler job that rings it now. */
  job: Schema.optionalKey(ID),
  /** The ringing notification, once it rang. */
  notification: Schema.optionalKey(ID),
  /** The notification whose snooze or +5 minutes this row has already carried out (an action handler runs at most once per notification). */
  press: Schema.optionalKey(ID),
  /** When it ended; 0 while active. Indexed with `phase` for the clean-up. */
  endedAt: Instant
})
export type Timer = typeof Timer.Type

/** At most this many rows of one list: the worst legal timer is about 1,200 characters of JSON. */
const MAX_CHARS = 1_300

export const timers = defineCollection({
  name: "timers",
  scope: "household",
  schema: Timer,
  maxChars: MAX_CHARS,
  indexes: ["phase", ["phase", "endedAt"]],
  // The per-turn household facts (behind the Home setting): the running timers among the most recently changed rows.
  ambient: (rows, { now }) => ambientLine(rows, now),
  ambientRows: 10
})

/** One list page (`maxListRows` is 19 at 1,300 characters). */
const PAGE = 16
/** The most active timers one answer reads: the contract's 50, and room for the few a snooze may bring back. */
const SCAN_ACTIVE = 64
/** A finished timer stays this long before the clean-up removes it. */
const KEEP_ENDED_MS = 24 * 3_600_000
/** Minutes of "Five more minutes". */
const MORE_MINUTES = 5

// ---------------------------------------------------------------------------------------------------------------------
// Words

/** "pasta timer" / "timer of 10 minutes" (Dutch "timer pasta", "timer van 10 minuten"). */
const displayName = (value: Pick<Timer, "name" | "durationMs">, language: Language): string =>
  value.name !== undefined ? say(texts, language, "named", { name: value.name }) : say(texts, language, "unnamed", { duration: speakDuration(value.durationMs, language) ?? "" })

const leftOf = (value: Timer, now: number): number => (value.state === "paused" ? (value.leftMs ?? 0) : Math.max(0, value.dueAt - now))

/** One timer in a list: "pasta timer with 6 minutes left". */
const itemOf = (row: Row<Timer>, ringing: boolean, now: number, language: Language): string => {
  const name = displayName(row.value, language)
  const left = speakLeft(leftOf(row.value, now), language)
  if (ringing) return say(texts, language, "itemRinging", { name })
  if (row.value.state === "paused") return say(texts, language, "itemPaused", { name, left })
  if (row.value.snoozed === true) return say(texts, language, "itemSnoozed", { name, left })
  return say(texts, language, "itemLeft", { name, left })
}

/** The ambient line: at most three running timers among the rows the host read (the most recently changed ones). */
const ambientLine = (rows: ReadonlyArray<Row<Timer>>, now: number): string | undefined => {
  const active = rows.filter((r) => r.value.phase === "active")
  if (active.length === 0) return undefined
  const items = active.slice(0, 3).map((r) => itemOf(r, false, now, "en"))
  const more = active.length > 3 ? `, and ${active.length - 3} more` : ""
  return say(texts, "en", "ambient", { list: items.join(", "), more })
}

// ---------------------------------------------------------------------------------------------------------------------
// The module

const settings = {
  snoozeMinutes: Setting.number({ label: "Snooze for", description: "Minutes a ringing timer waits when someone says snooze.", default: 5, integer: true, min: 1, max: 30, unit: "minutes" }),
  ringMinutes: Setting.number({ label: "Ring for", description: "Minutes a timer rings before it stops by itself.", default: 15, integer: true, min: 1, max: 120, unit: "minutes" })
}

/** Which timer a request means. */
type Target =
  | { readonly kind: "one"; readonly row: Row<Timer>; readonly ringing: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly name: string }
  | { readonly kind: "ask"; readonly say: string }

/** A request's failure, as the person hears it. */
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
      // One change at a time (a tool, a press of a ringing card's button, the ring job): each reads the row again inside.
      const lock = yield* Semaphore.make(1)
      const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect)
      // The countdowns this part showed, by timer id; a countdown shown before a restart is replaced by its key.
      const countdowns = new Map<string, PresentHandle>()
      const language = (): Language => homeLanguage(ctx.host.view())
      const snoozeMs = () => (ctx.settings.snoozeMinutes ?? 5) * 60_000
      const ringMs = () => (ctx.settings.ringMinutes ?? 15) * 60_000

      // -- reading -------------------------------------------------------------------------------------------------------

      /** The active timers, oldest first, at most `SCAN_ACTIVE` (and whether there were more). */
      const readActive = scan<Timer>((q) => store.list({ where: { phase: "active" }, orderBy: { field: "createdAt", direction: "asc" }, ...q }), PAGE, SCAN_ACTIVE)

      /**
       * The timers ringing now: this module's open notifications (at most 10, one page of 12), each with its row. A row
       * that has gone meanwhile is left out.
       */
      const readRinging = Effect.gen(function*() {
        const open = yield* ctx.notify.list()
        const out: Array<Row<Timer>> = []
        for (const n of open) {
          if (n.key === undefined || !n.key.startsWith("timer:")) continue
          const row = yield* store.get(n.key.slice("timer:".length))
          if (row !== undefined && row.value.notification === n.id && row.value.state === "rang") out.push(row)
        }
        return out
      })

      const readAll = Effect.gen(function*() {
        const active = yield* readActive
        const ringing = yield* readRinging
        return { active: active.rows, cut: active.cut, ringing }
      })

      const unreadable = () => fail(say(texts, language(), "unreadable"))
      const failure = (e: unknown) => fail(say(texts, language(), isBusy(e) ? "busy" : "failed"))

      /**
       * Which timer `name` means: by name; with no name, the only one there is; otherwise a question. Never the first of
       * several. A ringing timer counts too (it can be stopped or given more time).
       */
      const resolve = (name: string | undefined, now: number) =>
        Effect.gen(function*() {
          const lang = language()
          const all = yield* readAll.pipe(Effect.mapError(unreadable))
          const candidates = [...all.ringing.map((row) => ({ row, ringing: true })), ...all.active.map((row) => ({ row, ringing: false }))]
          const key = name === undefined ? "" : nameKey(name)
          const matches = key === "" ? candidates : candidates.filter((c) => c.row.value.name !== undefined && nameKey(c.row.value.name) === key)
          if (matches.length === 1) return { kind: "one", row: matches[0]!.row, ringing: matches[0]!.ringing } satisfies Target as Target
          if (matches.length === 0) {
            if (key !== "") return { kind: "unknown", name: name! } satisfies Target as Target
            if (all.cut) return yield* Effect.fail(unreadable())
            return { kind: "none" } satisfies Target as Target
          }
          const list = listOf(matches.map((c) => itemOf(c.row, c.ringing, now, lang)), lang)
          const cut = key === "" && all.cut
          return { kind: "ask", say: say(texts, lang, cut ? "whichCut" : "which", { count: matches.length, list }) } satisfies Target as Target
        })

      /** Answer a target that is not one timer. */
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

      // -- what screens show ---------------------------------------------------------------------------------------------

      const targetOf = (value: Timer) => (value.room !== undefined ? { room: value.room } : { device: value.deviceId })

      /** Show (or replace, by its key) a running timer's countdown on every screen of its room. Never fails the timer. */
      const showCountdown = (id: string, value: Timer) =>
        Effect.gen(function*() {
          const lang = language()
          const now = yield* Clock.currentTimeMillis
          const name = capitalise(displayName(value, lang))
          const handle = yield* ctx.present.show(
            targetOf(value),
            { kind: "timer", label: cut(name, 40), endsAt: value.dueAt, spoken: say(texts, lang, "spoken", { Name: name, left: speakLeft(value.dueAt - now, lang) }) },
            { lifetime: "pinned", key: `timer:${id}` }
          )
          countdowns.set(id, handle)
        }).pipe(Effect.ignore)

      /**
       * Take a timer's countdown down. One this part showed is dismissed by its handle; one shown before a restart is
       * replaced by its key (a countdown ending now) and dismissed, so nothing is left counting down for a timer that
       * does not run. Never fails the change it follows.
       */
      const dismissCountdown = (id: string, value: Timer) =>
        Effect.gen(function*() {
          const handle = countdowns.get(id)
          countdowns.delete(id)
          if (handle !== undefined) {
            yield* Effect.ignore(handle.dismiss)
            return
          }
          const now = yield* Clock.currentTimeMillis
          const lang = language()
          const replaced = yield* Effect.option(
            ctx.present.show(targetOf(value), { kind: "timer", label: cut(capitalise(displayName(value, lang)), 40), endsAt: now, spoken: capitalise(displayName(value, lang)) }, {
              lifetime: "pinned",
              key: `timer:${id}`
            })
          )
          if (Option.isSome(replaced)) yield* Effect.ignore(replaced.value.dismiss)
        })

      // -- changing ------------------------------------------------------------------------------------------------------

      const ringJob = (id: string, at: number, deviceId: string) =>
        ctx.scheduler.prepare({ handler: "ring", key: `timer:${id}`, payload: { id }, at, origin: { deviceId } })

      type StartOutcome =
        | { readonly kind: "started"; readonly id: string; readonly value: Timer }
        | { readonly kind: "duplicate"; readonly row: Row<Timer> }
        | { readonly kind: "limit" }

      /** Start a timer: the row and the job that rings it in one transaction, then its countdown. */
      const startTimer = (input: { readonly durationMs: number; readonly name?: string | undefined; readonly deviceId: string; readonly room?: string | undefined }) =>
        locked(Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const active = yield* readActive
          if (active.cut || active.rows.length >= TIMERS_LIMITS.running) return { kind: "limit" } satisfies StartOutcome as StartOutcome
          if (input.name !== undefined) {
            const key = nameKey(input.name)
            const same = active.rows.find((r) => r.value.name !== undefined && key !== "" && nameKey(r.value.name) === key)
            if (same !== undefined) return { kind: "duplicate", row: same } satisfies StartOutcome as StartOutcome
          }
          const id = randomUUID()
          const job = yield* ringJob(id, now + input.durationMs, input.deviceId)
          const room = input.room !== undefined && input.room.length <= 60 && input.room.trim() !== "" ? input.room : undefined
          const value: Timer = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            durationMs: input.durationMs,
            state: "running",
            phase: "active",
            dueAt: job.dueAt,
            deviceId: input.deviceId,
            ...(room !== undefined ? { room } : {}),
            job: job.id,
            endedAt: 0
          }
          yield* ctx.store.transaction((tx) => {
            tx.collection(timers).insert(value, { id })
            job.writeIn(tx)
          })
          yield* showCountdown(id, value)
          return { kind: "started", id, value } satisfies StartOutcome as StartOutcome
        }))

      /** The device a call runs for: the turn's, else the job's. */
      const callDevice = Effect.gen(function*() {
        const turn = yield* CurrentTurn
        if (turn?.deviceId !== undefined) return { deviceId: turn.deviceId, room: turn.room }
        const job = yield* CurrentJob
        return job?.deviceId !== undefined ? { deviceId: job.deviceId, room: undefined } : undefined
      })

      /** Restart a timer that rang (or is ringing) for `ms`, as its own snooze or "+5 minutes". Inside the lock. */
      const rearm = (row: Row<Timer>, ms: number, options: { readonly snoozed: boolean; readonly press?: string }) =>
        Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const job = yield* ringJob(row.id, now + ms, row.value.deviceId)
          const { notification: _n, job: _j, leftMs: _l, snoozed: _s, ...rest } = row.value
          const value: Timer = {
            ...rest,
            state: "running",
            phase: "active",
            dueAt: job.dueAt,
            job: job.id,
            endedAt: 0,
            ...(options.snoozed ? { snoozed: true } : {}),
            ...(options.press !== undefined ? { press: options.press } : {})
          }
          yield* ctx.store.transaction((tx) => {
            tx.collection(timers).update(row.id, () => value, { expectRev: row.rev })
            job.writeIn(tx)
          })
          if (!options.snoozed) yield* showCountdown(row.id, value)
          return value
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
            const key = name === undefined ? "" : nameKey(name)
            if (key !== "") {
              const t = yield* resolve(name, now)
              if (t.kind !== "one") return notOne(t)
              return oneAnswer(t.row, t.ringing, now, lang)
            }
            const all = yield* readAll.pipe(Effect.mapError(unreadable))
            const items = [...all.ringing.map((row) => ({ row, ringing: true })), ...all.active.map((row) => ({ row, ringing: false }))]
            if (items.length === 0) {
              if (all.cut) return yield* Effect.fail(unreadable())
              return say(texts, lang, "none")
            }
            if (items.length === 1 && !all.cut) return oneAnswer(items[0]!.row, items[0]!.ringing, now, lang)
            const list = listOf(items.map((i) => itemOf(i.row, i.ringing, now, lang)), lang)
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
            if (t.ringing) {
              // A ringing timer given more time runs again for that long; taking time off a ringing one means nothing.
              if (deltaMs <= 0) return say(texts, lang, "notPausedRinging", { Name })
              if (deltaMs > TIMERS_LIMITS.maxMs) return yield* Effect.fail(fail(say(texts, lang, "tooLong")))
              const active = yield* readActive.pipe(Effect.mapError(failure))
              if (active.cut || active.rows.length >= TIMERS_LIMITS.running) return yield* Effect.fail(fail(say(texts, lang, "full", { count: TIMERS_LIMITS.running })))
              yield* rearm(row, deltaMs, { snoozed: false }).pipe(Effect.mapError(failure))
              yield* Effect.ignore(ctx.notify.resolve(row.value.notification!))
              return say(texts, lang, "restarted", { Name, left: speakLeft(deltaMs, lang) })
            }
            const left = leftOf(row.value, now) + deltaMs
            if (left < 1_000) return say(texts, lang, "wouldEnd", { name: displayName(row.value, lang), left: speakLeft(leftOf(row.value, now), lang) })
            if (left > TIMERS_LIMITS.maxMs) return yield* Effect.fail(fail(say(texts, lang, "tooLong")))
            if (row.value.state === "paused") {
              yield* store.update(row.id, (v) => ({ ...v, leftMs: left }), { expectRev: row.rev }).pipe(Effect.mapError(failure))
              return say(texts, lang, "adjustedPaused", { Name, left: speakLeft(left, lang) })
            }
            // The job is replaced by a new one for the new time (same key), in the same transaction as the row.
            const job = yield* ringJob(row.id, now + left, row.value.deviceId).pipe(Effect.mapError(failure))
            const value: Timer = { ...row.value, dueAt: job.dueAt, job: job.id }
            yield* ctx.store.transaction((tx) => {
              tx.collection(timers).update(row.id, () => value, { expectRev: row.rev })
              job.writeIn(tx)
            }).pipe(Effect.mapError(failure))
            if (row.value.snoozed !== true) yield* showCountdown(row.id, value)
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
            if (t.ringing) return say(texts, lang, "notPausedRinging", { Name })
            if (row.value.state === "paused") return say(texts, lang, "alreadyPaused", { Name, left: speakLeft(leftOf(row.value, now), lang) })
            const left = Math.max(1_000, row.value.dueAt - now)
            const { job: _j, snoozed: _s, ...rest } = row.value
            // The row first: a job that still runs finds it paused and does nothing. Then the job is cancelled.
            yield* store.update(row.id, () => ({ ...rest, state: "paused", leftMs: left }), { expectRev: row.rev }).pipe(Effect.mapError(failure))
            if (row.value.job !== undefined) yield* Effect.ignore(ctx.scheduler.cancel(row.value.job))
            yield* dismissCountdown(row.id, row.value)
            return say(texts, lang, "paused", { Name, left: speakLeft(left, lang) })
          })),

        resume: (name) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            const t = yield* resolve(name, now)
            if (t.kind !== "one") return notOne(t)
            const row = t.row
            const Name = capitalise(displayName(row.value, lang))
            if (t.ringing) return say(texts, lang, "notPausedRinging", { Name })
            if (row.value.state !== "paused") return say(texts, lang, "notPaused", { Name, left: speakLeft(leftOf(row.value, now), lang) })
            const left = row.value.leftMs ?? 1_000
            const job = yield* ringJob(row.id, now + left, row.value.deviceId).pipe(Effect.mapError(failure))
            const { leftMs: _l, ...rest } = row.value
            const value: Timer = { ...rest, state: "running", dueAt: job.dueAt, job: job.id }
            yield* ctx.store.transaction((tx) => {
              tx.collection(timers).update(row.id, () => value, { expectRev: row.rev })
              job.writeIn(tx)
            }).pipe(Effect.mapError(failure))
            yield* showCountdown(row.id, value)
            return say(texts, lang, "resumed", { Name, left: speakLeft(left, lang) })
          })),

        cancel: (name, all) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const now = yield* Clock.currentTimeMillis
            if (all) {
              const read = yield* readAll.pipe(Effect.mapError(unreadable))
              const rows = read.active
              if (rows.length === 0 && read.ringing.length === 0) return say(texts, lang, "cancelledNone")
              // One transaction for every row (at most `SCAN_ACTIVE`), then their jobs, countdowns and rings.
              yield* ctx.store.transaction((tx) => {
                for (const row of rows) tx.collection(timers).update(row.id, (v) => endedValue(v, "cancelled", now), { expectRev: row.rev })
              }).pipe(Effect.mapError(failure))
              for (const row of rows) {
                if (row.value.job !== undefined) yield* Effect.ignore(ctx.scheduler.cancel(row.value.job))
                yield* dismissCountdown(row.id, row.value)
              }
              for (const row of read.ringing) yield* Effect.ignore(ctx.notify.resolve(row.value.notification!))
              const count = rows.length + read.ringing.length
              return say(texts, lang, read.cut ? "cancelledAllCut" : "cancelledAll", { count })
            }
            const t = yield* resolve(name, now)
            if (t.kind !== "one") return notOne(t)
            const row = t.row
            const Name = capitalise(displayName(row.value, lang))
            if (t.ringing) {
              const resolved = yield* ctx.notify.resolve(row.value.notification!).pipe(Effect.mapError(failure))
              // Already resolved elsewhere (stopped on another device a moment ago): it is not ringing any more either way.
              void resolved
              return say(texts, lang, "cancelledRinging", { Name })
            }
            yield* store.update(row.id, (v) => endedValue(v, "cancelled", now), { expectRev: row.rev }).pipe(Effect.mapError(failure))
            if (row.value.job !== undefined) yield* Effect.ignore(ctx.scheduler.cancel(row.value.job))
            yield* dismissCountdown(row.id, row.value)
            return say(texts, lang, "cancelled", { Name })
          }))
      }

      /** One timer's answer to "how long is left". */
      const oneAnswer = (row: Row<Timer>, ringing: boolean, now: number, lang: Language): string => {
        const Name = capitalise(displayName(row.value, lang))
        const left = speakLeft(leftOf(row.value, now), lang)
        if (ringing) return say(texts, lang, "oneRinging", { Name })
        if (row.value.state === "paused") return say(texts, lang, "onePaused", { Name, left })
        if (row.value.snoozed === true) return say(texts, lang, "oneSnoozed", { Name, left })
        return say(texts, lang, "oneLeft", { Name, left })
      }

      // -- jobs ----------------------------------------------------------------------------------------------------------

      // The ring: one job per timer, at its due instant. It sends the ringing notification on the timer's device (the
      // job's origin), marks the row as rung and takes the countdown down. Idempotent: run again after a failure, the
      // send finds its open notification by key (`deduped`) and the row is marked once.
      yield* ctx.scheduler.handle("ring", {
        payload: Schema.Struct({ id: ID }),
        idempotent: true,
        retries: 5,
        timeoutMs: 10_000,
        run: ({ id }, due) =>
          locked(Effect.gen(function*() {
            const row = yield* store.get(id)
            // Gone, paused, cancelled or moved meanwhile: this job is not the one that rings it.
            if (row === undefined || row.value.state !== "running" || row.value.job !== due.jobId) return
            const job = yield* CurrentJob
            const lang = language()
            const name = displayName(row.value, lang)
            const duration = speakDuration(row.value.durationMs, lang) ?? ""
            const sent = yield* ctx.notify.send({
              title: row.value.name !== undefined ? say(texts, lang, "title", { Name: cut(capitalise(name), 40) }) : say(texts, lang, "titlePlain"),
              text: due.lateMs >= 60_000 ? say(texts, lang, "ringTextLate", { duration, late: speakLeft(due.lateMs, lang) }) : say(texts, lang, "ringText", { duration }),
              priority: "ring",
              key: `timer:${id}`,
              expiresInMs: ringMs(),
              actions: [{ id: "snooze", label: say(texts, lang, "snooze") }, { id: "more", label: say(texts, lang, "more") }],
              handler: "timer"
            })
            const now = yield* Clock.currentTimeMillis
            yield* store.update(id, (v) => ({ ...endedValue(v, "rang", now), notification: sent.notification.id }), {
              expectRev: row.rev,
              ...(job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {})
            })
            yield* dismissCountdown(id, row.value)
          }))
      }).pipe(Effect.orDie)

      // The daily clean-up: ended timers older than a day, oldest first, a page per transaction with a yield between.
      yield* ctx.scheduler.handle("cleanup", {
        payload: Schema.Struct({}),
        idempotent: true,
        run: () =>
          Effect.gen(function*() {
            const job = yield* CurrentJob
            const cutoff = (yield* Clock.currentTimeMillis) - KEEP_ENDED_MS
            for (let batch = 0; batch < 100; batch++) {
              const rows = yield* store.list({ where: { phase: "ended" }, orderBy: { field: "endedAt", direction: "asc" }, limit: PAGE })
              const old = rows.filter((r) => r.value.endedAt < cutoff)
              if (old.length > 0) {
                yield* ctx.store.transaction((tx) => {
                  for (const r of old) tx.collection(timers).remove(r.id, { expectRev: r.rev, ...(job !== undefined ? { actor: { kind: "job" as const, jobId: job.jobId } } : {}) })
                })
              }
              if (old.length < PAGE) return
              yield* Effect.yieldNow
            }
          })
      }).pipe(Effect.orDie)
      yield* ctx.scheduler.schedule({ handler: "cleanup", key: "cleanup", cron: "17 4 * * *" }).pipe(Effect.orDie)

      // -- the ringing card's buttons ------------------------------------------------------------------------------------

      // Snooze and "Five more minutes", beside the host's stop. Idempotent by notification id: the row remembers the
      // notification it already acted on, and a second run (after a store failure) answers the same without a change.
      yield* ctx.notify.handle("timer", {
        run: (press) =>
          locked(Effect.gen(function*() {
            const lang = language()
            const id = press.key?.startsWith("timer:") === true ? press.key.slice("timer:".length) : undefined
            const row = id === undefined ? undefined : yield* store.get(id)
            if (row === undefined) return { say: say(texts, lang, "gone") }
            const Name = capitalise(displayName(row.value, lang))
            const snooze = press.actionId === "snooze"
            const now = yield* Clock.currentTimeMillis
            const answer = (value: Timer) =>
              snooze ? say(texts, lang, "snoozed", { Name, left: speakLeft(leftOf(value, now), lang) }) : say(texts, lang, "moreDone", { Name })
            // Done already for this notification (a run again after a failure), or the timer was restarted meanwhile.
            if (row.value.press === press.notificationId || row.value.state !== "rang" || row.value.notification !== press.notificationId) {
              return { say: row.value.phase === "active" ? answer(row.value) : say(texts, lang, "gone") }
            }
            const active = yield* readActive
            if (active.cut || active.rows.length >= TIMERS_LIMITS.running) return { say: say(texts, lang, "full", { count: TIMERS_LIMITS.running }), keepOpen: true }
            const value = yield* rearm(row, snooze ? snoozeMs() : MORE_MINUTES * 60_000, { snoozed: snooze, press: press.notificationId })
            return { say: answer(value) }
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
            if (label !== undefined && (typeof label !== "string" || label.length < 1 || cleanName(label) === false || label.length > TIMERS_LIMITS.labelChars)) {
              return yield* Effect.fail(invalid("label is not one line of 1 to 60 characters"))
            }
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
            // A second timer of a name that runs already: refused as a request outside the bounds, since names must tell timers apart.
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

/** A row's value once it ended (rang or cancelled): no job, no countdown, kept a day. */
const endedValue = (v: Timer, state: "rang" | "cancelled", now: number): Timer => {
  const { job: _j, snoozed: _s, ...rest } = v
  return { ...rest, state, phase: "ended", endedAt: now }
}
