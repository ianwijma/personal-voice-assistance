import { Effect, Schema } from "effect"
import type { StoreTx } from "./HouseholdStore.ts"
import type { ModuleStopped } from "./ModuleApi.ts"
import type { PartHandle } from "./ModuleRegistrations.ts"
import type { TurnPerson } from "./TurnContext.ts"

/**
 * The scheduler (docs/MODULES-PLAN.md §4 P6; docs/SCHEDULING.md): it calls a module's handler at a time, once. This
 * file is the contract; `SchedulerEngine.ts` implements it on the household store (one collection, `jobs`, of the
 * core owner `core.scheduler`), the same in serve mode (SQLite) and in `@pva/core/testing` (in memory).
 *
 * - A **job** is one row: the module, the handler's name, an optional key (one live job per module and key), a JSON
 *   payload of at most `MAX_PAYLOAD_CHARS`, when it is due (`at`, `inMs`, or a `cron` expression), what to do when it
 *   is found late (`late`), and its origin (the device, assistant and person it was made for).
 * - A **handler** is a registration of the part that declared it (`ctx.scheduler.handle` during `shared` or `start`):
 *   published and withdrawn with its module. A job runs only while its handler is published; until then it waits,
 *   `scheduled`, however late.
 * - **Once**: a due job is claimed in a transaction (`running`, attempt + 1) and its outcome is written in a second one
 *   that is conditional on the claim's revision, so a job rescheduled or cancelled while it ran ignores that run.
 *
 * Nothing else: no pause and resume (cancel and schedule again), no background tasks (a fiber in the module's own
 * scope), no notification jobs (P9 registers a handler of its own).
 */

// ---------------------------------------------------------------------------------------------------------------------
// Limits

/** The owner of the scheduler's collections in the household store. */
export const SCHEDULER_OWNER = "core.scheduler" as const
/** The most characters of a job's payload, as JSON. */
export const MAX_PAYLOAD_CHARS = 1_000
/** The most live (`scheduled` or `running`) jobs of one module. */
export const MAX_LIVE_JOBS = 200
/** A handler's name: lower case letters, digits and `_ . -`, starting with a letter, at most 64. */
export const HANDLER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/
/** A job's key: 1–100 letters, digits and `_ . : @ / -`. */
export const JOB_KEY = /^[A-Za-z0-9_.:@/-]{1,100}$/
/** An id in a job's origin (an assistant, a device, a person): 1–64 letters, digits and `_ . : -` (every real one fits). */
export const ORIGIN_ID = /^[A-Za-z0-9_.:-]{1,64}$/
/**
 * The longest `cron` expression. `cron` is for system jobs (refreshing a cache): minute, hour and day-of-week patterns,
 * with an optional seconds field first; its day-of-month and month fields must be `*`. A date ("the 1st of each month")
 * is a one-off job that schedules the next one from its handler.
 */
export const MAX_CRON_CHARS = 100
/** The latest time a job can be due (epoch ms; the end of JavaScript's date range). Times are whole milliseconds. */
export const MAX_TIME = 8.64e15
/** The most characters a stored failure text takes as JSON (`JobRow.lastError`; well-formed, one line). */
export const MAX_ERROR_CHARS = 200
/** A handler's time limit when it declares none (it covers decoding the payload too). */
export const DEFAULT_HANDLER_TIMEOUT_MS = 60_000
/** The longest time limit a handler may declare. */
export const MAX_HANDLER_TIMEOUT_MS = 10 * 60_000
/** Retries of an idempotent handler when it declares none. */
export const DEFAULT_RETRIES = 3
/** The most retries a handler may declare. */
export const MAX_RETRIES = 10
/** Finished jobs (`done`, `failed`, `cancelled`, `missed`) are removed this long after they finished. */
export const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000
// ---------------------------------------------------------------------------------------------------------------------
// Jobs

/**
 * `scheduled`: waiting for its due time (and for its handler to be published); `running`: claimed, its handler runs (or
 * ran in a process that stopped: the recovery rule decides); `done`; `failed`: its handler failed and will not run
 * again for it (a Health issue until it is cancelled or removed); `cancelled`; `missed`: it was found later than its
 * `late` allows, and its handler was not called. A repeating job stays live: after each occurrence it is `scheduled`
 * for the next one.
 */
export type JobState = "scheduled" | "running" | "done" | "failed" | "cancelled" | "missed"
export const JOB_STATES: ReadonlyArray<JobState> = ["scheduled", "running", "done", "failed", "cancelled", "missed"]
export const LIVE_STATES: ReadonlyArray<JobState> = ["scheduled", "running"]

/**
 * What to do with a job found late: `"run"` (the default: run it once, however late) or `{ withinMs }` (run it only if
 * it is at most that late; otherwise it becomes `missed`, or a repeating job moves on to its next occurrence, and the
 * handler is not called). There is no grace beyond what the job says.
 */
export type LatePolicy = "run" | { readonly withinMs: number }

/**
 * Who a job is for: the assistant, device and person of the turn or job that scheduled it, unless the caller gives
 * one. Its handler runs with this as its principal (`CurrentJob`), through the execution gateway.
 */
export interface ScheduleOrigin {
  readonly assistantId?: string
  readonly deviceId?: string
  readonly person?: TurnPerson
}

/** When a job is due: a time (epoch ms), a delay from now, or a `Cron` expression (in its zone, else the household's). */
export type ScheduleWhen =
  | { readonly at: number; readonly inMs?: never; readonly cron?: never; readonly timeZone?: never }
  | { readonly inMs: number; readonly at?: never; readonly cron?: never; readonly timeZone?: never }
  | { readonly cron: string; readonly timeZone?: string; readonly at?: never; readonly inMs?: never }

export type ScheduleRequest = {
  /** The name of a handler of the same module (`handle`). */
  readonly handler: string
  /** JSON (stored as `JSON.stringify` gives it), at most `MAX_PAYLOAD_CHARS`: the handler's schema decodes it. */
  readonly payload?: unknown
  /** One live job per module and key: scheduling the same key again replaces the live one (it is `cancelled`). */
  readonly key?: string
  /** Default `"run"`. */
  readonly late?: LatePolicy
  /** Default: the turn's (`CurrentTurn`), or, inside a handler, its job's (`CurrentJob`). */
  readonly origin?: ScheduleOrigin
} & ScheduleWhen

/** A new due time for a live job (`reschedule`). */
export type RescheduleWhen = { readonly at: number; readonly inMs?: never } | { readonly inMs: number; readonly at?: never }

/** A job as `get`, `list` and the admin page see it. */
export interface JobRow {
  readonly id: string
  /** The module (or `core.<name>`) that owns it. */
  readonly module: string
  readonly handler: string
  readonly key?: string
  readonly payload: unknown
  readonly state: JobState
  /** Live: when it is due next (running: the occurrence it runs for). Finished: its last due time. */
  readonly dueAt: number
  readonly cron?: string
  /** The cron's own zone; absent: the household's zone, read each time its next occurrence is planned. */
  readonly timeZone?: string
  readonly late: LatePolicy
  readonly origin: ScheduleOrigin
  /** Runs of its current occurrence so far (0 before the first). */
  readonly attempt: number
  /**
   * Why its last run failed: passed through the page boundary of its module in full, then made one well-formed line of
   * at most `MAX_ERROR_CHARS` characters as JSON.
   */
  readonly lastError?: string
  /**
   * When its last run failed. A repeating job keeps it (and `lastError`) until an occurrence succeeds, however many it
   * misses meanwhile: a Health issue until then.
   */
  readonly failedAt?: number
  readonly finishedAt?: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly rev: number
}

/** What a handler is told about the run. */
export interface DueInfo {
  readonly jobId: string
  readonly key?: string
  /** The occurrence it runs for (a repeating job found late: the latest one at or before now). */
  readonly dueAt: number
  /** How late it runs: now − `dueAt` (0 when on time). */
  readonly lateMs: number
  /** 1 on the first run of this occurrence, 2 on the first retry… */
  readonly attempt: number
}

/** A handler (`handle`). */
export interface JobHandler<P, I> {
  /** Decodes the stored payload (its JSON form, `Schema.toCodecJson`); one that does not decode fails the run. */
  readonly payload: Schema.Codec<P, I>
  /**
   * It may run again for the same occurrence: after it failed, timed out, or was interrupted without telling (the
   * server stopped, its module stopped, its outcome could not be saved). Default false: such a run is `failed`.
   */
  readonly idempotent?: boolean
  /** Retries of an idempotent handler (back-off 5 s, 10 s, 20 s, …). Default `DEFAULT_RETRIES`, at most `MAX_RETRIES`. */
  readonly retries?: number
  /** Default `DEFAULT_HANDLER_TIMEOUT_MS`, 100 ms to `MAX_HANDLER_TIMEOUT_MS`; it covers decoding the payload. */
  readonly timeoutMs?: number
  readonly run: (payload: P, due: DueInfo) => Effect.Effect<void, unknown>
}

/** `list`: the module's live jobs by due time, a page at a time. */
export interface JobListQuery {
  /** Only the live job of this key (at most one). */
  readonly key?: string
  /** The last row of the previous page of the same query (a row `list` returned; not a copy). */
  readonly after?: JobRow
  /** Default and at most `MAX_JOB_PAGE` (`maxListRows(jobs)`). */
  readonly limit?: number
}

/**
 * Why a scheduler call failed. `unavailable`: no scheduler here (the CLI modes; a module words it: "timers run only on
 * the server"); `invalid`: the request is wrong (an unknown field, a cron expression that does not parse, never
 * fires, or names a day of month or a month (`MAX_CRON_CHARS`), a payload that is not JSON or too long); `state`: the job cannot do that now (reschedule a finished job, a
 * handler registered after the start); `limit`: `MAX_LIVE_JOBS` live jobs already; `busy`: the store was busy, try
 * again; `failed`: the store said no.
 */
export class SchedulerError extends Schema.TaggedError<SchedulerError>()("SchedulerError", {
  reason: Schema.Literals(["unavailable", "invalid", "state", "limit", "busy", "failed"]),
  message: Schema.String
}) {}

/**
 * A job checked and ready to be written inside the caller's own transaction (`ModuleScheduler.prepare`): its id, due
 * time and origin are decided; `writeIn` writes it.
 */
export interface PreparedJob {
  readonly id: string
  readonly dueAt: number
  /**
   * Write the job inside a running transaction of the module (`ctx.store.transaction((tx) => … job.writeIn(tx) …)`):
   * synchronous, part of that transaction (it commits or rolls back with the module's own writes), and the engine is
   * woken after the commit. Everything that can refuse is checked before its first write, so a refusal leaves the
   * transaction as it was: `StoreError` `invalid` for `MAX_LIVE_JOBS`, for a prepared job written already and for a
   * handle used outside its function (it may be caught to commit the rest). Any other failure is the store's, in the
   * middle of the job's writes: it must not be caught to go on with the same transaction (docs/SCHEDULING.md "Inside
   * your own transaction"). Write a prepared job once.
   */
  readonly writeIn: (tx: StoreTx) => JobRow
}

/**
 * `ctx.scheduler` of a version 2 module (docs/SCHEDULING.md). Every call stops with `ModuleStopped` once the part it
 * was given to has closed, like the store handle.
 */
export interface ModuleScheduler {
  /**
   * Register the handler `name` of this module, during `shared` or `start`: a registration of the part, published and
   * withdrawn with its module. Two handlers of one module with the same name refuse its start. After the start: `state`.
   */
  readonly handle: <P, I>(name: string, handler: JobHandler<P, I>) => Effect.Effect<void, SchedulerError>
  /** Store a job (one synchronous transaction; replacing the live job of its key) and wake the engine. */
  readonly schedule: (request: ScheduleRequest) => Effect.Effect<JobRow, SchedulerError>
  /** Check a job and decide its id, time and origin, to write it inside the module's own transaction (`PreparedJob`). */
  readonly prepare: (request: ScheduleRequest) => Effect.Effect<PreparedJob, SchedulerError>
  /**
   * Stop a live job (`scheduled` or `running`), or dismiss a `failed` one: it becomes `cancelled`. A running handler is
   * not interrupted; what it then reports is ignored. `false`: no such job of this module, or it had finished already.
   */
  readonly cancel: (target: string | { readonly key: string }) => Effect.Effect<boolean, SchedulerError>
  /**
   * A new due time for a live job (`scheduled` again, attempt 0). For a running one, the outcome of the present run is
   * ignored. A repeating job continues from its cron after this occurrence. A finished job: `state`. No job: `undefined`.
   */
  readonly reschedule: (id: string, when: RescheduleWhen) => Effect.Effect<JobRow | undefined, SchedulerError>
  /** One of this module's jobs (live or finished, until it is removed seven days after it finished). */
  readonly get: (id: string) => Effect.Effect<JobRow | undefined, SchedulerError>
  /** This module's live jobs by due time, one page (`JobListQuery`); continue with `after`. */
  readonly list: (query?: JobListQuery) => Effect.Effect<ReadonlyArray<JobRow>, SchedulerError>
}

/**
 * The scheduler of a mode without one (the CLI modes, whose store is read-only; a host made without a scheduler):
 * `handle` registers nothing and succeeds, so a module still starts; every other call fails `unavailable`.
 */
export const closedModuleScheduler = (reason: string): ModuleScheduler => {
  const fail = Effect.fail(new SchedulerError({ reason: "unavailable", message: reason }))
  return {
    handle: () => Effect.void,
    schedule: () => fail,
    prepare: () => fail,
    cancel: () => fail,
    reschedule: () => fail,
    get: () => fail,
    list: () => fail
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The module host's side

/** What the module host gives the scheduler for one part, with the part's `PartHandle`. */
export interface PartRunner {
  /**
   * Run `body` as a call in flight of the part's published module (the host's guard, as a tool call is): refused with
   * `ModuleStopped` when the part is not published; when its module stops, given the grace period and then interrupted
   * (it fails with `ModuleStopped`).
   */
  readonly inFlight: <A, E>(body: () => Effect.Effect<A, E>) => Effect.Effect<A, E | ModuleStopped>
}

/**
 * `ModuleHostOptions.scheduler` (`SchedulerEngine.forPart`): `ctx.scheduler` of one part of a version 2 module, made
 * in `servicesFor`. Its handlers register through `part.register` (`ModuleRegistrations.ts`).
 */
export interface SchedulerHook {
  readonly forPart: (part: PartHandle, runner: PartRunner) => ModuleScheduler
}

// ---------------------------------------------------------------------------------------------------------------------
// The admin view

/** One job in the admin list. */
export interface JobView {
  readonly job: JobRow
  /** The module's name, or its id when it is not in the catalogue (`orphaned`). */
  readonly moduleName: string
  /** Its module is not in the catalogue (removed): the owner cancels its jobs. */
  readonly orphaned: boolean
}

/** One page of the admin list: live jobs by due time, then finished ones newest first. */
export interface JobPage {
  readonly jobs: ReadonlyArray<JobView>
  /** Pass it back for the next page; absent: there is no more. */
  readonly next?: string
}
