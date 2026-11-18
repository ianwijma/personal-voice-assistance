// Review round 5 of PR 90 (5B-5): every ending of a module-route request is recorded exactly once in its call log; a
// caller that goes away is recorded as cancelled, and nothing is written to its closed socket.
import { defineModule, makeModuleHost, type ModuleHost, type ModuleRoute, readOnlyPersistence } from "@pva/core"
import { Context, Effect, Exit, Scope } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModuleRouter, ROUTE_CANCELLED_STATUS } from "../src/serve/moduleRoutes.ts"
import { makeRouteTokens } from "../src/serve/RouteTokens.ts"
import { openStore } from "./support/store.ts"

vi.setConfig({ testTimeout: 20_000 })

let dir: string
let scope: Scope.Closeable
const servers: Array<http.Server> = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pva-routes5-"))
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

const setup = async (routes: ReadonlyArray<ModuleRoute>) => {
  const store = await Effect.runPromise(openStore(join(dir, "data")))
  const tokens = makeRouteTokens({ store, locked: () => false })
  const mod = defineModule({ apiVersion: 2, id: "slow", name: "Slow", description: "", shared: () => Effect.succeed({ value: undefined, routes: [...routes] }), start: () => Effect.succeed({}) })
  const host: ModuleHost = await Effect.runPromise(makeModuleHost({
    catalog: [mod],
    persistence: readOnlyPersistence({ modules: { slow: { enabled: true } }, secrets: {} }),
    env: {},
    routeTokens: tokens,
    graceMs: 0
  }).pipe(Scope.provide(scope)))
  await Effect.runPromise(host.startEnabled)
  const router = makeModuleRouter({ host, admin: { enabled: false, check: () => undefined, touch: () => false }, tokens, services: Context.empty(), remoteAddress: () => "127.0.0.1" })
  const server = http.createServer((req, res) => router.handle(req, res))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  /** Start a request and return a function that aborts it (the caller goes away). */
  const start = (path: string, options: { method?: string; headers?: Record<string, string>; partialBody?: string } = {}) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: options.headers ?? {}, agent: false })
    req.on("error", () => {})
    if (options.partialBody !== undefined) {
      req.flushHeaders()
      req.write(options.partialBody)
    } else req.end()
    return () => req.destroy()
  }
  const calls = async (path: string) => {
    const view = await Effect.runPromise(router.view("slow"))
    return view.modules[0]!.routes.find((r) => r.path.endsWith(path))!.calls
  }
  return { start, calls }
}

describe("module routes: the call log has every ending once (5B-5)", () => {
  it("the caller goes away while the handler runs: one cancelled entry at once, still one after the handler's cleanup", async () => {
    const probe = { started: 0, cleaned: 0 }
    const t = await setup([{
      method: "GET",
      path: "hang",
      public: true,
      handler: () =>
        Effect.suspend(() => {
          probe.started++
          return Effect.never.pipe(Effect.onInterrupt(() => Effect.andThen(Effect.promise(() => sleep(300)), Effect.sync(() => void probe.cleaned++))))
        })
    }])
    const abort = t.start("/api/modules/slow/hang")
    for (let i = 0; i < 50 && probe.started < 1; i++) await sleep(10)
    expect(probe.started).toBe(1)
    abort()
    await sleep(50)
    const now = await t.calls("hang")
    expect(now).toHaveLength(1)
    expect(now[0]).toMatchObject({ status: ROUTE_CANCELLED_STATUS, note: "Cancelled: the caller went away before the answer" })
    await sleep(400)
    expect(probe.cleaned).toBe(1)
    expect(await t.calls("hang")).toHaveLength(1)
  })

  it("the caller goes away while the handler cleans up before its answer: one cancelled entry, also once the answer is ready", async () => {
    const probe = { cleaning: 0, done: 0 }
    const t = await setup([{
      method: "GET",
      path: "tidy",
      public: true,
      handler: () =>
        Effect.succeed({ status: 200, body: "ok" }).pipe(Effect.ensuring(Effect.andThen(Effect.sync(() => void probe.cleaning++), Effect.andThen(Effect.promise(() => sleep(300)), Effect.sync(() => void probe.done++)))))
    }])
    const abort = t.start("/api/modules/slow/tidy")
    for (let i = 0; i < 50 && probe.cleaning < 1; i++) await sleep(10)
    expect(probe.cleaning).toBe(1)
    abort()
    await sleep(50)
    expect(await t.calls("tidy")).toMatchObject([{ status: ROUTE_CANCELLED_STATUS }])
    await sleep(400)
    expect(probe.done).toBe(1)
    expect(await t.calls("tidy")).toHaveLength(1)
  })

  it("the caller goes away while its body is read: one cancelled entry, and the handler never runs", async () => {
    let ran = 0
    const t = await setup([{
      method: "POST",
      path: "hook",
      guards: ["lan"],
      body: "json",
      handler: () => Effect.sync(() => void ran++).pipe(Effect.as({ status: 204 }))
    } as ModuleRoute])
    const abort = t.start("/api/modules/slow/hook", { method: "POST", headers: { "content-type": "application/json", "content-length": "100" }, partialBody: "{\"a\":" })
    await sleep(100)
    abort()
    await sleep(100)
    expect(await t.calls("hook")).toMatchObject([{ status: ROUTE_CANCELLED_STATUS }])
    expect(ran).toBe(0)
  })
})
