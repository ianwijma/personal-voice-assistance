// Review of PR #41: a turn's configuration snapshot (`TraceInfo.config.toolRounds`) is the tool-round limit that turn
// ran with. An assistant's changed `toolRounds` applies from its next turn in the conversation that is already running
// (docs/ASSISTANTS.md: live at the next turn start), and that turn's snapshot reports the same number.
import { Llm, type LlmEvent } from "@pva/core"
import { type Assistant, type ServerMessage, type TraceInfo } from "@pva/protocol"
import { Effect, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

/** Every model call, from every instance. */
let calls = 0
/** Instances that ask for the greeter's tool on every call: a turn makes exactly its tool-round limit + 1 calls. */
const alwaysTools: LlmBuilder = () =>
  Effect.succeed(Llm.of({
    stream: () =>
      Stream.suspend(() => {
        calls++
        return Stream.fromIterable<LlmEvent>([{ _tag: "ToolCall", id: `c${calls}`, name: "greet", input: {} }, { _tag: "Done", stopReason: "tool_use" }])
      })
  }))

/** One assistant, Alpha: the greeter module on (its one tool, `greet`), 3 tool rounds. */
const dataDirWithAlpha = async (): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-toolrounds-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = {
    ...base,
    id: "alpha",
    rev: 0,
    name: "Alpha",
    toolRounds: 3,
    llm: { ...base.llm, account: "anthropic", model: "model-a" },
    modules: { greeter: { on: true, offTools: [] } }
  }
  file.assistants = { order: ["alpha"], byId: { alpha } }
  file.modules = { ...file.modules, greeter: { ...(file.modules?.greeter ?? {}), enabled: true, settings: { greeting: "hello" } } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }],
    withoutPhrase: { mode: "nobody" },
    interruptMode: "instant"
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const connect = async () => {
  const client = await ScriptedClient.connect({ url: server!.url })
  clients.push(client)
  return client
}

const traces = (client: ScriptedClient): Array<TraceInfo> =>
  client.messages.flatMap((m: ServerMessage): Array<TraceInfo> => (m.type === "trace" ? [m.trace] : []))

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 500 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

describe("an assistant's tool rounds, changed while its conversation runs", () => {
  it("the next turn runs with the new limit, and its snapshot reports the limit it ran with", async () => {
    calls = 0
    const dataDir = await dataDirWithAlpha()
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "the build's").llm }), buildLlm: alwaysTools, dataDir })
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)

    const typed = async (text: string, id: string) => {
      const from = page.messages.length
      page.send({ type: "text.send", requestId: id, text, speak: false, assistantId: "alpha" })
      expect((await page.waitFor("result", (m) => m.requestId === id, { from })).ok).toBe(true)
      const begun = await page.waitFor("turn.start", (m) => m.assistantId === "alpha", { from, timeoutMs: 10_000 })
      await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    }

    await typed("first", "t1")
    await until("one trace", () => traces(admin).length === 1)
    expect(calls).toBe(4)
    expect(traces(admin)[0]!.config?.toolRounds).toBe(3)

    // No tool rounds from now on; nothing reloads, so the conversation that runs is the one the first turn used.
    const store = server.handle.store
    const alpha = store.assistants().find((a) => a.id === "alpha")!
    await Effect.runPromise(store.saveAssistantRecord({ ...alpha, toolRounds: 0 } satisfies Assistant))
    await typed("second", "t2")
    await until("two traces", () => traces(admin).length === 2)
    expect(traces(admin)[1]!.config?.toolRounds).toBe(0)
    expect(calls - 4).toBe(0 + 1)
  })
})
