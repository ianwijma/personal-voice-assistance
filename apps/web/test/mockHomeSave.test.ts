// @vitest-environment node
// P2 review round 4 (net report, finding 4): the mock's Home checks are tested through its actual save handler. The mock is started
// as its own process on a loopback port and driven over the protocol, as the admin page drives it.
import { decodeServerMessage, encodeClientMessage, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
import { spawn, type ChildProcess } from "node:child_process"
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

type Section = Extract<ServerMessage, { type: "admin.snapshot" }>["snapshot"]["sections"][number]

/** An admin connection: logged in, with the latest Home section as the mock last sent it. */
const admin = (url: string) =>
  new Promise<{ update: (values: Record<string, unknown>) => Promise<Extract<ServerMessage, { type: "result" }>>; home: () => Section; close: () => void }>((resolve, reject) => {
    const ws = new WebSocket(url)
    let home: Section | undefined
    let n = 0
    const waiting = new Map<string, (m: Extract<ServerMessage, { type: "result" }>) => void>()
    const timer = setTimeout(() => reject(new Error("no admin snapshot")), 10_000)
    ws.on("error", reject)
    ws.on("open", () => ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-home-save-test", resumeOwner: false, frontend: "admin" })))
    ws.on("message", (data: Buffer) => {
      const decoded = decodeServerMessage(data.toString("utf8"))
      if (decoded._tag !== "Ok") return
      const m = decoded.message
      if (m.type === "welcome") ws.send(encodeClientMessage({ type: "admin.login", requestId: "login", password: "admin password" }))
      if (m.type === "result") waiting.get(m.requestId)?.(m)
      if (m.type === "section.changed" && m.section.id === "home") home = m.section
      if (m.type === "admin.snapshot") {
        home = m.snapshot.sections.find((s) => s.id === "home")
        clearTimeout(timer)
        resolve({
          home: () => home!,
          update: (values) =>
            new Promise((done) => {
              const requestId = `u${++n}`
              waiting.set(requestId, done)
              ws.send(encodeClientMessage({ type: "settings.update", requestId, sectionId: "home", patch: { values: values as never, secrets: {} } }))
            }),
          close: () => ws.close()
        })
      }
    })
  })

describe("the mock's Home save (settings.update)", () => {
  let mock: ChildProcess | undefined
  let url = ""
  beforeAll(async () => {
    const port = await freePort()
    url = `ws://127.0.0.1:${port}/ws`
    mock = spawn(path.join(here, "../node_modules/.bin/tsx"), ["mock/server.ts"], {
      cwd: path.join(here, ".."),
      env: { ...process.env, MOCK_PORT: String(port), MOCK_HOST: "127.0.0.1", MOCK_QUIET: "1", MOCK_SCENARIO: "voice" },
      stdio: ["ignore", "pipe", "inherit"]
    })
    // Listening once it says so on stdout (MOCK_QUIET keeps the rest quiet).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the mock did not start")), 20_000)
      mock!.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("assistant mock on")) { clearTimeout(timer); resolve() } })
      mock!.once("exit", (code) => reject(new Error(`the mock exited with ${code}`)))
    })
  }, 30_000)
  afterAll(() => { mock?.kill() })

  it("a save with invalid values mixed with a valid change is refused and changes nothing", async () => {
    const c = await admin(url)
    try {
      // First a valid save, so there are saved values to keep.
      const saved = await c.update({ HOME_CURRENCY: "GBP", HOME_CUP_SIZE: "us", HOME_API_CONTACT: "you@example.com", HOME_TIME_ZONE: "Europe/London" })
      expect(saved.ok).toBe(true)
      await new Promise((r) => setTimeout(r, 50))
      const before = c.home()
      expect(before.form.values).toMatchObject({ HOME_CURRENCY: "GBP", HOME_CUP_SIZE: "us" })
      const bad: Array<Record<string, unknown>> = [
        { HOME_LOCATION: "Leeds", HOME_CURRENCY: "eur" },
        { HOME_LOCATION: "Leeds", HOME_CUP_SIZE: "teacup" },
        { HOME_LOCATION: "Leeds", HOME_API_CONTACT: "a\r\nX-Evil: 1" },
        { HOME_LOCATION: "Leeds", HOME_TIME_ZONE: "+01:00" },
        { HOME_LOCATION: "Leeds", HOME_TIME_ZONE: "Mars/Olympus" }
      ]
      for (const values of bad) {
        const r = await c.update(values)
        expect(r.ok, JSON.stringify(values)).toBe(false)
        expect(r.error?.code).toBe("invalid_settings")
        const keys = (r.error?.fieldErrors ?? []).map((e) => e.key)
        expect(keys).not.toContain("HOME_LOCATION")
        expect(keys.length).toBe(1)
      }
      await new Promise((r) => setTimeout(r, 50))
      expect(c.home().form.values).toEqual(before.form.values)
      expect(c.home().revision).toBe(before.revision)
      // The valid change alone is saved.
      expect((await c.update({ HOME_LOCATION: "Leeds" })).ok).toBe(true)
      await new Promise((r) => setTimeout(r, 50))
      expect(c.home().form.values).toMatchObject({ HOME_LOCATION: "Leeds", HOME_CURRENCY: "GBP" })
      expect(c.home().revision).toBe(before.revision + 1)
    } finally { c.close() }
  }, 20_000)
})
