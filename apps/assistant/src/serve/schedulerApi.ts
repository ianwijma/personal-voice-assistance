import type { Scheduler } from "@pva/core"
import type { ScheduledJobsResponse } from "@pva/protocol"
import { Effect } from "effect"
import { scheduledJobOnWire } from "./scheduler.ts"
import { ApiFailure } from "./VoiceCatalog.ts"

/** What the admin API needs of the scheduler. */
export type AdminScheduler = Pick<Scheduler, "listAll" | "cancelAny">

const JOB_PATH = /^scheduler\/jobs\/([A-Za-z0-9_-]{1,64})\/cancel$/

const fail = (e: { readonly reason: string; readonly message: string }) =>
  new ApiFailure({ status: e.reason === "unavailable" ? 503 : 500, code: e.reason, message: e.message })

/**
 * `GET /api/scheduler/jobs` and `POST /api/scheduler/jobs/<id>/cancel` (protocol `scheduledJobs.ts`), behind the admin
 * API's token check. `undefined`: not a scheduler path.
 */
export const schedulerRoute = (
  path: string,
  method: string,
  scheduler: AdminScheduler | undefined
): Effect.Effect<{ readonly status: number; readonly json: unknown }, ApiFailure> | undefined => {
  if (path === "scheduler/jobs") {
    if (method !== "GET") return Effect.fail(new ApiFailure({ status: 405, code: "method_not_allowed", message: "Use GET" }))
    if (scheduler === undefined) return Effect.succeed({ status: 200, json: { jobs: [], available: false } satisfies ScheduledJobsResponse })
    return scheduler.listAll().pipe(
      Effect.map((views) => ({ status: 200, json: { jobs: views.map(scheduledJobOnWire), available: true } satisfies ScheduledJobsResponse })),
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
        : Effect.fail(new ApiFailure({ status: 404, code: "not_found", message: "There is no such job (it may have been removed)" }))
    )
  )
}
