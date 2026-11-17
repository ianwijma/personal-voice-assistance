// Assistants on one device (docs/ASSISTANTS.md WP-4b "thin slice"): the settings store's assistants and device
// settings decide who answers, through the route gate and the session dispatcher, against the real server with
// injected providers and the scripted client.
import { endOfTurn, speechStarted } from "@pva/core/testing"
import type { ServerMessage, TraceInfo } from "@pva/protocol"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
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

/**
 * A data directory whose settings hold two assistants on the browser defaults: Alpha (its own prompt, the greeter
 * module on) and Bravo (another prompt, no modules), "hey alpha" / "hey bravo", nobody answers without a phrase,
 * follow-up 8 s. Made from the migrated default install (a first start writes version 4), then edited.
 */
export const twoAssistantsDataDir = async (edit: (file: Json) => void = () => {}): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-assistants-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", prompt: "You are Alpha.", followUpSeconds: 8, modules: { greeter: { on: true, offTools: [] } } }
  const bravo = { ...base, id: "bravo", rev: 0, name: "Bravo", prompt: "You are Bravo.", followUpSeconds: 8, modules: {} }
  file.assistants = { order: ["alpha", "bravo"], byId: { alpha, bravo } }
  file.modules = { ...file.modules, greeter: { ...(file.modules?.greeter ?? {}), enabled: true, settings: { greeting: "hello" } } }
  file.deviceTypes["web-voice"] = {
    ...file.deviceTypes["web-voice"],
    assistants: [{ assistant: "alpha", phrases: ["hey alpha"] }, { assistant: "bravo", phrases: ["hey bravo"] }],
    withoutPhrase: { mode: "nobody" },
    interruptMode: "instant"
  }
  edit(file)
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

const start = async (dataDir: string) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `Reply to ${t}.`)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), dataDir })
  return { stt, llm }
}

const connect = async () => {
  const client = await ScriptedClient.connect({ url: server!.url })
  clients.push(client)
  return client
}

const untilOpen = async (stt: ReturnType<typeof controlledStt>, n: number) => {
  for (let i = 0; i < 200 && stt.open() < n; i++) await sleep(10)
  expect(stt.open()).toBe(n)
}

const userTexts = (messages: ReadonlyArray<unknown>) =>
  messages.flatMap((m) => ((m as { role?: string }).role === "user" ? [(m as { content: string }).content] : []))

describe("assistants on one device (WP-4b)", () => {
  it("two assistants: answered by phrase from separate histories with their own prompts and tools; follow-up stays; a phrase alone arms; traces carry assistant and route", async () => {
    const { stt, llm } = await start(await twoAssistantsDataDir())
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()
    await page.claim()
    await untilOpen(stt, 1)

    /** Say `text` as one utterance; the turn it starts (and its end, after the reply has played). */
    const utterance = async (text: string) => {
      const from = page.messages.length
      stt.emit(speechStarted, endOfTurn(text))
      const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
      await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
      // The reply has played (the follow-up window opens at its end).
      await page.waitFor("state", (m) => m.state !== "speaking" && m.state !== "thinking", { from, timeoutMs: 5_000 })
      return begun
    }

    // 1. "hey alpha …": Alpha, with its prompt and the greeter's instructions and tool.
    const one = await utterance("hey alpha what time is it")
    expect(one).toMatchObject({ userText: "what time is it", assistantId: "alpha" })
    expect(llm.requests[0]!.system).toContain("You are Alpha.")
    expect(llm.requests[0]!.system).toContain("Greet with hello.")
    expect(llm.requests[0]!.tools).toEqual(["greet"])

    // 2. Within Alpha's follow-up window, no phrase: Alpha again, from its own history.
    const two = await utterance("and tomorrow")
    expect(two).toMatchObject({ userText: "and tomorrow", assistantId: "alpha" })
    expect(userTexts(llm.requests[1]!.messages)).toEqual(["what time is it", "and tomorrow"])

    // 3. "hey bravo …": Bravo, its own prompt, no greeter (module off for it), a history of its own.
    const three = await utterance("hey bravo tell me a joke")
    expect(three).toMatchObject({ userText: "tell me a joke", assistantId: "bravo" })
    expect(llm.requests[2]!.system).toContain("You are Bravo.")
    expect(llm.requests[2]!.system).not.toContain("Greet with hello.")
    expect(llm.requests[2]!.system).not.toContain("You are Alpha.")
    expect(llm.requests[2]!.tools).toEqual([])
    expect(userTexts(llm.requests[2]!.messages)).toEqual(["tell me a joke"])

    // 4. The phrase alone arms Alpha (inside Bravo's follow-up window): no turn; the next sentence goes to Alpha.
    const before = page.messages.length
    stt.emit(speechStarted, endOfTurn("hey alpha"))
    expect(await page.waitFor("wake", () => true, { from: before })).toEqual({ type: "wake", phrase: "hey alpha", armed: true, assistantId: "alpha" })
    await sleep(150)
    expect(page.types(before)).not.toContain("turn.start")
    const four = await utterance("one more thing")
    expect(four).toMatchObject({ userText: "one more thing", assistantId: "alpha" })
    expect(userTexts(llm.requests[3]!.messages)).toEqual(["what time is it", "and tomorrow", "one more thing"])
    expect(llm.requests).toHaveLength(4)

    // Turn ids are unique across the device's conversations.
    expect([one, two, three, four].map((t) => t.turnId)).toEqual([1, 2, 3, 4])
    // The assistant's messages carry it.
    expect(page.messages.filter((m) => m.type === "assistant.text").every((m) => (m as { assistantId?: string }).assistantId !== undefined)).toBe(true)

    // Admin's live traces: who answered and who chose the assistant, and the device.
    for (let i = 0; i < 100 && admin.messages.filter((m) => m.type === "trace").length < 4; i++) await sleep(10)
    const traces = admin.messages.flatMap((m: ServerMessage): Array<TraceInfo> => (m.type === "trace" ? [m.trace] : []))
    expect(traces.map((t) => [t.turnId, t.assistant, t.route])).toEqual([
      [1, { id: "alpha", name: "Alpha" }, { by: "phrase", phrase: "hey alpha" }],
      [2, { id: "alpha", name: "Alpha" }, { by: "follow-up" }],
      [3, { id: "bravo", name: "Bravo" }, { by: "phrase", phrase: "hey bravo" }],
      [4, { id: "alpha", name: "Alpha" }, { by: "armed", phrase: "hey alpha" }]
    ])
    for (const t of traces) {
      expect(t.deviceId).toBe(page.device.id)
      expect(t.device).toBe("Test browser")
    }
    // The device's own tabs get the trace without the device's (admin-set) name.
    const own = page.messages.flatMap((m) => (m.type === "turn.end" ? [m.trace] : []))
    expect(own.map((t) => t.assistant?.id)).toEqual(["alpha", "alpha", "bravo", "alpha"])
    expect(own.every((t) => t.device === undefined && t.session === undefined)).toBe(true)
  })

  it("typed text goes to the assistant the page names, else the follow-up holder, else who answers without a phrase; conversation.new is per assistant", async () => {
    const { llm } = await start(await twoAssistantsDataDir((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "bravo" }
    }))
    const page = await connect()
    await page.hello()
    const type = async (text: string, assistantId?: string) => {
      const from = page.messages.length
      page.send({ type: "text.send", requestId: `t-${from}`, text, speak: false, ...(assistantId !== undefined ? { assistantId } : {}) })
      const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
      await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
      return begun
    }
    // Nothing named, no spoken reply (no follow-up window): who answers without a phrase.
    expect((await type("hello")).assistantId).toBe("bravo")
    expect((await type("hi alpha", "alpha")).assistantId).toBe("alpha")
    expect(llm.requests.map((r) => r.system.includes("You are Alpha."))).toEqual([false, true])
    // A new conversation for Alpha leaves Bravo's.
    const from = page.messages.length
    page.send({ type: "conversation.new", requestId: "new-alpha", assistantId: "alpha" })
    const told = await page.waitFor("conversation", () => true, { from })
    expect(told).toMatchObject({ reason: "new", assistantId: "alpha" })
    expect((await type("and again")).assistantId).toBe("bravo")
    expect(userTexts(llm.requests[2]!.messages)).toEqual(["hello", "and again"])
    expect((await type("fresh", "alpha")).assistantId).toBe("alpha")
    expect(userTexts(llm.requests[3]!.messages)).toEqual(["fresh"])
  })
})
