import { MAX_REPORT_BODY_CHARS, MAX_REPORT_TITLE_CHARS, MAX_REPORTS_PAGE, REPORT_LABEL, REPORT_REPOSITORY, type ReportDetail, type ReportsResponse, type ReportSummary, type ReportUpdate } from "@pva/protocol"

/**
 * The mock server's reports, answering as the real server's `/api/reports` routes do (docs/REPORTS.md,
 * `apps/assistant/src/serve/reportsApi.ts`): a page at a time, newest first, with a `next` cursor of the server's shape
 * (`<createdAt>-<id>`; a malformed one is 400 `invalid_request`); ids of the server's shape (`r` and 16 hex digits); a
 * report that was not sent can be edited, a `sent` one is 409 `already_sent`; `issueUrl` records an issue filed by hand
 * (an issue address of the repository, at most 10 digits); send files it (409 when it was sent, 400 `no_token` without
 * a token) and fails for the seeded report `REPORT_IDS.failed`; delete answers `{ removed: true }`; while the server
 * keeps no reports (`available: false`) a report's routes are 503 `unavailable`. Every issue has a number, as every
 * issue the server records does.
 */
export class MockReportError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** The seeded reports' ids (the server's shape). */
export const REPORT_IDS = {
  draftProblem: "r00000000000000a1",
  draftFeature: "r00000000000000a2",
  failed: "r00000000000000a3",
  sent: "r00000000000000a4",
  old: (i: number) => `r00000000000001${i.toString(16).padStart(2, "0")}`
} as const
/** Sending this report fails (it is the seeded failed one: trying again fails again). */
export const FAILING_ID = REPORT_IDS.failed
/** The longest part of a body the mock's "new issue" address carries. */
const URL_BODY_CHARS = 2000
const ISSUE_URL = new RegExp(`^https://github\\.com/${REPORT_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/issues/([1-9][0-9]{0,9})$`)
const CURSOR = /^([0-9]{1,16})-(r[0-9a-f]{16})$/
/** The server's `lastError` for a refused token. */
const REFUSED_TOKEN = "GitHub refused the token (401): check it on the report module's page."

const bodyOf = (kind: "problem" | "feature", id: string, what: string) =>
  `<!-- pva-report v1 kind=${kind} id=${id} -->\n**Title:** \`${what}\`\n\n## What the person reported\n\n\`\`\`text\n${what}\n\`\`\`\n`

export const createReportsMock = (options: { readonly hasToken?: boolean; readonly sendImmediately?: boolean; readonly available?: boolean } = {}, now: () => number = Date.now) => {
  const t0 = now()
  let hasToken = options.hasToken ?? true
  let available = options.available ?? true
  const sendImmediately = options.sendImmediately ?? false
  let nextIssue = 100
  const make = (id: string, kind: "problem" | "feature", title: string, age: number, extra: Partial<ReportDetail> = {}): ReportDetail => ({
    id,
    kind,
    title,
    status: "draft",
    createdAt: t0 - age,
    updatedAt: t0 - age,
    body: bodyOf(kind, id, title),
    newIssueUrl: "",
    bodyFits: true,
    ...extra
  })
  let reports: Array<ReportDetail> = [
    make(REPORT_IDS.draftProblem, "problem", "The timer rang twice in the kitchen", 600_000, { deviceName: "Kitchen", assistantName: "Jev" }),
    make(REPORT_IDS.draftFeature, "feature", "Let the assistant read recipes aloud step by step", 3_600_000, { assistantName: "Jev" }),
    make(REPORT_IDS.failed, "problem", "It stops listening after a long answer", 7_200_000, { status: "failed", lastError: REFUSED_TOKEN, deviceName: "Study" }),
    make(REPORT_IDS.sent, "problem", "The wake phrase is missed in a noisy room", 86_400_000, { status: "sent", sentAt: t0 - 80_000_000, issue: { number: 42, url: `https://github.com/${REPORT_REPOSITORY}/issues/42` }, deviceName: "Living room", assistantName: "Jev" }),
    ...Array.from({ length: 21 }, (_, i) => make(REPORT_IDS.old(i), i % 2 === 0 ? "problem" : "feature", `Older report ${i}`, (i + 3) * 86_400_000, { status: "sent", issue: { number: 10 + i, url: `https://github.com/${REPORT_REPOSITORY}/issues/${10 + i}` } }))
  ]
  /** As the server's `newIssueUrl`: the title, the labels, then as much of the body as fits. */
  const withLink = (r: ReportDetail): ReportDetail => {
    const body = r.body.slice(0, URL_BODY_CHARS)
    const labels = encodeURIComponent([r.kind === "problem" ? "bug" : "enhancement", REPORT_LABEL].join(","))
    return { ...r, bodyFits: body.length === r.body.length, newIssueUrl: `https://github.com/${REPORT_REPOSITORY}/issues/new?title=${encodeURIComponent(r.title)}&labels=${labels}&body=${encodeURIComponent(body)}` }
  }
  const summary = (r: ReportDetail): ReportSummary => {
    const { body: _b, newIssueUrl: _n, bodyFits: _f, ...rest } = r
    return rest
  }
  const find = (id: string): ReportDetail => {
    if (!available) throw new MockReportError(503, "unavailable", "This server keeps no reports")
    const r = reports.find((x) => x.id === id)
    if (r === undefined) throw new MockReportError(404, "not_found", "There is no such report (it may have been removed)")
    return r
  }
  const replace = (r: ReportDetail) => {
    reports = reports.map((x) => (x.id === r.id ? r : x))
    return withLink(r)
  }
  const newest = (a: ReportDetail, b: ReportDetail) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)
  return {
    setToken: (on: boolean) => {
      hasToken = on
    },
    setAvailable: (on: boolean) => {
      available = on
    },
    list: (cursor?: string, limit: number = MAX_REPORTS_PAGE): ReportsResponse => {
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORTS_PAGE) throw new MockReportError(400, "invalid_request", `limit must be 1 to ${MAX_REPORTS_PAGE}`)
      if (!available) return { reports: [], available, repository: REPORT_REPOSITORY, hasToken, sendImmediately }
      let after: { readonly createdAt: number; readonly id: string } | undefined
      if (cursor !== undefined) {
        const m = CURSOR.exec(cursor)
        if (m === null) throw new MockReportError(400, "invalid_request", "That is not a page of the list")
        after = { createdAt: Number(m[1]), id: m[2]! }
      }
      const sorted = [...reports].sort(newest)
      const from = after === undefined ? sorted : sorted.filter((r) => r.createdAt < after!.createdAt || (r.createdAt === after!.createdAt && r.id < after!.id))
      const page = from.slice(0, limit)
      const last = page.at(-1)
      const base = { reports: page.map(summary), available, repository: REPORT_REPOSITORY, hasToken, sendImmediately }
      return from.length > limit && last !== undefined ? { ...base, next: `${last.createdAt}-${last.id}` } : base
    },
    get: (id: string): ReportDetail => withLink(find(id)),
    update: (id: string, patch: ReportUpdate): ReportDetail => {
      const r = find(id)
      if (patch.title === undefined && patch.body === undefined && patch.issueUrl === undefined) throw new MockReportError(400, "invalid_request", "Change the title, the body or the issue address")
      if (r.status === "sent") throw new MockReportError(409, "already_sent", "This report was sent already; it is not changed any more")
      if (patch.title !== undefined && (patch.title.trim() === "" || patch.title.length > MAX_REPORT_TITLE_CHARS)) throw new MockReportError(400, "invalid_request", "The title is empty")
      if (patch.body !== undefined && patch.body.length > MAX_REPORT_BODY_CHARS) throw new MockReportError(400, "invalid_request", `The request is not valid: the body is longer than ${MAX_REPORT_BODY_CHARS} characters`)
      let next: ReportDetail = { ...r, ...(patch.title !== undefined ? { title: patch.title.trim().replace(/\s+/g, " ") } : {}), ...(patch.body !== undefined ? { body: patch.body } : {}), updatedAt: now() }
      if (patch.issueUrl !== undefined) {
        const m = ISSUE_URL.exec(patch.issueUrl.trim())
        if (m === null) throw new MockReportError(400, "invalid_request", `The issue address must be https://github.com/${REPORT_REPOSITORY}/issues/<number>`)
        const { lastError: _e, ...rest } = next
        next = { ...rest, status: "sent", sentAt: now(), issue: { number: Number(m[1]), url: patch.issueUrl.trim() } }
      }
      return replace(next)
    },
    send: (id: string): ReportDetail => {
      const r = find(id)
      if (r.status === "sent") throw new MockReportError(409, "already_sent", "This report was sent already")
      if (!hasToken) throw new MockReportError(400, "no_token", "No GitHub token is set: set one on the report module's page, or file the issue by hand")
      if (id === FAILING_ID) return replace({ ...r, status: "failed", lastError: REFUSED_TOKEN, updatedAt: now() })
      const number = nextIssue++
      const { lastError: _e, ...rest } = r
      return replace({ ...rest, status: "sent", sentAt: now(), updatedAt: now(), issue: { number, url: `https://github.com/${REPORT_REPOSITORY}/issues/${number}` } })
    },
    remove: (id: string): void => {
      find(id)
      reports = reports.filter((x) => x.id !== id)
    }
  }
}
