import { Schema } from "effect"

/**
 * Reports (docs/REPORTS.md): a problem or a feature idea a person told the assistant about, kept by the server as a
 * draft with everything known about the conversation, and sent to the project's GitHub repository as an issue once
 * the owner has read it. Read and changed through the admin API (admin session token only), not the socket, so the
 * protocol version does not change.
 *
 * - `GET /api/reports[?cursor=<next>&limit=<n>]`: one page of at most `MAX_REPORTS_PAGE`, newest first.
 * - `GET /api/reports/<id>`: one report with its body.
 * - `PUT /api/reports/<id>` with a `ReportUpdate`: change the title or the body of a report that was not sent, or
 *   record the issue the owner filed by hand (`issueUrl`; the report then counts as sent). The body of this request
 *   may be as large as `MAX_REPORT_REQUEST_BYTES`, not the admin API's usual limit.
 * - `POST /api/reports/<id>/send`: file it as an issue with the install's GitHub token. Answers the report as it is
 *   afterwards: `sent` with its issue, or `failed` with `lastError`. 409 when it was sent already, 400 `no_token`
 *   when no token is set.
 * - `DELETE /api/reports/<id>`: remove the local record (an issue that was filed stays on GitHub).
 */

export const REPORTS_ADMIN_PATH = "/api/reports"
/** The one repository every install reports to. */
export const REPORT_REPOSITORY = "ianwijma/personal-voice-assistance"
/** The label that marks an issue as filed by an assistant (applied only when the token may label; see `REPORT_MARKER`). */
export const REPORT_LABEL = "voice-report"
/**
 * The first line of every issue body filed from a report: `<!-- pva-report v1 kind=<kind> id=<id> -->`. An agent
 * that processes these issues finds them by this line, since GitHub drops labels set by an account without triage
 * rights.
 */
export const REPORT_MARKER = "pva-report"
export const MAX_REPORTS_PAGE = 20
export const MAX_REPORT_TITLE_CHARS = 200
/** GitHub refuses an issue body above 65,536 characters; the rest is headroom for the marker line. */
export const MAX_REPORT_BODY_CHARS = 60_000
/** The largest `PUT /api/reports/<id>` body, in bytes (a full body of four-byte characters, JSON-escaped, and the title). */
export const MAX_REPORT_REQUEST_BYTES = 512 * 1024

const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max))
const Time = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8.64e15 }))

export const ReportKind = Schema.Literals(["problem", "feature"])
export type ReportKind = typeof ReportKind.Type

/** `draft`: waits for the owner. `sent`: has an issue. `failed`: sending was tried and refused; it can be tried again. */
export const ReportStatus = Schema.Literals(["draft", "sent", "failed"])
export type ReportStatus = typeof ReportStatus.Type

export const ReportIssue = Schema.Struct({
  /** Absent for an issue the owner filed by hand whose address has no number the server could read. */
  number: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  url: text(500)
})
export type ReportIssue = typeof ReportIssue.Type

export const ReportSummary = Schema.Struct({
  id: text(64),
  kind: ReportKind,
  title: text(MAX_REPORT_TITLE_CHARS),
  status: ReportStatus,
  createdAt: Time,
  updatedAt: Time,
  /** Where it was said; absent for a device or assistant that has no name or is gone. */
  deviceName: Schema.optionalKey(text(200)),
  assistantName: Schema.optionalKey(text(200)),
  issue: Schema.optionalKey(ReportIssue),
  sentAt: Schema.optionalKey(Time),
  /** Why the last attempt to send failed (one line, never the token). */
  lastError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300)))
})
export type ReportSummary = typeof ReportSummary.Type

export const ReportDetail = Schema.Struct({
  ...ReportSummary.fields,
  /** The issue body, Markdown, as it will be (or was) filed. */
  body: Schema.String.check(Schema.isMaxLength(MAX_REPORT_BODY_CHARS)),
  /**
   * GitHub's "new issue" page with the title and as much of the body as an address can carry filled in: the way to
   * file without a token. `bodyFits` is false when the body had to be cut for it (the page then offers to copy it).
   */
  newIssueUrl: text(8200),
  bodyFits: Schema.Boolean
})
export type ReportDetail = typeof ReportDetail.Type

/** `GET /api/reports`. */
export const ReportsResponse = Schema.Struct({
  reports: Schema.Array(ReportSummary).check(Schema.isMaxLength(MAX_REPORTS_PAGE)),
  /** The server keeps no reports (a CLI mode, or no household store): the page says so. */
  available: Schema.Boolean,
  repository: text(200),
  /** Whether a GitHub token is set (never the token), and whether a new report is sent without waiting for the owner. */
  hasToken: Schema.Boolean,
  sendImmediately: Schema.Boolean,
  next: Schema.optionalKey(text(64))
})
export type ReportsResponse = typeof ReportsResponse.Type

/** `PUT /api/reports/<id>`: at least one field. */
export const ReportUpdate = Schema.Struct({
  title: Schema.optionalKey(text(MAX_REPORT_TITLE_CHARS)),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_REPORT_BODY_CHARS))),
  /** An issue of `REPORT_REPOSITORY` the owner filed by hand: `https://github.com/<repository>/issues/<n>`. */
  issueUrl: Schema.optionalKey(text(500))
})
export type ReportUpdate = typeof ReportUpdate.Type
