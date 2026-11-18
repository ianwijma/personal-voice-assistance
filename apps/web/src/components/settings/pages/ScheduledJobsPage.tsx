"use client"
import { useEffect, useRef, useState } from "react"
import { type ScheduledJob, ScheduledJobsResponse } from "@pva/protocol"
import { Schema } from "effect"
import { resolveWsUrl } from "@/lib/connection.ts"
import { ApiError, apiBaseFor, makeVoiceApi, type VoiceApi } from "@/lib/voiceCatalog.ts"
import { Spinner } from "../../ui/Icon.tsx"
import { Button, cx, ToneDot } from "../../ui/controls.tsx"

/**
 * Diagnostics › Scheduled jobs (docs/SCHEDULING.md "Admin"): the jobs the modules and core services scheduled, read
 * through the admin API a page at a time (`GET /api/scheduler/jobs?cursor=…`): live jobs first (earliest due first),
 * then the finished ones of the last 7 days, newest first. "Load more" reads the next page. "Cancel" stops a live
 * job (a running handler is not interrupted: what it then reports is ignored); on a failed one it dismisses it and
 * its Health issue. Payloads are never shown.
 *
 * Refresh (and the reload after a cancel) starts a new generation of the list: an answer to a read of an older
 * generation (a "Load more" still on its way) is dropped, so pages of two readings are never joined. The list is not a
 * snapshot: a job that changed between two pages can be missing or shown once in its older state; Refresh reads again.
 */

const STATE: Readonly<Record<ScheduledJob["state"], { readonly label: string; readonly tone: "ok" | "warning" | "error" | "neutral" }>> = {
  scheduled: { label: "Scheduled", tone: "ok" },
  running: { label: "Running", tone: "ok" },
  done: { label: "Done", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  failed: { label: "Failed", tone: "error" },
  missed: { label: "Missed (too late to run)", tone: "warning" }
}

const LIVE = new Set<ScheduledJob["state"]>(["scheduled", "running"])

/** "in 6 min", "3 min ago", or a date and time further out. */
const when = (at: number, now: number): string => {
  const s = Math.round((at - now) / 1000)
  const abs = Math.abs(s)
  if (abs < 45) return s >= 0 ? "now" : "just now"
  if (abs < 3600) return s > 0 ? `in ${Math.round(abs / 60)} min` : `${Math.round(abs / 60)} min ago`
  return new Date(at).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
}

const originText = (o: ScheduledJob["origin"]): string =>
  [o.deviceId !== undefined ? `device ${o.deviceId}` : undefined, o.assistantId !== undefined ? `assistant ${o.assistantId}` : undefined, o.personId !== undefined ? `for ${o.personId}` : undefined]
    .filter((x) => x !== undefined)
    .join(", ")

const decode = Schema.decodeUnknownSync(ScheduledJobsResponse)

export function ScheduledJobsPage({ api: given }: { readonly api?: VoiceApi } = {}) {
  const api = useRef(given ?? makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))).current
  const [jobs, setJobs] = useState<ReadonlyArray<ScheduledJob> | undefined>(undefined)
  const [next, setNext] = useState<string | undefined>(undefined)
  const [available, setAvailable] = useState(true)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** The generation of the list: every first-page read starts a new one; answers of older ones are dropped. */
  const generation = useRef(0)

  /**
   * The first page again (after a cancel, on Refresh): what was loaded beyond it is read again on request. True when
   * it was read and shown (false: it failed, and the problem says so; or a newer reading replaced it).
   */
  const load = async (): Promise<boolean> => {
    const mine = ++generation.current
    try {
      const body = decode(await (await api.request("scheduler/jobs")).json())
      if (mine !== generation.current) return false
      setJobs(body.jobs)
      setNext(body.next)
      setAvailable(body.available)
      setProblem(undefined)
      setNow(Date.now())
      return true
    } catch (e) {
      if (mine === generation.current) setProblem(e instanceof ApiError ? e.message : "The scheduled jobs could not be read.")
      return false
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const loadMore = async () => {
    if (next === undefined) return
    const mine = generation.current
    setLoadingMore(true)
    try {
      const body = decode(await (await api.request(`scheduler/jobs?cursor=${encodeURIComponent(next)}`)).json())
      // Refresh (or a cancel) started another reading meanwhile: this page belongs to the old one.
      if (mine !== generation.current) return
      // A job that moved between pages (it finished meanwhile) is shown once.
      setJobs((old) => {
        const seen = new Set((old ?? []).map((j) => j.id))
        return [...(old ?? []), ...body.jobs.filter((j) => !seen.has(j.id))]
      })
      setNext(body.next)
      setProblem(undefined)
    } catch (e) {
      if (mine !== generation.current) return
      // The server no longer knows the page (it keeps a few hundred, and none from before a restart): start again from
      // the top, and say so only when that worked (a failed reload says why itself).
      if (e instanceof ApiError && e.status === 400) {
        if (await load()) setProblem("The list changed; it was read again from the top.")
      } else setProblem(e instanceof ApiError ? e.message : "More jobs could not be read.")
    } finally {
      setLoadingMore(false)
    }
  }

  const cancel = async (job: ScheduledJob) => {
    const name = job.key ?? job.handler
    const question = job.state === "failed"
      ? `Dismiss the failed ${name}?`
      : job.state === "running"
      ? `Cancel ${name}? It is running now: it is not interrupted, but what it reports is ignored and it does not run again.`
      : `Cancel ${name}? It will not run.`
    if (!window.confirm(question)) return
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
          {live.length === 0 ? "Nothing is scheduled." : `${live.length}${next !== undefined && list.length === live.length ? "+" : ""} scheduled`}
          {list.length > live.length && <span className="text-ink-faint"> · {list.length - live.length}{next !== undefined ? "+" : ""} finished in the last 7 days</span>}
        </p>
        <Button size="sm" onClick={() => void load()}>Refresh</Button>
      </div>
      <p className="text-[13px] text-ink-muted">Cancelling a job that is running does not interrupt it; what it reports is ignored.</p>
      {problem !== undefined && <p className="text-[13px] text-danger" role="alert">{problem}</p>}
      <ul className="flex flex-col gap-2">
        {list.map((job) => {
          const state = STATE[job.state]
          const canCancel = LIVE.has(job.state) || job.state === "failed"
          const origin = originText(job.origin)
          return (
            <li key={job.id} className="flex flex-col gap-1 rounded-md border border-line/70 px-3 py-2.5" data-testid="scheduled-job" data-state={job.state}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <ToneDot tone={state.tone} className="self-center" />
                <span className="min-w-0 text-[14px] font-medium text-ink">{job.key ?? job.handler}</span>
                <span className="text-[13px] text-ink-muted">{job.moduleName}{job.orphaned ? " (removed)" : ""}</span>
                <span className="flex-1" />
                {canCancel && (
                  <Button size="sm" variant="quiet" disabled={busy === job.id} onClick={() => void cancel(job)} data-testid="scheduled-cancel">
                    {busy === job.id && <Spinner size={12} />}{job.state === "failed" ? "Dismiss" : "Cancel"}
                  </Button>
                )}
              </div>
              <p className={cx("text-[13px]", job.state === "failed" ? "text-warn" : "text-ink-muted")}>
                {state.label}
                {LIVE.has(job.state) ? ` · ${when(job.dueAt, now)}` : job.finishedAt !== undefined ? ` · ${when(job.finishedAt, now)}` : ""}
                {job.cron !== undefined && ` · repeats ${job.cron}${job.timeZone !== undefined ? ` (${job.timeZone})` : " (household time zone)"}`}
                {job.key !== undefined && ` · ${job.handler}`}
                {job.attempt > 1 && ` · attempt ${job.attempt}`}
                {origin !== "" && ` · ${origin}`}
              </p>
              {job.lastError !== undefined && <p className="text-[13px] text-ink-muted" data-testid="scheduled-error">{job.lastError}</p>}
            </li>
          )
        })}
      </ul>
      {next !== undefined && (
        <div>
          <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-testid="scheduled-more">
            {loadingMore && <Spinner size={12} />}Load more
          </Button>
        </div>
      )}
    </div>
  )
}
