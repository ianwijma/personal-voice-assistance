import { JOB_LOG_LINES, type JobAction, type JobInfo, type JobPhase, MAX_FINISHED_JOBS, type ToolId } from "@pva/protocol"

/**
 * Jobs (docs/SETTINGS-UI.md §4.6, §5.1): long-running work on the server with
 * progress, a short log and cancel, published to every page. Small on purpose
 * so the installers and logins of piece P6 can use it as is: a job is a
 * function of an `AbortSignal` and a reporter; the jobs model owns the state,
 * the limits and the throttled updates.
 *
 * Limits: one running job per tool and target; at most `maxRunning` at once.
 * Updates are throttled to one per `throttleMs` per job (state changes are
 * sent at once). Finished jobs are kept (the last `MAX_FINISHED_JOBS`) so a
 * page that reconnects sees how it ended. A server restart forgets them.
 */

export interface JobReporter {
  readonly phase: (phase: JobPhase) => void
  readonly progress: (done: number, total?: number) => void
  /** One line for the job's log (keep secrets out of it). */
  readonly log: (line: string) => void
}

export interface JobSpec {
  readonly tool: ToolId
  readonly action: JobAction
  readonly target: string
  readonly label: string
  /** The work. Rejecting fails the job with the error's message; after a cancel the outcome is `cancelled`. */
  readonly run: (signal: AbortSignal, report: JobReporter) => Promise<void>
  /** After it ended (any outcome). */
  readonly onEnd?: (job: JobInfo) => void
}

export type StartResult = { readonly ok: true; readonly job: JobInfo } | { readonly ok: false; readonly code: "busy"; readonly message: string }

export interface Jobs {
  readonly start: (spec: JobSpec) => StartResult
  /** `false` when there is no such running job. */
  readonly cancel: (id: string) => boolean
  /** Running and recently finished, oldest first. */
  readonly list: () => ReadonlyArray<JobInfo>
  readonly running: (tool: ToolId, target: string) => JobInfo | undefined
  /** Cancel everything (server shutdown). */
  readonly cancelAll: () => void
}

interface Entry {
  info: JobInfo
  readonly controller: AbortController
  timer: ReturnType<typeof setTimeout> | undefined
  dirty: boolean
}

export const makeJobs = (options: {
  readonly onChange: (job: JobInfo) => void
  readonly maxRunning?: number
  readonly throttleMs?: number
  readonly now?: () => number
}): Jobs => {
  const maxRunning = options.maxRunning ?? 2
  const throttleMs = options.throttleMs ?? 250
  const now = options.now ?? Date.now
  const entries: Array<Entry> = []
  let counter = 0

  const publish = (entry: Entry) => {
    entry.dirty = false
    try {
      options.onChange(entry.info)
    } catch {
      // a listener must not break a job
    }
  }
  /** Progress: at most one update per `throttleMs`. */
  const throttled = (entry: Entry) => {
    entry.dirty = true
    if (entry.timer !== undefined) return
    publish(entry)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (entry.dirty) throttled(entry)
    }, throttleMs)
    entry.timer.unref?.()
  }
  const flush = (entry: Entry) => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    publish(entry)
  }
  const isRunning = (e: Entry) => e.info.state === "running"
  const trim = () => {
    const finished = entries.filter((e) => !isRunning(e))
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_JOBS))) entries.splice(entries.indexOf(old), 1)
  }

  const start = (spec: JobSpec): StartResult => {
    const same = entries.find((e) => isRunning(e) && e.info.tool === spec.tool && e.info.target === spec.target)
    if (same !== undefined) return { ok: false, code: "busy", message: `${spec.label} is already being downloaded` }
    if (entries.filter(isRunning).length >= maxRunning) {
      return { ok: false, code: "busy", message: `${maxRunning} jobs are already running; wait for one to finish` }
    }
    const entry: Entry = {
      info: {
        id: `job-${++counter}`,
        tool: spec.tool,
        action: spec.action,
        target: spec.target,
        label: spec.label,
        state: "running",
        log: [],
        startedAt: now()
      },
      controller: new AbortController(),
      timer: undefined,
      dirty: false
    }
    entries.push(entry)
    trim()
    const reporter: JobReporter = {
      phase: (phase) => {
        if (!isRunning(entry) || entry.info.phase === phase) return
        const { progress: _p, ...rest } = entry.info
        entry.info = { ...rest, phase }
        flush(entry)
      },
      progress: (done, total) => {
        if (!isRunning(entry)) return
        entry.info = { ...entry.info, progress: { done, ...(total !== undefined ? { total } : {}), unit: "bytes" } }
        throttled(entry)
      },
      log: (line) => {
        if (!isRunning(entry)) return
        const clean = line.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 300)
        entry.info = { ...entry.info, log: [...entry.info.log, clean].slice(-JOB_LOG_LINES) }
        throttled(entry)
      }
    }
    flush(entry)
    const end = (state: JobInfo["state"], error?: string) => {
      if (!isRunning(entry)) return
      entry.info = { ...entry.info, state, endedAt: now(), ...(error !== undefined ? { error } : {}) }
      flush(entry)
      trim()
      try {
        spec.onEnd?.(entry.info)
      } catch {
        // ignore
      }
    }
    spec.run(entry.controller.signal, reporter).then(
      () => end(entry.controller.signal.aborted ? "cancelled" : "succeeded"),
      (error: unknown) =>
        entry.controller.signal.aborted
          ? end("cancelled")
          : end("failed", error instanceof Error ? error.message : String(error))
    )
    return { ok: true, job: entry.info }
  }

  return {
    start,
    cancel: (id) => {
      const entry = entries.find((e) => e.info.id === id && isRunning(e))
      if (entry === undefined) return false
      entry.controller.abort()
      return true
    },
    list: () => entries.map((e) => e.info),
    running: (tool, target) => entries.find((e) => isRunning(e) && e.info.tool === tool && e.info.target === target)?.info,
    cancelAll: () => {
      for (const e of entries) if (isRunning(e)) e.controller.abort()
    }
  }
}
