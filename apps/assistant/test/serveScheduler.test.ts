// The scheduler in serve mode (docs/SCHEDULING.md): a version 2 module's handler registered in its shared part runs; a
// failed job is on the Health page with its text passed through the page boundary; the admin API lists the jobs a page
// at a time (more than one page) and cancels one; doctor reads the failed jobs from the database while the server is
// down; jobs and their state survive a restart.
import { defineModule, MAX_JOB_PAGE, type ModuleScheduler } from "@pva/core"
import type { ScheduledJob, ScheduledJobsResponse } from "@pva/protocol"
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
const kitchenTimers = defineModule({
  apiVersion: 2,
  id: "kitchen-timers",
  name: "Kitchen timers",
  description: "Timers",
  enabledByDefault: true,
  shared: (ctx) =>
    Effect.gen(function*() {
      scheduler = ctx.scheduler
      yield* ctx.scheduler.handle("ring", { payload: Schema.Struct({ label: Schema.String }), run: (p) => Effect.sync(() => void rang.push(p.label)) }).pipe(Effect.orDie)
      yield* ctx.scheduler.handle("boom", { payload: Schema.Unknown, run: () => Effect.fail(new Error("the oven\nis offline")) }).pipe(Effect.orDie)
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})
const catalog = [greeterModule, kitchenTimers]

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
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog })
    await until(() => scheduler !== undefined)
    const s = scheduler!
    const handled = await run(s.schedule({ handler: "ring", payload: { label: "pasta" }, inMs: 0 }))
    const later = await run(s.schedule({ handler: "ring", payload: { label: "morning" }, key: "alarm:morning", cron: "0 7 * * *", timeZone: "Europe/Amsterdam" }))
    const broken = await run(s.schedule({ handler: "boom", inMs: 0 }))
    // More than a page: the admin list must reach every one.
    for (let i = 0; i < MAX_JOB_PAGE + 3; i++) await run(s.schedule({ handler: "ring", payload: { label: `t${i}` }, inMs: 3_600_000 + i }))
    await until(() => rang.includes("pasta"))
    await until(async () => (await run(s.get(broken.id)))?.state === "failed")
    expect((await run(s.get(handled.id)))?.state).toBe("done")

    const admin = await ScriptedClient.connect({ url: server.url, deviceId: "admin-0001" })
    clients.push(admin)
    const { snapshot, token } = await admin.admin(TEST_ADMIN_PASSWORD)
    // The failed job is on the Health page; its reason is one line.
    const issue = snapshot.health?.issues.find((i) => i.id === `core.scheduler.failed.${broken.id}`)
    expect(issue?.module).toBe("kitchen-timers")
    expect(issue?.detail).toMatch(/^the oven is offline/)
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${server!.url}/api/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    expect((await fetch(`${server.url}/api/scheduler/jobs`)).status).toBe(401)
    const all: Array<ScheduledJob> = []
    let cursor: string | undefined
    for (;;) {
      const page = await (await api(`scheduler/jobs?limit=10${cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).json() as ScheduledJobsResponse
      expect(page.available).toBe(true)
      expect(page.jobs.length).toBeLessThanOrEqual(10)
      all.push(...page.jobs)
      if (page.next === undefined) break
      cursor = page.next
    }
    expect(all).toHaveLength(MAX_JOB_PAGE + 6)
    // Live first, by due time, then the finished ones; no payload on the wire.
    const states = all.map((j) => j.state)
    expect(states.slice(0, MAX_JOB_PAGE + 4).every((x) => x === "scheduled")).toBe(true)
    expect(states.slice(MAX_JOB_PAGE + 4).sort()).toEqual(["done", "failed"])
    const live = all.slice(0, MAX_JOB_PAGE + 4).map((j) => j.dueAt)
    expect(live).toEqual([...live].sort((a, b) => a - b))
    expect(all.find((j) => j.id === later.id)).toMatchObject({ id: later.id, module: "kitchen-timers", moduleName: "Kitchen timers", handler: "ring", key: "alarm:morning", state: "scheduled", cron: "0 7 * * *", timeZone: "Europe/Amsterdam", orphaned: false })
    expect(all.some((j) => "payload" in j)).toBe(false)
    expect(all.find((j) => j.id === broken.id)).toMatchObject({ state: "failed", handler: "boom", lastError: "the oven is offline" })
    expect((await api("scheduler/jobs?cursor=nonsense")).status).toBe(400)
    expect((await api("scheduler/jobs?cursor=live.zzz")).status).toBe(400)
    expect((await api("scheduler/jobs?limit=500")).status).toBe(400)
    expect((await api(`scheduler/jobs/${later.id}/cancel`, { method: "POST" })).status).toBe(200)
    expect((await api(`scheduler/jobs/${handled.id}/cancel`, { method: "POST" })).status).toBe(404)
    expect((await api("scheduler/jobs/job_nothing/cancel", { method: "POST" })).status).toBe(404)
    expect((await api("scheduler/jobs/x/cancel")).status).toBe(405)
    expect((await run(s.get(later.id)))?.state).toBe("cancelled")

    await server.close()
    server = undefined
    const issues = await run(schedulerDoctorIssues(dataDir, catalog))
    expect(issues.map((i) => i.id)).toEqual([`core.scheduler.failed.${broken.id}`])
    // No database: nothing to say.
    expect(await run(schedulerDoctorIssues(mkdtempSync(join(tmpdir(), "pva-empty-")), catalog))).toEqual([])

    // A restart: the live jobs are still there, the finished ones too.
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog })
    await until(() => scheduler !== undefined)
    expect((await run(scheduler!.list({ limit: MAX_JOB_PAGE }))).length).toBe(MAX_JOB_PAGE)
    expect((await run(scheduler!.get(broken.id)))?.state).toBe("failed")
  })
})
