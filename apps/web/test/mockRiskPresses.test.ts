// @vitest-environment node
// P8, review round 1, H5 (finding 5): the mock decides a press as the real gateway does, with the shared decoder,
// `decideRisk` (class `change`) and the shared spoken refusal: a notification's action, a presentation's tick and a
// button, under the saved policy allow / confirm / deny; the holder checks stay; `stop` is the host's and never refused.
// The mock runs as its own process on a loopback port and is driven over the protocol, as a voice page drives it.
import { encodeClientMessage, PROTOCOL_VERSION, riskSpoken } from "@pva/protocol"
import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

const here = path.dirname(fileURLToPath(import.meta.url))
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let seq = 0
const peer = async (url: string, frontend: "admin" | "voice", device?: unknown) => {
  const ws = new WebSocket(url)
  const messages: Array<Record<string, any>> = []
  ws.on("message", (data: Buffer, binary: boolean) => {
    if (!binary) messages.push(JSON.parse(data.toString("utf8")))
  })
  await new Promise((r, j) => {
    ws.once("open", r)
    ws.once("error", j)
  })
  const wait = async (type: string, pred: (m: Record<string, any>) => boolean = () => true) => {
    const end = Date.now() + 5_000
    for (;;) {
      const m = messages.find((x) => x.type === type && pred(x))
      if (m !== undefined) return m
      if (Date.now() > end) throw new Error(`no ${type}`)
      await sleep(10)
    }
  }
  ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: `c-risk-press-${++seq}`, resumeOwner: false, frontend, ...(device !== undefined ? { device } : {}) } as never))
  await wait("welcome")
  const request = async (message: Record<string, unknown>) => {
    const requestId = `r-${++seq}`
    ws.send(JSON.stringify({ ...message, requestId }))
    return wait("result", (r) => r.requestId === requestId)
  }
  return { ws, wait, request }
}

describe("the mock decides presses by the saved risk policy", () => {
  let mock: ChildProcess | undefined
  let port = 0
  beforeAll(async () => {
    port = await freePort()
    mock = spawn(path.join(here, "../node_modules/.bin/tsx"), ["mock/server.ts"], {
      cwd: path.join(here, ".."),
      env: { ...process.env, MOCK_PORT: String(port), MOCK_HOST: "127.0.0.1", MOCK_QUIET: "1", MOCK_SCENARIO: "devices" },
      stdio: ["ignore", "pipe", "inherit"]
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the mock did not start")), 20_000)
      mock!.stdout!.on("data", (d: Buffer) => {
        if (d.toString().includes("assistant mock on")) {
          clearTimeout(timer)
          resolve()
        }
      })
      mock!.once("exit", (code) => reject(new Error(`the mock exited with ${code}`)))
    })
  }, 30_000)
  afterAll(() => {
    mock?.kill()
  })

  it("allow, confirm and deny for a notification's action, a tick and a button; stop always works", async () => {
    const url = `ws://127.0.0.1:${port}/ws`
    const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json()) as Promise<{ id: string }>
    const admin = await peer(url, "admin")
    await admin.request({ type: "admin.login", password: "admin password" })
    const deviceId = "d-risk-press-01"
    const voice = await peer(url, "voice", {
      id: deviceId,
      kind: "web-voice",
      name: "Risk",
      capabilities: { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, present: { kinds: { card: 1, list: 1 } } }
    })
    try {
      for (const [change, expectOk] of [["allow", true], ["confirm", false], ["deny", false]] as const) {
        expect((await admin.request({ type: "settings.update", sectionId: "risk", patch: { values: { RISK_CHANGE: change }, secrets: {} } })).ok).toBe(true)
        const spoken = riskSpoken("en", change === "confirm" ? { outcome: "confirm", by: "change" } : { outcome: "deny", by: "change" })
        const list = await post("/mock/present", {
          deviceId,
          options: { lifetime: "pinned" },
          presentation: { kind: "list", title: "Shopping", style: "checklist", items: [{ id: "milk", text: "Milk", done: false }], spoken: "Milk.", handler: "shop" }
        })
        const card = await post("/mock/present", {
          deviceId,
          options: { lifetime: "pinned" },
          presentation: { kind: "card", title: "Lamp", text: "Press", spoken: "A lamp.", handler: "lamp", buttons: [{ id: "on", label: "On" }] }
        })
        expect(list.id, JSON.stringify(list)).toBeTypeOf("string")
        expect(card.id, JSON.stringify(card)).toBeTypeOf("string")
        await voice.wait("present.show", (m) => m.presentation.id === list.id)
        await voice.wait("present.show", (m) => m.presentation.id === card.id)
        const tick = await voice.request({ type: "present.action", id: list.id, action: "tick", item: "milk", done: true })
        const button = await voice.request({ type: "present.action", id: card.id, action: "on" })
        const n = await post("/mock/notify", { title: "Pasta", ring: true, deviceId, actions: [{ id: "snooze", label: "Snooze" }] })
        await voice.wait("notification.ring", (m) => m.notification.id === n.id)
        const snooze = await voice.request({ type: "notification.action", id: n.id, actionId: "snooze" })
        for (const r of [tick, button, snooze]) {
          if (expectOk) expect(r).toMatchObject({ ok: true })
          else expect(r).toMatchObject({ ok: false, say: spoken, error: { code: "bad_message", message: spoken } })
        }
        // The host's stop: never refused (on a card still open).
        const ringing = await post("/mock/notify", { title: "Eggs", ring: true, deviceId, actions: [{ id: "snooze", label: "Snooze" }] })
        await voice.wait("notification.ring", (m) => m.notification.id === ringing.id)
        expect(await voice.request({ type: "notification.action", id: ringing.id, actionId: "stop" })).toMatchObject({ ok: true })
        // A page that does not hold the card is refused by the holder check first, whatever the policy says.
        const other = await peer(url, "voice", { id: "d-risk-press-02", kind: "web-voice", name: "Other" })
        expect(await other.request({ type: "present.action", id: card.id, action: "on" })).toMatchObject({ ok: false, error: { code: "bad_message" } })
        other.ws.terminate()
      }
    } finally {
      admin.ws.terminate()
      voice.ws.terminate()
    }
  }, 30_000)
})
