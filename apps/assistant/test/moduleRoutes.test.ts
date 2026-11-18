// Module HTTP routes (docs/MODULES-PLAN.md §4 P3, docs/UI-AND-MODULES.md §1.11): guards (every declared one must
// pass), route tokens in the vault (revocable, a locked vault answers 503), the LAN check and forwarding headers, body
// and rate limits, time limits, the call log, and a route that disappears when its module stops.
import { defineModule, makeModuleHost, type ModuleHost, type ModuleRoute, type PublishedRoute, readOnlyPersistence, routeInfo } from "@pva/core"
import { Context, Effect, Exit, Scope } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isLanAddress, makeModuleRouter, makeRouteLimiterForTests, type ModuleRouter, rateKeyOf } from "../src/serve/moduleRoutes.ts"
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
  { method: "GET", path: "limited", guards: ["lan"], rateLimit: { perAddress: 2, total: 3 }, handler: () => Effect.succeed({ status: 200 }) },
  // Review round 1.
  {
    method: "GET",
    path: "query",
    public: true,
    handler: (req) => Effect.succeed({ status: 200, body: { query: { ...req.query }, all: { ...req.queryAll }, inherited: typeof req.query.toLocaleString } })
  },
  {
    method: "POST",
    path: "slow-body",
    guards: ["lan"],
    body: "bytes",
    handler: () => Effect.sync(() => ({ status: 200, body: `run ${++probe.slowBody}` }))
  },
  {
    method: "GET",
    path: "busy",
    guards: ["lan"],
    timeoutMs: 10_000,
    handler: () => Effect.sync(() => void probe.busy++).pipe(Effect.andThen(Effect.sleep(3_000)), Effect.as({ status: 200 }))
  },
  { method: "GET", path: "hang", guards: ["lan"], timeoutMs: 100, handler: () => Effect.never.pipe(Effect.ensuring(Effect.sleep(1_500))) },
  { method: "GET", path: "stubborn", guards: ["lan"], timeoutMs: 100, handler: () => Effect.uninterruptible(Effect.sleep(1_500)).pipe(Effect.as({ status: 200 })) },
  { method: "GET", path: "status/:code", guards: ["lan"], handler: (req) => Effect.succeed({ status: Number(req.params.code), body: "done" }) },
  {
    method: "GET",
    path: "header/:kind",
    guards: ["lan"],
    handler: (req) =>
      Effect.succeed({
        status: 200,
        headers: ({
          space: { "bad name": "x" },
          control: { "X-A": "a\u0001b" },
          crlf: { "X-A": "a\r\nSet-Cookie: x=1" },
          cors: { "Access-Control-Allow-Origin": "*", "access-control-allow-credentials": "true", "X-Ok": "1" }
        } as Record<string, Record<string, string>>)[req.params.kind!] ?? {},
        body: "ok"
      })
  }
]

/** What the review-round-1 handlers saw. */
const probe = { slowBody: 0, busy: 0 }

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
  probe.slowBody = 0
  probe.busy = 0
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

// ---------------------------------------------------------------------------------------------------------------------
// Review round 1 (PR 90).

/** A raw request: any method, path (not normalised), headers and body chunks. */
const raw = (path: string, init: { method?: string; headers?: Record<string, string>; chunks?: ReadonlyArray<string>; port?: number } = {}) =>
  new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const url = new URL(base)
    const req = http.request({ host: "127.0.0.1", port: init.port ?? Number(url.port), path, method: init.method ?? "GET", headers: init.headers ?? {} }, (res) => {
      let text = ""
      res.on("data", (c) => (text += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
    })
    req.on("error", reject)
    for (const chunk of init.chunks ?? []) req.write(chunk)
    req.end()
  })
const P = "/api/modules/hooks"

/** A second router (and server) on the same host, with other options. */
const otherRouter = async (extra: Partial<Parameters<typeof makeModuleRouter>[0]>) => {
  const r = makeModuleRouter({
    host,
    admin: { enabled: false, check: () => undefined, touch: () => false },
    tokens,
    services: Context.empty(),
    remoteAddress: () => caller,
    ...extra
  })
  const s = http.createServer((req, res) => r.handle(req, res))
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve))
  return { router: r, port: (s.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => s.close(() => resolve())) }
}

describe("module routes after review round 1", () => {
  it("treat prototype-style query keys as ordinary keys (no crash, nothing inherited)", async () => {
    const r = await raw(`${P}/query?constructor=a&__proto__=b&toString=c&toString=d&hasOwnProperty=e`)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.text)).toEqual({
      query: { constructor: "a", ["__proto__"]: "b", toString: "c", hasOwnProperty: "e" },
      all: { constructor: ["a"], ["__proto__"]: ["b"], toString: ["c", "d"], hasOwnProperty: ["e"] },
      inherited: "undefined"
    })
    // The server is still there.
    expect((await raw(`${P}/callback`)).status).toBe(200)
  })

  it("answer 500, never end the process, when anything of a request fails unexpectedly", async () => {
    const broken = await otherRouter({
      host: {
        routes: () => {
          throw new Error("boom")
        },
        modules: () => [],
        pageText: (_id, text) => String(text),
        routeView: routeInfo
      }
    })
    const unhandled: Array<unknown> = []
    const onRejection = (e: unknown) => unhandled.push(e)
    process.on("unhandledRejection", onRejection)
    try {
      expect((await raw(`${P}/callback`, { port: broken.port })).status).toBe(500)
      await new Promise((r) => setTimeout(r, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
      await broken.close()
    }
  })

  it("refuse what a browser marks as another site on every route that is not public, before the handler and the body", async () => {
    const own = `http://127.0.0.1:${new URL(base).port}`
    // A simple cross-site POST (text/plain, no preflight) from a page elsewhere: the browser's address is a home one.
    const evil = await raw(`${P}/slow-body`, { method: "POST", headers: { Origin: "http://evil.example", "Content-Type": "text/plain" }, chunks: ["x"] })
    expect(evil).toMatchObject({ status: 403, text: "Requests from another site are refused" })
    expect((await raw(`${P}/slow-body`, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" }, chunks: ["x"] })).status).toBe(403)
    expect((await raw(`${P}/lan`, { headers: { Origin: "null" } })).status).toBe(403)
    expect(probe.slowBody).toBe(0)
    // The server's own page, a typed address, or a script without either header.
    expect((await raw(`${P}/slow-body`, { method: "POST", headers: { Origin: own, "Sec-Fetch-Site": "same-origin" }, chunks: ["x"] })).status).toBe(200)
    expect((await raw(`${P}/lan`, { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(200)
    expect((await raw(`${P}/lan`)).status).toBe(200)
    // A public route is a browser's to arrive on (an OAuth callback from the provider's site).
    expect((await raw(`${P}/callback`, { headers: { "Sec-Fetch-Site": "cross-site", Origin: "https://accounts.example" } })).status).toBe(200)
    // No CORS header, even if a handler sets one.
    const cors = await raw(`${P}/header/cors`)
    expect(cors.status).toBe(200)
    expect(Object.keys(cors.headers).filter((h) => h.startsWith("access-control-"))).toEqual([])
    expect(cors.headers["x-ok"]).toBe("1")
    expect((await raw(`${P}/lan`, { method: "OPTIONS", headers: { Origin: "http://evil.example" } })).headers["access-control-allow-origin"]).toBeUndefined()
  })

  it("behind a declared reverse proxy, refuse every lan request; a same-host proxy that adds no header is otherwise a loopback caller", async () => {
    const proxied = await otherRouter({ behindProxy: true, remoteAddress: (req) => req.socket.remoteAddress })
    // A proxy on the same host, forwarding without any forwarding header.
    const proxyTo = (port: number) =>
      http.createServer((req, res) => {
        const up = http.request({ host: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers)
          r.pipe(res)
        })
        req.pipe(up)
      })
    const direct = await otherRouter({ remoteAddress: (req) => req.socket.remoteAddress })
    const proxies = [proxyTo(proxied.port), proxyTo(direct.port)]
    const ports: Array<number> = []
    for (const p of proxies) {
      await new Promise<void>((resolve) => p.listen(0, "127.0.0.1", resolve))
      ports.push((p.address() as AddressInfo).port)
    }
    try {
      // Declared: refused, whoever is behind the proxy; a token route still works.
      const refused = await raw(`${P}/lan`, { port: ports[0]! })
      expect(refused.status).toBe(403)
      expect(refused.text).toMatch(/SERVE_BEHIND_PROXY/)
      const { secret } = await mint()
      expect((await raw(`${P}/hook/x`, { method: "POST", port: ports[0]!, headers: bearer(secret) })).status).toBe(202)
      expect((await Effect.runPromise(proxied.router.view("hooks"))).behindProxy).toBe(true)
      // Not declared (the default): the server cannot tell, and the proxied caller passes as loopback.
      expect((await raw(`${P}/lan`, { port: ports[1]! })).status).toBe(200)
      expect((await Effect.runPromise(direct.router.view("hooks"))).behindProxy).toBe(false)
    } finally {
      for (const p of proxies) await new Promise<void>((resolve) => p.close(() => resolve()))
      await proxied.close()
      await direct.close()
    }
  })

  it("keep a route's total when many addresses come and go, and count an IPv6 /64 as one caller", () => {
    const limiter = makeRouteLimiterForTests(() => 1_000)
    let accepted = 0
    for (let i = 0; i < 6_000; i++) if (limiter.take("r", `10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, { perAddress: 30, total: 120 }).ok) accepted++
    expect(accepted).toBe(120)
    // After the route's total is reached no address window is even made.
    expect(limiter.sizes()).toEqual({ totals: 1, addresses: 120 })
    expect(rateKeyOf("2001:db8:1:2::1")).toBe(rateKeyOf("2001:db8:1:2:ffff:ffff:ffff:9"))
    expect(rateKeyOf("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64")
    expect(rateKeyOf("2001:db8:1:3::1")).not.toBe(rateKeyOf("2001:db8:1:2::1"))
    expect(rateKeyOf("::ffff:192.168.1.4")).toBe("192.168.1.4")
    expect(rateKeyOf("::1")).toBe("0:0:0:0::/64")
    const v6 = makeRouteLimiterForTests(() => 1_000)
    let fromOneHome = 0
    for (let i = 0; i < 100; i++) if (v6.take("r", rateKeyOf(`2001:db8:1:2::${i.toString(16)}`), { perAddress: 30, total: 120 }).ok) fromOneHome++
    expect(fromOneHome).toBe(30)
  })

  it("answer 503, not with a retired generation, when the module restarts or stops while the body arrives", async () => {
    const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: Number(new URL(base).port), path: `${P}/slow-body`, method: "POST", headers: { "Content-Length": "10" } }, (res) => {
        let text = ""
        res.on("data", (c) => (text += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }))
      })
      req.on("error", reject)
      req.write("ab")
      setTimeout(() => {
        void Effect.runPromise(Effect.andThen(host.disable("hooks"), host.enable("hooks"))).then(() => setTimeout(() => req.end("cdefghij"), 50))
      }, 100)
    })
    expect(await answer).toEqual({ status: 503, text: "The module restarted or stopped meanwhile; try again" })
    expect(probe.slowBody).toBe(0)
    // The new generation answers.
    expect(await raw(`${P}/slow-body`, { method: "POST", chunks: ["ab"] })).toMatchObject({ status: 200, text: "run 1" })
  })

  it("interrupt a handler when its shared part closes (503), instead of running on without its resources", async () => {
    const pending = raw(`${P}/busy`)
    for (let i = 0; i < 50 && probe.busy === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(probe.busy).toBe(1)
    const started = Date.now()
    await Effect.runPromise(host.disable("hooks"))
    const r = await pending
    expect(r).toMatchObject({ status: 503, text: "The module stopped while answering; try again" })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("answer 504 at the deadline even when the handler's cleanup is slow or its work uninterruptible", async () => {
    for (const path of ["hang", "stubborn"]) {
      const started = Date.now()
      expect(await raw(`${P}/${path}`)).toMatchObject({ status: 504, text: "The module did not answer in time" })
      expect(Date.now() - started, path).toBeLessThan(1_000)
    }
  })

  it("read a chunked body as it arrives: a small one passes, an oversized one is 413, and a route without a body refuses one", async () => {
    const { secret } = await mint()
    const auth = { ...bearer(secret), ...json }
    const small = await raw(`${P}/hook/a`, { method: "POST", headers: auth, chunks: ["{", "}"] })
    expect(small.status).toBe(202)
    expect(JSON.parse(small.text)).toMatchObject({ name: "a", body: {} })
    const big = await raw(`${P}/hook/a`, { method: "POST", headers: auth, chunks: ["{\"t\":\"", "x".repeat(40), "x".repeat(40), "\"}"] })
    expect(big).toMatchObject({ status: 413, text: "The body is larger than 64 bytes" })
    expect(await raw(`${P}/lan`, { headers: { "Transfer-Encoding": "chunked" }, chunks: ["a"] })).toMatchObject({ status: 413, text: "This address takes no body" })
  })

  it("send only final statuses: an informational or out-of-range one is a 500", async () => {
    for (const code of [100, 101, 103, 199, 600]) expect((await raw(`${P}/status/${code}`)).status, String(code)).toBe(500)
    expect(await raw(`${P}/status/200`)).toMatchObject({ status: 200, text: "done" })
    expect((await raw(`${P}/status/404`)).status).toBe(404)
  })

  it("refuse a response with an invalid header name or value (500), and log the status really sent", async () => {
    for (const kind of ["space", "control", "crlf"]) {
      const r = await raw(`${P}/header/${kind}`)
      expect(r.status, kind).toBe(500)
      expect(r.headers["set-cookie"], kind).toBeUndefined()
    }
    const view = await Effect.runPromise(router.view("hooks"))
    const calls = view.modules[0]!.routes.find((x) => x.path.endsWith("/header/:kind"))!.calls
    expect(calls.map((c) => c.status)).toEqual([500, 500, 500])
  })

  it("resolve dot segments before matching and stay under the module routes", async () => {
    expect((await raw(`${P}/x/../callback`)).status).toBe(200)
    expect((await raw("/api/modules/../module-routes")).status).toBe(404)
    expect((await raw(`${P}/%2e%2e/%2e%2e/admin`)).status).toBe(404)
  })

  it("keep the call log bounded across route generations (the least recently called route goes first)", async () => {
    const scope = Effect.runSync(Scope.make())
    let generation = 0
    const routeOf = (n: number): ModuleRoute => ({ method: "GET", path: `gen${n}`, public: true, handler: () => Effect.succeed({ status: 200 }) })
    let live: Array<PublishedRoute> = []
    const churn = await otherRouter({
      host: { routes: () => live, modules: () => [{ id: "churn" }] as never, pageText: (_id, text) => String(text), routeView: routeInfo }
    })
    try {
      for (; generation < 300; generation++) {
        live = [{ moduleId: "churn", route: routeOf(generation), scope, stopped: Effect.never }]
        expect((await raw(`/api/modules/churn/gen${generation}`, { port: churn.port })).status).toBe(200)
      }
      // The first generation's pattern comes back: its old calls were let go; the latest one's are kept.
      live = [{ moduleId: "churn", route: routeOf(0), scope, stopped: Effect.never }, { moduleId: "churn", route: routeOf(299), scope, stopped: Effect.never }]
      const view = await Effect.runPromise(churn.router.view("churn"))
      expect(view.modules[0]!.routes.map((r) => r.calls.length)).toEqual([0, 1])
    } finally {
      await churn.close()
    }
  })

  it("show route descriptions and call-log notes only through the host's page boundary (review round 2)", async () => {
    const scope = Effect.runSync(Scope.make())
    const live: Array<PublishedRoute> = [{
      moduleId: "said",
      route: { method: "GET", path: "x", guards: ["admin"], description: "Uses KEY", handler: () => Effect.succeed({ status: 200 }) },
      scope,
      stopped: Effect.never
    }]
    const seen: Array<string> = []
    const said = await otherRouter({
      host: {
        routes: () => live,
        modules: () => [{ id: "said" }] as never,
        pageText: (id, text, max) => {
          seen.push(`${id}:${max}`)
          return String(text).replaceAll("KEY", "[secret]")
        },
        // The host's own view of a route (the boundary on what the module declared).
        routeView: (id, r) => {
          seen.push(`view:${id}`)
          const view = routeInfo(id, r)
          return { ...view, ...(view.description !== undefined ? { description: view.description.replaceAll("KEY", "[secret]") } : {}) }
        }
      }
    })
    try {
      expect((await raw("/api/modules/said/x", { port: said.port })).status).toBe(401)
      const view = await Effect.runPromise(said.router.view("said"))
      expect(view.modules[0]!.routes[0]!.description).toBe("Uses [secret]")
      expect(view.modules[0]!.routes[0]!.calls[0]!.note).toBe("Log in to admin first")
      expect(seen).toEqual(["view:said", "said:120"])
    } finally {
      await said.close()
    }
  })

  it("mint only for installed modules (running or not), and never past the limit when mints race", async () => {
    await expect(Effect.runPromise(router.mint("not-installed", "hook", "x"))).rejects.toThrow(/There is no module "not-installed"/)
    await expect(Effect.runPromise(router.revoke("not-installed", "0123456789ab"))).rejects.toThrow(/no module/)
    await Effect.runPromise(host.disable("hooks"))
    expect((await Effect.runPromise(router.mint("hooks", "hook", "While stopped"))).token.label).toBe("While stopped")
    for (let i = 1; i < 19; i++) await mint(`caller ${i}`)
    const both = await Promise.allSettled([mint("last place A"), mint("last place B")])
    expect(both.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(String((both.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/at most 20 tokens/)
    expect((await Effect.runPromise(tokens.forModule("hooks").list)).length).toBe(20)
    // A stopped module's tokens are in the view (to be revoked).
    const view = await Effect.runPromise(router.view("hooks"))
    expect(view.modules[0]).toMatchObject({ moduleId: "hooks", running: false, routes: [] })
    expect(view.modules[0]!.tokens.length).toBe(20)
  })
})
