// Voice node pairing (docs/VOICE-NODES.md §3.4, §6.1): codes, redeem, back-off per address and in total, admin
// disabled, replace, and seeding "Every voice node" once. On a real settings store and device registry with a fake
// clock; the replace case also against the real server (the old connection is closed with 4403).
import { BUILT_IN_WEB_VOICE_SETTINGS, type NodePairRequest, PROTOCOL_VERSION, type ServerMessage, VOICE_NODE_KIND, WEB_VOICE_KIND } from "@pva/protocol"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeDeviceRegistry } from "../src/serve/devices.ts"
import {
  CODE_TTL_MS,
  FIRST_WAIT_MS,
  GLOBAL_WINDOW_MS,
  makeNodes,
  makePairCode,
  type Nodes,
  normaliseCode,
  type PairedEvent,
  seededNodeSettings,
  spkiPin
} from "../src/serve/nodes.ts"
import type { SettingsStore } from "../src/serve/SettingsStore.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 30_000 })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmp = () => mkdtempSync(join(tmpdir(), "pva-node-pairing-"))

const request = (code: string, hostname = "kitchen-pi"): NodePairRequest => ({
  code,
  hostname,
  platform: { os: "linux", arch: "arm64", hostname, model: "Raspberry Pi 5" },
  version: "0.1.0+abcdef0123"
})

interface Setup {
  readonly store: SettingsStore
  readonly nodes: Nodes
  readonly events: Array<PairedEvent>
  readonly clock: { t: number }
  readonly code: (options?: { name?: string; replace?: string }) => Promise<string>
}

const setup = async (options: { adminEnabled?: boolean; dir?: string } = {}): Promise<Setup> => {
  const store = await run(openStore(options.dir ?? tmp()))
  const clock = { t: 1_800_000_000_000 }
  const registry = makeDeviceRegistry({ store, now: () => clock.t })
  const nodes = makeNodes({
    store,
    registry,
    adminEnabled: options.adminEnabled ?? true,
    tls: false,
    loopbackOnly: false,
    manifest: () => undefined,
    now: () => clock.t
  })
  const events: Array<PairedEvent> = []
  nodes.onPaired((e) => events.push(e))
  const code = async (o: { name?: string; replace?: string } = {}) => {
    const r = await run(nodes.create(o))
    if (!r.ok) throw new Error(r.error.message)
    return r.pairing.code
  }
  return { store, nodes, events, clock, code }
}

/** A code that is surely not outstanding (all outstanding ones start with a letter of the real alphabet too; this one is fixed). */
const WRONG = "00000000"

describe("pairing codes", () => {
  it("codes are 8 Crockford characters from 40 random bits; typed variants normalise", () => {
    expect(makePairCode(() => Buffer.from([0, 0, 0, 0, 0]))).toBe("00000000")
    expect(makePairCode(() => Buffer.from([255, 255, 255, 255, 255]))).toBe("ZZZZZZZZ")
    for (let i = 0; i < 50; i++) expect(makePairCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(normaliseCode("k7qm-2xhp")).toBe("K7QM2XHP")
    expect(normaliseCode("io0l 1234")).toBe("10011234")
  })

  it("a code is redeemed once: a device id, a 32-byte credential whose SHA-256 alone is stored, the hostname as the name", async () => {
    const t = await setup()
    const code = await t.code()
    const answer = await run(t.nodes.redeem(request(code), "192.168.1.50"))
    expect(answer.status).toBe(200)
    const body = answer.json as { deviceId: string; credential: string; name: string }
    expect(body.deviceId).toMatch(/^vn-[A-Za-z0-9_-]{16}$/)
    expect(body.credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(body.credential, "base64url")).toHaveLength(32)
    expect(body.name).toBe("kitchen-pi")
    const record = t.store.settings().devices[body.deviceId]!
    expect(record).toMatchObject({ kind: VOICE_NODE_KIND, name: "kitchen-pi", own: {}, rev: 0, firstSeen: t.clock.t, lastSeen: t.clock.t })
    expect(record.node).toEqual({
      credentialSha256: createHash("sha256").update(body.credential).digest("hex"),
      pairedAt: t.clock.t,
      version: "0.1.0+abcdef0123",
      platform: request(code).platform
    })
    // The credential itself is nowhere in the settings.
    expect(JSON.stringify(t.store.settings())).not.toContain(body.credential)
    expect(t.events).toEqual([{ code, deviceId: body.deviceId, name: "kitchen-pi", replaced: false }])
    // Reused: gone.
    expect(await run(t.nodes.redeem(request(code), "192.168.1.50"))).toEqual({ status: 403, json: { error: "bad_code" } })
    // The admin's name wins and is made unique.
    const named = await run(t.nodes.redeem(request(await t.code({ name: "kitchen-pi" }), "other"), "192.168.1.50"))
    expect((named.json as { name: string }).name).toBe("kitchen-pi 2")
  })

  it("expired after 10 minutes; a wrong code is bad_code; a cancelled code is gone", async () => {
    const t = await setup()
    const code = await t.code()
    t.clock.t += CODE_TTL_MS
    expect(await run(t.nodes.redeem(request(code), "10.0.0.2"))).toEqual({ status: 403, json: { error: "expired" } })
    expect(await run(t.nodes.redeem(request(WRONG), "10.0.0.2"))).toEqual({ status: 403, json: { error: "bad_code" } })
    const other = await t.code()
    t.nodes.cancel(other)
    expect(await run(t.nodes.redeem(request(other), "10.0.0.2"))).toEqual({ status: 403, json: { error: "bad_code" } })
    expect(t.events).toEqual([])
  })

  it("at most three outstanding: a fourth cancels the oldest", async () => {
    const t = await setup()
    const [a, b, c] = [await t.code(), await t.code(), await t.code()]
    const d = await t.code()
    expect(await run(t.nodes.redeem(request(a), "10.0.0.3"))).toEqual({ status: 403, json: { error: "bad_code" } })
    for (const code of [b, c, d]) expect((await run(t.nodes.redeem(request(code), "10.0.0.3"))).status).toBe(200)
  })

  it("wrong codes back off per address: 5 in a row → 30 s, doubling; another address is not held up; a right code resets", async () => {
    const t = await setup()
    const code = await t.code()
    for (let i = 0; i < 4; i++) expect((await run(t.nodes.redeem(request(WRONG), "::ffff:10.0.0.4"))).status).toBe(403)
    expect((await run(t.nodes.redeem(request(WRONG), "10.0.0.4"))).status).toBe(403) // the fifth (same address, IPv4-mapped)
    // Refused, even with the right code.
    expect(await run(t.nodes.redeem(request(code), "10.0.0.4"))).toEqual({ status: 429, json: { error: "rate_limited", retryAfterMs: FIRST_WAIT_MS } })
    t.clock.t += FIRST_WAIT_MS
    // The sixth wrong one doubles the wait.
    expect((await run(t.nodes.redeem(request(WRONG), "10.0.0.4"))).status).toBe(403)
    expect(await run(t.nodes.redeem(request(code), "10.0.0.4"))).toEqual({ status: 429, json: { error: "rate_limited", retryAfterMs: 2 * FIRST_WAIT_MS } })
    // Another address may still pair.
    expect((await run(t.nodes.redeem(request(code), "10.0.0.5"))).status).toBe(200)
    // After a success the count starts again.
    const next = await t.code()
    for (let i = 0; i < 4; i++) await run(t.nodes.redeem(request(WRONG), "10.0.0.6"))
    expect((await run(t.nodes.redeem(request(next), "10.0.0.6"))).status).toBe(200)
    for (let i = 0; i < 4; i++) expect((await run(t.nodes.redeem(request(WRONG), "10.0.0.6"))).status).toBe(403)
  })

  it("50 wrong codes in 10 minutes from anywhere: every redeem is refused until the oldest of them is out of the window", async () => {
    const t = await setup()
    const code = await t.code()
    const start = t.clock.t
    // Four per address (none of them backs off), 13 addresses: 52 attempts, the 51st and 52nd refused.
    const answers: Array<number> = []
    for (let i = 0; i < 13; i++) {
      for (let j = 0; j < 4; j++) {
        answers.push((await run(t.nodes.redeem(request(WRONG), `10.1.${i}.1`))).status)
        t.clock.t += 1_000
      }
    }
    expect(answers.filter((s) => s === 403)).toHaveLength(50)
    expect(answers.slice(50)).toEqual([429, 429])
    const refused = await run(t.nodes.redeem(request(code), "10.9.9.9"))
    expect(refused).toEqual({ status: 429, json: { error: "rate_limited", retryAfterMs: start + GLOBAL_WINDOW_MS - t.clock.t } })
    t.clock.t = start + GLOBAL_WINDOW_MS
    // The oldest wrong one has left the window (and the first code has expired with it): a new code pairs.
    const fresh = await t.code()
    expect((await run(t.nodes.redeem(request(fresh), "10.9.9.9"))).status).toBe(200)
  })

  it("no admin password: no codes are made, and a redeem says admin_disabled", async () => {
    const t = await setup({ adminEnabled: false })
    expect(await run(t.nodes.create({}))).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(await run(t.nodes.redeem(request(WRONG), "10.0.0.7"))).toEqual({ status: 503, json: { error: "admin_disabled" } })
  })

  it("replace: the record keeps its name and settings but gets the new credential; replace of a non-node is refused", async () => {
    const t = await setup()
    const first = (await run(t.nodes.redeem(request(await t.code()), "10.0.0.8"))).json as { deviceId: string; credential: string }
    const id = first.deviceId
    await run(t.store.saveDevice(id, 0, { name: "Kitchen", own: { sound: { volume: 30, cues: false } } }))
    const before = t.store.settings().devices[id]!
    t.clock.t += 5_000
    const code = await t.code({ replace: id })
    const again = await run(t.nodes.redeem(request(code, "new-box"), "10.0.0.8"))
    expect(again.status).toBe(200)
    const body = again.json as { deviceId: string; credential: string; name: string }
    expect(body.deviceId).toBe(id)
    expect(body.name).toBe("Kitchen")
    expect(body.credential).not.toBe(first.credential)
    const after = t.store.settings().devices[id]!
    expect(after).toMatchObject({ name: "Kitchen", own: { sound: { volume: 30, cues: false } }, rev: before.rev, firstSeen: before.firstSeen })
    expect(after.node?.credentialSha256).toBe(createHash("sha256").update(body.credential).digest("hex"))
    expect(after.node?.pairedAt).toBe(t.clock.t)
    expect(t.events.at(-1)).toEqual({ code, deviceId: id, name: "Kitchen", replaced: true })
    expect(Object.keys(t.store.settings().devices)).toHaveLength(1)
    expect(await run(t.nodes.create({ replace: "not-a-node-0001" }))).toMatchObject({ ok: false, error: { code: "unknown_device" } })
  })

  it("the first code seeds Every voice node from the browsers once, without follow-up values, nobody without a phrase; never over a saved type", async () => {
    const t = await setup()
    const browsers = t.store.settings().deviceTypes[WEB_VOICE_KIND]
    // The migrated default install has its assistant on the browsers; give it a follow-up and a TypeSafe mode.
    const assistant = t.store.assistants()[0]!.id
    await run(t.store.saveDeviceType(WEB_VOICE_KIND, browsers?.rev ?? 0, {
      ...(browsers ?? BUILT_IN_WEB_VOICE_SETTINGS),
      assistants: [{ assistant, phrases: ["hey jeff"], followUpSeconds: 12 }],
      withoutPhrase: { mode: "assistant", assistant },
      matching: "exact"
    }))
    expect(t.store.settings().deviceTypes[VOICE_NODE_KIND]).toBeUndefined()
    await t.code()
    const seeded = t.store.settings().deviceTypes[VOICE_NODE_KIND]!
    expect(seeded).toMatchObject({ assistants: [{ assistant, phrases: ["hey jeff"] }], withoutPhrase: { mode: "nobody" }, matching: "exact", sound: { volume: 80, cues: true }, rev: 1 })
    expect(seeded.assistants[0]).not.toHaveProperty("followUpSeconds")
    // Once: the owner's own change stays.
    await run(t.store.saveDeviceType(VOICE_NODE_KIND, 1, { ...seeded, assistants: [] }))
    await t.code()
    expect(t.store.settings().deviceTypes[VOICE_NODE_KIND]).toMatchObject({ assistants: [], rev: 2 })
    // Browsers without assistants: nothing to seed.
    expect(seededNodeSettings({ ...seeded, assistants: [] })).toBeUndefined()
  })

  it("the SPKI pin of a certificate is sha256 of its DER public key", async () => {
    const { execFileSync } = await import("node:child_process")
    const dir = tmp()
    const cert = join(dir, "cert.pem")
    try {
      execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(dir, "key.pem"), "-out", cert, "-days", "1", "-subj", "/CN=test"], { stdio: "ignore" })
    } catch {
      return // no openssl on this machine
    }
    const { readFileSync } = await import("node:fs")
    const { X509Certificate } = await import("node:crypto")
    const pem = readFileSync(cert)
    const der = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })
    expect(spkiPin(pem)).toBe(`sha256:${createHash("sha256").update(der).digest("hex")}`)
    // What `openssl … | openssl dgst -sha256` gives (curl's --pinnedpubkey takes the base64 of the same digest).
    const viaOpenssl = execFileSync("sh", ["-c", `openssl x509 -in '${cert}' -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -hex`]).toString()
    expect(viaOpenssl).toContain(spkiPin(pem).slice("sha256:".length))
  })
})

// -- Against the server ------------------------------------------------------------------------------------------------

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const nodeHello = (client: ScriptedClient, id: string, credential: string) =>
  client.send({
    type: "hello",
    protocol: PROTOCOL_VERSION,
    clientId: client.clientId,
    resumeOwner: true,
    frontend: "voice",
    device: { id, kind: VOICE_NODE_KIND, name: "kitchen-pi", capabilities: { v: 1, speaker: { media: ["speech"] }, microphone: {} } },
    node: { credential, version: "0.1.0+abcdef0123", platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi" } }
  })

describe("pairing against the server", () => {
  it("node.pair.create → result.pairing; redeem → node.paired to admin; replace closes the old node with 4403 and the old credential stops working", async () => {
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "ok").llm }) })
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    admin.send({ type: "node.pair.create", requestId: "p1" })
    const created = await admin.waitFor("result", (m) => m.requestId === "p1")
    expect(created).toMatchObject({ ok: true, pairing: { tls: false, loopbackOnly: true, bundle: null } })
    expect(created.pairing!.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    expect(created.pairing!.expiresAt).toBeGreaterThan(Date.now())
    expect(created.pairing).not.toHaveProperty("tlsPin")

    const first = (await run(server.handle.nodes.redeem(request(created.pairing!.code), "127.0.0.1"))).json as { deviceId: string; credential: string }
    expect(await admin.waitFor("node.paired")).toEqual({ type: "node.paired", code: created.pairing!.code, deviceId: first.deviceId, name: "kitchen-pi" })

    const node = await ScriptedClient.connect({ url: server.url })
    clients.push(node)
    nodeHello(node, first.deviceId, first.credential)
    await node.waitFor("welcome")

    admin.send({ type: "node.pair.create", requestId: "p2", replace: first.deviceId })
    const again = await admin.waitFor("result", (m) => m.requestId === "p2")
    expect(again.pairing?.replace).toBe(first.deviceId)
    const second = (await run(server.handle.nodes.redeem(request(again.pairing!.code), "127.0.0.1"))).json as { deviceId: string; credential: string }
    expect(second.deviceId).toBe(first.deviceId)
    expect((await node.closed).code).toBe(4403)

    const stale = await ScriptedClient.connect({ url: server.url })
    clients.push(stale)
    nodeHello(stale, first.deviceId, first.credential)
    expect((await stale.closed).code).toBe(4403)
    expect(stale.messages.map((m) => m.type)).not.toContain("welcome")
    const fresh = await ScriptedClient.connect({ url: server.url })
    clients.push(fresh)
    nodeHello(fresh, second.deviceId, second.credential)
    await fresh.waitFor("welcome")
  })

  it("the first code's seeded Every voice node reaches admin (device.types) before the result, as the mock sends it", async () => {
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "ok").llm }) })
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    const before = admin.messages.length
    admin.send({ type: "node.pair.create", requestId: "s1" })
    await admin.waitFor("result", (m) => m.requestId === "s1")
    const after = admin.messages.slice(before)
    const resultAt = after.findIndex((m) => m.type === "result" && m.requestId === "s1")
    const typesAt = after.findIndex((m) => m.type === "device.types")
    expect(typesAt).toBeGreaterThanOrEqual(0)
    expect(typesAt).toBeLessThan(resultAt)
    const types = after[typesAt] as Extract<ServerMessage, { type: "device.types" }>
    expect(types.types.find((t) => t.kind === VOICE_NODE_KIND)?.settings.assistants.length).toBeGreaterThan(0)
  })

  it("node.pair.* are admin only", async () => {
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "ok").llm }) })
    const page = await ScriptedClient.connect({ url: server.url })
    clients.push(page)
    await page.hello()
    page.send({ type: "node.pair.create", requestId: "x1" })
    expect(await page.waitFor("result", (m) => m.requestId === "x1")).toMatchObject({ ok: false, error: { code: "admin_required" } })
    page.send({ type: "node.pair.cancel", requestId: "x2", code: "K7QM2XHP" })
    expect(await page.waitFor("result", (m) => m.requestId === "x2")).toMatchObject({ ok: false, error: { code: "admin_required" } })
  })
})
