"use client"
import { useEffect, useRef, useState } from "react"
import { MAX_REPORT_BODY_CHARS, MAX_REPORT_TITLE_CHARS, REPORT_REPOSITORY, type ReportDetail, ReportDetail as ReportDetailSchema, type ReportSummary, ReportsResponse, type ReportUpdate } from "@pva/protocol"
import { Schema } from "effect"
import { resolveWsUrl } from "@/lib/connection.ts"
import { ApiError, apiBaseFor, makeVoiceApi, type VoiceApi } from "@/lib/voiceCatalog.ts"
import { useClient, useClientState } from "../../context.tsx"
import { Spinner } from "../../ui/Icon.tsx"
import { Button, cx, ToneDot } from "../../ui/controls.tsx"
import { when } from "./ScheduledJobsPage.tsx"

/**
 * Diagnostics › Reports (docs/REPORTS.md): the drafts the server keeps when someone tells an assistant about a problem
 * or a feature idea, read through the admin API (`GET /api/reports?cursor=…`, newest first, "Load more" reads the next
 * page). A report opens at `#settings/diagnostics/reports/<id>`: its title and text can be edited until it is sent,
 * then it is filed as an issue of the project's public repository with the install's GitHub token (Send to GitHub),
 * or by hand through the pre-filled "new issue" page of GitHub, after which the owner pastes the issue's address back.
 *
 * The list reads like the scheduled jobs' (docs/SCHEDULING.md): every first-page read starts a new reading, answers of
 * an older one are dropped, a report that comes twice is shown once. The detail view needs `hasToken`, which only the
 * list answer has, so it reads the first page (one report) next to the report.
 */

const STATUS: Readonly<Record<ReportSummary["status"], { readonly label: string; readonly tone: "ok" | "warning" | "error" | "neutral" }>> = {
  draft: { label: "Draft", tone: "warning" },
  sent: { label: "Sent", tone: "ok" },
  failed: { label: "Failed", tone: "error" }
}
const KIND: Readonly<Record<ReportSummary["kind"], string>> = { problem: "Problem", feature: "Feature idea" }

const decodeList = Schema.decodeUnknownSync(ReportsResponse)
const decodeDetail = Schema.decodeUnknownSync(ReportDetailSchema)

const REPORTS_PATH = ["diagnostics", "reports"] as const
const issueLabel = (issue: NonNullable<ReportSummary["issue"]>) => (issue.number !== undefined ? `Issue #${issue.number}` : "Issue")
/** As the server's (`apps/assistant/src/serve/reports/github.ts`, `ISSUE_URL`): an issue of the repository, at most 10 digits. */
const ISSUE_ADDRESS = new RegExp(`^https://github\\.com/${REPORT_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/[1-9][0-9]{0,9}$`)
/** The report module's display name, as Shared settings › Modules lists it (`packages/module-report`). */
const MODULE_NAME = "Reports"
const INPUT = "w-full rounded-md border border-line bg-bg px-2.5 py-2 text-base text-ink placeholder:text-ink-faint focus-visible:border-you read-only:text-ink-muted sm:text-[14px]"
const LINK = "text-voice underline underline-offset-2 hover:no-underline"

const IssueLink = ({ issue }: { readonly issue: NonNullable<ReportSummary["issue"]> }) => (
  <a href={issue.url} target="_blank" rel="noreferrer noopener" className={LINK} data-testid="report-issue">{issueLabel(issue)}</a>
)

/** What went wrong, in words, for the page's error line. */
const problemOf = (e: unknown, fallback: string): string => {
  if (!(e instanceof ApiError)) return fallback
  if (e.status === 404) return "This report is gone (it may have been deleted elsewhere). Go back to the list."
  if (e.status === 409 && e.code === "sending") return "This report is being sent right now, from another tab or window. Wait a moment, then open it again to see how that went."
  if (e.status === 409) return "This report was sent already, so it cannot be changed or sent again."
  if (e.status === 503) return "The server cannot read its reports right now (see its log). Try again after it restarts."
  if (e.code === "no_token") return "No GitHub token is set, so it cannot be sent from here. Open it on GitHub instead."
  return e.message
}

export function ReportsPage({ api: given }: { readonly api?: VoiceApi } = {}) {
  const api = useRef(given ?? makeVoiceApi(() => apiBaseFor(resolveWsUrl(location)))).current
  const id = useClientState((s) => s.ui.settingsPath[2])
  return id === undefined ? <ReportList api={api} /> : <ReportView key={id} api={api} id={id} />
}

function ReportList({ api }: { readonly api: VoiceApi }) {
  const client = useClient()
  const [reports, setReports] = useState<ReadonlyArray<ReportSummary> | undefined>(undefined)
  const [info, setInfo] = useState<Pick<ReportsResponse, "repository" | "hasToken" | "sendImmediately"> | undefined>(undefined)
  const [next, setNext] = useState<string | undefined>(undefined)
  const [available, setAvailable] = useState(true)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  /** The reading of the list: every first-page read starts a new one; answers of older ones are dropped. */
  const generation = useRef(0)
  /** The cursor "Load more" may use, with the reading that produced it (none while a first page or a page is read). */
  const cursor = useRef<{ readonly generation: number; readonly next: string } | undefined>(undefined)
  /** The ids shown for the current reading: a report that comes again is left out. */
  const seen = useRef(new Set<string>())
  const fresh = (list: ReadonlyArray<ReportSummary>, ids: Set<string>) =>
    list.filter((r) => {
      if (ids.has(r.id)) return false
      ids.add(r.id)
      return true
    })

  /** The first page again (on Refresh): true when it was read and shown. */
  const load = async (): Promise<boolean> => {
    const mine = ++generation.current
    cursor.current = undefined
    try {
      const body = decodeList(await (await api.request("reports")).json())
      if (mine !== generation.current) return false
      const ids = new Set<string>()
      seen.current = ids
      setReports(fresh(body.reports, ids))
      setInfo({ repository: body.repository, hasToken: body.hasToken, sendImmediately: body.sendImmediately })
      cursor.current = body.next === undefined ? undefined : { generation: mine, next: body.next }
      setNext(body.next)
      setAvailable(body.available)
      setProblem(undefined)
      setNow(Date.now())
      return true
    } catch (e) {
      if (mine === generation.current) setProblem(e instanceof ApiError ? e.message : "The reports could not be read.")
      return false
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const loadMore = async () => {
    const from = cursor.current
    if (from === undefined || from.generation !== generation.current) return
    cursor.current = undefined
    const mine = from.generation
    setLoadingMore(true)
    try {
      const body = decodeList(await (await api.request(`reports?cursor=${encodeURIComponent(from.next)}`)).json())
      if (mine !== generation.current) return
      const added = fresh(body.reports, seen.current)
      setReports((old) => [...(old ?? []), ...added])
      cursor.current = body.next === undefined ? undefined : { generation: mine, next: body.next }
      setNext(body.next)
      setProblem(undefined)
    } catch (e) {
      if (mine !== generation.current) return
      cursor.current = from
      // The server no longer knows the page: start again from the top, and say so only when that worked.
      if (e instanceof ApiError && e.status === 400) {
        if (await load()) setProblem("The list changed; it was read again from the top.")
      } else setProblem(e instanceof ApiError ? e.message : "More reports could not be read.")
    } finally {
      setLoadingMore(false)
    }
  }

  if (reports === undefined && problem === undefined) return <p className="text-[14px] text-ink-muted"><Spinner size={12} /> Reading the reports…</p>
  if (!available) return <p className="text-[14px] text-ink-muted" data-testid="no-reports">This server keeps no reports right now: it cannot store them here, or could not read them when it started (its log says why).</p>
  const list = reports ?? []

  return (
    <div className="flex flex-col gap-4" data-testid="reports">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 text-[14px] text-ink" data-testid="reports-where">
          Reports go to{" "}
          {info !== undefined
            ? <a href={`https://github.com/${info.repository}/issues`} target="_blank" rel="noreferrer noopener" className={cx(LINK, "break-all")}>{info.repository}</a>
            : "the project's repository"}
          , which is public.
        </p>
        <Button size="sm" onClick={() => void load()} data-testid="reports-refresh">Refresh</Button>
      </div>
      {info !== undefined && (
        <p className="text-[13px] text-ink-muted" data-testid="reports-sending">
          {info.hasToken
            ? info.sendImmediately
              ? "A GitHub token is set, and new reports are sent at once."
              : "A GitHub token is set. New reports wait here until you send them."
            : `No GitHub token is set, so reports are kept here and can be filed by hand from each report. Set the token under Shared settings › Modules › ${MODULE_NAME}.`}
        </p>
      )}
      {problem !== undefined && <p className="text-[13px] text-danger" role="alert" data-testid="reports-error">{problem}</p>}
      {list.length === 0 && problem === undefined && (
        <p className="text-[14px] text-ink-muted" data-testid="reports-empty">
          Nothing has been reported yet. Say &ldquo;report a problem&rdquo; or &ldquo;I have a feature idea&rdquo; to an assistant with the {MODULE_NAME} module switched on.
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {list.map((r) => {
          const status = STATUS[r.status]
          const where = [r.deviceName, r.assistantName].filter((x) => x !== undefined).join(" · ")
          return (
            <li key={r.id} className="flex flex-col gap-1 rounded-md border border-line/70 px-3 py-2.5" data-testid="report" data-status={r.status} data-kind={r.kind}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <ToneDot tone={status.tone} className="self-center" />
                <button
                  type="button"
                  onClick={() => client.settings([...REPORTS_PATH, r.id])}
                  className="min-w-0 break-words text-left text-[14px] font-medium text-ink hover:underline"
                  data-testid="report-open"
                >
                  {r.title}
                </button>
                <span className="text-[13px] text-ink-muted">{KIND[r.kind]}</span>
              </div>
              <p className={cx("text-[13px]", r.status === "failed" ? "text-warn" : "text-ink-muted")}>
                {status.label} · {when(r.createdAt, now)}
                {where !== "" && ` · ${where}`}
                {r.issue !== undefined && <> · <IssueLink issue={r.issue} /></>}
              </p>
              {r.lastError !== undefined && r.lastError !== "" && <p className="break-words text-[13px] text-ink-muted" data-testid="report-last-error">{r.lastError}</p>}
            </li>
          )
        })}
      </ul>
      {next !== undefined && (
        <div>
          <Button size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-testid="reports-more">
            {loadingMore && <Spinner size={12} />}Load more
          </Button>
        </div>
      )}
    </div>
  )
}

type Busy = "save" | "send" | "delete" | "hand"

function ReportView({ api, id }: { readonly api: VoiceApi; readonly id: string }) {
  const client = useClient()
  const [report, setReport] = useState<ReportDetail | undefined>(undefined)
  const [hasToken, setHasToken] = useState(false)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<Busy | undefined>(undefined)
  const [address, setAddress] = useState("")
  const [addressProblem, setAddressProblem] = useState<string | undefined>(undefined)
  /** Set while a request that changes the report is on its way: a second press does nothing. */
  const working = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const show = (r: ReportDetail) => {
    setReport(r)
    setTitle(r.title)
    setBody(r.body)
  }
  const load = async () => {
    try {
      const [one, list] = await Promise.all([api.request(`reports/${encodeURIComponent(id)}`), api.request("reports?limit=1")])
      const detail = decodeDetail(await one.json())
      const info = decodeList(await list.json())
      if (!alive.current) return
      setHasToken(info.hasToken)
      show(detail)
      setProblem(undefined)
    } catch (e) {
      if (alive.current) setProblem(problemOf(e, "The report could not be read."))
    }
  }
  useEffect(() => {
    void load()
  }, [id])

  const unsent = report !== undefined && report.status !== "sent"
  const titleChanged = report !== undefined && title !== report.title
  const bodyChanged = report !== undefined && body !== report.body
  const dirty = unsent && (titleChanged || bodyChanged)
  // The settings screen asks "Leave without saving?" while there are edits.
  useEffect(() => {
    if (client.store.get().ui.settingsDirty !== dirty) client.store.dispatch({ type: "local/ui", patch: { settingsDirty: dirty } })
  }, [client, dirty])
  useEffect(() => () => client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } }), [client])

  /** Runs one request that changes the report, once at a time; its failure is the page's problem. */
  const run = async (what: Busy, fallback: string, f: () => Promise<void>) => {
    if (working.current) return
    working.current = true
    setBusy(what)
    setNotice(undefined)
    try {
      await f()
      if (alive.current) setProblem(undefined)
    } catch (e) {
      // Sent elsewhere: show what is there now, and still say why this did not work. Being sent elsewhere: keep the
      // edits on the page (nothing is read over them), and say so.
      const sentElsewhere = e instanceof ApiError && e.status === 409 && e.code !== "sending"
      const hadEdits = dirty
      if (sentElsewhere && alive.current) await load()
      if (alive.current) setProblem(problemOf(e, fallback) + (sentElsewhere && hadEdits ? " Your unsaved edits were replaced by the report as it was sent." : ""))
    } finally {
      working.current = false
      if (alive.current) setBusy(undefined)
    }
  }
  /** Saves the edits (only the changed fields); throws when it fails. */
  const save = async () => {
    if (report === undefined) return
    if (titleChanged && title.trim() === "") throw new ApiError(400, "invalid_request", "The title cannot be empty.")
    const patch: ReportUpdate = { ...(titleChanged ? { title } : {}), ...(bodyChanged ? { body } : {}) }
    show(decodeDetail(await (await api.request(`reports/${encodeURIComponent(id)}`, { method: "PUT", body: patch })).json()))
  }
  const onSave = () => run("save", "The report was not saved.", async () => {
    await save()
    if (alive.current) setNotice("Saved.")
  })
  const onSend = () => run("send", "The report was not sent.", async () => {
    if (dirty) await save()
    const sent = decodeDetail(await (await api.request(`reports/${encodeURIComponent(id)}/send`, { method: "POST" })).json())
    if (alive.current) show(sent)
  })
  const onHand = () => {
    const url = address.trim()
    if (!ISSUE_ADDRESS.test(url)) return setAddressProblem(`That is not an issue of ${REPORT_REPOSITORY}. It looks like https://github.com/${REPORT_REPOSITORY}/issues/123.`)
    setAddressProblem(undefined)
    return run("hand", "The issue address was not saved.", async () => {
      show(decodeDetail(await (await api.request(`reports/${encodeURIComponent(id)}`, { method: "PUT", body: { issueUrl: url } satisfies ReportUpdate })).json()))
      if (alive.current) setAddress("")
    })
  }
  const onDelete = () => {
    if (report === undefined) return
    if (!window.confirm(`Delete "${report.title}"? An issue already filed from it stays on GitHub.`)) return
    return run("delete", "The report was not deleted.", async () => {
      await api.request(`reports/${encodeURIComponent(id)}`, { method: "DELETE" })
      client.store.dispatch({ type: "local/ui", patch: { settingsDirty: false } })
      client.settings(REPORTS_PATH)
    })
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body)
      setNotice("The full text is copied.")
    } catch {
      setProblem("The text could not be copied. Select it in the box and copy it by hand.")
    }
  }

  const back = (
    <div>
      <Button size="sm" variant="quiet" onClick={() => client.settings(REPORTS_PATH)} data-testid="report-back">‹ All reports</Button>
    </div>
  )
  if (report === undefined) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        {problem !== undefined ? <p className="text-[13px] text-danger" role="alert" data-testid="report-error">{problem}</p> : <p className="text-[14px] text-ink-muted"><Spinner size={12} /> Reading the report…</p>}
      </div>
    )
  }
  const status = STATUS[report.status]
  const nearLimit = body.length >= MAX_REPORT_BODY_CHARS * 0.9
  const locked = busy !== undefined

  return (
    <div className="flex flex-col gap-4" data-testid="report-detail" data-status={report.status} aria-busy={locked}>
      {back}
      <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-ink-muted">
        <ToneDot tone={status.tone} className="self-center" />
        <span data-testid="report-status">{status.label}</span>
        <span>· {KIND[report.kind]} · {when(report.createdAt, Date.now())}</span>
        {[report.deviceName, report.assistantName].filter((x) => x !== undefined).length > 0 && <span>· {[report.deviceName, report.assistantName].filter((x) => x !== undefined).join(" · ")}</span>}
        {report.issue !== undefined && <span>· <IssueLink issue={report.issue} /></span>}
      </p>
      {report.status === "failed" && report.lastError !== undefined && <p className="break-words text-[13px] text-warn" data-testid="report-last-error">The last attempt to send it did not work. {report.lastError}</p>}
      {problem !== undefined && <p className="break-words text-[13px] text-danger" role="alert" data-testid="report-error">{problem}</p>}
      {notice !== undefined && <p className="text-[13px] text-ink-muted" role="status" data-testid="report-notice">{notice}</p>}
      {unsent && (
        <p className="rounded-md border border-warn/50 px-3 py-2 text-[13px] text-ink" data-testid="report-public-notice">
          The repository ({REPORT_REPOSITORY}) is public. Everything in this text becomes public when the report is sent. Read it, and remove anything that should not be published.
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="report-title" className="text-[13px] font-medium text-ink-muted">Title</label>
        <input id="report-title" className={INPUT} value={title} maxLength={MAX_REPORT_TITLE_CHARS} readOnly={!unsent} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="report-body" className="text-[13px] font-medium text-ink-muted">Text (Markdown)</label>
        <textarea
          id="report-body"
          className={cx(INPUT, "min-h-[22rem] resize-y overflow-auto font-mono !text-[13px] leading-snug")}
          value={body}
          maxLength={MAX_REPORT_BODY_CHARS}
          readOnly={!unsent}
          disabled={locked}
          onChange={(e) => setBody(e.target.value)}
        />
        {unsent && nearLimit && <p className="text-[12px] text-ink-muted" data-testid="report-count">{body.length} of {MAX_REPORT_BODY_CHARS} characters</p>}
      </div>
      {unsent && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!dirty || locked} onClick={() => void onSave()} data-testid="report-save">
              {busy === "save" && <Spinner size={12} />}Save
            </Button>
            {hasToken && (
              <Button size="sm" variant="primary" disabled={locked} onClick={() => void onSend()} data-testid="report-send">
                {busy === "send" && <Spinner size={12} />}Send to GitHub
              </Button>
            )}
            <a href={report.newIssueUrl} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center rounded-md border border-line bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-2 max-sm:h-11" data-testid="report-open-github">
              Open on GitHub
            </a>
          </div>
          {!hasToken && <p className="text-[13px] text-ink-muted">No GitHub token is set, so this report cannot be sent from here. Open it on GitHub to file it yourself (edits you have not saved are not in that link).</p>}
          {!report.bodyFits && (
            <div className="flex flex-wrap items-center gap-2" data-testid="report-shortened">
              <p className="min-w-0 flex-1 text-[13px] text-ink-muted">The text was shortened for the GitHub link. Copy the full text and paste it into the issue.</p>
              <Button size="sm" onClick={() => void copy()} data-testid="report-copy">Copy full text</Button>
            </div>
          )}
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              void onHand()
            }}
          >
            <label htmlFor="report-issue-address" className="text-[13px] font-medium text-ink-muted">Filed it by hand? Paste the issue address</label>
            <div className="flex flex-wrap gap-2">
              <input
                id="report-issue-address"
                className={cx(INPUT, "min-w-0 flex-1")}
                value={address}
                placeholder={`https://github.com/${REPORT_REPOSITORY}/issues/123`}
                inputMode="url"
                autoComplete="off"
                aria-invalid={addressProblem !== undefined}
                aria-describedby={addressProblem !== undefined ? "report-issue-address-problem" : undefined}
                disabled={locked}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setAddressProblem(undefined)
                }}
              />
              <Button size="sm" type="submit" disabled={locked || address.trim() === ""} data-testid="report-hand">
                {busy === "hand" && <Spinner size={12} />}Save address
              </Button>
            </div>
            {addressProblem !== undefined && <p id="report-issue-address-problem" className="text-[13px] text-danger" role="alert" data-testid="report-address-error">{addressProblem}</p>}
          </form>
        </>
      )}
      <div>
        <Button size="sm" variant="danger" disabled={locked} onClick={() => void onDelete()} data-testid="report-delete">
          {busy === "delete" && <Spinner size={12} />}Delete
        </Button>
      </div>
    </div>
  )
}
