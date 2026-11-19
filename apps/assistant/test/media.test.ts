// P10: the image cache behind /media/<hash> (docs/PRESENTING.md "Images"): fetched once through safeFetch with its own
// image policy, checked by the type it says and the bytes it is, kept for a day within its bounds in a directory of its
// own, served only while a page holds it, with headers that make a browser treat it as an image and nothing else. Each
// refusal; the same image asked twice fetched once; expiry; the cache read back after a restart. No network: a fake
// resolver and connector stand behind the real safeFetch.
import type { ConnectRequest, ConnectResponse } from "@pva/net"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { chmodSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import type http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_IMAGE_BYTES, MAX_MEDIA_FETCHES, MEDIA_KEEP_MS, makeMediaCache } from "../src/serve/media.ts"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3])
const SVG = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")

const reply = (status: number, body: Uint8Array, headers: Record<string, string>): ConnectResponse => ({
  status,
  headers: { ...headers, "content-length": String(body.length) },
  body: (async function*() {
    yield body
  })()
})

interface World {
  readonly requests: Array<string>
  /** Answers per path; a function may wait. */
  readonly routes: Map<string, () => ConnectResponse | Promise<ConnectResponse>>
  readonly clock: { now: number }
}

const world = (): World => ({ requests: [], routes: new Map(), clock: { now: Date.UTC(2026, 10, 19, 12) } })

const open = (w: World, dir = mkdtempSync(join(tmpdir(), "pva-media-")), limits?: { files?: number; bytes?: number }) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const cache = yield* makeMediaCache({
      dir,
      now: () => w.clock.now,
      ...(limits !== undefined ? { limits } : {}),
      fetchOptions: {
        // Every public name resolves to a public address; `private.example` to a private one.
        resolver: async (host) => (host === "private.example" ? ["192.168.1.20"] : ["93.184.216.34"]),
        connector: async (r: ConnectRequest) => {
          w.requests.push(`${r.url.hostname}${r.url.pathname}`)
          const route = w.routes.get(`${r.url.hostname}${r.url.pathname}`)
          return route === undefined ? reply(404, new Uint8Array(), { "content-type": "text/plain" }) : route()
        }
      }
    }).pipe(Scope.provide(scope))
    return { cache, dir, close: Scope.close(scope, Exit.void) }
  })

/** A request and a response that record what the route answers. */
/** A page's address token, and a resolver that answers `hash` for it alone (the Presenter's `mediaFor`). */
const TOKEN = "T".repeat(32)
const only = (hash: string) => (token: string) => (token === TOKEN ? hash : undefined)
const serveOnce = (cache: Effect.Success<ReturnType<typeof open>>["cache"], path: string, resolve: (token: string) => string | undefined, method = "GET") => {
  const out: { status?: number; headers?: Record<string, string>; body?: Buffer | undefined } = {}
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status
      out.headers = headers
      return res
    },
    end(body?: Buffer | string) {
      out.body = typeof body === "string" ? Buffer.from(body) : body
      return res
    }
  }
  cache.serve({ method, url: path } as http.IncomingMessage, res as unknown as http.ServerResponse, resolve)
  return out
}

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe("the image cache (/media)", () => {
  it("fetches an image once, keeps it under its content hash and serves it as an image and nothing else, only while a page holds it", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    w.routes.set("other.example/same.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const { cache, dir, close } = await run(open(w))
    const first = await run(cache.fetch("https://img.example/heron.png"))
    expect("hash" in first).toBe(true)
    const hash = (first as { hash: string }).hash
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // The same address asked again: not fetched again. The same bytes from another address: kept once.
    expect(await run(cache.fetch("https://img.example/heron.png"))).toEqual({ hash })
    expect(await run(cache.fetch("https://other.example/same.png"))).toEqual({ hash })
    expect(w.requests).toEqual(["img.example/heron.png", "other.example/same.png"])
    expect(cache.stats()).toMatchObject({ files: 1, bytes: PNG.length })
    // Its own private directory, a private file named by the hash.
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir)).toEqual([`${hash}.png`])
    expect(statSync(join(dir, `${hash}.png`)).mode & 0o777).toBe(0o600)
    // Served to the page whose own address names it, with the headers of an inert image kept out of every cache.
    const ok = serveOnce(cache, `/media/${TOKEN}`, only(hash))
    expect(ok.status).toBe(200)
    expect(ok.headers).toEqual({
      "Content-Type": "image/png",
      "Content-Length": String(PNG.length),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline; filename=\"image.png\"",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store"
    })
    expect([...ok.body!]).toEqual([...PNG])
    expect(serveOnce(cache, `/media/${TOKEN}`, only(hash), "HEAD").body).toBeUndefined()
    // The content hash is not an address; a token no page holds, one that names nothing kept, anything else: 404.
    expect(serveOnce(cache, `/media/${hash}`, () => hash).status).toBe(404)
    expect(serveOnce(cache, `/media/${TOKEN}`, () => undefined).status).toBe(404)
    expect(serveOnce(cache, `/media/${TOKEN}`, () => "b".repeat(64)).status).toBe(404)
    expect(serveOnce(cache, "/media/../settings.json", () => hash).status).toBe(404)
    expect(serveOnce(cache, `/media/${TOKEN}`, only(hash), "POST").status).toBe(405)
    await run(close)
  })

  it("refuses by type (what it says, SVG, bytes that are not what it says), by size, and an address the server may not fetch (a redirect to a private one)", async () => {
    const w = world()
    w.routes.set("img.example/page", () => reply(200, new TextEncoder().encode("<html></html>"), { "content-type": "text/html" }))
    w.routes.set("img.example/vector.svg", () => reply(200, SVG, { "content-type": "image/svg+xml" }))
    w.routes.set("img.example/liar.png", () => reply(200, JPEG, { "content-type": "image/png" }))
    w.routes.set("img.example/huge.png", () => reply(200, new Uint8Array(MAX_IMAGE_BYTES + 1).fill(1), { "content-type": "image/png" }))
    w.routes.set("img.example/away", () => ({ status: 302, headers: { location: "https://private.example/secret.png" }, body: (async function*() {})() }))
    const { cache, close } = await run(open(w))
    expect(await run(cache.fetch("https://img.example/page"))).toEqual({ refused: "type" })
    expect(await run(cache.fetch("https://img.example/vector.svg"))).toEqual({ refused: "type" })
    expect(await run(cache.fetch("https://img.example/liar.png"))).toEqual({ refused: "type" })
    expect(await run(cache.fetch("https://img.example/huge.png"))).toEqual({ refused: "size" })
    expect(await run(cache.fetch("https://img.example/away"))).toEqual({ refused: "blocked" })
    expect(w.requests).not.toContain("private.example/secret.png")
    expect(await run(cache.fetch("http://127.0.0.1/x.png"))).toEqual({ refused: "blocked" })
    expect(await run(cache.fetch("https://img.example/missing.png"))).toEqual({ refused: "fetch" })
    expect(cache.stats().files).toBe(0)
    await run(close)
  })

  it("refuses more fetches at once than its bound (busy); one address under way is fetched once for every asker", async () => {
    const w = world()
    const gate = Effect.runSync(Deferred.make<void>())
    for (let i = 0; i < MAX_MEDIA_FETCHES + 1; i++) {
      w.routes.set(`img.example/${i}.png`, async () => {
        await Effect.runPromise(Deferred.await(gate))
        return reply(200, Uint8Array.from([...PNG, i]), { "content-type": "image/png" })
      })
    }
    const { cache, close } = await run(open(w))
    const running = Array.from({ length: MAX_MEDIA_FETCHES }, (_, i) => Effect.runFork(cache.fetch(`https://img.example/${i}.png`)))
    const again = Effect.runFork(cache.fetch("https://img.example/0.png"))
    await new Promise((r) => setTimeout(r, 50))
    expect(cache.stats().inFlight).toBe(MAX_MEDIA_FETCHES)
    expect(await run(cache.fetch(`https://img.example/${MAX_MEDIA_FETCHES}.png`))).toEqual({ refused: "busy" })
    await run(Deferred.succeed(gate, undefined))
    const outcomes = await Promise.all(running.map((f) => run(Fiber.join(f))))
    expect(await run(Fiber.join(again))).toEqual(outcomes[0])
    expect(w.requests.filter((r) => r === "img.example/0.png")).toHaveLength(1)
    await run(close)
  })

  it("refuses a new image when the cache is full; what has expired goes first", async () => {
    const w = world()
    for (let i = 0; i < 3; i++) w.routes.set(`img.example/${i}.png`, () => reply(200, Uint8Array.from([...PNG, i]), { "content-type": "image/png" }))
    const { cache, close } = await run(open(w, undefined, { files: 2 }))
    expect("hash" in (await run(cache.fetch("https://img.example/0.png")))).toBe(true)
    w.clock.now += MEDIA_KEEP_MS / 2
    expect("hash" in (await run(cache.fetch("https://img.example/1.png")))).toBe(true)
    expect(await run(cache.fetch("https://img.example/2.png"))).toEqual({ refused: "full" })
    // A day after the first: it has expired and makes room.
    w.clock.now += MEDIA_KEEP_MS / 2
    expect("hash" in (await run(cache.fetch("https://img.example/2.png")))).toBe(true)
    expect(cache.stats().files).toBe(2)
    await run(close)
  })

  it("keeps an image for a day: then it is not served and its file is removed; the cache is read back after a restart", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const first = await run(open(w))
    const { hash } = (await run(first.cache.fetch("https://img.example/heron.png"))) as { hash: string }
    await run(first.close)
    // A restart: the directory is read back; served without fetching again.
    const second = await run(open(w, first.dir))
    expect(second.cache.stats().files).toBe(1)
    expect(serveOnce(second.cache, `/media/${TOKEN}`, only(hash)).status).toBe(200)
    // A day later: not served, and gone from the directory.
    w.clock.now += MEDIA_KEEP_MS
    expect(serveOnce(second.cache, `/media/${TOKEN}`, only(hash)).status).toBe(404)
    second.cache.sweep()
    expect(readdirSync(first.dir)).toEqual([])
    await run(second.close)
  })

  it("b16: at start, real debris (an interrupted write, a foreign file, an expired image) is removed and a valid unexpired image kept", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const first = await run(open(w))
    const { hash } = (await run(first.cache.fetch("https://img.example/heron.png"))) as { hash: string }
    await run(first.close)
    writeFileSync(join(first.dir, ".tmp-0123456789abcdef"), "half a file")
    writeFileSync(join(first.dir, "notes.txt"), "not the cache's")
    const old = `${"9".repeat(64)}.png`
    writeFileSync(join(first.dir, old), PNG)
    utimesSync(join(first.dir, old), (w.clock.now - MEDIA_KEEP_MS - 1) / 1000, (w.clock.now - MEDIA_KEEP_MS - 1) / 1000)
    const again = await run(open(w, first.dir))
    expect(readdirSync(first.dir).sort()).toEqual([`${hash}.png`])
    expect(again.cache.stats()).toMatchObject({ files: 1, stale: 0 })
    expect(serveOnce(again.cache, `/media/${TOKEN}`, only(hash)).status).toBe(200)
    await run(again.close)
  })

  it("b4: a file whose removal fails stays counted against the bounds and is removed later; the disk never holds more than the bound", async () => {
    const w = world()
    for (let i = 0; i < 2; i++) w.routes.set(`img.example/${i}.png`, () => reply(200, Uint8Array.from([...PNG, i]), { "content-type": "image/png" }))
    const { cache, dir, close } = await run(open(w, undefined, { files: 1 }))
    expect("hash" in (await run(cache.fetch("https://img.example/0.png")))).toBe(true)
    w.clock.now += MEDIA_KEEP_MS + 1
    chmodSync(dir, 0o500)
    try {
      cache.sweep()
      expect(cache.stats()).toMatchObject({ files: 0, stale: 1 })
      // Its place is not free yet: refused full, and the disk holds one file.
      expect(await run(cache.fetch("https://img.example/1.png"))).toEqual({ refused: "full" })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(readdirSync(dir)).toHaveLength(1)
    // The removal is tried again before the next write: then there is room.
    expect("hash" in (await run(cache.fetch("https://img.example/1.png")))).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(cache.stats()).toMatchObject({ files: 1, stale: 0 })
    await run(close)
  })

  it("b5: the same bytes fetched again after their day are a new admission, served again", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    w.routes.set("img.example/other.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const { cache, close } = await run(open(w))
    const { hash } = (await run(cache.fetch("https://img.example/heron.png"))) as { hash: string }
    w.clock.now += MEDIA_KEEP_MS + 1
    // No sweep between: the expired copy is dealt with before the new bytes are matched against it.
    expect(await run(cache.fetch("https://img.example/other.png"))).toEqual({ hash })
    expect(serveOnce(cache, `/media/${TOKEN}`, only(hash)).status).toBe(200)
    expect(await run(cache.fetch("https://img.example/heron.png"))).toEqual({ hash })
    expect(w.requests.filter((r) => r === "img.example/heron.png")).toHaveLength(2)
    await run(close)
  })
})
