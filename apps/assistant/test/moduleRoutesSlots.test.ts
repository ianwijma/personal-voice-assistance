// Review round 4 of PR 90 (module routes in serve mode): handlers run in slots of their module (at most
// MAX_ROUTE_SLOTS at once, however they ended), the answer never waits for a handler's cleanup, and behind a proxy
// the same-origin check ignores the scheme and compares the Origin's host and port with Host.
import { defineModule, makeIssueRegistry, makeModuleHost, MAX_ROUTE_SLOTS, type ModuleHost, type ModuleRoute, readOnlyPersistence } from "@pva/core"
import { Context, Effect, Exit, Scope } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { crossSiteReason, makeModuleRouter, type ModuleRouter, ROUTE_BUSY_RETRY_S } from "../src/serve/moduleRoutes.ts"
import { makeRouteTokens, type RouteTokenKeeper } from "../src/serve/RouteTokens.ts"
import type { SettingsStore } from "../src/serve/SettingsStore.ts"
import { openVault, type Vault } from "../src/serve/Vault.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

const PASSWORD = "correct horse battery"

let dir: string
let vault: Vault
let store: SettingsStore
let tokens: RouteTokenKeeper
let scope: Scope.Closeable
const servers: Array<http.Server> = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pva-routes4-"))
  vault = await openVault({ path: join(dir, "vault.enc"), kdf: { N: 2 ** 12, r: 8, p: 1 } })
  expect((await vault.setup(PASSWORD, { modules: {}, assistant: {} })).ok).toBe(true)
  store = await Effect.runPromise(openStore(join(dir, "data"), { vault }))
  tokens = makeRouteTokens({ store, locked: () => vault.state() === "locked" })
  scope = await Effect.runPromise(Scope.make())
})

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
  await Effect.runPromise(Scope.close(scope, Exit.void))
  rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Reply {
  readonly status: number
  readonly text: string
  readonly retryAfter: string | undefined
}

const serve = async (host: ModuleHost, extra: Partial<Parameters<typeof makeModuleRouter>[0]> = {}) => {
  const router: ModuleRouter = makeModuleRouter({
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
  /** A request with any headers (Host and Origin included); `signal` aborts it (the caller goes away). */
  const request = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {}, agent: false }, (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (c: string) => (text += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text, retryAfter: res.headers["retry-after"] as string | undefined }))
        res.on("error", reject)
      })
      req.on("error", reject)
      options.signal?.addEventListener("abort", () => req.destroy(new Error("aborted")))
      req.end(options.body)
    })
  return { router, request }
}

const hostOf = async (mod: Parameters<typeof makeModuleHost>[0]["catalog"][number], options: { graceMs?: number; stopTimeoutMs?: number } = {}) => {
  const host = await Effect.runPromise(makeModuleHost({
    catalog: [mod],
    persistence: readOnlyPersistence({ modules: { [mod.id]: { enabled: true } }, secrets: {} }),
    env: {},
    routeTokens: tokens,
    graceMs: options.graceMs ?? 0,
    ...(options.stopTimeoutMs !== undefined ? { stopTimeoutMs: options.stopTimeoutMs } : {})
  }).pipe(Scope.provide(scope)))
  await Effect.runPromise(host.startEnabled)
  return host
}

/** A handler that never answers; asked to stop, it cleans up for `cleanupMs`. `probe` counts it from start to the end of its cleanup. */
const slowHandler = (probe: { active: number; max: number; cleaned: number; interrupted: number }, cleanupMs: number): ModuleRoute["handler"] => () =>
  Effect.suspend(() => {
    probe.active++
    probe.max = Math.max(probe.max, probe.active)
    return Effect.never.pipe(
      Effect.onInterrupt(() => Effect.andThen(Effect.sync(() => void probe.interrupted++), Effect.promise(() => sleep(cleanupMs)))),
      Effect.ensuring(Effect.sync(() => {
        probe.active--
        probe.cleaned++
      }))
    )
  })

const newProbe = () => ({ active: 0, max: 0, cleaned: 0, interrupted: 0 })

const slowModule = (probe: ReturnType<typeof newProbe>, cleanupMs: number, timeoutMs: number) =>
  defineModule({
    apiVersion: 2,
    id: "slow",
    name: "Slow",
    description: "Slow cleanup",
    shared: () =>
      Effect.succeed({
        value: undefined,
        routes: [{
          method: "GET",
          path: "hang",
          public: true,
          timeoutMs,
          rateLimit: { perAddress: 200, total: 400 },
          handler: slowHandler(probe, cleanupMs)
        } satisfies ModuleRoute]
      }),
    start: () => Effect.succeed({})
  })

const busyIssue = (issues: ReturnType<typeof makeIssueRegistry>) => issues.all().find((i) => i.id === "slow.routes-busy")

describe("route handlers run in slots (review round 4)", () => {
  it("thirty concurrent requests against a handler with slow cleanup never have more than MAX_ROUTE_SLOTS running; the rest get 503 with Retry-After, and it recovers", async () => {
    expect(MAX_ROUTE_SLOTS).toBe(16)
    const probe = newProbe()
    const issues = makeIssueRegistry()
    const host = await hostOf(slowModule(probe, 1_500, 200))
    const { request } = await serve(host, { issues })
    const replies = await Promise.all(Array.from({ length: 30 }, () => request("/api/modules/slow/hang")))
    const timedOut = replies.filter((r) => r.status === 504)
    const busy = replies.filter((r) => r.status === 503)
    expect(timedOut.length).toBe(MAX_ROUTE_SLOTS)
    expect(busy.length).toBe(30 - MAX_ROUTE_SLOTS)
    for (const r of busy) {
      expect(r.text).toBe("The module is busy with earlier requests; try again later")
      expect(r.retryAfter).toBe(String(ROUTE_BUSY_RETRY_S))
    }
    expect(probe.max).toBe(MAX_ROUTE_SLOTS)
    // Answered at their deadline, still cleaning up: their slots are taken, so a new request is refused too.
    expect(probe.cleaned).toBe(0)
    expect((await request("/api/modules/slow/hang")).status).toBe(503)
    expect(busyIssue(issues)).toMatchObject({ module: "slow", severity: "warning" })
    // Unknown paths are still 404 first.
    expect((await request("/api/modules/slow/nope")).status).toBe(404)
    await sleep(1_800)
    expect(probe.cleaned).toBe(MAX_ROUTE_SLOTS)
    expect(busyIssue(issues)).toBeUndefined()
    expect((await request("/api/modules/slow/hang")).status).toBe(504)
    expect(probe.max).toBe(MAX_ROUTE_SLOTS)
  })

  it("a caller that disconnects keeps its slot until the handler's cleanup has ended", async () => {
    const probe = newProbe()
    const issues = makeIssueRegistry()
    const host = await hostOf(slowModule(probe, 1_500, 30_000))
    const { request } = await serve(host, { issues })
    const aborts = Array.from({ length: MAX_ROUTE_SLOTS }, () => new AbortController())
    const pending = aborts.map((a) => request("/api/modules/slow/hang", { signal: a.signal }).catch(() => "gone"))
    for (let i = 0; i < 50 && probe.active < MAX_ROUTE_SLOTS; i++) await sleep(20)
    expect(probe.active).toBe(MAX_ROUTE_SLOTS)
    // Long before their 30 s deadline, every caller goes away.
    for (const a of aborts) a.abort()
    expect(await Promise.all(pending)).toEqual(aborts.map(() => "gone"))
    for (let i = 0; i < 50 && probe.interrupted < MAX_ROUTE_SLOTS; i++) await sleep(20)
    expect(probe.interrupted).toBe(MAX_ROUTE_SLOTS)
    expect(probe.cleaned).toBe(0)
    // Their handlers are cleaning up: the slots are still taken.
    const refused = await request("/api/modules/slow/hang")
    expect(refused.status).toBe(503)
    expect(refused.retryAfter).toBe(String(ROUTE_BUSY_RETRY_S))
    expect(busyIssue(issues)).toBeDefined()
    await sleep(1_800)
    expect(probe.cleaned).toBe(MAX_ROUTE_SLOTS)
    expect(busyIssue(issues)).toBeUndefined()
    // Admitted again (and cancelled again, to end the test).
    const last = new AbortController()
    const admitted = request("/api/modules/slow/hang", { signal: last.signal }).catch(() => "gone")
    for (let i = 0; i < 50 && probe.active < 1; i++) await sleep(20)
    expect(probe.active).toBe(1)
    last.abort()
    await admitted
    await sleep(1_700)
  })

  it("a stop answers 503 right after the grace period while the handler's cleanup still runs", async () => {
    const probe = newProbe()
    const host = await hostOf(slowModule(probe, 2_000, 10_000), { graceMs: 200, stopTimeoutMs: 5_000 })
    const { request } = await serve(host)
    const reply = request("/api/modules/slow/hang")
    for (let i = 0; i < 50 && probe.active < 1; i++) await sleep(20)
    const started = Date.now()
    const disabled = Effect.runPromise(host.disable("slow"))
    const answered = await reply
    const ms = Date.now() - started
    expect(answered).toMatchObject({ status: 503, text: "The module stopped while answering; try again" })
    expect(ms).toBeGreaterThanOrEqual(150)
    expect(ms).toBeLessThan(1_500)
    // The answer did not wait for the cleanup, nor for the stop to finish.
    expect(probe.cleaned).toBe(0)
    expect((await disabled).ok).toBe(true)
    expect(probe.cleaned).toBe(1)
  })
})

describe("the same-origin check behind a proxy (review round 4)", () => {
  const hooks = defineModule({
    apiVersion: 2,
    id: "site",
    name: "Site",
    description: "A browser POST",
    shared: () =>
      Effect.succeed({
        value: undefined,
        routes: [{ method: "POST", path: "hook", guards: ["token"], token: "hook", handler: () => Effect.succeed({ status: 202 }) } satisfies ModuleRoute]
      }),
    start: () => Effect.succeed({})
  })

  it("the documented Caddy case passes with a valid token; a sibling port, a foreign origin and a null origin are refused; no forwarding header is read", async () => {
    const host = await hostOf(hooks)
    const { request, router } = await serve(host, { behindProxy: true })
    const { secret } = await Effect.runPromise(router.mint("site", "hook", "browser"))
    const post = (headers: Record<string, string>) =>
      request("/api/modules/site/hook", { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Sec-Fetch-Site": "same-origin", ...headers } })
    // Caddy terminates TLS and passes Host through: the browser's https origin reaches a plain-http server.
    expect((await post({ Host: "assistant.example", Origin: "https://assistant.example" })).status).toBe(202)
    expect((await post({ Host: "assistant.example:8443", Origin: "https://assistant.example:8443" })).status).toBe(202)
    expect((await post({ Host: "Assistant.Example", Origin: "https://assistant.example" })).status).toBe(202)
    for (
      const origin of [
        "https://assistant.example:8443",
        "https://other.example",
        "https://assistant.example.evil",
        "null",
        "assistant.example",
        "https://assistant.example/"
      ]
    ) {
      const refused = await post({ Host: "assistant.example", Origin: origin })
      expect(refused, origin).toMatchObject({ status: 403, text: "Requests from another site are refused" })
    }
    // Forwarding headers change nothing: neither a forwarded host nor a forwarded scheme is believed.
    expect((await post({ Host: "assistant.example", Origin: "https://other.example", "X-Forwarded-Host": "other.example", Forwarded: "host=other.example;proto=https" })).status).toBe(403)
    expect((await post({ Host: "internal:8787", Origin: "https://assistant.example", "X-Forwarded-Host": "assistant.example" })).status).toBe(403)
    // Without the setting nothing changes: the scheme counts.
    const direct = await serve(host)
    expect((await direct.request("/api/modules/site/hook", { method: "POST", headers: { Authorization: `Bearer ${secret}`, Host: "assistant.example", Origin: "https://assistant.example" } })).status).toBe(403)
    expect((await direct.request("/api/modules/site/hook", { method: "POST", headers: { Authorization: `Bearer ${secret}`, Host: "assistant.example", Origin: "http://assistant.example" } })).status).toBe(202)
  })

  it("crossSiteReason on its own", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as http.IncomingMessage
    expect(crossSiteReason(req({ host: "a.example", origin: "https://a.example" }), "http", true)).toBeUndefined()
    expect(crossSiteReason(req({ host: "a.example", origin: "https://a.example" }), "http")).toBeDefined()
    expect(crossSiteReason(req({ origin: "https://" }), "http", true)).toBeDefined()
    expect(crossSiteReason(req({ host: "a.example", origin: "https://a.example", "sec-fetch-site": "cross-site" }), "http", true)).toBeDefined()
  })
})
