// Review round 3 of the net package: each finding's case, failing on the code before the fix.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { randomBytes } from "node:crypto"
import zlib from "node:zlib"
import { makeCachedJson, makeMemoryJsonCache } from "../src/CachedJson.ts"
import { NetAborted, NetFailure, NetHttpStatus, NetRefused } from "../src/Errors.ts"
import { contentTypes, safeFetch, type ConnectRequest, type SafeFetchOptions, type SafeResponse } from "../src/SafeFetch.ts"
import { bytes, chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}
const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
const json = (status: number, body: string, headers: Record<string, string> = {}) => reply(status, body, { "content-type": "application/json", ...headers })

describe("finding 1: a validator belongs to the URL its body came from", () => {
  it("the reviewer's case: /current moves from /old to /new, both with ETag \"1\"; the refresh is not a revalidation", async () => {
    let target = "/old"
    const connector = fakeConnector((r: ConnectRequest) => {
      if (r.url.pathname === "/current") return reply(302, "", { location: target })
      const tag = '"1"'
      if (r.headers["if-none-match"] === tag) return reply(304, "", { etag: tag })
      return json(200, JSON.stringify(r.url.pathname.slice(1)), { etag: tag })
    })
    let clock = 0
    const api = makeCachedJson({ now: () => clock, fetch: (url, o) => safeFetch(url, { ...o, resolver, connector }) })
    const first = await Effect.runPromise(api.getJson<string>("http://a.example/current", { ttlMs: 10 }))
    expect(first).toMatchObject({ value: "old", source: "network" })
    target = "/new"
    clock = 100
    const second = await Effect.runPromise(api.getJson<string>("http://a.example/current", { ttlMs: 10 }))
    expect(second).toMatchObject({ value: "new", source: "network" })
    // No conditional request went anywhere: the cached body came from /old, not from /current.
    expect(connector.requests.filter((r) => r.headers["if-none-match"] !== undefined)).toEqual([])
  })
  it("without a redirect the validator is sent to the same URL, and a 304 from it renews the entry", async () => {
    const connector = fakeConnector((r) => (r.headers["if-none-match"] === '"7"' ? reply(304, "", { etag: '"7"' }) : json(200, '"v"', { etag: '"7"' })))
    let clock = 0
    const api = makeCachedJson({ now: () => clock, fetch: (url, o) => safeFetch(url, { ...o, resolver, connector }) })
    await Effect.runPromise(api.getJson("http://a.example/x", { ttlMs: 10 }))
    clock = 100
    expect(await Effect.runPromise(api.getJson("http://a.example/x", { ttlMs: 10 }))).toMatchObject({ value: "v", source: "revalidated" })
    expect(connector.requests[1]!.headers["if-none-match"]).toBe('"7"')
  })
  it("safeFetch drops a caller's validator on a same-origin redirect: it is about the URL it was sent to", async () => {
    const connector = fakeConnector((r) => (r.url.pathname === "/a" ? reply(301, "", { location: "/b" }) : reply(200, "ok")))
    await Effect.runPromise(safeFetch("http://a.example/a", { accept: contentTypes.webPage, resolver, connector, headers: { "If-None-Match": '"1"', "x-keep": "1" } }))
    expect(connector.requests[0]!.headers["if-none-match"]).toBe('"1"')
    expect(connector.requests[1]!.headers["if-none-match"]).toBeUndefined()
    expect(connector.requests[1]!.headers["x-keep"]).toBe("1")
  })
  it("a 304 that comes from another URL than the cached body's is not a revalidation: the value is asked for again", async () => {
    const calls: Array<SafeFetchOptions> = []
    const answers: Array<SafeResponse> = []
    const r = (status: number, body: string, url: string, redirects: Array<string> = [], headers: Record<string, string> = {}): SafeResponse => ({
      url, status, headers, body: bytes(body), redirects, text: () => body, encoding: "identity", contentType: "application/json"
    })
    let clock = 0
    const api = makeCachedJson({ now: () => clock, fetch: (_url, o) => { calls.push(o); return Effect.succeed(answers.shift()!) } })
    answers.push(r(200, '"one"', "http://a.example/x", [], { etag: "e" }))
    await Effect.runPromise(api.getJson("http://a.example/x", { ttlMs: 10 }))
    clock = 100
    answers.push(r(304, "", "http://a.example/y", ["http://a.example/y"]), r(200, '"two"', "http://a.example/x", [], { etag: "e" }))
    expect(await Effect.runPromise(api.getJson("http://a.example/x", { ttlMs: 10 }))).toMatchObject({ value: "two", source: "network" })
    expect(calls[1]!.headers?.["if-none-match"]).toBe("e")
    expect(calls[2]!.headers?.["if-none-match"]).toBeUndefined()
    // A server that answers 304 even unconditionally is an error, never the old value.
    clock = 200
    answers.push(r(304, "", "http://a.example/y", ["http://a.example/y"]), r(304, "", "http://a.example/x"))
    expect(await errorOf(api.getJson("http://a.example/x", { ttlMs: 10 }))).toBeInstanceOf(NetHttpStatus)
  })
})

describe("finding 2: Content-Encoding deflate is the zlib format", () => {
  const fetchDeflate = (body: Uint8Array) =>
    safeFetch("http://a.example/", { accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, chunks(body), { "content-encoding": "deflate" })) })
  it("the reviewer's overlapping-prefix body (valid raw deflate, zlib-looking header) is refused, not misread", async () => {
    const body = Uint8Array.of(0x78, 0x01, 0x00, 0xfe, 0xff, 0x41, 0x03, 0x00)
    expect(zlib.inflateRawSync(body).toString()).toBe("A")
    const error = (await errorOf(fetchDeflate(body))) as NetRefused
    expect(error).toBeInstanceOf(NetRefused)
    expect(error.rule).toBe("content-encoding")
  })
  it("raw deflate is refused; zlib deflate is read", async () => {
    expect(((await errorOf(fetchDeflate(zlib.deflateRawSync("hello hello hello")))) as NetRefused).rule).toBe("content-encoding")
    expect((await Effect.runPromise(fetchDeflate(zlib.deflateSync("hello")))).text()).toBe("hello")
  })
})

describe("finding 3: header maps are canonicalised before they are merged", () => {
  it("a per-request header overrides a default whatever the case of either", async () => {
    const seen: Array<Readonly<Record<string, string>> | undefined> = []
    const api = makeCachedJson({
      headers: { Authorization: "default", "User-Agent": "ua" },
      fetch: (_url, o) => { seen.push(o.headers); return Effect.succeed({ url: "http://x/a", status: 200, headers: {}, body: bytes("1"), redirects: [], text: () => "1", encoding: "identity", contentType: "application/json" }) }
    })
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 0, headers: { authorization: "override" } }))
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 0, headers: { AUTHORIZATION: "again", "user-agent": "mine" } }))
    expect(seen[0]).toMatchObject({ authorization: "override", "user-agent": "ua" })
    expect(seen[1]).toMatchObject({ authorization: "again", "user-agent": "mine" })
  })
  it("a name twice in one map is still refused", async () => {
    const api = makeCachedJson({ fetch: () => Effect.die("not reached") })
    expect(((await errorOf(api.getJson("http://x/a", { ttlMs: 0, headers: { "X-A": "1", "x-a": "2" } }))) as NetRefused).rule).toBe("header")
    const client = makeCachedJson({ headers: { "X-A": "1", "x-a": "2" }, fetch: () => Effect.die("not reached") })
    expect(((await errorOf(client.getJson("http://x/a", { ttlMs: 0 }))) as NetRefused).rule).toBe("header")
  })
})

describe("finding 4: ordering survives eviction", () => {
  it("the reviewer's case: A starts, B stores, /b evicts /a, A finishes: A's older value is not stored", () => {
    const cache = makeMemoryJsonCache(1)
    const a = cache.sequence()
    const b = cache.sequence()
    expect(cache.setIfNewer("/a", { value: "new", storedAt: 0, sequence: b })).toBe(true)
    expect(cache.setIfNewer("/b", { value: "b", storedAt: 0, sequence: cache.sequence() })).toBe(true)
    expect(cache.get("/a")).toBeUndefined()
    expect(cache.setIfNewer("/a", { value: "old", storedAt: 0, sequence: a })).toBe(false)
    expect(cache.get("/a")).toBeUndefined()
    // A later write to it is stored.
    expect(cache.setIfNewer("/a", { value: "newest", storedAt: 0, sequence: cache.sequence() })).toBe(true)
  })
  it("with two clients sharing the cache, through getJson", async () => {
    const cache = makeMemoryJsonCache(1)
    const gates: Array<(v: SafeResponse) => void> = []
    const fetch = (url: string) => Effect.promise<SafeResponse>(() => new Promise((resolve) => { gates.push(resolve) })).pipe(Effect.map((r) => ({ ...r, url })))
    const ok = (body: string): SafeResponse => ({ url: "", status: 200, headers: {}, body: bytes(body), redirects: [], text: () => body, encoding: "identity", contentType: "application/json" })
    const one = makeCachedJson({ cache, fetch })
    const two = makeCachedJson({ cache, fetch })
    const slow = Effect.runPromise(one.getJson("http://x/a", { ttlMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 0))
    const fast = Effect.runPromise(two.getJson("http://x/a", { ttlMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 0))
    gates[1]!(ok('"new"'))
    await fast
    const evict = Effect.runPromise(two.getJson("http://x/b", { ttlMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 0))
    gates[2]!(ok('"b"'))
    await evict
    gates[0]!(ok('"old"'))
    await slow
    const next = Effect.runPromise(two.getJson("http://x/a", { ttlMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 0))
    // Not a cache hit on "old": a new request goes out.
    expect(gates).toHaveLength(4)
    gates[3]!(ok('"fresh"'))
    expect((await next).value).toBe("fresh")
  })
  it("when the fences overflow, the floor still refuses an older write to a key long gone", () => {
    const cache = makeMemoryJsonCache(1)
    const early = cache.sequence()
    for (let k = 0; k < 5; k++) cache.setIfNewer(`k${k}`, { value: k, storedAt: 0, sequence: cache.sequence() })
    expect(cache.setIfNewer("k0", { value: "old", storedAt: 0, sequence: early })).toBe(false)
    expect(cache.setIfNewer("never-seen", { value: "old", storedAt: 0, sequence: early })).toBe(false)
  })
})

describe("finding 5: an aborted signal fails also on a fresh hit", () => {
  it("populated, then called with an aborted signal within the TTL", async () => {
    const api = makeCachedJson({ fetch: () => Effect.succeed({ url: "http://x/a", status: 200, headers: {}, body: bytes("1"), redirects: [], text: () => "1", encoding: "identity", contentType: "application/json" }) })
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 60_000 }))
    expect(await errorOf(api.getJson("http://x/a", { ttlMs: 60_000, fetch: { signal: AbortSignal.abort() } }))).toBeInstanceOf(NetAborted)
  })
})

describe("finding 6: back-pressure waits do not pile up listeners", () => {
  it("1 MiB of incompressible gzip in 64 KiB chunks: no MaxListenersExceededWarning", async () => {
    const warnings: Array<string> = []
    const onWarning = (w: Error) => { warnings.push(w.name) }
    process.on("warning", onWarning)
    try {
      const plain = randomBytes(1 << 20)
      const gz = zlib.gzipSync(plain)
      const parts = Array.from({ length: Math.ceil(gz.byteLength / 65_536) }, (_, i) => new Uint8Array(gz.subarray(i * 65_536, (i + 1) * 65_536)))
      const res = await Effect.runPromise(safeFetch("http://a.example/", {
        accept: contentTypes.webPage, resolver, maxBytes: 4 << 20,
        connector: fakeConnector(() => reply(200, chunks(...parts), { "content-encoding": "gzip" }))
      }))
      expect(res.body.byteLength).toBe(1 << 20)
      await new Promise((r) => setTimeout(r, 10))
      expect(warnings.filter((w) => w === "MaxListenersExceededWarning")).toEqual([])
    } finally {
      process.off("warning", onWarning)
    }
  })
})

describe("finding 7: a stalled first address does not use up the deadline", () => {
  it("a black-holed IPv6 address, then a working IPv4 one: the second answers within the total time", async () => {
    const dual = fakeResolver({ "d.example": ["2606:4700:4700::1111", "1.1.1.1"] })
    const connector = fakeConnector((r) => (r.address.includes(":") ? new Promise(() => {}) : reply(200, "v4")))
    const started = Date.now()
    const res = await Effect.runPromise(safeFetch("http://d.example/", { accept: contentTypes.webPage, resolver: dual, connector, timeoutMs: 600 }))
    expect(res.text()).toBe("v4")
    expect(connector.requests.map((r) => r.address)).toEqual(["2606:4700:4700::1111", "1.1.1.1"])
    // The first attempt was cancelled when its share (half the time) ran out.
    expect(connector.requests[0]!.signal.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(600)
  })
  it("the connection that answered keeps its signal until the request ends", async () => {
    let seen: AbortSignal | undefined
    const connector = fakeConnector((r) => { seen = r.signal; return reply(200, "x") })
    await Effect.runPromise(safeFetch("http://a.example/", { accept: contentTypes.webPage, resolver, connector }))
    // Aborted only by the end of the request, as before.
    expect(seen?.aborted).toBe(true)
  })
})

describe("finding 9: durations that are not numbers count as 0", () => {
  it("a string TTL is no TTL, and a string stale window is no window", async () => {
    let clock = 0
    let fail = false
    const calls: Array<string> = []
    const api = makeCachedJson({
      now: () => clock,
      fetch: (url) => {
        calls.push(url)
        return fail ? Effect.fail(new NetFailure({ url, stage: "connect", detail: "down" })) : Effect.succeed({ url, status: 200, headers: {}, body: bytes("1"), redirects: [], text: () => "1", encoding: "identity", contentType: "application/json" })
      }
    })
    const bad = (v: unknown) => v as number
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: bad("1000") }))
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: bad("1000") }))
    expect(calls).toHaveLength(2)
    await Effect.runPromise(api.getJson("http://x/b", { ttlMs: 1000, staleIfErrorMs: bad("5000") }))
    clock = 6000
    fail = true
    expect(await errorOf(api.getJson("http://x/b", { ttlMs: 1000, staleIfErrorMs: bad("5000") }))).toBeInstanceOf(NetFailure)
    expect(await errorOf(api.getJson("http://x/b", { ttlMs: 1000, staleIfErrorMs: bad(true) }))).toBeInstanceOf(NetFailure)
  })
})
