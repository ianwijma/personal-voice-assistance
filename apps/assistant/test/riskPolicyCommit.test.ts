// P8, review round 2, finding 1: the policy record is published at the commit itself, in the store's first commit
// listener, so a call queued at the commit (the reviewer's sequence: a reader resumed from the store's committed-state
// notification while the admin's save has not returned yet) already gets the new policy, in both directions; and a
// commit observer registered before the sections exist reads the new record too.
import { CurrentTurn, defineModule, makeExecutionGateway, makeTool, makeToolRegistry } from "@pva/core"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { servePolicyReader } from "../src/serve/riskPolicy.ts"
import { makeSections } from "../src/serve/sections.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 30_000 })

const DENIED = "Not run: it would change something in the house, which this household does not allow."

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

describe("the policy record at the commit", () => {
  it("the full server: a call queued at the commit refuses after allow -> deny and runs after deny -> allow", async () => {
    let executions = 0
    const switches = defineModule({
      apiVersion: 2,
      id: "switches",
      name: "Switches",
      description: "Lamp",
      start: () => Effect.succeed({ tools: [makeTool({ name: "lamp", description: "Lamp", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.sync(() => (++executions, "on")) })] })
    })
    server = await startTestServer({ catalog: [greeterModule, switches], build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }) })
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    const page = await ScriptedClient.connect({ url: server.url, deviceId: "risk-commit-01", player: { enabled: false } })
    clients.push(page)
    await admin.admin(TEST_ADMIN_PASSWORD)
    await page.hello()
    const registry = server.handle.host.snapshot().registry
    const assistantId = Object.keys(server.handle.store.settings().assistants.byId)[0]!
    const turn = { turnId: 1, conversationId: "c", source: "text" as const, assistantId, deviceId: page.device.id }
    const call = () => Effect.runPromise(registry.run({ id: "lamp", name: "lamp", input: {} }).pipe(Effect.provideService(CurrentTurn, turn)))
    expect((await call()).content).toBe("on")

    // The reviewer's sequence: at the store's committed-state notification, a call is queued (a microtask: it runs before
    // the admin's save is answered).
    const atCommit: Array<{ readonly committed: unknown; readonly result: Promise<{ readonly content: string }> }> = []
    const stop = server.handle.store.onCommitted((before, after) => {
      if (before.assistant.RISK_CHANGE === after.assistant.RISK_CHANGE) return
      let resolve!: (r: { readonly content: string }) => void
      const result = new Promise<{ readonly content: string }>((r) => (resolve = r))
      atCommit.push({ committed: after.assistant.RISK_CHANGE, result })
      queueMicrotask(() => void call().then(resolve))
    })
    let n = 0
    const save = async (change: string) => {
      const requestId = `save-${++n}`
      admin.send({ type: "settings.update", requestId, sectionId: "risk", patch: { values: { RISK_CHANGE: change }, secrets: {} } })
      return admin.waitFor("result", (m) => m.requestId === requestId, { from: 0 })
    }
    // allow -> deny: the queued call is refused and the tool does not run.
    expect((await save("deny")).ok).toBe(true)
    expect(atCommit[0]?.committed).toBe("deny")
    expect((await atCommit[0]!.result).content).toBe(DENIED)
    expect(executions).toBe(1)
    // deny -> allow: the queued call runs.
    expect((await save("allow")).ok).toBe(true)
    expect(atCommit[1]?.committed).toBe("allow")
    expect((await atCommit[1]!.result).content).toBe("on")
    expect(executions).toBe(2)
    stop()
  })

  it("a commit observer registered before the sections exist reads the new record synchronously, in both directions (also allow -> confirm)", async () => {
    const store = await Effect.runPromise(openStore(mkdtempSync(join(tmpdir(), "pva-risk-commit-"))))
    let read: (() => string) | undefined
    const seen: Array<{ readonly committed: unknown; readonly published: string }> = []
    store.onCommitted((_before, after) => void seen.push({ committed: after.assistant.RISK_CHANGE, published: read!() }))
    const sections = makeSections(store, {})
    read = () => sections.riskPolicy().change
    let executions = 0
    const registry = makeToolRegistry(
      [{ name: "house", tools: [makeTool({ name: "lamp", description: "", parameters: Schema.Struct({}), risk: "change", execute: () => Effect.sync(() => (++executions, "on")) })] }],
      { gateway: makeExecutionGateway({ policy: servePolicyReader(sections) }) }
    )
    const results: Array<string> = []
    store.onCommitted(() => void results.push(Effect.runSync(registry.run({ id: "x", name: "lamp", input: {} }).pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "voice" }))).content))
    for (const change of ["deny", "allow", "confirm"]) expect((await Effect.runPromise(sections.update("risk", { values: { RISK_CHANGE: change }, secrets: {} }))).result.ok).toBe(true)
    expect(seen).toEqual([{ committed: "deny", published: "deny" }, { committed: "allow", published: "allow" }, { committed: "confirm", published: "confirm" }])
    expect(results).toEqual([
      DENIED,
      "on",
      "Not run: it would change something in the house, which this household has set to need the owner's confirmation, and this assistant cannot ask for it yet."
    ])
    expect(executions).toBe(1)
  })
})
