// Voice sessions (docs/VOICE-SESSIONS.md step 2): one session per device, several devices at once, against the real
// server with injected providers and the scripted client.
import { endOfTurn } from "@pva/core/testing"
import type { ServerMessage } from "@pva/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const start = async (extra: Partial<Parameters<typeof startTestServer>[0]> = {}, reply: (t: string) => string = (t) => `Reply to ${t}.`) => {
  const stt = controlledStt()
  const llm = scriptedLlm(reply)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), ...extra })
  return { stt, llm }
}

/** A voice tab of device `deviceId` (a fresh client id each time). */
const tab = async (deviceId: string, options: { readonly clientId?: string } = {}) => {
  const client = await ScriptedClient.connect({ url: server!.url, deviceId, ...options })
  clients.push(client)
  return client
}

/** Wait until `n` recognition streams are open (each new session's loop opens one as it starts). */
const untilOpen = async (stt: ReturnType<typeof controlledStt>, n: number) => {
  for (let i = 0; i < 200 && stt.open() < n; i++) await sleep(10)
  expect(stt.open()).toBe(n)
}

const texts = (client: ScriptedClient, type: "turn.start" | "transcript") =>
  client.messages.filter((m) => m.type === type).map((m) => (m as { userText?: string; text?: string }).userText ?? (m as { text: string }).text)

const say = async (client: ScriptedClient, text: string, requestId = `t-${Math.random()}`) => {
  const from = client.messages.length
  client.send({ type: "text.send", requestId, text, speak: false })
  return client.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
}

describe("voice sessions: several devices at once", () => {
  it("two devices talk at the same time; each hears only its own reply and sees only its own transcript, state and history", async () => {
    const { stt } = await start({}, (t) => `Answer for ${t}. More words here.`)
    const a = await tab("device-a")
    await a.hello()
    await a.claim()
    const b = await tab("device-b")
    await b.hello()
    await b.claim()
    await untilOpen(stt, 2)
    const fromA = a.messages.length
    const fromB = b.messages.length
    // Simultaneous turn ends: stream 0 is device A's session (created first), stream 1 device B's.
    stt.emitTo(0, endOfTurn("question from a"))
    stt.emitTo(1, endOfTurn("question from b"))
    const [endA, endB] = await Promise.all([
      a.waitFor("turn.end", () => true, { from: fromA, timeoutMs: 10_000 }),
      b.waitFor("turn.end", () => true, { from: fromB, timeoutMs: 10_000 })
    ])
    expect(endA.outcome).toBe("completed")
    expect(endB.outcome).toBe("completed")
    expect(texts(a, "turn.start")).toEqual(["question from a"])
    expect(texts(b, "turn.start")).toEqual(["question from b"])
    const said = (c: ScriptedClient) => c.messages.filter((m) => m.type === "assistant.text").map((m) => (m as { text: string }).text).join(" ")
    expect(said(a)).toContain("question from a")
    expect(said(a)).not.toContain("question from b")
    expect(said(b)).not.toContain("question from a")
    // Each owner got its own reply audio, and only one reply.
    expect(a.replySamples.size).toBe(1)
    expect(b.replySamples.size).toBe(1)
    expect([...a.replySamples.values()][0]).toBeGreaterThan(0)
    expect(endA.turnId).toBe(1)
    expect(endB.turnId).toBe(1)
    // A late tab of each device sees that device's history only.
    const lateA = await tab("device-a")
    expect((await lateA.hello()).snapshot.history.map((h) => h.text)).toEqual(["question from a", "Answer for question from a. More words here."])
    const lateB = await tab("device-b")
    const welcomeB = await lateB.hello()
    expect(welcomeB.snapshot.history.map((h) => h.text)).toEqual(["question from b", "Answer for question from b. More words here."])
    expect(welcomeB.snapshot.conversations[0]!.id).not.toBe((await lateA.waitFor("welcome", () => true, { from: 0 })).snapshot.conversations[0]!.id)
    // State messages of B never reach A's tabs: A's states are its own.
    expect(b.messages.slice(fromB).some((m) => m.type === "state" && m.state === "speaking")).toBe(true)
  })

  it("a claim on device B leaves device A's owner alone; a claim on another tab of A takes it over within A", async () => {
    const { stt } = await start({}, () => "One long clause. Another long clause. And a third one.")
    const a1 = await tab("device-a")
    await a1.hello()
    await a1.claim()
    await untilOpen(stt, 1)
    stt.emitTo(0, endOfTurn("talk"))
    await a1.waitFor("assistant.playing", () => true, { timeoutMs: 10_000 })
    const b = await tab("device-b")
    const welcomeB = await b.hello()
    // B's device has no owner: A's owner is not B's business.
    expect(welcomeB.snapshot.ownerPresent).toBe(false)
    expect(welcomeB.snapshot.role).toBe("observer")
    await b.claim()
    // A keeps the audio and its reply plays to the end.
    expect((await a1.waitFor("turn.end", () => true, { timeoutMs: 10_000 })).outcome).toBe("completed")
    expect(a1.types()).not.toContain("reply.stop")
    expect(a1.messages.filter((m) => m.type === "session").map((m) => (m as { reason: string }).reason)).toEqual(["claimed"])
    // Two tabs of one device: as before, the last claim on that device wins.
    const a2 = await tab("device-a")
    expect((await a2.hello()).snapshot.ownerPresent).toBe(true)
    await a2.claim()
    expect(await a1.waitFor("session", (m) => m.reason === "taken_over")).toMatchObject({ role: "observer", ownerPresent: true })
    // …and B's owner was told nothing.
    expect(b.messages.filter((m) => m.type === "session").map((m) => (m as { reason: string }).reason)).toEqual(["claimed"])
  })

  it("conversation.new on device A leaves device B's history and conversation", async () => {
    await start()
    const a = await tab("device-a")
    await a.hello()
    const b = await tab("device-b")
    const firstB = await b.hello()
    expect((await say(a, "hello a")).outcome).toBe("completed")
    expect((await say(b, "hello b")).outcome).toBe("completed")
    const before = (await (await tab("device-b")).hello()).snapshot.conversations[0]!.id
    a.send({ type: "conversation.new", requestId: "n1" })
    expect((await a.waitFor("result", (m) => m.requestId === "n1")).ok).toBe(true)
    expect((await a.waitFor("conversation", () => true, { from: 0 })).reason).toBe("new")
    await sleep(50)
    expect(b.types()).not.toContain("conversation")
    const lateB = await tab("device-b")
    const welcome = await lateB.hello()
    expect(welcome.snapshot.history.map((h) => h.text)).toEqual(["hello b", "Reply to hello b."])
    expect(welcome.snapshot.conversations[0]!.id).toBe(before)
    expect(firstB.snapshot.conversations[0]!.id).toBe(before)
    const lateA = await tab("device-a")
    expect((await lateA.hello()).snapshot.history).toEqual([])
  })

  it("conversation.new on a device without a session yet: a new id for its tabs, kept when the session starts", async () => {
    await start()
    const a = await tab("device-a")
    const welcome = await a.hello()
    a.send({ type: "conversation.new", requestId: "n1" })
    const told = await a.waitFor("conversation")
    expect(told.reason).toBe("new")
    expect(told.id).not.toBe(welcome.snapshot.conversations[0]!.id)
    await say(a, "first words")
    const later = await tab("device-a")
    expect((await later.hello()).snapshot.conversations[0]!.id).toBe(told.id)
  })

  it("idle reset: after the device's conversationIdleMinutes without a turn, the next turn starts a new conversation", async () => {
    // One "minute" is 200 ms here; the device kind's default is 1 minute.
    const { llm } = await start({ minuteMs: 200, kindDefaults: { interruptMode: "instant", conversationIdleMinutes: 1 } })
    const a = await tab("device-a")
    const first = await a.hello()
    await say(a, "first")
    expect(a.types()).not.toContain("conversation")
    await say(a, "second, soon after")
    expect(llm.requests.at(-1)!.messages.map((m: any) => m.content)).toEqual(["first", "Reply to first.", "second, soon after"])
    await sleep(350)
    const from = a.messages.length
    await say(a, "third, much later")
    const told = a.messages.slice(from).find((m): m is Extract<ServerMessage, { type: "conversation" }> => m.type === "conversation")
    expect(told?.reason).toBe("idle")
    expect(told?.id).not.toBe(first.snapshot.conversations[0]!.id)
    // Sent before the turn that started it.
    expect(a.types(from).indexOf("conversation")).toBeLessThan(a.types(from).indexOf("turn.start"))
    expect(llm.requests.at(-1)!.messages.map((m: any) => m.content)).toEqual(["third, much later"])
  })

  it("sessions_full: one session more than MAX_VOICE_SESSIONS is refused for a claim and for typed text", async () => {
    await start({ env: { MAX_VOICE_SESSIONS: "1" } })
    const a = await tab("device-a")
    await a.hello()
    await a.claim()
    const b = await tab("device-b")
    await b.hello()
    b.send({ type: "audio.claim", audio: { contextSampleRate: 48_000, outputPath: "direct", outputLatencyMs: 10 } })
    expect((await b.waitFor("error")).error.code).toBe("sessions_full")
    b.send({ type: "text.send", requestId: "t1", text: "hi", speak: false })
    const refused = await b.waitFor("result", (m) => m.requestId === "t1")
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("sessions_full")
    // Device A's other tab is not a new session.
    const a2 = await tab("device-a")
    await a2.hello()
    expect((await say(a2, "still works")).outcome).toBe("completed")
  })

  it("at the limit, a device that is here takes the place of the least recently active one that left", async () => {
    await start({ env: { MAX_VOICE_SESSIONS: "2" } })
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const a = await tab("device-a")
    await a.hello()
    await say(a, "from a")
    const b = await tab("device-b")
    await b.hello()
    await say(b, "from b")
    await say(a, "a again") // B is now the least recently active
    // Both left: their sessions wait for SESSION_DISCARD_MINUTES (30 min).
    a.close()
    b.close()
    await sleep(100)
    const c = await tab("device-c")
    await c.hello()
    expect((await say(c, "from c")).outcome).toBe("completed")
    const listed = await admin.waitFor("sessions", (m) => m.sessions.length === 2 && m.sessions.some((x) => x.key === "device-c"), { from: 0, timeoutMs: 3_000 })
    expect(listed.sessions.map((x) => x.key).sort()).toEqual(["device-a", "device-c"])
    // A kept its conversation; B starts a fresh one when it comes back (and takes A's place: A has no connection).
    const backA = await tab("device-a")
    expect((await backA.hello()).snapshot.history.filter((h) => h.role === "user").map((h) => h.text)).toEqual(["from a", "a again"])
    backA.close()
    await sleep(100)
    const backB = await tab("device-b")
    expect((await backB.hello()).snapshot.history).toEqual([])
    expect((await say(backB, "b is back")).outcome).toBe("completed")
    // Every session's device connected (C, B): one more is refused.
    const c2 = await tab("device-c")
    await c2.hello()
    const d = await tab("device-d")
    await d.hello()
    d.send({ type: "text.send", requestId: "d1", text: "hi", speak: false })
    expect((await d.waitFor("result", (m) => m.requestId === "d1")).error?.code).toBe("sessions_full")
  })

  it("a device without a connection keeps its session for SESSION_DISCARD_MINUTES, then it is discarded", async () => {
    // One "minute" is 300 ms here.
    await start({ minuteMs: 300, env: { SESSION_DISCARD_MINUTES: "1" } })
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const a = await tab("device-a")
    await a.hello()
    await say(a, "remember me")
    const id = (await admin.waitFor("sessions", (m) => m.sessions.length === 1 && m.sessions[0]!.turns === 1, { from: 0 })).sessions[0]!.conversationId
    a.close()
    await sleep(100)
    // Back within the time: the same conversation.
    const back = await tab("device-a")
    const welcome = await back.hello()
    expect(welcome.snapshot.history.map((h) => h.text)).toEqual(["remember me", "Reply to remember me."])
    expect(welcome.snapshot.conversations[0]!.id).toBe(id)
    back.close()
    await admin.waitFor("sessions", (m) => m.sessions.length === 0, { from: 0, timeoutMs: 3_000 })
    const later = await tab("device-a")
    const fresh = await later.hello()
    expect(fresh.snapshot.history).toEqual([])
    expect(fresh.snapshot.conversations[0]!.id).not.toBe(id)
  })

  it("an engine reload with two sessions keeps both histories and both conversation ids", async () => {
    await start()
    const a = await tab("device-a")
    await a.hello()
    const b = await tab("device-b")
    await b.hello()
    await say(a, "before reload a")
    await say(b, "before reload b")
    const idOf = async (device: string) => (await (await tab(device)).hello()).snapshot.conversations[0]!.id
    const [idA, idB] = [await idOf("device-a"), await idOf("device-b")]
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    admin.send({ type: "engine.reload", requestId: "r1" })
    expect((await admin.waitFor("result", (m) => m.requestId === "r1", { timeoutMs: 10_000 })).ok).toBe(true)
    expect(a.types()).not.toContain("conversation")
    await say(a, "after reload a")
    await say(b, "after reload b")
    const lateA = await tab("device-a")
    const welcomeA = await lateA.hello()
    expect(welcomeA.snapshot.history.filter((h) => h.role === "user").map((h) => h.text)).toEqual(["before reload a", "after reload a"])
    expect(welcomeA.snapshot.conversations[0]!.id).toBe(idA)
    const lateB = await tab("device-b")
    const welcomeB = await lateB.hello()
    expect(welcomeB.snapshot.history.filter((h) => h.role === "user").map((h) => h.text)).toEqual(["before reload b", "after reload b"])
    expect(welcomeB.snapshot.conversations[0]!.id).toBe(idB)
  })

  it("admin: sessions (and admin.snapshot.sessions) list the devices talking, most recently active first; no turn traffic", async () => {
    await start()
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    expect((await admin.admin(TEST_ADMIN_PASSWORD)).snapshot.sessions).toEqual([])
    const a = await tab("device-a")
    await a.hello()
    await a.claim()
    const listed = await admin.waitFor("sessions", (m) => m.sessions.some((s) => s.ownerPresent), { from: 0, timeoutMs: 3_000 })
    expect(listed.sessions[0]).toMatchObject({ key: "device-a", deviceId: "device-a", name: "Test browser", ownerPresent: true, turns: 0, lastTurnAt: null })
    const b = await tab("device-b")
    await b.hello()
    await say(b, "hi from b")
    const after = await admin.waitFor("sessions", (m) => m.sessions.length === 2 && m.sessions[0]!.turns === 1, { from: 0, timeoutMs: 3_000 })
    expect(after.sessions.map((s) => s.key)).toEqual(["device-b", "device-a"])
    expect(after.sessions[0]!.lastTurnAt).toBeGreaterThan(0)
    expect(admin.types()).not.toContain("turn.start")
    expect(admin.types()).not.toContain("state")
    const again = await ScriptedClient.connect({ url: server!.url })
    clients.push(again)
    const snapshot = (await again.admin(TEST_ADMIN_PASSWORD)).snapshot
    expect(snapshot.sessions.map((s) => s.key).sort()).toEqual(["device-a", "device-b"])
    expect(snapshot.traces.map((t) => t.session)).toEqual(["Test browser"])
  })

  it("admin: every finished turn of every session arrives live as trace (key, device, session name); voice pages never get it", async () => {
    await start()
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const a = await tab("device-a")
    await a.hello()
    const b = await tab("device-b")
    await b.hello()
    await Promise.all([say(a, "hi from a"), say(b, "hi from b")])
    await say(a, "again from a")
    for (let i = 0; i < 100 && admin.messages.filter((m) => m.type === "trace").length < 3; i++) await sleep(10)
    const traces = admin.messages.filter((m): m is Extract<ServerMessage, { type: "trace" }> => m.type === "trace")
    expect(traces.map((t) => [t.key, t.deviceId, t.trace.turnId]).sort()).toEqual([
      ["device-a", "device-a", 1],
      ["device-a", "device-a", 2],
      ["device-b", "device-b", 1]
    ])
    for (const t of traces) {
      expect(t.trace.session).toBe("Test browser")
      expect(t.trace.mode).toBe("text")
      expect(t.trace.outcome).toBe("completed")
    }
    expect(a.types()).not.toContain("trace")
    expect(b.types()).not.toContain("trace")
    // The same traces are in a later admin snapshot.
    const again = await ScriptedClient.connect({ url: server!.url })
    clients.push(again)
    expect((await again.admin(TEST_ADMIN_PASSWORD)).snapshot.traces).toHaveLength(3)
  })

  it("the phrase tester follows the device it names", async () => {
    const { stt } = await start()
    const admin = await ScriptedClient.connect({ url: server!.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const a = await tab("device-a")
    await a.hello()
    await a.claim()
    const b = await tab("device-b")
    await b.hello()
    await b.claim()
    await untilOpen(stt, 2)
    admin.send({ type: "wake.test", requestId: "w1", on: true, deviceId: "device-b" })
    expect((await admin.waitFor("result", (m) => m.requestId === "w1")).ok).toBe(true)
    stt.emitTo(0, endOfTurn("words on a"))
    stt.emitTo(1, endOfTurn("words on b"))
    await b.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    await a.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    expect(admin.messages.filter((m) => m.type === "wake.heard").map((m) => (m as { text: string }).text)).toEqual(["words on b"])
    admin.send({ type: "wake.test", requestId: "w2", on: true, deviceId: "no-such-device" })
    expect((await admin.waitFor("result", (m) => m.requestId === "w2")).error?.code).toBe("unknown_device")
  })
})
