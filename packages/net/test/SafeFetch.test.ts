import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import { NetAborted, NetFailure, NetRefused, NetTimeout, NetTooLarge } from "../src/Errors.ts"
import { fetchOwnerConfiguredLan, safeFetch, type SafeFetchOptions } from "../src/SafeFetch.ts"
import { chunks, fakeConnector, fakeResolver, reply } from "./helpers.ts"

const failure = async (url: string, options: SafeFetchOptions, lan = false) => {
  const exit = await Effect.runPromiseExit((lan ? fetchOwnerConfiguredLan : safeFetch)(url, options))
  if (!Exit.isFailure(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons.map((r) => (r._tag === "Fail" ? r.error : undefined)).find((e) => e !== undefined)
  return error
}
const refusedRule = async (url: string, options: SafeFetchOptions, lan = false) => {
  const error = await failure(url, options, lan)
  expect(error).toBeInstanceOf(NetRefused)
  return (error as NetRefused).rule
}

describe("safeFetch: the happy path", () => {
  it("resolves once, connects to the checked address and keeps the URL's host for the request", async () => {
    const resolver = fakeResolver({ "example.com": ["93.184.216.34"] })
    const connector = fakeConnector(() => reply(200, "hello", { "content-type": "text/plain" }))
    const res = await Effect.runPromise(safeFetch("https://example.com/a?b=1", { resolver, connector, headers: { "User-Agent": "t" } }))
    expect(res.status).toBe(200)
    expect(res.text()).toBe("hello")
    expect(res.url).toBe("https://example.com/a?b=1")
    expect(resolver.calls).toEqual(["example.com"])
    expect(connector.requests).toHaveLength(1)
    expect(connector.requests[0]!.address).toBe("93.184.216.34")
    expect(connector.requests[0]!.url.hostname).toBe("example.com")
    expect(connector.requests[0]!.headers["user-agent"]).toBe("t")
  })
  it("fetches an IP literal without resolving", async () => {
    const resolver = fakeResolver({})
    const connector = fakeConnector(() => reply(200, "ok"))
    await Effect.runPromise(safeFetch("http://93.184.216.34/", { resolver, connector }))
    expect(resolver.calls).toEqual([])
    expect(connector.requests[0]!.address).toBe("93.184.216.34")
  })
  it("HEAD reads no body", async () => {
    const connector = fakeConnector(() => reply(200, "ignored"))
    const res = await Effect.runPromise(safeFetch("http://1.1.1.1/", { connector, method: "HEAD" }))
    expect(res.body.byteLength).toBe(0)
  })
  it("falls to the next address when a connection cannot be made", async () => {
    const resolver = fakeResolver({ "x.example": ["1.1.1.1", "8.8.8.8"] })
    const connector = fakeConnector((r) => {
      if (r.address === "1.1.1.1") throw new Error("ECONNREFUSED")
      return reply(200, "second")
    })
    const res = await Effect.runPromise(safeFetch("http://x.example/", { resolver, connector }))
    expect(res.text()).toBe("second")
  })
  it("reports a connect failure and a DNS failure", async () => {
    const dead = fakeConnector(() => { throw new Error("ECONNREFUSED") })
    const a = await failure("http://1.1.1.1/", { connector: dead })
    expect(a).toBeInstanceOf(NetFailure)
    expect((a as NetFailure).stage).toBe("connect")
    const b = await failure("http://nowhere.example/", { resolver: fakeResolver({}), connector: dead })
    expect((b as NetFailure).stage).toBe("dns")
  })
})

describe("safeFetch: refused URLs", () => {
  const connector = fakeConnector(() => reply(200, "should not be reached"))
  const resolver = fakeResolver({ "ok.example": ["8.8.8.8"] })
  const o = { connector, resolver }
  const literals: ReadonlyArray<readonly [string, string]> = [
    ["http://127.0.0.1/", "loopback"], ["http://127.1/", "loopback"], ["http://2130706433/", "loopback"], ["http://0x7f.0.0.1/", "loopback"],
    ["http://017700000001/", "loopback"], ["http://0.0.0.0/", "unspecified"], ["http://10.1.2.3/", "private"],
    ["http://172.16.5.5/", "private"], ["http://192.168.1.10/", "private"], ["http://169.254.169.254/latest/meta-data/", "link-local"],
    ["http://100.64.1.1/", "carrier-grade-nat"], ["http://224.0.0.251/", "multicast"], ["http://255.255.255.255/", "broadcast"],
    ["http://[::1]/", "loopback"], ["http://[::]/", "unspecified"], ["http://[fe80::1]/", "link-local"], ["http://[fd00::1]/", "unique-local"],
    ["http://[ff02::1]/", "multicast"], ["http://[::ffff:127.0.0.1]/", "loopback"], ["http://[::ffff:10.0.0.1]/", "private"],
    ["http://[::ffff:a9fe:a9fe]/", "link-local"], ["http://[64:ff9b::a00:1]/", "private"]
  ]
  for (const [url, klass] of literals)
    it(`${url} is refused as ${klass}`, async () => {
      const error = (await failure(url, o)) as NetRefused
      expect(error).toBeInstanceOf(NetRefused)
      expect(error.rule).toBe("address")
      expect(error.addressClass).toBe(klass)
    })
  const names: ReadonlyArray<readonly [string, string]> = [
    ["http://localhost/", "host-name"], ["http://printer/", "host-name"], ["http://nas.local/", "host-name"], ["http://router.lan/", "host-name"],
    ["http://thing.home.arpa/", "host-name"], ["http://db.internal/", "host-name"], ["http://foo.localhost/", "host-name"],
    ["ftp://ok.example/", "scheme"], ["file:///etc/passwd", "scheme"], ["javascript:alert(1)", "scheme"], ["gopher://ok.example/", "scheme"], ["not a url", "scheme"],
    ["http://user:pw@ok.example/", "credentials"], ["http://user@ok.example/", "credentials"],
    ["http://ok.example:8080/", "port"], ["https://ok.example:22/", "port"]
  ]
  for (const [url, rule] of names) it(`${url} is refused by ${rule}`, async () => expect(await refusedRule(url, o)).toBe(rule))
  it("allows explicit default ports", async () => {
    await Effect.runPromise(safeFetch("http://ok.example:80/", o))
    await Effect.runPromise(safeFetch("https://ok.example:443/", o))
  })
  it("nothing was connected for any refusal", () => expect(connector.requests.filter((r) => r.address !== "8.8.8.8")).toEqual([]))
})

describe("safeFetch: names that resolve inside", () => {
  const connector = fakeConnector(() => reply(200, "no"))
  for (const [address, klass] of [["10.0.0.5", "private"], ["127.0.0.1", "loopback"], ["::1", "loopback"], ["fd00::5", "unique-local"], ["::ffff:192.168.0.1", "private"], ["169.254.169.254", "link-local"]] as const)
    it(`a name resolving to ${address} is refused`, async () => {
      const error = (await failure("http://evil.example/", { connector, resolver: fakeResolver({ "evil.example": [address] }) })) as NetRefused
      expect(error.rule).toBe("address")
      expect(error.addressClass).toBe(klass)
    })
  it("one private address among public ones refuses the name", async () => {
    const error = await failure("http://mixed.example/", { connector, resolver: fakeResolver({ "mixed.example": ["8.8.8.8", "10.0.0.1"] }) })
    expect(error).toBeInstanceOf(NetRefused)
    expect(connector.requests).toEqual([])
  })
})

describe("safeFetch: DNS rebinding", () => {
  it("resolves once per hop and connects to that answer, even if the next lookup would differ", async () => {
    let lookups = 0
    const resolver = async () => (++lookups === 1 ? ["8.8.8.8"] : ["127.0.0.1"])
    const connector = fakeConnector(() => reply(200, "ok"))
    await Effect.runPromise(safeFetch("http://rebind.example/", { resolver, connector }))
    expect(lookups).toBe(1)
    expect(connector.requests.map((r) => r.address)).toEqual(["8.8.8.8"])
  })
  it("a second lookup on a redirect to the same name is checked again and refused", async () => {
    let lookups = 0
    const resolver = async () => (++lookups === 1 ? ["8.8.8.8"] : ["127.0.0.1"])
    const connector = fakeConnector((r) => (r.address === "8.8.8.8" ? reply(302, "", { location: "http://rebind.example/next" }) : reply(200, "secret")))
    const error = (await failure("http://rebind.example/", { resolver, connector })) as NetRefused
    expect(error.rule).toBe("address")
    expect(connector.requests.map((r) => r.address)).toEqual(["8.8.8.8"])
  })
})

describe("safeFetch: redirects", () => {
  const resolver = fakeResolver({ "a.example": ["8.8.8.8"], "b.example": ["8.8.4.4"], "inside.example": ["10.0.0.7"] })
  it("follows a redirect, relative and absolute, and lists the hops", async () => {
    const connector = fakeConnector((r) => {
      if (r.url.pathname === "/") return reply(301, "", { location: "/two" })
      if (r.url.pathname === "/two") return reply(302, "", { location: "http://b.example/three" })
      return reply(200, "done")
    })
    const res = await Effect.runPromise(safeFetch("http://a.example/", { resolver, connector }))
    expect(res.text()).toBe("done")
    expect(res.url).toBe("http://b.example/three")
    expect(res.redirects).toEqual(["http://a.example/two", "http://b.example/three"])
    expect(connector.requests.map((r) => r.address)).toEqual(["8.8.8.8", "8.8.8.8", "8.8.4.4"])
  })
  for (const target of ["http://127.0.0.1/admin", "http://[::1]/", "http://169.254.169.254/latest", "http://inside.example/", "http://192.168.0.1/", "http://localhost/", "ftp://a.example/x", "file:///etc/passwd", "http://u:p@b.example/"])
    it(`a redirect to ${target} is refused`, async () => {
      const connector = fakeConnector((r) => (r.url.hostname === "a.example" ? reply(302, "", { location: target }) : reply(200, "leak")))
      const error = await failure("http://a.example/", { resolver, connector })
      expect(error).toBeInstanceOf(NetRefused)
      expect(connector.requests).toHaveLength(1)
    })
  it("stops after the redirect limit", async () => {
    const connector = fakeConnector(() => reply(302, "", { location: "/again" }))
    expect(await refusedRule("http://a.example/", { resolver, connector })).toBe("redirect-limit")
    expect(connector.requests).toHaveLength(4)
    const one = fakeConnector(() => reply(302, "", { location: "/again" }))
    expect(await refusedRule("http://a.example/", { resolver, connector: one, maxRedirects: 1 })).toBe("redirect-limit")
    expect(one.requests).toHaveLength(2)
  })
  it("a redirect without Location is refused", async () => {
    expect(await refusedRule("http://a.example/", { resolver, connector: fakeConnector(() => reply(302)) })).toBe("redirect-target")
  })
  it("drops credentials headers when the redirect leaves the origin", async () => {
    const connector = fakeConnector((r) => (r.url.hostname === "a.example" ? reply(302, "", { location: "http://b.example/" }) : reply(200, "ok")))
    await Effect.runPromise(safeFetch("http://a.example/", { resolver, connector, headers: { Authorization: "Bearer x", Cookie: "a=b", Accept: "*/*" } }))
    expect(connector.requests[0]!.headers["authorization"]).toBe("Bearer x")
    expect(connector.requests[1]!.headers["authorization"]).toBeUndefined()
    expect(connector.requests[1]!.headers["cookie"]).toBeUndefined()
    expect(connector.requests[1]!.headers["accept"]).toBe("*/*")
  })
})

describe("safeFetch: limits", () => {
  const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
  it("refuses a body whose Content-Length is over the limit without reading it", async () => {
    const connector = fakeConnector(() => reply(200, chunks("x"), { "content-length": "5000" }))
    const error = await failure("http://a.example/", { resolver, connector, maxBytes: 1000 })
    expect(error).toBeInstanceOf(NetTooLarge)
  })
  it("stops counting a body that grows past the limit without saying so", async () => {
    let produced = 0
    async function* endless() {
      for (;;) { produced++; yield new Uint8Array(400) }
    }
    const connector = fakeConnector(() => reply(200, endless()))
    const error = await failure("http://a.example/", { resolver, connector, maxBytes: 1000 })
    expect(error).toBeInstanceOf(NetTooLarge)
    expect(produced).toBeLessThanOrEqual(4)
  })
  it("accepts a body exactly at the limit", async () => {
    const connector = fakeConnector(() => reply(200, chunks(new Uint8Array(600), new Uint8Array(400))))
    const res = await Effect.runPromise(safeFetch("http://a.example/", { resolver, connector, maxBytes: 1000 }))
    expect(res.body.byteLength).toBe(1000)
  })
  it("times out on a body that stalls", async () => {
    async function* stall() {
      yield new Uint8Array(1)
      await new Promise(() => {})
    }
    const connector = fakeConnector(() => reply(200, stall()))
    const error = await failure("http://a.example/", { resolver, connector, timeoutMs: 40 })
    expect(error).toBeInstanceOf(NetTimeout)
  })
  it("times out on a connection that never answers, and tells the connector to stop", async () => {
    let signal: AbortSignal | undefined
    const connector = fakeConnector((r) => { signal = r.signal; return new Promise(() => {}) })
    const error = await failure("http://a.example/", { resolver, connector, timeoutMs: 40 })
    expect(error).toBeInstanceOf(NetTimeout)
    expect(signal?.aborted).toBe(true)
  })
  it("the time limit covers the whole chain of redirects", async () => {
    const connector = fakeConnector(async () => { await new Promise((r) => setTimeout(r, 25)); return reply(302, "", { location: "/x" }) })
    const error = await failure("http://a.example/", { resolver, connector, timeoutMs: 60, maxRedirects: 10 })
    expect(error).toBeInstanceOf(NetTimeout)
  })
  it("times out on a slow resolver", async () => {
    const slow = () => new Promise<ReadonlyArray<string>>(() => {})
    expect(await failure("http://a.example/", { resolver: slow, connector: fakeConnector(() => reply(200)), timeoutMs: 30 })).toBeInstanceOf(NetTimeout)
  })
})

describe("safeFetch: abort and interruption", () => {
  const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
  it("an AbortSignal that is already aborted fails with NetAborted", async () => {
    const error = await failure("http://a.example/", { resolver, connector: fakeConnector(() => reply(200)), signal: AbortSignal.abort() })
    expect(error).toBeInstanceOf(NetAborted)
  })
  it("an AbortSignal fired mid-request fails with NetAborted and reaches the connector", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const connector = fakeConnector((r) => { seen = r.signal; return new Promise(() => {}) })
    const pending = failure("http://a.example/", { resolver, connector, signal: controller.signal })
    await new Promise((r) => setTimeout(r, 10))
    controller.abort()
    expect(await pending).toBeInstanceOf(NetAborted)
    expect(seen?.aborted).toBe(true)
  })
  it("interrupting the fiber aborts the connection", async () => {
    let seen: AbortSignal | undefined
    const connector = fakeConnector((r) => { seen = r.signal; return new Promise(() => {}) })
    const fiber = Effect.runFork(safeFetch("http://a.example/", { resolver, connector }))
    await new Promise((r) => setTimeout(r, 10))
    const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.map(() => "interrupted")))
    expect(exit).toBe("interrupted")
    expect(seen?.aborted).toBe(true)
  })
})

describe("fetchOwnerConfiguredLan", () => {
  const resolver = fakeResolver({ "nas.local": ["192.168.1.5"], "meta.example": ["169.254.169.254"], "box.lan": ["10.0.0.9"], "lo.example": ["127.0.0.1"] })
  const connector = fakeConnector(() => reply(200, "lan"))
  it("safeFetch cannot reach the LAN, and has no option that does", async () => {
    expect(await refusedRule("http://192.168.1.5/", { connector, resolver })).toBe("address")
    expect(await refusedRule("http://nas.local/", { connector, resolver })).toBe("host-name")
    expect(await refusedRule("http://8.8.8.8:8123/", { connector, resolver })).toBe("port")
  })
  it("lets private, unique-local and CGNAT addresses, local names and other ports through", async () => {
    for (const url of ["http://192.168.1.5:8123/", "http://nas.local/", "http://box.lan:3000/", "http://[fd00::1]/", "http://100.64.0.2/", "http://printer/"]) {
      const res = await Effect.runPromise(fetchOwnerConfiguredLan(url, { connector, resolver: fakeResolver({ nas: ["10.0.0.1"], "nas.local": ["192.168.1.5"], "box.lan": ["10.0.0.9"], printer: ["192.168.1.7"] }) }))
      expect(res.status).toBe(200)
    }
  })
  it("still refuses loopback, link-local (cloud metadata) and multicast", async () => {
    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "http://meta.example/", "http://lo.example/", "http://224.0.0.1/", "http://0.0.0.0/"])
      expect(await refusedRule(url, { connector, resolver }, true)).toBe("address")
  })
  it("still refuses other schemes and credentials", async () => {
    expect(await refusedRule("ftp://192.168.1.5/", { connector, resolver }, true)).toBe("scheme")
    expect(await refusedRule("http://a:b@192.168.1.5/", { connector, resolver }, true)).toBe("credentials")
  })
})
