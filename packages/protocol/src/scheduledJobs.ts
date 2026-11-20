import { Schema } from "effect"

/**
 * The scheduler's admin view (docs/MODULES-PLAN.md §4 P6, docs/SCHEDULING.md "Admin"): the jobs the modules and core
 * services scheduled, read through the admin API (admin session token only), not the socket, so the protocol version
 * does not change. Payloads are never sent.
 *
 * - `GET /api/scheduler/jobs[?cursor=<next>&limit=<n>]`: one page of at most `MAX_SCHEDULED_JOBS_PAGE`: the live jobs
 *   by due time, then the finished ones (kept 7 days), newest first; `next` asks for the following page (absent: there
 *   is no more). A cursor the server does not know (an old one, or one from before a restart) is answered 400: start
 *   again from the top. It is not a snapshot: a job that changes between two pages can be shown twice or not at all,
 *   and Refresh reads it again from the top.
 * - `POST /api/scheduler/jobs/<id>/cancel`: cancel a live job, or dismiss a failed one. A running handler is not
 *   interrupted; what it then reports is ignored.
 */

export const SCHEDULER_ADMIN_PATH = "/api/scheduler/jobs"
/**
 * The most jobs one page of the admin list holds: the scheduler's `MAX_ADMIN_JOB_PAGE` (two reads of `maxListRows(jobs)`;
 * `serveScheduler.test.ts` checks that they agree).
 */
export const MAX_SCHEDULED_JOBS_PAGE = 20

/** Bounds of the fields, as the scheduler keeps them (docs/SCHEDULING.md "Scheduling"). */
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
/** A time in epoch ms (a whole number within JavaScript's date range), or a span of ms. */
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }))
const OriginId = text(64)

export const ScheduledJobState = Schema.Literals(["scheduled", "running", "done", "failed", "cancelled", "missed"])
export type ScheduledJobState = typeof ScheduledJobState.Type

export const ScheduledJob = Schema.Struct({
  id: text(200),
  /** A module id or `core.<name>`; not a `ModuleId` check: a module that was removed keeps its jobs (`orphaned`). */
  module: text(40),
  moduleName: text(200),
  handler: text(64),
  key: Schema.optionalKey(text(100)),
  state: ScheduledJobState,
  /** Epoch ms: when it is due next (live; running: the occurrence it runs for), or its last due time (finished). */
  dueAt: Time,
  cron: Schema.optionalKey(text(100)),
  /** Absent for a cron job: the household's zone. */
  timeZone: Schema.optionalKey(text(48)),
  late: Schema.Union([Schema.Literal("run"), Schema.Struct({ withinMs: Time })]),
  origin: Schema.Struct({
    assistantId: Schema.optionalKey(OriginId),
    deviceId: Schema.optionalKey(OriginId),
    personId: Schema.optionalKey(OriginId)
  }),
  /** Runs of its current occurrence so far (at most one more than a handler's most retries, 10). */
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 11 })),
  /** Why the last run failed (passed through the page boundary; one line). */
  lastError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  failedAt: Schema.optionalKey(Time),
  finishedAt: Schema.optionalKey(Time),
  /** Its module is no longer installed. */
  orphaned: Schema.Boolean,
  createdAt: Time,
  updatedAt: Time
})
export type ScheduledJob = typeof ScheduledJob.Type

/** `GET /api/scheduler/jobs`. */
export const ScheduledJobsResponse = Schema.Struct({
  jobs: Schema.Array(ScheduledJob).check(Schema.isMaxLength(MAX_SCHEDULED_JOBS_PAGE)),
  /** The server keeps no scheduler: the page says so. */
  available: Schema.Boolean,
  /** The cursor of the next page; absent: this was the last. */
  next: Schema.optionalKey(text(64))
})
export type ScheduledJobsResponse = typeof ScheduledJobsResponse.Type
