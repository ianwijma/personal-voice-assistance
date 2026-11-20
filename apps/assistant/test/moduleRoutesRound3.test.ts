// Review round 3 of PR 90 (module routes in serve mode): module-written token labels pass the page boundary, token
// changes never acknowledge damaged settings, and a request in
// flight when its module is withdrawn finishes within the grace period or is answered 503.
import { defineModule, makeModuleHost, type ModuleHost, type ModuleRoute, readOnlyPersistence, Setting } from "@pva/core"
import { Context, Effect, Exit, Scope } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModuleRouter, type ModuleRouter } from "../src/serve/moduleRoutes.ts"
import { makeRouteTokens, type RouteTokenKeeper } from "../src/serve/RouteTokens.ts"
import type { SettingsStore } from "../src/serve/SettingsStore.ts"
import { openVault, type Vault } from "../src/serve/Vault.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

const PASSWORD = "correct horse battery"
const SECRET = "module-setting-secret-0123456789abcdef"

let dir: string
let vault: Vault
let store: SettingsStore
let tokens: RouteTokenKeeper
let scope: Scope.Closeable
const servers: Array<http.Server> = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pva-routes3-"))
  vault = await openVault({ path: join(dir, "vault.enc"), kdf: { N: 2 ** 12, r: 8, p: 1 } })
  expect((await vault.setup(PASSWORD, { modules: {}, assistant: {} })).ok).toBe(true)
  store = await Effect.runPromise(openStore(join(dir, "data"), { vault }))
  tokens = makeRouteTokens({ store, locked: () => vault.state() === "locked" })
  scope = await Effect.runPromise(Scope.make())
})

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  rmSync(dir, { recursive: true, force: true })
})

const serve = async (host: ModuleHost, extra: Partial<Parameters<typeof makeModuleRouter>[0]> = {}): Promise<{ router: ModuleRouter; get: (path: string, headers?: Record<string, string>) => Promise<{ status: number; text: string }> }> => {
  const router = makeModuleRouter({
    host,
    admin: { enabled: false, check: () => undefined, touch: () => false },
    tokens,
    services: Context.empty(),
    remoteAddress: () => "127.0.0.1",
    ...extra
  })
  const server = http.createServer((req, res) => router.handle(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    router,
    get: async (path, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: path.includes("/hook") ? "POST" : "GET", headers })
      return { status: res.status, text: await res.text() }
    }
  }
}

const hostOf = async (mod: Parameters<typeof makeModuleHost>[0]["catalog"][number], options: { graceMs?: number; secrets?: Record<string, string>; closeTimeoutMs?: number } = {}) => {
  const host = await Effect.runPromise(makeModuleHost({
    catalog: [mod],
    persistence: readOnlyPersistence({ modules: { [mod.id]: { enabled: true } }, secrets: options.secrets !== undefined ? { [mod.id]: options.secrets } : {} }),
    env: {},
    routeTokens: tokens,
    graceMs: options.graceMs ?? 0,
    ...(options.closeTimeoutMs !== undefined ? { closeTimeoutMs: options.closeTimeoutMs } : {})
  }).pipe(Scope.provide(scope)))
  await Effect.runPromise(host.startEnabled)
  return host
}

describe("module routes after review round 3", () => {
  it("3b-1: a token label the module wrote passes the page boundary, in the inventory and in the call log, also after a lock", async () => {
    const minted: { current?: string } = {}
    const mod = defineModule({
      apiVersion: 2,
      id: "labeller",
      name: "Labeller",
      description: "Mints a token with its key in the label",
      settings: { key: Setting.secret({ label: "Key", required: true }) },
      shared: ({ host, settings }) =>
        host.routeTokens.mint("hook", `Connected with ${String(settings.key).slice(0, 40)}`).pipe(Effect.orDie, Effect.map((m) => {
          minted.current = m.secret
          return {
            value: undefined,
            routes: [{ method: "POST", path: "hook", guards: ["token"], token: "hook", handler: () => Effect.succeed({ status: 202 }) } satisfies ModuleRoute]
          }
        })),
      start: () => Effect.succeed({})
    })
    const host = await hostOf(mod, { secrets: { key: SECRET } })
    const { get, router } = await serve(host)
    expect((await get("/api/modules/labeller/hook", { Authorization: `Bearer ${minted.current}` })).status).toBe(202)
    const view = JSON.stringify(await Effect.runPromise(router.view("labeller")))
    expect(view).not.toContain(SECRET)
    expect(view).toContain("Connected with [secret]")
    vault.lock()
    const locked = await Effect.runPromise(router.view("labeller"))
    expect(locked.tokensLocked).toBe(true)
    expect(JSON.stringify(locked)).not.toContain(SECRET)
    expect(locked.modules[0]!.routes[0]!.calls[0]!.token).toBe("Connected with [secret]")
  })

  it("a request in flight when its module is withdrawn finishes within the grace period, or is answered 503", async () => {
    const mod = defineModule({
      apiVersion: 2,
      id: "graceful",
      name: "Graceful",
      description: "Slow answers",
      shared: () =>
        Effect.succeed({
          value: undefined,
          routes: [
            { method: "GET", path: "quick", public: true, timeoutMs: 10_000, handler: () => Effect.as(Effect.sleep(300), { status: 200, body: "done" }) },
            { method: "GET", path: "long", public: true, timeoutMs: 10_000, handler: () => Effect.as(Effect.sleep(5_000), { status: 200, body: "late" }) }
          ] satisfies ReadonlyArray<ModuleRoute>
        }),
      start: () => Effect.succeed({})
    })
    const host = await hostOf(mod, { graceMs: 1_000 })
    const { get } = await serve(host)
    const quick = get("/api/modules/graceful/quick")
    const long = get("/api/modules/graceful/long")
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    await Effect.runPromise(host.disable("graceful"))
    // Withdrawn: a new request is not routed to it.
    expect((await get("/api/modules/graceful/quick")).status).toBe(404)
    expect(await quick).toEqual({ status: 200, text: "done" })
    const answered = await long
    expect(answered.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(4_000)
  })

  it("3b-2: while the settings are damaged, a token change (even a refused one) saves nothing and starts nothing", async () => {
    const data = join(dir, "data")
    await vault.unlock(PASSWORD)
    // Settings and vault from two different saves (what a damaged journal can leave).
    const keys = ["LLM_PROVIDER", "ANTHROPIC_API_KEY"]
    for (let i = 0; i < 20; i++) await Effect.runPromise(tokens.forModule("hooks").mint("hook", `caller ${i}`))
    await Effect.runPromise(store.saveAssistant(keys, { LLM_PROVIDER: "anthropic" }, { ANTHROPIC_API_KEY: "k-old" }))
    const oldSettings = readFileSync(join(data, "settings.json"), "utf8")
    await Effect.runPromise(store.saveAssistant(keys, { LLM_PROVIDER: "fake" }, {}))
    writeFileSync(join(data, "settings.json"), oldSettings)
    const reopened = await openVault({ path: join(dir, "vault.enc"), kdf: { N: 2 ** 12, r: 8, p: 1 } })
    const blocked = await Effect.runPromise(openStore(data, { vault: reopened }))
    await reopened.unlock(PASSWORD)
    expect(blocked.blocked()).toBeDefined()
    let unblocked = 0
    blocked.onUnblocked(() => void unblocked++)
    const keeper = makeRouteTokens({ store: blocked, locked: () => reopened.state() === "locked" })
    const before = { settings: readFileSync(join(data, "settings.json"), "utf8"), vault: readFileSync(join(dir, "vault.enc"), "utf8") }
    const id = (await Effect.runPromise(keeper.forModule("hooks").list))[0]!.id
    const ops: ReadonlyArray<Effect.Effect<unknown, unknown>> = [keeper.forModule("hooks").mint("hook", "one more"), keeper.forModule("hooks").revoke(id), keeper.forModule("other").mint("hook", "x")]
    for (const op of ops) {
      const exit = await Effect.runPromise(Effect.exit(op))
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toMatch(/blocked/)
    }
    // The store itself refuses too (whoever calls it).
    await expect(Effect.runPromise(blocked.saveRouteTokens((c) => c))).rejects.toThrow(/route tokens were not saved/)
    expect(blocked.blocked()).toBeDefined()
    expect(unblocked).toBe(0)
    expect(readFileSync(join(data, "settings.json"), "utf8")).toBe(before.settings)
    expect(readFileSync(join(dir, "vault.enc"), "utf8")).toBe(before.vault)
    expect((await Effect.runPromise(keeper.forModule("hooks").list)).length).toBe(20)
  })
})
