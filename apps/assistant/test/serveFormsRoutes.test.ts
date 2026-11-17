// P3 in serve mode (docs/MODULES-PLAN.md §4 P3): the demo home's records fields saved and loaded across a restart,
// its buttons pressed with `module.action` (draft and saved settings, admin only), and module routes on the server's
// own port: a public route, a token route whose token is minted and revoked through the admin API, kept in
// secrets.json before there is a vault, moved into the vault with the other keys, and refused (503) while it is locked.
import { defineModule, type ModuleRoute } from "@pva/core"
import { demoHomeModule } from "@pva/modules-builtin"
import type { ClientMessage, ModuleInfo, ModuleRoutesResponse } from "@pva/protocol"
import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

const hookRoutes: ReadonlyArray<ModuleRoute> = [
  { method: "GET", path: "ping", public: true, handler: () => Effect.succeed({ status: 200, body: "pong" }) },
  { method: "POST", path: "hook", guards: ["token"], token: "hook", handler: (req) => Effect.succeed({ status: 202, body: { from: req.token?.label } }) }
]
const hooksModule = defineModule({
  apiVersion: 2,
  id: "hooks",
  name: "Hooks",
  description: "Inbound hooks",
  shared: () => Effect.succeed({ value: undefined, routes: hookRoutes }),
  start: () => Effect.succeed({})
})

const build = () => fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm })
const start = (dataDir?: string) => startTestServer({ build: build(), catalog: [demoHomeModule, hooksModule], ...(dataDir !== undefined ? { dataDir } : {}) })

type RequestInput = Extract<ClientMessage, { readonly requestId: string }> extends infer M ? M extends unknown ? Omit<M, "requestId"> : never : never
let seq = 0
const request = async (client: ScriptedClient, message: RequestInput) => {
  const requestId = `p3-${++seq}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from, timeoutMs: 15_000 })
}

const connect = async () => {
  const c = await ScriptedClient.connect({ url: server!.url })
  clients.push(c)
  return c
}

const moduleOf = (client: ScriptedClient, id: string): ModuleInfo | undefined =>
  client.messages.flatMap((m) => (m.type === "module.changed" && m.module.id === id ? [m.module] : m.type === "admin.snapshot" ? m.snapshot.modules.filter((x) => x.id === id) : [])).at(-1)

describe("extended fields in serve mode", () => {
  it("save records, press buttons with the draft or the saved settings, and keep the records across a restart", async () => {
    server = await start()
    const admin = await connect()
    const { snapshot } = await admin.admin(TEST_ADMIN_PASSWORD)
    const demo = snapshot.modules.find((m) => m.id === "demo-home")!
    expect(demo.settings.fields.map((f) => [f.key, f.type])).toEqual([
      ["rooms", "records"],
      ["lights", "records"],
      ["state", "info"],
      ["check", "action"],
      ["allOff", "action"]
    ])
    expect(demo.settings.values.state).toBe("All lights are off.")

    // A draft with a lamp in a room that does not exist: the check says so, and nothing is saved.
    const draft = { rooms: [{ name: "Hall", aliases: [] }], lights: [{ name: "Desk lamp", room: "Attic", aliases: [] }] }
    const checked = await request(admin, { type: "module.action", moduleId: "demo-home", key: "check", values: draft })
    expect(checked).toMatchObject({ ok: true, action: { ok: false, text: "Desk lamp is in \"Attic\", which is not one of the rooms", tone: "error" } })
    const saved = await request(admin, { type: "module.action", moduleId: "demo-home", key: "check" })
    expect(saved).toMatchObject({ ok: true, action: { ok: true, text: "4 rooms and 2 lamps; every lamp is in one of the rooms." } })
    expect(await request(admin, { type: "module.action", moduleId: "demo-home", key: "allOff" })).toMatchObject({ ok: true, action: { ok: true, text: "Every light was already off." } })
    expect(await request(admin, { type: "module.action", moduleId: "demo-home", key: "rooms" })).toMatchObject({ ok: false, error: { code: "unknown_action" } })
    // Admin only.
    const voice = await connect()
    await voice.hello()
    expect(await request(voice, { type: "module.action", moduleId: "demo-home", key: "allOff" })).toMatchObject({ ok: false, error: { code: "admin_required" } })

    // Save the records; the instance restarts with the new house.
    const rooms = [{ name: "Hall", aliases: ["entrance"] }, { name: "Attic", aliases: [] }]
    const lights = [{ name: "Desk lamp", room: "Attic", aliases: ["bureaulamp"] }]
    expect((await request(admin, { type: "module.configure", moduleId: "demo-home", patch: { values: { rooms, lights }, secrets: {} } })).ok).toBe(true)
    for (let i = 0; i < 100 && moduleOf(admin, "demo-home")?.status?.text.startsWith("2 rooms") !== true; i++) await new Promise((r) => setTimeout(r, 50))
    expect(moduleOf(admin, "demo-home")!.status?.text).toBe("2 rooms · 0 lights on")
    expect(moduleOf(admin, "demo-home")!.settings.values.rooms).toEqual(rooms)
    const file = JSON.parse(readFileSync(join(server.dataDir, "settings.json"), "utf8"))
    expect(file.modules["demo-home"].settings.rooms).toEqual(rooms)

    // A new server on the same data directory loads them unchanged.
    const dataDir = server.dataDir
    for (const c of clients.splice(0)) c.close()
    await server.close()
    server = await start(dataDir)
    const again = await connect()
    const restarted = (await again.admin(TEST_ADMIN_PASSWORD)).snapshot.modules.find((m) => m.id === "demo-home")!
    expect(restarted.settings.values.rooms).toEqual(rooms)
    expect(restarted.settings.values.lights).toEqual(lights)
    expect(restarted.settings.errors).toEqual([])
  })
})

describe("module routes in serve mode", () => {
  it("answer on the server's port; tokens are minted and revoked by admin, move into the vault, and a locked vault answers 503", async () => {
    server = await start()
    const admin = await connect()
    const { token: adminToken, snapshot } = await admin.admin(TEST_ADMIN_PASSWORD)
    expect(snapshot.modules.find((m) => m.id === "hooks")!.routes?.map((r) => [r.method, r.path, r.guards])).toEqual([
      ["GET", "/api/modules/hooks/ping", []],
      ["POST", "/api/modules/hooks/hook", ["token"]]
    ])
    const ping = await fetch(`${server.url}/api/modules/hooks/ping`)
    expect([ping.status, await ping.text()]).toEqual([200, "pong"])
    expect((await fetch(`${server.url}/api/modules/hooks/nothing`)).status).toBe(404)

    const adminApi = (path: string, init: RequestInit = {}) =>
      fetch(`${server!.url}/api/${path}`, { ...init, headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json", ...init.headers } })
    // The admin API needs the admin token.
    expect((await fetch(`${server.url}/api/module-routes`)).status).toBe(401)
    const minted = await adminApi("module-routes/hooks/tokens", { method: "POST", body: JSON.stringify({ name: "hook", label: "Doorbell" }) })
    expect(minted.status).toBe(201)
    const { token, secret } = await minted.json() as { token: { id: string; label: string }; secret: string }
    expect(token.label).toBe("Doorbell")
    // Before there is a vault, kept (as a hash) with the other keys in secrets.json.
    const secretsFile = readFileSync(join(server.dataDir, "secrets.json"), "utf8")
    expect(secretsFile).toContain("@route-tokens")
    expect(secretsFile).not.toContain(secret)

    const hook = (t: string) => fetch(`${server!.url}/api/modules/hooks/hook`, { method: "POST", headers: { Authorization: `Bearer ${t}` } })
    const ok = await hook(secret)
    expect([ok.status, await ok.json()]).toEqual([202, { from: "Doorbell" }])
    const view = await (await adminApi("module-routes?module=hooks")).json() as ModuleRoutesResponse
    expect(view.modules[0]!.tokens.map((t) => t.label)).toEqual(["Doorbell"])
    expect(view.modules[0]!.routes.find((r) => r.path.endsWith("/hook"))!.calls[0]).toMatchObject({ status: 202, token: "Doorbell" })

    // A vault is made: the token moves into it and keeps working; locked, the route says why.
    expect((await request(admin, { type: "vault.setup", password: "correct horse battery" })).ok).toBe(true)
    expect(readFileSync(join(server.dataDir, "vault", "vault.enc"), "utf8")).not.toContain(secret)
    expect((await hook(secret)).status).toBe(202)
    expect((await request(admin, { type: "vault.lock" })).ok).toBe(true)
    const locked = await hook(secret)
    expect([locked.status, await locked.text()]).toEqual([503, "The key vault is locked, so tokens cannot be checked; unlock it in admin"])
    expect(((await (await adminApi("module-routes")).json()) as ModuleRoutesResponse).tokensLocked).toBe(true)
    expect((await request(admin, { type: "vault.unlock", password: "correct horse battery" })).ok).toBe(true)

    // Revoked: refused at once.
    expect((await adminApi(`module-routes/hooks/tokens/${token.id}`, { method: "DELETE" })).status).toBe(200)
    expect((await hook(secret)).status).toBe(401)
    expect((await adminApi(`module-routes/hooks/tokens/${token.id}`, { method: "DELETE" })).status).toBe(404)
  })
})
