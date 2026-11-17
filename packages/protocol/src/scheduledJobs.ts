import { Schema } from "effect"
import { HouseholdScope } from "./household.ts"

/**
 * The scheduler's admin view (docs/MODULES-PLAN.md §4 P6, docs/SCHEDULING.md): every job the modules scheduled and
 * every background task, read through the admin API (admin session token only), not the socket, so the protocol
 * version does not change.
 *
 * - `GET /api/scheduler/jobs`: the live jobs (earliest first), then the finished ones of the last 7 days (newest first).
 * - `POST /api/scheduler/jobs/<id>/cancel`: cancel a live job, or dismiss a failed one.
 */

export const SCHEDULER_ADMIN_PATH = "/api/scheduler/jobs"

export const ScheduledJobState = Schema.Literals(["scheduled", "paused", "running", "done", "cancelled", "failed", "missed"])
export type ScheduledJobState = typeof ScheduledJobState.Type

export const ScheduledJob = Schema.Struct({
  id: Schema.String,
  /** Not a `ModuleId` check: a module that was removed keeps its jobs (`orphaned`). */
  module: Schema.String,
  moduleName: Schema.String,
  kind: Schema.Literals(["timer", "alarm", "reminder", "recurring", "task", "deferred"]),
  key: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  state: ScheduledJobState,
  /** Epoch ms; absent while paused and for tasks. */
  dueAt: Schema.optionalKey(Schema.Finite),
  remainingMs: Schema.optionalKey(Schema.Finite),
  cron: Schema.optionalKey(Schema.String),
  timeZone: Schema.optionalKey(Schema.String),
  /** What it does when due: a notification, the module's handler (named), or a background task. */
  action: Schema.Literals(["notify", "handler", "task"]),
  handler: Schema.optionalKey(Schema.String),
  scope: HouseholdScope,
  origin: Schema.Struct({
    deviceId: Schema.optionalKey(Schema.String),
    assistantId: Schema.optionalKey(Schema.String),
    conversationId: Schema.optionalKey(Schema.String),
    person: Schema.optionalKey(Schema.String)
  }),
  /** Due, but its module is not running (its handler is not registered). */
  waiting: Schema.Boolean,
  /** Its module is no longer installed. */
  orphaned: Schema.Boolean,
  lastRunAt: Schema.optionalKey(Schema.Finite),
  lastError: Schema.optionalKey(Schema.String),
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite
})
export type ScheduledJob = typeof ScheduledJob.Type

/** `GET /api/scheduler/jobs`. */
export const ScheduledJobsResponse = Schema.Struct({
  jobs: Schema.Array(ScheduledJob),
  /** The server keeps no scheduler (no household store): the page says so. */
  available: Schema.Boolean
})
export type ScheduledJobsResponse = typeof ScheduledJobsResponse.Type
