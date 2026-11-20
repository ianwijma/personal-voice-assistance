// Review round 4 of the net package: each finding's case, failing on the code before the fix.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import http from "node:http"
import type { AddressInfo } from "node:net"
import zlib from "node:zlib"
import { makeCachedJson } from "../src/CachedJson.ts"
import { NetFailure, NetRefused, NetTooLarge } from "../src/Errors.ts"
import { contentTypes, nodeConnector, safeFetch, fetchOwnerConfiguredLan, type ConnectRequest } from "../src/SafeFetch.ts"
import { chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}
const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })

describe("finding 1: a decompressor failure ends the read at once, also when the body never ends", () => {
  // A loopback server (packages/net/README.md: not network) that sends the given bytes and then keeps the body open for good.
  const stalling = async (encoding: string, body: Uint8Array) => {
    let closed!: () => void
    const socketClosed = new Promise<void>((r) => { closed = r })
    const server = http.createServer((req, res) => {
      req.socket.on("close", () => closed())
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": encoding })
      res.write(body)
      // never res.end()
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const port = (server.address() as AddressInfo).port
    return {
      port,
      socketClosed,
      close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) })
    }
  }
  const fetchFrom = (port: number, maxBytes: number) =>
    fetchOwnerConfiguredLan(`http://pretend.example:${port}/`, {
      accept: contentTypes.webPage,
      maxBytes,
      timeoutMs: 10_000,
      resolver: async () => ["192.168.0.1"],
      connector: (r) => nodeConnector({ ...r, address: "127.0.0.1" })
    })
  const settledWithin = async (ms: number, p: Promise<void>) =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

  it("a gzip bomb over the limit is NetTooLarge at once and the socket is closed", async () => {
    const s = await stalling("gzip", zlib.gzipSync("x".repeat(100_000)))
    try {
      const started = Date.now()
      const error = await errorOf(fetchFrom(s.port, 1000))
      expect(Date.now() - started).toBeLessThan(2000)
      expect(error).toBeInstanceOf(NetTooLarge)
      expect(await settledWithin(2000, s.socketClosed)).toBe(true)
    } finally { await s.close() }
  })
  it("invalid deflate (the overlapping-prefix bytes) is NetRefused(content-encoding) at once and the socket is closed", async () => {
    const s = await stalling("deflate", Uint8Array.from([0x78, 0x01, 0x00, 0xfe, 0xff, 0x41, 0x03, 0x00]))
    try {
      const started = Date.now()
      const error = await errorOf(fetchFrom(s.port, 1_000_000))
      expect(Date.now() - started).toBeLessThan(2000)
      expect(error).toBeInstanceOf(NetRefused)
      expect((error as NetRefused).rule).toBe("content-encoding")
      expect(await settledWithin(2000, s.socketClosed)).toBe(true)
    } finally { await s.close() }
  })
  it("with a fake transport too: the pending read of the raw body is abandoned and the body closed", async () => {
    let returned = false
    const never: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let sent = false
        return {
          next: () => {
            if (!sent) { sent = true; return Promise.resolve({ done: false, value: new Uint8Array(zlib.gzipSync("y".repeat(50_000))) }) }
            return new Promise<IteratorResult<Uint8Array>>(() => undefined)
          },
          return: () => { returned = true; return Promise.resolve({ done: true, value: undefined }) }
        }
      }
    }
    const started = Date.now()
    const error = await errorOf(safeFetch("http://a.example/", { accept: contentTypes.webPage, maxBytes: 100, timeoutMs: 10_000, resolver, connector: fakeConnector(() => reply(200, never, { "content-encoding": "gzip" })) }))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(error).toBeInstanceOf(NetTooLarge)
    expect(returned).toBe(true)
  })
})

describe("finding 3: a single-stream encoding with bytes after its stream is refused", () => {
  const fetchEncoded = (encoding: string, ...parts: Array<Uint8Array>) =>
    safeFetch("http://a.example/", { accept: contentTypes.webPage, resolver, connector: fakeConnector(() => reply(200, chunks(...parts), { "content-encoding": encoding })) })
  const junk = new TextEncoder().encode("NOT A STREAM")
  const cat = (...parts: Array<Uint8Array>) => new Uint8Array(Buffer.concat(parts))
  const deflate = new Uint8Array(zlib.deflateSync("hello"))
  const br = new Uint8Array(zlib.brotliCompressSync("hello"))
  const gzip = new Uint8Array(zlib.gzipSync("hello"))
  const refusedEncoding = async (effect: Effect.Effect<unknown, unknown>) => {
    const error = await errorOf(effect)
    expect(error).toBeInstanceOf(NetRefused)
    expect((error as NetRefused).rule).toBe("content-encoding")
  }
  it("deflate: junk in the same chunk, junk in a later chunk, a second stream", async () => {
    await refusedEncoding(fetchEncoded("deflate", cat(deflate, junk)))
    await refusedEncoding(fetchEncoded("deflate", deflate, junk))
    await refusedEncoding(fetchEncoded("deflate", cat(deflate, deflate)))
    await refusedEncoding(fetchEncoded("deflate", deflate, deflate))
  })
  it("br: junk in the same chunk, junk in a later chunk, a second stream", async () => {
    await refusedEncoding(fetchEncoded("br", cat(br, junk)))
    await refusedEncoding(fetchEncoded("br", br, junk))
    await refusedEncoding(fetchEncoded("br", cat(br, br)))
  })
  it("controls: a whole stream is read; truncation is still refused; gzip members may follow each other; gzip junk fails", async () => {
    expect((await Effect.runPromise(fetchEncoded("deflate", deflate))).text()).toBe("hello")
    expect((await Effect.runPromise(fetchEncoded("br", br.subarray(0, 3), br.subarray(3)))).text()).toBe("hello")
    await refusedEncoding(fetchEncoded("deflate", deflate.subarray(0, deflate.length - 2)))
    expect((await Effect.runPromise(fetchEncoded("gzip", cat(gzip, gzip)))).text()).toBe("hellohello")
    expect((await Effect.runPromise(fetchEncoded("gzip", gzip, gzip))).text()).toBe("hellohello")
    expect(await errorOf(fetchEncoded("gzip", gzip, junk))).toBeInstanceOf(NetFailure)
  })
})

describe("finding 2: a validator is bound to the resource, whatever the URL's spelling", () => {
  const spellings: Array<[string, string]> = [
    ["a bare origin", "http://a.example"],
    ["an upper-case scheme and host with the default port", "HTTP://A.EXAMPLE:80/x"],
    ["dot segments", "http://a.example/x/./y/../z"],
    ["a fragment", "http://a.example/x#part"]
  ]
  for (const [name, url] of spellings) {
    it(`${name} (${url}) revalidates on the second call`, async () => {
      const connector = fakeConnector((r: ConnectRequest) =>
        r.headers["if-none-match"] === '"1"' ? reply(304, "", { etag: '"1"' }) : reply(200, '"v"', { "content-type": "application/json", etag: '"1"' }))
      let clock = 0
      const api = makeCachedJson({ now: () => clock, fetch: (u, o) => safeFetch(u, { ...o, resolver, connector }) })
      expect(await Effect.runPromise(api.getJson(url, { ttlMs: 0 }))).toMatchObject({ value: "v", source: "network" })
      clock = 10
      expect(await Effect.runPromise(api.getJson(url, { ttlMs: 0 }))).toMatchObject({ value: "v", source: "revalidated" })
      expect(connector.requests[1]!.headers["if-none-match"]).toBe('"1"')
    })
  }
  it("a body from another resource still gets no validator (the round-3 safeguard stays)", async () => {
    const connector = fakeConnector((r: ConnectRequest) =>
      r.url.pathname === "/current" ? reply(302, "", { location: "/old" })
        : r.headers["if-none-match"] !== undefined ? reply(304, "", { etag: '"1"' }) : reply(200, '"old"', { "content-type": "application/json", etag: '"1"' }))
    let clock = 0
    const api = makeCachedJson({ now: () => clock, fetch: (u, o) => safeFetch(u, { ...o, resolver, connector }) })
    await Effect.runPromise(api.getJson("HTTP://A.EXAMPLE:80/current", { ttlMs: 0 }))
    clock = 10
    await Effect.runPromise(api.getJson("HTTP://A.EXAMPLE:80/current", { ttlMs: 0 }))
    expect(connector.requests.filter((r) => r.headers["if-none-match"] !== undefined)).toEqual([])
  })
})
