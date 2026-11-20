import { type Connector, contentTypes, maxMaxRequestBytes, type RefusedRule, type Resolver, type SafeFetchError, userAgent } from "@pva/net"
import { postFixedPublicJson } from "@pva/net/host"
import { REPORT_LABEL, REPORT_REPOSITORY, type ReportKind } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { closeOpenFence, wellFormed } from "./render.ts"

/**
 * Filing a report as an issue of `REPORT_REPOSITORY` (docs/REPORTS.md "Sending"): one `POST /repos/<repo>/issues` with
 * the install's token, through `@pva/net`'s `postFixedPublicJson` (public addresses only; sent once, never retried, no
 * redirect followed). No GitHub SDK. GitHub's answer is untrusted: only `number` and `html_url` are read, and the address
 * must be an issue of the repository. Every failure is one line for the admin page that never holds the token.
 */

export const GITHUB_API = "https://api.github.com"
export const ISSUES_PAGE = `https://github.com/${REPORT_REPOSITORY}/issues/`
/** An issue address of the repository, exactly: `https://github.com/<repo>/issues/<n>`. */
export const ISSUE_URL = new RegExp(`^${ISSUES_PAGE.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([1-9][0-9]{0,9})$`)
/** The time a send may take, inside the 5 s a tool or action has when it sends at once (`ACTION_TIMEOUT_MS`). */
export const SEND_TIMEOUT_MS = 3_500
/** The most characters of `lastError` (`ReportSummary.lastError`). */
export const MAX_LAST_ERROR = 300

export interface GitHubDeps {
  /** Default `GITHUB_API`; tests may name another public base their fixtures answer. */
  readonly apiBase?: string
  readonly resolver?: Resolver
  readonly connector?: Connector
  readonly timeoutMs?: number
}

export interface FiledIssue {
  readonly number: number
  readonly url: string
}

/** What GitHub's answer must hold (anything else in it is ignored). */
const CreatedIssue = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  html_url: Schema.String.check(Schema.isMaxLength(500))
})
const decodeCreated = Schema.decodeUnknownExit(Schema.fromJsonString(CreatedIssue))

export const labelsOf = (kind: ReportKind): ReadonlyArray<string> => [kind === "problem" ? "bug" : "enhancement", REPORT_LABEL]

/** The issue number of an address of the repository, or `undefined` when it is not one. */
export const issueNumberOf = (url: string): number | undefined => {
  const m = ISSUE_URL.exec(url)
  return m === null ? undefined : Number(m[1])
}

const oneLine = (text: string, token: string | undefined): string => {
  let t = text.replace(/\s+/g, " ").trim()
  if (token !== undefined && token.length > 0) t = t.split(token).join("[secret]")
  return t.length > MAX_LAST_ERROR ? `${t.slice(0, MAX_LAST_ERROR - 1)}…` : t
}

const MAYBE = "the issue may or may not have been filed: look at the repository's issues before sending again"

/**
 * Why a send failed: one line for `lastError` (never the token), and whether the issue may exist anyway (the request
 * may have reached GitHub). Decided from the failure's type, never from its text.
 */
export interface FileFailure {
  readonly message: string
  readonly maybeFiled: boolean
}

/** The refusals `@pva/net` makes before anything is connected: nothing reached GitHub. */
const REFUSED_BEFORE_CONNECTING: ReadonlySet<RefusedRule> = new Set(["scheme", "credentials", "port", "host-name", "address", "header", "options", "body"])

const statusFailure = (status: number, headers: Readonly<Record<string, string>>): FileFailure => {
  const limited = headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined
  // GitHub refused the request (4xx): no issue was made.
  const refused = (message: string): FileFailure => ({ message, maybeFiled: false })
  if (status === 401) return refused("GitHub refused the token (401): check it on the report module's page.")
  if ((status === 403 || status === 429) && limited) return refused(`GitHub's rate limit was reached (${status}): try again later.`)
  if (status === 403) return refused(`GitHub refused (403): the token may not be allowed to create issues in ${REPORT_REPOSITORY} (it needs Issues: read and write).`)
  if (status === 404) return refused(`GitHub answered 404: the repository ${REPORT_REPOSITORY} was not found, or the token cannot see it.`)
  if (status === 410) return refused(`Issues are switched off for ${REPORT_REPOSITORY} (410).`)
  if (status === 422) return refused("GitHub refused the issue as not valid (422): it may be too long, or hold something GitHub does not accept.")
  if (status === 429) return refused("GitHub asked to slow down (429): try again later.")
  if (status >= 500) return { message: `GitHub had a problem (${status}); ${MAYBE}.`, maybeFiled: true }
  return { message: `GitHub answered ${status}; ${MAYBE}.`, maybeFiled: true }
}

/** What a failure of `@pva/net` means for the issue: refused before it left, not reached, or possibly filed. */
const netFailure = (e: SafeFetchError, timeoutMs: number): FileFailure => {
  switch (e._tag) {
    case "NetTimeout":
      return { message: `GitHub did not answer within ${Math.round(timeoutMs / 100) / 10} s; ${MAYBE}.`, maybeFiled: true }
    case "NetAborted":
      return { message: `Sending was stopped; ${MAYBE}.`, maybeFiled: true }
    case "NetTooLarge":
      return { message: `GitHub's answer was too large to read; ${MAYBE}.`, maybeFiled: true }
    case "NetRefused":
      if (e.rule === "body") return { message: "The report is too large to send as it is (over 128 KiB as sent): shorten it, or file it by hand.", maybeFiled: false }
      if (REFUSED_BEFORE_CONNECTING.has(e.rule)) return { message: `Sending was refused before it left (${e.rule}).`, maybeFiled: false }
      // A refusal of the answer (a redirect, its type or encoding): the request reached GitHub.
      return { message: `GitHub's answer was refused (${e.rule}); ${MAYBE}.`, maybeFiled: true }
    case "NetFailure":
      // A lookup that failed, or a connect that wrote nothing.
      if (e.stage === "dns" || (e.stage === "connect" && e.requestSent !== true)) return { message: "GitHub could not be reached (is the server offline?). Nothing was sent.", maybeFiled: false }
      return { message: `The connection to GitHub failed; ${MAYBE}.`, maybeFiled: true }
  }
}

/**
 * File one issue. Sent once: a failure after the request may have reached GitHub says so (`maybeFiled`), and is not
 * sent again here.
 */
export const fileIssue = (
  deps: GitHubDeps,
  issue: { readonly token: string; readonly title: string; readonly body: string; readonly kind: ReportKind }
): Effect.Effect<FiledIssue, FileFailure> => {
  const url = `${(deps.apiBase ?? GITHUB_API).replace(/\/+$/, "")}/repos/${REPORT_REPOSITORY}/issues`
  const timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS
  const clean = (f: FileFailure): FileFailure => ({ ...f, message: oneLine(f.message, issue.token) })
  return postFixedPublicJson(url, {
    accept: contentTypes.json,
    body: { json: { title: wellFormed(issue.title), body: wellFormed(issue.body), labels: labelsOf(issue.kind) } },
    maxRequestBytes: maxMaxRequestBytes,
    maxBytes: 256 * 1024,
    timeoutMs,
    maxRedirects: 0,
    headers: {
      authorization: `Bearer ${issue.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": userAgent(undefined)
    },
    ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
    ...(deps.connector !== undefined ? { connector: deps.connector } : {})
  }).pipe(
    Effect.mapError((e) => clean(netFailure(e, timeoutMs))),
    Effect.flatMap((response) => {
      if (response.status !== 201 && response.status !== 200) return Effect.fail(clean(statusFailure(response.status, response.headers)))
      const decoded = decodeCreated(response.text())
      if (decoded._tag === "Failure") return Effect.fail(clean({ message: `GitHub answered, but not with an issue; ${MAYBE}.`, maybeFiled: true }))
      const { number, html_url } = decoded.value
      if (issueNumberOf(html_url) !== number) return Effect.fail(clean({ message: `GitHub answered with an address that is not an issue of ${REPORT_REPOSITORY}; ${MAYBE}.`, maybeFiled: true }))
      return Effect.succeed({ number, url: html_url })
    })
  )
}

/** The longest "new issue" address (`ReportDetail.newIssueUrl`). */
export const MAX_NEW_ISSUE_URL = 8_000
const CUT_NOTE = "\n\n_(Cut to fit an address: the full report is in the assistant's admin panel, Reports. Paste it here in place of this body.)_"

/**
 * GitHub's "new issue" page with the title, the labels and as much of the body as an address of at most
 * `MAX_NEW_ISSUE_URL` characters carries: the body cut at a line boundary with a note when it does not fit (`fits`
 * false). GitHub ignores the labels for an account that may not set them.
 */
export const newIssueUrl = (rawTitle: string, rawBody: string, kind: ReportKind): { readonly url: string; readonly fits: boolean } => {
  // `encodeURIComponent` throws on a lone surrogate: both are made well formed first, whatever the store holds.
  const title = wellFormed(rawTitle)
  const body = wellFormed(rawBody)
  const base = `https://github.com/${REPORT_REPOSITORY}/issues/new?title=${encodeURIComponent(title)}&labels=${encodeURIComponent(labelsOf(kind).join(","))}&body=`
  const whole = base + encodeURIComponent(body)
  if (whole.length <= MAX_NEW_ISSUE_URL) return { url: whole, fits: true }
  // Room for the note and for a fence that closes a block the cut left open.
  const room = MAX_NEW_ISSUE_URL - base.length - encodeURIComponent(CUT_NOTE).length - 200
  const lines = body.split("\n")
  // The most whole lines that fit, by bisection on the number of lines.
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (encodeURIComponent(lines.slice(0, mid).join("\n")).length <= room) lo = mid
    else hi = mid - 1
  }
  const part = closeOpenFence(lines.slice(0, lo).join("\n"))
  return { url: base + encodeURIComponent(part + CUT_NOTE), fits: false }
}
