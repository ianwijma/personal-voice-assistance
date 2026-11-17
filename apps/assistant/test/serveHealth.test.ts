// Diagnostics › Health in serve mode (docs/MODULES-PLAN.md §4 P1): a module whose required program is missing is
// `unavailable` from the start, the admin snapshot carries the issue registry, and "Check again" (`health.check`)
// answers once the check has run and sends the registry to admin pages as `health`.
import { defineModule } from "@pva/core"
import type { ClientMessage } from "@pva/protocol"
import { Effect } from "effect"
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
    expect(module.unavailable?.reason).toBe(`${MISSING} is missing`)
    expect(snapshot.health).toBeDefined()

    const from = admin.messages.length
    admin.send({ type: "health.check", requestId: "h1" } as ClientMessage)
    const result = await admin.waitFor("result", (m) => m.requestId === "h1", { from, timeoutMs: 20_000 })
    expect(result.ok).toBe(true)
    const health = admin.messages.slice(from).flatMap((m) => (m.type === "health" ? [m.health] : [])).at(-1)!
    expect(health.checking).toBe(false)
    expect(health.checkedAt).toBeGreaterThan(0)
    const issue = health.issues.find((i) => i.id === `needs-program.requires.${MISSING}`)
    expect(issue).toMatchObject({ module: "needs-program", title: `${MISSING} is missing`, detail: "Needs a program needs it: It does the work." })
    // A voice page is never sent the registry.
    const voice = await ScriptedClient.connect({ url: server.url })
    clients.push(voice)
    const welcome = await voice.hello()
    expect("health" in welcome.snapshot).toBe(false)
  })
})
