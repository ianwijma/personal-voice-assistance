// The scheduler in serve mode (docs/SCHEDULING.md): a version 2 module's handler registered in its shared part runs; a
// failed job is on the Health page with its text passed through the page boundary (in full, before it is shortened:
// a secret across the point where it is cut is still replaced); a job for a person who left Members is refused; the
// admin API lists the jobs a page at a time (more than one page) and cancels one; doctor reads the failed jobs from the
// database while the server is down; jobs and their state survive a restart.
import { defineModule, MAX_ADMIN_JOB_PAGE, MAX_ERROR_CHARS, MAX_JOB_PAGE, type ModuleScheduler, Setting } from "@pva/core"
import { type ClientMessage, MAX_SCHEDULED_JOBS_PAGE, type ScheduledJob, type ScheduledJobsResponse } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { schedulerDoctorIssues } from "../src/serve/scheduler.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let scheduler: ModuleScheduler | undefined
const rang: Array<string> = []
/** The module's secret (from the environment): a handler's error quotes it after 150 characters, across the cut at 200. */
const SECRET = `s3cr3t-${"q".repeat(121)}`
const kitchenTimers = defineModule({
  apiVersion: 2,
  id: "kitchen-timers",
  name: "Kitchen timers",
  description: "Timers",
  enabledByDefault: true,
  settings: { token: Setting.secret({ label: "Token", env: "KITCHEN_TIMERS_TOKEN" }) },
  shared: (ctx) =>
    Effect.gen(function*() {
      scheduler = ctx.scheduler
      yield* ctx.scheduler.handle("ring", { payload: Schema.Struct({ label: Schema.String }), run: (p) => Effect.sync(() => void rang.push(p.label)) }).pipe(Effect.orDie)
      yield* ctx.scheduler.handle("boom", { payload: Schema.Unknown, run: () => Effect.fail(new Error("the oven\nis offline")) }).pipe(Effect.orDie)
      yield* ctx.scheduler.handle("leak", { payload: Schema.Unknown, run: () => Effect.fail(new Error(`${"upstream said ".repeat(11).slice(0, 150)}${SECRET} and more`)) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})
const catalog = [greeterModule, kitchenTimers]
/** Jobs due in an hour: more than one page of the admin list, and of a module's list. */
const LATER = MAX_ADMIN_JOB_PAGE + 3

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  scheduler = undefined
  rang.length = 0
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
let requestCounter = 0
type Request = Extract<ClientMessage, { requestId: string }>
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never
const request = async (client: ScriptedClient, message: WithoutId<Request>) => {
  const requestId = `r${++requestCounter}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from, timeoutMs: 10_000 })
}
const until = async (check: () => boolean | Promise<boolean>, ms = 5_000) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out")
    await sleep(20)
  }
}

describe("the scheduler in serve mode", () => {
  it("runs a module's handler jobs, lists them page by page and cancels them in the admin API, and doctor reports the failed ones", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-scheduler-"))
    const env = { KITCHEN_TIMERS_TOKEN: SECRET }
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog, env })
    await until(() => scheduler !== undefined)
    const s = scheduler!
    const handled = await run(s.schedule({ handler: "ring", payload: { label: "pasta" }, inMs: 0 }))
    const later = await run(s.schedule({ handler: "ring", payload: { label: "morning" }, key: "alarm:morning", cron: "0 7 * * *", timeZone: "Europe/Amsterdam" }))
    const broken = await run(s.schedule({ handler: "boom", inMs: 0 }))
    const leaked = await run(s.schedule({ handler: "leak", inMs: 0 }))
    // More than a page: the admin list must reach every one.
    for (let i = 0; i < LATER; i++) await run(s.schedule({ handler: "ring", payload: { label: `t${i}` }, inMs: 3_600_000 + i }))
    await until(() => rang.includes("pasta"))
    await until(async () => (await run(s.get(broken.id)))?.state === "failed")
    await until(async () => (await run(s.get(leaked.id)))?.state === "failed")
    expect((await run(s.get(handled.id)))?.state).toBe("done")
    // The secret was replaced before the text was cut and stored: nothing of it is kept, the placeholder is.
    const stored = (await run(s.get(leaked.id)))!.lastError!
    expect(stored).toContain("[secret]")
    expect(stored).not.toContain(SECRET.slice(0, 12))
    expect(JSON.stringify(stored).length - 2).toBeLessThanOrEqual(MAX_ERROR_CHARS)

    const admin = await ScriptedClient.connect({ url: server.url, deviceId: "admin-0001" })
    clients.push(admin)
    const { snapshot, token } = await admin.admin(TEST_ADMIN_PASSWORD)
    // The failed job is on the Health page; its reason is one line.
    const issue = snapshot.health?.issues.find((i) => i.id === `core.scheduler.failed.${broken.id}`)
    expect(issue?.module).toBe("kitchen-timers")
    expect(issue?.detail).toMatch(/^the oven is offline/)
    const leakIssue = snapshot.health?.issues.find((i) => i.id === `core.scheduler.failed.${leaked.id}`)
    expect(leakIssue?.detail).toContain("[secret]")
    expect(leakIssue?.detail).not.toContain(SECRET.slice(0, 12))

    // A job for a person alone (no device): run while the person is in Members, refused once they are not.
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam" }] }, secrets: {} } })).ok).toBe(true)
    const samId = (server.handle.store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<{ readonly id: string }>)[0]!.id
    const forSam = { handler: "ring", payload: { label: "for sam" }, origin: { person: { id: samId, how: "chosen" as const } } }
    const whileIn = await run(s.schedule({ ...forSam, inMs: 0 }))
    await until(async () => (await run(s.get(whileIn.id)))?.state === "done")
    const afterOut = await run(s.schedule({ ...forSam, inMs: 3_600_000 }))
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [] }, secrets: {} } })).ok).toBe(true)
    await run(s.reschedule(afterOut.id, { inMs: 0 }))
    await until(async () => (await run(s.get(afterOut.id)))?.state === "failed")
    expect((await run(s.get(afterOut.id)))?.lastError).toBe("Not run: the person is not in Members.")
    expect(rang.filter((l) => l === "for sam")).toHaveLength(1)
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${server!.url}/api/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    expect((await fetch(`${server.url}/api/scheduler/jobs`)).status).toBe(401)
    const listed: Array<ScheduledJob> = []
    let cursor: string | undefined
    for (;;) {
      const page = await (await api(`scheduler/jobs?limit=10${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as ScheduledJobsResponse
      expect(page.available).toBe(true)
      expect(page.jobs.length).toBeLessThanOrEqual(10)
      listed.push(...page.jobs)
      if (page.next === undefined) break
      cursor = page.next
    }
    // P9: the notification service's own system job (its retention pass) is listed too, under its core owner.
    expect(listed.filter((j) => j.module === "core.notify").map((j) => [j.handler, j.state, j.cron])).toEqual([["retention", "scheduled", "*/10 * * * *"]])
    const all = listed.filter((j) => j.module !== "core.notify")
    expect(all).toHaveLength(LATER + 6)
    // Live first, by due time, then the finished ones; no payload on the wire.
    const states = all.map((j) => j.state)
    expect(states.slice(0, LATER + 1).every((x) => x === "scheduled")).toBe(true)
    expect(states.slice(LATER + 1).sort()).toEqual(["done", "done", "failed", "failed", "failed"])
    const live = all.slice(0, LATER + 1).map((j) => j.dueAt)
    expect(live).toEqual([...live].sort((a, b) => a - b))
    expect(all.find((j) => j.id === later.id)).toMatchObject({ id: later.id, module: "kitchen-timers", moduleName: "Kitchen timers", handler: "ring", key: "alarm:morning", state: "scheduled", cron: "0 7 * * *", timeZone: "Europe/Amsterdam", orphaned: false })
    expect(all.some((j) => "payload" in j)).toBe(false)
    expect(all.find((j) => j.id === broken.id)).toMatchObject({ state: "failed", handler: "boom", lastError: "the oven is offline" })
    expect((await api("scheduler/jobs?cursor=nonsense")).status).toBe(400)
    expect((await api("scheduler/jobs?cursor=live.zzz")).status).toBe(400)
    expect((await api("scheduler/jobs?limit=500")).status).toBe(400)
    // The protocol's page is the engine's: two reads of a list of jobs.
    expect(MAX_SCHEDULED_JOBS_PAGE).toBe(MAX_ADMIN_JOB_PAGE)
    expect(((await (await api("scheduler/jobs")).json()) as ScheduledJobsResponse).jobs).toHaveLength(MAX_SCHEDULED_JOBS_PAGE)
    expect((await api(`scheduler/jobs?limit=${MAX_SCHEDULED_JOBS_PAGE + 1}`)).status).toBe(400)
    expect((await api(`scheduler/jobs/${later.id}/cancel`, { method: "POST" })).status).toBe(200)
    expect((await api(`scheduler/jobs/${handled.id}/cancel`, { method: "POST" })).status).toBe(404)
    expect((await api("scheduler/jobs/job_nothing/cancel", { method: "POST" })).status).toBe(404)
    expect((await api("scheduler/jobs/x/cancel")).status).toBe(405)
    expect((await run(s.get(later.id)))?.state).toBe("cancelled")

    await server.close()
    server = undefined
    const issues = await run(schedulerDoctorIssues(dataDir, catalog))
    expect(issues.map((i) => i.id).sort()).toEqual([broken.id, leaked.id, afterOut.id].map((id) => `core.scheduler.failed.${id}`).sort())
    expect(issues.find((i) => i.id.endsWith(leaked.id))?.detail).not.toContain(SECRET.slice(0, 12))
    // No database: nothing to say.
    expect(await run(schedulerDoctorIssues(mkdtempSync(join(tmpdir(), "pva-empty-")), catalog))).toEqual([])

    // A restart: the live jobs are still there, the finished ones too.
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog, env })
    await until(() => scheduler !== undefined)
    expect((await run(scheduler!.list({ limit: MAX_JOB_PAGE }))).length).toBe(MAX_JOB_PAGE)
    expect((await run(scheduler!.get(broken.id)))?.state).toBe("failed")
  })
})
