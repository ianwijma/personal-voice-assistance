import { MAX_SCHEDULED_JOBS_PAGE, type ScheduledJob, type ScheduledJobsResponse } from "@pva/protocol"

/**
 * The mock server's scheduled jobs, answering as the real server's `GET /api/scheduler/jobs?cursor=&limit=` and
 * `POST /api/scheduler/jobs/<id>/cancel` do (docs/SCHEDULING.md "Admin"): live jobs by due time, then finished ones
 * newest first, a page at a time with a `next` cursor (an unknown cursor is 400: start again); cancel works on a live
 * or failed job (404 otherwise), and a running one keeps running. Thirty feed refreshes make the list longer than a
 * page.
 */
export class MockSchedulerError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const createScheduledJobsMock = (now: () => number = Date.now) => {
  const t0 = now()
  const base = { late: "run" as const, origin: {}, attempt: 0, orphaned: false, createdAt: t0 - 600_000, updatedAt: t0 - 60_000 }
  let jobs: Array<ScheduledJob> = [
    { ...base, id: "job_pasta", module: "timers", moduleName: "Timers", handler: "ring", key: "timer:pasta", state: "scheduled", dueAt: t0 + 6 * 60_000, origin: { deviceId: "kitchen-0001", assistantId: "jev" } },
    { ...base, id: "job_news", module: "news", moduleName: "News and feeds", handler: "refresh", state: "scheduled", dueAt: t0 + 14 * 60_000, cron: "*/15 * * * *" },
    { ...base, id: "job_alarm", module: "alarms", moduleName: "Alarms", handler: "ring", state: "scheduled", dueAt: t0 + 3_600_000, cron: "45 6 * * 1-5", timeZone: "Europe/Amsterdam", late: { withinMs: 1_800_000 } },
    { ...base, id: "job_digest", module: "web-search", moduleName: "Web search", handler: "digest", state: "running", dueAt: t0 - 30_000, attempt: 1, origin: { deviceId: "study-0001", personId: "sam" } },
    { ...base, id: "job_oven", module: "smart-home", moduleName: "Smart home", handler: "run-command", state: "failed", dueAt: t0 - 3_600_000, attempt: 1, lastError: "Home Assistant did not answer", failedAt: t0 - 3_590_000, finishedAt: t0 - 3_590_000 },
    { ...base, id: "job_gone", module: "old-module", moduleName: "old-module", handler: "remind", state: "scheduled", dueAt: t0 + 86_400_000, orphaned: true },
    ...Array.from({ length: 30 }, (_, i): ScheduledJob => ({ ...base, id: `job_feed${i}`, module: "news", moduleName: "News and feeds", handler: "fetch", key: `feed:${i}`, state: "done", dueAt: t0 - (i + 2) * 600_000, attempt: 1, finishedAt: t0 - (i + 2) * 600_000 }))
  ]
  const live = (j: ScheduledJob) => j.state === "scheduled" || j.state === "running"
  /** The list in the server's order. */
  const ordered = () => [
    ...jobs.filter(live).sort((a, b) => a.dueAt - b.dueAt),
    ...jobs.filter((j) => !live(j)).sort((a, b) => (b.finishedAt ?? b.dueAt) - (a.finishedAt ?? a.dueAt))
  ]
  /** Cursor tokens: the id of the last job of a page. */
  const cursors = new Map<string, string>()
  let next = 0
  return {
    list: (cursor?: string, limit: number = MAX_SCHEDULED_JOBS_PAGE): ScheduledJobsResponse => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCHEDULED_JOBS_PAGE) throw new MockSchedulerError(400, "invalid", `limit must be 1 to ${MAX_SCHEDULED_JOBS_PAGE}`)
      const all = ordered()
      let from = 0
      if (cursor !== undefined && cursor !== "") {
        const last = cursors.get(cursor)
        if (last === undefined) throw new MockSchedulerError(400, "invalid", "That page of the list is no longer known; start again from the top")
        from = all.findIndex((j) => j.id === last) + 1
      }
      const page = all.slice(from, from + limit)
      if (from + limit >= all.length) return { jobs: page, available: true }
      const token = `live.${(++next).toString(36)}`
      cursors.set(token, page[page.length - 1]!.id)
      return { jobs: page, available: true, next: token }
    },
    /** False: no such live or failed job. */
    cancel: (id: string): boolean => {
      const job = jobs.find((j) => j.id === id)
      if (job === undefined || !(live(job) || job.state === "failed")) return false
      const at = now()
      jobs = jobs.map((j) => (j.id === id ? { ...j, state: "cancelled", finishedAt: at, updatedAt: at } : j))
      return true
    }
  }
}
