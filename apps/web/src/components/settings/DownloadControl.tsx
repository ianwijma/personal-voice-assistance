"use client"
import { useState } from "react"
import type { JobInfo, ToolId } from "@pva/protocol"
import { lastJob, runningJob } from "@/lib/state.ts"
import { useClient, useClientState } from "../context.tsx"
import { Icon } from "../ui/Icon.tsx"
import { Button, cx } from "../ui/controls.tsx"

/** "1.2 GB" / "484 MB". */
export const formatMb = (mb: number): string => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`)

const PHASE: Readonly<Record<NonNullable<JobInfo["phase"]>, string>> = { check: "Checking disk space", download: "Downloading", unpack: "Unpacking" }

/** The share done of a job, 0–100, or undefined when not known. */
export const jobPercent = (job: JobInfo): number | undefined => {
  const p = job.progress
  if (p === undefined || p.total === undefined || p.total === 0) return undefined
  return Math.min(100, Math.floor((p.done / p.total) * 100))
}

/** A running job: phase, a bar, the percentage, and Cancel (admin). */
export function JobProgress({ job, admin }: { readonly job: JobInfo; readonly admin: boolean }) {
  const client = useClient()
  const percent = jobPercent(job)
  const [cancelling, setCancelling] = useState(false)
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5" data-testid="job-progress" data-job={job.id} data-phase={job.phase ?? ""}>
      <div className="flex items-center gap-3 text-[12px] text-ink-muted">
        <span aria-live="polite">{PHASE[job.phase ?? "check"]}{percent !== undefined ? ` · ${percent}%` : "…"}</span>
        {admin && (
          <Button
            size="sm"
            variant="quiet"
            className="ml-auto"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true)
              void client.cancelJob(job.id).finally(() => setCancelling(false))
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={`${PHASE[job.phase ?? "check"]} ${job.label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== undefined ? { "aria-valuenow": percent } : {})}
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={cx("h-full rounded-full bg-voice transition-[width] duration-200", percent === undefined && "w-1/3 animate-pulse")} style={percent !== undefined ? { width: `${percent}%` } : undefined} />
      </div>
    </div>
  )
}

/**
 * Download one model inline (docs/SETTINGS-UI.md §3.3: a missing model is an option with an action, not an error):
 * the Download button with the size, then the progress with Cancel, then "Downloaded". Admin pages only can start it;
 * every page sees the progress.
 */
export function DownloadControl({ tool, target, sizeMb, label }: { readonly tool: ToolId; readonly target: string; readonly sizeMb: number; readonly label?: string }) {
  const client = useClient()
  const admin = useClientState((s) => s.vault.admin)
  const job = useClientState((s) => runningJob(s, tool, target))
  const last = useClientState((s) => lastJob(s, tool, target))
  const installed = useClientState((s) => s.models.find((m) => m.tool === tool)?.items.find((i) => i.id === target)?.installed === true)
  const [error, setError] = useState<string | undefined>()
  const [starting, setStarting] = useState(false)
  if (job !== undefined) return <div className="flex" data-testid="download-control" data-target={target}><JobProgress job={job} admin={admin} /></div>
  if (installed) {
    return (
      <p className="flex items-center gap-1.5 text-[13px] text-ok" data-testid="download-control" data-target={target} data-state="installed">
        <Icon name="check" size={14} /> Downloaded
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1" data-testid="download-control" data-target={target} data-state="missing">
      <div className="flex flex-wrap items-center gap-3">
        {admin ? (
          <Button
            size="sm"
            disabled={starting}
            onClick={() => {
              setError(undefined)
              setStarting(true)
              void client.downloadModel(tool, target).then((r) => {
                setStarting(false)
                if (!r.ok) setError(r.error?.message ?? "Could not start the download.")
              })
            }}
            aria-label={`Download ${label ?? target} (${formatMb(sizeMb)})`}
          >
            <Icon name="arrowDown" size={14} /> Download · {formatMb(sizeMb)}
          </Button>
        ) : (
          <span className="text-[13px] text-ink-muted">Not downloaded ({formatMb(sizeMb)}). Log in to admin to download it.</span>
        )}
        {last?.state === "failed" && <span className="text-[13px] text-danger" role="alert">Last try failed: {last.error}</span>}
        {last?.state === "cancelled" && <span className="text-[13px] text-ink-muted">Cancelled.</span>}
      </div>
      {error !== undefined && <p role="alert" className="text-[13px] text-danger">{error}</p>}
    </div>
  )
}
