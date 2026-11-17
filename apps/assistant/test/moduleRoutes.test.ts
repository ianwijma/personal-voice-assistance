// Module HTTP routes (docs/MODULES-PLAN.md §4 P3, docs/UI-AND-MODULES.md §1.11): guards (every declared one must
// pass), route tokens in the vault (revocable, a locked vault answers 503), the LAN check and forwarding headers, body
// and rate limits, time limits, the call log, and a route that disappears when its module stops.
import { defineModule, makeModuleHost, type ModuleHost, type ModuleRoute, readOnlyPersistence } from "@pva/core"
import { Context, Effect, Exit, Scope } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isLanAddress, makeModuleRouter, type ModuleRouter } from "../src/serve/moduleRoutes.ts"
import { makeRouteTokens, type RouteTokenKeeper } from "../src/serve/RouteTokens.ts"
import { ROUTE_TOKENS_ENTRY, type SettingsStore } from "../src/serve/SettingsStore.ts"
import { openVault, type Vault } from "../src/serve/Vault.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

const ADMIN_TOKEN = "admin-session-token-0123456789"
const PASSWORD = "correct horse battery"

const routes: ReadonlyArray<ModuleRoute> = [
  { method: "GET", path: "callback", public: true, handler: (req) => Effect.succeed({ status: 200, body: { code: req.query.code ?? null } }) },
  { method: "GET", path: "lan", guards: ["lan"], handler: (req) => Effect.succeed({ status: 200, body: `hello ${req.address}` }) },
  { method: "GET", path: "admin", guards: ["admin"], handler: () => Effect.succeed({ status: 200, body: { admin: true } }) },
  { method: "GET", path: "admin-lan", guards: ["admin", "lan"], handler: () => Effect.succeed({ status: 204 }) },
  {
    method: "POST",
    path: "hook/:name",
    guards: ["token"],
    token: "hook",
    bodyLimitBytes: 64,
    rateLimit: { perAddress: 4, total: 100 },
    handler: (req) => Effect.succeed({ status: 202, body: { name: req.params.name, body: req.body, caller: req.token?.label } })
  },
  { method: "POST", path: "lan-hook", guards: ["token", "lan"], token: "hook", handler: () => Effect.succeed({ status: 202 }) },
  { method: "POST", path: "raw", guards: ["lan"], body: "bytes", handler: (req) => Effect.succeed({ status: 200, body: `${(req.body as Uint8Array).length} bytes` }) },
  { method: "GET", path: "slow", guards: ["lan"], timeoutMs: 100, handler: () => Effect.as(Effect.sleep(5_000), { status: 200 }) },
  { method: "GET", path: "broken", guards: ["lan"], handler: () => Effect.fail("secret detail") },
  { method: "GET", path: "limited", guards: ["lan"], rateLimit: { perAddress: 2, total: 3 }, handler: () => Effect.succeed({ status: 200 }) }
]

const hooksModule = defineModule({
  apiVersion: 2,
  id: "hooks",
  name: "Hooks",
  description: "Inbound hooks",
  shared: () => Effect.succeed({ value: undefined, routes }),
  start: () => Effect.succeed({})
})

let dir: string
let vault: Vault
let store: SettingsStore
let tokens: RouteTokenKeeper
let scope: Scope.Closeable
let host: ModuleHost
let router: ModuleRouter
let server: http.Server
let base: string
/** The caller's address as the router sees it (the test seam for the socket's). */
let caller = "127.0.0.1"

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pva-routes-"))
  vault = await openVault({ path: join(dir, "vault.enc"), kdf: { N: 2 ** 12, r: 8, p: 1 } })
  expect((await vault.setup(PASSWORD, { modules: {}, assistant: {} })).ok).toBe(true)
  store = await Effect.runPromise(openStore(join(dir, "data"), { vault }))
  tokens = makeRouteTokens({ store, locked: () => vault.state() === "locked" })
  scope = await Effect.runPromise(Scope.make())
  host = await Effect.runPromise(makeModuleHost({
    catalog: [hooksModule],
    persistence: readOnlyPersistence({ modules: { hooks: { enabled: true } }, secrets: {} }),
    env: {},
    routeTokens: tokens,
    graceMs: 0
  }).pipe(Scope.provide(scope)))
  await Effect.runPromise(host.startEnabled)
  router = makeModuleRouter({
    host,
    admin: { enabled: true, check: (t) => (t === ADMIN_TOKEN ? { token: t, expiresAt: Date.now() + 60_000 } : undefined), touch: (t) => t === ADMIN_TOKEN },
    tokens,
    services: Context.empty(),
    remoteAddress: () => caller
  })
  server = http.createServer((req, res) => router.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/modules/hooks`
  caller = "127.0.0.1"
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await Effect.runPromise(Scope.close(scope, Exit.void))
  rmSync(dir, { recursive: true, force: true })
})

const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const res = await fetch(`${base}${path}`, { method: init.method ?? "GET", ...(init.headers !== undefined ? { headers: init.headers } : {}), ...(init.body !== undefined ? { body: init.body } : {}) })
  return { status: res.status, text: await res.text(), headers: res.headers }
}
/** A GET with a body (fetch will not send one). */
const getWithBody = (path: string, body: string) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: "GET", headers: { "Content-Length": String(Buffer.byteLength(body)) } }, (res) => {
      let text = ""
      res.on("data", (c) => (text += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on("error", reject)
    req.end(body)
  })
const json = { "Content-Type": "application/json" }
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
const mint = (label = "Home Assistant") => Effect.runPromise(tokens.forModule("hooks").mint("hook", label))

describe("module routes over HTTP", () => {
  it("answer 404 for unknown paths and modules, 405 with Allow for a wrong method", async () => {
    expect((await call("/nothing")).status).toBe(404)
    const other = await fetch(base.replace("/hooks", "/other") + "/callback")
    expect(other.status).toBe(404)
    const wrong = await call("/callback", { method: "DELETE" })
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get("allow")).toBe("GET")
  })

  it("let anyone call a public route, which reads no body", async () => {
    const r = await call("/callback?code=abc&code=ignored")
    expect(r).toMatchObject({ status: 200, text: "{\"code\":\"abc\"}" })
    expect(r.headers.get("cache-control")).toBe("no-store")
    // A public route takes no body.
    expect((await getWithBody("/callback", "hello")).status).toBe(413)
  })

  it("lan: a private or loopback caller passes; another caller, or any forwarded request, does not", async () => {
    expect((await call("/lan")).status).toBe(200)
    caller = "192.168.1.20"
    expect(await call("/lan")).toMatchObject({ status: 200, text: "hello 192.168.1.20" })
    caller = "203.0.113.9"
    expect(await call("/lan")).toMatchObject({ status: 403, text: "Only callers on the home network" })
    // The forwarded value is never believed: a public caller claiming a home address is refused...
    expect((await call("/lan", { headers: { "X-Forwarded-For": "192.168.1.5" } })).status).toBe(403)
    // ...and through a proxy even a loopback socket says nothing about the caller.
    caller = "127.0.0.1"
    expect(await call("/lan", { headers: { Forwarded: "for=192.168.1.5" } })).toMatchObject({ status: 403, text: "Only callers on the home network, not through a proxy" })
    expect((await call("/lan", { headers: { "X-Real-IP": "10.0.0.2" } })).status).toBe(403)
  })

  it("admin: the admin session token, and with lan both must pass", async () => {
    expect((await call("/admin")).status).toBe(401)
    expect((await call("/admin", { headers: bearer("not-the-admin-token-000") })).status).toBe(401)
    expect(await call("/admin", { headers: bearer(ADMIN_TOKEN) })).toMatchObject({ status: 200, text: "{\"admin\":true}" })
    expect((await call("/admin-lan", { headers: bearer(ADMIN_TOKEN) })).status).toBe(204)
    caller = "198.51.100.7"
    expect((await call("/admin-lan", { headers: bearer(ADMIN_TOKEN) })).status).toBe(403)
    caller = "10.1.2.3"
    expect((await call("/admin-lan")).status).toBe(401)
  })

  it("token: a minted token passes until it is revoked; the handler knows the caller", async () => {
    const { token, secret } = await mint("Home Assistant")
    // Only a hash is kept, in the vault.
    const stored = store.secrets().modules[ROUTE_TOKENS_ENTRY]!
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect(readFileSync(join(dir, "vault.enc"), "utf8")).not.toContain(secret)
    expect((await call("/hook/kitchen", { method: "POST" })).status).toBe(401)
    expect((await call("/hook/kitchen", { method: "POST", headers: bearer("x".repeat(43)) })).status).toBe(401)
    const ok = await call("/hook/kitchen", { method: "POST", headers: { ...bearer(secret), ...json }, body: "{\"on\":true}" })
    expect(ok.status).toBe(202)
    expect(JSON.parse(ok.text)).toEqual({ name: "kitchen", body: { on: true }, caller: "Home Assistant" })
    expect((await Effect.runPromise(tokens.forModule("hooks").list))[0]?.lastUsedAt).toBeGreaterThan(0)
    // Another module's tokens are not this one's.
    expect(await Effect.runPromise(tokens.forModule("other").list)).toEqual([])
    expect(await Effect.runPromise(tokens.forModule("other").revoke(token.id))).toBe(false)
    expect(await Effect.runPromise(tokens.forModule("hooks").revoke(token.id))).toBe(true)
    expect(await call("/hook/kitchen", { method: "POST", headers: bearer(secret) })).toMatchObject({ status: 401, text: "The token is not valid (it may have been revoked)" })
  })

  it("token: a locked vault answers 503 with a plain reason; unlocked, the same token works again", async () => {
    const { secret } = await mint()
    vault.lock()
    const locked = await call("/hook/x", { method: "POST", headers: bearer(secret) })
    expect(locked).toMatchObject({ status: 503, text: "The key vault is locked, so tokens cannot be checked; unlock it in admin" })
    expect(locked.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    await expect(mint()).rejects.toThrow(/locked/)
    expect((await vault.unlock(PASSWORD)).ok).toBe(true)
    expect((await call("/hook/x", { method: "POST", headers: bearer(secret) })).status).toBe(202)
  })

  it("token and lan: both must pass", async () => {
    const { secret } = await mint()
    caller = "192.168.1.9"
    expect((await call("/lan-hook", { method: "POST" })).status).toBe(401)
    expect((await call("/lan-hook", { method: "POST", headers: bearer(secret) })).status).toBe(202)
    caller = "8.8.8.8"
    expect((await call("/lan-hook", { method: "POST", headers: bearer(secret) })).status).toBe(403)
  })

  it("limit bodies: over the limit 413, not JSON 415, bad JSON 400, bytes as given", async () => {
    const { secret } = await mint()
    const auth = { ...bearer(secret), ...json }
    expect(await call("/hook/a", { method: "POST", headers: auth, body: JSON.stringify({ text: "x".repeat(100) }) })).toMatchObject({ status: 413, text: "The body is larger than 64 bytes" })
    expect((await call("/hook/a", { method: "POST", headers: { ...bearer(secret), "Content-Type": "text/plain" }, body: "hi" })).status).toBe(415)
    expect((await call("/hook/a", { method: "POST", headers: auth, body: "{nope" })).status).toBe(400)
    expect(await call("/raw", { method: "POST", body: "abcdef" })).toMatchObject({ status: 200, text: "6 bytes" })
    expect(await getWithBody("/lan", "abc")).toMatchObject({ status: 413, text: "This address takes no body" })
  })

  it("limit the rate per caller address and per route (429 with Retry-After)", async () => {
    expect((await call("/limited")).status).toBe(200)
    expect((await call("/limited")).status).toBe(200)
    const third = await call("/limited")
    expect(third.status).toBe(429)
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0)
    caller = "192.168.1.2"
    expect((await call("/limited")).status).toBe(200)
    // The route's total (3 a minute) is reached now, whoever calls.
    caller = "192.168.1.3"
    expect((await call("/limited")).status).toBe(429)
    // Other routes have their own windows.
    expect((await call("/lan")).status).toBe(200)
  })

  it("rate-limit before checking tokens, so they cannot be guessed quickly", async () => {
    for (let i = 0; i < 4; i++) expect((await call("/hook/a", { method: "POST", headers: bearer(`wrong-token-${i}-0123456789`) })).status).toBe(401)
    expect((await call("/hook/a", { method: "POST", headers: bearer("wrong-token-5-0123456789") })).status).toBe(429)
  })

  it("give a handler its time limit (504) and hide its failures (500)", async () => {
    expect(await call("/slow")).toMatchObject({ status: 504, text: "The module did not answer in time" })
    const broken = await call("/broken")
    expect(broken.status).toBe(500)
    expect(broken.text).not.toContain("secret detail")
  })

  it("keep the last calls of each route for the admin view", async () => {
    caller = "192.168.1.20"
    await call("/lan")
    caller = "203.0.113.9"
    await call("/lan")
    const view = await Effect.runPromise(router.view("hooks"))
    expect(view.tokensLocked).toBe(false)
    const lan = view.modules[0]!.routes.find((r) => r.path === "/api/modules/hooks/lan")!
    expect(lan.guards).toEqual(["lan"])
    expect(lan.calls.map((c) => [c.address, c.status, c.note])).toEqual([["203.0.113.9", 403, "Only callers on the home network"], ["192.168.1.20", 200, undefined]])
  })

  it("stop answering when the module stops: its paths are 404", async () => {
    expect((await call("/callback")).status).toBe(200)
    await Effect.runPromise(host.disable("hooks"))
    expect((await call("/callback")).status).toBe(404)
    await Effect.runPromise(host.enable("hooks"))
    expect((await call("/callback")).status).toBe(200)
  })
})

describe("the LAN check", () => {
  it("knows private, loopback and link-local addresses, IPv4 and IPv6", () => {
    for (const a of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"]) {
      expect(isLanAddress(a), a).toBe(true)
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8", "", undefined, "not an address"]) expect(isLanAddress(a), String(a)).toBe(false)
  })
})
