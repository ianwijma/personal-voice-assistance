import { MAX_SCHEDULED_JOBS_PAGE, type ScheduledJob, type ScheduledJobsResponse } from "@pva/protocol"

/**
 * The mock server's scheduled jobs, answering as the real server's `GET /api/scheduler/jobs?cursor=&limit=` and
 * `POST /api/scheduler/jobs/<id>/cancel` do (docs/SCHEDULING.md "Admin"): live jobs by due time, then finished ones
 * newest first, a page at a time with a `next` cursor (an unknown cursor is 400: start again; the newest 256 are known);
 * cancel works on a live or failed job (404 otherwise), and a running one keeps running. Thirty feed refreshes make the
 * list longer than a page.
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
  /** A job's place in its phase, as the server's index has it: live by due time, finished newest first; then its id. */
  const placeOf = (j: ScheduledJob) => (live(j) ? j.dueAt : (j.finishedAt ?? j.dueAt))
  const phaseOf = (j: ScheduledJob): "live" | "finished" => (live(j) ? "live" : "finished")
  const before = (phase: "live" | "finished", a: { readonly at: number; readonly id: string }, b: { readonly at: number; readonly id: string }) =>
    a.at !== b.at ? (phase === "live" ? a.at < b.at : a.at > b.at) : phase === "live" ? a.id < b.id : a.id > b.id
  /** The jobs of a phase in the server's order, after a place (the place of the row a cursor was given for). */
  const phaseAfter = (phase: "live" | "finished", after: { readonly at: number; readonly id: string } | undefined) =>
    jobs
      .filter((j) => phaseOf(j) === phase)
      .map((j) => ({ j, at: placeOf(j), id: j.id }))
      .filter((x) => after === undefined || before(phase, after, x))
      .sort((x, y) => (before(phase, x, y) ? -1 : 1))
      .map((x) => x.j)
  /**
   * Cursor tokens, as the server's engine keeps them: random, of this mock only (a token of another, or of one that
   * was reset, is unknown), each the phase and the place of the last job of its page (not the job: a job that moved
   * or finished meanwhile does not move the cursor), the newest 256 kept.
   */
  const cursors = new Map<string, { readonly phase: "live" | "finished"; readonly at: number; readonly id: string }>()
  const remember = (phase: "live" | "finished", job: ScheduledJob) => {
    const token = `${phase}.${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`
    cursors.set(token, { phase, at: placeOf(job), id: job.id })
    if (cursors.size > 256) cursors.delete(cursors.keys().next().value!)
    return token
  }
  return {
    list: (cursor?: string, limit: number = MAX_SCHEDULED_JOBS_PAGE): ScheduledJobsResponse => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SCHEDULED_JOBS_PAGE) throw new MockSchedulerError(400, "invalid", `limit must be 1 to ${MAX_SCHEDULED_JOBS_PAGE}`)
      let phase: "live" | "finished" = "live"
      let after: { readonly at: number; readonly id: string } | undefined
      // As the server's route: an explicitly empty cursor (`?cursor=`) is not a page of the list.
      if (cursor === "") throw new MockSchedulerError(400, "invalid", "That is not a page of the list")
      if (cursor !== undefined) {
        if (cursor === "finished") phase = "finished"
        else {
          const known = cursors.get(cursor)
          if (known === undefined) throw new MockSchedulerError(400, "invalid", "That page of the list is no longer known; start again from the top")
          phase = known.phase
          after = known
        }
      }
      // As the server's engine: the rest of the phase, then (if room is left) the finished phase from its start.
      const out: Array<ScheduledJob> = []
      for (;;) {
        const want = limit - out.length
        const rows = phaseAfter(phase, after).slice(0, want)
        out.push(...rows)
        if (rows.length === want) return { jobs: out, available: true, next: remember(phase, rows[rows.length - 1]!) }
        if (phase === "finished") return { jobs: out, available: true }
        phase = "finished"
        after = undefined
        if (out.length === limit) return { jobs: out, available: true, next: "finished" }
      }
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
