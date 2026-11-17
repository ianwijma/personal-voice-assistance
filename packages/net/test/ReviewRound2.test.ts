// Regression tests for the second review of the modules P2 helpers (PR #88), @pva/net. Each describe names its finding. No network:
// fakes, and sockets on this machine's loopback interface only (see NodeConnector.loopback.test.ts).
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import http from "node:http"
import type { AddressInfo } from "node:net"
import zlib from "node:zlib"
import { makeCachedJson, makeMemoryJsonCache } from "../src/CachedJson.ts"
import { NetAborted, NetFailure, NetRefused } from "../src/Errors.ts"
import { contentTypes, fetchOwnerConfiguredLan, nodeConnector, safeFetch, type SafeResponse } from "../src/SafeFetch.ts"
import { bytes, chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  return exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : undefined)).find((e) => e !== undefined)
}
const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })

/** Every unhandled rejection while `run` and a little after it, so one that surfaces late is seen too. */
const unhandledDuring = async (run: () => Promise<unknown>): Promise<Array<unknown>> => {
  const seen: Array<unknown> = []
  const listener = (reason: unknown) => { seen.push(reason) }
  process.on("unhandledRejection", listener)
  try {
    await run()
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    process.off("unhandledRejection", listener)
  }
  return seen
}

describe("finding 1: an already-aborted fetch starts nothing and leaves no unhandled rejection", () => {
  it("the reviewer's case: a pre-aborted signal with the real connector", async () => {
    let dialled = false
    const seen = await unhandledDuring(async () => {
      const error = await errorOf(safeFetch("http://8.8.8.8/", {
        accept: contentTypes.webPage, signal: AbortSignal.abort(),
        connector: (r) => { dialled = true; return nodeConnector({ ...r, address: "127.0.0.1" }) }
      }))
      expect(error).toBeInstanceOf(NetAborted)
    })
    expect(dialled).toBe(false)
    expect(seen).toEqual([])
  })
  it("a connector or a resolver that rejects after the race is lost is handled", async () => {
    const seen = await unhandledDuring(async () => {
      const controller = new AbortController()
      const late = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), ms))
      const pending = Effect.runPromiseExit(safeFetch("http://a.example/", { accept: contentTypes.webPage, signal: controller.signal, resolver, connector: () => late(20) }))
      setTimeout(() => controller.abort(), 5)
      expect(Exit.isFailure(await pending)).toBe(true)
      const controller2 = new AbortController()
      const pending2 = Effect.runPromiseExit(safeFetch("http://a.example/", { accept: contentTypes.webPage, signal: controller2.signal, resolver: () => late(20) }))
      setTimeout(() => controller2.abort(), 5)
      expect(Exit.isFailure(await pending2)).toBe(true)
    })
    expect(seen).toEqual([])
  })
  it("a real connection aborted while it is being made leaves nothing behind", async () => {
    const server = http.createServer((_req, res) => { setTimeout(() => res.end("late"), 100) })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    try {
      const seen = await unhandledDuring(async () => {
        const controller = new AbortController()
        const pending = Effect.runPromiseExit(fetchOwnerConfiguredLan(`http://pretend.example:${port}/`, {
          accept: contentTypes.webPage, signal: controller.signal, resolver: async () => ["192.168.0.1"], connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
        }))
        setTimeout(() => controller.abort(), 10)
        expect(Exit.isFailure(await pending)).toBe(true)
        await new Promise((r) => setTimeout(r, 150))
      })
      expect(seen).toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe("finding 19: a compressed body decodes whatever its chunk boundaries", () => {
  const text = "hello world, ".repeat(40)
  const fetchWith = (encoding: string, parts: ReadonlyArray<Uint8Array>) =>
    Effect.runPromise(safeFetch("http://a.example/", {
      accept: contentTypes.webPage, resolver,
      connector: fakeConnector(() => reply(200, chunks(...parts), { "content-encoding": encoding }))
    }))
  const bodies: ReadonlyArray<readonly [string, string, Uint8Array]> = [
    ["deflate", "zlib-wrapped", zlib.deflateSync(text)], ["gzip", "gzip", zlib.gzipSync(text)], ["br", "brotli", zlib.brotliCompressSync(text)]
  ]
  for (const [encoding, kind, body] of bodies) {
    it(`${kind}: split at every byte once, and into single bytes`, async () => {
      for (let at = 0; at <= body.byteLength; at++) {
        const r: SafeResponse = await fetchWith(encoding, [body.subarray(0, at), body.subarray(at)])
        expect(r.text(), `${kind} split at ${at}`).toBe(text)
      }
      const single = await fetchWith(encoding, [...body].map((b) => Uint8Array.of(b)))
      expect(single.text()).toBe(text)
      // Empty chunks in front and in between change nothing.
      const empty = await fetchWith(encoding, [new Uint8Array(0), body.subarray(0, 1), new Uint8Array(0), body.subarray(1)])
      expect(empty.text()).toBe(text)
    })
  }
  it("the reviewer's case: zlib.deflateSync(\"hello world\") as its first byte and the rest", async () => {
    const body = zlib.deflateSync("hello world")
    expect((await fetchWith("deflate", [body.subarray(0, 1), body.subarray(1)])).text()).toBe("hello world")
  })
  it("an empty deflate body is an empty body, and one that is not a zlib stream is refused (review round 3: deflate is zlib)", async () => {
    expect((await fetchWith("deflate", [])).text()).toBe("")
    const error = await errorOf(safeFetch("http://a.example/", { accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, chunks(bytes("x")), { "content-encoding": "deflate" })) }))
    expect(error).toBeInstanceOf(NetRefused)
    expect((error as NetRefused).rule).toBe("content-encoding")
  })
})

describe("finding 18: refreshes are ordered by a sequence, not by the clock", () => {
  const json = (body: string): SafeResponse => ({ url: "x", status: 200, headers: {}, body: bytes(body), redirects: [], text: () => body, encoding: "identity", contentType: "application/json" })
  it("the reviewer's case: two clients, one cache, the same millisecond: the older request does not overwrite the newer answer", async () => {
    const cache = makeMemoryJsonCache()
    let release!: () => void
    const slow = makeCachedJson({ cache, now: () => 1000, fetch: () => Effect.promise(() => new Promise<void>((r) => { release = r })).pipe(Effect.as(json('"old"'))) })
    const fast = makeCachedJson({ cache, now: () => 1000, fetch: () => Effect.succeed(json('"new"')) })
    const pending = Effect.runPromise(slow.getJson("http://x/a", { ttlMs: 10 }))
    await new Promise((r) => setTimeout(r, 5))
    await Effect.runPromise(fast.getJson("http://x/a", { ttlMs: 10 }))
    release()
    expect((await pending).value).toBe("old") // its caller gets what it fetched
    expect(await Effect.runPromise(fast.getJson("http://x/a", { ttlMs: 10 }))).toMatchObject({ value: "new", source: "cache" })
    expect(await Effect.runPromise(slow.getJson("http://x/a", { ttlMs: 10 }))).toMatchObject({ value: "new", source: "cache" })
  })
  it("within one client: separate flights (different limits) keep the newer answer, also with a clock that goes back", async () => {
    const cache = makeMemoryJsonCache()
    const clock = { t: 5000 }
    let release!: () => void
    let call = 0
    const api = makeCachedJson({
      cache, now: () => clock.t,
      fetch: () => (++call === 1 ? Effect.promise(() => new Promise<void>((r) => { release = r })).pipe(Effect.as(json('"old"'))) : Effect.succeed(json('"new"')))
    })
    const pending = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 10_000, fetch: { maxBytes: 100 } }))
    await new Promise((r) => setTimeout(r, 5))
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 10_000, fetch: { maxBytes: 200 } }))
    clock.t -= 3000 // the older request finishes "earlier" by the clock: the clock does not order them
    release()
    await pending
    clock.t += 3000
    expect(await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 10_000, fetch: { maxBytes: 300 } }))).toMatchObject({ value: "new", source: "cache" })
    expect(call).toBe(2)
  })
  it("the memory cache's sequence only goes up, and an entry is replaced only by a later one", () => {
    const cache = makeMemoryJsonCache()
    const a = cache.sequence()
    const b = cache.sequence()
    expect(b).toBeGreaterThan(a)
    expect(cache.setIfNewer("k", { value: "b", storedAt: 0, sequence: b })).toBe(true)
    expect(cache.setIfNewer("k", { value: "a", storedAt: 99, sequence: a })).toBe(false)
    expect(cache.setIfNewer("k", { value: "b again", storedAt: 0, sequence: b })).toBe(false)
    expect(cache.get("k")?.value).toBe("b")
  })
})

describe("web-search §13, rule by rule (self-review)", () => {
  const fetchType = (type: string) => safeFetch("http://a.example/", { accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, "x", { "content-type": type })) })
  it("rule 5: a web page is text/html, text/plain or application/pdf, nothing else", async () => {
    for (const type of ["text/html; charset=utf-8", "text/plain", "application/pdf"]) expect((await Effect.runPromise(fetchType(type))).status, type).toBe(200)
    for (const type of ["application/xhtml+xml", "image/svg+xml", "application/javascript", "text/xml", "application/octet-stream"])
      expect(((await errorOf(fetchType(type))) as { rule?: string }).rule, type).toBe("content-type")
  })
})
