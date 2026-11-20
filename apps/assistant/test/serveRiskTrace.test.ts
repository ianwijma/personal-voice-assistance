import { defineModule, Llm, makeTool } from "@pva/core"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })
const desk = defineModule({ id: "desk", name: "Desk", description: "", start: () => Effect.succeed({ tools: [makeTool({ name: "look", description: "", risk: "read", parameters: Schema.Struct({}), execute: () => Effect.succeed("ok") })] }) })

describe("risk policy and cached turn trace configuration", () => {
  for (const subscription of [false, true]) {
    it(`a new trace follows live offers and keeps old snapshots (${subscription ? "subscription tools disabled" : "model tools enabled"})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pva-risk-trace-"))
      const build = fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Done.").llm })
      const first = await startTestServer({ dataDir: dir, build })
      await first.close()
      const path = join(dir, "settings.json")
      const file = JSON.parse(readFileSync(path, "utf8"))
      const base = file.assistants.byId[file.assistants.order[0]]
      file.assistants = { order: ["alpha"], byId: { alpha: { ...base, id: "alpha", name: "Alpha", rev: 0, llm: { ...base.llm, account: subscription ? "claude-subscription" : "anthropic", model: "model-a", useModules: !subscription }, modules: { desk: { on: true, offTools: [] } } } } }
      file.deviceTypes["web-voice"] = { ...file.deviceTypes["web-voice"], assistants: [{ assistant: "alpha", phrases: [] }], withoutPhrase: { mode: "assistant", assistant: "alpha" } }
      writeFileSync(path, JSON.stringify(file))
      const offered: Array<Array<string>> = []
      const server = await startTestServer({ dataDir: dir, build, catalog: [desk], buildLlm: () => Effect.succeed(Llm.of({ stream: (r) => {
        offered.push(r.tools.map((t) => t.name))
        return Stream.fromIterable([{ _tag: "TextDelta", text: "Hello." }, { _tag: "Done", stopReason: "end" }])
      } })) })
      const admin = await ScriptedClient.connect({ url: server.url })
      const page = await ScriptedClient.connect({ url: server.url, deviceId: "risk-trace-01" })
      try {
        await admin.admin(TEST_ADMIN_PASSWORD)
        await page.hello()
        const session = () => server.handle.sessions.all()[0]
        let turn = 0
        const talk = async () => {
          const requestId = `t${++turn}`
          const from = admin.messages.length
          page.send({ type: "text.send", requestId, text: `hello ${requestId}`, speak: false, assistantId: "alpha" })
          return (await admin.waitFor("trace", () => true, { from, timeoutMs: 10_000 })).trace
        }
        const firstTrace = await talk()
        const originalSession = session()
        const originalConfig = server.handle.sessions.traces()[0]!.config
        const registry = server.handle.host.snapshot().registry
        expect(registry.specs.map((t) => t.name)).toEqual(["look"])
        const counts = [firstTrace.config?.tools]
        for (const read of ["deny", "allow"]) {
          admin.send({ type: "settings.update", requestId: read, sectionId: "risk", patch: { values: { RISK_READ: read }, secrets: {} } })
          expect((await admin.waitFor("result", (m) => m.requestId === read, { from: 0 })).ok).toBe(true)
          counts.push((await talk()).config?.tools)
          expect(session()).toBe(originalSession)
          expect(server.handle.host.snapshot().registry).toBe(registry)
        }
        expect(counts).toEqual(subscription ? [0, 0, 0] : [1, 0, 1])
        if (!subscription) expect(offered).toEqual([["look"], [], ["look"]])
        expect(originalConfig?.tools).toBe(subscription ? 0 : 1)
        expect(server.handle.sessions.traces().map((t) => t.config?.tools)).toEqual(counts)
      } finally {
        page.close()
        admin.close()
        await server.close()
      }
    })
  }
})
