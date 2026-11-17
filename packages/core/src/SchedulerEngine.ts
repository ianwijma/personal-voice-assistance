import { Cause, Clock, type Context, Cron, Deferred, Effect, Exit, FiberMap, Result, Schema, type Scope, Semaphore } from "effect"
import { HOUSEHOLD_SCOPE, scopeKey, type StoreError } from "./HouseholdStore.ts"
import type { Issue } from "./ModuleApi.ts"
import type { IssueRegistry } from "./Issues.ts"
import type { JobTable } from "./JobTable.ts"
import {
  type DueInfo,
  type JobOrigin,
  type JobRow,
  type JobView,
  type JobWhen,
  LIVE_STATES,
  type ListFilter,
  logDelivery,
  type MissedPolicy,
  type ModuleScheduler,
  type NotificationDelivery,
  NotificationRequest,
  occurrenceKey,
  ON_TIME_MS,
  type ScheduleRequest,
  type Scheduler,
  type SchedulerCounts,
  SchedulerError,
  type TaskRequest
} from "./Scheduler.ts"
import { CurrentTurn } from "./TurnContext.ts"

/**
 * The scheduler's engine (docs/SCHEDULING.md; shared-state-jobs-and-notifications.md §6.2): one fiber that sleeps until
 * the earliest due time and is woken by every change, over a `JobTable`. Serve mode runs it on the household store
 * (`sqlJobTable`); `makeTestScheduler` in `@pva/core/testing` runs the same engine on the in-memory store, on the test
 * clock.
 *
 * - **Time.** Due times are absolute wall-clock milliseconds (`Clock.currentTimeMillis`), so they survive a restart.
 *   The fiber sleeps at most `jumpCheckMs` at a time and compares how far the wall clock moved with how far the
 *   monotonic clock moved: a jump (NTP setting the clock of a Pi without an RTC after boot) triggers a re-check, as
 *   does every wake-up. A `Cron` job is computed in its time zone (default `HOME_TIME_ZONE`, read at each computation),
 *   so a daylight-saving change does not move "7:00".
 * - **Claims.** A due job is claimed (`scheduled → running`, compare-and-set on its rev) before it runs, and its run is
 *   a fiber of its own: a slow handler never holds up the engine. Completing or failing the occurrence and scheduling
 *   the next one of a recurring job are one write. A run interrupted by shutdown leaves its job `running`; the next
 *   start recovers it (see `recover`).
 */

export interface SchedulerEngineOptions {
  readonly table: JobTable
  /** Default `logDelivery` on `log`. */
  readonly delivery?: NotificationDelivery
  /** Where failed jobs, jobs waiting for a handler and jobs of removed modules show (source `scheduler`). */
  readonly issues?: IssueRegistry
  /** `HOME_TIME_ZONE` (read at each cron computation). Absent or empty: the server's own zone. */
  readonly timeZone?: () => string | undefined
  /** The module catalogue (ids and names): a job of a module not in it is "orphaned". Absent: none is. */
  readonly modules?: () => ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly log?: (line: string) => void
  /** Tasks running at once. Default 2. */
  readonly maxTasks?: number
  /** First retry delay (doubles each time, at most 10 min). Default 5 s. */
  readonly retryBaseMs?: number
  /** Longest single sleep, and so how soon a clock jump is noticed. Default 10 s. */
  readonly jumpCheckMs?: number
  /** Finished jobs are kept this long. Default 7 days. */
  readonly keepFinishedMs?: number
  /** A handler's time limit when it gives none. Default 60 s. */
  readonly handlerTimeoutMs?: number
  /** Job ids (tests). Default random. */
  readonly newId?: () => string
}

export interface SchedulerEngine extends Scheduler {
  /** Wake the engine now (tests; the app after a clock change it knows of). */
  readonly wake: () => void
  /** Recompute the Health issues (source `scheduler`). */
  readonly refreshIssues: Effect.Effect<void>
}

const KEY = /^[A-Za-z0-9_.:@/-]{1,200}$/
const HANDLER = /^[a-z][a-z0-9_.-]{0,63}$/
const MAX_PAYLOAD_CHARS = 16_000
const MAX_RESULT_CHARS = 4_000
const JUMP_MS = 2_000
const MAX_BACKOFF_MS = 10 * 60_000
const DAY = 24 * 60 * 60 * 1000

interface Registration {
  readonly schema: Schema.Codec<any, any>
  readonly run: (payload: any, due: DueInfo) => Effect.Effect<void, unknown>
  readonly timeoutMs: number
}

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  const m = e instanceof Error ? e.message : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e)
  return m.slice(0, 500)
}

const jsonSafe = (value: unknown): { readonly ok: true; readonly text: string } | { readonly ok: false } => {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? { ok: false } : { ok: true, text }
  } catch {
    return { ok: false }
  }
}

const invalid = (message: string) => new SchedulerError({ reason: "invalid", message })
const storeFailed = (e: StoreError) => new SchedulerError({ reason: e.reason === "read-only" || e.reason === "unavailable" ? "unavailable" : "failed", message: e.message })

const policyProblem = (p: MissedPolicy): string | undefined => {
  if (p === "fire-late" || p === "skip" || p === "inbox") return undefined
  if (typeof p === "object" && p !== null && Number.isFinite(p.fireIfWithinMs) && p.fireIfWithinMs >= 0) {
    return p.otherwise === undefined || p.otherwise === "missed" || p.otherwise === "inbox" ? undefined : "missed.otherwise must be \"missed\" or \"inbox\""
  }
  return "missed must be \"fire-late\", \"skip\", \"inbox\" or { fireIfWithinMs }"
}

/** What to do with an occurrence `lateBy` after its due time. */
const verdictOf = (p: MissedPolicy, lateBy: number): "fire" | "inbox" | "missed" => {
  if (lateBy <= ON_TIME_MS) return "fire"
  if (p === "fire-late") return "fire"
  if (p === "skip") return "missed"
  if (p === "inbox") return "inbox"
  return lateBy <= p.fireIfWithinMs ? "fire" : p.otherwise === "inbox" ? "inbox" : "missed"
}

export const makeSchedulerEngine = (options: SchedulerEngineOptions): Effect.Effect<SchedulerEngine, StoreError, Scope.Scope> =>
  Effect.gen(function*() {
    const { table } = options
    const log = options.log ?? (() => {})
    let delivery = options.delivery ?? logDelivery(log)
    const retryBaseMs = options.retryBaseMs ?? 5_000
    const jumpCheckMs = options.jumpCheckMs ?? 10_000
    const keepFinishedMs = options.keepFinishedMs ?? 7 * DAY
    const handlerTimeoutMs = options.handlerTimeoutMs ?? 60_000
    const newId = options.newId ?? (() => `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`)
    const scope = yield* Effect.scope
    // Runs and tasks are forked with the engine's own context, never the caller's: a task started inside a module's
    // transaction or a turn must not inherit that transaction (or that turn).
    const engineContext = yield* Effect.context<never>()
    const detached = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> => Effect.updateContext(effect, (_: Context.Context<never>) => engineContext)
    const runs = yield* FiberMap.make<string>()
    const taskSlots = Semaphore.makeUnsafe(options.maxTasks ?? 2)
    /** `<module>\u0000<handler>` → registrations, newest last. */
    const handlers = new Map<string, Array<Registration>>()
    const handlerKey = (module: string, name: string) => `${module}\u0000${name}`
    const handlerOf = (module: string, name: string) => handlers.get(handlerKey(module, name))?.at(-1)

    yield* table.migrate

    const now = Clock.currentTimeMillis
    const monotonicMs = Effect.map(Clock.monotonicTimeNanos, (n) => Number(n / 1_000_000n))

    // ---- Wake-ups

    let signal = Deferred.makeUnsafe<void>()
    const wake = () => {
      Deferred.doneUnsafe(signal, Effect.void)
    }
    const freshSignal = () => {
      signal = Deferred.makeUnsafe<void>()
      return signal
    }

    // ---- Cron

    const zoneOf = (job: { readonly timeZone?: string }) =>
      job.timeZone ?? (options.timeZone?.() || undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    const parseCron = (expr: string, zone: string) => {
      const parsed = Cron.parse(expr, zone)
      return Result.isSuccess(parsed) ? { ok: true as const, cron: parsed.success } : { ok: false as const, message: parsed.failure.message }
    }
    const cronOf = (job: { readonly cron?: string; readonly timeZone?: string }) => {
      const parsed = parseCron(job.cron!, zoneOf(job))
      // A zone that became invalid (HOME_TIME_ZONE changed): UTC rather than a job that never moves on.
      return parsed.ok ? parsed.cron : Cron.parseUnsafe(job.cron!, "UTC")
    }
    /** The first occurrence strictly after `after`. */
    const cronNext = (job: { readonly cron?: string; readonly timeZone?: string }, after: number): number => Cron.next(cronOf(job), new Date(after)).getTime()
    /** The last occurrence at or before `at`. */
    const cronLast = (job: JobRow, at: number): number => Cron.prev(cronOf(job), new Date(at + 1)).getTime()
    /** Occurrences from `from` (one) up to, not including, `to` (at most 10 000 counted). */
    const occurrencesBetween = (job: JobRow, from: number, to: number): number => {
      const cron = cronOf(job)
      let n = 0
      for (let t = from; t < to && n < 10_000; t = Cron.next(cron, new Date(t)).getTime()) n++
      return n
    }

    /** The first due time of `when`, or why it is not valid. */
    const firstDue = (when: JobWhen, at: number): Effect.Effect<{ readonly dueAt: number; readonly cron?: string; readonly timeZone?: string }, SchedulerError> => {
      if ("at" in when) {
        return Number.isFinite(when.at) ? Effect.succeed({ dueAt: Math.round(when.at) }) : Effect.fail(invalid("when.at must be a time in epoch milliseconds"))
      }
      if ("inMs" in when) {
        return Number.isFinite(when.inMs) && when.inMs >= 0 ? Effect.succeed({ dueAt: at + Math.round(when.inMs) }) : Effect.fail(invalid("when.inMs must be 0 or more"))
      }
      if ("cron" in when && typeof when.cron === "string") {
        const tz = when.timeZone
        const parsed = parseCron(when.cron, tz ?? zoneOf({}))
        if (!parsed.ok) return Effect.fail(invalid(`"${when.cron}"${tz !== undefined ? ` in ${tz}` : ""} is not a cron schedule: ${parsed.message}`))
        const job = { cron: when.cron, ...(tz !== undefined ? { timeZone: tz } : {}) }
        return Effect.succeed({ dueAt: cronNext(job, at), ...job })
      }
      return Effect.fail(invalid("when must be { at }, { inMs } or { cron }"))
    }

    // ---- Writes

    /** A change to a row; `undefined` removes a field. */
    type Patch = { readonly [K in keyof JobRow]?: JobRow[K] | undefined }
    const bump = (job: JobRow, patch: Patch, at: number): JobRow => {
      const next: Record<string, unknown> = { ...job, ...patch, rev: job.rev + 1, updatedAt: at }
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
      return next as unknown as JobRow
    }
    const write = (job: JobRow, patch: Patch, at: number) =>
      Effect.map(table.replace(bump(job, patch, at)), (ok) => (ok ? bump(job, patch, at) : undefined))

    // ---- Issues

    const moduleName = (id: string) => options.modules?.().find((m) => m.id === id)?.name ?? id
    const isOrphan = (id: string) => options.modules !== undefined && !options.modules().some((m) => m.id === id)

    const refreshIssues: Effect.Effect<void> = options.issues === undefined
      ? Effect.void
      : Effect.gen(function*() {
        const live = yield* table.query({ states: LIVE_STATES, limit: 2000 })
        const failed = yield* table.query({ states: ["failed"], limit: 50 })
        options.issues!.set("scheduler", schedulerIssues({ live, failed, moduleName, isOrphan }))
      }).pipe(Effect.catch((e) => Effect.sync(() => log(`Scheduler: issues not refreshed: ${e.message}`))))

    /** Recompute the issues in the engine's scope, not the caller's (a tool's `cancel` is on the turn path). */
    const refreshIssuesSoon: Effect.Effect<void> = options.issues === undefined ? Effect.void : Effect.asVoid(Effect.forkIn(detached(refreshIssues), scope))

    // ---- Firing

    const backoff = (attempts: number) => Math.min(MAX_BACKOFF_MS, retryBaseMs * 2 ** Math.max(0, attempts - 1))

    /** Finish a claimed occurrence: done, retried, failed, or (recurring) moved on to its next time. One write. */
    const complete = (
      claimed: JobRow,
      outcome: { readonly ok: true; readonly inbox: boolean; readonly delivered?: JobRow["delivered"] } | { readonly ok: false; readonly message: string; readonly retryable: boolean }
    ) =>
      table.transaction(Effect.gen(function*() {
        const at = yield* now
        const current = yield* table.get(claimed.id)
        // Cancelled or rescheduled while it ran: what was done to it stands. (Handing its key to a successor, below in
        // `schedule`, changes only the key, so the run still completes.)
        if (current === undefined || current.state !== "running" || current.occurrenceAt !== claimed.occurrenceAt || current.attempts !== claimed.attempts) return
        const delivered = outcome.ok && outcome.delivered !== undefined ? { delivered: outcome.delivered } : {}
        if (outcome.ok) {
          if (current.cron !== undefined) {
            yield* write(current, {
              state: "scheduled",
              dueAt: cronNext(current, Math.max(at, current.occurrenceAt ?? at)),
              occurrenceAt: undefined,
              attempts: 0,
              lastFailedAt: undefined,
              ...delivered
            }, at)
          } else {
            yield* write(current, { state: outcome.inbox ? "missed" : "done", ...delivered }, at)
          }
          return
        }
        const retry = outcome.retryable && current.attempts <= current.retryLimit
        if (retry) {
          log(`Scheduler: ${current.id} (${current.module}) failed, retry ${current.attempts} of ${current.retryLimit}: ${outcome.message}`)
          yield* write(current, { state: "scheduled", dueAt: at + backoff(current.attempts), lastError: outcome.message }, at)
        } else if (current.cron !== undefined) {
          log(`Scheduler: an occurrence of ${current.id} (${current.module}) failed: ${outcome.message}`)
          yield* write(current, {
            state: "scheduled",
            dueAt: cronNext(current, Math.max(at, current.occurrenceAt ?? at)),
            occurrenceAt: undefined,
            attempts: 0,
            lastError: outcome.message,
            lastFailedAt: at
          }, at)
        } else {
          log(`Scheduler: ${current.id} (${current.module}) failed: ${outcome.message}`)
          yield* write(current, { state: "failed", lastError: outcome.message }, at)
        }
      })).pipe(
        // Issues change only with a failure, or with the first success after one.
        Effect.andThen(!outcome.ok || claimed.lastFailedAt !== undefined ? refreshIssues : Effect.void),
        Effect.andThen(Effect.sync(wake)),
        Effect.catch((e) => Effect.sync(() => log(`Scheduler: ${claimed.id} not completed: ${e.message}`)))
      )

    const dueInfoOf = (job: JobRow, extra: { readonly lateByMs: number; readonly inbox: boolean; readonly skipped: number }): DueInfo => ({
      job,
      occurrenceKey: occurrenceKey(job.id, job.occurrenceAt!),
      dueAt: job.occurrenceAt!,
      lateByMs: extra.lateByMs,
      attempt: job.attempts,
      inbox: extra.inbox,
      skipped: extra.skipped
    })

    /** Run a claimed occurrence (its own fiber). Interrupted (shutdown): the row stays `running` for `recover`. */
    const fire = (claimed: JobRow, extra: { readonly lateByMs: number; readonly inbox: boolean; readonly skipped: number }) =>
      Effect.gen(function*() {
        const onDue = claimed.onDue!
        const due = dueInfoOf(claimed, extra)
        if ("notify" in onDue) {
          const request = { ...onDue.notify, source: { module: claimed.module, jobId: claimed.id } }
          const exit = yield* Effect.exit(Effect.suspend(() => delivery.deliver(request, { notificationId: due.occurrenceKey, lateByMs: due.lateByMs, inbox: due.inbox, job: claimed })).pipe(
            Effect.timeoutOrElse({ duration: handlerTimeoutMs, orElse: () => Effect.fail(new Error(`The delivery took longer than ${handlerTimeoutMs / 1000} s`)) })
          ))
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
          const at = yield* now
          return yield* complete(claimed, Exit.isSuccess(exit)
            ? { ok: true, inbox: due.inbox, delivered: { notificationId: due.occurrenceKey, at, lateByMs: due.lateByMs, inbox: due.inbox } }
            : { ok: false, message: messageOf(exit.cause), retryable: true })
        }
        const reg = handlerOf(claimed.module, onDue.handler)
        if (reg === undefined) {
          // Withdrawn between the claim and now: it waits again, as if it had not been claimed.
          const at = yield* now
          yield* table.transaction(Effect.flatMap(table.get(claimed.id), (current) =>
            current?.rev === claimed.rev
              ? write(current, {
                state: "scheduled",
                waiting: true,
                attempts: Math.max(0, current.attempts - 1),
                ...(current.attempts <= 1 ? { occurrenceAt: undefined, dueAt: current.occurrenceAt } : {})
              }, at)
              : Effect.succeed(undefined))).pipe(Effect.ignore)
          yield* refreshIssues
          return
        }
        const decoded = yield* Effect.exit(Schema.decodeUnknownEffect(reg.schema)(onDue.payload))
        if (Exit.isFailure(decoded)) {
          return yield* complete(claimed, { ok: false, message: `Its payload does not match the handler's schema: ${messageOf(decoded.cause)}`, retryable: false })
        }
        const exit = yield* Effect.exit(Effect.suspend(() => reg.run(decoded.value, due)).pipe(
          Effect.timeoutOrElse({ duration: reg.timeoutMs, orElse: () => Effect.fail(new Error(`The handler took longer than ${reg.timeoutMs / 1000} s`)) })
        ))
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
        return yield* complete(claimed, Exit.isSuccess(exit) ? { ok: true, inbox: due.inbox } : { ok: false, message: messageOf(exit.cause), retryable: claimed.idempotent })
      })

    /** One due job: wait for its handler, apply its missed policy, or claim it and start its run. */
    const dispatch = (job: JobRow) =>
      table.transaction(Effect.gen(function*() {
        const at = yield* now
        const onDue = job.onDue
        if (onDue === undefined) return
        if ("handler" in onDue && handlerOf(job.module, onDue.handler) === undefined) {
          yield* write(job, { waiting: true }, at)
          return "waiting" as const
        }
        const retry = job.occurrenceAt !== undefined
        let occurrenceAt = job.occurrenceAt ?? job.dueAt!
        let skipped = 0
        if (!retry && job.cron !== undefined && at - occurrenceAt > ON_TIME_MS) {
          // Several occurrences passed: only the last one runs (or is judged by the missed policy), once.
          const last = Math.max(occurrenceAt, cronLast(job, at))
          skipped = last > occurrenceAt ? occurrencesBetween(job, occurrenceAt, last) : 0
          occurrenceAt = last
        }
        const lateByMs = Math.max(0, at - occurrenceAt)
        const verdict = retry ? "fire" : verdictOf(job.missed, lateByMs)
        const totalSkipped = (job.skipped ?? 0) + skipped
        if (verdict === "missed") {
          log(`Scheduler: ${job.id} (${job.module}) missed by ${Math.round(lateByMs / 1000)} s; not fired`)
          if (job.cron !== undefined) {
            yield* write(job, { dueAt: cronNext(job, at), skipped: totalSkipped + 1, waiting: false }, at)
          } else {
            yield* write(job, { state: "missed", waiting: false, ...(totalSkipped > 0 ? { skipped: totalSkipped } : {}) }, at)
          }
          return "missed" as const
        }
        const claimed = yield* write(job, {
          state: "running",
          occurrenceAt,
          attempts: retry ? job.attempts + 1 : 1,
          waiting: false,
          lastRunAt: at,
          ...(totalSkipped > 0 ? { skipped: totalSkipped } : {})
        }, at)
        if (claimed === undefined) return
        return { claimed, extra: { lateByMs, inbox: verdict === "inbox", skipped } }
      })).pipe(
        Effect.flatMap((r) => (typeof r === "object" ? Effect.asVoid(FiberMap.run(runs, r.claimed.id, detached(fire(r.claimed, r.extra)), { startImmediately: true })) : r === "waiting" ? refreshIssues : Effect.void))
      )

    const processDue: Effect.Effect<void, StoreError> = Effect.gen(function*() {
      for (;;) {
        const due = yield* table.due(yield* now, 50)
        for (const job of due) yield* dispatch(job)
        if (due.length < 50) return
        yield* Effect.yieldNow
      }
    })

    /** Sleep until `dueAt` (or forever), woken early by `woken`, by a clock jump, and at least every `jumpCheckMs`. */
    const waitUntil = (dueAt: number | undefined, woken: Deferred.Deferred<void>) =>
      Effect.gen(function*() {
        for (;;) {
          const w0 = yield* now
          if (dueAt !== undefined && w0 >= dueAt) return
          const m0 = yield* monotonicMs
          const chunk = Math.max(1, Math.min(dueAt === undefined ? jumpCheckMs : dueAt - w0, jumpCheckMs))
          const how = yield* Effect.raceFirst(Effect.as(Deferred.await(woken), "woken" as const), Effect.as(Effect.sleep(chunk), "slept" as const))
          if (how === "woken") return
          const jump = ((yield* now) - w0) - ((yield* monotonicMs) - m0)
          if (Math.abs(jump) > JUMP_MS) {
            log(`Scheduler: the wall clock jumped ${jump > 0 ? "forward" : "back"} by ${Math.round(Math.abs(jump) / 1000)} s; checking the jobs again`)
            return
          }
        }
      })

    let lastPrune = 0
    const loop: Effect.Effect<never> = Effect.gen(function*() {
      for (;;) {
        const woken = freshSignal()
        const step = yield* Effect.exit(Effect.gen(function*() {
          yield* processDue
          const at = yield* now
          if (at - lastPrune > DAY / 4) {
            lastPrune = at
            yield* table.prune(at - keepFinishedMs)
          }
          return yield* table.nextDueAt
        }))
        if (Exit.isFailure(step)) {
          if (Cause.hasInterruptsOnly(step.cause)) return yield* Effect.interrupt
          log(`Scheduler: ${messageOf(step.cause)}; trying again in 5 s`)
          yield* Effect.raceFirst(Deferred.await(woken), Effect.sleep(5_000))
          continue
        }
        yield* waitUntil(step.value, woken)
      }
    })

    // ---- Recovery: jobs left `running` (or queued tasks) by a process that stopped

    const recover = Effect.gen(function*() {
      const at = yield* now
      const stuck = yield* table.query({ states: ["running"], limit: 10_000 })
      const queued = yield* table.query({ states: ["scheduled"], kind: "task", limit: 10_000 })
      for (const job of [...stuck, ...queued]) {
        if (job.kind === "task") {
          yield* write(job, { state: "failed", lastError: job.state === "running" ? "Interrupted by a restart" : "Interrupted by a restart before it started" }, at)
          continue
        }
        const notify = job.onDue !== undefined && "notify" in job.onDue
        if ((notify || job.idempotent) && job.attempts <= job.retryLimit) {
          // The same occurrence again: delivered under the same id (deduped), or the idempotent handler run again.
          yield* write(job, { state: "scheduled", dueAt: job.occurrenceAt ?? job.dueAt ?? at, waiting: false }, at)
        } else if (notify || job.idempotent) {
          yield* write(job, { state: "failed", lastError: "Stopped by a restart while it ran, and out of retries" }, at)
        } else if (job.cron !== undefined) {
          yield* write(job, {
            state: "scheduled",
            dueAt: cronNext(job, Math.max(at, job.occurrenceAt ?? at)),
            occurrenceAt: undefined,
            attempts: 0,
            lastError: "Interrupted by a restart while its handler ran (it is not idempotent, so it was not run again)",
            lastFailedAt: at
          }, at)
        } else {
          yield* write(job, { state: "failed", lastError: "Interrupted by a restart while its handler ran (it is not idempotent, so it was not run again)" }, at)
        }
      }
      if (stuck.length + queued.length > 0) log(`Scheduler: recovered ${stuck.length + queued.length} job(s) left running by the last run`)
    })

    yield* recover
    yield* refreshIssues
    yield* Effect.forkIn(loop, scope)

    // ---- The module API

    const originFromTurn = Effect.map(Effect.service(CurrentTurn), (turn): JobOrigin => {
      if (turn === undefined) return {}
      return {
        ...(turn.deviceId !== undefined ? { deviceId: turn.deviceId } : {}),
        ...(turn.assistantId !== undefined ? { assistantId: turn.assistantId } : {}),
        conversationId: turn.conversationId,
        ...(turn.person !== undefined ? { person: turn.person.id } : {})
      }
    })

    const ownJob = (moduleId: string, id: string) =>
      Effect.flatMap(table.get(id).pipe(Effect.mapError(storeFailed)), (job) =>
        job === undefined || job.module !== moduleId
          ? Effect.fail(new SchedulerError({ reason: "not_found", message: `There is no job ${id.slice(0, 60)}` }))
          : Effect.succeed(job))

    const changed = <A>(work: Effect.Effect<A, SchedulerError | StoreError>) =>
      table.transaction(work).pipe(
        Effect.mapError((e) => (e instanceof SchedulerError ? e : storeFailed(e))),
        Effect.tap(() => Effect.sync(wake))
      )

    const lost = (id: string) => new SchedulerError({ reason: "conflict", message: `Job ${id} changed at the same time; try again` })

    const checkRequest = (req: ScheduleRequest): SchedulerError | undefined => {
      if (req.kind === ("task" as string) || !["timer", "alarm", "reminder", "recurring", "deferred"].includes(req.kind)) return invalid(`kind "${String(req.kind)}" cannot be scheduled (tasks use runTask)`)
      if (req.key !== undefined && !KEY.test(req.key)) return invalid("key must be 1 to 200 letters, digits or _ . : @ / -")
      if (req.label !== undefined && req.label.length > 200) return invalid("label is longer than 200 characters")
      const p = policyProblem(req.missed ?? "fire-late")
      if (p !== undefined) return invalid(p)
      if (req.retryLimit !== undefined && !(Number.isInteger(req.retryLimit) && req.retryLimit >= 0 && req.retryLimit <= 20)) return invalid("retryLimit must be 0 to 20")
      const onDue = req.onDue as Record<string, unknown> | undefined
      if (onDue === undefined || (!("notify" in onDue) && !("handler" in onDue))) return invalid("onDue must be { notify } or { handler, payload }")
      if ("handler" in onDue) {
        if (typeof onDue.handler !== "string" || !HANDLER.test(onDue.handler)) return invalid("handler must be a lower-case name (letters, digits, _ . -)")
        const json = jsonSafe(onDue.payload ?? null)
        if (!json.ok) return invalid("payload must be JSON")
        if (json.text.length > MAX_PAYLOAD_CHARS) return invalid(`payload may hold at most ${MAX_PAYLOAD_CHARS} characters of JSON`)
      } else {
        const r = Schema.decodeUnknownResult(NotificationRequest)(onDue.notify)
        if (Result.isFailure(r)) return invalid(`notify is not a notification request: ${String(r.failure.message).slice(0, 300)}`)
      }
      return undefined
    }

    const forModule = (moduleId: string): ModuleScheduler => ({
      schedule: (req) =>
        Effect.gen(function*() {
          const problem = checkRequest(req)
          if (problem !== undefined) return yield* problem
          const at = yield* now
          const first = yield* firstDue(req.when, at)
          const origin = req.origin ?? (yield* originFromTurn)
          const onDue: JobRow["onDue"] = "handler" in req.onDue
            ? { handler: req.onDue.handler, payload: JSON.parse(JSON.stringify(req.onDue.payload ?? null)) }
            : { notify: JSON.parse(JSON.stringify(req.onDue.notify)) }
          const row: JobRow = {
            id: newId(),
            module: moduleId,
            kind: req.kind,
            ...(req.key !== undefined ? { key: req.key } : {}),
            ...(req.label !== undefined ? { label: req.label } : {}),
            state: "scheduled",
            dueAt: first.dueAt,
            ...(first.cron !== undefined ? { cron: first.cron } : {}),
            ...(first.timeZone !== undefined ? { timeZone: first.timeZone } : {}),
            scope: req.scope ?? HOUSEHOLD_SCOPE,
            origin,
            onDue,
            missed: req.missed ?? "fire-late",
            idempotent: req.idempotent === true,
            retryLimit: req.retryLimit ?? 3,
            attempts: 0,
            waiting: false,
            createdAt: at,
            updatedAt: at,
            rev: 1
          }
          return yield* changed(Effect.gen(function*() {
            if (req.key !== undefined) {
              const old = yield* table.liveByKey(moduleId, req.key)
              // A one-off job that is running now (its handler is scheduling its successor: the next occurrence of an
              // RRULE) hands over the key and finishes as it would; any other is replaced.
              const patch = old?.state === "running" && old.cron === undefined ? { key: undefined } : { state: "cancelled" as const, waiting: false }
              if (old !== undefined && (yield* write(old, patch, at)) === undefined) return yield* lost(old.id)
            }
            yield* table.insert(row)
            return row
          }))
        }),

      handle: (name, payload, run, handleOptions) =>
        Effect.gen(function*() {
          const k = handlerKey(moduleId, name)
          const reg: Registration = { schema: payload, run, timeoutMs: handleOptions?.timeoutMs ?? handlerTimeoutMs }
          handlers.set(k, [...(handlers.get(k) ?? []), reg])
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const left = (handlers.get(k) ?? []).filter((r) => r !== reg)
              if (left.length === 0) handlers.delete(k)
              else handlers.set(k, left)
            })
          )
          // Due jobs that waited for this handler fire now (their missed policy decides how).
          const at = yield* now
          yield* table.transaction(Effect.gen(function*() {
            const waiting = (yield* table.query({ module: moduleId, states: ["scheduled"], limit: 10_000 }))
              .filter((j) => j.waiting && j.onDue !== undefined && "handler" in j.onDue && j.onDue.handler === name)
            for (const j of waiting) yield* write(j, { waiting: false }, at)
            return waiting.length
          })).pipe(
            Effect.flatMap((n) => (n > 0 ? refreshIssuesSoon : Effect.void)),
            Effect.catch((e) => Effect.sync(() => log(`Scheduler: waiting jobs of ${moduleId} not released: ${e.message}`)))
          )
          wake()
        }),

      pause: (id) =>
        changed(Effect.gen(function*() {
          const job = yield* ownJob(moduleId, id)
          if (job.kind === "task") return yield* new SchedulerError({ reason: "state", message: "A task cannot be paused; cancel it instead" })
          if (job.state === "paused") return job
          if (job.state !== "scheduled") return yield* new SchedulerError({ reason: "state", message: `The job is ${job.state}; only a scheduled job can be paused` })
          const at = yield* now
          const paused = yield* write(job, {
            state: "paused",
            dueAt: undefined,
            remainingMs: job.cron === undefined ? Math.max(0, (job.dueAt ?? at) - at) : undefined,
            waiting: false
          }, at)
          return paused ?? (yield* lost(id))
        })),

      resume: (id) =>
        changed(Effect.gen(function*() {
          const job = yield* ownJob(moduleId, id)
          if (job.state !== "paused") return yield* new SchedulerError({ reason: "state", message: `The job is ${job.state}, not paused` })
          const at = yield* now
          const resumed = yield* write(job, {
            state: "scheduled",
            dueAt: job.cron !== undefined ? cronNext(job, at) : at + (job.remainingMs ?? 0),
            remainingMs: undefined
          }, at)
          return resumed ?? (yield* lost(id))
        })),

      reschedule: (id, when) =>
        changed(Effect.gen(function*() {
          const job = yield* ownJob(moduleId, id)
          if (job.kind === "task") return yield* new SchedulerError({ reason: "state", message: "A task cannot be rescheduled" })
          if (job.state === "cancelled") return yield* new SchedulerError({ reason: "state", message: "The job was cancelled" })
          const at = yield* now
          const first = yield* firstDue(when, at)
          if (job.key !== undefined && !LIVE_STATES.includes(job.state)) {
            const other = yield* table.liveByKey(moduleId, job.key)
            if (other !== undefined && other.id !== job.id) return yield* new SchedulerError({ reason: "conflict", message: `Another job holds the key ${job.key}` })
          }
          const timing = { cron: first.cron, timeZone: first.timeZone }
          const moved = job.state === "paused"
            ? yield* write(job, { ...timing, remainingMs: first.cron !== undefined ? undefined : Math.max(0, first.dueAt - at) }, at)
            : yield* write(job, { ...timing, state: "scheduled", dueAt: first.dueAt, occurrenceAt: undefined, attempts: 0, waiting: false }, at)
          return moved ?? (yield* lost(id))
        })),

      cancel: (id) =>
        Effect.gen(function*() {
          const job = yield* ownJob(moduleId, id)
          yield* cancelJob(job)
        }),

      list: (filter?: ListFilter) =>
        Effect.map(
          table.query({
            module: moduleId,
            ...(filter?.states === "all" ? {} : { states: filter?.states ?? LIVE_STATES }),
            ...(filter?.kind !== undefined ? { kind: filter.kind } : {}),
            limit: 1000
          }).pipe(Effect.mapError(storeFailed)),
          (rows) =>
            rows.filter((r) =>
              (filter?.key === undefined || r.key === filter.key) && (filter?.scope === undefined || scopeKey(r.scope) === scopeKey(filter.scope))
            )
        ),

      get: (id) => Effect.map(table.get(id).pipe(Effect.mapError(storeFailed)), (j) => (j?.module === moduleId ? j : undefined)),

      runTask: <A, E>(task: TaskRequest<A, E>) =>
        Effect.gen(function*() {
          if (typeof task.label !== "string" || task.label.trim() === "" || task.label.length > 200) return yield* invalid("A task needs a label of at most 200 characters")
          if (task.key !== undefined && !KEY.test(task.key)) return yield* invalid("key must be 1 to 200 letters, digits or _ . : @ / -")
          const at = yield* now
          const row: JobRow = {
            id: newId(),
            module: moduleId,
            kind: "task",
            ...(task.key !== undefined ? { key: task.key } : {}),
            label: task.label,
            state: "scheduled",
            scope: task.scope ?? HOUSEHOLD_SCOPE,
            origin: task.origin ?? (yield* originFromTurn),
            missed: "skip",
            idempotent: false,
            retryLimit: 0,
            attempts: 0,
            waiting: false,
            createdAt: at,
            updatedAt: at,
            rev: 1
          }
          yield* changed(Effect.gen(function*() {
            if (task.key !== undefined && (yield* table.liveByKey(moduleId, task.key)) !== undefined) {
              return yield* new SchedulerError({ reason: "conflict", message: `A task with the key ${task.key} is already running` })
            }
            yield* table.insert(row)
          }))
          yield* FiberMap.run(runs, row.id, detached(runTaskFiber(row, task)), { startImmediately: true })
          return row
        })
    })

    const deliverQuietly = (job: JobRow, request: NotificationRequest | undefined, suffix: string) =>
      request === undefined
        ? Effect.succeed(undefined)
        : Effect.gen(function*() {
          const notificationId = `${job.id}@${suffix}`
          const ok = yield* Effect.exit(delivery.deliver({ ...request, source: { module: job.module, jobId: job.id } }, { notificationId, lateByMs: 0, inbox: false, job }))
          if (Exit.isFailure(ok)) {
            log(`Scheduler: the notification of task ${job.id} was not delivered: ${messageOf(ok.cause)}`)
            return undefined
          }
          return { notificationId, at: yield* now, lateByMs: 0, inbox: false }
        })

    const runTaskFiber = <A, E>(row: JobRow, task: TaskRequest<A, E>) =>
      taskSlots.withPermits(1)(Effect.gen(function*() {
        const start = yield* now
        const current = yield* table.get(row.id)
        if (current?.state !== "scheduled") return
        const running = yield* write(current, { state: "running", attempts: 1, lastRunAt: start }, start)
        if (running === undefined) return
        const exit = yield* Effect.exit(Effect.suspend(() => task.work))
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
        const at = yield* now
        const latest = yield* table.get(row.id)
        if (latest === undefined || latest.state !== "running") return
        if (Exit.isSuccess(exit)) {
          const recorded = jsonSafe(task.result !== undefined ? task.result(exit.value) : exit.value)
          const result = recorded.ok ? (recorded.text.length <= MAX_RESULT_CHARS ? JSON.parse(recorded.text) : recorded.text.slice(0, MAX_RESULT_CHARS)) : undefined
          const delivered = yield* deliverQuietly(latest, task.onDone?.(exit.value), "done")
          yield* write(latest, { state: "done", ...(result !== undefined ? { result } : {}), ...(delivered !== undefined ? { delivered } : {}) }, at)
        } else {
          const message = messageOf(exit.cause)
          const delivered = yield* deliverQuietly(latest, task.onFailed?.(message), "failed")
          yield* write(latest, { state: "failed", lastError: message, ...(delivered !== undefined ? { delivered } : {}) }, at)
          yield* refreshIssues
        }
      })).pipe(Effect.catch((e) => Effect.sync(() => log(`Scheduler: task ${row.id} not recorded: ${e.message}`))))

    const cancelJob = (job: JobRow) =>
      Effect.gen(function*() {
        if (!LIVE_STATES.includes(job.state) && job.state !== "failed") return false
        const at = yield* now
        const done = yield* changed(write(job, { state: "cancelled", waiting: false }, at))
        if (done === undefined) return yield* lost(job.id)
        // A task's fiber is interrupted; a handler that is running finishes, and its job stays cancelled.
        if (job.kind === "task") yield* FiberMap.remove(runs, job.id)
        if (job.state === "failed" || job.waiting || job.lastFailedAt !== undefined || isOrphan(job.module)) yield* refreshIssuesSoon
        return true
      })

    const counts: Effect.Effect<SchedulerCounts, SchedulerError> = Effect.gen(function*() {
      const live = yield* table.query({ states: LIVE_STATES, limit: 10_000 })
      const failed = yield* table.query({ states: ["failed"], limit: 10_000 })
      return {
        live: live.length,
        failed: failed.length + live.filter((j) => j.lastFailedAt !== undefined).length,
        waiting: live.filter((j) => j.waiting).length,
        orphaned: live.filter((j) => isOrphan(j.module)).length,
        tasksRunning: live.filter((j) => j.kind === "task" && j.state === "running").length
      }
    }).pipe(Effect.mapError(storeFailed))

    const engine: SchedulerEngine = {
      forModule,
      setDelivery: (d) => {
        delivery = d
      },
      listAll: (listOptions) =>
        Effect.map(table.query({ limit: listOptions?.limit ?? 500 }).pipe(Effect.mapError(storeFailed)), (rows) =>
          rows.map((job): JobView => ({ job, moduleName: moduleName(job.module), orphaned: isOrphan(job.module) }))),
      cancelAny: (id) =>
        Effect.flatMap(table.get(id).pipe(Effect.mapError(storeFailed)), (job) => (job === undefined ? Effect.succeed(false) : Effect.as(cancelJob(job), true))),
      counts,
      wake,
      refreshIssues
    }
    return engine
  })

const describeJob = (j: JobRow) => j.label ?? j.key ?? (j.onDue !== undefined && "handler" in j.onDue ? j.onDue.handler : j.kind)

/**
 * The scheduler's Health issues (source `scheduler`; `pnpm start doctor` reads the same from the database): each failed
 * job, each recurring job whose last run failed, the jobs of each module that wait for its handler, and the jobs of
 * each module that is no longer in the catalogue.
 */
export const schedulerIssues = (input: {
  readonly live: ReadonlyArray<JobRow>
  readonly failed: ReadonlyArray<JobRow>
  readonly moduleName: (id: string) => string
  readonly isOrphan: (id: string) => boolean
}): ReadonlyArray<Issue> => {
  const { failed, isOrphan, live, moduleName } = input
  const list: Array<Issue> = []
  const fix = { kind: "link" as const, label: "Open Scheduled jobs", value: "#settings/diagnostics/scheduled" }
  const known = (m: string) => (isOrphan(m) ? {} : { module: m })
  for (const j of failed) {
    list.push({
      id: `core.scheduler.failed.${j.id}`,
      ...known(j.module),
      severity: "warning",
      title: `A ${j.kind} of ${moduleName(j.module)} failed: ${describeJob(j)}`.slice(0, 200),
      detail: (j.lastError ?? "").slice(0, 1900),
      fix
    })
  }
  for (const j of live.filter((x) => x.lastFailedAt !== undefined)) {
    list.push({
      id: `core.scheduler.failed.${j.id}`,
      ...known(j.module),
      severity: "warning",
      title: `The last run of ${describeJob(j)} (${moduleName(j.module)}) failed`.slice(0, 200),
      detail: `${(j.lastError ?? "").slice(0, 1500)} It runs again at its next time.`,
      fix
    })
  }
  const byModule = (rows: ReadonlyArray<JobRow>) => {
    const m = new Map<string, Array<JobRow>>()
    for (const r of rows) m.set(r.module, [...(m.get(r.module) ?? []), r])
    return m
  }
  for (const [m, rows] of byModule(live.filter((x) => x.waiting && !isOrphan(x.module)))) {
    const one = rows.length === 1
    list.push({
      id: `core.scheduler.waiting.${m}`,
      module: m,
      severity: "warning",
      title: `${rows.length} job${one ? "" : "s"} of ${moduleName(m)} wait${one ? "s" : ""} for the module to run`,
      detail: `Due, but ${moduleName(m)} is not running, so ${one ? "it" : "they"} cannot fire (${rows.slice(0, 3).map(describeJob).join(", ")}). ` +
        "They fire when the module runs again, as their missed policy allows; an assistant must have the module on.",
      fix
    })
  }
  for (const [m, rows] of byModule(live.filter((x) => isOrphan(x.module)))) {
    const one = rows.length === 1
    list.push({
      id: `core.scheduler.orphaned.${m}`,
      severity: "warning",
      title: `${rows.length} scheduled job${one ? "" : "s"} of a removed module (${m})`,
      detail: "The module is no longer installed. Its notifications still fire; anything else waits. Cancel them on the Scheduled jobs page.",
      fix
    })
  }
  return list
}

/** A short summary of counts: "4 scheduled, 1 failed, 2 waiting for their module". */
export const describeCounts = (c: SchedulerCounts): string =>
  [
    `${c.live} scheduled`,
    ...(c.failed > 0 ? [`${c.failed} failed`] : []),
    ...(c.waiting > 0 ? [`${c.waiting} waiting for their module`] : []),
    ...(c.orphaned > 0 ? [`${c.orphaned} of removed modules`] : []),
    ...(c.tasksRunning > 0 ? [`${c.tasksRunning} task${c.tasksRunning === 1 ? "" : "s"} running`] : [])
  ].join(", ")
