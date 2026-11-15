// Protocol 5 on the server (docs/FRONTENDS-AND-ACTIVATION.md): admin password and sessions, role-shaped data,
// front-end kinds and devices with their profiles, the wake gate in serve mode, per-device voice and interrupt
// mode. Driven by the scripted client against the real server with injected providers.
import { endOfTurn, interim, speechStarted } from "@pva/core/testing"
import { type ClientMessage, type ServerMessage, type ServerMessageType, WEB_VOICE_KIND } from "@pva/protocol"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ADMIN_ONLY } from "../src/serve/SessionHub.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer, toneTts } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 20_000 })

let servers: Array<TestServer> = []
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const s of servers.splice(0)) await s.close()
})

type StartOptions = Partial<Parameters<typeof startTestServer>[0]>

const start = async (extra: StartOptions = {}) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `You said: ${t}.`)
  const server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), ...extra })
  servers.push(server)
  return { server, stt, llm }
}

const connect = async (server: TestServer, options: { readonly deviceId?: string } = {}) => {
  const client = await ScriptedClient.connect({ url: server.url, ...options })
  clients.push(client)
  return client
}

const voicePage = async (server: TestServer, options: { readonly deviceId?: string } = {}) => {
  const client = await connect(server, options)
  const welcome = await client.hello()
  return { client, welcome }
}

const adminPage = async (server: TestServer) => {
  const client = await connect(server)
  const logged = await client.admin(TEST_ADMIN_PASSWORD)
  return { client, ...logged }
}

type WithoutId<M> = M extends unknown ? Omit<M, "requestId"> : never
type RequestInput = WithoutId<Extract<ClientMessage, { readonly requestId: string }>>
let seq = 0
const request = async (client: ScriptedClient, message: RequestInput) => {
  const requestId = `f${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from })
}

/** Wait until the admin page's device list has this device (its record was saved). */
const deviceKnown = (admin: ScriptedClient, id: string) =>
  admin.waitFor("devices", (m) => m.devices.some((d) => d.id === id), { from: 0 })

const profileOf = (client: ScriptedClient, pred: (m: Extract<ServerMessage, { type: "device.profile" }>) => boolean) =>
  client.waitFor("device.profile", pred, { from: 0 })

// ---------------------------------------------------------------------------

describe("admin password and sessions", () => {
  it("unset or shorter than 8 characters: admin is disabled; login is refused and says how to enable it", async () => {
    for (const adminPassword of ["", "short"]) {
      const { server } = await start({ adminPassword })
      const page = await connect(server)
      const welcome = await page.hello({ frontend: "admin" })
      expect(welcome.snapshot.admin).toEqual({ enabled: false, loggedIn: false })
      expect(welcome.snapshot.device).toBeUndefined()
      const { result } = await page.login(adminPassword === "" ? "anything at all" : "short")
      expect(result).toMatchObject({ ok: false, error: { code: "admin_required", message: expect.stringContaining("PVA_ADMIN_PASSWORD") } })
      expect(page.types()).not.toContain("admin.snapshot")
    }
  })

  it("login: a token and its end, admin.state, then admin.snapshot; a wrong password is bad_password; never on a voice page", async () => {
    const { server } = await start()
    const page = await connect(server)
    const welcome = await page.hello({ frontend: "admin" })
    expect(welcome.snapshot.admin).toEqual({ enabled: true, loggedIn: false })
    const wrong = await page.login("not the password")
    expect(wrong.result).toMatchObject({ ok: false, error: { code: "bad_password" } })
    expect(await page.waitFor("admin.state", () => true, { from: 0 })).toEqual({ type: "admin.state", admin: { enabled: true, loggedIn: false } })

    const before = Date.now()
    const from = page.messages.length
    const { result, snapshot } = await page.login(TEST_ADMIN_PASSWORD)
    expect(result.ok).toBe(true)
    expect(result.admin?.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.admin!.expiresAt).toBeGreaterThanOrEqual(before + 12 * 3_600_000 - 1_000)
    expect(page.types(from)).toEqual(["result", "admin.state", "admin.snapshot"])
    expect(page.messages[from + 1]).toEqual({ type: "admin.state", admin: { enabled: true, loggedIn: true, expiresAt: result.admin!.expiresAt } })
    expect(snapshot?.frontends.map((f) => f.id)).toEqual([WEB_VOICE_KIND])
    expect(snapshot?.vault.admin).toBe(true)

    const voice = await voicePage(server)
    const fromVoice = await voice.client.login(TEST_ADMIN_PASSWORD)
    expect(fromVoice.result).toMatchObject({ ok: false, error: { code: "bad_message" } })
    expect(JSON.stringify(page.messages)).not.toContain(TEST_ADMIN_PASSWORD)
  })

  it("five wrong passwords in a row: refused for 30 s (shown in admin.state), then accepted again", async () => {
    let now = 9_000_000
    const { server } = await start({ adminNow: () => now })
    const page = await connect(server)
    await page.hello({ frontend: "admin" })
    for (let i = 0; i < 4; i++) expect((await page.login("wrong horse")).result.error?.message).toBe("Wrong password")
    const fifth = await page.login("wrong horse")
    expect(fifth.result.error?.message).toMatch(/try again in 30 s/)
    expect(await page.waitFor("admin.state", (m) => m.admin.retryAfterMs !== undefined, { from: 0 })).toMatchObject({ admin: { retryAfterMs: 30_000 } })
    const refused = await page.login(TEST_ADMIN_PASSWORD)
    expect(refused.result).toMatchObject({ ok: false, error: { code: "bad_password", message: expect.stringMatching(/Too many wrong passwords/) } })
    now += 30_000
    expect((await page.login(TEST_ADMIN_PASSWORD)).result.ok).toBe(true)
  })

  it("a token in hello resumes the session (admin.snapshot follows welcome); an unknown token is refused quietly", async () => {
    const { server } = await start()
    const { token } = await adminPage(server)
    const again = await connect(server)
    const welcome = await again.hello({ frontend: "admin", adminToken: token })
    expect(welcome.snapshot.admin).toMatchObject({ enabled: true, loggedIn: true })
    expect(again.types()).toEqual(["welcome", "admin.snapshot"])
    expect((await request(again, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: {} })).ok).toBe(true)

    const stranger = await connect(server)
    const refused = await stranger.hello({ frontend: "admin", adminToken: "A".repeat(43) })
    expect(refused.snapshot.admin).toEqual({ enabled: true, loggedIn: false, endReason: "token" })
    await sleep(50)
    expect(stranger.types()).toEqual(["welcome"])
    // A voice page's token is ignored (admin pages only).
    const voice = await connect(server)
    expect((await voice.hello({ adminToken: token })).snapshot.admin.loggedIn).toBe(false)
  })

  it("logout ends the session on every connection that used it; the token no longer resumes", async () => {
    const { server } = await start()
    const a = await adminPage(server)
    const b = await connect(server)
    await b.hello({ frontend: "admin", adminToken: a.token })
    const other = await adminPage(server)
    expect((await request(a.client, { type: "admin.logout" })).ok).toBe(true)
    for (const c of [a.client, b]) {
      expect(await c.waitFor("admin.state", (m) => !m.admin.loggedIn, { from: 0 })).toEqual({
        type: "admin.state",
        admin: { enabled: true, loggedIn: false, endReason: "logout" }
      })
      expect(await request(c, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: {} })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    }
    // Another session is not affected.
    expect((await request(other.client, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: {} })).ok).toBe(true)
    const later = await connect(server)
    expect((await later.hello({ frontend: "admin", adminToken: a.token })).snapshot.admin.endReason).toBe("token")
    // Logging out when not logged in is ok too.
    expect((await request(a.client, { type: "admin.logout" })).ok).toBe(true)
  })

  it("idle: the session ends after the idle limit without an admin action; admin actions keep it alive", async () => {
    const { server } = await start({ adminIdleMs: 400 })
    const busy = await adminPage(server)
    const quiet = await adminPage(server)
    for (let i = 0; i < 5; i++) {
      await sleep(200)
      expect((await request(busy.client, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: {} })).ok).toBe(true)
    }
    expect(await quiet.client.waitFor("admin.state", (m) => !m.admin.loggedIn, { from: 0 })).toMatchObject({ admin: { loggedIn: false, endReason: "idle" } })
    expect(await request(quiet.client, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: {} })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(busy.client.messages.filter((m) => m.type === "admin.state" && !m.admin.loggedIn)).toEqual([])
  })

  it("expiry: the session ends at its limit whatever happens", async () => {
    const { server } = await start({ adminMaxMs: 500 })
    const page = await adminPage(server)
    const ended = page.client.waitFor("admin.state", (m) => !m.admin.loggedIn, { from: 0, timeoutMs: 3_000 })
    for (let i = 0; i < 3; i++) {
      await sleep(100)
      await request(page.client, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: {} })
    }
    expect((await ended).admin).toEqual({ enabled: true, loggedIn: false, endReason: "expired" })
  })
})

// ---------------------------------------------------------------------------

/** One request of every admin-only family. */
const adminOnly: ReadonlyArray<RequestInput> = [
  { type: "module.enable", moduleId: "greeter" },
  { type: "module.disable", moduleId: "greeter" },
  { type: "module.configure", moduleId: "greeter", patch: { values: { greeting: "hoi" }, secrets: {} } },
  { type: "settings.update", sectionId: "voices", patch: { values: { DEFAULT_VOICE: "standard" }, secrets: {} } },
  { type: "engine.reload" },
  { type: "vault.setup", password: "correct horse battery" },
  { type: "vault.unlock", password: "correct horse battery" },
  { type: "vault.lock" },
  { type: "vault.changePassword", oldPassword: "correct horse battery", newPassword: "another horse battery" },
  { type: "settings.moveFromEnv", keys: ["STT_SHERPA_AGC"] },
  { type: "job.start", tool: "stt-models", action: "download", target: "whisper-turbo" },
  { type: "job.cancel", jobId: "job-1" },
  { type: "model.delete", tool: "tts-models", target: "nl_NL-pim-medium" },
  { type: "frontend.update", kind: WEB_VOICE_KIND, patch: { captions: false } },
  { type: "device.admin.update", id: "device-0001", name: "x" },
  { type: "device.forget", id: "device-0001" },
  { type: "wake.test", on: true }
]

/** What a voice connection may ever receive. */
const VOICE_TYPES: ReadonlySet<ServerMessageType> = new Set<ServerMessageType>([
  "welcome", "session", "state", "transcript", "turn.start", "assistant.text", "assistant.playing", "tool.start", "tool.end",
  "turn.end", "reply.start", "reply.end", "reply.stop", "result", "error", "engine.summary", "admin.state", "device.profile",
  "wake", "pong"
])

describe("role-shaped data", () => {
  it("every admin-only request family is refused admin_required for a voice page and for an admin page not logged in", async () => {
    const { server } = await start()
    const voice = await voicePage(server)
    const loggedOut = await connect(server)
    await loggedOut.hello({ frontend: "admin" })
    for (const message of adminOnly) {
      for (const client of [voice.client, loggedOut]) {
        expect(await request(client, message), message.type).toMatchObject({ ok: false, error: { code: "admin_required" } })
      }
    }
    expect(server.handle.host.modules()[0]).toMatchObject({ enabled: true, settings: { values: { greeting: "hello" } } })
    expect(server.handle.vault.state()).toBe("none")
  })

  it("a voice page never receives admin data, whatever admin does; an admin page stops receiving it at logout", async () => {
    const { server, stt } = await start({ env: { STT_SHERPA_AGC: "true" } })
    const voice = await voicePage(server)
    await voice.client.claim()
    const admin = await adminPage(server)
    const other = await adminPage(server)
    await deviceKnown(admin.client, voice.client.device.id)
    expect((await request(admin.client, { type: "settings.update", sectionId: "stt-timing", patch: { values: { STT_SHERPA_FINAL_SILENCE_MS: 500 }, secrets: {} } })).ok).toBe(true)
    expect((await request(admin.client, { type: "module.configure", moduleId: "greeter", patch: { values: { greeting: "hoi" }, secrets: { token: "tok-secret" } } })).ok).toBe(true)
    expect((await request(admin.client, { type: "vault.setup", password: "correct horse battery" })).ok).toBe(true)
    expect((await request(admin.client, { type: "vault.lock" })).ok).toBe(true)
    expect((await request(admin.client, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: { captions: false } })).ok).toBe(true)
    expect((await request(admin.client, { type: "device.admin.update", id: voice.client.device.id, name: "Kitchen" })).ok).toBe(true)
    expect((await request(admin.client, { type: "wake.test", on: true })).ok).toBe(true)
    expect((await request(admin.client, { type: "engine.reload" })).ok).toBe(true)
    stt.emit(endOfTurn("hello there"))
    await voice.client.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    // Always listening: accepted without a phrase.
    expect(await admin.client.waitFor("wake.heard", (m) => m.text === "hello there", { from: 0 })).toMatchObject({ accepted: true })

    for (const m of voice.client.messages) expect(VOICE_TYPES.has(m.type), m.type).toBe(true)
    for (const m of voice.client.messages) expect(ADMIN_ONLY.has(m.type), m.type).toBe(false)
    const raw = JSON.stringify(voice.client.messages)
    for (const word of ["sections", "modules", "greeting", "vault", "tok-secret", "Kitchen", "STT_SHERPA", "entries"]) expect(raw, word).not.toContain(word)
    expect(voice.client.messages.find((m) => m.type === "welcome")).toMatchObject({ snapshot: { engine: { ready: true } } })

    // Logout: admin data stops for that page (the other admin page still gets it).
    expect((await request(admin.client, { type: "admin.logout" })).ok).toBe(true)
    const from = admin.client.messages.length
    expect((await request(other.client, { type: "module.configure", moduleId: "greeter", patch: { values: { greeting: "hallo" }, secrets: {} } })).ok).toBe(true)
    await other.client.waitFor("module.changed", (m) => m.module.settings.values.greeting === "hallo", { from: 0 })
    stt.emit(endOfTurn("again"))
    await other.client.waitFor("turn.end", (m) => m.turnId > 0, { from: other.client.messages.length - 1, timeoutMs: 10_000 }).catch(() => undefined)
    await sleep(100)
    for (const m of admin.client.messages.slice(from)) expect(ADMIN_ONLY.has(m.type), m.type).toBe(false)
  })
})

// ---------------------------------------------------------------------------

describe("front-end kinds and devices", () => {
  it("a device is recorded at hello; its own tabs may change voice, activation and follow-up only; changes reach every tab live", async () => {
    const { server } = await start()
    const admin = await adminPage(server)
    const tab1 = await voicePage(server, { deviceId: "phone-0001" })
    const tab2 = await voicePage(server, { deviceId: "phone-0001" })
    expect(tab1.welcome.snapshot.device).toEqual({
      deviceId: "phone-0001",
      profile: expect.objectContaining({ activation: "always", interruptMode: "instant", voice: "" }),
      editable: ["voice", "activation", "followUpSeconds"]
    })
    const listed = await admin.client.waitFor("devices", (m) => m.devices.some((d) => d.id === "phone-0001" && d.connections === 2), { from: 0 })
    expect(listed.devices.find((d) => d.id === "phone-0001")).toMatchObject({ kind: WEB_VOICE_KIND, name: "Test browser", overrides: {}, audioOwner: false })

    expect((await request(tab1.client, { type: "device.update", patch: { activation: "wake-phrase", followUpSeconds: 3, voice: "standard" } })).ok).toBe(true)
    for (const tab of [tab1, tab2]) {
      const p = await profileOf(tab.client, (m) => m.profile.activation === "wake-phrase")
      expect(p.profile).toMatchObject({ followUpSeconds: 3, voice: "standard" })
    }
    await admin.client.waitFor("devices", (m) => m.devices.some((d) => d.overrides.activation === "wake-phrase"), { from: 0 })
    // Not editable by the device itself; an unknown voice; a page without a device.
    expect(await request(tab1.client, { type: "device.update", patch: { captions: false } })).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(await request(tab1.client, { type: "device.update", patch: { voice: "nope" } })).toMatchObject({
      ok: false,
      error: { code: "invalid_settings", fieldErrors: [{ key: "voice" }] }
    })
    const bare = await connect(server)
    const bareWelcome = await bare.hello({ device: false })
    expect(bareWelcome.snapshot.device).toEqual({ profile: expect.objectContaining({ interruptMode: "instant" }), editable: [] })
    expect(await request(bare, { type: "device.update", patch: { voice: null } })).toMatchObject({ ok: false, error: { code: "bad_message" } })
    // `null` removes the device's own override.
    expect((await request(tab2.client, { type: "device.update", patch: { followUpSeconds: null } })).ok).toBe(true)
    expect((await profileOf(tab1.client, (m) => m.profile.followUpSeconds === 8)).profile.activation).toBe("wake-phrase")

    const saved = JSON.parse(readFileSync(join(server.dataDir, "settings.json"), "utf8"))
    expect(saved.version).toBe(3)
    expect(saved.devices["phone-0001"]).toMatchObject({ kind: WEB_VOICE_KIND, name: "Test browser", overrides: { activation: "wake-phrase", voice: "standard" } })
  })

  it("admin: kind defaults and device overrides reach running devices live; rename, reset, forget; unknown ids", async () => {
    const { server } = await start()
    const admin = await adminPage(server)
    const a = await voicePage(server, { deviceId: "laptop-001" })
    const b = await voicePage(server, { deviceId: "tablet-001" })
    await deviceKnown(admin.client, "laptop-001")
    await deviceKnown(admin.client, "tablet-001")

    // Kind defaults: every device of the kind.
    const fromAdmin = admin.client.messages.length
    expect((await request(admin.client, { type: "frontend.update", kind: WEB_VOICE_KIND, patch: { captions: false, prebufferMs: 120 } })).ok).toBe(true)
    for (const c of [a.client, b.client]) await profileOf(c, (m) => !m.profile.captions && m.profile.prebufferMs === 120)
    const kinds = await admin.client.waitFor("frontends", () => true, { from: fromAdmin })
    expect(kinds.frontends[0]).toMatchObject({ id: WEB_VOICE_KIND, defaults: { interruptMode: "instant", captions: false, prebufferMs: 120 }, profile: { captions: false } })

    // A device override wins over the kind; `null` resets it; rename.
    expect((await request(admin.client, { type: "device.admin.update", id: "laptop-001", name: "Study laptop", patch: { captions: true } })).ok).toBe(true)
    await profileOf(a.client, (m) => m.profile.captions)
    const renamed = await admin.client.waitFor("devices", (m) => m.devices.some((d) => d.name === "Study laptop"), { from: 0 })
    expect(renamed.devices.find((d) => d.id === "laptop-001")).toMatchObject({ overrides: { captions: true }, profile: { captions: true, prebufferMs: 120 } })
    const bFrom = b.client.messages.length
    expect((await request(admin.client, { type: "device.admin.update", id: "laptop-001", patch: { captions: null } })).ok).toBe(true)
    const reset = a.client.messages.length
    await profileOf(a.client, (m) => !m.profile.captions)
    await sleep(50)
    expect(b.client.types(bFrom)).not.toContain("device.profile") // b's profile did not change
    void reset

    // Fields that do not exist for the kind, unknown kinds and devices.
    expect(await request(admin.client, { type: "frontend.update", kind: "satellite", patch: {} })).toMatchObject({ ok: false, error: { code: "unknown_device" } })
    expect(await request(admin.client, { type: "device.admin.update", id: "nobody-0001", patch: {} })).toMatchObject({ ok: false, error: { code: "unknown_device" } })
    expect(await request(admin.client, { type: "device.forget", id: "nobody-0001" })).toMatchObject({ ok: false, error: { code: "unknown_device" } })

    // Forget a connected device: recorded again as new (kind defaults), its tab told.
    expect((await request(admin.client, { type: "device.admin.update", id: "tablet-001", name: "Old tablet", patch: { activation: "wake-phrase" } })).ok).toBe(true)
    await profileOf(b.client, (m) => m.profile.activation === "wake-phrase")
    expect((await request(admin.client, { type: "device.forget", id: "tablet-001" })).ok).toBe(true)
    await profileOf(b.client, (m) => m.profile.activation === "always" && m.deviceId === "tablet-001")
    const again = await admin.client.waitFor("devices", (m) => m.devices.some((d) => d.id === "tablet-001" && d.name === "Test browser"), { from: 0 })
    expect(again.devices.find((d) => d.id === "tablet-001")?.overrides).toEqual({})
  })

  it("the device profile decides its session's echo-gate interrupt mode, live", async () => {
    const { server, stt } = await start()
    const admin = await adminPage(server)
    const owner = await voicePage(server, { deviceId: "speaker-01" })
    await owner.client.claim()
    expect(server.handle.sessions.get("speaker-01")?.gate.mode()).toBe("instant")
    await deviceKnown(admin.client, "speaker-01")
    expect((await request(admin.client, { type: "device.admin.update", id: "speaker-01", patch: { interruptMode: "manual" } })).ok).toBe(true)
    await profileOf(owner.client, (m) => m.profile.interruptMode === "manual")
    expect(server.handle.sessions.get("speaker-01")?.gate.mode()).toBe("manual")
    // Manual: talking during the reply does not interrupt it.
    stt.emit(endOfTurn("tell me"))
    await owner.client.waitFor("assistant.playing", () => true, { timeoutMs: 10_000 })
    stt.emit(speechStarted, endOfTurn("stop it"))
    const end = await owner.client.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    expect(end.outcome).toBe("completed")
    expect(owner.client.types()).not.toContain("reply.stop")
    // Back to the kind default (instant).
    expect((await request(admin.client, { type: "device.admin.update", id: "speaker-01", patch: { interruptMode: null } })).ok).toBe(true)
    await profileOf(owner.client, (m) => m.profile.interruptMode === "instant")
    expect(server.handle.sessions.get("speaker-01")?.gate.mode()).toBe("instant")
  })

  it("per-device voice: the owner's profile voice speaks its replies; empty = the assistant's default", async () => {
    const stt = controlledStt()
    const llm = scriptedLlm((t) => `You said: ${t}.`)
    const server = await startTestServer({
      build: fakeBuild({
        stt: stt.stt,
        llm: llm.llm,
        voices: [
          { name: "standard", description: "Everyday answers.", tts: toneTts() },
          { name: "bright", description: "Cheerful.", tts: toneTts() }
        ],
        voiceInfo: [
          { name: "standard", description: "Everyday answers.", enabled: true, isDefault: true, engine: "tone", location: "local" },
          { name: "bright", description: "Cheerful.", enabled: true, isDefault: false, engine: "tone", location: "local" }
        ]
      })
    })
    servers.push(server)
    const owner = await voicePage(server)
    expect(owner.welcome.snapshot.engine.voices.map((v) => v.name)).toEqual(["standard", "bright"])
    await owner.client.claim()
    expect((await request(owner.client, { type: "device.update", patch: { voice: "bright" } })).ok).toBe(true)
    await profileOf(owner.client, (m) => m.profile.voice === "bright")
    stt.emit(endOfTurn("hi"))
    const spoken = await owner.client.waitFor("assistant.text", () => true, { timeoutMs: 10_000 })
    expect(spoken.voice).toBe("bright")
    await owner.client.waitFor("turn.end", () => true, { timeoutMs: 10_000 })
    expect((await request(owner.client, { type: "device.update", patch: { voice: null } })).ok).toBe(true)
    await profileOf(owner.client, (m) => m.profile.voice === "")
    const from = owner.client.messages.length
    stt.emit(endOfTurn("again"))
    expect((await owner.client.waitFor("assistant.text", () => true, { from, timeoutMs: 10_000 })).voice).toBe("standard")
  })
})

// ---------------------------------------------------------------------------

describe("wake phrase in serve mode", () => {
  const wakeServer = async () => {
    const started = await start({ kindDefaults: { interruptMode: "instant", activation: "wake-phrase", followUpSeconds: 1 } })
    const owner = await voicePage(started.server)
    await owner.client.claim()
    await owner.client.waitFor("state", (m) => m.state === "asleep", { from: 0 })
    const admin = await adminPage(started.server)
    expect((await request(admin.client, { type: "wake.test", on: true })).ok).toBe(true)
    return { ...started, owner: owner.client, admin: admin.client }
  }

  it("ignored talk produces no turn, no caption, no history, nothing for the model; only the tester sees it", async () => {
    const { server, stt, llm, owner, admin } = await wakeServer()
    const observer = await voicePage(server, { deviceId: owner.device.id })
    stt.emit(speechStarted, interim("what is the weather like"), endOfTurn("what is the weather like"))
    const heard = await admin.waitFor("wake.heard", () => true, { from: 0 })
    expect(heard).toMatchObject({ text: "what is the weather like", accepted: false })
    expect(heard.matched).toBeUndefined()
    await sleep(150)
    for (const c of [owner, observer.client]) {
      expect(c.types()).not.toContain("turn.start")
      expect(c.messages.filter((m) => m.type === "transcript" && m.text.length > 0)).toEqual([])
      expect(JSON.stringify(c.messages)).not.toContain("weather")
    }
    expect(llm.requests).toEqual([])
    const late = await voicePage(server, { deviceId: owner.device.id })
    expect(late.welcome.snapshot.history).toEqual([])
    expect(late.welcome.snapshot.state).toBe("asleep")
  })

  it("phrase + request: a turn with the phrase removed, `wake` to everyone; then the follow-up window; then asleep again", async () => {
    const { stt, llm, owner, admin } = await wakeServer()
    stt.emit(speechStarted, interim("Hey Jeff, what"), endOfTurn("Hey Jeff, what time is it?"))
    expect(await owner.waitFor("wake", () => true, { from: 0 })).toEqual({ type: "wake", phrase: "hey jeff", armed: false })
    expect((await owner.waitFor("turn.start", () => true, { from: 0 })).userText).toBe("what time is it?")
    expect(owner.messages.filter((m) => m.type === "transcript").map((m) => (m as { text: string }).text)).toEqual(["what", ""])
    expect(await admin.waitFor("wake.heard", () => true, { from: 0 })).toMatchObject({ text: "Hey Jeff, what time is it?", matched: "hey jeff", accepted: true })
    await owner.waitFor("turn.end", () => true, { from: 0, timeoutMs: 10_000 })
    expect(owner.messages.some((m) => m.type === "state" && m.state === "speaking")).toBe(true)
    // Follow-up (1 s): no phrase needed.
    const from = owner.messages.length
    stt.emit(endOfTurn("and tomorrow"))
    expect((await owner.waitFor("turn.start", () => true, { from })).userText).toBe("and tomorrow")
    // The tester: answered without a phrase (accepted, nothing matched).
    const followUp = await admin.waitFor("wake.heard", (m) => m.text === "and tomorrow", { from: 0 })
    expect(followUp.accepted).toBe(true)
    expect(followUp.matched).toBeUndefined()
    await owner.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    // The window closes with nobody speaking: asleep again, and talk is ignored.
    await owner.waitFor("state", (m) => m.state === "asleep", { from, timeoutMs: 3_000 })
    const after = owner.messages.length
    stt.emit(endOfTurn("and the day after"))
    expect((await admin.waitFor("wake.heard", (m) => m.text === "and the day after", { from: 0 })).accepted).toBe(false)
    await sleep(100)
    expect(owner.types(after)).not.toContain("turn.start")
    expect(llm.requests.map((r) => (r.messages.at(-1) as { content?: string }).content)).toEqual(["what time is it?", "and tomorrow"])
  })

  it("with \"save what the assistant hears\" on, ignored talk is not recorded; accepted talk is", async () => {
    const started = await start({ env: { RECORD_HEARD_AUDIO: "true" }, kindDefaults: { activation: "wake-phrase" } })
    const owner = await voicePage(started.server)
    await owner.client.claim()
    // The owner's microphone (quiet) is the recogniser's input, and so what the recordings hold.
    const mic = owner.client.silence(2_500)
    await sleep(400)
    started.stt.emit(speechStarted)
    await sleep(200)
    started.stt.emit(endOfTurn("private chatter"))
    await sleep(300)
    started.stt.emit(speechStarted)
    await sleep(200)
    started.stt.emit(endOfTurn("Hey Jeff, what time is it?"))
    await owner.client.waitFor("turn.start", () => true, { from: 0 })
    const dir = join(started.server.dataDir, "recordings")
    let transcripts: Array<string> = []
    for (let i = 0; i < 50 && transcripts.length === 0; i++) {
      await sleep(50)
      transcripts = (existsSync(dir) ? readdirSync(dir) : []).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).transcript)
    }
    await sleep(300)
    transcripts = readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")).transcript)
    expect(transcripts).toEqual(["Hey Jeff, what time is it?"])
    await mic
  })

  it("the phrase alone arms the window: `wake` armed, listening, the next utterance needs no phrase", async () => {
    const { stt, owner } = await wakeServer()
    stt.emit(speechStarted, endOfTurn("Hey Jeff."))
    expect(await owner.waitFor("wake", () => true, { from: 0 })).toEqual({ type: "wake", phrase: "hey jeff", armed: true })
    await owner.waitFor("state", (m) => m.state === "listening", { from: 0 })
    await sleep(100)
    expect(owner.types()).not.toContain("turn.start")
    stt.emit(endOfTurn("tell me a joke"))
    expect((await owner.waitFor("turn.start", () => true, { from: 0 })).userText).toBe("tell me a joke")
  })

  it("the tester: wake.heard only while on, only to admin pages that switched it on", async () => {
    const { server, stt, admin } = await wakeServer()
    const other = await adminPage(server)
    stt.emit(endOfTurn("one"))
    await admin.waitFor("wake.heard", (m) => m.text === "one", { from: 0 })
    expect((await request(admin, { type: "wake.test", on: false })).ok).toBe(true)
    const from = admin.messages.length
    stt.emit(endOfTurn("two"))
    await sleep(200)
    expect(admin.types(from)).not.toContain("wake.heard")
    expect(other.client.types()).not.toContain("wake.heard")
  })

  it("in `always` mode nothing is gated: every utterance is a turn, and the state is never asleep", async () => {
    const { server, stt } = await start()
    const owner = await voicePage(server)
    await owner.client.claim()
    stt.emit(endOfTurn("Hey Jeff, hello"))
    expect((await owner.client.waitFor("turn.start", () => true, { from: 0 })).userText).toBe("Hey Jeff, hello")
    await owner.client.waitFor("turn.end", () => true, { from: 0, timeoutMs: 10_000 })
    expect(owner.client.messages.some((m) => m.type === "state" && m.state === "asleep")).toBe(false)
    expect(owner.client.types()).not.toContain("wake")
  })
})
