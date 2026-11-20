// P8, review round 1, H5 (finding 7): saving the risk policy is checked by one function (`riskPolicyPatchProblems`),
// which the real section runs before its generic form checks and the web mock runs too. The same patches (valid,
// invalid, null, a fixed row, mixed; review round 2: a secrets part, mixed and alone) get the same answers from both;
// the real section keeps its all-or-nothing write, and the mock writes nothing for a refused patch either.
import { encodeClientMessage, PROTOCOL_VERSION, riskPolicyPatchProblems } from "@pva/protocol"
import { Effect } from "effect"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path, { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { makeSections } from "../src/serve/sections.ts"
import { openStore } from "./support/store.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const web = path.join(here, "../../web")
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })

const PATCHES: ReadonlyArray<Record<string, unknown> | { readonly values: Record<string, unknown>; readonly secrets: Record<string, string> }> = [
  { RISK_MESSAGE: "allow" },
  { RISK_CHANGE: "sometimes" },
  { RISK_CHANGE: null },
  { RISK_MONEY: "allow" },
  { RISK_SECURITY: "confirm" },
  { RISK_MONEY: "deny" },
  { RISK_CHANGE: "deny", RISK_MONEY: "allow", RISK_READ: "maybe" },
  { RISK_READ: 3 },
  { RISK_READ: "confirm", RISK_CHANGE: "allow" },
  // Review round 2, finding 2: anything in the secrets part (the section has none), mixed with a valid value and alone.
  { values: { RISK_CHANGE: "deny" }, secrets: { RISK_MONEY: "allow" } },
  { values: {}, secrets: { RISK_CHANGE: "allow" } },
  { values: { RISK_MESSAGE: "allow" }, secrets: { RISK_MESSAGE: "allow", RISK_NOTHING: "x" } }
]
const patchOf = (p: (typeof PATCHES)[number]) =>
  "secrets" in p && "values" in p ? { values: p.values as Record<string, unknown>, secrets: p.secrets as Record<string, string> } : { values: p as Record<string, unknown>, secrets: {} }

type Answer = { readonly ok: boolean; readonly message?: string; readonly fieldErrors?: ReadonlyArray<{ readonly key: string | null; readonly message: string }> }

describe("the real section and the mock check a policy save with the same function", () => {
  let mock: ChildProcess | undefined
  let url = ""
  beforeAll(async () => {
    const port = await freePort()
    url = `ws://127.0.0.1:${port}/ws`
    mock = spawn(path.join(web, "node_modules/.bin/tsx"), ["mock/server.ts"], {
      cwd: web,
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

  it("valid, invalid, null, fixed-row and mixed patches: the same answers; an invalid save writes nothing", async () => {
    // The mock, over the protocol as the admin page saves.
    const ws = new WebSocket(url)
    const messages: Array<Record<string, any>> = []
    ws.on("message", (d: Buffer) => messages.push(JSON.parse(d.toString("utf8"))))
    await new Promise((r) => ws.once("open", r))
    const wait = async (pred: (m: Record<string, any>) => boolean) => {
      const end = Date.now() + 5_000
      for (;;) {
        const m = messages.find(pred)
        if (m !== undefined) return m
        if (Date.now() > end) throw new Error("no answer")
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    ws.send(encodeClientMessage({ type: "hello", protocol: PROTOCOL_VERSION, clientId: "c-risk-parity", resumeOwner: false, frontend: "admin" }))
    await wait((m) => m.type === "welcome")
    ws.send(JSON.stringify({ type: "admin.login", requestId: "login", password: "admin password" }))
    await wait((m) => m.type === "admin.snapshot")
    let n = 0
    const mockSave = async (patch: { readonly values: Record<string, unknown>; readonly secrets: Record<string, string> }): Promise<Answer> => {
      const requestId = `s${++n}`
      const sentAt = messages.length
      ws.send(JSON.stringify({ type: "settings.update", requestId, sectionId: "risk", patch }))
      const from = sentAt
      const r = await wait((m) => m.type === "result" && m.requestId === requestId)
      await new Promise((done) => setTimeout(done, 50))
      // A refused patch changes nothing on the mock either: no new revision of the section is announced.
      if (!r.ok) expect(messages.slice(from).some((m) => m.type === "section.changed" && m.section.id === "risk"), JSON.stringify(patch)).toBe(false)
      return r.ok ? { ok: true } : { ok: false, message: r.error.message, fieldErrors: r.error.fieldErrors }
    }
    // The real section on a real store.
    const dir = mkdtempSync(join(tmpdir(), "pva-risk-parity-"))
    const sections = makeSections(await Effect.runPromise(openStore(dir)), {})
    const realSave = async (patch: { readonly values: Record<string, unknown>; readonly secrets: Record<string, string> }): Promise<Answer> => {
      const before = (() => {
        try {
          return readFileSync(join(dir, "settings.json"), "utf8")
        } catch {
          return ""
        }
      })()
      const r = (await Effect.runPromise(sections.update("risk", { values: patch.values as never, secrets: patch.secrets }))).result
      if (!r.ok) {
        // All or nothing: a refused save leaves the file as it was.
        const after = (() => {
          try {
            return readFileSync(join(dir, "settings.json"), "utf8")
          } catch {
            return ""
          }
        })()
        expect(after).toBe(before)
      }
      return r.ok ? { ok: true } : { ok: false, message: r.error.message, ...(r.error.fieldErrors !== undefined ? { fieldErrors: r.error.fieldErrors } : {}) }
    }
    try {
      for (const p of PATCHES) {
        const patch = patchOf(p)
        const real = await realSave(patch)
        const fake = await mockSave(patch)
        expect(fake, JSON.stringify(patch)).toEqual(real)
        // Both answers are the shared function's.
        const problems = riskPolicyPatchProblems(patch.values, patch.secrets)
        expect(real.ok).toBe(problems.length === 0)
        if (problems.length > 0) expect(real).toEqual({ ok: false, message: problems[0]!.message, fieldErrors: problems })
      }
    } finally {
      ws.terminate()
    }
  }, 30_000)
})
