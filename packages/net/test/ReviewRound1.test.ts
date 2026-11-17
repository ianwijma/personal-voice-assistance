// Regression tests for the first review of the modules P2 helpers (PR #88). Each describe names its finding. No network: fakes only.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { validateHeaderValue } from "node:http"
import zlib from "node:zlib"
import { classifyAddress } from "../src/Address.ts"
import { makeCachedJson, makeMemoryJsonCache } from "../src/CachedJson.ts"
import { NetAborted, NetFailure, NetRefused, NetTimeout, NetTooLarge } from "../src/Errors.ts"
import { contentTypes, safeFetch, type SafeFetchOptions, type SafeResponse } from "../src/SafeFetch.ts"
import { userAgent } from "../src/UserAgent.ts"
import { bytes, chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  return exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : undefined)).find((e) => e !== undefined)
}
const page = (o: Omit<SafeFetchOptions, "accept">): SafeFetchOptions => ({ accept: contentTypes.webPage, ...o })
const resolver = fakeResolver({ "a.example": ["8.8.8.8"], "b.example": ["8.8.4.4"], "doc6.example": ["3fff::1"] })

describe("finding 2: the non-public list is the IANA registries", () => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["3fff::1", "documentation"], ["3fff:fff:ffff::1", "documentation"], ["3fff:1000::1", "public"], ["3ff0::1", "public"],
    ["192.0.0.9", "reserved"], ["192.0.0.170", "reserved"], ["198.18.0.1", "reserved"], ["198.19.255.255", "reserved"], ["192.88.99.1", "reserved"], ["240.0.0.1", "reserved"],
    ["64:ff9b:1::1", "reserved"], ["100::1", "reserved"], ["100:0:0:1::1", "reserved"], ["5f00::1", "reserved"], ["2001:2::1", "reserved"], ["2001:10::1", "reserved"], ["2001::1", "reserved"],
    ["fec0::1", "private"], ["::ffff:0:a00:1", "reserved"], ["::a00:1", "reserved"], ["4000::1", "reserved"],
    // Globally reachable by the registries: left public.
    ["192.31.196.1", "public"], ["192.52.193.1", "public"], ["192.175.48.1", "public"], ["2620:4f:8000::1", "public"], ["2001:4860:4860::8888", "public"]
  ]
  for (const [address, klass] of rows) it(`${address} is ${klass}`, () => expect(classifyAddress(address)?.class).toBe(klass))
  it("a literal, a DNS answer and a redirect into 3fff::/20 are refused", async () => {
    const connector = fakeConnector((r) => (r.url.hostname === "a.example" ? reply(302, "", { location: "http://[3fff::1]/" }) : reply(200, "leak")))
    for (const url of ["http://[3fff::1]/", "http://doc6.example/", "http://a.example/"]) {
      const error = (await errorOf(safeFetch(url, page({ resolver, connector })))) as NetRefused
      expect(error).toBeInstanceOf(NetRefused)
      expect(error.addressClass).toBe("documentation")
    }
    expect(connector.requests.map((r) => r.address)).toEqual(["8.8.8.8"])
  })
})

describe("finding 3: compressed bodies are decompressed and limited after decompression", () => {
  const big = "x".repeat(3 * 1024 * 1024)
  const served = (encoding: string, body: Uint8Array, type = "text/plain") => fakeConnector((r) => {
    expect(r.headers["accept-encoding"]).toBeUndefined() // the connector asks for identity itself
    return reply(200, chunks(body), { "content-type": type, "content-encoding": encoding, "content-length": String(body.byteLength) })
  })
  it("3 MiB of gzip that is 3 KB on the wire is too large", async () => {
    const gz = zlib.gzipSync(big)
    expect(gz.byteLength).toBeLessThan(10_000)
    expect(await errorOf(safeFetch("http://a.example/", page({ resolver, connector: served("gzip", gz) })))).toBeInstanceOf(NetTooLarge)
    expect(await errorOf(safeFetch("http://a.example/", page({ resolver, connector: served("br", zlib.brotliCompressSync(big)) })))).toBeInstanceOf(NetTooLarge)
    expect(await errorOf(safeFetch("http://a.example/", page({ resolver, connector: served("deflate", zlib.deflateSync(big)) })))).toBeInstanceOf(NetTooLarge)
  })
  it("gzip, x-gzip, deflate (zlib) and br are decoded; the headers say what the body is now", async () => {
    const text = "héllo wörld ".repeat(50)
    for (const [encoding, body] of [["gzip", zlib.gzipSync(text)], ["x-gzip", zlib.gzipSync(text)], ["deflate", zlib.deflateSync(text)], ["br", zlib.brotliCompressSync(text)]] as const) {
      const res = await Effect.runPromise(safeFetch("http://a.example/", page({ resolver, connector: served(encoding, new Uint8Array(body), "text/plain; charset=utf-8") })))
      expect(res.text(), encoding).toBe(text)
      expect(res.encoding).toBe(encoding === "x-gzip" ? "gzip" : encoding)
      expect(res.headers["content-encoding"]).toBeUndefined()
      expect(res.headers["content-length"]).toBeUndefined()
    }
  })
  it("a body split into many small chunks is decoded incrementally", async () => {
    const gz = zlib.gzipSync("abc".repeat(1000))
    const parts = Array.from({ length: Math.ceil(gz.byteLength / 7) }, (_, i) => new Uint8Array(gz.subarray(i * 7, i * 7 + 7)))
    const connector = fakeConnector(() => reply(200, chunks(...parts), { "content-type": "text/plain", "content-encoding": "gzip" }))
    expect((await Effect.runPromise(safeFetch("http://a.example/", page({ resolver, connector })))).text()).toBe("abc".repeat(1000))
  })
  it("other encodings, stacked encodings and a corrupt body are refused", async () => {
    for (const encoding of ["compress", "zstd", "gzip, br", "identity, gzip"]) {
      const error = (await errorOf(safeFetch("http://a.example/", page({ resolver, connector: served(encoding, bytes("x")) })))) as NetRefused
      expect(error.rule, encoding).toBe("content-encoding")
    }
    const error = (await errorOf(safeFetch("http://a.example/", page({ resolver, connector: served("gzip", bytes("not gzip at all")) })))) as NetFailure
    expect(error).toBeInstanceOf(NetFailure)
    expect(error.stage).toBe("response")
  })
  it("the time limit covers a decompressing body that stalls", async () => {
    const gz = zlib.gzipSync("abc")
    async function* stall() { yield new Uint8Array(gz.subarray(0, 5)); await new Promise(() => {}) }
    const connector = fakeConnector(() => reply(200, stall(), { "content-type": "text/plain", "content-encoding": "gzip" }))
    expect(await errorOf(safeFetch("http://a.example/", page({ resolver, connector, timeoutMs: 50 })))).toBeInstanceOf(NetTimeout)
  })
})

describe("finding 4: the caller cannot steer the authority or the connection", () => {
  const ok = () => fakeConnector(() => reply(200, "ok"))
  for (const name of ["Host", "host", "HOST", "Connection", "Keep-Alive", "Proxy-Connection", "Proxy-Authorization", "Transfer-Encoding", "TE", "Trailer", "Upgrade", "Content-Length", "Expect", "Accept-Encoding", ":authority", "bad name"])
    it(`a ${name} header is refused`, async () => {
      const connector = ok()
      const error = (await errorOf(safeFetch("http://a.example/", page({ resolver, connector, headers: { [name]: "metadata.google.internal" } })))) as NetRefused
      expect(error.rule).toBe("header")
      expect(connector.requests).toEqual([])
    })
  it("values with CR, LF, NUL or non-ASCII, and a name given twice, are refused", async () => {
    for (const headers of [{ "X-A": "a\r\nHost: evil" }, { "X-A": "a\u0000" }, { "X-A": "联系" }, { Accept: "a", accept: "b" }]) {
      const error = (await errorOf(safeFetch("http://a.example/", page({ resolver, connector: ok(), headers })))) as NetRefused
      expect(error.rule, JSON.stringify(headers)).toBe("header")
    }
  })
  it("a cross-origin redirect keeps only Accept, Accept-Language and User-Agent", async () => {
    const connector = fakeConnector((r) => (r.url.hostname === "a.example" ? reply(302, "", { location: "http://b.example/" }) : reply(200, "ok")))
    await Effect.runPromise(safeFetch("http://a.example/", page({ resolver, connector, headers: { "X-Api-Key": "k", "User-Agent": "ua", "Accept-Language": "nl", Authorization: "Bearer x" } })))
    expect(connector.requests[0]!.headers["x-api-key"]).toBe("k")
    expect({ ...connector.requests[1]!.headers }).toEqual({ "user-agent": "ua", "accept-language": "nl", accept: "text/html, text/plain, application/pdf" })
  })
})

describe("finding 5: the response type is checked before the body is read", () => {
  const untouched = () => {
    let read = false
    async function* body() { read = true; yield bytes("MZ\u0090\u0000") }
    return { body, wasRead: () => read }
  }
  for (const type of ["application/octet-stream", "application/x-msdownload", "text/javascript", "image/svg+xml", "", "not a type"])
    it(`a web page fetch refuses "${type || "no content type"}" without reading it`, async () => {
      const b = untouched()
      const connector = fakeConnector(() => reply(200, b.body(), { "content-type": type }))
      const error = (await errorOf(safeFetch("http://a.example/", page({ resolver, connector })))) as NetRefused
      expect(error.rule).toBe("content-type")
      expect(b.wasRead()).toBe(false)
    })
  it("the presets accept their types, with parameters and in any case", async () => {
    const cases: ReadonlyArray<readonly [SafeFetchOptions["accept"], string]> = [
      [contentTypes.webPage, "Text/HTML; charset=UTF-8"], [contentTypes.webPage, "application/pdf"], [contentTypes.webPage, "text/plain"],
      [contentTypes.json, "application/json"], [contentTypes.json, "application/geo+json"], [contentTypes.json, "application/problem+json; charset=utf-8"],
      [contentTypes.feed, "application/rss+xml"], [contentTypes.feed, "application/atom+xml"], [contentTypes.feed, "text/xml"], [contentTypes.feed, "application/feed+json"],
      [contentTypes.image, "image/png"], [contentTypes.image, "image/webp"]
    ]
    for (const [accept, type] of cases) {
      const res = await Effect.runPromise(safeFetch("http://a.example/", { accept, resolver, connector: fakeConnector(() => reply(200, "x", { "content-type": type })) }))
      expect(res.status, `${accept.name} ${type}`).toBe(200)
    }
    for (const [accept, type] of [[contentTypes.json, "text/html"], [contentTypes.image, "image/svg+xml"], [contentTypes.feed, "text/html"], [contentTypes.webPage, "application/json"]] as const) {
      const error = (await errorOf(safeFetch("http://a.example/", { accept, resolver, connector: fakeConnector(() => reply(200, "x", { "content-type": type })) }))) as NetRefused
      expect(error.rule, `${accept.name} ${type}`).toBe("content-type")
    }
  })
  it("sends an Accept header from the policy; an error page of another type is not read but its status arrives", async () => {
    const b = untouched()
    const connector = fakeConnector(() => reply(404, b.body(), { "content-type": "text/html" }))
    const res = await Effect.runPromise(safeFetch("http://a.example/", { accept: contentTypes.json, resolver, connector }))
    expect(res.status).toBe(404)
    expect(res.body.byteLength).toBe(0)
    expect(b.wasRead()).toBe(false)
    expect(connector.requests[0]!.headers["accept"]).toBe("application/json")
  })
  it("a policy is required, and must list a type", async () => {
    for (const accept of [undefined, { name: "x", types: [] }, { name: "x", types: ["*/*"] }]) {
      const error = (await errorOf(safeFetch("http://a.example/", { accept, resolver, connector: fakeConnector(() => reply(200, "x")) } as unknown as SafeFetchOptions))) as NetRefused
      expect(error.rule).toBe("options")
    }
  })
  it("decodes text in the charset the type names", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9])
    const res = await Effect.runPromise(safeFetch("http://a.example/", page({ resolver, connector: fakeConnector(() => reply(200, chunks(latin1), { "content-type": "text/plain; charset=ISO-8859-1" })) })))
    expect(res.text()).toBe("café")
    expect(res.contentType).toBe("text/plain")
  })
})

describe("finding 30: HEAD is not limited by a body it does not receive", () => {
  it("a HEAD of a big file answers", async () => {
    const connector = fakeConnector(() => reply(200, "", { "content-type": "application/pdf", "content-length": String(50 * 1024 * 1024) }))
    const res = await Effect.runPromise(safeFetch("http://a.example/", page({ resolver, connector, method: "HEAD" })))
    expect(res.status).toBe(200)
    expect(res.headers["content-length"]).toBe(String(50 * 1024 * 1024))
  })
  it("other limits and methods are checked", async () => {
    for (const o of [{ maxBytes: -1 }, { maxBytes: Number.NaN }, { maxRedirects: 1.5 }, { timeoutMs: 0 }, { method: "POST" as never }]) {
      const error = (await errorOf(safeFetch("http://a.example/", page({ resolver, connector: fakeConnector(() => reply(200, "x")), ...o })))) as NetRefused
      expect(error.rule, JSON.stringify(o)).toBe("options")
    }
  })
})

// ---- the cache ------------------------------------------------------------------------------------------------------------------------

const json = (status: number, body: string, headers: Record<string, string> = {}): SafeResponse => ({
  url: "x", status, headers, body: bytes(body), redirects: [], text: () => body, encoding: "identity", contentType: "application/json"
})

describe("finding 1: the cache key includes the request headers", () => {
  it("Alice's answer is never Bob's", async () => {
    const seen: Array<string | undefined> = []
    const api = makeCachedJson({
      now: () => 0,
      fetch: (_url, o) => { seen.push(o.headers?.["authorization"]); return Effect.succeed(json(200, JSON.stringify({ me: o.headers?.["authorization"] }))) }
    })
    const alice = await Effect.runPromise(api.getJson("http://x/me", { ttlMs: 60_000, headers: { Authorization: "alice" } }))
    const bob = await Effect.runPromise(api.getJson("http://x/me", { ttlMs: 60_000, headers: { Authorization: "bob" } }))
    const lang = await Effect.runPromise(api.getJson("http://x/me", { ttlMs: 60_000, headers: { Authorization: "alice", "Accept-Language": "nl" } }))
    const again = await Effect.runPromise(api.getJson("http://x/me", { ttlMs: 60_000, headers: { authorization: "alice" } }))
    expect([alice.value, bob.value, lang.source, again.source]).toEqual([{ me: "alice" }, { me: "bob" }, "network", "cache"])
    expect(seen).toEqual(["alice", "bob", "alice"])
  })
  it("the JSON preset is used, and conditional headers from the caller are not sent", async () => {
    let options: SafeFetchOptions | undefined
    const api = makeCachedJson({ fetch: (_url, o) => { options = o; return Effect.succeed(json(200, "1")) } })
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 0, headers: { "If-None-Match": "*" } }))
    expect(options?.accept).toBe(contentTypes.json)
    expect(options?.headers?.["if-none-match"]).toBeUndefined()
  })
  it("a header that cannot be sent is refused", async () => {
    const api = makeCachedJson({ fetch: () => Effect.succeed(json(200, "1")) })
    expect(((await errorOf(api.getJson("http://x/a", { ttlMs: 0, headers: { Host: "evil" } }))) as NetRefused).rule).toBe("header")
  })
})

describe("finding 23: concurrent misses share one request", () => {
  const gate = () => {
    const pending: Array<(r: SafeResponse) => void> = []
    let calls = 0
    let signal: AbortSignal | undefined
    const fetch = (_url: string, _o: SafeFetchOptions) => {
      calls++
      return Effect.tryPromise({ try: (s) => { signal = s; return new Promise<SafeResponse>((r) => { pending.push(r) }) }, catch: () => new NetFailure({ url: "x", stage: "connect", detail: "x" }) })
    }
    /** Answers every request still waiting. */
    const open = (r: SafeResponse) => { for (const p of pending.splice(0)) p(r) }
    return { fetch, open, calls: () => calls, signal: () => signal }
  }
  it("two callers, one request, both get the value", async () => {
    const g = gate()
    const api = makeCachedJson({ fetch: g.fetch })
    const a = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000 }))
    const b = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000 }))
    await new Promise((r) => setTimeout(r, 5))
    g.open(json(200, '{"v":1}'))
    expect([(await a).value, (await b).value]).toEqual([{ v: 1 }, { v: 1 }])
    expect(g.calls()).toBe(1)
  })
  it("one caller's abort fails only that caller; its interruption stops only its wait", async () => {
    const g = gate()
    const api = makeCachedJson({ fetch: g.fetch })
    const controller = new AbortController()
    const aborted = Effect.runPromiseExit(api.getJson("http://x/a", { ttlMs: 1000, fetch: { signal: controller.signal } }))
    const interrupted = Effect.runFork(api.getJson("http://x/a", { ttlMs: 1000 }))
    const waiting = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000 }))
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    const exit = await aborted
    expect(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Fail" && r.error instanceof NetAborted)).toBe(true)
    await Effect.runPromise(Fiber.interrupt(interrupted))
    expect(g.signal()?.aborted).toBe(false)
    g.open(json(200, "7"))
    expect((await waiting).value).toBe(7)
    expect(g.calls()).toBe(1)
  })
  it("the request is cancelled when every caller has left, and the next caller starts a new one", async () => {
    const g = gate()
    const api = makeCachedJson({ fetch: g.fetch })
    const a = Effect.runFork(api.getJson("http://x/a", { ttlMs: 1000 }))
    const b = Effect.runFork(api.getJson("http://x/a", { ttlMs: 1000 }))
    await new Promise((r) => setTimeout(r, 5))
    await Effect.runPromise(Fiber.interrupt(a))
    expect(g.signal()?.aborted).toBe(false)
    await Effect.runPromise(Fiber.interrupt(b))
    await new Promise((r) => setTimeout(r, 5))
    expect(g.signal()?.aborted).toBe(true)
    const c = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000 }))
    await new Promise((r) => setTimeout(r, 5))
    g.open(json(200, "3"))
    expect((await c).value).toBe(3)
    expect(g.calls()).toBe(2)
  })
  it("callers with different limits or connectors do not share", async () => {
    const g = gate()
    const api = makeCachedJson({ fetch: g.fetch })
    const a = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000, fetch: { maxBytes: 100 } }))
    const b = Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000, fetch: { maxBytes: 200 } }))
    await new Promise((r) => setTimeout(r, 5))
    expect(g.calls()).toBe(2)
    g.open(json(200, "1"))
    await Promise.all([a, b])
  })
  it("an older answer does not replace a newer entry", async () => {
    const cache = makeMemoryJsonCache()
    const clock = { t: 1000 }
    let release!: () => void
    const slow = makeCachedJson({ cache, now: () => clock.t, fetch: () => Effect.promise(() => new Promise<void>((r) => { release = r })).pipe(Effect.as(json(200, '"old"'))) })
    const fast = makeCachedJson({ cache, now: () => clock.t, fetch: () => Effect.succeed(json(200, '"new"')) })
    const pending = Effect.runPromise(slow.getJson("http://x/a", { ttlMs: 10 }))
    await new Promise((r) => setTimeout(r, 5))
    clock.t += 1
    await Effect.runPromise(fast.getJson("http://x/a", { ttlMs: 10 }))
    clock.t += 1
    release()
    await pending
    expect(await Effect.runPromise(fast.getJson("http://x/a", { ttlMs: 10 }))).toMatchObject({ value: "new", source: "cache" })
  })
})

describe("findings 24 and 25: stale-if-error ages and aborts", () => {
  it("the age is taken after the failed request, and a request that outlasts the window fails", async () => {
    const clock = { t: 0 }
    let fail = false
    const api = makeCachedJson({
      now: () => clock.t,
      fetch: () => (fail ? Effect.sync(() => { clock.t += 4000 }).pipe(Effect.andThen(Effect.fail(new NetTimeout({ url: "x", timeoutMs: 4000 })))) : Effect.succeed(json(200, '"v"')))
    })
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000, staleIfErrorMs: 5000 }))
    fail = true
    clock.t = 1500
    const r = await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000, staleIfErrorMs: 5000 }))
    expect(r).toMatchObject({ source: "stale", ageMs: 5500 })
    clock.t = 3000 // the next failure ends at 7000: past 1000 + 5000
    expect(await errorOf(api.getJson("http://x/a", { ttlMs: 1000, staleIfErrorMs: 5000 }))).toBeInstanceOf(NetTimeout)
  })
  it("a caller's abort is NetAborted, not the stale value", async () => {
    const clock = { t: 0 }
    let hang = false
    const api = makeCachedJson({ now: () => clock.t, fetch: () => (hang ? Effect.never : Effect.succeed(json(200, '"v"'))) })
    await Effect.runPromise(api.getJson("http://x/a", { ttlMs: 1000, staleIfErrorMs: 60_000 }))
    hang = true
    clock.t = 2000
    const controller = new AbortController()
    const pending = errorOf(api.getJson("http://x/a", { ttlMs: 1000, staleIfErrorMs: 60_000, fetch: { signal: controller.signal } }))
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    expect(await pending).toBeInstanceOf(NetAborted)
    // A NetAborted from the fetch itself is not turned into a stale value either.
    const aborting = makeCachedJson({ now: () => clock.t, fetch: () => Effect.fail(new NetAborted({ url: "x" })) })
    expect(await errorOf(aborting.getJson("http://x/a", { ttlMs: 0, staleIfErrorMs: 60_000 }))).toBeInstanceOf(NetAborted)
  })
  it("interruption stays interruption", async () => {
    const api = makeCachedJson({ fetch: () => Effect.never })
    const fiber = Effect.runFork(api.getJson("http://x/a", { ttlMs: 0, staleIfErrorMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 5))
    const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))
    expect(Exit.isFailure(exit) && exit.cause.reasons.every((r) => r._tag === "Interrupt")).toBe(true)
  })
})

describe("finding 31: cache capacities", () => {
  for (const bad of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2e6])
    it(`${bad} is refused`, () => expect(() => makeMemoryJsonCache(bad)).toThrow(RangeError))
  it("1 keeps one entry", () => {
    const c = makeMemoryJsonCache(1)
    c.setIfNewer("a", { value: 1, storedAt: 0, sequence: c.sequence() })
    c.setIfNewer("b", { value: 2, storedAt: 0, sequence: c.sequence() })
    expect([c.get("a"), c.get("b")?.value]).toEqual([undefined, 2])
  })
})

describe("finding 26: the User-Agent is a legal header for any contact", () => {
  it("non-ASCII is percent-encoded", () => {
    expect(userAgent("https://example.com/联系")).toBe("personal-voice-assistance/1 (https://example.com/%E8%81%94%E7%B3%BB)")
    expect(userAgent("me@exämple.com")).toBe("personal-voice-assistance/1 (me@ex%C3%A4mple.com)")
    expect(userAgent("a\\b")).toBe("personal-voice-assistance/1 (a b)")
  })
  it("Node accepts every result", () => {
    const samples = ["联系", "\u0000\u0001", "é".repeat(300), "😀 smile", "\ud800", "x\r\ny", "()", "a\u007fb", " nbsp", "tab\there"]
    for (const s of samples) {
      expect(() => validateHeaderValue("user-agent", userAgent(s)), JSON.stringify(s)).not.toThrow()
      expect(() => validateHeaderValue("user-agent", userAgent(undefined, s, s)), JSON.stringify(s)).not.toThrow()
      expect(userAgent(s).length).toBeLessThanOrEqual(240)
    }
  })
})
