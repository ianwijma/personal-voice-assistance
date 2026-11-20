// Reports in serve mode (docs/REPORTS.md): the core's `Reports` a module drafts with, and the admin API of protocol
// `reports.ts` on a real server: admin only (401 without the token), the list newest first, one report with its body,
// a PUT larger than the admin API's usual limit (and the larger limit enforced), an issue filed by hand, Send without a
// token, removal, answers that decode with the protocol's schemas, and the reports still there after a restart.
import { CurrentTurn, defineModule, Reports, type ReportsService } from "@pva/core"
import { makeTestTurn } from "@pva/core/testing"
import { MAX_API_BODY_BYTES, MAX_REPORT_REQUEST_BYTES, REPORT_REPOSITORY, ReportDetail, ReportsResponse } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

/**
 * A module with the report module's id that only takes the core's `Reports` from its shared part (the service is given
 * to the module `report` alone), and another module that tries to.
 */
let reportsService: ReportsService | undefined
let othersService: ReportsService | undefined | "unset" = "unset"
const asReport = defineModule({
  apiVersion: 2,
  id: "report",
  name: "Reports (test)",
  description: "Takes the Reports service",
  enabledByDefault: true,
  shared: (ctx) =>
    Effect.sync(() => {
      reportsService = ctx.host.service(Reports)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})
const other = defineModule({
  apiVersion: 2,
  id: "not-report",
  name: "Another",
  description: "Tries to take the Reports service",
  enabledByDefault: true,
  shared: (ctx) =>
    Effect.sync(() => {
      othersService = ctx.host.service(Reports)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})
const catalog = [greeterModule, asReport, other]

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  reportsService = undefined
  othersService = "unset"
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const until = async (check: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(20)
  }
}
const decodeList = Schema.decodeUnknownSync(ReportsResponse)
const decodeDetail = Schema.decodeUnknownSync(ReportDetail)

describe("reports in serve mode", () => {
  it("keeps what a module drafts and serves the admin API of the protocol; the reports survive a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-reports-"))
    const start = () => startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog })
    server = await start()
    await until(() => reportsService !== undefined && othersService !== "unset")
    // Any other module gets no `Reports`: it can neither configure it nor draft.
    expect(othersService).toBeUndefined()
    const turn = makeTestTurn({ device: "kitchen-display", conversationId: "c-1" })
    const inTurn = <A>(e: Effect.Effect<A>, t = turn) => run(e.pipe(Effect.provideService(CurrentTurn, t)))
    // Outside a turn: refused.
    expect((await Effect.runPromiseExit(reportsService!.draft({ kind: "problem", title: "No turn", description: "x", send: false })))._tag).toBe("Failure")
    const first = await inTurn(reportsService!.draft({ kind: "problem", title: "The timer did not ring", description: "It never rang.", send: false }))
    expect(first.status).toBe("draft")
    await sleep(5)
    const second = await inTurn(reportsService!.draft({ kind: "feature", title: "Read recipes aloud", description: "Step by step.", send: false }), { ...turn, turnId: 2 })

    const admin = await ScriptedClient.connect({ url: server.url, deviceId: "admin-0001" })
    clients.push(admin)
    const { token } = await admin.admin(TEST_ADMIN_PASSWORD)
    const api = (path: string, init: RequestInit = {}) => fetch(`${server!.url}/api/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    const put = (id: string, body: unknown) => api(`reports/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })

    // Admin only.
    expect((await fetch(`${server.url}/api/reports`)).status).toBe(401)
    expect((await fetch(`${server.url}/api/reports/${first.id}`)).status).toBe(401)

    const list = decodeList(await (await api("reports")).json())
    expect(list).toMatchObject({ available: true, repository: REPORT_REPOSITORY, hasToken: false, sendImmediately: false })
    expect(list.reports.map((r) => [r.id, r.kind, r.status])).toEqual([[second.id, "feature", "draft"], [first.id, "problem", "draft"]])
    const paged = decodeList(await (await api("reports?limit=1")).json())
    expect(paged.reports.map((r) => r.id)).toEqual([second.id])
    expect(decodeList(await (await api(`reports?limit=1&cursor=${paged.next!}`)).json()).reports.map((r) => r.id)).toEqual([first.id])
    expect((await api("reports?limit=500")).status).toBe(400)
    expect((await api("reports?cursor=nope")).status).toBe(400)

    const detail = decodeDetail(await (await api(`reports/${first.id}`)).json())
    expect(detail.body.split("\n")[0]).toBe(`<!-- pva-report v1 kind=problem id=${first.id} -->`)
    // The test server knows no such device: the report says so.
    expect(detail.body).toContain("Not available: the device has no voice session now")
    expect(detail.bodyFits).toBe(true)
    expect(detail.newIssueUrl).toMatch(/^https:\/\/github\.com\/ianwijma\/personal-voice-assistance\/issues\/new\?title=/)

    // A body far over the admin API's usual limit is taken by this route; one over the route's own limit is not.
    const big = "A long line of the edited report.\n".repeat(1_500)
    expect(big.length).toBeGreaterThan(MAX_API_BODY_BYTES * 10)
    const edited = await put(first.id, { title: "The timer stayed silent", body: big })
    expect(edited.status).toBe(200)
    const after = decodeDetail(await edited.json())
    expect([after.title, after.body]).toEqual(["The timer stayed silent", big])
    expect((await put(first.id, JSON.stringify({ body: "x".repeat(MAX_REPORT_REQUEST_BYTES) }))).status).toBe(413)
    // Every other route keeps the admin API's usual limit.
    const otherRoute = await api("voices/favourites/sherpa%3Aen_US-lessac-medium", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x".repeat(MAX_API_BODY_BYTES) }) })
    expect(otherRoute.status).toBe(413)
    // The owner's edit is scrubbed before it is kept.
    const scrubbed = decodeDetail(await (await put(second.id, { body: "the key ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked" })).json())
    expect(scrubbed.body).toBe("the key [secret] leaked")
    expect((await put(first.id, {})).status).toBe(400)
    expect((await put(first.id, { issueUrl: "https://github.com/ianwijma/personal-voice-assistance/pull/3" })).status).toBe(400)
    expect((await put(first.id, { title: "" })).status).toBe(400)

    // Send without a token: refused, nothing sent.
    const noToken = await api(`reports/${first.id}/send`, { method: "POST" })
    expect(noToken.status).toBe(400)
    expect(((await noToken.json()) as { error: { code: string } }).error.code).toBe("no_token")
    expect((await api(`reports/${first.id}/send`)).status).toBe(405)

    // Filed by hand: it counts as sent, and is not sent or changed again.
    const filed = await put(first.id, { issueUrl: "https://github.com/ianwijma/personal-voice-assistance/issues/77" })
    expect(filed.status).toBe(200)
    expect(decodeDetail(await filed.json())).toMatchObject({ status: "sent", issue: { number: 77, url: "https://github.com/ianwijma/personal-voice-assistance/issues/77" } })
    expect((await api(`reports/${first.id}/send`, { method: "POST" })).status).toBe(409)
    expect((await put(first.id, { title: "Again" })).status).toBe(409)

    // Removed: gone.
    expect((await api(`reports/${second.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await api(`reports/${second.id}`)).status).toBe(404)
    expect((await api("reports/r0000000000000000")).status).toBe(404)
    expect((await api(`reports/${first.id}`, { method: "POST" })).status).toBe(405)

    // A restart: the report is still there, as it was.
    await server.close()
    server = undefined
    reportsService = undefined
    server = await start()
    await until(() => reportsService !== undefined)
    const admin2 = await ScriptedClient.connect({ url: server.url, deviceId: "admin-0002" })
    clients.push(admin2)
    const { token: token2 } = await admin2.admin(TEST_ADMIN_PASSWORD)
    const again = decodeList(await (await fetch(`${server.url}/api/reports`, { headers: { Authorization: `Bearer ${token2}` } })).json())
    expect(again.reports.map((r) => [r.id, r.status, r.title, r.issue?.number])).toEqual([[first.id, "sent", "The timer stayed silent", 77]])
    const kept = decodeDetail(await (await fetch(`${server.url}/api/reports/${first.id}`, { headers: { Authorization: `Bearer ${token2}` } })).json())
    expect(kept.body).toBe(big)
  })
})
