// Review round 1 of the POST and typed-loopback change (fetchOwnerConfiguredLan): each finding's case, failing on the code before
// the fix. The real-socket tests bind servers on this machine's loopback interface only (packages/net/README.md).
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { NetAborted, NetRefused, NetTimeout } from "../src/Errors.ts"
import {
  type ConnectRequest, type ConnectResponse, contentTypes, fetchOwnerConfiguredLan, invalidUrlShown, maxMaxRequestBytes,
  type OwnerConfiguredLanOptions, safeFetch, type SafeFetchOptions
} from "../src/SafeFetch.ts"
import * as before from "./fixtures/SafeFetch.before.ts"
import { fakeConnector, fakeResolver, reply } from "./helpers.ts"

const exitOf = (effect: Effect.Effect<unknown, unknown>) => Effect.runPromiseExit(effect)
const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await exitOf(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  // Every reason is a typed failure: no defect, no interruption.
  expect(exit.cause.reasons.every((r) => r._tag === "Fail")).toBe(true)
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}
const shown = (error: unknown) => `${JSON.stringify(error)} ${(error as Error).message}`
/** What the system resolver answers for these names: loopback. */
const resolver = () => fakeResolver({
  "ha.lan": ["192.168.1.20"], localhost: ["127.0.0.1", "::1"], "localhost.": ["127.0.0.1"], "x.localhost": ["127.0.0.1"], "x.localhost.": ["127.0.0.1"]
})
const json = (body = "{}", headers: Record<string, string> = {}) => reply(200, body, { "content-type": "application/json", ...headers })
type Method = "GET" | "HEAD" | "POST"
const lan = (url: string | URL, method: Method, extra: Record<string, unknown> = {}) =>
  fetchOwnerConfiguredLan(url, { accept: contentTypes.json, ...(method === "POST" ? { method, body: { json: { a: 1 } } } : { method }), ...extra } as OwnerConfiguredLanOptions)

const listen = async (handler: http.RequestListener) => {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return { port: (server.address() as AddressInfo).port, close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())) } }
}

describe("finding 1: typed loopback is decided on the host as the owner wrote it", () => {
  // Spellings the URL parser turns into 127.0.0.1, ::1 or localhost, but which are not one of the three typed spellings.
  const spellings = [
    "2130706433", "0x7f000001", "0x7f.0.0.1", "0177.0.0.1", "127.1", "127.0.1", "127.0.0.1.", "127.000.0.1", "127.0.0.01",
    "%6cocalhost", "loc%61lhost", "ℓocalhost", "localhost.", "LOCALHOST.", "x.localhost", "x.localhost.", "local\thost",
    "[::0.0.0.1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:0:0:1]", "[::0001]", "[0::1]"
  ]
  for (const host of spellings) {
    it(`${JSON.stringify(host)} is refused for GET, HEAD and POST, with the option, without it, or false`, async () => {
      for (const method of ["GET", "HEAD", "POST"] as const) {
        for (const option of [{ typedLoopback: true }, {}, { typedLoopback: false }]) {
          const connector = fakeConnector(() => json())
          const error = await errorOf(lan(`http://${host}:8123/api/`, method, { resolver: resolver(), connector, ...option }))
          expect(error, `${method} ${JSON.stringify(option)}`).toBeInstanceOf(NetRefused)
          expect(connector.requests, `${method} ${JSON.stringify(option)}`).toEqual([])
        }
      }
    })
  }
  it("the numeric and escaped spellings do not reach a real server on 127.0.0.1 (the reviewer's probe)", async () => {
    let requests = 0
    const s = await listen((_req, res) => { requests++; res.writeHead(200, { "content-type": "application/json" }); res.end("{}") })
    try {
      for (const host of ["2130706433", "0x7f000001", "127.1", "0177.0.0.1", "127.0.0.1.", "%6cocalhost", "ℓocalhost"]) {
        for (const method of ["GET", "HEAD", "POST"] as const) {
          // The real resolver and connector: whatever the system answers for a name, it is loopback, which is refused.
          const exit = await exitOf(lan(`http://${host}:${s.port}/`, method, { typedLoopback: true }))
          expect(Exit.isFailure(exit), `${method} ${host}`).toBe(true)
        }
      }
      expect(requests).toBe(0)
    } finally { await s.close() }
  })
  it("a URL object carries no spelling: refused, even for localhost", async () => {
    for (const url of [new URL("http://localhost:8123/"), new URL("http://127.0.0.1:8123/"), new URL("http://[::1]/")]) {
      const connector = fakeConnector(() => json())
      const error = await errorOf(lan(url, "POST", { resolver: resolver(), connector, typedLoopback: true }))
      expect(error).toBeInstanceOf(NetRefused)
      expect(connector.requests).toEqual([])
    }
  })
  it("text the parser reads differently from the plain reading is refused: a user name, an empty or odd port", async () => {
    for (const url of ["http://localhost:/", "http://localhost:80x/", "http://u@localhost/", "http://localhost :8123/", " http://localhost/"]) {
      const connector = fakeConnector(() => json())
      expect(await errorOf(lan(url, "GET", { resolver: resolver(), connector, typedLoopback: true })), url).toBeInstanceOf(NetRefused)
      expect(connector.requests, url).toEqual([])
    }
  })
  it("the three typed spellings still pass, with any case of localhost and any port", async () => {
    for (const [url, addresses] of [
      ["http://127.0.0.1:8123/", ["127.0.0.1"]], ["http://127.255.255.254/", ["127.255.255.254"]], ["http://[::1]:8123/", ["::1"]],
      ["http://localhost:8123/", ["127.0.0.1"]], ["HTTP://LocalHost/api", ["127.0.0.1"]], ["https://localhost/", ["127.0.0.1"]]
    ] as const) {
      const r = resolver()
      const connector = fakeConnector(() => json())
      await Effect.runPromise(lan(url, "POST", { resolver: r, connector, typedLoopback: true }))
      expect(connector.requests.map((q) => q.address), url).toEqual(addresses)
      expect(r.calls, url).toEqual([])
    }
  })
})

describe("finding 2: serialising is inside the one deadline, and the body has a lower maximum", () => {
  /** A value whose serialisation takes `ms` of main-thread time, counting its calls. */
  const slow = (ms: number) => {
    const calls = { n: 0 }
    return { calls, value: { toJSON: () => { calls.n++; const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } return { ok: true } } } }
  }
  it("a serialisation that outlasts timeoutMs ends in NetTimeout, and nothing is connected", async () => {
    const { value, calls } = slow(40)
    const r = resolver()
    const connector = fakeConnector(() => json())
    const error = await errorOf(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: { json: value }, timeoutMs: 10, resolver: r, connector }))
    expect(error).toBeInstanceOf(NetTimeout)
    expect(calls.n).toBe(1)
    expect(r.calls).toEqual([])
    expect(connector.requests).toEqual([])
  })
  it("an already-aborted signal: the body is not serialised", async () => {
    const { value, calls } = slow(0)
    const error = await errorOf(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: { json: value }, signal: AbortSignal.abort(), resolver: resolver(), connector: fakeConnector(() => json()) }))
    expect(error).toBeInstanceOf(NetAborted)
    expect(calls.n).toBe(0)
  })
  it("the maximum is 128 KiB: 128 KiB passes, more is refused as an option", async () => {
    expect(maxMaxRequestBytes).toBe(128 * 1024)
    const connector = fakeConnector(() => json())
    const atMax = "z".repeat(128 * 1024 - 2)
    await Effect.runPromise(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: { json: atMax }, maxRequestBytes: 128 * 1024, resolver: resolver(), connector }))
    expect(connector.requests[0]!.body!.byteLength).toBe(128 * 1024)
    for (const maxRequestBytes of [128 * 1024 + 1, 256 * 1024, 1024 * 1024]) {
      const error = (await errorOf(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: { json: 1 }, maxRequestBytes, resolver: resolver(), connector }))) as NetRefused
      expect(error.rule).toBe("options")
    }
    expect(connector.requests).toHaveLength(1)
  })
  // The number in packages/net/README.md and docs/MODULES.md §12. Run with PVA_MEASURE=1 (on an otherwise idle machine).
  it.skipIf(process.env.PVA_MEASURE !== "1")("measures the longest main-thread stop for the largest legal body", async () => {
    const max = maxMaxRequestBytes
    const shapes: Record<string, () => unknown> = {
      "small properties": () => { const o: Record<string, number> = {}; let len = 2; for (let i = 0; len < max - 24; i++) { o[`k${i}`] = i; len += `k${i}`.length + 4 + String(i).length } return o },
      "small objects": () => { const a: Array<unknown> = []; let len = 2; while (len < max - 40) { a.push({ id: a.length, on: true }); len += 22 + String(a.length).length } return a },
      "numbers": () => new Array(Math.floor((max - 2) / 2)).fill(1),
      "escapes": () => "\u0001".repeat(Math.floor((max - 2) / 6))
    }
    const connector = fakeConnector(() => json())
    for (const [name, make] of Object.entries(shapes)) {
      const value = make()
      const gaps: Array<number> = []
      for (let round = 0; round < 20; round++) {
        let last = performance.now()
        let longest = 0
        const beat = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now }, 1)
        await new Promise((r) => setTimeout(r, 5))
        last = performance.now()
        longest = 0
        await Effect.runPromise(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: { json: value }, maxRequestBytes: max, resolver: resolver(), connector }))
        await new Promise((r) => setTimeout(r, 5))
        clearInterval(beat)
        gaps.push(longest)
      }
      gaps.sort((a, b) => a - b)
      const bytes = connector.requests.at(-1)!.body!.byteLength
      console.log(`MEASURE ${name}: ${bytes} bytes, heartbeat gap median ${gaps[10]!.toFixed(2)} ms, max ${gaps.at(-1)!.toFixed(2)} ms`)
    }
  })
})

describe("finding 3: no received header value appears in an error", () => {
  const secret = "review-secret-body"
  const token = "review-secret-token"
  it("a server that reflects the POST body into Content-Encoding and the credentials into Content-Type (a real socket)", async () => {
    const s = await listen((req, res) => {
      const parts: Array<Buffer> = []
      req.on("data", (c: Buffer) => parts.push(c))
      req.on("end", () => {
        const body = Buffer.concat(parts).toString()
        const auth = String(req.headers.authorization ?? "").replace(/^Bearer /, "")
        if (req.url === "/encoding") res.writeHead(200, { "content-type": "application/json", "content-encoding": body })
        else res.writeHead(200, { "content-type": `application/x-${auth}` })
        res.end("{}")
      })
    })
    try {
      for (const path of ["/encoding", "/type"]) {
        const error = await errorOf(fetchOwnerConfiguredLan(`http://127.0.0.1:${s.port}${path}`, {
          accept: contentTypes.json, method: "POST", body: { json: { token: secret } }, typedLoopback: true, headers: { authorization: `Bearer ${token}` }
        }))
        expect(error, path).toBeInstanceOf(NetRefused)
        expect((error as NetRefused).rule).toBe(path === "/encoding" ? "content-encoding" : "content-type")
        expect(shown(error), path).not.toContain(secret)
        expect(shown(error), path).not.toContain(token)
      }
    } finally { await s.close() }
  })
  it("a redirect target is not quoted: the refusal names the URL that answered and the rule", async () => {
    for (const [location, rule] of [
      [`http://${secret}.local/x`, "host-name"], [`http://a.example:4444/${secret}`, "port"], [`ftp://${secret}.example/`, "scheme"],
      [`http://u:${token}@b.example/`, "credentials"]
    ] as const) {
      const connector = fakeConnector(() => reply(302, "", { location }))
      const error = (await errorOf(safeFetch("http://a.example/start", { accept: contentTypes.json, resolver: fakeResolver({ "a.example": ["8.8.8.8"] }), connector }))) as NetRefused
      expect(error.rule, location).toBe(rule)
      expect(error.url).toBe("http://a.example/start")
      expect(shown(error), location).not.toContain(secret)
      expect(shown(error), location).not.toContain(token)
      expect(shown(error), location).not.toContain("4444")
    }
  })
})

describe("finding 4: nothing is read from what the serialiser throws", () => {
  const secret = "review-secret-body"
  const hostile: ReadonlyArray<readonly [string, () => unknown]> = [
    ["an Error whose name holds the body", () => ({ toJSON: () => { const e = new Error("x"); e.name = secret; throw e } })],
    ["an Error whose name is a getter that throws", () => ({ toJSON: () => { const e = new Error("x"); Object.defineProperty(e, "name", { get: () => { throw new Error(secret) } }); throw e } })],
    ["an Error whose message is a getter that throws", () => ({ toJSON: () => { const e = new Error("x"); Object.defineProperty(e, "message", { get: () => { throw new Error(secret) } }); throw e } })],
    ["a thrown object whose toString throws", () => ({ toJSON: () => { throw { toString: () => { throw new Error(secret) }, name: secret } } })],
    ["a thrown string holding the body", () => ({ toJSON: () => { throw secret } })],
    ["a json getter that throws", () => undefined]
  ]
  for (const [name, make] of hostile) {
    it(name, async () => {
      const body = name === "a json getter that throws" ? { get json(): unknown { throw new Error(secret) } } : { json: make() }
      const connector = fakeConnector(() => json())
      const error = (await errorOf(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: body as never, resolver: resolver(), connector }))) as NetRefused
      expect(error).toBeInstanceOf(NetRefused)
      expect(error.rule).toBe("body")
      expect(error.detail).toBe("The body cannot be serialised as JSON")
      expect(shown(error)).not.toContain(secret)
      expect(connector.requests).toEqual([])
    })
  }
  it("a hostile value thrown elsewhere (an option's getter) is a typed NetFailure, not a defect, and is not shown", async () => {
    const options = Object.defineProperty({ accept: contentTypes.json }, "headers", {
      get: () => { throw { toString: () => { throw new Error(secret) } } }, enumerable: true
    })
    const error = await errorOf(fetchOwnerConfiguredLan("http://ha.lan/", options as OwnerConfiguredLanOptions))
    expect((error as { _tag: string })._tag).toBe("NetFailure")
    expect(shown(error)).not.toContain(secret)
  })
  it("a body that is a proxy whose `has` throws", async () => {
    const body = new Proxy({}, { has: () => { throw new Error(secret) } })
    const error = (await errorOf(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, method: "POST", body: body as never, resolver: resolver(), connector: fakeConnector(() => json()) }))) as NetRefused
    expect(error.rule).toBe("body")
    expect(shown(error)).not.toContain(secret)
  })
})

describe("finding 6: every 3xx answer to a POST is refused", () => {
  for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
    it(`${status}, with a Location: post-redirect, and only one request`, async () => {
      const connector = fakeConnector(() => reply(status, '{"x":1}', { location: "http://ha.lan/elsewhere", "content-type": "application/json" }))
      const error = (await errorOf(fetchOwnerConfiguredLan("http://ha.lan/api/services/a/b", { accept: contentTypes.json, method: "POST", body: { json: {} }, resolver: resolver(), connector }))) as NetRefused
      expect(error.rule).toBe("post-redirect")
      expect(connector.requests).toHaveLength(1)
    })
  }
  it("300 with a Location and a JSON body from a real server", async () => {
    let requests = 0
    const s = await listen((req, res) => { requests++; req.resume(); res.writeHead(300, { location: "/other", "content-type": "application/json" }); res.end("{}") })
    try {
      const error = (await errorOf(fetchOwnerConfiguredLan(`http://127.0.0.1:${s.port}/`, { accept: contentTypes.json, method: "POST", body: { json: {} }, typedLoopback: true }))) as NetRefused
      expect(error.rule).toBe("post-redirect")
      expect(requests).toBe(1)
    } finally { await s.close() }
  })
  it("a GET still gets 300 and 304 back as answers (unchanged)", async () => {
    for (const status of [300, 304]) {
      const res = await Effect.runPromise(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, resolver: resolver(), connector: fakeConnector(() => reply(status, "", { location: "/x" })) }))
      expect(res.status).toBe(status)
    }
  })
})

describe("finding 7: no error shows a user name or password, whether the URL parses or not", () => {
  const password = "review-password"
  const urls = [`http://user:${password}@ha.lan/`, `http://user:${password}@ha.lan:bad/`, `http://user:${password}@[`, `http://user:${password}@ha.lan:8123/%zz`]
  const slow = { toJSON: () => { const end = Date.now() + 30; while (Date.now() < end) { /* spin */ } return 1 } }
  const throwingHeaders = Object.defineProperty({ accept: contentTypes.json }, "headers", { get: () => { throw new Error("headers getter") }, enumerable: true })
  const paths: ReadonlyArray<readonly [string, (url: string) => Effect.Effect<unknown, unknown>]> = [
    ["timeoutMs refused", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, timeoutMs: 0 })],
    ["maxBytes refused", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, maxBytes: -1 })],
    ["safeFetch POST refused", (url) => safeFetch(url, { accept: contentTypes.json, method: "POST" } as unknown as SafeFetchOptions)],
    ["a header refused", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, headers: { Host: "x" } })],
    ["a POST's Content-Type refused", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: { json: 1 }, headers: { "content-type": "text/plain" } })],
    ["a body without json", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: {} as never })],
    ["a body on a GET", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, body: { json: 1 } } as unknown as OwnerConfiguredLanOptions)],
    ["an unserialisable body", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: { json: 1n } })],
    ["a body over the limit", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: { json: "xxxxxxxx" }, maxRequestBytes: 4 })],
    ["an aborted POST", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: { json: 1 }, signal: AbortSignal.abort() })],
    ["a POST whose serialisation outlasts the time limit", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: { json: slow }, timeoutMs: 5 })],
    ["the URL rules (credentials, or not a URL)", (url) => fetchOwnerConfiguredLan(url, { accept: contentTypes.json, resolver: resolver(), connector: fakeConnector(() => json()) })],
    ["safeFetch's URL rules", (url) => safeFetch(url, { accept: contentTypes.json, resolver: resolver(), connector: fakeConnector(() => json()) })],
    ["a failure that is no rule (a throwing option)", (url) => fetchOwnerConfiguredLan(url, throwingHeaders as OwnerConfiguredLanOptions)]
  ]
  for (const [name, call] of paths) {
    it(name, async () => {
      for (const url of urls) {
        const error = await errorOf(call(url))
        expect(error, `${name}: ${url}`).toBeDefined()
        expect(shown(error), `${name}: ${url}`).not.toContain(password)
        expect(shown(error), `${name}: ${url}`).not.toContain("user:")
        const valid = (() => { try { return new URL(url) } catch { return undefined } })()
        if (valid === undefined) expect((error as { url: string }).url, `${name}: ${url}`).toBe(invalidUrlShown)
      }
    })
  }
})

describe("GET and HEAD without the new options behave as before the change", () => {
  const addresses = { "ok.example": ["8.8.8.8"], "next.example": ["1.1.1.1"], "ha.lan": ["192.168.1.20"], "mixed.example": ["8.8.8.8", "127.0.0.1"], "two.example": ["8.8.8.8", "1.1.1.1"], localhost: ["127.0.0.1"] }
  const answer = (status: number, headers: Record<string, string> = {}, text = '{"a":1}'): ConnectResponse => reply(status, text, { "content-type": "application/json", ...headers })
  const cases: ReadonlyArray<{ readonly name: string; readonly url: string; readonly headers?: Record<string, string>; readonly maxBytes?: number; readonly respond: (r: ConnectRequest) => ConnectResponse }> = [
    { name: "json", url: "http://ok.example/a?b=1", respond: () => answer(200) },
    { name: "a caller's Content-Type on a GET", url: "http://ok.example/", headers: { "Content-Type": "text/plain" }, respond: () => answer(200) },
    { name: "a LAN host and port", url: "http://ha.lan:8123/", respond: () => answer(200) },
    { name: "a name with a loopback answer", url: "http://mixed.example/", respond: () => answer(200) },
    { name: "localhost", url: "http://localhost/", respond: () => answer(200) },
    { name: "a loopback literal", url: "http://127.0.0.1/", respond: () => answer(200) },
    { name: "a mapped loopback literal", url: "http://[::ffff:127.0.0.1]/", respond: () => answer(200) },
    { name: "an integer address", url: "http://2130706433/", respond: () => answer(200) },
    { name: "metadata", url: "http://169.254.169.254/", respond: () => answer(200) },
    { name: "a local name", url: "http://ha.local/", respond: () => answer(200) },
    { name: "a port", url: "http://ok.example:8123/", respond: () => answer(200) },
    { name: "a scheme", url: "file:///etc/passwd", respond: () => answer(200) },
    { name: "credentials", url: "http://u:p@ok.example/", respond: () => answer(200) },
    { name: "not a URL", url: "http://[", respond: () => answer(200) },
    { name: "an unaccepted type", url: "http://ok.example/", respond: () => answer(200, { "content-type": "text/html" }) },
    { name: "two types", url: "http://ok.example/", respond: () => ({ ...answer(200), contentTypeLines: ["application/json", "text/html"] }) },
    { name: "an error page of another type", url: "http://ok.example/", respond: () => answer(500, { "content-type": "text/html" }) },
    { name: "an unknown encoding", url: "http://ok.example/", respond: () => answer(200, { "content-encoding": "zstd" }) },
    { name: "too large", url: "http://ok.example/", maxBytes: 3, respond: () => answer(200) },
    { name: "204", url: "http://ok.example/", respond: () => answer(204) },
    { name: "300", url: "http://ok.example/", respond: () => answer(300, { location: "/x" }) },
    { name: "304", url: "http://ok.example/", respond: () => answer(304) },
    { name: "a cross-origin redirect", url: "http://ok.example/", headers: { authorization: "a", "if-none-match": "e" }, respond: (r) => (r.url.hostname === "ok.example" ? answer(302, { location: "http://next.example/n" }) : answer(200)) },
    { name: "a same-origin redirect", url: "http://ok.example/", headers: { authorization: "a", "if-none-match": "e" }, respond: (r) => (r.url.pathname === "/" ? answer(307, { location: "/n" }) : answer(200)) },
    { name: "a redirect to a local name", url: "http://ok.example/", respond: () => answer(302, { location: "http://x.local/" }) },
    { name: "a redirect to loopback", url: "http://ok.example/", respond: () => answer(302, { location: "http://127.0.0.1/" }) },
    { name: "a redirect without Location", url: "http://ok.example/", respond: () => answer(302) },
    { name: "the next address", url: "http://two.example/", respond: (r) => { if (r.address === "8.8.8.8") throw new Error("ECONNRESET"); return answer(200) } }
  ]
  const outcome = async (effect: Effect.Effect<{ readonly status: number; readonly text: () => string; readonly redirects: ReadonlyArray<string>; readonly headers: Readonly<Record<string, string>> }, unknown>) => {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return { ok: true, status: exit.value.status, text: exit.value.text(), redirects: exit.value.redirects, headers: { ...exit.value.headers } }
    const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
    const error = reason?._tag === "Fail" ? (reason.error as { _tag: string; rule?: string; stage?: string; addressClass?: string }) : undefined
    // The details and the URL of a refusal are not compared: review round 1 changed what they show (findings 3 and 7), not what happens.
    return { ok: false, tag: error?._tag, rule: error?.rule, stage: error?.stage, addressClass: error?.addressClass }
  }
  for (const front of ["safeFetch", "fetchOwnerConfiguredLan"] as const) {
    for (const method of ["GET", "HEAD"] as const) {
      it(`${front} ${method}: the same results and the same requests`, async () => {
        for (const c of cases) {
          const run = async (impl: { safeFetch: typeof safeFetch; fetchOwnerConfiguredLan: typeof safeFetch }) => {
            const connector = fakeConnector(c.respond)
            const options: SafeFetchOptions = { accept: contentTypes.json, method, resolver: fakeResolver(addresses), connector, ...(c.headers ? { headers: c.headers } : {}), ...(c.maxBytes ? { maxBytes: c.maxBytes } : {}) }
            const result = await outcome(impl[front](c.url, options))
            return { result, requests: connector.requests.map((r) => ({ url: r.url.href, address: r.address, method: r.method, headers: { ...r.headers }, body: r.body })) }
          }
          const now = await run({ safeFetch, fetchOwnerConfiguredLan })
          const then = await run(before)
          expect(now, `${front} ${method} ${c.name}`).toEqual(then)
        }
      })
    }
  }
})
