import type { ScheduledJob, ScheduledJobsResponse } from "@pva/protocol"

/**
 * The mock server's scheduled jobs (as the real server's `GET /api/scheduler/jobs` and
 * `POST /api/scheduler/jobs/<id>/cancel`, docs/SCHEDULING.md): a timer, a recurring refresh, a job waiting for a module
 * that is off, a failed one, a running task and one of a removed module.
 */
export const createScheduledJobsMock = (now: () => number = Date.now) => {
  const t0 = now()
  const base = { scope: { kind: "household" as const }, origin: {}, waiting: false, orphaned: false, createdAt: t0 - 600_000, updatedAt: t0 - 60_000 }
  let jobs: Array<ScheduledJob> = [
    { ...base, id: "job_pasta", module: "timers", moduleName: "Timers", kind: "timer", key: "timer:pasta", label: "Pasta", state: "scheduled", dueAt: t0 + 6 * 60_000, action: "notify", origin: { deviceId: "kitchen-0001", assistantId: "jev" } },
    { ...base, id: "job_news", module: "news", moduleName: "News and feeds", kind: "recurring", label: "Refresh feeds", state: "scheduled", dueAt: t0 + 14 * 60_000, cron: "*/15 * * * *", action: "handler", handler: "refresh" },
    { ...base, id: "job_alarm", module: "alarms", moduleName: "Alarms", kind: "alarm", label: "Wake up", state: "scheduled", dueAt: t0 - 120_000, cron: "45 6 * * 1-5", timeZone: "Europe/Amsterdam", action: "handler", handler: "ring", waiting: true },
    { ...base, id: "job_research", module: "web-search", moduleName: "Web search", kind: "task", label: "Research heat pumps", state: "running", action: "task", lastRunAt: t0 - 30_000, origin: { deviceId: "study-0001" } },
    { ...base, id: "job_oven", module: "smart-home", moduleName: "Smart home", kind: "deferred", label: "Turn off the oven", state: "failed", dueAt: t0 - 3_600_000, action: "handler", handler: "run-command", lastError: "Home Assistant did not answer" },
    { ...base, id: "job_gone", module: "old-module", moduleName: "old-module", kind: "reminder", label: "Water the plants", state: "scheduled", dueAt: t0 + 86_400_000, action: "notify", orphaned: true }
  ]
  return {
    list: (): ScheduledJobsResponse => ({ jobs, available: true }),
    /** False: no such job. */
    cancel: (id: string): boolean => {
      const job = jobs.find((j) => j.id === id)
      if (job === undefined) return false
      if (["scheduled", "paused", "running", "failed"].includes(job.state)) {
        jobs = jobs.map((j) => (j.id === id ? { ...j, state: "cancelled", waiting: false, updatedAt: now() } : j))
      }
      return true
    }
  }
}
