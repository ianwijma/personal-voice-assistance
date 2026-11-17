"use client"
import { useEffect, useRef, useState } from "react"
import { type ScheduledJob, ScheduledJobsResponse } from "@pva/protocol"
import { Schema } from "effect"
import { resolveWsUrl } from "@/lib/connection.ts"
import { ApiError, apiBaseFor, makeVoiceApi, type VoiceApi } from "@/lib/voiceCatalog.ts"
import { Spinner } from "../../ui/Icon.tsx"
import { Button, cx, ToneDot } from "../../ui/controls.tsx"

/**
 * Diagnostics › Scheduled jobs (docs/SCHEDULING.md): every job the modules scheduled and every background task, read
 * through the admin API (`GET /api/scheduler/jobs`). Live jobs first (earliest due first), then the finished ones of
 * the last 7 days. "Cancel" stops a live job; on a failed one it dismisses it (and its Health issue).
 */

const KIND: Readonly<Record<ScheduledJob["kind"], string>> = {
  timer: "Timer",
  alarm: "Alarm",
  reminder: "Reminder",
  recurring: "Recurring",
  task: "Task",
  deferred: "Deferred"
}

const STATE: Readonly<Record<ScheduledJob["state"], { readonly label: string; readonly tone: "ok" | "warning" | "error" | "neutral" }>> = {
  scheduled: { label: "Scheduled", tone: "ok" },
  paused: { label: "Paused", tone: "neutral" },
  running: { label: "Running", tone: "ok" },
  done: { label: "Done", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
  missed: { label: "Missed", tone: "warning" }
}

const LIVE = new Set<ScheduledJob["state"]>(["scheduled", "paused", "running"])

/** "in 6 min", "3 min ago", or a date and time further out. */
const when = (at: number, now: number): string => {
  const s = Math.round((at - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 45) return s >= 0 ? "now" : "just now"
  if (abs < 3600) return s > 0 ? `in ${Math.round(abs / 60)} min` : `${Math.round(abs / 60)} min ago`
  return new Date(at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

const originText = (o: ScheduledJob["origin"]): string =>
  [o.deviceId !== undefined ? `device ${o.deviceId}` : undefined, o.assistantId !== undefined ? `assistant ${o.assistantId}` : undefined, o.person !== undefined ? `for ${o.person}` : undefined]
    .filter((x) => x !== undefined)
    .join(", ")

export function ScheduledJobsPage({ api: given }: { readonly api?: VoiceApi } = {}) {
  const api = useRef(given ?? makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))).current
  const [jobs, setJobs] = useState<ReadonlyArray<ScheduledJob> | undefined>(undefined)
  const [available, setAvailable] = useState(true)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

  const load = async () => {
    try {
      const res = await api.request("scheduler/jobs")
      const body = Schema.decodeUnknownSync(ScheduledJobsResponse)(await res.json())
      setJobs(body.jobs)
      setAvailable(body.available)
      setProblem(undefined)
      setNow(Date.now())
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The scheduled jobs could not be read.")
    }
  }
  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [])

  const cancel = async (job: ScheduledJob) => {
    const name = job.label ?? job.key ?? KIND[job.kind].toLowerCase()
    if (!window.confirm(job.state === "failed" ? `Dismiss the failed ${name}?` : `Cancel ${name}? It will not fire.`)) return
    setBusy(job.id)
    try {
      await api.request(`scheduler/jobs/${encodeURIComponent(job.id)}/cancel`, { method: "POST" })
      await load()
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The job was not cancelled.")
    } finally {
      setBusy(undefined)
    }
  }

  if (jobs === undefined && problem === undefined) return <p className="text-[14px] text-ink-muted"><Spinner size={12} /> Reading the scheduled jobs…</p>
  if (!available) return <p className="text-[14px] text-ink-muted" data-testid="no-scheduler">This server keeps no scheduled jobs.</p>
  const list = jobs ?? []
  const live = list.filter((j) => LIVE.has(j.state))

  return (
    <div className="flex flex-col gap-4" data-testid="scheduled-jobs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[14px] text-ink" aria-live="polite" data-testid="scheduled-summary">
          {live.length === 0 ? "Nothing is scheduled." : `${live.length} scheduled`}
          {list.length > live.length && <span className="text-ink-faint"> · {list.length - live.length} finished in the last 7 days</span>}
        </p>
        <Button size="sm" onClick={() => void load()}>Refresh</Button>
      </div>
      {problem !== undefined && <p className="text-[13px] text-danger" role="alert">{problem}</p>}
      <ul className="flex flex-col gap-2">
        {list.map((job) => {
          const state = STATE[job.state]
          const canCancel = LIVE.has(job.state) || job.state === "failed"
          const origin = originText(job.origin)
          return (
            <li key={job.id} className="flex flex-col gap-1 rounded-md border border-line/70 px-3 py-2.5" data-testid="scheduled-job" data-state={job.state}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <ToneDot tone={job.waiting ? "warning" : state.tone} className="self-center" />
                <span className="label text-[10px] text-ink-faint">{KIND[job.kind]}</span>
                <span className="min-w-0 text-[14px] font-medium text-ink">{job.label ?? job.key ?? job.handler ?? job.id}</span>
                <span className="text-[13px] text-ink-muted">{job.moduleName}{job.orphaned ? " (removed)" : ""}</span>
                <span className="flex-1" />
                {canCancel && (
                  <Button size="sm" variant="quiet" disabled={busy === job.id} onClick={() => void cancel(job)} data-testid="scheduled-cancel">
                    {busy === job.id && <Spinner size={12} />}{job.state === "failed" ? "Dismiss" : "Cancel"}
                  </Button>
                )}
              </div>
              <p className={cx("text-[13px]", job.waiting || job.state === "failed" ? "text-warn" : "text-ink-muted")}>
                {job.waiting ? "Waiting for its module to run" : state.label}
                {job.dueAt !== undefined && LIVE.has(job.state) && ` · ${when(job.dueAt, now)}`}
                {job.state === "paused" && job.remainingMs !== undefined && ` · ${Math.round(job.remainingMs / 60_000)} min left`}
                {job.cron !== undefined && ` · ${job.cron}${job.timeZone !== undefined ? ` (${job.timeZone})` : ""}`}
                {origin !== "" && ` · ${origin}`}
              </p>
              {job.lastError !== undefined && <p className="text-[13px] text-ink-muted">{job.lastError}</p>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
