// makeFixedApi: calls to a fixed public API whose hosts the module's own code names (Spotify). Every request goes to a fake
// connector: nothing leaves the machine.
import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { NetFailure, NetRefused } from "../src/Errors.ts"
import { makeFixedApi } from "../src/FixedApi.ts"
import { contentTypes } from "../src/SafeFetch.ts"
import { fakeConnector, fakeResolver, reply } from "./helpers.ts"

const errorOf = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const reason = exit.cause.reasons.find((r) => r._tag === "Fail")
  return reason?._tag === "Fail" ? reason.error : undefined
}

const json = { "content-type": "application/json" }
const api = makeFixedApi({ hosts: ["api.spotify.com", "Accounts.Spotify.com"] })
const resolver = fakeResolver({
  "api.spotify.com": ["35.186.224.25"],
  "accounts.spotify.com": ["35.186.224.26"],
  "api.spotify.com.evil.com": ["93.184.216.34"],
  "evil.com": ["93.184.216.34"],
  "private.spotify.com": ["192.168.1.5"]
})
const base = { accept: contentTypes.json, resolver } as const
const rule = async (effect: Effect.Effect<unknown, unknown>) => ((await errorOf(effect)) as NetRefused).rule

describe("makeFixedApi hosts", () => {
  it("validates the list at construction", () => {
    expect(() => makeFixedApi({ hosts: [] })).toThrow()
    expect(() => makeFixedApi({ hosts: ["8.8.8.8"] })).toThrow()
    expect(() => makeFixedApi({ hosts: ["[::1]"] })).toThrow()
    expect(() => makeFixedApi({ hosts: ["localhost"] })).toThrow()
    expect(() => makeFixedApi({ hosts: ["*.spotify.com"] })).toThrow()
    expect(() => makeFixedApi({ hosts: ["api.spotify.com:443"] })).toThrow()
    expect(() => makeFixedApi({ hosts: ["api.spotify.com/x"] })).toThrow()
    expect(() => makeFixedApi({ hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.org`) })).toThrow()
    expect(() => makeFixedApi({ hosts: ["api.spotify.com"] })).not.toThrow()
  })

  it("allows exactly the listed hosts, without case, and refuses suffixes, IP literals and other hosts", async () => {
    const connector = fakeConnector(() => reply(200, "{}", json))
    for (const url of ["https://api.spotify.com/v1/me", "https://API.Spotify.COM/v1/me", "https://accounts.spotify.com/x"]) {
      expect((await Effect.runPromise(api.call(url, { ...base, method: "GET", connector }))).status).toBe(200)
    }
    expect(connector.requests).toHaveLength(3)
    const none = fakeConnector(() => reply(200, "{}", json))
    for (const url of ["https://api.spotify.com.evil.com/x", "https://evil.com/x", "https://x.api.spotify.com/x", "https://35.186.224.25/x", "https://[2001:db8::1]/x", "https://api.spotify.com./x"]) {
      expect(await rule(api.call(url, { ...base, method: "GET", connector: none }))).toBe("host-list")
    }
    expect(none.requests).toHaveLength(0)
  })

  it("refuses http, another port, credentials and an address that resolves to a private one", async () => {
    const connector = fakeConnector(() => reply(200, "{}", json))
    expect(await rule(api.call("http://api.spotify.com/x", { ...base, method: "GET", connector }))).toBe("scheme")
    expect(await rule(api.call("https://api.spotify.com:8443/x", { ...base, method: "GET", connector }))).toBe("port")
    expect(await rule(api.call("https://api.spotify.com:80/x", { ...base, method: "GET", connector }))).toBe("port")
    expect(await rule(api.call("https://user:pw@api.spotify.com/x", { ...base, method: "GET", connector }))).toBe("credentials")
    const lan = makeFixedApi({ hosts: ["private.spotify.com"] })
    expect(await rule(lan.call("https://private.spotify.com/x", { ...base, method: "GET", connector }))).toBe("address")
    expect(connector.requests).toHaveLength(0)
  })
})

describe("makeFixedApi bodies and methods", () => {
  it("sends a JSON body with its type and length, and passes Authorization through", async () => {
    const connector = fakeConnector(() => reply(200, "{\"ok\":true}", json))
    const answer = await Effect.runPromise(api.call("https://api.spotify.com/v1/me/player/play", { ...base, method: "PUT", json: { uris: ["spotify:track:1"] }, headers: { Authorization: "Bearer tok" }, connector }))
    expect(JSON.parse(answer.text())).toEqual({ ok: true })
    const sent = connector.requests[0]!
    expect(sent.method).toBe("PUT")
    expect(new TextDecoder().decode(sent.body)).toBe("{\"uris\":[\"spotify:track:1\"]}")
    expect(sent.headers["content-type"]).toBe("application/json")
    expect(sent.headers["content-length"]).toBe(String(sent.body!.byteLength))
    expect(sent.headers["authorization"]).toBe("Bearer tok")
  })

  it("encodes a form body, special characters included", async () => {
    const connector = fakeConnector(() => reply(200, "{}", json))
    await Effect.runPromise(api.call("https://accounts.spotify.com/api/token", { ...base, method: "POST", form: { grant_type: "refresh_token", refresh_token: "a b&c=d+e/ü%" }, connector }))
    const sent = connector.requests[0]!
    const text = new TextDecoder().decode(sent.body)
    expect(text).toBe("grant_type=refresh_token&refresh_token=a+b%26c%3Dd%2Be%2F%C3%BC%25")
    expect(Object.fromEntries(new URLSearchParams(text))).toEqual({ grant_type: "refresh_token", refresh_token: "a b&c=d+e/ü%" })
    expect(sent.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    expect(sent.headers["content-length"]).toBe(String(sent.body!.byteLength))
  })

  it("sends a PUT, POST or DELETE with no body with Content-Length 0 and no Content-Type, and reads a 204", async () => {
    for (const method of ["PUT", "POST", "DELETE"] as const) {
      const connector = fakeConnector(() => reply(204, "", {}))
      const answer = await Effect.runPromise(api.call("https://api.spotify.com/v1/me/player/pause", { ...base, method, connector }))
      expect(answer.status).toBe(204)
      expect(answer.body.byteLength).toBe(0)
      const sent = connector.requests[0]!
      expect(sent.method).toBe(method)
      expect(sent.headers["content-length"]).toBe("0")
      expect("content-type" in sent.headers).toBe(false)
      expect(sent.body?.byteLength ?? 0).toBe(0)
    }
  })

  it("returns a non-2xx answer to the caller", async () => {
    const connector = fakeConnector(() => reply(401, "{\"error\":\"expired\"}", json))
    const answer = await Effect.runPromise(api.call("https://api.spotify.com/v1/me", { ...base, method: "GET", connector }))
    expect(answer.status).toBe(401)
    expect(JSON.parse(answer.text())).toEqual({ error: "expired" })
  })

  it("refuses both bodies, a body on GET, a caller's Content-Type, another method and an oversize body, before connecting", async () => {
    const connector = fakeConnector(() => reply(200, "{}", json))
    const url = "https://api.spotify.com/x"
    expect(await rule(api.call(url, { ...base, method: "POST", json: {}, form: {}, connector }))).toBe("body")
    expect(await rule(api.call(url, { ...base, method: "GET", json: {}, connector }))).toBe("body")
    expect(await rule(api.call(url, { ...base, method: "GET", form: { a: "b" }, connector }))).toBe("body")
    expect(await rule(api.call(url, { ...base, method: "PUT", json: {}, headers: { "Content-Type": "text/plain" }, connector }))).toBe("header")
    expect(await rule(api.call(url, { ...base, method: "PUT", json: {}, headers: { "Content-Length": "1" }, connector }))).toBe("header")
    expect(await rule(api.call(url, { ...base, method: "PATCH" as "PUT", connector }))).toBe("options")
    expect(await rule(api.call(url, { ...base, method: "PUT", form: { a: 1 } as unknown as Record<string, string>, connector }))).toBe("body")
    expect(await rule(api.call(url, { ...base, method: "POST", json: "x".repeat(70 * 1024), connector }))).toBe("body")
    expect(await rule(api.call(url, { ...base, method: "POST", form: { a: "x".repeat(2000) }, maxRequestBytes: 1000, connector }))).toBe("body")
    expect(await rule(api.call(url, { ...base, method: "POST", json: {}, maxRequestBytes: 1024 * 1024, connector }))).toBe("options")
    expect(connector.requests).toHaveLength(0)
    expect(resolver.calls.length).toBeGreaterThan(0)
  })

  it("refuses a header with a line break", async () => {
    const connector = fakeConnector(() => reply(200, "{}", json))
    expect(await rule(api.call("https://api.spotify.com/x", { ...base, method: "GET", headers: { authorization: "Bearer a\r\nX-Evil: 1" }, connector }))).toBe("header")
    expect(connector.requests).toHaveLength(0)
  })
})

describe("makeFixedApi redirects and failures", () => {
  it("sends a PUT, POST or DELETE once: every 3xx answer is refused, nothing is followed", async () => {
    for (const method of ["PUT", "POST", "DELETE"] as const) {
      for (const status of [301, 302, 303, 304, 307, 308]) {
        const connector = fakeConnector(() => reply(status, "", { location: "https://api.spotify.com/y" }))
        expect(await rule(api.call("https://api.spotify.com/x", { ...base, method, connector }))).toBe("post-redirect")
        expect(connector.requests).toHaveLength(1)
      }
    }
  })

  it("follows a GET redirect inside the list, drops Authorization when the origin changes, and refuses one that leaves the list", async () => {
    let n = 0
    const inside = fakeConnector(() => (n++ === 0 ? reply(302, "", { location: "https://accounts.spotify.com/y" }) : reply(200, "{}", json)))
    const answer = await Effect.runPromise(api.call("https://api.spotify.com/x", { ...base, method: "GET", headers: { authorization: "Bearer t" }, connector: inside }))
    expect(answer.status).toBe(200)
    expect(inside.requests[0]!.headers["authorization"]).toBe("Bearer t")
    expect(inside.requests[1]!.headers["authorization"]).toBeUndefined()

    for (const target of ["https://evil.com/y", "https://api.spotify.com.evil.com/y", "http://api.spotify.com/y", "https://api.spotify.com:8443/y"]) {
      const out = fakeConnector(() => reply(302, "", { location: target }))
      const refused = (await errorOf(api.call("https://api.spotify.com/x", { ...base, method: "GET", connector: out }))) as NetRefused
      expect(refused).toBeInstanceOf(NetRefused)
      expect(out.requests).toHaveLength(1)
    }
    const out = fakeConnector(() => reply(302, "", { location: "https://evil.com/y" }))
    expect(await rule(api.call("https://api.spotify.com/x", { ...base, method: "GET", connector: out }))).toBe("host-list")
  })

  it("does not retry a PUT that failed after it was written, and says it was sent", async () => {
    const two = fakeResolver({ "api.spotify.com": ["35.186.224.25", "35.186.224.27"] })
    const connector = fakeConnector(() => Promise.reject(new Error("socket hang up")))
    const failure = (await errorOf(api.call("https://api.spotify.com/x", { accept: contentTypes.json, method: "PUT", resolver: two, connector }))) as NetFailure
    expect(failure).toBeInstanceOf(NetFailure)
    expect(failure.requestSent).toBe(true)
    expect(connector.requests).toHaveLength(1)
  })

  it("goes to the next address when nothing was written", async () => {
    const two = fakeResolver({ "api.spotify.com": ["35.186.224.25", "35.186.224.27"] })
    let n = 0
    const connector = fakeConnector(() => (n++ === 0 ? Promise.reject(Object.assign(new Error("refused"), { notSent: true })) : reply(204, "", {})))
    const answer = await Effect.runPromise(api.call("https://api.spotify.com/x", { accept: contentTypes.json, method: "PUT", resolver: two, connector }))
    expect(answer.status).toBe(204)
    expect(connector.requests.map((r) => r.address)).toEqual(["35.186.224.25", "35.186.224.27"])
  })
})
