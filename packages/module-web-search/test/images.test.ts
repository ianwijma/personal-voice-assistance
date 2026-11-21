// Issue #150: the `WebImages` service (`@pva/module-contracts`), offered from the shared part while the SearXNG address is
// set: one image search per call, read as the contract says. No network: the kit's offline net answers the SearXNG host.
import { assert, describe, it } from "@effect/vitest"
import { makeOfflineNet, type OfflineResponse, startTestModule } from "@pva/core/testing"
import { WebImages, type WebImagesError } from "@pva/module-contracts"
import type { Connector } from "@pva/net"
import { Effect } from "effect"
import { imageAddressOf, toImages, webSearchModule } from "../src/index.ts"

const SEARX = "http://searx.lan:8080"
const LAN = { lan: { "searx.lan": "192.168.1.5" } }

/** The members of SearXNG's `images` results the provider reads, as its JSON output gives them. */
const heron = (i: number, over: Record<string, unknown> = {}) => ({
  template: "images.html",
  engine: "bing images",
  title: `Grey heron ${i} <b>photo</b>`,
  url: `https://www.site${i}.example.org/herons/${i}`,
  img_src: `https://cdn.site${i}.example.org/heron-${i}.jpg`,
  thumbnail_src: `https://tse${i}.mm.bing.net/th?id=OIP.${i}&pid=Api`,
  img_format: "JPEG",
  resolution: "1600 x 1067",
  ...over
})

const start = (answer: OfflineResponse, settings: Record<string, unknown> = { searxngUrl: SEARX }) =>
  Effect.gen(function*() {
    const net = makeOfflineNet({ [`${SEARX}/search`]: answer }, LAN)
    const kit = yield* startTestModule(webSearchModule({ resolver: net.resolver, connector: net.connector as unknown as Connector }), { settings })
    return { kit, net }
  })

describe("@pva/module-web-search, the WebImages service (issue #150)", () => {
  it.effect("one SearXNG image search per call, with the caller's safe search and language; results read as the contract says", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* start({ body: { results: [heron(1), heron(2, { thumbnail_src: "//tse2.mm.bing.net/th?id=x" }), heron(3, { thumbnail_src: "data:image/jpeg;base64,AAAA" })] } })
      const service = kit.service(WebImages)
      assert.isDefined(service)
      const found = yield* service!.search({ query: "grey heron", safeSearch: 2, language: "nl-NL", timeoutMs: 2_000 })
      assert.deepStrictEqual(found[0], {
        imageUrl: "https://cdn.site1.example.org/heron-1.jpg",
        thumbnailUrl: "https://tse1.mm.bing.net/th?id=OIP.1&pid=Api",
        pageUrl: "https://www.site1.example.org/herons/1",
        site: "site1.example.org",
        title: "Grey heron 1 <b>photo</b>",
        format: "jpeg"
      })
      // A protocol-relative thumbnail is made https; a data: one is left out.
      assert.strictEqual(found[1]?.thumbnailUrl, "https://tse2.mm.bing.net/th?id=x")
      assert.isUndefined(found[2]?.thumbnailUrl)
      assert.strictEqual(net.requests.length, 1)
      const asked = new URL(net.requests[0]!.url)
      assert.strictEqual(`${asked.origin}${asked.pathname}`, `${SEARX}/search`)
      assert.deepStrictEqual(Object.fromEntries(asked.searchParams), { q: "grey heron", format: "json", categories: "images", safesearch: "2", language: "nl-NL" })
    }))

  it.effect("offered only while the address is set and valid", () =>
    Effect.gen(function*() {
      const none = yield* start({ body: { results: [] } }, {})
      assert.isUndefined(none.kit.service(WebImages))
      const bad = yield* start({ body: { results: [] } }, { searxngUrl: "ftp://searx.lan" }).pipe(Effect.result)
      // A bad address is refused as a setting, or, if kept, offers no service.
      if (bad._tag === "Success") assert.isUndefined(bad.success.kit.service(WebImages))
    }))

  it.effect("the owner's blocked sites: a blocked page or picture drops the result, a blocked thumbnail is left out", () =>
    Effect.gen(function*() {
      const { kit } = yield* start(
        { body: { results: [heron(1), heron(2), heron(3, { thumbnail_src: "https://thumbs.blocked.example/t.jpg" }), heron(4, { img_src: "https://img.blocked.example/a.jpg" })] } },
        { searxngUrl: SEARX, blockedDomains: ["site1.example.org", "blocked.example"] }
      )
      const found = yield* kit.service(WebImages)!.search({ query: "heron", safeSearch: 1, timeoutMs: 2_000 })
      assert.deepStrictEqual(found.map((r) => [r.site, r.thumbnailUrl !== undefined]), [["site2.example.org", true], ["site3.example.org", false]])
    }))

  it("toImages and imageAddressOf drop what cannot be used and bound the rest", () => {
    const out = toImages([
      heron(1, { img_src: "http://plain.example/a.jpg" }),
      heron(2, { img_src: "data:image/png;base64,AAAA" }),
      heron(3, { url: "" }),
      heron(4, { url: "javascript:alert(1)" }),
      heron(5, { img_src: `https://x.example/${"a".repeat(2_000)}.jpg` }),
      heron(6, { img_src: 42 }),
      heron(7, { title: "t".repeat(1_000), img_format: undefined }),
      ...Array.from({ length: 20 }, (_, i) => heron(10 + i))
    ], [])
    assert.strictEqual(out[0]?.site, "site7.example.org")
    assert.strictEqual(out[0]?.title.length, 300)
    assert.isUndefined(out[0]?.format)
    assert.strictEqual(out.length, 10)
    assert.strictEqual(imageAddressOf("https://x.example/a.jpg#frag"), "https://x.example/a.jpg")
    for (const bad of ["https://user:pw@x.example/a.jpg", " ", "https://"]) assert.isUndefined(imageAddressOf(bad), bad)
    // The URL parser percent-encodes a space or a quote: what is given on is printable ASCII.
    assert.strictEqual(imageAddressOf("https://x.example/a \"b.jpg"), "https://x.example/a%20%22b.jpg")
  })

  it.effect("its failures carry the contract's reasons: JSON off (403), throttled (429), not a search answer, an error status, a bad query", () =>
    Effect.gen(function*() {
      const reasonOf = (answer: OfflineResponse, query = "heron") =>
        Effect.gen(function*() {
          const { kit } = yield* start(answer)
          const r = yield* kit.service(WebImages)!.search({ query, safeSearch: 2, timeoutMs: 2_000 }).pipe(Effect.result)
          return r._tag === "Failure" ? (r.failure as WebImagesError).reason : `answered ${JSON.stringify(r.success)}`
        })
      assert.strictEqual(yield* reasonOf({ status: 403, body: { error: "forbidden" } }), "json-off")
      assert.strictEqual(yield* reasonOf({ status: 429, body: { results: [] } }), "rate-limited")
      assert.strictEqual(yield* reasonOf({ status: 500, body: { results: [] } }), "failed")
      assert.strictEqual(yield* reasonOf({ body: { answers: [] } }), "invalid")
      assert.strictEqual(yield* reasonOf({ body: { results: [] } }, "two\nlines"), "failed")
      assert.strictEqual(yield* reasonOf({ body: { results: [] } }, "x".repeat(201)), "failed")
    }))
})
