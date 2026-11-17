// Diagnostics › Health in serve mode (docs/MODULES-PLAN.md §4 P1): a module whose required program is missing is
// `unavailable` from the start, the admin snapshot carries the issue registry, and "Check again" (`health.check`)
// answers once the check has run and sends the registry to admin pages as `health`.
import { defineModule } from "@pva/core"
import type { ClientMessage } from "@pva/protocol"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

/** A program no machine has: its probe finds nothing on the fixed path. */
const MISSING = "pva-test-no-such-program"

const needsProgram = defineModule({
  id: "needs-program",
  name: "Needs a program",
  description: "Cannot run without a program",
  requires: [{ tool: MISSING, why: "It does the work" }],
  start: () => Effect.succeed({ instructions: "It works." })
})

describe("health in serve mode", () => {
  it("the unavailable module, the registry in the admin snapshot, and Check again", async () => {
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, needsProgram] })
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    const { snapshot } = await admin.admin(TEST_ADMIN_PASSWORD)
    const module = snapshot.modules.find((m) => m.id === "needs-program")!
    expect(module.state).toBe("unavailable")
    // The program registry is empty in this version: a program it does not know is missing.
    expect(module.unavailable?.reason).toBe(`${MISSING} is not a program this assistant knows how to check`)
    expect(snapshot.health).toBeDefined()

    const from = admin.messages.length
    admin.send({ type: "health.check", requestId: "h1" } as ClientMessage)
    const result = await admin.waitFor("result", (m) => m.requestId === "h1", { from, timeoutMs: 20_000 })
    expect(result.ok).toBe(true)
    const done = await admin.waitFor("health", (m) => !m.health.checking && m.health.checkedAt !== undefined, { from, timeoutMs: 20_000 })
    const health = done.health
    expect(health.checking).toBe(false)
    expect(health.checkedAt).toBeGreaterThan(0)
    const issue = health.issues.find((i) => i.id === `needs-program.requires.${MISSING}`)
    expect(issue).toMatchObject({ module: "needs-program", title: `${MISSING} is not a program this assistant knows how to check`, detail: expect.stringMatching(/^Needs a program needs it: It does the work\./) })
    // A voice page is never sent the registry.
    const voice = await ScriptedClient.connect({ url: server.url })
    clients.push(voice)
    const welcome = await voice.hello()
    expect("health" in welcome.snapshot).toBe(false)
  })

  it("Check again reports the household's backup: none yet, then one too old (backup age is read from the files, never from the database)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-health-household-"))
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule] })
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const check = async (id: string) => {
      const from = admin.messages.length
      admin.send({ type: "health.check", requestId: id } as ClientMessage)
      await admin.waitFor("result", (m) => m.requestId === id, { from, timeoutMs: 20_000 })
      // Answered once the check has started (P3): its outcome is the first `health` after it that is not checking.
      return (await admin.waitFor("health", (m) => !m.health.checking, { from, timeoutMs: 20_000 })).health
    }
    expect((await check("h1")).issues.find((i) => i.id === "core.household.backup")?.title).toBe("The household data has no backup yet")
    const backups = join(dataDir, "backups")
    mkdirSync(backups, { recursive: true })
    const old = join(backups, "household-2026-01-01.db")
    writeFileSync(old, "")
    const t = (Date.now() - 3 * 86_400_000) / 1000
    utimesSync(old, t, t)
    expect((await check("h2")).issues.find((i) => i.id === "core.household.backup")?.title).toBe("The last household backup is old")
  })

  // Review round 1, finding 19: a check can outlast the page's 10 s request timeout, so it is answered once started.
  it("Check again is answered at once, with `checking` first; the outcome follows as `health`", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const slow = defineModule({
      id: "slow-health",
      name: "Slow health",
      description: "Its health check waits",
      start: () => Effect.succeed({}),
      health: () => Effect.promise(() => (calls++ === 0 ? Promise.resolve([]) : gate.then(() => [])))
    })
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, slow] })
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    const { snapshot } = await admin.admin(TEST_ADMIN_PASSWORD)
    // The check at start has finished (it may still run when the page logs in).
    if (snapshot.health?.checking !== false || snapshot.health.checkedAt === undefined) {
      await admin.waitFor("health", (m) => !m.health.checking && m.health.checkedAt !== undefined, { from: 0, timeoutMs: 20_000 })
    }
    const from = admin.messages.length
    const asked = Date.now()
    admin.send({ type: "health.check", requestId: "h2" } as ClientMessage)
    const result = await admin.waitFor("result", (m) => m.requestId === "h2", { from, timeoutMs: 5_000 })
    expect(result.ok).toBe(true)
    expect(Date.now() - asked).toBeLessThan(2_000)
    const before = admin.messages.slice(from)
    const firstHealth = before.findIndex((m) => m.type === "health")
    expect(firstHealth).toBeGreaterThanOrEqual(0)
    expect(firstHealth).toBeLessThan(before.findIndex((m) => m.type === "result"))
    expect((before[firstHealth] as Extract<typeof before[number], { type: "health" }>).health.checking).toBe(true)
    // Still running: the module's health() waits.
    expect(admin.messages.slice(from).some((m) => m.type === "health" && !m.health.checking)).toBe(false)
    release()
    const done = await admin.waitFor("health", (m) => !m.health.checking, { from, timeoutMs: 20_000 })
    expect(done.health.checkedAt).toBeGreaterThanOrEqual(asked)
  })
})
