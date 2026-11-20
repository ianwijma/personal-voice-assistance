import { MAX_REPORTS_PAGE, REPORT_REPOSITORY, ReportDetail, ReportsResponse, ReportUpdate } from "@pva/protocol"
import { Effect, Schema } from "effect"
import type { ReportsFailure, ReportsHost } from "./reports/Reports.ts"
import { ApiFailure } from "./VoiceCatalog.ts"

/**
 * The reports' admin API (protocol `reports.ts`, docs/REPORTS.md "Admin API"), behind the admin API's token check:
 * `GET reports[?cursor&limit]`, `GET|PUT|DELETE reports/<id>`, `POST reports/<id>/send`. Every answer is encoded with
 * the protocol's schema. A PUT's body may be as large as `MAX_REPORT_REQUEST_BYTES` (`readBody`, the caller's reader
 * with that limit). `undefined`: not a reports path.
 */

const ID_PATH = /^reports\/([A-Za-z0-9_-]{1,64})(\/send)?$/

const encodeList = Schema.encodeUnknownSync(ReportsResponse)
const encodeDetail = Schema.encodeUnknownSync(ReportDetail)
const decodeUpdate = Schema.decodeUnknownResult(ReportUpdate)

const failure = (e: ReportsFailure) => new ApiFailure({ status: e.status, code: e.code, message: e.message })
const methodNotAllowed = (allow: string) => Effect.fail(new ApiFailure({ status: 405, code: "method_not_allowed", message: `Use ${allow}` }))

export const reportsRoute = (
  path: string,
  method: string,
  query: URLSearchParams,
  readBody: () => Effect.Effect<unknown, ApiFailure>,
  reports: ReportsHost | undefined
): Effect.Effect<{ readonly status: number; readonly json: unknown }, ApiFailure> | undefined => {
  if (path === "reports") {
    if (method !== "GET") return methodNotAllowed("GET")
    if (reports === undefined || !reports.available()) {
      return Effect.succeed({
        status: 200,
        json: encodeList({ reports: [], available: false, repository: REPORT_REPOSITORY, hasToken: reports?.settings().hasToken ?? false, sendImmediately: reports?.settings().sendImmediately ?? false })
      })
    }
    const limitText = query.get("limit")
    const limit = limitText === null ? MAX_REPORTS_PAGE : Number(limitText)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORTS_PAGE) {
      return Effect.fail(new ApiFailure({ status: 400, code: "invalid_request", message: `limit must be 1 to ${MAX_REPORTS_PAGE}` }))
    }
    const cursor = query.get("cursor") ?? undefined
    return reports.list({ limit, ...(cursor !== undefined ? { cursor } : {}) }).pipe(
      Effect.map((page) => {
        const settings = reports.settings()
        return {
          status: 200,
          json: encodeList({ reports: page.reports, available: true, repository: REPORT_REPOSITORY, hasToken: settings.hasToken, sendImmediately: settings.sendImmediately, ...(page.next !== undefined ? { next: page.next } : {}) })
        }
      }),
      Effect.mapError(failure)
    )
  }
  const match = ID_PATH.exec(path)
  if (match === null) return undefined
  const id = match[1]!
  const unavailable = Effect.fail(new ApiFailure({ status: 503, code: "unavailable", message: "This server keeps no reports" }))
  if (match[2] !== undefined) {
    if (method !== "POST") return methodNotAllowed("POST")
    if (reports === undefined || !reports.available()) return unavailable
    return reports.send(id).pipe(Effect.map((d) => ({ status: 200, json: encodeDetail(d) })), Effect.mapError(failure))
  }
  if (method !== "GET" && method !== "PUT" && method !== "DELETE") return methodNotAllowed("GET, PUT, DELETE")
  if (reports === undefined || !reports.available()) return unavailable
  if (method === "GET") return reports.get(id).pipe(Effect.map((d) => ({ status: 200, json: encodeDetail(d) })), Effect.mapError(failure))
  if (method === "DELETE") return reports.remove(id).pipe(Effect.as({ status: 200, json: { removed: true } }), Effect.mapError(failure))
  return Effect.gen(function*() {
    const raw = yield* readBody()
    const decoded = decodeUpdate(raw ?? {})
    if (decoded._tag === "Failure") {
      return yield* new ApiFailure({ status: 400, code: "invalid_request", message: `The request is not valid: ${decoded.failure.message.split("\n").slice(0, 3).join(" ").slice(0, 300)}` })
    }
    const detail = yield* reports.update(id, decoded.success).pipe(Effect.mapError(failure))
    return { status: 200, json: encodeDetail(detail) }
  })
}
