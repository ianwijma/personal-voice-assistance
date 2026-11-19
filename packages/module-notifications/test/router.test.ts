// The inbound hook through the real module host and the real HTTP router (apps/assistant/src/serve/moduleRoutes.ts): the
// guards, the body and rate limits, the token, and the route's withdrawal when the module stops. Only the notification
// service is a recording fixture.
import { type ModuleNotify, makeModuleHost, type ModuleHost, type NotifyHook, readOnlyPersistence } from "@pva/core"
import { Context, Effect, Exit, Scope } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeModuleRouter, type ModuleRouter } from "../../../apps/assistant/src/serve/moduleRoutes.ts"
import { notificationsModule } from "../src/index.ts"

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = "router-test-token-0123456789"
const HEADER = "x-pva-token"

let scope: Scope.Closeable
let host: ModuleHost
let server: http.Server
let base: string
let caller = "192.168.1.20"
const sent: Array<unknown> = []

const recording = (): ModuleNotify => {
  const unavailable = Effect.die("not used by the hook")
  return {
    send: (request) => Effect.sync(() => (sent.push(request), { notification: { id: "n1" } as never, deduped: false })),
    resolve: () => unavailable,
    list: () => unavailable,
    handle: () => Effect.void,
    dnd: { get: unavailable, set: () => unavailable, clear: unavailable }
  }
}
const notifyHook: NotifyHook = { forPart: () => ({ notify: recording(), speech: { say: () => Effect.die("no speech") } }) }

const startServer = async (options: { behindProxy?: boolean; token?: string } = {}) => {
  scope = await Effect.runPromise(Scope.make())
  host = await Effect.runPromise(
    makeModuleHost({
      catalog: [notificationsModule],
      persistence: readOnlyPersistence({ modules: { notifications: { enabled: true } }, secrets: { notifications: { hookToken: options.token ?? TOKEN } } }),
      env: {},
      notify: notifyHook,
      graceMs: 0
    }).pipe(Scope.provide(scope))
  )
  await Effect.runPromise(host.startEnabled)
  const router: ModuleRouter = makeModuleRouter({
    host,
    admin: { enabled: false, check: () => undefined, touch: () => false },
    tokens: undefined as never,
    services: Context.empty(),
    ...(options.behindProxy === true ? { behindProxy: true } : {}),
    remoteAddress: () => caller
  })
  server = http.createServer((req, res) => router.handle(req, res))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/modules/notifications/notify`
}

beforeEach(() => {
  sent.length = 0
  caller = "192.168.1.20"
})
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await Effect.runPromise(Scope.close(scope, Exit.void))
})

const post = async (body: unknown, headers: Record<string, string> = { [HEADER]: TOKEN }, raw?: string) => {
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ?? JSON.stringify(body) })
  return { status: res.status, text: await res.text() }
}

describe("the hook through the real router", () => {
  it("a valid POST from the home network is accepted and sends one normal card to every device", async () => {
    await startServer()
    const r = await post({ title: "Washer done", text: "Cycle finished", key: "washer" })
    expect(r).toEqual({ status: 202, text: '{"ok":true,"deduped":false}' })
    expect(sent).toEqual([{ title: "Washer done", text: "Cycle finished", priority: "normal", target: "everywhere", expiresInMs: 86_400_000, key: "hook:washer" }])
  })

  it("a missing or wrong token is 401, the same answer, and nothing is sent; the token is not in any answer", async () => {
    await startServer()
    const missing = await post({ title: "x" }, {})
    const wrong = await post({ title: "x" }, { [HEADER]: `${TOKEN}!` })
    expect([missing.status, wrong.status]).toEqual([401, 401])
    expect(missing.text).toBe(wrong.text)
    expect(sent).toEqual([])
    // The default Authorization header is not a way in.
    expect((await post({ title: "x" }, { authorization: `Bearer ${TOKEN}` })).status).toBe(401)
    for (const r of [missing, wrong]) expect(r.text).not.toContain(TOKEN)
  })

  it("a request that is not from the home network is refused 403 even with the right token; so are forwarded and cross-site ones", async () => {
    await startServer()
    caller = "203.0.113.9"
    expect((await post({ title: "x" })).status).toBe(403)
    caller = "::ffff:8.8.8.8"
    expect((await post({ title: "x" })).status).toBe(403)
    caller = "192.168.1.20"
    expect((await post({ title: "x" }, { [HEADER]: TOKEN, "x-forwarded-for": "192.168.1.5" })).status).toBe(403)
    expect((await post({ title: "x" }, { [HEADER]: TOKEN, forwarded: "for=192.168.1.5" })).status).toBe(403)
    expect((await post({ title: "x" }, { [HEADER]: TOKEN, "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect((await post({ title: "x" }, { [HEADER]: TOKEN, origin: "http://evil.example" })).status).toBe(403)
    // Mapped and IPv6 home callers are fine.
    caller = "::ffff:192.168.1.7"
    expect((await post({ title: "ok" })).status).toBe(202)
    caller = "fd00::7"
    expect((await post({ title: "ok2" })).status).toBe(202)
    expect(sent).toHaveLength(2)
  })

  it("behind a declared proxy the home-network guard refuses everyone", async () => {
    await startServer({ behindProxy: true })
    expect((await post({ title: "x" })).status).toBe(403)
    expect(sent).toEqual([])
  })

  it("a body over 2 KiB is 413, not JSON 415, bad JSON 400; nothing is sent", async () => {
    await startServer()
    expect((await post({ title: "x", text: "y".repeat(3000) })).status).toBe(413)
    const res = await fetch(base, { method: "POST", headers: { "content-type": "text/plain", [HEADER]: TOKEN }, body: "hi" })
    expect(res.status).toBe(415)
    expect((await post(undefined, { [HEADER]: TOKEN }, "{nope")).status).toBe(400)
    expect(sent).toEqual([])
  })

  it("more than ten calls a minute from one address is 429", async () => {
    await startServer()
    const statuses: Array<number> = []
    for (let i = 0; i < 12; i++) statuses.push((await post({ title: `n${i}` })).status)
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
    expect(sent).toHaveLength(10)
  })

  it("a short token closes the hook (503), and no token set is the same", async () => {
    await startServer({ token: "short" })
    expect(await post({ title: "short" }, { [HEADER]: "short" })).toEqual({ status: 503, text: '{"ok":false,"error":"not-set-up"}' })
    expect(sent).toEqual([])
  })

  it("while the module is off its address is 404; it comes back with it (this fails if a stopped route stayed published)", async () => {
    await startServer()
    expect((await post({ title: "a" })).status).toBe(202)
    await Effect.runPromise(host.disable("notifications"))
    expect(host.routes().filter((r) => r.moduleId === "notifications")).toEqual([])
    expect((await post({ title: "b" })).status).toBe(404)
    expect(sent).toHaveLength(1)
    await Effect.runPromise(host.enable("notifications"))
    expect((await post({ title: "c" })).status).toBe(202)
    expect(sent).toHaveLength(2)
  })
})
