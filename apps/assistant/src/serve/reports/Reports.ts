import { CurrentTurn, type HouseholdStore, type ReportDrafted, type ReportInput, type ReportsService, type ReportsSettings } from "@pva/core"
import { MAX_REPORT_TITLE_CHARS, type ReportDetail, type ReportSummary, type ReportUpdate } from "@pva/protocol"
import { Clock, Data, Effect } from "effect"
import { randomBytes } from "node:crypto"
import { gatherFacts, type ReportSources } from "./context.ts"
import { fileIssue, type FiledIssue, type GitHubDeps, issueNumberOf, ISSUE_URL, MAX_LAST_ERROR, newIssueUrl, SEND_TIMEOUT_MS } from "./github.ts"
import { fitBody, renderReport } from "./render.ts"
import { makeScrubber } from "./scrub.ts"
import { removeReport, reportParts, REPORT_ID, type ReportRow, reports, REPORTS_OWNER, storedLine, type StoredReport, writeParts } from "./store.ts"

/**
 * The host's reports (docs/REPORTS.md): the core's `Reports` service a module drafts with, and what the admin API reads
 * and changes. Reports are rows of `core.reports` (`store.ts`); a summary of each is kept in memory (at most
 * `MAX_KEPT_REPORTS`), read once at start, so the list never scans the store.
 *
 * - `draft` gathers the turn's context (`context.ts`), renders the body (`render.ts`, secrets scrubbed), and keeps the
 *   report. It never waits on GitHub, unless the module's settings send at once with a token: then it sends once,
 *   within `SEND_TIMEOUT_MS`, and answers `sent` or `failed`.
 * - `send` (the admin page's Send) files one issue with the token, once: never retried, never sent twice at the same
 *   time, and not interrupted by the page going away (a POST that reached GitHub is recorded).
 * - A send writes `attemptedAt` before the request leaves and clears it when the result is recorded. A report left with
 *   it (the process stopped, or the answer was lost) is shown `failed`, saying it may have been filed. When GitHub said
 *   201 but the record could not be written, the issue is kept in memory (the report counts as sent) and written again
 *   at the next use, so it is never posted twice.
 * - Past `MAX_KEPT_REPORTS`, a new report takes the place of the oldest sent one, else of the oldest one; never of one
 *   being sent.
 * - Reports could not be read at start: `available()` is false (no draft, no eviction over a miscounted index).
 */

/** The id of the one module the service is given to (`moduleCoreServices` in serve mode). */
export const REPORT_MODULE_ID = "report"
/** `lastError` of a report whose send was started and whose result was never recorded. */
export const MAYBE_FILED = "A send was started but its result was not recorded (the server stopped, or the answer was lost): the issue may have been filed. Look at the repository's issues before sending again, and record its address if it is there."

/** The most reports kept. */
export const MAX_KEPT_REPORTS = 300
/** The admin page's Send has longer than a turn's immediate send. */
const ADMIN_SEND_TIMEOUT_MS = 10_000
const MAX_DESCRIPTION_CHARS = 8_000

export class ReportsFailure extends Data.TaggedError("ReportsFailure")<{ readonly status: number; readonly code: string; readonly message: string }> {}

const fail = (status: number, code: string, message: string) => Effect.fail(new ReportsFailure({ status, code, message }))

export interface ReportsOptions {
  readonly store: HouseholdStore
  readonly sources: ReportSources
  /** Secret values the server knows (the key vault's, the environment's): replaced in every report. */
  readonly knownSecrets: () => Iterable<string>
  readonly github?: GitHubDeps
  readonly log?: (line: string) => void
  /** The report module took its settings back (`configure(undefined)`): what is kept for reports goes (previous conversations). */
  readonly onStopped?: () => void
}

export interface ReportsHost {
  /** The core service (`host.service(Reports)`: `Reports.of(service)` in `coreServices`). */
  readonly service: ReportsService
  /** Whether reports can be kept (the store is writable and the reports' data usable). */
  readonly available: () => boolean
  readonly settings: () => { readonly hasToken: boolean; readonly sendImmediately: boolean }
  /** Whether the report module runs (it handed its settings over): only then is anything kept for reports. */
  readonly active: () => boolean
  /** Newest first, `limit` at a time; `cursor` is a page's `next`. */
  readonly list: (query: { readonly cursor?: string; readonly limit: number }) => Effect.Effect<{ readonly reports: ReadonlyArray<ReportSummary>; readonly next?: string }, ReportsFailure>
  readonly get: (id: string) => Effect.Effect<ReportDetail, ReportsFailure>
  readonly update: (id: string, patch: ReportUpdate) => Effect.Effect<ReportDetail, ReportsFailure>
  readonly send: (id: string) => Effect.Effect<ReportDetail, ReportsFailure>
  readonly remove: (id: string) => Effect.Effect<void, ReportsFailure>
}

/** A page's `next`: the created time and the id of its last report. */
const CURSOR = /^([0-9]{1,16})-(r[0-9a-f]{16})$/

const newest = (a: ReportRow, b: ReportRow) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

const summaryOf = (row: ReportRow): ReportSummary => {
  const v = row.value
  return {
    id: row.id,
    kind: v.kind,
    title: v.title,
    status: v.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(v.deviceName !== undefined ? { deviceName: v.deviceName } : {}),
    ...(v.assistantName !== undefined ? { assistantName: v.assistantName } : {}),
    ...(v.issueUrl !== undefined ? { issue: { url: v.issueUrl, ...(v.issueNumber !== undefined ? { number: v.issueNumber } : {}) } } : {}),
    ...(v.sentAt !== undefined ? { sentAt: v.sentAt } : {}),
    ...(v.lastError !== undefined ? { lastError: v.lastError } : {})
  }
}

const storeFailure = (what: string) => (e: { readonly message: string; readonly reason?: string }) =>
  new ReportsFailure({ status: e.reason === "busy" || e.reason === "unavailable" ? 503 : 500, code: e.reason ?? "failed", message: `${what}: ${e.message}`.slice(0, 300) })

export const makeReports = (options: ReportsOptions): Effect.Effect<ReportsHost> =>
  Effect.gen(function*() {
    const core = options.store.forCore(REPORTS_OWNER)
    const log = options.log ?? (() => undefined)
    const index = new Map<string, ReportRow>()
    const sending = new Set<string>()
    let config: ReportsSettings | undefined
    const usable = () => options.store.availability(REPORTS_OWNER) === undefined && !core.readOnly

    /** Issues GitHub filed whose record could not be written yet: kept, and written at the next use. */
    const pending = new Map<string, { readonly issue: FiledIssue; readonly at: number }>()
    let loadedOk = false
    // Read every report's row once (a bounded number, in pages of what one list may read).
    if (usable()) {
      const loaded = yield* Effect.gen(function*() {
        let after: ReportRow | undefined
        for (let page = 0; page < 1_000; page++) {
          const rows = yield* core.collection(reports).list({ orderBy: { field: "createdAt", direction: "asc" }, limit: 6, ...(after !== undefined ? { after } : {}) })
          for (const r of rows) index.set(r.id, r)
          if (rows.length < 6) return
          after = rows.at(-1)
        }
      }).pipe(Effect.result)
      if (loaded._tag === "Failure") {
        index.clear()
        yield* Effect.logWarning(`Reports could not be read, so none are kept or shown until a restart: ${loaded.failure.message}`)
      } else loadedOk = true
    }
    const available = () => usable() && loadedOk

    // A send that started and never recorded its result (the process stopped): it may have been filed.
    for (const row of [...index.values()]) {
      if (row.value.attemptedAt === undefined || row.value.status !== "draft") continue
      const marked = yield* core.collection(reports).update(row.id, (v) => ({ ...v, status: "failed", lastError: MAYBE_FILED })).pipe(Effect.result)
      index.set(row.id, marked._tag === "Success" ? marked.success : { ...row, value: { ...row.value, status: "failed", lastError: MAYBE_FILED } })
    }

    const scrubber = () => makeScrubber([...options.knownSecrets(), config?.token])

    const sentValue = (v: StoredReport, issue: FiledIssue, at: number): StoredReport => {
      const { lastError: _, attemptedAt: __, ...rest } = v
      return { ...rest, status: "sent", issueNumber: issue.number, issueUrl: issue.url, sentAt: at }
    }
    /** Write the issues GitHub filed whose record failed before; one that still fails stays pending. */
    const flushPending = Effect.suspend(() =>
      Effect.forEach([...pending], ([id, p]) =>
        core.collection(reports).update(id, (v) => sentValue(v, p.issue, p.at)).pipe(
          Effect.tap((row) => Effect.sync(() => {
            pending.delete(id)
            index.set(id, row)
          })),
          Effect.catchTag("StoreNotFound", () => Effect.sync(() => void pending.delete(id))),
          Effect.ignore
        ), { discard: true })
    )

    const rowOf = (id: string) => (REPORT_ID.test(id) ? index.get(id) : undefined)
    const found = (id: string) =>
      Effect.andThen(flushPending, Effect.suspend(() => {
        if (!available()) return fail(503, "unavailable", "Reports cannot be read here now (see the server's log)")
        const row = rowOf(id)
        return row === undefined ? fail(404, "not_found", "There is no such report (it may have been removed)") : Effect.succeed(row)
      }))

    /** The body from its parts, read one by one (a read, no transaction); `undefined` when a part is missing. */
    const bodyOf = (row: ReportRow) =>
      Effect.forEach(Array.from({ length: row.value.parts }, (_, n) => n), (n) => core.collection(reportParts).get(`${row.id}.${n}`)).pipe(
        Effect.map((parts) => (parts.some((p) => p === undefined) ? undefined : parts.map((p) => p!.value.text).join(""))),
        Effect.mapError(storeFailure("The report could not be read"))
      )

    const detailOf = (row: ReportRow) =>
      Effect.map(bodyOf(row), (stored): ReportDetail => {
        const body = stored ?? "(The body of this report is missing from the store.)"
        const link = newIssueUrl(row.value.title, body, row.value.kind)
        return { ...summaryOf(row), body, newIssueUrl: link.url, bodyFits: link.fits }
      })

    /** Change a report's row (and its body) in one transaction; the index follows the commit. */
    const change = (row: ReportRow, f: (v: StoredReport) => StoredReport, body?: string) =>
      core.transaction((tx) => {
        let parts = row.value.parts
        if (body !== undefined) parts = writeParts(tx, row.id, row.value.parts, body)
        return tx.collection(reports).update(row.id, (v) => ({ ...f(v), parts }))
      }).pipe(
        Effect.tap((next) => Effect.sync(() => void index.set(next.id, next))),
        Effect.mapError(storeFailure("The report could not be saved"))
      )

    /**
     * File report `row` as an issue, once, and record what came of it. It claims the report first, in one step with the
     * check (a report being sent is refused `sending`, so two sends never overlap), and lets go when done.
     * Uninterruptible from the claim on: a POST that may have reached GitHub is always recorded (its time limit bounds
     * it), and a claim is never left behind.
     *
     * 1. `attemptedAt` is written before the request leaves (a failure there sends nothing).
     * 2. The POST, once.
     * 3. Filed: recorded as sent, tried three times; still failing, the issue is kept in memory (`pending`) and the
     *    report counts as sent, so a second Send is refused rather than posted. Not filed: `failed`, the marker cleared.
     *    Perhaps filed (the answer was lost): `failed`, the marker kept, `lastError` saying so.
     */
    const fileOnce = (row: ReportRow, token: string, timeoutMs: number) =>
      Effect.uninterruptible(Effect.suspend(() => {
        if (sending.has(row.id)) return fail(409, "sending", "This report is being sent")
        sending.add(row.id)
        return Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis
          const marked = yield* change(row, (v) => ({ ...v, attemptedAt: started }))
          const body = (yield* bodyOf(marked)) ?? ""
          const scrub = scrubber().scrub
          const outcome = yield* fileIssue({ ...options.github, timeoutMs: options.github?.timeoutMs ?? timeoutMs }, { token, title: scrub(marked.value.title), body: scrub(body), kind: marked.value.kind }).pipe(Effect.result)
          const at = yield* Clock.currentTimeMillis
          const fresh = index.get(row.id) ?? marked
          if (outcome._tag === "Success") {
            const issue = outcome.success
            const written = yield* change(fresh, (v) => sentValue(v, issue, at)).pipe(Effect.retry({ times: 2 }), Effect.result)
            if (written._tag === "Success") return written.success
            // GitHub has the issue: never post it again. Kept here and written at the next use.
            log(`Report ${row.id} was filed as issue ${issue.number}, but the record could not be written yet: ${written.failure.message}`)
            pending.set(row.id, { issue, at })
            const shown: ReportRow = { ...fresh, value: sentValue(fresh.value, issue, at) }
            index.set(row.id, shown)
            return shown
          }
          const failure = outcome.failure
          log(`Report ${row.id} was not sent: ${failure.message}`)
          return yield* change(fresh, (v) => {
            const { attemptedAt: _, ...rest } = v
            return { ...(failure.maybeFiled ? v : rest), status: "failed", lastError: failure.message.slice(0, MAX_LAST_ERROR) }
          })
        }).pipe(Effect.ensuring(Effect.sync(() => void sending.delete(row.id))))
      }))

    const draft = (input: ReportInput): Effect.Effect<ReportDrafted> =>
      Effect.gen(function*() {
        if (!available()) return yield* Effect.die(new Error("Reports cannot be kept here (the household store is not writable, or the reports could not be read)"))
        // The turn is the host's reading of the call's context (the gateway admitted it), not the module's word.
        const turn = yield* CurrentTurn
        if (turn === undefined) return yield* Effect.die(new Error("A report is drafted in a turn"))
        yield* flushPending
        const id = `r${randomBytes(8).toString("hex")}`
        const createdAt = yield* Clock.currentTimeMillis
        const facts = yield* gatherFacts(
          { ...input, description: input.description.slice(0, MAX_DESCRIPTION_CHARS) },
          turn,
          id,
          createdAt,
          options.sources
        )
        const scrub = scrubber().scrub
        const { body } = renderReport(facts, { scrub })
        const title = storedLine(scrub(input.title), MAX_REPORT_TITLE_CHARS) ?? (input.kind === "problem" ? "A problem with the assistant" : "A feature idea")
        const deviceName = facts.deviceName !== undefined ? storedLine(scrub(facts.deviceName), 200) : undefined
        const assistantName = facts.assistantName !== undefined ? storedLine(scrub(facts.assistantName), 200) : undefined
        // Past the bound, the oldest sent report goes (it is on GitHub), else the oldest one.
        const all = [...index.values()].sort((a, b) => a.createdAt - b.createdAt)
        // Never one being sent (its result is still to be recorded).
        const candidates = all.filter((r) => !sending.has(r.id))
        const victim = all.length >= MAX_KEPT_REPORTS ? candidates.find((r) => r.value.status === "sent") ?? candidates[0] : undefined
        const victims = victim === undefined ? [] : [victim]
        const row = yield* core.transaction((tx) => {
          for (const v of victims) removeReport(tx, v.id, v.value.parts)
          const parts = writeParts(tx, id, 0, body)
          return tx.collection(reports).insert({
            kind: input.kind,
            title,
            status: "draft",
            ...(deviceName !== undefined ? { deviceName } : {}),
            ...(assistantName !== undefined ? { assistantName } : {}),
            parts
          }, { id })
        })
        for (const v of victims) {
          index.delete(v.id)
          pending.delete(v.id)
        }
        index.set(row.id, row)
        log(`Report ${id} kept (${input.kind}, ${body.length} characters)${victims.length > 0 ? `; report ${victims[0]!.id} removed to keep at most ${MAX_KEPT_REPORTS}` : ""}`)
        const token = config?.token
        // At once only when the tool was declared to send (its `message` class) and the owner's setting says so.
        if (input.send !== true || config?.sendImmediately !== true || token === undefined) return { id, status: "draft" as const }
        const sent = yield* fileOnce(row, token, SEND_TIMEOUT_MS)
        return sent.value.status === "sent"
          ? { id, status: "sent" as const, ...(sent.value.issueNumber !== undefined ? { issueNumber: sent.value.issueNumber } : {}) }
          : { id, status: "failed" as const }
      }).pipe(
        Effect.tapCause((cause) => Effect.sync(() => log(`A report could not be kept: ${String(cause).split("\n")[0]}`))),
        Effect.orDie
      )

    const service: ReportsService = {
      draft,
      configure: (settings) =>
        Effect.sync(() => {
          config = settings === undefined ? undefined : { sendImmediately: settings.sendImmediately, ...(settings.token !== undefined && settings.token !== "" ? { token: settings.token } : {}) }
          if (settings === undefined) options.onStopped?.()
        })
    }

    return {
      service,
      available,
      settings: () => ({ hasToken: config?.token !== undefined, sendImmediately: config?.sendImmediately === true }),
      active: () => config !== undefined,
      list: ({ cursor, limit }) =>
        Effect.andThen(flushPending, Effect.suspend(() => {
          let after: { readonly createdAt: number; readonly id: string } | undefined
          if (cursor !== undefined) {
            const m = CURSOR.exec(cursor)
            if (m === null) return fail(400, "invalid_request", "That is not a page of the list")
            after = { createdAt: Number(m[1]), id: m[2]! }
          }
          const sorted = [...index.values()].sort(newest)
          const from = after === undefined ? sorted : sorted.filter((r) => r.createdAt < after!.createdAt || (r.createdAt === after!.createdAt && r.id < after!.id))
          const page = from.slice(0, limit)
          const last = page.at(-1)
          return Effect.succeed({
            reports: page.map(summaryOf),
            ...(from.length > limit && last !== undefined ? { next: `${last.createdAt}-${last.id}` } : {})
          })
        })),
      get: (id) => Effect.flatMap(found(id), detailOf),
      update: (id, patch) =>
        Effect.gen(function*() {
          const row = yield* found(id)
          if (patch.title === undefined && patch.body === undefined && patch.issueUrl === undefined) {
            return yield* fail(400, "invalid_request", "Change the title, the body or the issue address")
          }
          if (row.value.status === "sent") return yield* fail(409, "already_sent", "This report was sent already; it is not changed any more")
          if (sending.has(id)) return yield* fail(409, "sending", "This report is being sent")
          let issue: { readonly number: number; readonly url: string } | undefined
          if (patch.issueUrl !== undefined) {
            const url = patch.issueUrl.trim()
            const number = ISSUE_URL.test(url) ? issueNumberOf(url) : undefined
            if (number === undefined) return yield* fail(400, "invalid_request", `The issue address must be https://github.com/ianwijma/personal-voice-assistance/issues/<number>`)
            issue = { number, url }
          }
          const scrub = scrubber().scrub
          const title = patch.title !== undefined ? storedLine(scrub(patch.title), MAX_REPORT_TITLE_CHARS) : undefined
          if (patch.title !== undefined && title === undefined) return yield* fail(400, "invalid_request", "The title is empty")
          const at = yield* Clock.currentTimeMillis
          const next = yield* change(row, (v) => {
            const titled = title !== undefined ? { ...v, title } : v
            return issue === undefined ? titled : sentValue(titled, issue, at)
          }, patch.body !== undefined ? fitBody(scrub(patch.body)) : undefined)
          return yield* detailOf(next)
        }),
      send: (id) =>
        Effect.gen(function*() {
          const row = yield* found(id)
          if (row.value.status === "sent") return yield* fail(409, "already_sent", "This report was sent already")
          const token = config?.token
          if (token === undefined) return yield* fail(400, "no_token", "No GitHub token is set: set one on the report module's page, or file the issue by hand")
          const next = yield* fileOnce(row, token, ADMIN_SEND_TIMEOUT_MS)
          return yield* detailOf(next)
        }),
      remove: (id) =>
        Effect.gen(function*() {
          const row = yield* found(id)
          if (sending.has(id)) return yield* fail(409, "sending", "This report is being sent")
          yield* core.transaction((tx) => removeReport(tx, row.id, row.value.parts)).pipe(Effect.mapError(storeFailure("The report could not be removed")))
          index.delete(id)
          pending.delete(id)
        })
    }
  })
