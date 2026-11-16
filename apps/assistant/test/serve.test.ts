// Serve mode driven by the scripted client, with injected providers (docs/UI-AND-MODULES.md §6.1).
import { endOfTurn, eagerEndOfTurn, interim, speechStarted } from "@pva/core/testing"
import { CloseCode, PROTOCOL_VERSION } from "@pva/protocol"
import { defineModule, type ModuleDefinition } from "@pva/core"
import { Effect } from "effect"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.setConfig({ testTimeout: 20_000 })
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { EngineBuildProblems } from "../src/serve/Engine.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, markedPcm, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer, toneTts } from "./support/serveHarness.ts"

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
/**
 * Protocol 6: every device has its own voice session. These tests are about the tabs of one device (one owner,
 * observers, takeover within the device), so every tab of a test is the same device unless it says otherwise
 * (`serveSessions.test.ts` has several devices).
 */
let deviceId = `dev-${Math.random().toString(36).slice(2)}`
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  deviceId = `dev-${Math.random().toString(36).slice(2)}`
})

const connect = async (options: Partial<Parameters<typeof ScriptedClient.connect>[0]> = {}) => {
  const client = await ScriptedClient.connect({ url: server!.url, deviceId, ...options })
  clients.push(client)
  return client
}

const basic = async (reply: (text: string) => string = (t) => `You said: ${t}.`, extra: Parameters<typeof startTestServer>[0] | object = {}) => {
  const stt = controlledStt()
  const llm = scriptedLlm(reply)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), ...extra })
  return { stt, llm }
}

/** Is `sub` a subsequence of `all`? */
const inOrder = (all: ReadonlyArray<string>, sub: ReadonlyArray<string>) => {
  let i = 0
  for (const x of all) if (x === sub[i]) i++
  return i === sub.length
}

describe("serve: handshake", () => {
  it("hello → welcome with the voice snapshot; the tab starts as an observer; admin data only after login", async () => {
    await basic()
    const client = await connect()
    const welcome = await client.hello()
    expect(welcome.protocol).toBe(PROTOCOL_VERSION)
    expect(welcome.snapshot.role).toBe("observer")
    expect(welcome.snapshot.ownerPresent).toBe(false)
    expect(welcome.snapshot.state).toBe("idle")
    expect(welcome.snapshot.engine).toEqual({ ready: true, state: "ready", voices: [{ name: "sherpa:en_US-lessac-medium", description: "Lessac", isDefault: true }] })
    expect(welcome.snapshot.history).toEqual([])
    expect(Object.keys(welcome.snapshot).sort()).toEqual(["admin", "conversation", "conversations", "device", "engine", "history", "ownerPresent", "role", "setup", "state"])
    const admin = await connect()
    const { snapshot } = await admin.admin(TEST_ADMIN_PASSWORD)
    expect(snapshot.engine.state).toBe("ready")
    expect(snapshot.modules.map((m) => [m.id, m.state])).toEqual([["greeter", "running"]])
    expect(snapshot.sections.map((s) => [s.id, `${s.group}/${s.page?.id}`])).toEqual([
      ["home", "modules/home"],
      ["llm-openai-accounts", "agents/openai-accounts"],
      ["language-model", "agents/provider"],
      ["llm-behaviour", "agents/behaviour"],
      ["stt-engine", "speech/engine"],
      ["stt-timing", "speech/turn-timing"],
      ["stt-mic", "speech/microphone"],
      ["stt-deepgram", "speech/deepgram"],
      ["voices", "voices/overview"],
      ["voice-providers", "voices/providers"],
      ["routing", "agents/routing"],
      ["recordings", "diagnostics/recordings"]
    ])
    expect(snapshot.modules[0]).toMatchObject({ id: "greeter", group: "modules" })
  })

  it("a different protocol version gets an error and close 4400; no hello closes 4401; binary first closes 4402", async () => {
    await basic(undefined, { helloTimeoutMs: 200 })
    const old = await connect()
    old.send({ type: "hello", protocol: PROTOCOL_VERSION + 1, clientId: "client-old-123", resumeOwner: false, frontend: "voice" })
    const error = await old.waitFor("error")
    expect(error.error).toEqual({ code: "bad_message", message: "This page is out of date; reload it" })
    expect((await old.closed).code).toBe(CloseCode.protocolMismatch)

    const silent = await connect()
    expect((await silent.closed).code).toBe(CloseCode.helloTimeout)

    const binary = await connect()
    binary.sendRaw(new Uint8Array(16))
    expect((await binary.closed).code).toBe(CloseCode.badMessage)
  })

  it("rejects a WebSocket from another origin with HTTP 403; serves a 'UI not built' page", async () => {
    await basic()
    await expect(ScriptedClient.connect({ url: server!.url, origin: "http://evil.example" })).rejects.toThrow("HTTP 403")
    const allowed = await connect({ origin: "http://localhost:3000" })
    await allowed.hello()
    const page = await fetch(server!.url)
    expect(page.status).toBe(503)
    expect(await page.text()).toContain("UI not built")
  })
})

describe("serve: a voice turn", () => {
  it("claim, microphone frames reach the recogniser, and the message sequence of §2.5", async () => {
    const { stt } = await basic((t) => `It's sunny in ${t.replace(/\?$/, "").split(" ").at(-1)}, eighteen degrees. Light wind.`)
    const owner = await connect()
    await owner.hello()
    const from = owner.messages.length
    const session = await owner.claim()
    expect(session).toEqual({ type: "session", role: "owner", ownerPresent: true, reason: "claimed" })
    await owner.waitFor("state", (m) => m.state === "listening")
    await owner.streamPcm(markedPcm(200), { realTime: false })
    await sleep(50)
    expect(stt.chunks.some((c) => c.length > 0 && c.every((b) => b === 0x11))).toBe(true)

    stt.emit(speechStarted, interim("what's the"), interim("what's the weather in Paris"), eagerEndOfTurn("What's the weather in Paris?"))
    await owner.waitFor("state", (m) => m.state === "hearing", { from })
    await sleep(30)
    stt.emit(endOfTurn("What's the weather in Paris?"))
    const end = await owner.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    expect(end.outcome).toBe("completed")
    await owner.waitFor("state", (m) => m.state === "listening", { from: owner.messages.indexOf(end) })

    const types = owner.types(from)
    expect(inOrder(types, [
      "session", "state", "transcript", "transcript", "transcript", "turn.start", "state", "assistant.text", "reply.start",
      "state", "assistant.playing", "reply.end", "turn.end", "state"
    ])).toBe(true)
    const texts = owner.messages.slice(from).filter((m) => m.type === "transcript").map((m) => (m as { text: string }).text)
    expect(texts).toEqual(["what's the", "what's the weather in Paris", ""])
    const states = owner.messages.slice(from).filter((m) => m.type === "state").map((m) => (m as { state: string }).state)
    expect(states).toEqual(["listening", "hearing", "thinking", "speaking", "listening"])
    const start = owner.messages.find((m) => m.type === "turn.start")!
    expect(start).toMatchObject({ source: "voice", userText: "What's the weather in Paris?", spoken: true })
    const clauses = owner.messages.filter((m) => m.type === "assistant.text")
    expect(clauses.map((m) => (m as { text: string }).text)).toEqual(["It's sunny in Paris,", "eighteen degrees.", "Light wind."])
    expect(clauses.every((m) => (m as { voice?: string }).voice === "sherpa:en_US-lessac-medium")).toBe(true)
    expect(end.trace.speculative).toBe(true)
    expect(end.trace.marks.playbackStart).toBeDefined()
    expect(end.trace.client).toEqual({ outputLatencyMs: 12, startDelayMs: 0 })
    expect(owner.replySamples.get(end.turnId)).toBe(3 * 10 * 882)
  })

  it("an observer sees the turn but receives no reply audio", async () => {
    const { stt } = await basic()
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    const observer = await connect()
    const welcome = await observer.hello()
    expect(welcome.snapshot.ownerPresent).toBe(true)
    stt.emit(endOfTurn("hello"))
    await observer.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    expect(observer.types()).not.toContain("reply.start")
    expect(observer.replySamples.size).toBe(0)
    expect(observer.types()).toContain("assistant.playing")
  })
})

describe("serve: interruptions", () => {
  it("barge-in: reply.stop, playback.stopped, turn.end interrupted; history keeps only what played", async () => {
    const { stt } = await basic(() => "First clause here. Second clause here. Third clause here.")
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    stt.emit(endOfTurn("tell me"))
    await owner.waitFor("assistant.playing", (m) => m.clause === 0, { timeoutMs: 10_000 })
    await sleep(150) // well inside the first 400 ms clause
    stt.emit(speechStarted)
    await owner.waitFor("reply.stop")
    const end = await owner.waitFor("turn.end")
    expect(end.outcome).toBe("interrupted")
    await owner.waitFor("state", (m) => m.state === "hearing", { from: owner.messages.indexOf(end) })

    const late = await connect()
    const welcome = await late.hello()
    expect(welcome.snapshot.history).toEqual([
      { role: "user", text: "tell me" },
      { role: "assistant", text: "First clause here.", interrupted: true, tools: [] }
    ])
    const admin = await connect()
    expect((await admin.admin(TEST_ADMIN_PASSWORD)).snapshot.traces.map((t) => t.outcome)).toEqual(["interrupted"])
  })

  it("Stop from an observer interrupts the owner's reply through reply.stop", async () => {
    const { stt } = await basic(() => "One long clause. Another long clause. And a third one.")
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    const observer = await connect()
    await observer.hello()
    stt.emit(endOfTurn("talk"))
    const start = await observer.waitFor("turn.start", () => true, { timeoutMs: 10_000 })
    await owner.waitFor("assistant.playing")
    observer.send({ type: "interrupt", turnId: start.turnId })
    await owner.waitFor("reply.stop")
    expect((await observer.waitFor("turn.end")).outcome).toBe("interrupted")
  })

  it("Stop in the owner tab: the player is already silent; the turn ends interrupted with the reported count", async () => {
    const { stt } = await basic(() => "One long clause. Another long clause. And a third one.")
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    stt.emit(endOfTurn("talk"))
    await owner.waitFor("assistant.playing", () => true, { timeoutMs: 10_000 })
    await sleep(100)
    owner.pressStop()
    const end = await owner.waitFor("turn.end")
    expect(end.outcome).toBe("interrupted")
  })

  it("a typed message taken just before Stop: kept in history unanswered; the next request carries it before the new one", async () => {
    const stt = controlledStt()
    const llm = scriptedLlm((t) => `Reply to ${t}.`, { firstTokenMs: 400 })
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }) })
    const owner = await connect()
    await owner.hello()
    owner.send({ type: "text.send", requestId: "t1", text: "first", speak: false })
    const start = await owner.waitFor("turn.start", () => true, { timeoutMs: 10_000 })
    owner.send({ type: "interrupt", turnId: start.turnId })
    expect((await owner.waitFor("turn.end", (m) => m.turnId === start.turnId)).outcome).toBe("interrupted")
    const from = owner.messages.length
    owner.send({ type: "text.send", requestId: "t2", text: "second", speak: false })
    expect((await owner.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })).outcome).toBe("completed")
    // The owner did send it, so it stays (as for any turn stopped before its reply); it has no answer.
    const later = await connect()
    const welcome = await later.hello()
    expect(welcome.snapshot.history.map((h) => [h.role, h.text])).toEqual([
      ["user", "first"],
      ["user", "second"],
      ["assistant", "Reply to second."]
    ])
    // The model sees both, in order (the adapters merge consecutive user messages for APIs that need alternation).
    expect(llm.requests.at(-1)!.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "first"], ["user", "second"]])
  })

  it("conversation.new: stops the turn, empties the history, new id for every tab of the device", async () => {
    const stt = controlledStt()
    const llm = scriptedLlm((t) => `Reply to ${t}.`, { firstTokenMs: 400 })
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }) })
    const owner = await connect()
    const first = await owner.hello()
    const other = await connect()
    await other.hello()
    owner.send({ type: "text.send", requestId: "t1", text: "first", speak: false })
    expect((await owner.waitFor("turn.end", () => true, { timeoutMs: 10_000 })).outcome).toBe("completed")
    owner.send({ type: "text.send", requestId: "t2", text: "second", speak: false })
    const start = await owner.waitFor("turn.start", (m) => m.userText === "second", { timeoutMs: 10_000 })
    owner.send({ type: "conversation.new", requestId: "n1" })
    expect((await owner.waitFor("result", (m) => m.requestId === "n1")).ok).toBe(true)
    expect((await owner.waitFor("turn.end", (m) => m.turnId === start.turnId, { from: owner.messages.indexOf(start) })).outcome).toBe("interrupted")
    const told = await other.waitFor("conversation")
    expect(told.reason).toBe("new")
    expect(told.id).not.toBe(first.snapshot.conversation.id)
    const later = await connect()
    const welcome = await later.hello()
    expect(welcome.snapshot.history).toEqual([])
    expect(welcome.snapshot.conversation.id).toBe(told.id)
    // The next turn starts from nothing.
    const from = owner.messages.length
    owner.send({ type: "text.send", requestId: "t3", text: "third", speak: false })
    expect((await owner.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })).outcome).toBe("completed")
    expect(llm.requests.at(-1)!.messages.map((m: any) => [m.role, m.content])).toEqual([["user", "third"]])
  })

  it("claiming again while already the owner does not stop the reply", async () => {
    const { stt } = await basic(() => "Short reply here.")
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    stt.emit(endOfTurn("hi"))
    await owner.waitFor("assistant.playing", () => true, { timeoutMs: 10_000 })
    await owner.claim()
    expect((await owner.waitFor("turn.end", () => true, { from: 0, timeoutMs: 10_000 })).outcome).toBe("completed")
    expect(owner.types()).not.toContain("reply.stop")
  })

  it("a stale interrupt (another turn id) is ignored", async () => {
    const { stt } = await basic(() => "Short.")
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    stt.emit(endOfTurn("hi"))
    const start = await owner.waitFor("turn.start", () => true, { timeoutMs: 10_000 })
    owner.send({ type: "interrupt", turnId: start.turnId + 100 })
    expect((await owner.waitFor("turn.end", () => true, { timeoutMs: 10_000 })).outcome).toBe("completed")
  })
})

describe("serve: typed messages", () => {
  it("unspoken from an observer: result, turn.start (spoken false), raw text deltas, turn.end", async () => {
    await basic((t) => `Typed reply to ${t}.`)
    const observer = await connect()
    await observer.hello()
    const from = observer.messages.length
    observer.send({ type: "text.send", requestId: "r1", text: "hello there", speak: true })
    expect(await observer.waitFor("result")).toEqual({ type: "result", requestId: "r1", ok: true })
    const start = await observer.waitFor("turn.start")
    expect(start).toMatchObject({ source: "text", userText: "hello there", spoken: false })
    const end = await observer.waitFor("turn.end")
    expect(end.outcome).toBe("completed")
    const deltas = observer.messages.slice(from).filter((m) => m.type === "assistant.text")
    expect(deltas.every((m) => (m as { clause: unknown }).clause === null)).toBe(true)
    expect(deltas.map((m) => (m as { text: string }).text).join("")).toBe("Typed reply to hello there.")
    expect(observer.types(from)[0]).toBe("result")
  })

  it("spoken from the owner; and refused with engine_failed when the engines are down", async () => {
    await basic((t) => `Spoken reply to ${t}.`)
    const owner = await connect()
    await owner.hello()
    await owner.claim()
    owner.send({ type: "text.send", requestId: "r2", text: "say it", speak: true })
    const start = await owner.waitFor("turn.start", () => true, { timeoutMs: 10_000 })
    expect(start.spoken).toBe(true)
    await owner.waitFor("reply.start")
    expect((await owner.waitFor("turn.end", () => true, { timeoutMs: 10_000 })).outcome).toBe("completed")
    await server!.close()

    server = await startTestServer({
      build: Effect.fail(new EngineBuildProblems({ problems: [{ stage: "language model (LLM_PROVIDER)", message: "ANTHROPIC_API_KEY is not set" }] }))
    })
    const tab = await connect()
    const welcome = await tab.hello()
    expect(welcome.snapshot.engine).toEqual({ ready: false, state: "failed", voices: [] })
    const admin = await connect()
    expect((await admin.admin(TEST_ADMIN_PASSWORD)).snapshot.engine).toMatchObject({
      state: "failed",
      problems: [{ stage: "language model (LLM_PROVIDER)", message: "ANTHROPIC_API_KEY is not set" }]
    })
    tab.send({ type: "text.send", requestId: "r3", text: "anyone?", speak: false })
    const refused = await tab.waitFor("result")
    expect(refused.ok).toBe(false)
    expect(refused.error?.code).toBe("engine_failed")
  })
})

describe("serve: modules and settings", () => {
  it("enable / configure / disable from tab A: result to A, module.changed to A and B; saved to disk", async () => {
    await basic()
    const a = await connect()
    const b = await connect()
    await a.admin(TEST_ADMIN_PASSWORD)
    const welcomeB = await b.admin(TEST_ADMIN_PASSWORD)
    const revision = welcomeB.snapshot.modules[0]!.revision

    a.send({ type: "module.configure", requestId: "c1", moduleId: "greeter", patch: { values: { greeting: "hoi" }, secrets: { token: "s3cret" } } })
    expect(await a.waitFor("result", (m) => m.requestId === "c1")).toEqual({ type: "result", requestId: "c1", ok: true })
    const changed = await b.waitFor("module.changed", (m) => m.module.settings.values.greeting === "hoi")
    expect(changed.module.revision).toBeGreaterThan(revision)
    expect(changed.module.settings.secrets.token).toEqual({ set: true, source: "store" })
    expect(JSON.stringify(changed)).not.toContain("s3cret")
    await a.waitFor("module.changed", (m) => m.module.settings.values.greeting === "hoi", { from: 0 })

    a.send({ type: "module.configure", requestId: "c2", moduleId: "greeter", patch: { values: { greeting: "bad" }, secrets: {} } })
    const invalid = await a.waitFor("result", (m) => m.requestId === "c2")
    expect(invalid.error).toMatchObject({ code: "invalid_settings", fieldErrors: [{ key: "greeting", message: "Not this one" }] })

    // A capability is switched on and off per assistant (docs/ASSISTANTS.md §2.6): its own switch is refused.
    b.send({ type: "module.disable", requestId: "d1", moduleId: "greeter" })
    expect((await b.waitFor("result", (m) => m.requestId === "d1")).error?.code).toBe("not_allowed")
    a.send({ type: "module.enable", requestId: "e1", moduleId: "nope" })
    expect((await a.waitFor("result", (m) => m.requestId === "e1")).error?.code).toBe("unknown_module")

    const saved = JSON.parse(readFileSync(join(server!.dataDir, "settings.json"), "utf8"))
    expect(saved.modules.greeter).toEqual({ enabled: true, settings: { greeting: "hoi" } })
    const secrets = join(server!.dataDir, "secrets.json")
    expect(JSON.parse(readFileSync(secrets, "utf8")).modules.greeter).toEqual({ token: "s3cret" })
    expect(statSync(secrets).mode & 0o777).toBe(0o600)
  })

  it("a module change applies from the next turn's system prompt", async () => {
    const { stt, llm } = await basic(() => "Ok.")
    // Typed on a voice page (protocol 6: admin connections have no voice session), configured on the admin page.
    const owner = await connect()
    await owner.hello()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    owner.send({ type: "text.send", requestId: "t1", text: "one", speak: false })
    await owner.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    admin.send({ type: "module.configure", requestId: "c1", moduleId: "greeter", patch: { values: { greeting: "hoi" }, secrets: {} } })
    await admin.waitFor("result", (m) => m.requestId === "c1")
    const from = owner.messages.length
    owner.send({ type: "text.send", requestId: "t2", text: "two", speak: false })
    await owner.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    expect(llm.requests[0]!.system).toContain("Greet with hello.")
    expect(llm.requests[1]!.system).toContain("Greet with hoi.")
    void stt
  })

  it("settings.update: section.changed to every tab, reloadPending for a reload field; engine.reload keeps the history", async () => {
    await basic((t) => `Reply to ${t}.`)
    const a = await connect()
    const b = await connect()
    await a.admin(TEST_ADMIN_PASSWORD)
    await b.admin(TEST_ADMIN_PASSWORD)
    // Typed on a voice page: admin connections have no voice session (protocol 6).
    const voice = await connect()
    await voice.hello()
    voice.send({ type: "text.send", requestId: "t1", text: "before reload", speak: false })
    await voice.waitFor("turn.end", () => true, { timeoutMs: 10_000 })

    a.send({ type: "settings.update", requestId: "s1", sectionId: "stt-timing", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 500 }, secrets: {} } })
    expect((await a.waitFor("result", (m) => m.requestId === "s1")).ok).toBe(true)
    const section = await b.waitFor("section.changed")
    expect(section.section.form.values.STT_SHERPA_FINAL_SILENCE_MS).toBe(500)
    const pending = (await b.waitFor("engine", (m) => m.engine.reloadPending)).engine
    expect(pending.state).toBe("ready")
    expect(pending.reloadPendingFor).toEqual(["speech/turn-timing"])

    a.send({ type: "settings.update", requestId: "s2", sectionId: "stt-timing", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 5 }, secrets: {} } })
    expect((await a.waitFor("result", (m) => m.requestId === "s2")).error?.code).toBe("invalid_settings")

    const from = b.messages.length
    a.send({ type: "engine.reload", requestId: "r1" })
    expect((await a.waitFor("result", (m) => m.requestId === "r1", { timeoutMs: 10_000 })).ok).toBe(true)
    await b.waitFor("engine", (m) => m.engine.state === "ready", { from })
    const engines = b.messages.slice(from).filter((m) => m.type === "engine").map((m) => (m as { engine: { state: string; reloadPending: boolean; reloadPendingFor?: ReadonlyArray<string> } }).engine)
    // The resource pool's rebuild during the reload announces its own changes (more `reloading` statuses).
    expect(engines.map((e) => e.state).filter((s, i, all) => s !== all[i - 1])).toEqual(["reloading", "ready"])
    expect(engines.at(-1)!.reloadPending).toBe(false)
    expect(engines.at(-1)!.reloadPendingFor).toEqual([])

    const late = await connect()
    expect((await late.hello()).snapshot.history).toEqual([
      { role: "user", text: "before reload" },
      { role: "assistant", text: "Reply to before reload.", interrupted: false, tools: [] }
    ])
    const saved = JSON.parse(readFileSync(join(server!.dataDir, "settings.json"), "utf8"))
    expect(saved).toMatchObject({
      version: 4,
      revision: expect.any(Number),
      assistant: { STT_SHERPA_FINAL_SILENCE_MS: 500 },
      deviceTypes: { "web-voice": { interruptMode: "instant" } },
      devices: expect.anything()
    })
    expect(Object.keys(saved.assistant)).toEqual(["STT_SHERPA_FINAL_SILENCE_MS"])
    // The flat key that became per assistant is mirrored into the migrated assistant.
    expect(saved.assistants.byId.assistant.hearing.finalSilenceMs).toBe(500)
  })
})

describe("serve: choosing the speech recognition model", () => {
  it("lists the presets with descriptions and how to download them; saving a preset whose files are missing is refused", async () => {
    const emptyModels = mkdtempSync(join(tmpdir(), "pva-no-models-"))
    await basic(undefined, { env: { STT_SHERPA_MODEL_DIR: emptyModels } })
    const a = await connect()
    const sections = (await a.admin(TEST_ADMIN_PASSWORD)).snapshot.sections
    const fields = sections.flatMap((s) => s.form.fields)
    const model = fields.find((f) => f.key === "STT_SHERPA_MODEL")!
    expect(model.type).toBe("choice")
    expect(model.visibleWhen).toEqual({ key: "STT_PROVIDER", in: ["sherpa"] })
    const options = (model as { options: ReadonlyArray<{ value: string; description?: string; tags?: ReadonlyArray<string> }> }).options
    expect(options.map((o) => o.value)).toContain("parakeet-v2")
    expect(options.find((o) => o.value === "whisper-turbo")!.description).toMatch(/99 languages/)
    expect(options.find((o) => o.value === "whisper-turbo")!.tags).toEqual(["local", "not-downloaded"])
    expect((options.find((o) => o.value === "whisper-turbo") as { download?: unknown }).download).toEqual({ tool: "stt-models", target: "whisper-turbo", sizeMb: 565 })
    for (const key of ["STT_SHERPA_LANGUAGE", "STT_SHERPA_VAD_THRESHOLD", "STT_SHERPA_AGC", "STT_SHERPA_EAGER_SILENCE_MS", "STT_SHERPA_FINAL_SILENCE_MS", "RECORD_HEARD_AUDIO"]) {
      const field = fields.find((f) => f.key === key)
      expect(field?.description, key).toBeTruthy()
    }
    a.send({ type: "settings.update", requestId: "m1", sectionId: "stt-engine", patch: { values: { STT_SHERPA_MODEL: "whisper-turbo" }, secrets: {} } })
    const result = await a.waitFor("result", (m) => m.requestId === "m1")
    expect(result.ok).toBe(false)
    expect(result.error?.fieldErrors?.[0]?.key).toBe("STT_SHERPA_MODEL")
    expect(result.error?.message).toContain("is not downloaded yet: download it first (565 MB)")
  })

  it("a reload whose recogniser files are missing is refused before the running engines stop", async () => {
    const emptyModels = mkdtempSync(join(tmpdir(), "pva-no-models-"))
    const { stt } = await basic((t) => `Reply to ${t}.`, { env: { STT_SHERPA_MODEL_DIR: emptyModels }, checkModelsBeforeReload: true })
    const a = await connect()
    await a.admin(TEST_ADMIN_PASSWORD)
    const from = a.messages.length
    a.send({ type: "engine.reload", requestId: "r1" })
    const result = await a.waitFor("result", (m) => m.requestId === "r1", { timeoutMs: 10_000 })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain("the running ones are kept")
    expect(result.error?.message).toContain("download-models parakeet-v2")
    expect(a.messages.slice(from).filter((m) => m.type === "engine")).toEqual([])
    // Still listening: a turn is answered by the engines that kept running (typed on a voice page).
    const voice = await connect()
    await voice.hello()
    voice.send({ type: "text.send", requestId: "t1", text: "still there?", speak: false })
    const end = await voice.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    expect(end.type).toBe("turn.end")
    void stt
  })
})

describe("serve: ownership", () => {
  it("takeover mid-reply: the old owner gets reply.stop and session taken_over; the new owner gets claimed", async () => {
    const { stt } = await basic(() => "One long clause. Another long clause. And a third one.")
    const a = await connect()
    await a.hello()
    await a.claim()
    const b = await connect()
    await b.hello()
    stt.emit(endOfTurn("talk"))
    await a.waitFor("assistant.playing", () => true, { timeoutMs: 10_000 })
    await b.claim()
    // The previous owner first gets reply.stop, then its new role.
    await a.waitFor("reply.stop")
    expect(await a.waitFor("session", (m) => m.reason === "taken_over")).toEqual({ type: "session", role: "observer", ownerPresent: true, reason: "taken_over" })
    // The failed turn may end before or after B's own session message.
    const end = await b.waitFor("turn.end", () => true, { from: 0 })
    expect(["interrupted", "failed"]).toContain(end.outcome)
    expect(b.types()).not.toContain("reply.start")
  })

  it("takeover between a clause start and the next progress report: the old owner's final count still reaches history", async () => {
    const { stt } = await basic(() => "One long clause. Another long clause. And a third one.")
    // A reports playback.started and then nothing until asked (its next periodic report is far away).
    const a = await connect({ player: { progressMs: 60_000 } })
    await a.hello()
    await a.claim()
    const b = await connect()
    await b.hello()
    stt.emit(endOfTurn("talk"))
    await a.waitFor("assistant.playing", (m) => m.clause === 0, { timeoutMs: 10_000 })
    await sleep(600) // the second 400 ms clause is now playing in A; the server has not been told
    await b.claim()
    await a.waitFor("reply.stop")
    const end = await b.waitFor("turn.end", () => true, { from: 0 })
    expect(["interrupted", "failed"]).toContain(end.outcome)
    const late = await connect()
    const welcome = await late.hello()
    const said = welcome.snapshot.history.find((h) => h.role === "assistant")
    expect(said?.text).toBe("One long clause. Another long clause.")
  })

  it("reconnect with resumeOwner gets the audio back if nobody claimed it since; otherwise it is an observer", async () => {
    await basic()
    const a = await connect()
    await a.hello()
    await a.claim()
    const watcher = await connect()
    await watcher.hello()
    a.drop()
    await watcher.waitFor("session", (m) => m.reason === "owner_disconnected")
    const again = await connect({ clientId: a.clientId })
    const welcome = await again.hello({ resumeOwner: true })
    expect(welcome.snapshot.role).toBe("owner")
    expect(await again.waitFor("session")).toEqual({ type: "session", role: "owner", ownerPresent: true, reason: "resumed" })

    await watcher.claim()
    again.drop()
    const third = await connect({ clientId: a.clientId })
    expect((await third.hello({ resumeOwner: true })).snapshot.role).toBe("observer")
  })

  it("after a restart (nobody has owned the audio yet), a reconnect with resumeOwner gets the audio back", async () => {
    await basic()
    const page = await connect({ clientId: "client-from-before-the-restart" })
    const welcome = await page.hello({ resumeOwner: true })
    expect(welcome.snapshot.role).toBe("owner")
    expect(await page.waitFor("session")).toEqual({ type: "session", role: "owner", ownerPresent: true, reason: "resumed" })
    // Once somebody owned it, only that client resumes.
    page.drop()
    const other = await connect({ clientId: "another-tab" })
    expect((await other.hello({ resumeOwner: true })).snapshot.role).toBe("observer")
  })

  it("owner-only messages from an observer are ignored with one not_owner error", async () => {
    await basic()
    const observer = await connect()
    await observer.hello()
    observer.send({ type: "mic.state", live: false })
    observer.send({ type: "audio.release" })
    await sleep(50)
    expect(observer.messages.filter((m) => m.type === "error").map((m) => (m as { error: { code: string } }).error.code)).toEqual(["not_owner"])
    observer.send({ type: "ping", id: 7 })
    expect(await observer.waitFor("pong")).toEqual({ type: "pong", id: 7 })
  })
})

describe("serve: provisional final counts (playback.stopped exact: false)", () => {
  it("barge-in: a provisional count past the next clause, then the exact one: history holds what the exact count says", async () => {
    const { stt } = await basic(() => "First clause here. Second clause here. Third clause here.")
    // The page's first answer overstates (500 ms more than played: into the second clause); the exact one follows.
    const owner = await connect({ player: { provisionalStop: { count: (played, rate) => played + Math.round(rate / 2), exactAfterMs: 80 } } })
    await owner.hello()
    await owner.claim()
    stt.emit(endOfTurn("tell me"))
    await owner.waitFor("assistant.playing", (m) => m.clause === 0, { timeoutMs: 10_000 })
    await sleep(150)
    stt.emit(speechStarted)
    await owner.waitFor("reply.stop")
    const end = await owner.waitFor("turn.end")
    expect(end.outcome).toBe("interrupted")
    const late = await connect()
    const welcome = await late.hello()
    expect(welcome.snapshot.history).toEqual([
      { role: "user", text: "tell me" },
      { role: "assistant", text: "First clause here.", interrupted: true, tools: [] }
    ])
  })

  it("takeover: a provisional count short of the second clause, then the exact one: the old owner's exact count reaches history", async () => {
    const { stt } = await basic(() => "One long clause. Another long clause. And a third one.")
    const a = await connect({ player: { progressMs: 60_000, provisionalStop: { count: (_played, rate) => Math.round(rate / 10), exactAfterMs: 80 } } })
    await a.hello()
    await a.claim()
    const b = await connect()
    await b.hello()
    stt.emit(endOfTurn("talk"))
    await a.waitFor("assistant.playing", (m) => m.clause === 0, { timeoutMs: 10_000 })
    await sleep(600) // the second 400 ms clause is playing in A
    await b.claim()
    await a.waitFor("reply.stop")
    const end = await b.waitFor("turn.end", () => true, { from: 0 })
    expect(["interrupted", "failed"]).toContain(end.outcome)
    const late = await connect()
    const welcome = await late.hello()
    expect(welcome.snapshot.history.find((h) => h.role === "assistant")?.text).toBe("One long clause. Another long clause.")
  })
})

describe("serve: playback stall", () => {
  it("a browser that stops reporting: reply.stop, playback_timeout error, the turn fails", async () => {
    const stt = controlledStt()
    const llm = scriptedLlm(() => "Short reply.")
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm, tts: toneTts({ millisPerClause: 120 }) }), stallMs: 400 })
    const owner = await connect({ player: { enabled: false } })
    await owner.hello()
    await owner.claim()
    stt.emit(endOfTurn("hello"))
    await owner.waitFor("reply.end", () => true, { timeoutMs: 10_000 })
    await owner.waitFor("reply.stop", () => true, { timeoutMs: 3_000 })
    const error = await owner.waitFor("error", (m) => m.error.code === "playback_timeout")
    expect(error.error.turnId).toBeGreaterThan(0)
    expect((await owner.waitFor("turn.end")).outcome).toBe("failed")
  })
})

describe("serve: settings that may come from two saves (a damaged journal after a half-applied save)", () => {
  it("every page sees why in the engine bar; engines and modules stay stopped until a save, which starts them", async () => {
    const { acquireDataDirLockSync, releaseDataDirLock } = await import("../src/serve/DataDirLock.ts")
    const { loadSettingsStore } = await import("../src/serve/SettingsStore.ts")
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const { lock } = acquireDataDirLockSync(dataDir)
    const before = await Effect.runPromise(loadSettingsStore(dataDir, { lock }))
    await Effect.runPromise(before.saveModule("greeter", { enabled: true, settings: { greeting: "hello" }, secrets: { token: "t1" } }))
    // A save that replaces secrets.json and stops before settings.json (its rollback fails too) ...
    const crashing = await Effect.runPromise(loadSettingsStore(dataDir, { lock, beforeStep: (step) => {
      if (step === "settings" || step === "rollback") throw new Error("crash")
    } }))
    await Effect.runPromise(Effect.result(crashing.saveModule("greeter", { enabled: true, settings: { greeting: "hoi" }, secrets: { token: "t2" } })))
    releaseDataDirLock(lock)
    // ... and whose journal is then unreadable.
    writeFileSync(join(dataDir, "transaction.json"), "{damaged")
    const llm = scriptedLlm((t) => `Reply to ${t}.`)
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: llm.llm }), dataDir })
    const page = await connect()
    const welcome = await page.admin(TEST_ADMIN_PASSWORD)
    expect(welcome.snapshot.engine.state).toBe("failed")
    expect(welcome.snapshot.engine.problems).toHaveLength(1)
    expect(welcome.snapshot.engine.problems[0]!.stage).toBe("settings")
    expect(welcome.snapshot.engine.problems[0]!.message).toContain("may come from two different saves")
    expect(welcome.snapshot.modules.find((m) => m.id === "greeter")).toMatchObject({ enabled: true, state: "disabled" })
    // Try again (engine.reload) is answered with the same reason and builds nothing.
    page.send({ type: "engine.reload", requestId: "r1" })
    const refused = await page.waitFor("result", (m) => m.requestId === "r1")
    expect(refused.ok).toBe(false)
    expect(refused.error?.message).toContain("two different saves")
    // The owner checks the settings and saves: the engines and the enabled module start.
    page.send({ type: "settings.update", requestId: "s1", sectionId: "stt-timing", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 600 }, secrets: {} } })
    expect((await page.waitFor("result", (m) => m.requestId === "s1")).ok).toBe(true)
    await page.waitFor("engine", (m) => m.engine.state === "ready", { from: 0, timeoutMs: 10_000 })
    await page.waitFor("module.changed", (m) => m.module.id === "greeter" && m.module.state === "running", { from: 0, timeoutMs: 10_000 })
    const late = await connect()
    expect((await late.hello()).snapshot.engine.ready).toBe(true)
    const admin = await connect()
    expect((await admin.admin(TEST_ADMIN_PASSWORD)).snapshot.engine).toMatchObject({ state: "ready", problems: [] })
  })
})

describe("serve: unblocking through every kind of save (fifth review)", () => {
  /** A second module, so enabling or disabling one shows that the other enabled modules start too. */
  const waver: ModuleDefinition<any> = defineModule({
    id: "waver",
    name: "Waver",
    description: "Waves.",
    settings: {},
    start: () => Effect.succeed({ instructions: "Wave." })
  })

  /** A data directory whose settings and keys may come from two saves, with greeter and waver enabled. */
  const blockedDir = async () => {
    const { acquireDataDirLockSync, releaseDataDirLock } = await import("../src/serve/DataDirLock.ts")
    const { loadSettingsStore } = await import("../src/serve/SettingsStore.ts")
    const dataDir = mkdtempSync(join(tmpdir(), "pva-serve-"))
    const { lock } = acquireDataDirLockSync(dataDir)
    const before = await Effect.runPromise(loadSettingsStore(dataDir, { lock }))
    await Effect.runPromise(before.saveModule("waver", { enabled: true, settings: {}, secrets: {} }))
    await Effect.runPromise(before.saveModule("greeter", { enabled: true, settings: { greeting: "hello" }, secrets: { token: "t1" } }))
    const crashing = await Effect.runPromise(loadSettingsStore(dataDir, { lock, beforeStep: (step) => {
      if (step === "settings" || step === "rollback") throw new Error("crash")
    } }))
    await Effect.runPromise(Effect.result(crashing.saveModule("greeter", { enabled: true, settings: { greeting: "hoi" }, secrets: { token: "t2" } })))
    releaseDataDirLock(lock)
    writeFileSync(join(dataDir, "transaction.json"), "{damaged")
    return dataDir
  }

  const saves: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, { enabled: boolean; state: string }>]> = [
    ["an assistant section", { type: "settings.update", sectionId: "stt-timing", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 600 }, secrets: {} } }, {
      greeter: { enabled: true, state: "running" },
      waver: { enabled: true, state: "running" }
    }],
    ["a section secret", { type: "settings.update", sectionId: "language-model", patch: { values: {}, secrets: { ANTHROPIC_API_KEY: "sk-test" } } }, {
      greeter: { enabled: true, state: "running" },
      waver: { enabled: true, state: "running" }
    }],
    ["a module's settings", { type: "module.configure", moduleId: "greeter", patch: { values: { greeting: "hallo" }, secrets: {} } }, {
      greeter: { enabled: true, state: "running" },
      waver: { enabled: true, state: "running" }
    }],
    ["a module secret", { type: "module.configure", moduleId: "greeter", patch: { values: {}, secrets: { token: "t3" } } }, {
      greeter: { enabled: true, state: "running" },
      waver: { enabled: true, state: "running" }
    }],
    ["a module enable", { type: "module.enable", moduleId: "greeter" }, {
      greeter: { enabled: true, state: "running" },
      waver: { enabled: true, state: "running" }
    }],
    ["a module disable", { type: "module.disable", moduleId: "greeter" }, {
      greeter: { enabled: false, state: "disabled" },
      waver: { enabled: true, state: "running" }
    }]
  ]

  for (const [what, request, expected] of saves) {
    it(`saving ${what} starts the engines and every enabled module`, async () => {
      const dataDir = await blockedDir()
      const llm = scriptedLlm((t) => `Reply to ${t}.`)
      server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: llm.llm }), dataDir, catalog: [greeterModule, waver] })
      const page = await connect()
      const welcome = await page.admin(TEST_ADMIN_PASSWORD)
      expect(welcome.snapshot.engine.state).toBe("failed")
      page.send({ ...request, requestId: "s1" } as never)
      expect((await page.waitFor("result", (m) => m.requestId === "s1")).ok).toBe(true)
      await page.waitFor("engine", (m) => m.engine.state === "ready", { from: 0, timeoutMs: 10_000 })
      const settled = async () => {
        for (let i = 0; i < 100; i++) {
          const modules = server!.handle.host.modules()
          if (Object.entries(expected).every(([id, want]) => {
            const m = modules.find((x) => x.id === id)
            return m?.enabled === want.enabled && m.state === want.state
          })) return modules
          await sleep(20)
        }
        return server!.handle.host.modules()
      }
      const modules = await settled()
      for (const [id, want] of Object.entries(expected)) expect(modules.find((m) => m.id === id), id).toMatchObject(want)
    })
  }

  /** A build that counts its calls; each waits for `release()` (so a build can be held in progress). */
  const heldBuild = () => {
    const llm = scriptedLlm((t) => `Reply to ${t}.`)
    const inner = fakeBuild({ stt: controlledStt().stt, llm: llm.llm })
    let builds = 0
    let open: () => void = () => {}
    let gate = new Promise<void>((resolve) => (open = resolve))
    const build = Effect.suspend(() => {
      builds++
      return Effect.andThen(Effect.promise(() => gate), inner)
    })
    return {
      build,
      builds: () => builds,
      release: () => {
        open()
        gate = Promise.resolve()
      }
    }
  }

  it("sixth review: an unblock and the owner's reload overlapping build the engines once (reload while the unblock's build runs)", async () => {
    const dataDir = await blockedDir()
    const held = heldBuild()
    server = await startTestServer({ build: held.build, dataDir, catalog: [greeterModule, waver] })
    const page = await connect()
    await page.admin(TEST_ADMIN_PASSWORD)
    page.send({ type: "module.configure", moduleId: "greeter", patch: { values: { greeting: "hallo" }, secrets: {} }, requestId: "s1" } as never)
    expect((await page.waitFor("result", (m) => m.requestId === "s1")).ok).toBe(true)
    page.send({ type: "engine.reload", requestId: "r1" })
    const reload = await page.waitFor("result", (m) => m.requestId === "r1", { from: 0 })
    expect(reload.ok ? "ok" : reload.error?.code).toBe("busy")
    expect(held.builds()).toBe(1)
    held.release()
    await page.waitFor("engine", (m) => m.engine.state === "ready", { from: 0, timeoutMs: 10_000 })
    await sleep(300) // several retry intervals (25 ms)
    expect(held.builds()).toBe(1)
    expect(server.handle.engine.status().state).toBe("ready")
  })

  it("sixth review: a reload sent together with the unblocking save never leads to a second build", async () => {
    for (let round = 0; round < 5; round++) {
      const dataDir = await blockedDir()
      const held = heldBuild()
      server = await startTestServer({ build: held.build, dataDir, catalog: [greeterModule, waver] })
      const page = await connect()
      await page.admin(TEST_ADMIN_PASSWORD)
      page.send({ type: "settings.update", sectionId: "stt-timing", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 600 }, secrets: {} }, requestId: "s1" } as never)
      page.send({ type: "engine.reload", requestId: "r1" })
      await page.waitFor("result", (m) => m.requestId === "s1", { from: 0 })
      await page.waitFor("result", (m) => m.requestId === "r1", { from: 0 })
      held.release()
      await page.waitFor("engine", (m) => m.engine.state === "ready", { from: 0, timeoutMs: 10_000 })
      await sleep(200)
      expect(held.builds(), `round ${round}`).toBe(1)
      await server.close()
      server = undefined
    }
  })
})
