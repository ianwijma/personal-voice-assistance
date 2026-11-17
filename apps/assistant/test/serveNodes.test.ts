// Voice nodes on the server (docs/VOICE-NODES.md §3.3, §4.1, §6.1): the credential check of a node's hello and 4403,
// removal revoking a node, the registry never creating or evicting a node, node.status / node.level / commands, the
// pushed sound settings, and one answer per phrase. Against the real server with injected providers and scripted
// clients; the registry cases on a real settings store.
import { endOfTurn, speechStarted } from "@pva/core/testing"
import {
  BUILT_IN_WEB_VOICE_SETTINGS,
  type DeviceListInfo,
  MAX_DEVICES,
  type NodeStatusBody,
  PROTOCOL_VERSION,
  type ServerMessage,
  VOICE_NODE_KIND,
  WEB_VOICE_KIND
} from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { makeDeviceRegistry } from "../src/serve/devices.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 30_000 })

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

/**
 * A data directory with one assistant, Alpha ("hey alpha", follow-up 8 s), on the browsers and on Every voice node,
 * nobody answering without a phrase anywhere.
 */
const dataDir = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), "pva-nodes-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir: dir })
  await first.close()
  const path = join(dir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", prompt: "You are Alpha.", followUpSeconds: 8, modules: {} }
  file.assistants = { order: ["alpha"], byId: { alpha } }
  const assignments = [{ assistant: "alpha", phrases: ["hey alpha"] }]
  file.deviceTypes[WEB_VOICE_KIND] = { ...file.deviceTypes[WEB_VOICE_KIND], assistants: assignments, withoutPhrase: { mode: "nobody" }, interruptMode: "instant" }
  file.deviceTypes[VOICE_NODE_KIND] = {
    ...BUILT_IN_WEB_VOICE_SETTINGS,
    voicePage: { pick: false },
    sound: { volume: 55, cues: false },
    soundDevices: { input: "plughw:CARD=Speaker,DEV=0", output: "" },
    assistants: assignments,
    withoutPhrase: { mode: "nobody" },
    interruptMode: "instant",
    rev: 1
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dir
}

const start = async (dir?: string) => {
  const stt = controlledStt()
  const llm = scriptedLlm((t) => `Reply to ${t}.`)
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: llm.llm }), ...(dir !== undefined ? { dataDir: dir } : {}) })
  return { stt, llm }
}

const connect = async (options: { deviceId?: string; clientId?: string } = {}) => {
  const client = await ScriptedClient.connect({ url: server!.url, ...options })
  clients.push(client)
  return client
}

/** Pair a node directly (as `POST /node/pair` would): its id and credential. */
const pair = async (hostname = "kitchen-pi") => {
  const created = await run(server!.handle.nodes.create({}))
  if (!created.ok) throw new Error(created.error.message)
  const answer = await run(server!.handle.nodes.redeem({
    code: created.pairing.code,
    hostname,
    platform: { os: "linux", arch: "arm64", hostname },
    version: "0.1.0+abcdef0123"
  }, "127.0.0.1"))
  expect(answer.status).toBe(200)
  return answer.json as { deviceId: string; credential: string; name: string }
}

/** Send a node's hello (`credential: undefined`: no `hello.node`). */
const nodeHello = (
  client: ScriptedClient,
  id: string,
  credential: string | undefined,
  options: { kind?: string; bundleSha256?: string } = {}
) =>
  client.send({
    type: "hello",
    protocol: PROTOCOL_VERSION,
    clientId: client.clientId,
    resumeOwner: true,
    frontend: "voice",
    device: { id, kind: options.kind ?? VOICE_NODE_KIND, name: "whatever the box says", capabilities: { v: 1, speaker: { media: ["speech"] }, microphone: {} } },
    ...(credential !== undefined
      ? {
        node: {
          credential,
          version: "0.2.0+0123456789",
          ...(options.bundleSha256 !== undefined ? { bundleSha256: options.bundleSha256 } : {}),
          platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi", model: "Raspberry Pi 5" }
        }
      }
      : {})
  })

/** A connected, authenticated node. */
const connectNode = async (paired: { deviceId: string; credential: string }) => {
  const node = await connect()
  nodeHello(node, paired.deviceId, paired.credential)
  const welcome = await node.waitFor("welcome")
  return { node, welcome }
}

/** The connection was closed with 4403 and never welcomed. */
const refused = async (client: ScriptedClient) => {
  expect((await client.closed).code).toBe(4403)
  expect(client.types()).not.toContain("welcome")
}

const OTHER_CREDENTIAL = "A".repeat(43)

const lastDevices = (admin: ScriptedClient): ReadonlyArray<DeviceListInfo> => {
  const all = admin.messages.filter((m): m is Extract<ServerMessage, { type: "devices" }> => m.type === "devices")
  return all.at(-1)?.devices ?? []
}

describe("a node's hello", () => {
  it("is refused with 4403 without a welcome: no credential, a wrong one, an unpaired id, a browser naming a node's id, a page without a device using a node's id", async () => {
    await start(await dataDir())
    const paired = await pair()

    const missing = await connect()
    nodeHello(missing, paired.deviceId, undefined)
    await refused(missing)

    const wrong = await connect()
    nodeHello(wrong, paired.deviceId, OTHER_CREDENTIAL)
    await refused(wrong)

    // An id nobody paired, posing as a node (a node device exists only by pairing).
    const unpaired = await connect()
    nodeHello(unpaired, "vn-notpairedatall", OTHER_CREDENTIAL)
    await refused(unpaired)
    expect(server!.handle.store.settings().devices["vn-notpairedatall"]).toBeUndefined()

    // A browser naming the node's id (its own kind, no credential).
    const browser = await connect({ deviceId: paired.deviceId })
    browser.send({ type: "hello", protocol: PROTOCOL_VERSION, clientId: browser.clientId, resumeOwner: true, frontend: "voice", device: browser.device })
    await refused(browser)

    // A browser with the node's credential format but as kind web-voice and a wrong credential.
    const posing = await connect()
    nodeHello(posing, paired.deviceId, OTHER_CREDENTIAL, { kind: WEB_VOICE_KIND })
    await refused(posing)

    // A voice page without a device whose client id is the node's id (it would share the node's session key).
    const deviceless = await connect({ clientId: paired.deviceId })
    deviceless.send({ type: "hello", protocol: PROTOCOL_VERSION, clientId: paired.deviceId, resumeOwner: true, frontend: "voice" })
    await refused(deviceless)

    // An admin front end cannot be a node either.
    const adminNode = await connect()
    adminNode.send({
      type: "hello",
      protocol: PROTOCOL_VERSION,
      clientId: adminNode.clientId,
      resumeOwner: false,
      frontend: "admin",
      device: { id: paired.deviceId, kind: VOICE_NODE_KIND, name: "x" },
      node: { credential: paired.credential, version: "dev", platform: { os: "linux", arch: "x64", hostname: "h" } }
    })
    await refused(adminNode)

    // The right credential: welcomed, as the record's device (its name, kind voice-node), with its sound settings.
    const { welcome } = await connectNode(paired)
    expect(welcome.snapshot.setup).toMatchObject({
      deviceId: paired.deviceId,
      sound: { volume: 55, cues: false },
      soundDevices: { input: "plughw:CARD=Speaker,DEV=0", output: "" }
    })
    // A browser's setup has no sound sections.
    const page = await connect()
    const pageWelcome = await page.hello()
    expect(pageWelcome.snapshot.setup).not.toHaveProperty("sound")
    expect(pageWelcome.snapshot.setup).not.toHaveProperty("soundDevices")
  })

  it("an authenticated node: version, platform and capabilities are written to the record; admin sees node info; the hello's name is ignored", async () => {
    await start()
    const paired = await pair()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const node = await connect()
    nodeHello(node, paired.deviceId, paired.credential, { bundleSha256: "a".repeat(64) })
    await node.waitFor("welcome")
    await admin.waitFor("devices", (m) => m.devices.some((d) => d.id === paired.deviceId && d.connections === 1))
    for (let i = 0; i < 100 && server!.handle.store.settings().devices[paired.deviceId]?.node?.version !== "0.2.0+0123456789"; i++) await sleep(10)
    const record = server!.handle.store.settings().devices[paired.deviceId]!
    expect(record.name).toBe("kitchen-pi")
    expect(record.node).toMatchObject({ version: "0.2.0+0123456789", platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi", model: "Raspberry Pi 5" } })
    expect(record.capabilities).toEqual({ v: 1, speaker: { media: ["speech"] }, microphone: {} })
    const entry = lastDevices(admin).find((d) => d.id === paired.deviceId)!
    expect(entry).toMatchObject({
      kind: VOICE_NODE_KIND,
      name: "kitchen-pi",
      capabilities: { v: 1, speaker: { media: ["speech"] }, microphone: {} },
      node: { version: "0.2.0+0123456789", bundleSha256: "a".repeat(64), transport: "ws", platform: { model: "Raspberry Pi 5" } }
    })
    // No bundle is built here, so whether it is up to date is unknown.
    expect(entry.node).not.toHaveProperty("upToDate")
    expect(entry.node!.pairedAt).toBeGreaterThan(0)
  })
})

describe("removing a node", () => {
  it("device.forget deletes the record, closes the node with 4403 and does not register it again; its credential no longer works", async () => {
    await start()
    const paired = await pair()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const { node } = await connectNode(paired)
    admin.send({ type: "device.forget", requestId: "f1", id: paired.deviceId })
    expect(await admin.waitFor("result", (m) => m.requestId === "f1")).toMatchObject({ ok: true })
    expect((await node.closed).code).toBe(4403)
    await sleep(100)
    expect(server!.handle.store.settings().devices[paired.deviceId]).toBeUndefined()
    expect(lastDevices(admin).some((d) => d.id === paired.deviceId)).toBe(false)
    const again = await connect()
    nodeHello(again, paired.deviceId, paired.credential)
    await refused(again)
    expect(server!.handle.store.settings().devices[paired.deviceId]).toBeUndefined()
  })
})

describe("the registry and nodes", () => {
  it("seen never creates a voice-node record; the cap never evicts a node; a node's facts are written when they change", async () => {
    let now = 1_000_000
    const store = await run(openStore(mkdtempSync(join(tmpdir(), "pva-node-registry-"))))
    const registry = makeDeviceRegistry({ store, now: () => now })
    await run(registry.seen({ id: "vn-posingasanode", kind: VOICE_NODE_KIND, name: "x" }, new Set()))
    expect(store.settings().devices["vn-posingasanode"]).toBeUndefined()
    expect(registry.known("vn-posingasanode")).toBe(false)

    // The oldest record of all is a node; then fill the registry with browsers.
    await run(registry.addNode("vn-oldestnode0001", { name: "Old node", node: { credentialSha256: "0".repeat(64), pairedAt: now } }, new Set()))
    for (let i = 0; i < MAX_DEVICES - 1; i++) {
      now += 1_000
      await run(registry.seen({ id: `browser-${String(i).padStart(4, "0")}`, kind: WEB_VOICE_KIND, name: `B${i}` }, new Set()))
    }
    expect(Object.keys(store.settings().devices)).toHaveLength(MAX_DEVICES)
    now += 1_000
    await run(registry.seen({ id: "browser-new0", kind: WEB_VOICE_KIND, name: "New" }, new Set()))
    const ids = Object.keys(store.settings().devices)
    expect(ids).toHaveLength(MAX_DEVICES)
    expect(ids).toContain("vn-oldestnode0001")
    expect(ids).not.toContain("browser-0000")

    // Within the 10-minute lastSeen interval, a changed version is still written at once; an unchanged one is not.
    const node = { version: "1.0.0+aaaaaaaaaa", platform: { os: "linux", arch: "x64", hostname: "vm" } } as const
    await run(registry.seen({ id: "vn-oldestnode0001", kind: VOICE_NODE_KIND, name: "x" }, new Set(), node))
    expect(store.settings().devices["vn-oldestnode0001"]?.node).toMatchObject({ version: "1.0.0+aaaaaaaaaa" })
    const revision = store.revision()
    now += 1_000
    await run(registry.seen({ id: "vn-oldestnode0001", kind: VOICE_NODE_KIND, name: "x" }, new Set(), node))
    expect(store.revision()).toBe(revision)
    await run(registry.seen({ id: "vn-oldestnode0001", kind: VOICE_NODE_KIND, name: "x" }, new Set(), { ...node, version: "1.0.1+bbbbbbbbbb" }))
    expect(store.settings().devices["vn-oldestnode0001"]?.node).toMatchObject({ version: "1.0.1+bbbbbbbbbb", credentialSha256: "0".repeat(64) })
    expect(store.settings().devices["vn-oldestnode0001"]?.name).toBe("Old node")
  })
})

const status = (n: number): NodeStatusBody => ({
  backend: "alsa",
  inputs: [{ id: "plughw:CARD=Speaker,DEV=0", name: `Speaker ${n}`, isDefault: true }],
  outputs: [{ id: "plughw:CARD=Speaker,DEV=0", name: "Speaker", isDefault: true }],
  input: { opened: "plughw:CARD=Speaker,DEV=0", sampleRate: 16_000 }
})

describe("node messages", () => {
  it("node.status reaches admin through devices, throttled; from a browser it is bad_message", async () => {
    await start()
    const paired = await pair()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()
    const { node } = await connectNode(paired)
    await sleep(1_200)
    const from = admin.position
    for (let i = 1; i <= 5; i++) node.send({ type: "node.status", ...status(i) })
    await sleep(300)
    const early = admin.messages.slice(from).filter((m) => m.type === "devices")
    expect(early.length).toBeLessThanOrEqual(1)
    await sleep(1_100)
    expect(lastDevices(admin).find((d) => d.id === paired.deviceId)?.node?.status).toEqual(status(5))
    expect(admin.messages.slice(from).filter((m) => m.type === "devices").length).toBeLessThanOrEqual(2)
    // The voice page gets neither devices nor any node data.
    expect(page.types()).not.toContain("devices")

    page.send({ type: "node.status", ...status(9) })
    page.send({ type: "node.level", rmsDbfs: -20, peakDbfs: -6 })
    const err = await page.waitFor("error")
    expect(err.error).toMatchObject({ code: "bad_message" })
    await sleep(100)
    expect(page.messages.filter((m) => m.type === "error")).toHaveLength(1) // once
    expect(lastDevices(admin).find((d) => d.id === paired.deviceId)?.node?.status).toEqual(status(5))
  })

  it("a bundle rebuilt while the server runs reaches admin: the node's upToDate turns false without a reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-bundle-poll-"))
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "ok").llm }), dataDir: dir, nodeBundlePollMs: 50 })
    // The harness serves `<dataDir>/no-node` (empty: not built). Write a built dist into it.
    const dist = join(dir, "no-node")
    const { mkdirSync } = await import("node:fs")
    const { createHash } = await import("node:crypto")
    mkdirSync(dist, { recursive: true })
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
    const pin = { url: "https://nodejs.org/x.tar.gz", sha256: "0".repeat(64) }
    const writeDist = (bundle: Buffer) => {
      const boot = Buffer.from("export {}\n")
      writeFileSync(join(dist, "pva-node.mjs"), bundle)
      writeFileSync(join(dist, "pva-node-boot.mjs"), boot)
      writeFileSync(join(dist, "manifest.json"), JSON.stringify({
        format: 1, protocol: 9, version: `0.0.0+${sha(bundle).slice(0, 10)}`,
        bundle: { path: "pva-node.mjs", sha256: sha(bundle), bytes: bundle.length },
        boot: { path: "pva-node-boot.mjs", sha256: sha(boot), bytes: boot.length },
        runtime: { version: "22.23.5", "linux-arm64": pin, "linux-x64": pin }
      }))
      return sha(bundle)
    }
    const first = writeDist(Buffer.from("export const a = 1\n"))
    const paired = await pair()
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const node = await connect()
    nodeHello(node, paired.deviceId, paired.credential, { bundleSha256: first })
    await node.waitFor("welcome")
    await vi.waitFor(() => expect(lastDevices(admin).find((d) => d.id === paired.deviceId)?.node?.upToDate).toBe(true))
    // Quiet: the pushes that follow a connection (throttled to 1 s) are over.
    await sleep(1_500)
    const from = admin.position
    // Rebuilt (a different size, so the manifest's stat changes even within one mtime tick): nothing else happens.
    writeDist(Buffer.from("export const a = 2 // rebuilt\n"))
    await vi.waitFor(() => {
      const pushed = admin.messages.slice(from).filter((m): m is Extract<ServerMessage, { type: "devices" }> => m.type === "devices")
      expect(pushed.at(-1)?.devices.find((d) => d.id === paired.deviceId)?.node?.upToDate).toBe(false)
    }, { timeout: 2_000 })
  })

  it("commands reach only that node; test-mic levels reach admin only, within the window; unknown or offline nodes are unknown_device", async () => {
    await start()
    const a = await pair("node-a")
    const b = await pair("node-b")
    const admin = await connect()
    await admin.admin(TEST_ADMIN_PASSWORD)
    const page = await connect()
    await page.hello()
    const nodeA = (await connectNode(a)).node
    const nodeB = (await connectNode(b)).node

    admin.send({ type: "node.command.send", requestId: "c1", id: a.deviceId, command: "identify" })
    expect(await admin.waitFor("result", (m) => m.requestId === "c1")).toMatchObject({ ok: true })
    expect(await nodeA.waitFor("node.command")).toEqual({ type: "node.command", command: "identify" })

    // Levels outside a test-mic are dropped.
    nodeA.send({ type: "node.level", rmsDbfs: -30, peakDbfs: -10 })
    await sleep(100)
    expect(admin.types()).not.toContain("node.meter")

    admin.send({ type: "node.command.send", requestId: "c2", id: a.deviceId, command: "test-mic", durationMs: 200 })
    expect(await admin.waitFor("result", (m) => m.requestId === "c2")).toMatchObject({ ok: true })
    expect(await nodeA.waitFor("node.command")).toEqual({ type: "node.command", command: "test-mic", durationMs: 200 })
    nodeA.send({ type: "node.level", rmsDbfs: -25, peakDbfs: -8 })
    expect(await admin.waitFor("node.meter")).toEqual({ type: "node.meter", deviceId: a.deviceId, rmsDbfs: -25, peakDbfs: -8 })
    // Another node's levels are not relayed for this window.
    nodeB.send({ type: "node.level", rmsDbfs: -1, peakDbfs: -1 })
    await sleep(1_400) // past durationMs + 1 s
    nodeA.send({ type: "node.level", rmsDbfs: -26, peakDbfs: -9 })
    await sleep(150)
    expect(admin.messages.filter((m) => m.type === "node.meter")).toHaveLength(1)

    expect(nodeB.types()).not.toContain("node.command")
    expect(page.types()).not.toContain("node.command")
    expect(page.types()).not.toContain("node.meter")
    expect(nodeB.types()).not.toContain("node.meter")

    // A browser device, an unknown id, an offline node: unknown_device. A voice page: admin_required.
    admin.send({ type: "node.command.send", requestId: "c3", id: page.device.id, command: "identify" })
    expect(await admin.waitFor("result", (m) => m.requestId === "c3")).toMatchObject({ ok: false, error: { code: "unknown_device" } })
    nodeB.close()
    await nodeB.closed
    await sleep(50)
    admin.send({ type: "node.command.send", requestId: "c4", id: b.deviceId, command: "restart" })
    expect(await admin.waitFor("result", (m) => m.requestId === "c4")).toMatchObject({ ok: false, error: { code: "unknown_device" } })
    page.send({ type: "node.command.send", requestId: "c5", id: a.deviceId, command: "restart" })
    expect(await page.waitFor("result", (m) => m.requestId === "c5")).toMatchObject({ ok: false, error: { code: "admin_required" } })
  })

  it("a sound change reaches the node as device.setup with sound; device.save warns answers_everything on a node, Save anyway keeps it", async () => {
    await start(await dataDir())
    const paired = await pair()
    const admin = await connect()
    const { snapshot } = await admin.admin(TEST_ADMIN_PASSWORD)
    const { node } = await connectNode(paired)
    const rev = snapshot.devices.find((d) => d.id === paired.deviceId)?.rev ?? 0
    admin.send({ type: "device.save", requestId: "s1", target: { kind: "device", id: paired.deviceId }, rev, settings: { sound: { volume: 20, cues: true } } })
    expect(await admin.waitFor("result", (m) => m.requestId === "s1")).toMatchObject({ ok: true })
    expect(await node.waitFor("device.setup")).toMatchObject({ deviceId: paired.deviceId, sound: { volume: 20, cues: true } })

    admin.send({ type: "device.save", requestId: "s2", target: { kind: "device", id: paired.deviceId }, rev: rev + 1, settings: { withoutPhrase: { mode: "assistant", assistant: "alpha" } } })
    const warned = await admin.waitFor("result", (m) => m.requestId === "s2")
    expect(warned).toMatchObject({ ok: false, error: { code: "invalid_settings", warnings: [{ key: "withoutPhrase" }] } })
    admin.send({
      type: "device.save",
      requestId: "s3",
      target: { kind: "device", id: paired.deviceId },
      rev: rev + 1,
      settings: { withoutPhrase: { mode: "assistant", assistant: "alpha" } },
      saveAnyway: true
    })
    expect(await admin.waitFor("result", (m) => m.requestId === "s3")).toMatchObject({ ok: true })
    // The same setting on a browser warns nothing.
    const page = await connect()
    await page.hello()
    await sleep(100)
    const pageRev = lastDevices(admin).find((d) => d.id === page.device.id)?.rev ?? 0
    admin.send({ type: "device.save", requestId: "s4", target: { kind: "device", id: page.device.id }, rev: pageRev, settings: { withoutPhrase: { mode: "assistant", assistant: "alpha" } } })
    expect(await admin.waitFor("result", (m) => m.requestId === "s4")).toMatchObject({ ok: true })
  })
})

describe("one answer per phrase", () => {
  it("on a node: a phrase and a question are answered, the next sentence without the phrase is dropped; a browser with the same assignment keeps its follow-up", async () => {
    const { stt, llm } = await start(await dataDir())
    const paired = await pair()
    const { node } = await connectNode(paired)
    await node.claim()
    for (let i = 0; i < 200 && stt.open() < 1; i++) await sleep(10)
    expect(stt.open()).toBe(1)

    const answered = async (client: ScriptedClient, emit: () => void) => {
      const from = client.position
      emit()
      const begun = await client.waitFor("turn.start", () => true, { from, timeoutMs: 10_000 })
      await client.waitFor("turn.end", (m) => m.turnId === begun.turnId, { from, timeoutMs: 10_000 })
      await client.waitFor("state", (m) => m.state !== "speaking" && m.state !== "thinking", { from, timeoutMs: 5_000 })
      return begun
    }
    const notAnswered = async (client: ScriptedClient, emit: () => void) => {
      const from = client.position
      emit()
      await sleep(400)
      expect(client.types(from)).not.toContain("turn.start")
    }

    const one = await answered(node, () => stt.emitTo(0, speechStarted, endOfTurn("hey alpha what time is it")))
    expect(one).toMatchObject({ userText: "what time is it", assistantId: "alpha" })
    await notAnswered(node, () => stt.emitTo(0, speechStarted, endOfTurn("and tomorrow")))
    expect(llm.requests).toHaveLength(1)

    const page = await connect()
    await page.hello()
    await page.claim()
    for (let i = 0; i < 200 && stt.open() < 2; i++) await sleep(10)
    expect(stt.open()).toBe(2)
    await answered(page, () => stt.emitTo(1, speechStarted, endOfTurn("hey alpha what time is it")))
    const followUp = await answered(page, () => stt.emitTo(1, speechStarted, endOfTurn("and tomorrow")))
    expect(followUp).toMatchObject({ userText: "and tomorrow", assistantId: "alpha" })
    expect(llm.requests).toHaveLength(3)

    // The node again: still one answer per phrase.
    await answered(node, () => stt.emitTo(0, speechStarted, endOfTurn("hey alpha and tomorrow")))
    await notAnswered(node, () => stt.emitTo(0, speechStarted, endOfTurn("and the day after")))
    expect(llm.requests).toHaveLength(4)
  })
})
