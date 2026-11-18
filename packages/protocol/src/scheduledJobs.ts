import { Schema } from "effect"

/**
 * The scheduler's admin view (docs/MODULES-PLAN.md §4 P6, docs/SCHEDULING.md "Admin"): the jobs the modules and core
 * services scheduled, read through the admin API (admin session token only), not the socket, so the protocol version
 * does not change. Payloads are never sent.
 *
 * - `GET /api/scheduler/jobs[?cursor=<next>&limit=<n>]`: one page: the live jobs by due time, then the finished ones of
 *   the last 7 days, newest first; `next` asks for the following page (absent: there is no more). A cursor the server
 *   no longer knows is answered 400: start again from the top.
 * - `POST /api/scheduler/jobs/<id>/cancel`: cancel a live job, or dismiss a failed one. A running handler is not
 *   interrupted; what it then reports is ignored.
 */

export const SCHEDULER_ADMIN_PATH = "/api/scheduler/jobs"
/** The most jobs one page of the admin list holds (the scheduler's page: `MAX_JOB_PAGE`). */
export const MAX_SCHEDULED_JOBS_PAGE = 24

export const ScheduledJobState = Schema.Literals(["scheduled", "running", "done", "failed", "cancelled", "missed"])
export type ScheduledJobState = typeof ScheduledJobState.Type

export const ScheduledJob = Schema.Struct({
  id: Schema.String,
  /** A module id or `core.<name>`; not a `ModuleId` check: a module that was removed keeps its jobs (`orphaned`). */
  module: Schema.String,
  moduleName: Schema.String,
  handler: Schema.String,
  key: Schema.optionalKey(Schema.String),
  state: ScheduledJobState,
  /** Epoch ms: when it is due next (live; running: the occurrence it runs for), or its last due time (finished). */
  dueAt: Schema.Finite,
  cron: Schema.optionalKey(Schema.String),
  /** Absent for a cron job: the household's zone. */
  timeZone: Schema.optionalKey(Schema.String),
  late: Schema.Union([Schema.Literal("run"), Schema.Struct({ withinMs: Schema.Finite })]),
  origin: Schema.Struct({
    assistantId: Schema.optionalKey(Schema.String),
    deviceId: Schema.optionalKey(Schema.String),
    personId: Schema.optionalKey(Schema.String)
  }),
  attempt: Schema.Finite,
  /** Why the last run failed (passed through the page boundary). */
  lastError: Schema.optionalKey(Schema.String),
  failedAt: Schema.optionalKey(Schema.Finite),
  finishedAt: Schema.optionalKey(Schema.Finite),
  /** Its module is no longer installed. */
  orphaned: Schema.Boolean,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite
})
export type ScheduledJob = typeof ScheduledJob.Type

/** `GET /api/scheduler/jobs`. */
export const ScheduledJobsResponse = Schema.Struct({
  jobs: Schema.Array(ScheduledJob),
  /** The server keeps no scheduler: the page says so. */
  available: Schema.Boolean,
  /** The cursor of the next page; absent: this was the last. */
  next: Schema.optionalKey(Schema.String)
})
export type ScheduledJobsResponse = typeof ScheduledJobsResponse.Type
