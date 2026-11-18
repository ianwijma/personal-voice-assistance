import { MAX_ADMIN_JOB_PAGE, type SchedulerEngine } from "@pva/core"
import type { ScheduledJobsResponse } from "@pva/protocol"
import { Effect } from "effect"
import { scheduledJobOnWire } from "./scheduler.ts"
import { ApiFailure } from "./VoiceCatalog.ts"

/** What the admin API needs of the scheduler. */
export type AdminScheduler = Pick<SchedulerEngine, "listAll" | "cancelAny">

const JOB_PATH = /^scheduler\/jobs\/([A-Za-z0-9_.:-]{1,200})\/cancel$/
/** `finished` (the start of the finished jobs), or a token of this server's engine: the phase and 32 random hex digits. */
const CURSOR = /^(?:finished|(?:live|finished)\.[0-9a-f]{32})$/

const fail = (e: { readonly reason: string; readonly message: string }) =>
  new ApiFailure({
    status: e.reason === "unavailable" || e.reason === "busy" ? 503 : e.reason === "invalid" ? 400 : 500,
    code: e.reason,
    message: e.message
  })

/**
 * `GET /api/scheduler/jobs[?cursor=…&limit=…]` and `POST /api/scheduler/jobs/<id>/cancel` (protocol `scheduledJobs.ts`),
 * behind the admin API's token check. A page holds at most `MAX_ADMIN_JOB_PAGE` jobs (the protocol's
 * `MAX_SCHEDULED_JOBS_PAGE`): live ones by due time, then finished ones newest first; `next` asks for the page after it.
 * It is not a snapshot (docs/SCHEDULING.md "Health and the admin page"). `undefined`: not a scheduler path.
 */
export const schedulerRoute = (
  path: string,
  method: string,
  query: URLSearchParams,
  scheduler: AdminScheduler | undefined
): Effect.Effect<{ readonly status: number; readonly json: unknown }, ApiFailure> | undefined => {
  if (path === "scheduler/jobs") {
    if (method !== "GET") return Effect.fail(new ApiFailure({ status: 405, code: "method_not_allowed", message: "Use GET" }))
    if (scheduler === undefined) return Effect.succeed({ status: 200, json: { jobs: [], available: false } satisfies ScheduledJobsResponse })
    const cursor = query.get("cursor") ?? undefined
    if (cursor !== undefined && !CURSOR.test(cursor)) return Effect.fail(new ApiFailure({ status: 400, code: "invalid", message: "That is not a page of the list" }))
    const limitText = query.get("limit")
    const limit = limitText === null ? MAX_ADMIN_JOB_PAGE : Number(limitText)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_JOB_PAGE) {
      return Effect.fail(new ApiFailure({ status: 400, code: "invalid", message: `limit must be 1 to ${MAX_ADMIN_JOB_PAGE}` }))
    }
    return scheduler.listAll({ limit, ...(cursor !== undefined ? { cursor } : {}) }).pipe(
      Effect.map((page) => ({
        status: 200,
        json: { jobs: page.jobs.map(scheduledJobOnWire), available: true, ...(page.next !== undefined ? { next: page.next } : {}) } satisfies ScheduledJobsResponse
      })),
      Effect.mapError(fail)
    )
  }
  const match = JOB_PATH.exec(path)
  if (match === null) return undefined
  if (method !== "POST") return Effect.fail(new ApiFailure({ status: 405, code: "method_not_allowed", message: "Use POST" }))
  if (scheduler === undefined) return Effect.fail(new ApiFailure({ status: 503, code: "unavailable", message: "This server keeps no scheduled jobs" }))
  return scheduler.cancelAny(match[1]!).pipe(
    Effect.mapError(fail),
    Effect.flatMap((found) =>
      found
        ? Effect.succeed({ status: 200, json: { cancelled: true } })
        : Effect.fail(new ApiFailure({ status: 404, code: "not_found", message: "There is no such live or failed job (it may have finished or been removed)" }))
    )
  )
}
