// The network in a module and in its test (docs/MODULES.md, "The network"): `@pva/net` with the test kit's network that
// has no network, so no test reaches the internet. The `#region` blocks are quoted in docs/MODULES.md.
import { assert, describe, it } from "@effect/vitest"
import type { HostView } from "@pva/core"
import { makeOfflineNet } from "@pva/core/testing"
import { type Connector, contentTypes, fetchOwnerConfiguredLan, makeCachedJson, type Resolver, safeFetch, userAgent } from "@pva/net"
import { Effect } from "effect"

// #region net-module
/** What a module that fetches takes from its tests: the resolver and connector (absent: the real ones). */
export interface NetDeps {
  readonly resolver?: Resolver
  readonly connector?: Connector
}

/** The User-Agent: the product token, and the owner's contact only when the owner set one (Home › API contact). */
const agentOf = (view: Pick<HostView, "home">) => {
  const contact = view.home.HOME_API_CONTACT
  return userAgent(typeof contact === "string" && contact.trim() !== "" ? contact : undefined)
}

/** A public API: `safeFetch` with the response type it accepts, a size and a time limit. */
export const fetchForecast = (deps: NetDeps, view: Pick<HostView, "home">, place: string) =>
  safeFetch(`https://api.example.org/forecast?place=${encodeURIComponent(place)}`, {
    accept: contentTypes.json,
    maxBytes: 64 * 1024,
    timeoutMs: 3_000,
    headers: { "user-agent": agentOf(view) },
    ...deps
  }).pipe(Effect.map((response) => JSON.parse(response.text()) as { readonly rain: boolean }))

/** An address the owner typed into the module's settings (a LAN SearXNG): the separate, explicit function. */
export const searchOwnServer = (deps: NetDeps, baseUrl: string, query: string) =>
  fetchOwnerConfiguredLan(`${baseUrl}/search?format=json&q=${encodeURIComponent(query)}`, { accept: contentTypes.json, timeoutMs: 3_000, ...deps })
// #endregion net-module

// #region net-post-module
/**
 * The owner's Home Assistant (its address from the module's settings, `http://localhost:8123` included): a POST with a JSON body.
 * Sent once: no redirect is followed and it is never retried, so a failure may or may not have switched the light.
 */
export const callService = (deps: NetDeps, baseUrl: string, token: string, domain: string, service: string, data: Readonly<Record<string, unknown>>) =>
  fetchOwnerConfiguredLan(`${baseUrl}/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, {
    accept: contentTypes.json,
    method: "POST",
    body: { json: data },
    typedLoopback: true,
    timeoutMs: 3_000,
    headers: { authorization: `Bearer ${token}` },
    ...deps
  })
// #endregion net-post-module

describe("the network in a module's test", () => {
  // #region net-test
  it.effect("serves fixtures, fails every other host, and keeps the owner's LAN for the LAN function", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(
        { "https://api.example.org/forecast": { body: { rain: true } }, "http://searx.lan/search": { body: { results: [] } } },
        { lan: { "searx.lan": "192.168.1.5" } }
      )
      const deps = { resolver: net.resolver, connector: net.connector }
      assert.deepStrictEqual(yield* fetchForecast(deps, { home: {} }, "Utrecht"), { rain: true })
      assert.strictEqual(net.requests[0]?.headers["user-agent"], "personal-voice-assistance/1")
      // Any other host is a lookup failure, as when the internet is not there.
      const elsewhere = yield* Effect.flip(safeFetch("https://elsewhere.example.com/", { accept: contentTypes.json, ...deps }))
      assert.strictEqual(elsewhere._tag, "NetFailure")
      // A LAN address: refused to safeFetch (a model's URL), allowed for the owner's own server.
      const refused = yield* Effect.flip(safeFetch("http://searx.lan/search", { accept: contentTypes.json, ...deps }))
      assert.strictEqual(refused._tag, "NetRefused")
      const own = yield* searchOwnServer(deps, "http://searx.lan", "bins")
      assert.strictEqual(own.status, 200)
    }))
  // #endregion net-test

  it.effect("an unlisted literal address is refused like an unlisted name, directly and after a redirect; only a listed host's unlisted path is a 404", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({
        "https://api.example.org/forecast": { body: { rain: true } },
        "https://api.example.org/moved": { status: 302, headers: { location: "https://8.8.8.8/forecast" } }
      })
      const deps = { resolver: net.resolver, connector: net.connector }
      for (const url of ["https://8.8.8.8/", "https://[2606:4700::1111]/", "https://api.example.org/moved"]) {
        const failed = yield* Effect.flip(safeFetch(url, { accept: contentTypes.json, ...deps }))
        assert.strictEqual(failed._tag, "NetFailure", url)
      }
      const missing = yield* safeFetch("https://api.example.org/nothing-here", { accept: contentTypes.webPage, ...deps })
      assert.strictEqual(missing.status, 404)
    }))

  // #region net-post-test
  it.effect("a POST to the owner's server: the test reads the method and the body that was sent", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet(
        {
          "http://ha.lan:8123/api/services/light/turn_on": (request) =>
            request.method === "POST" ? { body: [{ entity_id: "light.kitchen" }] } : { status: 405, body: "POST only" }
        },
        { lan: { "ha.lan": "192.168.1.20" } }
      )
      const deps = { resolver: net.resolver, connector: net.connector }
      const answer = yield* callService(deps, "http://ha.lan:8123", "t0ken", "light", "turn_on", { entity_id: "light.kitchen", brightness_pct: 40 })
      assert.deepStrictEqual(JSON.parse(answer.text()), [{ entity_id: "light.kitchen" }])
      const [sent] = net.requests
      assert.strictEqual(sent?.method, "POST")
      assert.deepStrictEqual(JSON.parse(sent?.body ?? ""), { entity_id: "light.kitchen", brightness_pct: 40 })
      assert.strictEqual(sent?.headers["content-type"], "application/json")
      assert.strictEqual(sent?.headers["authorization"], "Bearer t0ken")
      // A GET to the same fixture: no body recorded, the fixture sees the method.
      const get = yield* fetchOwnerConfiguredLan("http://ha.lan:8123/api/services/light/turn_on", { accept: contentTypes.json, ...deps })
      assert.strictEqual(get.status, 405)
      assert.deepStrictEqual([net.requests[1]?.method, net.requests[1]?.body], ["GET", undefined])
    }))
  // #endregion net-post-test

  it.effect("a POST to a host the test network does not have is a refused connect, and nothing is answered", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({}, { lan: { "ha.lan": "192.168.1.20" } })
      const failed = yield* Effect.flip(fetchOwnerConfiguredLan("http://192.168.1.99:8123/api/template", {
        accept: contentTypes.json, method: "POST", body: { json: { template: "x" } }, resolver: net.resolver, connector: net.connector
      }))
      assert.strictEqual(failed._tag, "NetFailure")
      assert.deepStrictEqual(net.requests.map((r) => [r.method, r.body]), [["POST", '{"template":"x"}']])
    }))

  it.effect("the contact goes into the User-Agent only when the owner set one", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ "https://api.example.org/forecast": { body: { rain: false } } })
      yield* fetchForecast(net, { home: { HOME_API_CONTACT: "owner@example.org" } }, "Utrecht")
      assert.strictEqual(net.requests[0]?.headers["user-agent"], "personal-voice-assistance/1 (owner@example.org)")
    }))

  it.effect("the cached JSON helper asks once within its time to live", () =>
    Effect.gen(function*() {
      const net = makeOfflineNet({ "https://api.example.org/forecast": { body: { rain: true }, headers: { etag: '"v1"' } } })
      let now = 0
      const cached = makeCachedJson({ now: () => now, fetch: (url, options) => safeFetch(url, { ...options, resolver: net.resolver, connector: net.connector }) })
      const first = yield* cached.getJson("https://api.example.org/forecast", { ttlMs: 60_000 })
      now += 1_000
      const second = yield* cached.getJson("https://api.example.org/forecast", { ttlMs: 60_000 })
      assert.deepStrictEqual([first.source, second.source, net.requests.length], ["network", "cache", 1])
    }))
})
