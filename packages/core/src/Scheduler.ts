import { Effect, Schema, type Scope } from "effect"
import type { ScopeRef } from "./HouseholdStore.ts"

/**
 * The scheduler (docs/MODULES-PLAN.md §4 P6; shared-state-jobs-and-notifications.md §6; docs/SCHEDULING.md): jobs that
 * fire at a wall-clock time, after a delay or on a `Cron` schedule, and tasks that run in the background after the
 * turn that started them. This file is the contract; `SchedulerEngine.ts` implements it on a job table (the
 * household store's `core_scheduler__jobs` in serve mode, an in-memory table in `@pva/core/testing`).
 *
 * - **Durable.** A job is a row; it survives a restart and fires at the same wall-clock time, or at start with its
 *   missed policy applied.
 * - **Exactly once as far as one process can give it.** Every occurrence has a stable key (`<jobId>@<dueAt>`), a due
 *   job is claimed in a transaction before it runs, and only an `idempotent` handler is ever run again for the same
 *   occurrence. A `{ notify }` job is always delivered again under the same notification id after a crash: the
 *   notification service dedupes it.
 * - **Namespaced.** `ctx.scheduler` sees and changes only its own module's jobs.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Notification requests (the part the scheduler stores; P9 owns their meaning)

/**
 * What a `{ notify }` job delivers when it is due, or what a task's `onDone` returns (shared-state §8.1). The scheduler
 * stores it as given and hands it to the `NotificationDelivery`; the notification service (P9) decides what each field
 * does (ringing, audiences, priorities and their caps). `source` is filled in by the scheduler.
 */
export const NotificationRequest = Schema.Struct({
  source: Schema.optionalKey(Schema.Struct({ module: Schema.String, jobId: Schema.optionalKey(Schema.String) })),
  /** A second send with the same key updates the first instead of adding one ("timer:<id>"). */
  dedupeKey: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["alert", "timer", "alarm", "reminder", "info", "result", "question"]),
  priority: Schema.Literals(["critical", "high", "normal", "low"]),
  audience: Schema.optionalKey(Schema.Union([
    Schema.Struct({ household: Schema.Literal(true) }),
    Schema.Struct({ person: Schema.String }),
    Schema.Struct({ devices: Schema.Array(Schema.String) }),
    Schema.Struct({ room: Schema.String })
  ])),
  origin: Schema.optionalKey(Schema.Struct({
    deviceId: Schema.optionalKey(Schema.String),
    assistantId: Schema.optionalKey(Schema.String),
    conversationId: Schema.optionalKey(Schema.String)
  })),
  ring: Schema.optionalKey(Schema.Literals(["origin", "origin-then-room", "origin-then-everywhere", "everywhere", "none"])),
  content: Schema.Struct({
    title: Schema.String,
    spoken: Schema.optionalKey(Schema.String),
    cue: Schema.optionalKey(Schema.String),
    actions: Schema.optionalKey(Schema.Array(Schema.String))
  }),
  followUp: Schema.optionalKey(Schema.Struct({
    assistantId: Schema.String,
    record: Schema.Boolean,
    listenSeconds: Schema.optionalKey(Schema.Finite)
  })),
  expiresAt: Schema.optionalKey(Schema.Finite),
  requireAck: Schema.optionalKey(Schema.Boolean),
  channels: Schema.optionalKey(Schema.Array(Schema.Literals(["device-audio", "device-visual", "phone"])))
})
export type NotificationRequest = typeof NotificationRequest.Type

/** What the scheduler tells the delivery about one delivery. */
export interface DeliveryInfo {
  /**
   * The occurrence key (`<jobId>@<dueAt>`, or `<jobId>@done` for a task's result): the same for every redelivery of
   * one occurrence, so the notification service can drop a second one.
   */
  readonly notificationId: string
  /** How late the delivery is (0 when on time). A late timer says "went off 3 minutes ago". */
  readonly lateByMs: number
  /** The job's missed policy sent it to the inbox: record it, do not ring. */
  readonly inbox: boolean
  readonly job: JobRow
}

/**
 * How a notification leaves the scheduler (`SchedulerOptions.delivery`, `Scheduler.setDelivery`). The default
 * (`logDelivery`) logs it; the scheduler records every delivery on its job (`JobRow.delivered`). P9's notification
 * service replaces it. A failure is retried with back-off up to the job's retry limit, under the same id.
 */
export interface NotificationDelivery {
  readonly deliver: (request: NotificationRequest, info: DeliveryInfo) => Effect.Effect<void, unknown>
}

/** The delivery until P9: one log line per notification. */
export const logDelivery = (log: (line: string) => void): NotificationDelivery => ({
  deliver: (request, info) =>
    Effect.sync(() =>
      log(
        `Notification ${info.notificationId} (${request.kind}, ${request.priority}${info.inbox ? ", inbox" : ""}${
          info.lateByMs > 0 ? `, ${Math.round(info.lateByMs / 1000)} s late` : ""
        }): ${request.content.title}`
      )
    )
})

// ---------------------------------------------------------------------------------------------------------------------
// Jobs

/** shared-state §6.1. `deferred`: a deferred command ("turn off the oven in 10 minutes"). `task`: `runTask` only. */
export type JobKind = "timer" | "alarm" | "reminder" | "recurring" | "task" | "deferred"
export const JOB_KINDS: ReadonlyArray<JobKind> = ["timer", "alarm", "reminder", "recurring", "task", "deferred"]

/**
 * `scheduled`: waiting for its due time (or, for a task, for a free slot); `paused`; `running`: claimed and firing;
 * `done`; `cancelled`; `failed`: its handler failed (or was interrupted) and will not be run again; `missed`: its due
 * time passed while the server was down and its missed policy said not to fire (or sent it to the inbox).
 */
export type JobState = "scheduled" | "paused" | "running" | "done" | "cancelled" | "failed" | "missed"
export const LIVE_STATES: ReadonlyArray<JobState> = ["scheduled", "paused", "running"]

/** When: an absolute time (epoch ms), a delay from now, or a `Cron` expression in a time zone (default `HOME_TIME_ZONE`). */
export type JobWhen =
  | { readonly at: number }
  | { readonly inMs: number }
  | { readonly cron: string; readonly timeZone?: string }

/**
 * What to do with an occurrence found late (the server was down, or its handler was not registered at its due time),
 * more than `ON_TIME_MS` after it was due:
 * - `fire-late`: fire it; the handler or notification is told how late (`lateByMs`);
 * - `{ fireIfWithinMs }`: fire it when it is at most that late, otherwise `missed` (or, with `otherwise: "inbox"`, to
 *   the inbox);
 * - `skip`: do not fire it (a one-off job becomes `missed`; a recurring one moves on);
 * - `inbox`: deliver it to the inbox instead of ringing (a handler is told `inbox: true`); the job ends `missed`.
 *
 * A recurring job that missed several occurrences runs only the last one, once (`DueInfo.skipped` says how many were
 * left out).
 */
export type MissedPolicy =
  | "fire-late"
  | "skip"
  | "inbox"
  | { readonly fireIfWithinMs: number; readonly otherwise?: "missed" | "inbox" }

/** A job found due this much after its due time or less is on time; the missed policy applies only beyond it. */
export const ON_TIME_MS = 60_000

/** Who a job is for and where it came from (filled from `CurrentTurn` when the call does not say). */
export interface JobOrigin {
  readonly deviceId?: string
  readonly assistantId?: string
  readonly conversationId?: string
  readonly person?: string
}

/**
 * What happens when it is due: deliver a notification (data only: it fires even while the module is not running), or
 * run a handler the module registered with `handle`, with a JSON payload decoded by the handler's schema.
 */
export type JobOnDue =
  | { readonly notify: NotificationRequest }
  | { readonly handler: string; readonly payload: unknown }

export interface ScheduleRequest {
  readonly kind: Exclude<JobKind, "task">
  /** One live job per module and key ("timer:pasta"): scheduling the same key again replaces it. */
  readonly key?: string
  /** For the admin list and logs: "Pasta timer". */
  readonly label?: string
  readonly when: JobWhen
  /** Default household. */
  readonly scope?: ScopeRef
  /** Default: from `CurrentTurn` (device, assistant, conversation, person). */
  readonly origin?: JobOrigin
  readonly onDue: JobOnDue
  /** Default `fire-late`. */
  readonly missed?: MissedPolicy
  /**
   * A handler job's handler may be run again for the same occurrence (after a failure, or when the server stopped
   * while it ran). Default false: a failure or an interruption marks the job `failed` and raises a Health issue.
   * `{ notify }` jobs are always delivered again under the same notification id.
   */
  readonly idempotent?: boolean
  /** Retries after a failure, for an idempotent handler or a notification (back-off 5 s, 10 s, 20 s, …). Default 3. */
  readonly retryLimit?: number
}

/** A job as stored (and as `list`, `get` and the admin page see it). */
export interface JobRow {
  readonly id: string
  readonly module: string
  readonly kind: JobKind
  readonly key?: string
  readonly label?: string
  readonly state: JobState
  /** The next due time (epoch ms). Absent while paused and for tasks. */
  readonly dueAt?: number
  /** Time left when it was paused (a one-off job). */
  readonly remainingMs?: number
  readonly cron?: string
  readonly timeZone?: string
  readonly scope: ScopeRef
  readonly origin: JobOrigin
  /** Absent for a task. */
  readonly onDue?: JobOnDue
  readonly missed: MissedPolicy
  readonly idempotent: boolean
  readonly retryLimit: number
  /** Runs of the current occurrence so far (1 on its first run). */
  readonly attempts: number
  /** The due time of the occurrence being run or retried: with the id, the occurrence key. */
  readonly occurrenceAt?: number
  /** It is due and its handler is not registered (the module is not running): it fires when the handler appears. */
  readonly waiting: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastRunAt?: number
  /** Why the last run failed (kept on a recurring job that moved on). */
  readonly lastError?: string
  /** A recurring job's last occurrence failed (a Health issue until one succeeds). */
  readonly lastFailedAt?: number
  /** The last notification delivered for it. */
  readonly delivered?: { readonly notificationId: string; readonly at: number; readonly lateByMs: number; readonly inbox: boolean }
  /** A finished task's result (JSON, at most 4000 characters). */
  readonly result?: unknown
  /** Occurrences of a recurring job left out because the server was down (only the last one ran). */
  readonly skipped?: number
  readonly rev: number
}

/** What a handler is told about the occurrence it runs for. */
export interface DueInfo {
  readonly job: JobRow
  /** `<jobId>@<dueAt>`: the same on every retry of this occurrence. */
  readonly occurrenceKey: string
  readonly dueAt: number
  /** How late it runs (0 when on time). */
  readonly lateByMs: number
  /** 1 on the first run of this occurrence, 2 on the first retry… */
  readonly attempt: number
  /** The missed policy sent it to the inbox: record it, do not ring. */
  readonly inbox: boolean
  /** Occurrences of a recurring job left out before this one. */
  readonly skipped: number
}

export interface ListFilter {
  readonly kind?: JobKind
  readonly key?: string
  readonly scope?: ScopeRef
  /** Default the live states (`scheduled`, `paused`, `running`); `"all"` includes finished jobs (kept 7 days). */
  readonly states?: ReadonlyArray<JobState> | "all"
}

/** A background task (`runTask`): a fiber in the scheduler's scope that outlives the turn. */
export interface TaskRequest<A, E> {
  readonly label: string
  readonly key?: string
  readonly scope?: ScopeRef
  /** Default: from `CurrentTurn`. */
  readonly origin?: JobOrigin
  readonly work: Effect.Effect<A, E>
  /** What is recorded on its row (JSON, cut at 4000 characters). Default: the value itself when it is JSON. */
  readonly result?: (a: A) => unknown
  /** A notification to deliver when it is done ("Your research on … is ready"). */
  readonly onDone?: (a: A) => NotificationRequest | undefined
  /** A notification to deliver when it failed or was interrupted by a restart. */
  readonly onFailed?: (message: string) => NotificationRequest | undefined
}

/**
 * Why a scheduler call failed. `unavailable`: no scheduler in this mode (the CLI modes, where the store is read-only;
 * a module words it: "timers run only on the server"); `invalid`: the request is wrong (a bad cron expression, a time
 * zone, a payload that is not JSON); `not_found`: no such job of this module; `state`: the job cannot do that now
 * (pause a job that is running); `conflict`: another live job holds the key; `failed`: the store said no.
 */
export class SchedulerError extends Schema.TaggedError<SchedulerError>()("SchedulerError", {
  reason: Schema.Literals(["unavailable", "invalid", "not_found", "state", "conflict", "failed"]),
  message: Schema.String
}) {}

/** `ctx.scheduler` of a version 2 module (shared-state §6.2). */
export interface ModuleScheduler {
  /**
   * Store a job and wake the engine. Inside `ctx.store.transaction(...)` it commits or rolls back with the module's own
   * writes (a timer row and its job are one transaction). Two single-row writes at most (the key's old job, the new
   * one): fine on the turn path.
   */
  readonly schedule: (job: ScheduleRequest) => Effect.Effect<JobRow, SchedulerError>
  /**
   * Register the handler `name` for this module's `{ handler }` jobs, until the scope closes (call it in `shared`). The
   * payload is decoded with `payload` when a job fires; a payload that does not decode fails the occurrence (not
   * retried). A later registration of the same name (a new generation of the shared part) replaces the earlier one
   * at once; closing the earlier scope then removes nothing that is live. Due jobs that waited for it fire now,
   * subject to their missed policy.
   */
  readonly handle: <P, I>(
    name: string,
    payload: Schema.Codec<P, I>,
    run: (payload: P, due: DueInfo) => Effect.Effect<void, unknown>,
    options?: { readonly timeoutMs?: number }
  ) => Effect.Effect<void, never, Scope.Scope>
  /** A scheduled job stops; a one-off job keeps its time left (`remainingMs`). */
  readonly pause: (id: string) => Effect.Effect<JobRow, SchedulerError>
  /** A paused job continues: a one-off job is due after its time left; a recurring one at its next occurrence. */
  readonly resume: (id: string) => Effect.Effect<JobRow, SchedulerError>
  /**
   * A new time ("add five minutes": `{ at: dueAt + 300_000 }`), or a new cron. A paused one-off job stays paused with
   * the new time left. A job that already fired (`done`, `missed`, `failed`) is scheduled again.
   */
  readonly reschedule: (id: string, when: JobWhen) => Effect.Effect<JobRow, SchedulerError>
  /** It will not fire again; a running handler or task is interrupted. Cancelling a finished job is a no-op. */
  readonly cancel: (id: string) => Effect.Effect<void, SchedulerError>
  readonly list: (filter?: ListFilter) => Effect.Effect<ReadonlyArray<JobRow>, SchedulerError>
  readonly get: (id: string) => Effect.Effect<JobRow | undefined, SchedulerError>
  /**
   * Start a task now (or as soon as one of the two slots is free): a fiber in the scheduler's scope, so it outlives the
   * turn and the conversation. Its row records the result or the failure; `cancel` interrupts it. A task found
   * `running` at start was interrupted by a restart and is marked failed (its `onFailed` is not called: the closure is
   * gone).
   */
  readonly runTask: <A, E>(task: TaskRequest<A, E>) => Effect.Effect<JobRow, SchedulerError>
}

/** One job in the admin list: the row, the module's name, and whether it waits for a handler or its module is gone. */
export interface JobView {
  readonly job: JobRow
  readonly moduleName: string
  /** The module is no longer in the catalogue: the owner cancels its jobs. */
  readonly orphaned: boolean
}

/** The engine the app holds (serve mode); modules see `forModule`. */
export interface Scheduler {
  readonly forModule: (moduleId: string) => ModuleScheduler
  /** Replace the delivery (P9's notification service). */
  readonly setDelivery: (delivery: NotificationDelivery) => void
  /** The admin page: every job (live, then the finished ones of the last 7 days). */
  readonly listAll: (options?: { readonly limit?: number }) => Effect.Effect<ReadonlyArray<JobView>, SchedulerError>
  /** The admin page's cancel (any module's job). Returns false when there is no such job. */
  readonly cancelAny: (id: string) => Effect.Effect<boolean, SchedulerError>
  /** Counts for doctor and the Health page. */
  readonly counts: Effect.Effect<SchedulerCounts, SchedulerError>
}

export interface SchedulerCounts {
  readonly live: number
  readonly failed: number
  readonly waiting: number
  readonly orphaned: number
  readonly tasksRunning: number
}

/**
 * The scheduler of a mode without one (the CLI modes, where the store is read-only; a host without a scheduler):
 * `handle` registers nothing and succeeds, so a module's shared part still starts; every other call fails
 * `unavailable` with `reason`.
 */
export const closedModuleScheduler = (reason: string): ModuleScheduler => {
  const fail = Effect.fail(new SchedulerError({ reason: "unavailable", message: reason }))
  return {
    schedule: () => fail,
    handle: () => Effect.void,
    pause: () => fail,
    resume: () => fail,
    reschedule: () => fail,
    cancel: () => fail,
    list: () => fail,
    get: () => fail,
    runTask: () => fail
  }
}

/** The occurrence key of a job's occurrence (`DeliveryInfo.notificationId`, `DueInfo.occurrenceKey`). */
export const occurrenceKey = (jobId: string, dueAt: number): string => `${jobId}@${dueAt}`
