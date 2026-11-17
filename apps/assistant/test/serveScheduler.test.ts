// The scheduler in serve mode (docs/SCHEDULING.md): a version 2 module's handler registered in its shared part fires;
// a `{ notify }` job is delivered by the default (log) delivery and recorded; the admin API lists jobs and cancels one;
// doctor reads the counts and the failed jobs from the database while the server is down.
import { defineModule, type ModuleScheduler } from "@pva/core"
import type { ScheduledJobsResponse } from "@pva/protocol"
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
      yield* ctx.scheduler.handle("ring", Schema.Struct({ label: Schema.String }), (p) => Effect.sync(() => rang.push(p.label)))
      yield* ctx.scheduler.handle("boom", Schema.Unknown, () => Effect.fail(new Error("the oven is offline")))
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
  it("fires handler and notify jobs, lists and cancels them in the admin API, and doctor reports them", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-scheduler-"))
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog })
    await until(() => scheduler !== undefined)
    const s = scheduler!
    const handled = await run(s.schedule({ kind: "timer", label: "Pasta", when: { inMs: 0 }, onDue: { handler: "ring", payload: { label: "pasta" } } }))
    const note = await run(s.schedule({ kind: "reminder", when: { inMs: 0 }, onDue: { notify: { kind: "reminder", priority: "normal", content: { title: "Bins" } } } }))
    const later = await run(s.schedule({ kind: "alarm", key: "alarm:morning", label: "Morning", when: { inMs: 3_600_000 }, onDue: { notify: { kind: "alarm", priority: "high", content: { title: "Wake up" } } } }))
    const broken = await run(s.schedule({ kind: "deferred", label: "Oven off", when: { inMs: 0 }, onDue: { handler: "boom", payload: null } }))
    await until(() => rang.includes("pasta"))
    await until(async () => (await run(s.get(broken.id)))?.state === "failed")
    await until(async () => (await run(s.get(note.id)))?.state === "done")
    expect((await run(s.get(handled.id)))?.state).toBe("done")
    expect((await run(s.get(note.id)))?.delivered?.notificationId).toBe(`${note.id}@${note.dueAt}`)

    const admin = await ScriptedClient.connect({ url: server.url, deviceId: "admin-0001" })
    clients.push(admin)
    const { snapshot, token } = await admin.admin(TEST_ADMIN_PASSWORD)
    // The failed job is on the Health page.
    expect(snapshot.health?.issues.some((i) => i.id === `core.scheduler.failed.${broken.id}` && i.module === "kitchen-timers")).toBe(true)
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${server!.url}/api/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } })
    expect((await fetch(`${server.url}/api/scheduler/jobs`)).status).toBe(401)
    const listed = await (await api("scheduler/jobs")).json() as ScheduledJobsResponse
    expect(listed.available).toBe(true)
    // Live first.
    expect(listed.jobs[0]).toMatchObject({ id: later.id, module: "kitchen-timers", moduleName: "Kitchen timers", kind: "alarm", key: "alarm:morning", label: "Morning", state: "scheduled", action: "notify", orphaned: false })
    expect(listed.jobs.find((j) => j.id === broken.id)).toMatchObject({ state: "failed", action: "handler", handler: "boom", lastError: "the oven is offline" })
    expect((await api(`scheduler/jobs/${later.id}/cancel`, { method: "POST" })).status).toBe(200)
    expect((await api("scheduler/jobs/job_nothing/cancel", { method: "POST" })).status).toBe(404)
    expect((await api("scheduler/jobs/x/cancel")).status).toBe(405)
    expect((await run(s.get(later.id)))?.state).toBe("cancelled")

    await server.close()
    server = undefined
    const issues = await run(schedulerDoctorIssues(dataDir, catalog))
    expect(issues[0]).toMatchObject({ id: "core.scheduler.count", severity: "info", title: "Scheduled jobs: 0 scheduled, 1 failed" })
    expect(issues.some((i) => i.id === `core.scheduler.failed.${broken.id}`)).toBe(true)
    // No database: nothing to say.
    expect(await run(schedulerDoctorIssues(mkdtempSync(join(tmpdir(), "pva-empty-")), catalog))).toEqual([])
  })
})
