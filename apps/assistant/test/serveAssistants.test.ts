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

  it("who has the turn: state.holder names the follow-up holder and goes back to nobody when its window lapses while the device keeps listening; a welcome in the window says whose history it sends", async () => {
    const { stt } = await start(await twoAssistantsDataDir((file) => {
      file.assistants.byId.bravo.followUpSeconds = 1
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "alpha" }
    }))
    const page = await connect()
    await page.hello()
    await page.claim()
    await untilOpen(stt, 1)
    const from = page.messages.length
    stt.emit(speechStarted, endOfTurn("hey bravo tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    expect(begun.assistantId).toBe("bravo")
    const end = await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    await page.waitFor("state", (m) => m.holder === "bravo", { from })

    // Another tab of the device inside Bravo's follow-up window: the snapshot's history is Bravo's, and says so.
    const tab = await ScriptedClient.connect({ url: server!.url, deviceId: page.device.id })
    clients.push(tab)
    const welcome = await tab.hello()
    expect(welcome.snapshot.answering).toBe("bravo")
    expect(welcome.snapshot.history.filter((h) => h.role === "user").map((h) => h.text)).toEqual(["tell me a joke"])

    // The window lapses (1 s after the reply); Alpha answers without a phrase again and the state stays listening.
    const lapsed = await page.waitFor("state", (m) => m.holder === null, { from: page.messages.indexOf(end), timeoutMs: 5_000 })
    expect(lapsed.state).toBe("listening")
    await tab.waitFor("state", (m) => m.holder === null, { timeoutMs: 5_000 })
  })

  it("who has the turn after the phrase alone: a joining tab is told apart from whose history it gets, the next sentence is heard as the armed assistant's, and an accepted pick hands the next sentence to the picked one", async () => {
    const { stt } = await start(await twoAssistantsDataDir((file) => {
      file.assistants.byId.bravo.followUpSeconds = 0
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "alpha" }
      file.deviceTypes["web-voice"].voicePage = { pick: true }
    }))
    const page = await connect()
    await page.hello()
    await page.claim()
    await untilOpen(stt, 1)

    // "hey bravo" alone arms Bravo (Alpha answers without a phrase): the state names Bravo.
    let from = page.messages.length
    stt.emit(speechStarted, endOfTurn("hey bravo"))
    await page.waitFor("wake", (m) => m.armed, { from })
    await page.waitFor("state", (m) => m.state === "listening" && m.holder === "bravo", { from, timeoutMs: 5_000 })

    // Another tab of the device inside the armed window: the history is Alpha's, the turn is Bravo's.
    const tab = await ScriptedClient.connect({ url: server!.url, deviceId: page.device.id })
    clients.push(tab)
    const welcome = await tab.hello()
    expect(welcome.snapshot.answering).toBe("alpha")
    expect(welcome.snapshot.holder).toBe("bravo")

    // The next sentence starts: it uses up the armed window, and Bravo keeps the turn while it is heard.
    from = page.messages.length
    stt.emit(speechStarted)
    const hearing = await page.waitFor("state", (m) => m.state === "hearing", { from })
    expect(hearing.holder).toBe("bravo")
    stt.emit(endOfTurn("tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    expect(begun.assistantId).toBe("bravo")
    expect(page.messages.slice(from, page.messages.indexOf(begun)).filter((m) => m.type === "state").map((m) => (m as { holder?: string | null }).holder)).not.toContain(null)
    await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    // Bravo has no follow-up: nobody has the turn after its reply.
    await page.waitFor("state", (m) => m.state === "listening" && m.holder === null, { from, timeoutMs: 5_000 })

    // Armed again, then the page picks Alpha (who answers without a phrase already): the window closes on the server too.
    from = page.messages.length
    stt.emit(speechStarted, endOfTurn("hey bravo"))
    await page.waitFor("state", (m) => m.state === "listening" && m.holder === "bravo", { from, timeoutMs: 5_000 })
    const tabFrom = tab.messages.length
    page.send({ type: "device.pick", requestId: "pick-1", withoutPhrase: "alpha" })
    expect(await page.waitFor("result", (m) => m.requestId === "pick-1", { from })).toMatchObject({ ok: true })
    await page.waitFor("state", (m) => m.holder === null, { from })
    await tab.waitFor("state", (m) => m.holder === null, { from: tabFrom })
    from = page.messages.length
    stt.emit(speechStarted, endOfTurn("what time is it"))
    expect(await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })).toMatchObject({ assistantId: "alpha", userText: "what time is it" })
  })

  it("the phrase alone, then a pick inside the hearing tail: the utterance is over, so the pick hands the turn back at once, before the state leaves hearing", async () => {
    const { stt } = await start(await twoAssistantsDataDir((file) => {
      file.assistants.byId.bravo.followUpSeconds = 0
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "alpha" }
      file.deviceTypes["web-voice"].voicePage = { pick: true }
    }))
    const page = await connect()
    await page.hello()
    await page.claim()
    await untilOpen(stt, 1)

    // "hey bravo" alone: the utterance is heard as Alpha's until the phrase, then it is over and Bravo is armed.
    let from = page.messages.length
    stt.emit(speechStarted, endOfTurn("hey bravo"))
    await page.waitFor("wake", (m) => m.armed, { from })
    const armed = await page.waitFor("state", (m) => m.holder === "bravo", { from })
    // Still the hearing tail (2 s after the last event): the armed window names Bravo, not the finished utterance.
    expect(armed.state).toBe("hearing")

    // The pick inside that tail: nobody holds the turn now, said while the state is still hearing.
    from = page.messages.length
    page.send({ type: "device.pick", requestId: "pick-tail", withoutPhrase: "alpha" })
    expect(await page.waitFor("result", (m) => m.requestId === "pick-tail", { from })).toMatchObject({ ok: true })
    const released = await page.waitFor("state", (m) => m.holder === null, { from })
    expect(released.state).toBe("hearing")
    from = page.messages.length
    stt.emit(speechStarted, endOfTurn("what time is it"))
    expect(await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })).toMatchObject({ assistantId: "alpha", userText: "what time is it" })
  })

  it("the holder comes from the routing state, not the display: a sentence that outlasts the hearing timer stays the armed assistant's, and a muted microphone keeps a follow-up holder", async () => {
    const { stt } = await start(await twoAssistantsDataDir((file) => {
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "alpha" }
    }))
    const page = await connect()
    await page.hello()
    await page.claim()
    await untilOpen(stt, 1)

    // "hey bravo" alone arms Bravo; the next sentence starts and, with no interims (Whisper), lasts past the 2 s
    // hearing timer: the display goes back to listening while the utterance is still open and still Bravo's.
    let from = page.messages.length
    stt.emit(speechStarted, endOfTurn("hey bravo"))
    await page.waitFor("state", (m) => m.state === "listening" && m.holder === "bravo", { from, timeoutMs: 5_000 })
    from = page.messages.length
    stt.emit(speechStarted)
    await page.waitFor("state", (m) => m.state === "hearing" && m.holder === "bravo", { from })
    const tail = await page.waitFor("state", (m) => m.state === "listening", { from, timeoutMs: 5_000 })
    expect(tail.holder).toBe("bravo")
    // A tab joining now is told the same.
    const tab = await ScriptedClient.connect({ url: server!.url, deviceId: page.device.id })
    clients.push(tab)
    expect((await tab.hello()).snapshot.holder).toBe("bravo")
    stt.emit(endOfTurn("tell me a joke"))
    const begun = await page.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
    expect(begun.assistantId).toBe("bravo")
    const holders = page.messages.slice(from, page.messages.indexOf(begun)).filter((m) => m.type === "state").map((m) => (m as { holder?: string | null }).holder)
    expect(holders).not.toContain(null)
    expect(holders).not.toContain("alpha")
    await page.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
    await page.waitFor("state", (m) => m.state === "listening" && m.holder === "bravo", { from, timeoutMs: 5_000 })

    // Bravo's follow-up window is open (8 s): muting the microphone makes the display idle, the turn stays Bravo's.
    from = page.messages.length
    page.send({ type: "mic.state", live: false })
    const muted = await page.waitFor("state", (m) => m.state === "idle", { from, timeoutMs: 5_000 })
    expect(muted.holder).toBe("bravo")
  })

  it("a new conversation or Stop while a sentence is heard cancels that sentence: its assistant holds the turn no longer, and no turn follows", async () => {
    const { stt } = await start(await twoAssistantsDataDir((file) => {
      file.assistants.byId.bravo.followUpSeconds = 0
      file.deviceTypes["web-voice"].withoutPhrase = { mode: "assistant", assistant: "alpha" }
    }))
    const page = await connect()
    await page.hello()
    await page.claim()
    await untilOpen(stt, 1)
    // Bravo's conversation exists (a typed message), so a new one stops the utterance it has open.
    let from = page.messages.length
    page.send({ type: "text.send", requestId: "t-1", text: "hello", speak: false, assistantId: "bravo" })
    await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })

    const cancelled = async (cancel: () => void) => {
      // Armed by the phrase alone; the next sentence starts and is heard as Bravo's.
      from = page.messages.length
      stt.emit(speechStarted, endOfTurn("hey bravo"))
      await page.waitFor("state", (m) => m.state === "listening" && m.holder === "bravo", { from, timeoutMs: 5_000 })
      from = page.messages.length
      stt.emit(speechStarted)
      await page.waitFor("state", (m) => m.state === "hearing" && m.holder === "bravo", { from })
      await sleep(100)
      from = page.messages.length
      cancel()
      const released = await page.waitFor("state", (m) => m.holder === null, { from })
      expect(released.state).toBe("hearing")
      stt.emit(endOfTurn("tell me a joke"))
      await page.waitFor("state", (m) => m.state === "listening", { from, timeoutMs: 5_000 })
      const after = page.messages.slice(from)
      expect(after.some((m) => m.type === "turn.start")).toBe(false)
      expect(after.filter((m) => m.type === "state").map((m) => (m as { holder?: string | null }).holder)).not.toContain("bravo")
    }
    await cancelled(() => page.send({ type: "conversation.new", requestId: "new-bravo", assistantId: "bravo" }))
    await cancelled(() => page.send({ type: "interrupt" }))
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
