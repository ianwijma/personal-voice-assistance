// Serve mode with the module scaffold (docs/MODULES-PLAN.md §4 P11): the gateway's default risk policy on every entry
// path, and an existing installation that chose none of the new modules running as it did before.
import { defineAction, defineModule, Llm, type LlmEvent, makeTool, type ModuleDefinition, type Principal } from "@pva/core"
import { homeAssistantModule } from "@pva/module-home-assistant"
import { clockModule, weatherModule } from "@pva/modules-builtin"
import { Effect, Schema, Stream } from "effect"
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { moduleCatalog } from "../src/modules.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
})

type Json = Record<string, any>

/** An `Llm` that records the system prompt and the tool names of every request, and answers "Ok.". */
const recordingLlm = () => {
  const requests: Array<{ system: string; tools: ReadonlyArray<string> }> = []
  const llm = Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push({ system: request.system, tools: request.tools.map((t) => t.name) })
        return Stream.fromIterable<LlmEvent>([{ _tag: "TextDelta", text: "Ok." }, { _tag: "Done", stopReason: "end" }])
      })
  })
  return { llm, requests }
}

/** A data directory whose one assistant, Alpha, has `modules` on, answering "hey alpha" on every voice page. */
const dataDirWith = async (modules: Json, catalog: ReadonlyArray<ModuleDefinition<any>>): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-scaffold-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir, catalog })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  file.assistants = { order: ["alpha"], byId: { alpha: { ...base, id: "alpha", rev: 0, name: "Alpha", prompt: "You are Alpha.", modules } } }
  file.deviceTypes["web-voice"] = { ...file.deviceTypes["web-voice"], assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }], withoutPhrase: { mode: "nobody" } }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const serve = async (dataDir: string, catalog: ReadonlyArray<ModuleDefinition<any>>) => {
  const llm = recordingLlm()
  const server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: llm.llm }), dataDir, catalog: [...catalog] })
  servers.push(server)
  const page = await ScriptedClient.connect({ url: server.url })
  clients.push(page)
  await page.hello()
  const typed = async (text: string) => {
    const from = page.messages.length
    page.send({ type: "text.send", requestId: `t-${from}`, text, speak: false, assistantId: "alpha" })
    await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
  }
  return { server, page, llm, typed }
}

const ran: Array<string> = []
const door = defineModule({
  apiVersion: 2,
  id: "door",
  name: "Door",
  description: "A door with a lock.",
  enabledByDefault: false,
  start: () =>
    Effect.succeed({
      tools: [
        makeTool({ name: "door_status", description: "Whether the door is locked.", parameters: Schema.Struct({}), speculative: true, execute: () => Effect.succeed("locked") }),
        makeTool({ name: "door_open", description: "Open the front door (security).", parameters: Schema.Struct({}), risk: "security", execute: () => Effect.sync(() => void ran.push("door_open")) })
      ],
      actions: [defineAction({ id: "unlock", label: "Unlock", description: "Unlock the door (security).", examples: ["unlock the door"], params: {}, risk: "security", run: () => Effect.sync(() => void ran.push("unlock")) })]
    })
})

describe("the risk policy in serve mode", () => {
  it("a security tool is not in the model's tool list, and is refused called directly, as a typed action and from a job", async () => {
    ran.length = 0
    const { server, page, llm, typed } = await serve(await dataDirWith({ door: { on: true, offTools: [] } }, [door]), [door])
    await typed("is the door locked")
    expect(llm.requests[0]!.tools).toEqual(["door_status"])
    const host = server.handle.host
    const part = (host.snapshot().assistantParts.get("alpha") ?? []).find((p) => p.moduleId === "door")!
    const open = part.module.tools!.find((t) => t.name === "door_open")!
    const unlockTool = part.module.tools!.find((t) => t.name === "door_unlock")!
    const turn: Principal = { _tag: "turn", turn: { turnId: 1, conversationId: "c", source: "voice", assistantId: "alpha", deviceId: page.device.id } }
    const job: Principal = { _tag: "job", job: { jobId: "j1", moduleId: "door", assistantId: "alpha" } }
    const messageOf = async (effect: Effect.Effect<unknown, { readonly message: string }>) => {
      const exit = await Effect.runPromise(Effect.exit(effect))
      return exit._tag === "Success" ? "ran" : String((exit.cause as { readonly reasons?: ReadonlyArray<{ readonly error?: { readonly message?: string } }> }).reasons?.[0]?.error?.message)
    }
    const refused = "Not run: it would act on a lock, an alarm, a door or a gate, which this assistant never does."
    expect(await messageOf(host.gateway.tool("door", open, {}, { principal: turn }))).toBe(refused)
    expect(await messageOf(host.gateway.action(unlockTool.action!, {}, { principal: turn }))).toBe(refused)
    expect(await messageOf(host.gateway.tool("door", open, {}, { principal: job }))).toBe(refused)
    expect(await messageOf(host.gateway.action(unlockTool.action!, {}, { principal: job }))).toBe(refused)
    expect(ran).toEqual([])
  })
})

describe("an existing installation and the scaffold", () => {
  it("with the assistant's old choices and every new module off, serve mode runs and offers what it did before", async () => {
    const before = [clockModule, weatherModule(), homeAssistantModule()]
    const old = { clock: { on: true, offTools: [] }, weather: { on: true, offTools: [] }, "home-assistant": { on: false, offTools: [] } }
    const dataDir = await dataDirWith(old, before)
    const copy = mkdtempSync(join(tmpdir(), "pva-scaffold-copy-"))
    cpSync(dataDir, copy, { recursive: true })
    // The catalogue before the scaffold, then the app's catalogue now, on the same saved settings.
    const then = await serve(dataDir, before)
    await then.typed("what time is it")
    const now = await serve(copy, moduleCatalog)
    await now.typed("what time is it")
    expect(now.llm.requests[0]!.tools).toEqual(then.llm.requests[0]!.tools)
    expect(now.llm.requests[0]!.system).toEqual(then.llm.requests[0]!.system)
    const states = new Map(now.server.handle.host.modules().map((m) => [m.id, m.state]))
    const added = moduleCatalog.map((m) => m.id).filter((id) => !before.some((b) => b.id === id) && id !== "claude-subscription")
    expect(added.length).toBeGreaterThan(15)
    for (const id of added) expect([id, states.get(id)]).toEqual([id, "disabled"])
    // The saved settings were not rewritten with the new modules.
    expect(Object.keys((JSON.parse(readFileSync(join(copy, "settings.json"), "utf8")) as Json).assistants.byId.alpha.modules).sort()).toEqual(Object.keys(old).sort())
  })
})
