// Review round 6 of the net package: each finding's case, failing on the code before the fix.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { makeCachedJson } from "../src/CachedJson.ts"
import { NetBadJson, NetRefused, NetTimeout } from "../src/Errors.ts"
import { contentTypes, fetchOwnerConfiguredLan, nodeConnector, safeFetch, type Connector, type SafeResponse } from "../src/SafeFetch.ts"
import { chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}
const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
const page = (connector: Connector) => safeFetch("http://a.example/x", { accept: contentTypes.webPage, resolver, connector })

describe("finding 1: more than one Content-Type is refused before the body is read", () => {
  it("one value that lists two media types (parameters, both orders)", async () => {
    for (const value of [
      "text/plain; charset=utf-8, application/octet-stream", "application/octet-stream, text/plain; charset=utf-8",
      "text/plain, application/octet-stream", "text/html; charset=utf-8, text/plain; format=flowed"
    ]) {
      let read = false
      async function* body() { read = true; yield new TextEncoder().encode("PAYLOAD") }
      const error = await errorOf(page(fakeConnector(() => reply(200, body(), { "content-type": value }))))
      expect(error, value).toBeInstanceOf(NetRefused)
      expect((error as NetRefused).rule, value).toBe("content-type")
      expect(read, value).toBe(false)
    }
  })
  it("a single type with a quoted parameter that contains a comma passes", async () => {
    const res = await Effect.runPromise(page(fakeConnector(() => reply(200, chunks("ok"), { "content-type": 'text/plain; title="a, b"; charset=utf-8' }))))
    expect(res.text()).toBe("ok")
    expect(res.contentType).toBe("text/plain")
  })
  it("two Content-Type lines through the real loopback connector, in both orders", async () => {
    for (const lines of [["text/plain", "application/octet-stream"], ["application/octet-stream", "text/plain"], ["text/plain; charset=utf-8", "application/octet-stream"]]) {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, [["Content-Type", lines[0]!], ["Content-Type", lines[1]!]])
        res.end("PAYLOAD")
      })
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
      try {
        const port = (server.address() as AddressInfo).port
        const error = await errorOf(fetchOwnerConfiguredLan(`http://pretend.example:${port}/`, {
          accept: contentTypes.webPage, resolver: async () => ["192.168.0.1"], connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
        }))
        expect(error, lines.join(" + ")).toBeInstanceOf(NetRefused)
        expect((error as NetRefused).rule).toBe("content-type")
      } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())) }
    }
  })
})

describe("finding 2: a deflate stream is known to be invalid from its first two bytes", () => {
  // Loopback server: sends the given bytes, then keeps the body open.
  const run = async (body: Uint8Array, timeoutMs: number) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "deflate" })
      res.write(body)
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const port = (server.address() as AddressInfo).port
      const started = Date.now()
      const error = await errorOf(fetchOwnerConfiguredLan(`http://pretend.example:${port}/`, {
        accept: contentTypes.webPage, timeoutMs, resolver: async () => ["192.168.0.1"], connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
      }))
      return { error, elapsed: Date.now() - started }
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())) }
  }
  it("one byte and then nothing ends at the deadline (README: the two-byte prefix is needed)", async () => {
    const { error, elapsed } = await run(Uint8Array.from([0x00]), 400)
    expect(error).toBeInstanceOf(NetTimeout)
    expect(elapsed).toBeGreaterThanOrEqual(350)
  })
  it("two invalid bytes are refused at once, the body still open", async () => {
    const { error, elapsed } = await run(Uint8Array.from([0x00, 0x00]), 5_000)
    expect(error).toBeInstanceOf(NetRefused)
    expect((error as NetRefused).rule).toBe("content-encoding")
    expect(elapsed).toBeLessThan(2_000)
  })
})

describe("finding 3: the same limits with different connectors do not share a request", () => {
  it("two requests and two distinct answers", async () => {
    const answer = (n: number) => ({ url: "x", status: 200, headers: {}, body: new Uint8Array(0), redirects: [], text: () => String(n), encoding: "identity", contentType: "application/json" }) as SafeResponse
    let calls = 0
    const c1 = fakeConnector(() => reply(200))
    const c2 = fakeConnector(() => reply(200))
    const api = makeCachedJson({
      fetch: (_url, o) => {
        calls++
        const n = o.connector === c1 ? 1 : 2
        return Effect.promise(() => new Promise<SafeResponse>((r) => setTimeout(() => r(answer(n)), 20)))
      }
    })
    const [a, b] = await Promise.all([
      Effect.runPromise(api.getJson("http://x/a", { ttlMs: 0, fetch: { connector: c1 } })),
      Effect.runPromise(api.getJson("http://x/a", { ttlMs: 0, fetch: { connector: c2 } }))
    ])
    expect(calls).toBe(2)
    expect([a.value, b.value]).toEqual([1, 2])
  })
})

describe("finding 4: NetBadJson carries nothing from the body", () => {
  it("a marker in the body is not in the message or the fields", async () => {
    const marker = "owner-secret-contact@example.com"
    const api = makeCachedJson({ fetch: () => Effect.succeed({ url: "x", status: 200, headers: {}, body: new Uint8Array(0), redirects: [], text: () => marker, encoding: "identity", contentType: "application/json" } as SafeResponse) })
    const error = await errorOf(api.getJson("http://a.example/x?q=1", { ttlMs: 0 }))
    expect(error).toBeInstanceOf(NetBadJson)
    expect((error as NetBadJson).message).not.toContain(marker)
    expect((error as NetBadJson).message).not.toContain("owner-")
    expect(JSON.stringify(error)).not.toContain("owner-")
  })
})
