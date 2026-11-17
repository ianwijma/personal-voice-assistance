import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { makeCachedJson, makeMemoryJsonCache } from "../src/CachedJson.ts"
import { NetBadJson, NetFailure, NetHttpStatus } from "../src/Errors.ts"
import type { SafeFetchOptions, SafeResponse } from "../src/SafeFetch.ts"
import { bytes } from "./helpers.ts"

const response = (status: number, body: string, headers: Record<string, string> = {}, url = "http://x/a"): SafeResponse => ({
  url, status, headers, body: bytes(body), redirects: [], text: () => body, encoding: "identity", contentType: "application/json"
})

const setup = () => {
  const clock = { t: 1_000_000 }
  const seen: Array<{ url: string; headers: Readonly<Record<string, string>> | undefined; options: SafeFetchOptions }> = []
  let next: () => Effect.Effect<SafeResponse, NetFailure> = () => Effect.succeed(response(200, "{}"))
  const api = makeCachedJson({
    now: () => clock.t,
    headers: { "user-agent": "ua" },
    fetch: (url, options) => {
      seen.push({ url, headers: options.headers, options })
      return next()
    }
  })
  return { clock, seen, api, respond: (f: typeof next) => { next = f } }
}
const get = (s: ReturnType<typeof setup>, ttlMs = 1000, staleIfErrorMs?: number) =>
  Effect.runPromise(s.api.getJson("http://x/a", { ttlMs, ...(staleIfErrorMs !== undefined ? { staleIfErrorMs } : {}) }))

describe("getJson", () => {
  it("fetches, then serves from the cache within the TTL", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(200, '{"a":1}')))
    expect(await get(s)).toMatchObject({ value: { a: 1 }, source: "network", ageMs: 0 })
    s.clock.t += 999
    expect(await get(s)).toMatchObject({ value: { a: 1 }, source: "cache", ageMs: 999 })
    expect(s.seen).toHaveLength(1)
    expect(s.seen[0]!.headers).toMatchObject({ accept: "application/json", "user-agent": "ua" })
  })
  it("asks again after the TTL, with If-None-Match, and a 304 renews the entry", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(200, '{"a":1}', { etag: '"v1"' })))
    await get(s)
    s.clock.t += 1000
    s.respond(() => Effect.succeed(response(304, "")))
    expect(await get(s)).toMatchObject({ value: { a: 1 }, source: "revalidated", ageMs: 0 })
    expect(s.seen[1]!.headers?.["if-none-match"]).toBe('"v1"')
    s.clock.t += 500
    expect((await get(s)).source).toBe("cache")
    expect(s.seen).toHaveLength(2)
  })
  it("a changed value replaces the old one and keeps the new ETag", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(200, "1", { etag: "a" })))
    await get(s)
    s.clock.t += 2000
    s.respond(() => Effect.succeed(response(200, "2", { etag: "b" })))
    expect(await get(s)).toMatchObject({ value: 2, source: "network" })
    s.clock.t += 2000
    s.respond(() => Effect.succeed(response(304, "")))
    await get(s)
    expect(s.seen[2]!.headers?.["if-none-match"]).toBe("b")
  })
  it("sends no If-None-Match without an ETag", async () => {
    const s = setup()
    await get(s)
    s.clock.t += 5000
    await get(s)
    expect(s.seen[1]!.headers?.["if-none-match"]).toBeUndefined()
  })
  it("stale-if-error: serves the old value when the refresh fails inside the window", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(200, '"old"')))
    await get(s, 1000, 5000)
    s.clock.t += 3000
    s.respond(() => Effect.fail(new NetFailure({ url: "x", stage: "connect", detail: "down" })))
    const r = await get(s, 1000, 5000)
    expect(r).toMatchObject({ value: "old", source: "stale", ageMs: 3000 })
    expect(r.error).toBeInstanceOf(NetFailure)
    s.respond(() => Effect.succeed(response(503, "")))
    expect((await get(s, 1000, 5000)).source).toBe("stale")
  })
  it("fails when the old value is past the stale window, or there is no window", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(200, "1")))
    await get(s, 1000, 5000)
    s.clock.t += 6000
    s.respond(() => Effect.fail(new NetFailure({ url: "x", stage: "connect", detail: "down" })))
    await expect(get(s, 1000, 5000)).rejects.toBeInstanceOf(NetFailure)
    s.clock.t -= 5000
    await expect(get(s, 1000)).rejects.toBeInstanceOf(NetFailure)
  })
  it("a non-success status and a body that is not JSON are typed errors and are not cached", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(404, "no")))
    await expect(get(s)).rejects.toBeInstanceOf(NetHttpStatus)
    s.respond(() => Effect.succeed(response(200, "<html>")))
    await expect(get(s)).rejects.toBeInstanceOf(NetBadJson)
    s.respond(() => Effect.succeed(response(200, "[1]")))
    expect((await get(s)).source).toBe("network")
  })
  it("keeps URLs apart", async () => {
    const s = setup()
    s.respond(() => Effect.succeed(response(200, '"a"')))
    expect((await Effect.runPromise(s.api.getJson("http://x/a", { ttlMs: 1000 }))).value).toBe("a")
    s.respond(() => Effect.succeed(response(200, '"b"')))
    expect((await Effect.runPromise(s.api.getJson("http://x/b", { ttlMs: 1000 }))).value).toBe("b")
    expect(await Effect.runPromise(s.api.getJson("http://x/a", { ttlMs: 1000 }))).toMatchObject({ value: "a", source: "cache" })
    expect(await Effect.runPromise(s.api.getJson("http://x/b", { ttlMs: 1000 }))).toMatchObject({ value: "b", source: "cache" })
    expect(s.seen.map((x) => x.url)).toEqual(["http://x/a", "http://x/b"])
  })
  it("the memory cache is bounded", async () => {
    const cache = makeMemoryJsonCache(2)
    cache.setIfNewer("a", { value: 1, storedAt: 0, sequence: cache.sequence() })
    cache.setIfNewer("b", { value: 2, storedAt: 0, sequence: cache.sequence() })
    cache.setIfNewer("c", { value: 3, storedAt: 0, sequence: cache.sequence() })
    expect(cache.get("a")).toBeUndefined()
    expect(cache.get("b")?.value).toBe(2)
    cache.delete("b")
    expect(cache.get("b")).toBeUndefined()
  })
})
