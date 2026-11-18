// @vitest-environment node
// PR 90 review round 4 (server/web report, findings 5, 6 and 8): the mock's module buttons, module routes and reset,
// tested through the actual mock server (its own process on a loopback port), driven over the protocol and its HTTP
// API as the admin page drives it.
import { decodeServerMessage, encodeClientMessage, type ModuleInfo, type ModuleRoutesResponse, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
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

type Result = Extract<ServerMessage, { type: "result" }>

interface Admin {
  readonly token: string
  readonly send: (message: Record<string, unknown>) => Promise<Result>
  readonly module: (id: string) => ModuleInfo | undefined
  readonly close: () => void
}

/** An admin connection, logged in, with the modules as the mock last sent them. */
const admin = (url: string) =>
  new Promise<Admin>((resolve, reject) => {
    const ws = new WebSocket(url)
    const modules = new Map<string, ModuleInfo>()
    let token = ""
    let n = 0
    const waiting = new Map<string, (m: Result) => void>()
    const timer = setTimeout(() => reject(new Error("no admin snapshot")), 10_000)
    ws.on("error", reject)
    ws.on("open", () => ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-mock-modules-test", resumeOwner: false, frontend: "admin" })))
    ws.on("message", (data: Buffer) => {
      const decoded = decodeServerMessage(data.toString("utf8"))
      if (decoded._tag !== "Ok") return
      const m = decoded.message
      if (m.type === "welcome") ws.send(encodeClientMessage({ type: "admin.login", requestId: "login", password: "admin password" }))
      if (m.type === "result" && m.requestId === "login" && m.admin !== undefined) token = m.admin.token
      if (m.type === "result") waiting.get(m.requestId)?.(m)
      if (m.type === "module.changed") modules.set(m.module.id, m.module)
      if (m.type === "admin.snapshot") {
        for (const x of m.snapshot.modules) modules.set(x.id, x)
        clearTimeout(timer)
        resolve({
          token,
          module: (id) => modules.get(id),
          send: (message) =>
            new Promise((done) => {
              const requestId = `r${++n}`
              waiting.set(requestId, done)
              ws.send(encodeClientMessage({ ...message, requestId } as never))
            }),
          close: () => ws.close()
        })
      }
    })
  })

describe("the mock's modules (PR 90 review round 4)", () => {
  let mock: ChildProcess | undefined
  let port = 0
  let url = ""
  const http = (method: string, p: string, token?: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    })
  const inventory = async (token: string) => (await (await http("GET", "/api/module-routes?module=demo-home", token)).json()) as ModuleRoutesResponse

  beforeAll(async () => {
    port = await freePort()
    url = `ws://127.0.0.1:${port}/ws`
    mock = spawn(path.join(here, "../node_modules/.bin/tsx"), ["mock/server.ts"], {
      cwd: path.join(here, ".."),
      env: { ...process.env, MOCK_PORT: String(port), MOCK_HOST: "127.0.0.1", MOCK_QUIET: "1", MOCK_SCENARIO: "voice" },
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

  it("8: POST /mock/reset and a scenario change bring back the seeded tokens and calls", async () => {
    for (const reset of [() => http("POST", "/mock/reset"), () => http("POST", "/mock/scenario", undefined, { name: "voice" })]) {
      const c = await admin(url)
      try {
        const seeded = await inventory(c.token)
        expect(seeded.modules[0]!.tokens.map((t) => t.label)).toEqual(["Home Assistant automations"])
        expect(seeded.modules[0]!.routes[0]!.calls.length).toBe(3)
        expect((await http("POST", "/api/module-routes/demo-home/tokens", c.token, { name: "hook", label: "A new caller" })).status).toBe(201)
        expect((await http("DELETE", `/api/module-routes/demo-home/tokens/${seeded.modules[0]!.tokens[0]!.id}`, c.token)).ok).toBe(true)
        expect((await inventory(c.token)).modules[0]!.tokens.map((t) => t.label)).toEqual(["A new caller"])
      } finally {
        c.close()
      }
      expect((await reset()).status).toBe(200)
      const again = await admin(url)
      try {
        const after = await inventory(again.token)
        expect(after.modules[0]!.tokens.map((t) => t.label)).toEqual(["Home Assistant automations"])
        expect(after.modules[0]!.routes[0]!.calls.length).toBe(3)
      } finally {
        again.close()
      }
    }
  }, 30_000)

  it("6: a stopped module publishes no routes, in its update and in the inventory, and keeps its tokens; starting publishes them again", async () => {
    await http("POST", "/mock/reset")
    const c = await admin(url)
    try {
      expect(c.module("demo-home")!.routes?.length).toBe(2)
      expect((await c.send({ type: "module.disable", moduleId: "demo-home" })).ok).toBe(true)
      await sleep(600)
      expect(c.module("demo-home")!.state).toBe("disabled")
      expect(c.module("demo-home")!.routes).toBeUndefined()
      const stopped = await inventory(c.token)
      expect(stopped.modules[0]).toMatchObject({ moduleId: "demo-home", running: false, routes: [] })
      expect(stopped.modules[0]!.tokens.map((t) => t.label)).toEqual(["Home Assistant automations"])
      expect((await c.send({ type: "module.enable", moduleId: "demo-home" })).ok).toBe(true)
      await sleep(100)
      expect(c.module("demo-home")!.state).toBe("running")
      expect(c.module("demo-home")!.routes?.length).toBe(2)
      expect((await inventory(c.token)).modules[0]!.routes.length).toBe(2)
    } finally {
      c.close()
    }
  }, 30_000)

  it("5: a second press of a running button is busy, an instance's button on a stopped module is not running, and a reset forgets running presses", async () => {
    await http("POST", "/mock/reset")
    const c = await admin(url)
    try {
      const first = c.send({ type: "module.action", moduleId: "demo-home", key: "allOff" })
      const second = await c.send({ type: "module.action", moduleId: "demo-home", key: "allOff" })
      expect(second).toMatchObject({ ok: false, error: { code: "busy", message: "That button is still running" } })
      expect((await first).ok).toBe(true)
      // Free again once answered.
      expect((await c.send({ type: "module.action", moduleId: "demo-home", key: "allOff" })).ok).toBe(true)
      expect((await c.send({ type: "module.disable", moduleId: "demo-home" })).ok).toBe(true)
      await sleep(600)
      expect(await c.send({ type: "module.action", moduleId: "demo-home", key: "allOff" })).toMatchObject({ ok: false, error: { code: "not_running", message: "Demo home is not running" } })
      // The definition's button runs while it is stopped.
      expect((await c.send({ type: "module.action", moduleId: "demo-home", key: "check" })).ok).toBe(true)
      expect((await c.send({ type: "module.enable", moduleId: "demo-home" })).ok).toBe(true)
      void c.send({ type: "module.action", moduleId: "demo-home", key: "allOff" })
      await sleep(50)
    } finally {
      c.close()
    }
    // Reset while that press runs: the button is not left busy.
    expect((await http("POST", "/mock/reset")).status).toBe(200)
    const again = await admin(url)
    try {
      expect((await again.send({ type: "module.action", moduleId: "demo-home", key: "allOff" })).ok).toBe(true)
    } finally {
      again.close()
    }
  }, 30_000)
})
