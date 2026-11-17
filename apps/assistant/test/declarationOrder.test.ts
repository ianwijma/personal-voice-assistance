// P5 review round 2, decision 3: declarations are ordered per device at arrival. Randomised: several tabs of one
// device, random interleavings of `hello`, `device.caps`, `device.pick` and `device.forget`, at random moments. The
// order in which the server received the declarations is recorded where it receives them (the hub's `accept` is
// wrapped); when everything has settled, the device's declaration (in memory, as admin sees it, and in its record) is
// the one that arrived last.
import type { ClientMessage, DeviceCapabilities, DeviceListInfo, ServerMessageOf } from "@pva/protocol"
import { decodeClientMessage } from "@pva/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConnectionHandlers, HubConnection } from "../src/serve/SessionHub.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 120_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

/** Declarations that differ materially (each is written). */
const variants: ReadonlyArray<DeviceCapabilities> = [
  { v: 1, display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true }, speaker: { media: ["speech", "audio"] }, microphone: { farField: false } },
  { v: 1, display: { class: "compact", widthPx: 390, heightPx: 844, dpr: 3, touch: "coarse", colour: true }, speaker: { media: ["speech", "audio"] }, microphone: { farField: false }, openUrl: true },
  { v: 1, display: { class: "large", widthPx: 1920, heightPx: 1080, dpr: 1, touch: "fine", colour: true }, speaker: { media: ["speech"] } },
  { v: 1, display: { class: "glance", widthPx: 320, heightPx: 240, dpr: 1, touch: "none", colour: false }, microphone: { farField: true } },
  { v: 1, speaker: { media: ["speech"] }, microphone: { farField: true } }
]

describe("review round 2: declarations in the order they arrived", () => {
  it("several tabs, random hello / device.caps / device.pick / device.forget: the registry ends with the declaration that arrived last", async () => {
    const seed = Number(process.env.PVA_DECL_SEED ?? Date.now() % 100_000)
    const debug = process.env.PVA_DECL_DEBUG !== undefined
    const next = random(seed)
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)]!
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }) })
    const store = server.handle.store
    const D = "decl-device-01"

    // Where the server receives text: the declarations of D, in arrival order, from connections the server still reads.
    const arrived: Array<string> = []
    const hub = server.handle.hub as { accept: (c: HubConnection) => ConnectionHandlers | undefined }
    const accept = hub.accept.bind(hub)
    hub.accept = (connection: HubConnection) => {
      let closedByServer = false
      let closedByPeer = false
      const handlers = accept({ ...connection, close: (code, reason) => {
        closedByServer = true
        connection.close(code, reason)
      } })
      if (handlers === undefined) return undefined
      return {
        ...handlers,
        onText: (text) => {
          if (!closedByServer && !closedByPeer) {
            const d = decodeClientMessage(text)
            if (d._tag === "Ok") {
              const m = d.message
              if (m.type === "hello" && m.device?.id === D && m.device.capabilities !== undefined) arrived.push(JSON.stringify(m.device.capabilities))
              if (m.type === "device.caps" && m.capabilities !== undefined) arrived.push(JSON.stringify(m.capabilities))
              if (debug && (m.type === "hello" || m.type === "device.caps")) {
                const caps = m.type === "hello" ? m.device?.capabilities : m.capabilities
                console.log(`[decl] ${Math.round(performance.now())} ${connection.id} ${m.type} v${variants.findIndex((v) => JSON.stringify(v) === JSON.stringify(caps))} closed ${closedByServer} ${closedByPeer}`)
              }
            }
          }
          handlers.onText(text)
        },
        onClose: () => {
          closedByPeer = true
          handlers.onClose()
        }
      }
    }

    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    let requestCounter = 0

    interface Tab { client: ScriptedClient | undefined; readonly clientId: string; caps: DeviceCapabilities }
    const tabs: Array<Tab> = Array.from({ length: 3 }, (_, i) => ({ client: undefined, clientId: `decl-tab-${i}`, caps: variants[i % variants.length]! }))
    const open = (tab: Tab) => tab.client !== undefined && tab.client.ws.readyState === tab.client.ws.OPEN
    const hello = async (tab: Tab) => {
      const client = await ScriptedClient.connect({ url: server!.url, deviceId: D, clientId: tab.clientId })
      clients.push(client)
      tab.client = client
      // Not awaited: a new device's welcome waits for its registration, and the next step may come first.
      void client.hello({ device: { ...client.device, capabilities: tab.caps } }).catch(() => undefined)
    }

    const ops: Array<string> = []
    const forgets: Array<string> = []
    // All three tabs open to begin with (the first one registers the device).
    for (const tab of tabs) {
      await hello(tab)
      await tab.client!.waitFor("welcome", () => true, { timeoutMs: 10_000 })
    }
    const detail = () => `seed ${seed}, ops ${ops.join(" ")}`
    /** Past every tab's coalescing and the writer's gap: the record has the declaration that arrived last. */
    const checkpoint = async () => {
      // What was sent has reached the server (and the wrapper's log) before "last" is read.
      await sleep(150)
      for (const id of forgets) await admin.waitFor("result", (m) => m.requestId === id, { from: 0, timeoutMs: 10_000 })
      if (store.settings().devices[D] === undefined || arrived.length === 0) return
      const last = arrived.at(-1)!
      for (let i = 0; i < 250 && JSON.stringify(store.settings().devices[D]?.declared?.capabilities) !== last; i++) await sleep(10)
      await sleep(700)
      if (store.settings().devices[D] === undefined) return
      if (debug) console.log(`[decl] checkpoint: record v${variants.findIndex((v) => JSON.stringify(v) === JSON.stringify(store.settings().devices[D]?.declared?.capabilities))}, last v${variants.findIndex((v) => JSON.stringify(v) === last)}`)
      expect(store.settings().devices[D]?.declared?.capabilities, detail()).toEqual(JSON.parse(last))
    }
    for (let step = 0; step < 40; step++) {
      const op = pick(["hello", "caps", "caps", "caps", "race", "race", "pick", "forget"] as const)
      ops.push(op)
      if (debug) console.log(`[decl] ${Math.round(performance.now())} op ${op}`)
      if (op === "race") {
        // One tab's second update is held back by its coalescing while another tab's arrives after it.
        const live = tabs.filter(open)
        if (live.length < 2) continue
        const [a, b] = [live[0]!, live[1]!]
        // Both idle first: A's first update is handled at once, its second held, B's handled at once.
        await sleep(550)
        a.caps = pick(variants)
        a.client!.send({ type: "device.caps", capabilities: a.caps })
        await sleep(20)
        a.caps = pick(variants.filter((v) => v !== a.caps))
        a.client!.send({ type: "device.caps", capabilities: a.caps })
        await sleep(40)
        b.caps = pick(variants.filter((v) => v !== a.caps))
        b.client!.send({ type: "device.caps", capabilities: b.caps })
        await checkpoint()
        continue
      }
      if (op === "hello") {
        const tab = pick(tabs)
        tab.caps = pick(variants)
        if (open(tab)) tab.client!.close()
        await hello(tab)
      } else if (op === "caps") {
        const live = tabs.filter(open)
        if (live.length === 0) continue
        const tab = pick(live)
        tab.caps = pick(variants)
        tab.client!.send({ type: "device.caps", capabilities: tab.caps })
      } else if (op === "pick") {
        const live = tabs.filter(open)
        if (live.length > 0) pick(live).client!.send({ type: "device.pick", requestId: `p${++requestCounter}`, withoutPhrase: "" } as ClientMessage)
      } else if (store.settings().devices[D] !== undefined) {
        const requestId = `f${++requestCounter}`
        forgets.push(requestId)
        admin.send({ type: "device.forget", requestId, id: D })
      }
      await sleep(Math.floor(next() * 120))
    }
    // Every forget answered, then, as the pages do, every tab the server closed comes back with what it can do now
    // (again, if a forget closed it on the way), until all of them are welcomed.
    for (const id of forgets) await admin.waitFor("result", (m) => m.requestId === id, { from: 0, timeoutMs: 10_000 })
    const welcomed = (tab: Tab) => open(tab) && tab.client!.messages.some((m) => m.type === "welcome")
    for (let round = 0; round < 20 && !tabs.every((t) => t.client === undefined || welcomed(t)); round++) {
      for (const tab of tabs) if (tab.client !== undefined && !open(tab)) await hello(tab)
      await sleep(200)
    }
    for (const tab of tabs) if (tab.client !== undefined) expect(welcomed(tab), `seed ${seed}: ${tab.clientId} welcomed`).toBe(true)

    // Settled: past every tab's coalescing and the writer's gap.
    const last = JSON.parse(arrived.at(-1)!) as DeviceCapabilities
    const adminSees = (): DeviceCapabilities | undefined => {
      const lists = admin.messages.flatMap((m) => (m.type === "devices" ? [m.devices] : m.type === "admin.snapshot" ? [m.snapshot.devices] : [])) as Array<ReadonlyArray<DeviceListInfo>>
      return lists.at(-1)?.find((d) => d.id === D)?.declared?.capabilities
    }
    const settled = () => JSON.stringify(store.settings().devices[D]?.declared?.capabilities) === JSON.stringify(last)
    for (let i = 0; i < 400 && !settled(); i++) await sleep(10)
    await sleep(1200)
    expect(store.settings().devices[D]?.declared?.capabilities, detail()).toEqual(last)
    // Admin's list (pushed after the last change) says the same.
    admin.send({ type: "wake.test", requestId: `w${++requestCounter}`, on: false } as ClientMessage)
    await sleep(1200)
    expect(adminSees(), detail()).toEqual(last)
    expect(arrived.length).toBeGreaterThan(3)
    void (undefined as unknown as ServerMessageOf<"welcome">)
  })
})
