// fetchOwnerConfiguredLan: POST with a JSON body (sent once, to one server) and loopback only for the host the owner typed. The
// real-socket tests bind servers on this machine's loopback interface only (no request leaves the machine; packages/net/README.md).
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber } from "effect"
import http from "node:http"
import net, { type AddressInfo } from "node:net"
import { NetFailure, NetRefused, NetTimeout, NetTooLarge } from "../src/Errors.ts"
import {
  type ConnectRequest, type Connector, contentTypes, fetchOwnerConfiguredLan, nodeConnector, type OwnerConfiguredLanOptions, safeFetch,
  type SafeFetchOptions
} from "../src/SafeFetch.ts"
import { fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}
const refusal = async (effect: Effect.Effect<unknown, unknown>) => {
  const error = await errorOf(effect)
  expect(error).toBeInstanceOf(NetRefused)
  return error as NetRefused
}
const lanResolver = () => fakeResolver({ "ha.lan": ["192.168.1.20"], "two.lan": ["192.168.1.20", "192.168.1.21"], "other.lan": ["192.168.1.30"], "lo.lan": ["127.0.0.1"], localhost: ["127.0.0.1"], "localhost.": ["127.0.0.1"], "foo.localhost": ["127.0.0.1"] })
const json = (body: string = "{}", headers: Record<string, string> = {}) => reply(200, body, { "content-type": "application/json", ...headers })
/** A POST to the owner's server with a JSON body; the rest of the options as given. */
const post = (url: string, value: unknown, options: Omit<OwnerConfiguredLanOptions, "method" | "body" | "accept"> = {}) =>
  fetchOwnerConfiguredLan(url, { accept: contentTypes.json, method: "POST", body: { json: value }, ...options })

// ---- real servers on loopback -------------------------------------------------------------------------------------------------------

interface Seen { readonly method: string; readonly headers: http.IncomingHttpHeaders; readonly body: Buffer }
const serve = async (handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void) => {
  const seen: Array<Seen> = []
  const server = http.createServer((req, res) => {
    const parts: Array<Buffer> = []
    req.on("data", (c: Buffer) => parts.push(c))
    req.on("end", () => {
      const body = Buffer.concat(parts)
      seen.push({ method: req.method ?? "", headers: req.headers, body })
      handler(req, body, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())) }
  }
}
/** A port on 127.0.0.1 where nothing listens (bound, then closed). */
const closedPort = async () => {
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}
/** The real connector, sending each checked address to a port of this machine's loopback instead. */
const toLoopbackPorts = (ports: Readonly<Record<string, number>>): Connector => (r: ConnectRequest) => {
  const url = new URL(r.url.href)
  url.port = String(ports[r.address])
  return nodeConnector({ ...r, url, address: "127.0.0.1" })
}

describe("POST reaches the owner's server with exactly the body, type and length the helper made", () => {
  it("through a real socket (typed loopback literal)", async () => {
    const s = await serve((_req, _body, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}') })
    try {
      const value = { entity_id: "light.kitchen", brightness_pct: 40, name: "Küche" }
      const res = await Effect.runPromise(post(`http://127.0.0.1:${s.port}/api/services/light/turn_on`, value, { typedLoopback: true, headers: { Authorization: "Bearer t" } }))
      expect(res.status).toBe(200)
      expect(res.text()).toBe('{"ok":true}')
      expect(s.seen).toHaveLength(1)
      const [one] = s.seen
      expect(one!.method).toBe("POST")
      expect(one!.headers["content-type"]).toBe("application/json")
      const sent = Buffer.from(JSON.stringify(value), "utf8")
      expect(one!.headers["content-length"]).toBe(String(sent.byteLength)) // bytes, not characters ("ü" is two)
      expect(one!.headers["transfer-encoding"]).toBeUndefined()
      expect(one!.headers["authorization"]).toBe("Bearer t")
      expect(one!.body.equals(sent)).toBe(true)
    } finally { await s.close() }
  })
  it("the connector is handed the body and the headers the helper set", async () => {
    const connector = fakeConnector(() => json())
    await Effect.runPromise(post("http://ha.lan:8123/api/template", { template: "{{ 1 }}" }, { resolver: lanResolver(), connector }))
    const [r] = connector.requests
    expect(r!.method).toBe("POST")
    expect(new TextDecoder().decode(r!.body)).toBe('{"template":"{{ 1 }}"}')
    expect(r!.headers["content-type"]).toBe("application/json")
    expect(r!.headers["content-length"]).toBe("22")
    expect(r!.headers["accept"]).toBe("application/json")
  })
  it("a GET has no body, no Content-Type and no length (unchanged)", async () => {
    const connector = fakeConnector(() => json())
    await Effect.runPromise(fetchOwnerConfiguredLan("http://ha.lan/api/", { accept: contentTypes.json, resolver: lanResolver(), connector }))
    expect(connector.requests[0]!.method).toBe("GET")
    expect(connector.requests[0]!.body).toBeUndefined()
    expect(connector.requests[0]!.headers["content-type"]).toBeUndefined()
    expect(connector.requests[0]!.headers["content-length"]).toBeUndefined()
  })
})

describe("safeFetch stays GET and HEAD only", () => {
  it("in its type", () => {
    const options: SafeFetchOptions = { accept: contentTypes.json }
    // @ts-expect-error safeFetch takes no POST
    const post: SafeFetchOptions = { ...options, method: "POST" }
    // @ts-expect-error safeFetch takes no body
    const body: SafeFetchOptions = { ...options, body: { json: 1 } }
    expect([post, body]).toHaveLength(2)
  })
  it("at run time, whatever a cast says: a POST, a body, a loopback option, a request limit", async () => {
    const connector = fakeConnector(() => json())
    const resolver = fakeResolver({ "a.example": ["8.8.8.8"] })
    for (const extra of [{ method: "POST", body: { json: {} } }, { method: "POST" }, { body: { json: {} } }, { typedLoopback: true }, { typedLoopback: false }, { maxRequestBytes: 10 }, { method: "PUT" }]) {
      const error = await refusal(safeFetch("http://a.example/", { accept: contentTypes.json, resolver, connector, ...extra } as unknown as SafeFetchOptions))
      expect(error.rule, JSON.stringify(extra)).toBe("options")
    }
    expect(connector.requests).toEqual([])
    expect(resolver.calls).toEqual([])
  })
  it("fetchOwnerConfiguredLan takes no other method either", async () => {
    const connector = fakeConnector(() => json())
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "post"]) {
      const error = await refusal(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, resolver: lanResolver(), connector, method, body: { json: 1 } } as unknown as OwnerConfiguredLanOptions))
      expect(error.rule, method).toBe("options")
    }
    expect(connector.requests).toEqual([])
  })
})

describe("the helper owns the body", () => {
  it("a value that cannot be serialised is a typed refusal, never a defect, and its content is not shown", async () => {
    const circular: Record<string, unknown> = { token: "secret-in-key" }
    circular["self"] = circular
    const throwing = { toJSON: () => { throw new Error("secret-in-message") } }
    for (const value of [10n, circular, throwing, undefined, () => 1, Symbol("s")]) {
      const connector = fakeConnector(() => json())
      const resolver = lanResolver()
      const exit = await Effect.runPromiseExit(post("http://ha.lan/api/template", value, { resolver, connector }))
      expect(Exit.isFailure(exit) && exit.cause.reasons.every((r) => r._tag === "Fail"), String(typeof value)).toBe(true)
      const error = await refusal(post("http://ha.lan/api/template", value, { resolver, connector }))
      expect(error.rule).toBe("body")
      expect(JSON.stringify(error) + error.message).not.toMatch(/secret-in/)
      expect(connector.requests).toEqual([])
      expect(resolver.calls).toEqual([])
    }
  })
  it("a POST without `{ json }`, and a body on a GET or HEAD, are refused", async () => {
    const connector = fakeConnector(() => json())
    for (const options of [{ method: "POST" }, { method: "POST", body: "{}" }, { method: "POST", body: null }, { method: "POST", body: { text: "{}" } }, { body: { json: 1 } }, { method: "HEAD", body: { json: 1 } }]) {
      const error = await refusal(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, resolver: lanResolver(), connector, ...options } as unknown as OwnerConfiguredLanOptions))
      expect(error.rule, JSON.stringify(options)).toBe("body")
      expect(error.detail, JSON.stringify(options)).toBe(options.method === "POST" ? "A POST takes a body of the form { json }" : `A ${options.method ?? "GET"} has no body`)
    }
    expect(connector.requests).toEqual([])
  })
  it("a body over maxRequestBytes (64 KiB by default) is refused before anything is looked up or connected", async () => {
    const connector = fakeConnector(() => json())
    const resolver = lanResolver()
    // JSON.stringify of a string adds its two quotes.
    const atLimit = "x".repeat(64 * 1024 - 2)
    await Effect.runPromise(post("http://ha.lan/", atLimit, { resolver, connector }))
    expect(connector.requests[0]!.body!.byteLength).toBe(64 * 1024)
    const over = await refusal(post("http://ha.lan/", `${atLimit}x`, { resolver, connector }))
    expect(over.rule).toBe("body")
    // Bytes, not characters: 3 × "€" is 9 bytes and 11 with its quotes.
    expect((await refusal(post("http://ha.lan/", "€€€", { resolver, connector, maxRequestBytes: 10 }))).rule).toBe("body")
    expect(connector.requests).toHaveLength(1)
    expect(resolver.calls).toEqual(["ha.lan"])
  })
  it("a caller may lower the limit or raise it up to 1 MiB, and no further", async () => {
    const connector = fakeConnector(() => json())
    const big = "y".repeat(512 * 1024)
    expect((await refusal(post("http://ha.lan/", big, { resolver: lanResolver(), connector }))).rule).toBe("body")
    await Effect.runPromise(post("http://ha.lan/", big, { resolver: lanResolver(), connector, maxRequestBytes: 1024 * 1024 }))
    expect((await refusal(post("http://ha.lan/", { a: 1 }, { resolver: lanResolver(), connector, maxRequestBytes: 4 }))).rule).toBe("body")
    for (const maxRequestBytes of [1024 * 1024 + 1, 0, -1, 1.5, Number.NaN, "10" as unknown as number]) {
      expect((await refusal(post("http://ha.lan/", 1, { resolver: lanResolver(), connector, maxRequestBytes }))).rule, String(maxRequestBytes)).toBe("options")
    }
    expect(connector.requests).toHaveLength(1)
  })
  it("a caller-given Content-Type or Content-Length is refused, in any case", async () => {
    const connector = fakeConnector(() => json())
    for (const name of ["Content-Type", "content-type", "CONTENT-TYPE", "Content-Length"]) {
      const error = await refusal(post("http://ha.lan/", {}, { resolver: lanResolver(), connector, headers: { [name]: name.toLowerCase().includes("type") ? "text/plain" : "2" } }))
      expect(error.rule, name).toBe("header")
    }
    expect(connector.requests).toEqual([])
  })
})

describe("a POST is sent once, to one server", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`a ${status} answer is refused and the second server sees nothing`, async () => {
      const connector = fakeConnector((r) => (r.address === "192.168.1.20" ? reply(status, "", { location: "http://other.lan/api/next" }) : json()))
      const error = await refusal(post("http://ha.lan/api/services/x/y", { a: 1 }, { resolver: lanResolver(), connector }))
      expect(error.rule).toBe("post-redirect")
      expect(connector.requests.map((r) => r.address)).toEqual(["192.168.1.20"])
    })
  }
  it("a redirect to the same URL is not followed either", async () => {
    const connector = fakeConnector(() => reply(307, "", { location: "/api/services/x/y" }))
    expect((await refusal(post("http://ha.lan/api/services/x/y", {}, { resolver: lanResolver(), connector }))).rule).toBe("post-redirect")
    expect(connector.requests).toHaveLength(1)
  })
  it("a GET still follows its redirects (unchanged)", async () => {
    const connector = fakeConnector((r) => (r.address === "192.168.1.20" ? reply(302, "", { location: "http://other.lan/" }) : json()))
    const res = await Effect.runPromise(fetchOwnerConfiguredLan("http://ha.lan/", { accept: contentTypes.json, resolver: lanResolver(), connector }))
    expect(res.redirects).toEqual(["http://other.lan/"])
  })

  it("a server that accepts, reads the request and resets: no second attempt, and the error says it may have been carried out", async () => {
    let reads = 0
    const reset = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        reads += chunk.byteLength
        if (chunk.includes('"on":true')) socket.resetAndDestroy()
      })
    })
    await new Promise<void>((r) => reset.listen(0, "127.0.0.1", r))
    const good = await serve((_req, _body, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("{}") })
    try {
      const connector = toLoopbackPorts({ "192.168.1.20": (reset.address() as AddressInfo).port, "192.168.1.21": good.port })
      const error = await errorOf(post("http://two.lan/api/services/switch/turn_on", { on: true }, { resolver: lanResolver(), connector }))
      expect(error).toBeInstanceOf(NetFailure)
      expect((error as NetFailure).detail).toMatch(/may or may not have been carried out/)
      expect(reads).toBeGreaterThan(0)
      expect(good.seen).toEqual([])
      // The same failure on a GET moves on to the next address (unchanged).
      const res = await Effect.runPromise(fetchOwnerConfiguredLan("http://two.lan/x?on=true", { accept: contentTypes.json, resolver: lanResolver(), connector, headers: { "x-body": '"on":true' } }))
      expect(res.status).toBe(200)
      expect(good.seen.map((s) => s.method)).toEqual(["GET"])
    } finally {
      await good.close()
      await new Promise<void>((r) => reset.close(() => r()))
    }
  })
  it("a refused connect is certain to have sent nothing: the second address is tried, once", async () => {
    const good = await serve((_req, _body, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"done":1}') })
    try {
      const connector = toLoopbackPorts({ "192.168.1.20": await closedPort(), "192.168.1.21": good.port })
      const res = await Effect.runPromise(post("http://two.lan/api/services/switch/turn_on", { on: true }, { resolver: lanResolver(), connector }))
      expect(res.text()).toBe('{"done":1}')
      expect(good.seen.map((s) => [s.method, s.body.toString()])).toEqual([["POST", '{"on":true}']])
    } finally { await good.close() }
  })
  it("a connector failure that does not say nothing was sent ends a POST; a GET goes on", async () => {
    const connector = fakeConnector((r) => { if (r.address === "192.168.1.20") throw new Error("ECONNRESET"); return json() })
    const error = await errorOf(post("http://two.lan/", {}, { resolver: lanResolver(), connector }))
    expect(error).toBeInstanceOf(NetFailure)
    expect(connector.requests.map((r) => r.address)).toEqual(["192.168.1.20"])
    await Effect.runPromise(fetchOwnerConfiguredLan("http://two.lan/", { accept: contentTypes.json, resolver: lanResolver(), connector }))
    expect(connector.requests.map((r) => r.address)).toEqual(["192.168.1.20", "192.168.1.20", "192.168.1.21"])
  })
  it("a connect that runs out of its share before connecting goes on; one that connected keeps all the time and is not moved", async () => {
    // Honours the signal; says nothing was sent when cancelled before it connected.
    const blackHoled = (r: ConnectRequest) => new Promise<never>((_resolve, reject) => {
      r.signal.addEventListener("abort", () => reject(Object.assign(new Error("connect cancelled"), { notSent: true })), { once: true })
    })
    const first = fakeConnector((r) => (r.address === "192.168.1.20" ? blackHoled(r) : json('{"second":1}')))
    const started = Date.now()
    const res = await Effect.runPromise(post("http://two.lan/", {}, { resolver: lanResolver(), connector: first, timeoutMs: 600 }))
    expect(res.text()).toBe('{"second":1}')
    expect(Date.now() - started).toBeLessThan(600)
    // Connected, written, then slow: the share of time ended at the connect, so it waits for the total limit, and never moves on.
    const slow = fakeConnector((r) => {
      if (r.address !== "192.168.1.20") return json()
      r.onConnect?.()
      return new Promise<never>((_resolve, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted after writing")), { once: true }))
    })
    const error = await errorOf(post("http://two.lan/", {}, { resolver: lanResolver(), connector: slow, timeoutMs: 300 }))
    expect(error).toBeInstanceOf(NetTimeout)
    expect(slow.requests.map((r) => r.address)).toEqual(["192.168.1.20"])
    // No onConnect and no `notSent`: the share ran out, the connector could have written, so it is not moved either.
    const silent = fakeConnector((r) => (r.address === "192.168.1.20" ? new Promise<never>((_res, reject) => r.signal.addEventListener("abort", () => reject(new Error("x")), { once: true })) : json()))
    const silentError = await errorOf(post("http://two.lan/", {}, { resolver: lanResolver(), connector: silent, timeoutMs: 300 }))
    expect(silentError).toBeInstanceOf(NetFailure)
    expect(silent.requests.map((r) => r.address)).toEqual(["192.168.1.20"])
  })
})

describe("everything else applies to a POST's answer", () => {
  it("the accepted response types", async () => {
    let read = false
    async function* body() { read = true; yield new TextEncoder().encode("<html>") }
    const connector = fakeConnector(() => reply(200, body(), { "content-type": "text/html" }))
    expect((await refusal(post("http://ha.lan/", {}, { resolver: lanResolver(), connector }))).rule).toBe("content-type")
    expect(read).toBe(false)
  })
  it("the response byte limit, declared and counted", async () => {
    const declared = fakeConnector(() => json("{}", { "content-length": "5000" }))
    expect(await errorOf(post("http://ha.lan/", {}, { resolver: lanResolver(), connector: declared, maxBytes: 1000 }))).toBeInstanceOf(NetTooLarge)
    async function* endless() { for (;;) yield new Uint8Array(400) }
    const counted = fakeConnector(() => reply(200, endless(), { "content-type": "application/json" }))
    expect(await errorOf(post("http://ha.lan/", {}, { resolver: lanResolver(), connector: counted, maxBytes: 1000 }))).toBeInstanceOf(NetTooLarge)
  })
  it("the one total time limit, on an answer that stalls", async () => {
    async function* stall() { yield new TextEncoder().encode("{"); await new Promise(() => {}) }
    const connector = fakeConnector(() => reply(200, stall(), { "content-type": "application/json" }))
    expect(await errorOf(post("http://ha.lan/", {}, { resolver: lanResolver(), connector, timeoutMs: 50 }))).toBeInstanceOf(NetTimeout)
  })
  it("the address rules: a POST to link-local or a name resolving there is refused before it is sent", async () => {
    const connector = fakeConnector(() => json())
    expect((await refusal(post("http://169.254.169.254/", {}, { resolver: lanResolver(), connector }))).rule).toBe("address")
    expect((await refusal(post("http://lo.lan/", {}, { resolver: lanResolver(), connector }))).rule).toBe("address")
    expect(connector.requests).toEqual([])
  })
  it("interrupting the caller during a slow answer closes the connection and ends the effect promptly", async () => {
    let received = false
    let closed = false
    // Reads the whole POST and never answers.
    const server = http.createServer((req) => {
      req.resume()
      req.on("end", () => { received = true })
      req.socket.on("close", () => { closed = true })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    try {
      const port = (server.address() as AddressInfo).port
      const fiber = Effect.runFork(post(`http://127.0.0.1:${port}/api/services/x/y`, { a: 1 }, { typedLoopback: true, timeoutMs: 10_000 }))
      for (let i = 0; i < 200 && !received; i++) await new Promise((r) => setTimeout(r, 10))
      expect(received).toBe(true)
      const started = Date.now()
      const exit = await Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber))))
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((r) => r._tag === "Interrupt")).toBe(true)
      expect(Date.now() - started).toBeLessThan(1_000)
      for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10))
      expect(closed).toBe(true)
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())) }
  })
})

describe("loopback only when the owner typed it", () => {
  const lan = (url: string, options: Pick<SafeFetchOptions, "resolver" | "connector"> & { readonly typedLoopback?: boolean } = {}) =>
    fetchOwnerConfiguredLan(url, { accept: contentTypes.json, ...options })
  for (const [url, addresses] of [
    ["http://127.0.0.1:8123/api/", ["127.0.0.1"]], ["http://127.5.6.7/", ["127.5.6.7"]], ["http://[::1]:8123/", ["::1"]],
    ["http://localhost:8123/api/", ["127.0.0.1"]], ["http://LOCALHOST/", ["127.0.0.1"]]
  ] as const) {
    it(`${url} with the option: connected as loopback, no lookup`, async () => {
      const resolver = lanResolver()
      const connector = fakeConnector(() => json())
      await Effect.runPromise(lan(url, { resolver, connector, typedLoopback: true }))
      expect(resolver.calls).toEqual([])
      expect(connector.requests.map((r) => r.address)).toEqual(addresses)
    })
    it(`${url} without the option, or with it false: refused`, async () => {
      for (const typedLoopback of [undefined, false]) {
        const connector = fakeConnector(() => json())
        const error = await refusal(lan(url, { resolver: lanResolver(), connector, ...(typedLoopback === undefined ? {} : { typedLoopback }) }))
        expect(error.rule).toBe("address")
        expect(error.addressClass).toBe("loopback")
        expect(connector.requests).toEqual([])
      }
    })
  }
  it("localhost is tried as 127.0.0.1, then ::1 when 127.0.0.1 refused the connection (a POST too)", async () => {
    const connector = fakeConnector((r) => {
      if (r.address === "127.0.0.1") return Promise.reject(Object.assign(new Error("ECONNREFUSED"), { notSent: true }))
      return json()
    })
    await Effect.runPromise(post("http://localhost:8123/api/services/x/y", {}, { resolver: lanResolver(), connector, typedLoopback: true }))
    expect(connector.requests.map((r) => r.address)).toEqual(["127.0.0.1", "::1"])
  })
  it("localhost through the real connector reaches a server on 127.0.0.1", async () => {
    const s = await serve((_req, _body, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end("[]") })
    try {
      const res = await Effect.runPromise(post(`http://localhost:${s.port}/api/template`, { template: "x" }, { typedLoopback: true }))
      expect(res.text()).toBe("[]")
      expect(s.seen[0]!.headers.host).toBe(`localhost:${s.port}`)
    } finally { await s.close() }
  })
  it("names that are not exactly localhost, and mapped loopback, stay refused with the option", async () => {
    for (const url of ["http://localhost./", "http://foo.localhost/", "http://[::ffff:127.0.0.1]/", "http://lo.lan/"]) {
      const connector = fakeConnector(() => json())
      const error = await refusal(lan(url, { resolver: lanResolver(), connector, typedLoopback: true }))
      expect(error.rule, url).toBe("address")
      expect(error.addressClass, url).toBe("loopback")
      expect(connector.requests, url).toEqual([])
    }
  })
  it("a LAN name that resolves to loopback is refused with the option", async () => {
    const resolver = lanResolver()
    const error = await refusal(post("http://lo.lan:8123/api/", {}, { resolver, connector: fakeConnector(() => json()), typedLoopback: true }))
    expect(error.addressClass).toBe("loopback")
    expect(resolver.calls).toEqual(["lo.lan"])
  })
  it("a redirect to loopback is refused with the option, also from a typed loopback host to itself", async () => {
    for (const [from, to] of [["http://ha.lan/", "http://127.0.0.1/"], ["http://ha.lan/", "http://localhost/"], ["http://ha.lan/", "http://[::1]/"], ["http://127.0.0.1:8123/", "http://127.0.0.1:8123/next"], ["http://localhost/", "http://localhost/next"]] as const) {
      const connector = fakeConnector((r) => (r.url.pathname === "/" ? reply(302, "", { location: to }) : json()))
      const error = await refusal(lan(from, { resolver: lanResolver(), connector, typedLoopback: true }))
      expect(error.rule, `${from} → ${to}`).toBe("address")
      expect(connector.requests, `${from} → ${to}`).toHaveLength(1)
    }
  })
  it("typedLoopback must be a boolean", async () => {
    const error = await refusal(lan("http://127.0.0.1/", { connector: fakeConnector(() => json()), typedLoopback: "yes" as unknown as boolean }))
    expect(error.rule).toBe("options")
  })
})

describe("the node connector says when nothing was sent", () => {
  it("a refused connection is notSent; a reset after the request was written is not", async () => {
    const port = await closedPort()
    const url = new URL(`http://127.0.0.1:${port}/`)
    const refused = await nodeConnector({ url, address: "127.0.0.1", method: "POST", headers: {}, body: new Uint8Array([1]), signal: new AbortController().signal }).catch((e: unknown) => e)
    expect((refused as { notSent?: boolean }).notSent).toBe(true)
    const reset = net.createServer((socket) => socket.on("data", () => socket.resetAndDestroy()))
    await new Promise<void>((r) => reset.listen(0, "127.0.0.1", r))
    try {
      let connected = 0
      const after = await nodeConnector({
        url: new URL(`http://127.0.0.1:${(reset.address() as AddressInfo).port}/`), address: "127.0.0.1", method: "POST", headers: {}, body: new Uint8Array([1]),
        onConnect: () => { connected++ }, signal: new AbortController().signal
      }).catch((e: unknown) => e)
      expect((after as { notSent?: boolean }).notSent).toBeUndefined()
      expect(connected).toBe(1)
    } finally { await new Promise<void>((r) => reset.close(() => r())) }
  })
  it("the length is the body's, whatever the headers say", async () => {
    const s = await serve((_req, _body, res) => res.end())
    try {
      const res = await nodeConnector({ url: new URL(`http://127.0.0.1:${s.port}/`), address: "127.0.0.1", method: "POST", headers: { "content-length": "999" }, body: new TextEncoder().encode("abc"), signal: new AbortController().signal })
      for await (const _ of res.body) { /* drain */ }
      expect(s.seen[0]!.headers["content-length"]).toBe("3")
      expect(s.seen[0]!.body.toString()).toBe("abc")
    } finally { await s.close() }
  })
})
