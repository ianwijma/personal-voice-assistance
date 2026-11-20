// @vitest-environment node
// P8: the mock's risk policy section follows the server's rules with the server's own function (`riskPolicyValueProblem`): a
// settable class takes one of the three outcomes, money and security only Refuse, and those two are never written. The mock is
// started as its own process on a loopback port and driven over the protocol, as the admin page drives it.
import { decodeRiskPolicy, decodeServerMessage, DEFAULT_RISK_POLICY, encodeClientMessage, FIXED_REASON, PROTOCOL_VERSION, type ServerMessage } from "@pva/protocol"
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

/** An admin connection: logged in, with the latest risk section as the mock last sent it. */
const admin = (url: string) =>
  new Promise<{ update: (values: Record<string, unknown>) => Promise<Extract<ServerMessage, { type: "result" }>>; risk: () => Section; close: () => void }>((resolve, reject) => {
    const ws = new WebSocket(url)
    let risk: Section | undefined
    let n = 0
    const waiting = new Map<string, (m: Extract<ServerMessage, { type: "result" }>) => void>()
    const timer = setTimeout(() => reject(new Error("no admin snapshot")), 10_000)
    ws.on("error", reject)
    ws.on("open", () => ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-risk-save-test", resumeOwner: false, frontend: "admin" })))
    ws.on("message", (data: Buffer) => {
      const decoded = decodeServerMessage(data.toString("utf8"))
      if (decoded._tag !== "Ok") return
      const m = decoded.message
      if (m.type === "welcome") ws.send(encodeClientMessage({ type: "admin.login", requestId: "login", password: "admin password" }))
      if (m.type === "result") waiting.get(m.requestId)?.(m)
      if (m.type === "section.changed" && m.section.id === "risk") risk = m.section
      if (m.type === "admin.snapshot") {
        risk = m.snapshot.sections.find((s) => s.id === "risk")
        clearTimeout(timer)
        resolve({
          risk: () => risk!,
          update: (values) =>
            new Promise((done) => {
              const requestId = `u${++n}`
              waiting.set(requestId, done)
              ws.send(encodeClientMessage({ type: "settings.update", requestId, sectionId: "risk", patch: { values: values as never, secrets: {} } }))
            }),
          close: () => ws.close()
        })
      }
    })
  })

describe("the mock's risk policy save (settings.update)", () => {
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the mock did not start")), 20_000)
      mock!.stdout!.on("data", (d: Buffer) => { if (d.toString().includes("assistant mock on")) { clearTimeout(timer); resolve() } })
      mock!.once("exit", (code) => reject(new Error(`the mock exited with ${code}`)))
    })
  }, 30_000)
  afterAll(() => { mock?.kill() })

  it("the section as the server declares it; money and security cannot be opened; an invalid save changes nothing; a valid one is saved", async () => {
    const c = await admin(url)
    try {
      const section = c.risk()
      expect([section.group, section.page?.id, section.protected]).toEqual(["modules", "risk", true])
      expect(section.form.values).toEqual({ RISK_READ: "allow", RISK_CHANGE: "allow", RISK_MESSAGE: "confirm", RISK_MONEY: "deny", RISK_SECURITY: "deny" })
      expect(section.form.fields.filter((f) => f.locked !== undefined).map((f) => [f.key, f.locked!.reason])).toEqual([["RISK_MONEY", FIXED_REASON], ["RISK_SECURITY", FIXED_REASON]])
      for (const values of [{ RISK_MONEY: "allow" }, { RISK_SECURITY: "confirm" }, { RISK_CHANGE: "deny", RISK_MONEY: "allow" }, { RISK_READ: "sometimes" }]) {
        const r = await c.update(values)
        expect(r.ok, JSON.stringify(values)).toBe(false)
        expect(r.error?.code).toBe("invalid_settings")
        if ("RISK_MONEY" in values || "RISK_SECURITY" in values) expect(r.error?.message).toBe(FIXED_REASON)
      }
      await new Promise((r) => setTimeout(r, 50))
      expect(c.risk().form.values).toEqual(section.form.values)
      expect(c.risk().revision).toBe(section.revision)
      // Refuse for money is accepted (as the server: nothing is written for it); a settable class is saved.
      expect((await c.update({ RISK_MONEY: "deny", RISK_MESSAGE: "allow" })).ok).toBe(true)
      await new Promise((r) => setTimeout(r, 50))
      expect(c.risk().form.values).toMatchObject({ RISK_MESSAGE: "allow", RISK_MONEY: "deny" })
      expect(decodeRiskPolicy((k) => c.risk().form.values[k])).toEqual({ ...DEFAULT_RISK_POLICY, message: "allow" })
    } finally { c.close() }
  }, 20_000)
})
