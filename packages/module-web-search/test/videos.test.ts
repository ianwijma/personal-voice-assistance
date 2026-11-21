// The `WebVideos` service (`@pva/module-contracts`, docs/modules/media.md §4.7): one video search per call, read as the
// contract says. No network: the kit's offline net answers the SearXNG host.
import { assert, describe, it } from "@effect/vitest"
import { makeOfflineNet, type OfflineResponse, startTestModule } from "@pva/core/testing"
import { WebVideos, type WebVideosError, youtubeVideoId } from "@pva/module-contracts"
import type { Connector } from "@pva/net"
import { Effect } from "effect"
import { toVideos, videoLengthSeconds, webSearchModule } from "../src/index.ts"

const SEARX = "http://searx.lan:8080"
const LAN = { lan: { "searx.lan": "192.168.1.5" } }
const ID = "dQw4w9WgXcQ"

/** A YouTube result as SearXNG's `videos` category gives it. */
const clip = (i: number, over: Record<string, unknown> = {}) => ({
  template: "videos.html",
  engine: "youtube",
  title: `Sharpen a knife ${i} <b>fast</b>`,
  url: `https://www.youtube.com/watch?v=${String(i).padStart(11, "k")}`,
  content: "How to",
  thumbnail: `https://i.ytimg.com/vi/${i}/hqdefault.jpg`,
  iframe_src: `https://www.youtube-nocookie.com/embed/${String(i).padStart(11, "k")}`,
  length: "12:34",
  author: "Chef Channel",
  publishedDate: "2024-03-05T10:20:30",
  ...over
})

const start = (answer: OfflineResponse, settings: Record<string, unknown> = { searxngUrl: SEARX }) =>
  Effect.gen(function*() {
    const net = makeOfflineNet({ [`${SEARX}/search`]: answer }, LAN)
    const kit = yield* startTestModule(webSearchModule({ resolver: net.resolver, connector: net.connector as unknown as Connector }), { settings })
    return { kit, net }
  })

describe("youtubeVideoId", () => {
  it("reads the id from every YouTube form", () => {
    const valid = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=30s&list=PL1`,
      `http://www.youtube.com/watch?feature=share&v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?t=5`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`
    ]
    for (const url of valid) assert.strictEqual(youtubeVideoId(url), ID, url)
    assert.strictEqual(youtubeVideoId("https://www.youtube.com/watch?v=a-_B1c2D3e4"), "a-_B1c2D3e4")
  })

  it("is undefined for look-alikes, other schemes, bad ids and other paths", () => {
    const bad = [
      `https://youtube.com.evil.com/watch?v=${ID}`,
      `https://notyoutube.com/watch?v=${ID}`,
      `https://evil.com/watch?v=${ID}&u=youtube.com`,
      `https://evil.com/https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com@evil.com/watch?v=${ID}`,
      `https://user:pw@www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com:8443/watch?v=${ID}`,
      `https://youtu.be.evil.com/${ID}`,
      `https://evil.youtu.be/${ID}`,
      `https://www.youtube-nocookie.com/watch?v=${ID}`,
      `https://www.youtube.com/embed/${ID}/extra`,
      `https://youtu.be/${ID}/extra`,
      `https://www.youtube.com/watch?v=${ID}x`,
      `https://www.youtube.com/watch?v=short`,
      "https://www.youtube.com/watch?v=",
      "https://www.youtube.com/watch",
      "https://www.youtube.com/playlist?list=PLabcdefghijk",
      `https://www.youtube.com/watch/${ID}`,
      `https://www.youtube.com/channel/${ID}`,
      `javascript:alert(1)//youtube.com/watch?v=${ID}`,
      `ftp://www.youtube.com/watch?v=${ID}`,
      `file:///watch?v=${ID}`,
      `//www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID.slice(0, 10)}%`,
      "",
      "not a url"
    ]
    for (const url of bad) assert.isUndefined(youtubeVideoId(url), url)
    assert.isUndefined(youtubeVideoId(undefined as unknown as string))
  })
})

describe("videoLengthSeconds", () => {
  it("reads the forms SearXNG gives and nothing else", () => {
    assert.strictEqual(videoLengthSeconds("12:34"), 754)
    assert.strictEqual(videoLengthSeconds("1:02:03"), 3_723)
    assert.strictEqual(videoLengthSeconds("0:45"), 45)
    assert.strictEqual(videoLengthSeconds(" 754 "), 754)
    assert.strictEqual(videoLengthSeconds(754), 754)
    assert.strictEqual(videoLengthSeconds(754.4), 754)
    for (const bad of [undefined, null, "", "live", "12:xx", "1:2:3:4", "12:99", -5, 0, Number.NaN, Infinity, 10 ** 9, "99999999", {}, []]) {
      assert.isUndefined(videoLengthSeconds(bad), String(bad))
    }
  })
})

describe("@pva/module-web-search, the WebVideos service (docs/modules/media.md §4.7)", () => {
  it.effect("one SearXNG video search per call with categories=videos, the caller's safe search and language; results read as the contract says", () =>
    Effect.gen(function*() {
      const { kit, net } = yield* start({
        body: {
          results: [
            clip(1),
            clip(2, { length: 3_723, thumbnail: "//i.ytimg.com/vi/2/hq.jpg", author: undefined, publishedDate: null }),
            clip(3, { length: undefined, thumbnail: "data:image/jpeg;base64,AAAA", publishedDate: "garbage" }),
            { title: "A vimeo clip", url: "https://vimeo.com/123456", engine: "vimeo", length: "3:00" }
          ]
        }
      })
      const service = kit.service(WebVideos)
      assert.isDefined(service)
      const found = yield* service!.search({ query: "sharpen knife", safeSearch: 2, language: "nl-NL", timeoutMs: 2_000 })
      assert.deepStrictEqual(found[0], {
        title: "Sharpen a knife 1 <b>fast</b>",
        url: "https://www.youtube.com/watch?v=kkkkkkkkkk1",
        site: "youtube.com",
        youtubeId: "kkkkkkkkkk1",
        lengthSeconds: 754,
        thumbnailUrl: "https://i.ytimg.com/vi/1/hqdefault.jpg",
        author: "Chef Channel",
        publishedDate: new Date("2024-03-05T10:20:30").toISOString()
      })
      assert.strictEqual(found[1]?.lengthSeconds, 3_723)
      assert.strictEqual(found[1]?.thumbnailUrl, "https://i.ytimg.com/vi/2/hq.jpg")
      assert.isUndefined(found[1]?.author)
      assert.isUndefined(found[1]?.publishedDate)
      assert.isUndefined(found[2]?.lengthSeconds)
      assert.isUndefined(found[2]?.thumbnailUrl)
      assert.isUndefined(found[2]?.publishedDate)
      // Without a site filter a result from another site is kept, with no youtube id.
      assert.deepStrictEqual([found[3]?.site, found[3]?.youtubeId, found[3]?.lengthSeconds], ["vimeo.com", undefined, 180])
      assert.strictEqual(net.requests.length, 1)
      const asked = new URL(net.requests[0]!.url)
      assert.strictEqual(`${asked.origin}${asked.pathname}`, `${SEARX}/search`)
      assert.deepStrictEqual(Object.fromEntries(asked.searchParams), { q: "sharpen knife", format: "json", categories: "videos", safesearch: "2", language: "nl-NL" })
    }))

  it.effect("site youtube keeps only results with a valid id; maxResults bounds the answer", () =>
    Effect.gen(function*() {
      const results = [
        { title: "Vimeo", url: "https://vimeo.com/1" },
        clip(1, { url: "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ" }),
        clip(2, { url: "https://www.youtube.com/watch?v=short" }),
        ...Array.from({ length: 15 }, (_, i) => clip(10 + i))
      ]
      const { kit } = yield* start({ body: { results } })
      const service = kit.service(WebVideos)!
      const all = yield* service.search({ query: "knife", safeSearch: 1, site: "youtube", timeoutMs: 2_000 })
      assert.strictEqual(all.length, 10)
      assert.isTrue(all.every((v) => v.youtubeId !== undefined && v.site === "youtube.com"))
      const three = yield* service.search({ query: "knife", safeSearch: 1, site: "youtube", maxResults: 3, timeoutMs: 2_000 })
      assert.strictEqual(three.length, 3)
      const loose = yield* service.search({ query: "knife", safeSearch: 1, timeoutMs: 2_000 })
      assert.strictEqual(loose[0]?.site, "vimeo.com")
      for (const maxResults of [0, 11, 1.5]) {
        const r = yield* service.search({ query: "knife", safeSearch: 1, maxResults, timeoutMs: 2_000 }).pipe(Effect.result)
        assert.strictEqual(r._tag === "Failure" ? (r.failure as WebVideosError).reason : "answered", "failed", String(maxResults))
      }
    }))

  it.effect("offered only while the address is set and valid", () =>
    Effect.gen(function*() {
      const none = yield* start({ body: { results: [] } }, {})
      assert.isUndefined(none.kit.service(WebVideos))
      const bad = yield* start({ body: { results: [] } }, { searxngUrl: "ftp://searx.lan" }).pipe(Effect.result)
      if (bad._tag === "Success") assert.isUndefined(bad.success.kit.service(WebVideos))
      const set = yield* start({ body: { results: [] } })
      assert.isDefined(set.kit.service(WebVideos))
    }))

  it.effect("the owner's blocked sites: a blocked page drops the result, a blocked thumbnail is left out", () =>
    Effect.gen(function*() {
      const { kit } = yield* start(
        {
          body: {
            results: [
              clip(1),
              { title: "Vimeo", url: "https://player.vimeo.com/video/1", thumbnail: "https://i.vimeocdn.com/x.jpg" },
              { title: "Other", url: "https://tube.example.org/v/1", thumbnail: "https://i.vimeocdn.com/y.jpg" }
            ]
          }
        },
        { searxngUrl: SEARX, blockedDomains: ["youtube.com", "vimeo.com", "vimeocdn.com"] }
      )
      const found = yield* kit.service(WebVideos)!.search({ query: "x", safeSearch: 1, timeoutMs: 2_000 })
      assert.deepStrictEqual(found.map((v) => [v.site, v.thumbnailUrl]), [["tube.example.org", undefined]])
    }))

  it("toVideos drops what cannot be used and bounds the rest", () => {
    const out = toVideos([
      clip(1, { url: "" }),
      clip(2, { url: "javascript:alert(1)" }),
      clip(3, { url: `https://x.example/${"a".repeat(2_000)}` }),
      clip(4, { url: "https://x.example/a b" }),
      clip(5, { title: "t".repeat(1_000), author: "a".repeat(500), url: "https://x.example/ok" }),
      clip(6, { title: 42 }),
      ...Array.from({ length: 20 }, (_, i) => clip(10 + i))
    ], [])
    assert.strictEqual(out[0]?.url, "https://x.example/ok")
    assert.strictEqual(out[0]?.title.length, 300)
    assert.strictEqual(out[0]?.author?.length, 100)
    assert.strictEqual(out[1]?.title, "")
    assert.strictEqual(out.length, 10)
  })

  it.effect("its failures carry the contract's reasons: JSON off (403), throttled (429), not a search answer, too large, an error status, a bad query", () =>
    Effect.gen(function*() {
      const reasonOf = (answer: OfflineResponse, query = "knife") =>
        Effect.gen(function*() {
          const { kit } = yield* start(answer)
          const r = yield* kit.service(WebVideos)!.search({ query, safeSearch: 2, timeoutMs: 2_000 }).pipe(Effect.result)
          return r._tag === "Failure" ? (r.failure as WebVideosError).reason : `answered ${JSON.stringify(r.success)}`
        })
      assert.strictEqual(yield* reasonOf({ status: 403, body: { error: "forbidden" } }), "json-off")
      assert.strictEqual(yield* reasonOf({ status: 429, body: { results: [] } }), "rate-limited")
      assert.strictEqual(yield* reasonOf({ status: 500, body: { results: [] } }), "failed")
      assert.strictEqual(yield* reasonOf({ body: { answers: [] } }), "invalid")
      assert.strictEqual(yield* reasonOf({ body: "not json at all" }), "invalid")
      assert.strictEqual(yield* reasonOf({ body: { results: "no" } }), "invalid")
      assert.strictEqual(yield* reasonOf({ body: { results: [], pad: "x".repeat(600 * 1024) } }), "invalid")
      assert.strictEqual(yield* reasonOf({ body: { results: [] } }, "two\nlines"), "failed")
      assert.strictEqual(yield* reasonOf({ body: { results: [] } }, "x".repeat(201)), "failed")
      assert.strictEqual(yield* reasonOf({ body: { results: [] } }, "  "), "failed")
    }))
})
