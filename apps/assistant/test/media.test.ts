// P10: the image cache behind /media/<hash> (docs/PRESENTING.md "Images"): fetched once through safeFetch with its own
// image policy, checked by the type it says and the bytes it is, kept for a day within its bounds in a directory of its
// own, served only while a page holds it, with headers that make a browser treat it as an image and nothing else. Each
// refusal; the same image asked twice fetched once; expiry; the cache read back after a restart. No network: a fake
// resolver and connector stand behind the real safeFetch.
import type { ConnectRequest, ConnectResponse } from "@pva/net"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { opendir, readFile, stat, unlink } from "node:fs/promises"
import type http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeIssueRegistry } from "@pva/core"
import { chmodSync as realChmod, readFileSync as realReadFile, readdirSync as realReaddir, statSync as realStat, unlinkSync as realUnlink, utimesSync as realUtimes } from "node:fs"
import { MAX_IMAGE_BYTES, MAX_MEDIA_FETCHES, MEDIA_KEEP_MS, makeMediaCache, type MediaCacheOptions, type MediaFs } from "../src/serve/media.ts"

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

const open = (w: World, dir = mkdtempSync(join(tmpdir(), "pva-media-")), limits?: { files?: number; bytes?: number }, extra: Pick<MediaCacheOptions, "fs" | "issues"> = {}) =>
  Effect.gen(function*() {
    const scope = yield* Scope.make()
    const cache = yield* makeMediaCache({
      dir,
      now: () => w.clock.now,
      ...(limits !== undefined ? { limits } : {}),
      ...extra,
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

/** A page's address token, and a resolver that answers `hash` for it alone (the Presenter's `mediaFor`). */
const TOKEN = "T".repeat(32)
const only = (hash: string) => (token: string) => (token === TOKEN ? hash : undefined)
/** A request and a response that record what the asynchronous route answers. */
const serveOnce = async (cache: Effect.Success<ReturnType<typeof open>>["cache"], path: string, resolve: (token: string) => string | undefined, method = "GET") => {
  const out: { status?: number; headers?: Record<string, string>; body?: Buffer | string | undefined } = {}
  await new Promise<void>((done) => {
    const res = {
      writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; return res },
      end(body?: Buffer | string) { out.body = body; done(); return res }
    }
    cache.serve({ method, url: path } as http.IncomingMessage, res as unknown as http.ServerResponse, resolve)
  })
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
    const ok = (await serveOnce(cache, `/media/${TOKEN}`, only(hash)))
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
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash), "HEAD")).body).toBeUndefined()
    // The content hash is not an address; a token no page holds, one that names nothing kept, anything else: 404.
    expect((await serveOnce(cache, `/media/${hash}`, () => hash)).status).toBe(404)
    expect((await serveOnce(cache, `/media/${TOKEN}`, () => undefined)).status).toBe(404)
    expect((await serveOnce(cache, `/media/${TOKEN}`, () => "b".repeat(64))).status).toBe(404)
    expect((await serveOnce(cache, "/media/../settings.json", () => hash)).status).toBe(404)
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash), "POST")).status).toBe(405)
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

  it("issue #150: every fetch says who is calling (image hosts such as Wikimedia answer 403 without a User-Agent); a refusing host is logged with its status", async () => {
    const agents: Array<string | undefined> = []
    const lines: Array<string> = []
    const fetchOptions = (status: number) => ({
      resolver: async () => ["93.184.216.34"],
      connector: async (r: ConnectRequest) => {
        agents.push(r.headers["user-agent"])
        // As upload.wikimedia.org does: no User-Agent is a 403 ("Please set a user-agent").
        if (r.headers["user-agent"] === undefined || r.headers["user-agent"] === "") return reply(403, new TextEncoder().encode("Please set a user-agent"), { "content-type": "text/plain" })
        return status === 200 ? reply(200, JPEG, { "content-type": "image/jpeg" }) : reply(status, new Uint8Array(), { "content-type": "text/plain" })
      }
    })
    const scope = await run(Scope.make())
    const plain = await run(makeMediaCache({ dir: mkdtempSync(join(tmpdir(), "pva-media-")), fetchOptions: fetchOptions(200) }).pipe(Scope.provide(scope)))
    expect("hash" in await run(plain.fetch("https://upload.wikimedia.org/a.jpg"))).toBe(true)
    const contact = { value: "owner@example.org" }
    const named = await run(makeMediaCache({ dir: mkdtempSync(join(tmpdir(), "pva-media-")), fetchOptions: fetchOptions(200), userAgent: () => `personal-voice-assistance/1 (${contact.value})` }).pipe(Scope.provide(scope)))
    expect("hash" in await run(named.fetch("https://thumb.wikimedia.org/b.jpg"))).toBe(true)
    // Read at each fetch: a changed contact is sent from the next fetch on.
    contact.value = "other@example.org"
    expect("hash" in await run(named.fetch("https://thumb.wikimedia.org/c.jpg"))).toBe(true)
    expect(agents).toEqual(["personal-voice-assistance/1", "personal-voice-assistance/1 (owner@example.org)", "personal-voice-assistance/1 (other@example.org)"])
    const refusing = await run(makeMediaCache({ dir: mkdtempSync(join(tmpdir(), "pva-media-")), fetchOptions: fetchOptions(429), log: (l) => lines.push(l) }).pipe(Scope.provide(scope)))
    expect(await run(refusing.fetch("https://img.example/secret/path.jpg?q=private"))).toEqual({ refused: "fetch" })
    expect(lines.filter((l) => l.includes("answered"))).toEqual(["Media: img.example answered 429; the image is not kept"])
    await run(Scope.close(scope, Exit.void))
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
    expect((await serveOnce(second.cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    // A day later: not served, and gone from the directory.
    w.clock.now += MEDIA_KEEP_MS
    expect((await serveOnce(second.cache, `/media/${TOKEN}`, only(hash))).status).toBe(404)
    await second.cache.sweep()
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
    expect(again.cache.stats()).toMatchObject({ files: 1, sure: true })
    expect((await serveOnce(again.cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    await run(again.close)
  })

  /** File operations that throw EIO for paths in `dir` while `fail` names them. */
  const faulty = (dir: string) => {
    const fail = new Set<keyof MediaFs>()
    let unreadable: string | undefined
    const eio = (op: keyof MediaFs, path: unknown) => {
      if (fail.has(op) && String(path).startsWith(dir)) throw Object.assign(new Error(`injected ${op} failure`), { code: "EIO" })
    }
    const fs: Partial<MediaFs> = {
      opendir: async (p, o) => (eio("opendir", p), opendir(p, o)),
      stat: async (p) => {
        if (fail.has("stat") && String(p).startsWith(dir)) {
          unreadable ??= String(p)
          if (unreadable === String(p)) throw Object.assign(new Error("injected stat failure"), { code: "EIO" })
        }
        return stat(p)
      },
      readFile: async (p) => (eio("readFile", p), readFile(p)),
      utimes: async (p, a, m) => (eio("utimes", p), (await import("node:fs/promises")).utimes(p, a, m)),
      unlink: async (p) => (eio("unlink", p), unlink(p)),
      readdirSync: (p) => (eio("readdirSync", p), realReaddir(p)),
      statSync: (p) => {
        // A stat fault hits one entry only (the first it meets), like one unreadable file.
        if (fail.has("statSync") && String(p).startsWith(dir)) {
          unreadable ??= String(p)
          if (unreadable === String(p)) throw Object.assign(new Error("injected statSync failure"), { code: "EIO" })
        }
        return realStat(p)
      },
      utimesSync: ((p: string, a: number, m: number) => (eio("utimesSync", p), realUtimes(p, a, m))) as MediaFs["utimesSync"],
      unlinkSync: ((p: string) => (eio("unlinkSync", p), realUnlink(p))) as MediaFs["unlinkSync"],
      readFileSync: (p) => (eio("readFileSync", p), realReadFile(p)),
      chmodSync: ((p: string, m: number) => realChmod(p, m)) as MediaFs["chmodSync"]
    }
    return { fs, fail }
  }
  const onDisk = (dir: string) => {
    const names = readdirSync(dir)
    return { files: names.length, bytes: names.reduce((n, name) => n + statSync(join(dir, name)).size, 0), names }
  }

  it("b4 (R6): a file whose removal fails makes the cache not sure: nothing new is admitted until an inventory removes it; the disk never holds more than the bound", async () => {
    const w = world()
    for (let i = 0; i < 2; i++) w.routes.set(`img.example/${i}.png`, () => reply(200, Uint8Array.from([...PNG, i]), { "content-type": "image/png" }))
    const dir = mkdtempSync(join(tmpdir(), "pva-media-"))
    const f = faulty(dir)
    const { cache, close } = await run(open(w, dir, { files: 1 }, { fs: f.fs }))
    expect("hash" in (await run(cache.fetch("https://img.example/0.png")))).toBe(true)
    w.clock.now += MEDIA_KEEP_MS + 1
    f.fail.add("unlinkSync")
    f.fail.add("unlink")
    await cache.sweep()
    expect(cache.stats()).toMatchObject({ files: 0, sure: false })
    // Not sure: refused, and the disk holds one file.
    expect(await run(cache.fetch("https://img.example/1.png"))).toEqual({ refused: "unavailable" })
    f.fail.clear()
    expect(readdirSync(dir)).toHaveLength(1)
    // The next admission takes an inventory first: the expired file goes, then there is room.
    expect("hash" in (await run(cache.fetch("https://img.example/1.png")))).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(cache.stats()).toMatchObject({ files: 1, sure: true })
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
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    expect(await run(cache.fetch("https://img.example/heron.png"))).toEqual({ hash })
    expect(w.requests.filter((r) => r === "img.example/heron.png")).toHaveLength(2)
    await run(close)
  })
  // ---- Review round 2, R6: the directory is the truth, and a fault closes the door.

  it("R6 media-write-failure: a write whose temporary file cannot be removed closes admission; the disk stays inside the bounds; a clean inventory removes it and admits again", async () => {
    const w = world()
    for (let i = 0; i < 40; i++) w.routes.set(`img.example/${i}.png`, () => reply(200, Uint8Array.from([...PNG, i]), { "content-type": "image/png" }))
    const dir = mkdtempSync(join(tmpdir(), "pva-media-"))
    const f = faulty(dir)
    const issues = makeIssueRegistry()
    const { cache, close } = await run(open(w, dir, { files: 2 }, { fs: f.fs, issues }))
    f.fail.add("utimes")
    f.fail.add("unlinkSync")
    f.fail.add("unlink")
    const outcomes = []
    for (let i = 0; i < 33; i++) outcomes.push(await run(cache.fetch(`https://img.example/${i}.png`)))
    // The first write fails (its temporary file stays); every later one is refused while the cache is not sure.
    expect(outcomes[0]).toEqual({ refused: "fetch" })
    expect(outcomes.slice(1).every((o) => "refused" in o && o.refused === "unavailable")).toBe(true)
    expect(cache.stats()).toMatchObject({ files: 0, sure: false })
    expect(onDisk(dir).files).toBe(1)
    expect(issues.all().map((i) => i.id)).toEqual(["media.cache"])
    f.fail.clear()
    await cache.sweep()
    expect(onDisk(dir).files).toBe(0)
    expect(cache.stats()).toMatchObject({ files: 0, bytes: 0, sure: true })
    expect(issues.all()).toEqual([])
    const { hash } = (await run(cache.fetch("https://img.example/39.png"))) as { hash: string }
    expect(onDisk(dir).names).toEqual([`${hash}.png`])
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    await run(close)
  })

  it("R6 media-startup-failure: an entry unreadable at start is never taken as absent: nothing new is admitted until an inventory reads it; then the bounds count it", async () => {
    const w = world()
    w.routes.set("img.example/new.png", () => reply(200, Uint8Array.from([...PNG, 99]), { "content-type": "image/png" }))
    const dir = mkdtempSync(join(tmpdir(), "pva-media-"))
    // Two valid images: the whole (small) bound.
    const seeded = [0, 1].map((i) => {
      const body = Uint8Array.from([...PNG, i])
      const name = `${createHash("sha256").update(body).digest("hex")}.png`
      writeFileSync(join(dir, name), body, { mode: 0o600 })
      utimesSync(join(dir, name), w.clock.now / 1000, w.clock.now / 1000)
      return name
    })
    const f = faulty(dir)
    f.fail.add("stat")
    const { cache, close } = await run(open(w, dir, { files: 2 }, { fs: f.fs }))
    expect(cache.stats()).toMatchObject({ files: 1, sure: false })
    // The one it could not read is not taken as absent: nothing new is admitted.
    expect(await run(cache.fetch("https://img.example/new.png"))).toEqual({ refused: "unavailable" })
    expect(onDisk(dir).files).toBe(2)
    f.fail.clear()
    // The inventory reads every entry: both counted, so the bound is reached; the disk never holds three.
    expect(await run(cache.fetch("https://img.example/new.png"))).toEqual({ refused: "full" })
    expect(cache.stats()).toMatchObject({ files: 2, sure: true })
    expect(onDisk(dir).names.sort()).toEqual([...seeded].sort())
    await run(close)
  })

  it("R6: a directory that cannot be read at start admits nothing until it can; then what is there is counted", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const first = await run(open(w))
    const { hash } = (await run(first.cache.fetch("https://img.example/heron.png"))) as { hash: string }
    await run(first.close)
    const f = faulty(first.dir)
    f.fail.add("opendir")
    const second = await run(open(w, first.dir, undefined, { fs: f.fs }))
    expect(second.cache.stats()).toMatchObject({ files: 0, sure: false })
    expect(await run(second.cache.fetch("https://img.example/heron.png"))).toEqual({ refused: "unavailable" })
    f.fail.clear()
    await second.cache.sweep()
    expect(second.cache.stats()).toMatchObject({ files: 1, sure: true })
    expect((await serveOnce(second.cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    await run(second.close)
  })

  it("R6 media-stale-replacement: an expired file whose removal failed is removed only by an inventory that sees it expired; the same bytes admitted afterwards stay and are served", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    w.routes.set("img.example/other.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const dir = mkdtempSync(join(tmpdir(), "pva-media-"))
    const f = faulty(dir)
    const { cache, close } = await run(open(w, dir, undefined, { fs: f.fs }))
    const { hash } = (await run(cache.fetch("https://img.example/heron.png"))) as { hash: string }
    w.clock.now += MEDIA_KEEP_MS + 1
    f.fail.add("unlinkSync")
    f.fail.add("unlink")
    // The expired copy cannot be removed: the same bytes from another address are not admitted on top of it.
    expect(await run(cache.fetch("https://img.example/other.png"))).toEqual({ refused: "unavailable" })
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(404)
    f.fail.clear()
    // The next admission takes the inventory: the expired file goes, the same bytes are a new file, served.
    expect(await run(cache.fetch("https://img.example/other.png"))).toEqual({ hash })
    await cache.sweep()
    await cache.sweep()
    expect(onDisk(dir).names).toEqual([`${hash}.png`])
    expect(cache.stats()).toMatchObject({ files: 1, sure: true })
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    await run(close)
  })
  it("round 3: a failed read while serving a held image keeps it: the cache is not sure, and a read that works again serves it again without an inventory", async () => {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const dir = mkdtempSync(join(tmpdir(), "pva-media-"))
    const f = faulty(dir)
    const { cache, close } = await run(open(w, dir, undefined, { fs: f.fs }))
    const { hash } = (await run(cache.fetch("https://img.example/heron.png"))) as { hash: string }
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    f.fail.add("readFile")
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(404)
    expect(cache.stats()).toMatchObject({ files: 1, sure: false })
    f.fail.clear()
    // No inventory in between: still held, and readable again.
    expect(cache.stats().sure).toBe(false)
    const again = (await serveOnce(cache, `/media/${TOKEN}`, only(hash)))
    expect(again.status).toBe(200)
    expect(again.body).toEqual(Buffer.from(PNG))
    await cache.sweep()
    expect(cache.stats()).toMatchObject({ files: 1, sure: true })
    await run(close)
  })
})

it("b2: recovery inventories asynchronously while unrelated work progresses, keeping admission closed", async () => {
  const w = world()
  const dir = mkdtempSync(join(tmpdir(), "pva-media-inventory-"))
  for (let i = 0; i < 32; i++) {
    const body = Buffer.from([...PNG, i])
    const name = `${createHash("sha256").update(body).digest("hex")}.png`
    writeFileSync(join(dir, name), body)
    utimesSync(join(dir, name), w.clock.now / 1000, w.clock.now / 1000)
  }
  let broken = false
  let recovering = false
  let syncStats = 0
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  const { cache, close } = await run(open(w, dir, undefined, { fs: {
    statSync: (p: string) => {
      if (recovering) { syncStats++; Atomics.wait(sleeper, 0, 0, 1) }
      return realStat(p)
    },
    readFile: async (p: string) => {
      if (broken) throw Object.assign(new Error("EIO"), { code: "EIO" })
      return readFile(p)
    }
  } }))
  try {
    const name = readdirSync(dir)[0]!
    broken = true
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(name.slice(0, 64)))).status).toBe(404)
    broken = false
    recovering = true
    let heartbeat = false
    let previous = performance.now()
    let longest = 0
    const beat = () => {
      const t = performance.now()
      longest = Math.max(longest, t - previous)
      previous = t
      heartbeat = true
    }
    const pulse = setInterval(beat, 1)
    const immediate = setImmediate(beat)
    try {
      const recovery = cache.sweep()
      expect(cache.stats().sure).toBe(false)
      await recovery
      expect(heartbeat).toBe(true)
      expect(syncStats).toBe(0)
      expect(cache.stats()).toMatchObject({ files: 32, sure: true })
      console.log(`media recovery longest event-loop gap: ${longest.toFixed(2)} ms`)
      expect(longest).toBeLessThan(10)
    } finally { clearInterval(pulse); clearImmediate(immediate) }
  } finally { await run(close) }
})

it("b3: restart inventory removes duplicate suffixes, truncated bytes and wrong digests before counting physical files", async () => {
  const w = world()
  const dir = mkdtempSync(join(tmpdir(), "pva-media-restored-"))
  let first = ""
  for (let i = 0; i < 255; i++) {
    const body = Buffer.from([...PNG, i])
    const hash = createHash("sha256").update(body).digest("hex")
    if (i === 0) first = hash
    const path = join(dir, `${hash}.png`)
    writeFileSync(path, body)
    utimesSync(path, w.clock.now / 1000, w.clock.now / 1000)
  }
  const duplicate = join(dir, `${first}.jpg`)
  writeFileSync(duplicate, Buffer.from([...PNG, 0]))
  utimesSync(duplicate, w.clock.now / 1000, w.clock.now / 1000)
  const wrong = join(dir, `${"a".repeat(64)}.png`)
  writeFileSync(wrong, PNG)
  utimesSync(wrong, w.clock.now / 1000, w.clock.now / 1000)
  const truncated = join(dir, `${"b".repeat(64)}.png`)
  writeFileSync(truncated, Buffer.alloc(0))
  utimesSync(truncated, w.clock.now / 1000, w.clock.now / 1000)
  w.routes.set("img.example/new.png", () => reply(200, Uint8Array.from([...PNG, 255]), { "content-type": "image/png" }))
  const { cache, close } = await run(open(w, dir))
  try {
    expect(readdirSync(dir)).toHaveLength(255)
    expect((await serveOnce(cache, `/media/${TOKEN}`, only("b".repeat(64)))).status).toBe(404)
    expect(cache.stats()).toMatchObject({ files: 255, sure: true })
    expect("hash" in await run(cache.fetch("https://img.example/new.png"))).toBe(true)
    expect(readdirSync(dir)).toHaveLength(256)
  } finally { await run(close) }
})

it("a6: a fresh keyed image resolves a real cache after its file's day and serves a ready image again", async () => {
  const { presentPrepared, presentWorld } = await import("@pva/core/present-contract")
  const { makeMemoryHouseholdStore } = await import("@pva/core/testing")
  await run(Effect.scoped(Effect.gen(function*() {
    const w = world()
    w.routes.set("img.example/heron.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const { cache, close } = yield* open(w)
    yield* Effect.addFinalizer(() => close)
    const presenter = yield* presentWorld(yield* presentPrepared(makeMemoryHouseholdStore()), { media: (url) => cache.fetch(url) })
    const image = { kind: "image", url: "https://img.example/heron.png", alt: "A", credit: "C", spoken: "A" } as const
    const showFresh = Effect.gen(function*() {
      const h = yield* presenter.showOn("kitchen-display", image, { key: "photo", lifetime: "pinned", expiresInMs: MEDIA_KEEP_MS })
      for (let i = 0; i < 1_000; i++) {
        yield* presenter.settle
        const content = presenter.shownOn("kitchen-display")[0]?.content
        if (content?.kind === "image" && content.image.state === "ready") {
          const token = content.image.token
          const response = yield* Effect.promise(() => serveOnce(cache, `/media/${token}`, presenter.present.mediaFor))
          expect(response.status).toBe(200)
          return h
        }
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      throw new Error("the fresh image did not resolve")
    })
    yield* showFresh
    w.clock.now += 23 * 3_600_000
    yield* showFresh
    w.clock.now += 3_600_001
    yield* showFresh
    expect(w.requests).toHaveLength(2)
  })))
})

it("r2 b1: slow successful writes and GET/HEAD reads yield, and reads recheck authorization and expiry", async () => {
  const { writeFile, utimes, rename } = await import("node:fs/promises")
  const w = world()
  w.routes.set("img.example/slow.png", () => reply(200, PNG, { "content-type": "image/png" }))
  let writing = false
  let reading = false
  let progressed = false
  let syncOps = 0
  let readAction = () => undefined as void
  const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 25))
  const { cache, close } = await run(open(w, undefined, undefined, { fs: {
    writeFile: async (...args: Parameters<typeof writeFile>) => { writing = true; await delay(); await writeFile(...args); writing = false },
    utimes, rename,
    readFile: async (path) => { reading = true; await delay(); readAction(); const body = await readFile(path); reading = false; return body },
    writeFileSync: (...args) => { syncOps++; return writeFileSync(...args) },
    readFileSync: (path) => { syncOps++; return realReadFile(path) }
  } }))
  try {
    const beat = setInterval(() => { if (writing || reading) progressed = true }, 1)
    try {
      const result = await run(cache.fetch("https://img.example/slow.png")) as { hash: string }
      expect(progressed).toBe(true)
      expect(syncOps).toBe(0)
      for (const method of ["GET", "HEAD"]) {
        progressed = false
        expect((await serveOnce(cache, `/media/${TOKEN}`, only(result.hash), method)).status).toBe(200)
        expect(progressed).toBe(true)
      }
      let held = true
      readAction = () => { held = false }
      expect((await serveOnce(cache, `/media/${TOKEN}`, () => held ? result.hash : undefined)).status).toBe(404)
      readAction = () => { w.clock.now += MEDIA_KEEP_MS }
      expect((await serveOnce(cache, `/media/${TOKEN}`, only(result.hash))).status).toBe(404)
      expect(syncOps).toBe(0)
    } finally { clearInterval(beat) }
  } finally { await run(close) }
})

it("r2 b2: admission rechecks expiry after joining an older slow sweep", async () => {
  const w = world()
  const older = Uint8Array.from([...PNG, 1])
  w.routes.set("img.example/older.png", () => reply(200, older, { "content-type": "image/png" }))
  w.routes.set("img.example/target.png", () => reply(200, PNG, { "content-type": "image/png" }))
  let release = () => undefined as void
  let entered = () => undefined as void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  let arm = false
  const oldHash = createHash("sha256").update(older).digest("hex")
  const { cache, close } = await run(open(w, undefined, undefined, { fs: { unlink: async (path) => {
    if (arm && path.endsWith(`${oldHash}.png`)) { entered(); await blocked }
    await unlink(path)
  } } }))
  try {
    await run(cache.fetch("https://img.example/older.png"))
    w.clock.now += 1_000
    const target = await run(cache.fetch("https://img.example/target.png")) as { hash: string }
    w.clock.now += MEDIA_KEEP_MS - 1_000
    arm = true
    const sweeping = cache.sweep()
    await started
    w.clock.now += 1_001
    w.routes.set("img.example/fresh.png", () => reply(200, PNG, { "content-type": "image/png" }))
    const fetching = run(cache.fetch("https://img.example/fresh.png"))
    release()
    await sweeping
    expect(await fetching).toEqual(target)
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(target.hash))).status).toBe(200)
  } finally { release(); await run(close) }
})

it("r2 b3: inventory removes dangling links and closes admission if that removal fails", async () => {
  const { symlinkSync } = await import("node:fs")
  for (const fail of [false, true]) {
    const w = world()
    const dir = mkdtempSync(join(tmpdir(), "pva-media-link-"))
    for (let i = 0; i < 255; i++) {
      const body = Buffer.from([...PNG, i])
      const path = join(dir, `${createHash("sha256").update(body).digest("hex")}.png`)
      writeFileSync(path, body)
      utimesSync(path, w.clock.now / 1000, w.clock.now / 1000)
    }
    const link = join(dir, `${"0".repeat(64)}.png`)
    symlinkSync("missing-entry", link)
    let blocked = fail
    const { cache, close } = await run(open(w, dir, undefined, { fs: { unlink: async (path) => {
      if (blocked && path === link) throw Object.assign(new Error("injected unlink"), { code: "EIO" })
      await unlink(path)
    } } }))
    try {
      expect(cache.stats().sure).toBe(!fail)
      expect(readdirSync(dir)).toHaveLength(fail ? 256 : 255)
      w.routes.set("img.example/new.png", () => reply(200, Uint8Array.from([...PNG, 255]), { "content-type": "image/png" }))
      if (fail) expect(await run(cache.fetch("https://img.example/new.png"))).toEqual({ refused: "unavailable" })
      blocked = false
      await cache.sweep()
      expect("hash" in await run(cache.fetch("https://img.example/new.png"))).toBe(true)
      expect(readdirSync(dir)).toHaveLength(256)
    } finally { await run(close) }
  }
})

it("r2 b4: a successfully read but corrupted live image is refused, invalidated and recovered", async () => {
  const w = world()
  w.routes.set("img.example/live.png", () => reply(200, PNG, { "content-type": "image/png" }))
  const { cache, dir, close } = await run(open(w))
  try {
    const { hash } = await run(cache.fetch("https://img.example/live.png")) as { hash: string }
    // Same-length corruption also has to be caught: signature and size alone are insufficient.
    for (const corrupt of [Buffer.alloc(0), Buffer.from([...PNG.slice(0, -1), 99])]) {
      writeFileSync(join(dir, `${hash}.png`), corrupt)
      expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(404)
      expect(cache.stats().sure).toBe(false)
      expect(await run(cache.fetch("https://img.example/live.png"))).toEqual({ hash })
      expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    }
    expect(w.requests).toHaveLength(3)
  } finally { await run(close) }
})

const mediaGate = () => {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

it.each([false, true])("r3 b2: inventory removes an empty foreign directory and safely refuses a nonempty one (%s)", async (nonempty) => {
  const { mkdir, rm, writeFile } = await import("node:fs/promises")
  const w = world(), dir = mkdtempSync(join(tmpdir(), "pva-media-directory-"))
  const foreign = join(dir, "old-cache")
  await mkdir(foreign)
  if (nonempty) await writeFile(join(foreign, "foreign.txt"), "Keep this")
  w.routes.set("img.example/new.png", () => reply(200, PNG, { "content-type": "image/png" }))
  const { cache, close } = await run(open(w, dir))
  try {
    expect(cache.stats().sure).toBe(!nonempty)
    if (nonempty) {
      expect(await run(cache.fetch("https://img.example/new.png"))).toEqual({ refused: "unavailable" })
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("Keep this")
      await unlink(join(foreign, "foreign.txt"))
      await cache.sweep()
    }
    expect("hash" in await run(cache.fetch("https://img.example/new.png"))).toBe(true)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(cache.stats()).toMatchObject({ files: 1, sure: true })
  } finally { await run(close); await rm(dir, { recursive: true, force: true }) }
})

it.each(["GET", "HEAD"])("r3 b3: inventory during a valid held %s does not turn recovery into a missing image", async (method) => {
  const w = world()
  w.routes.set("img.example/held.png", () => reply(200, PNG, { "content-type": "image/png" }))
  const begun = mediaGate(), resume = mediaGate()
  let failRead = false, delayRead = false
  const { cache, close } = await run(open(w, undefined, undefined, { fs: { readFile: async (path) => {
    if (failRead) { failRead = false; throw Object.assign(new Error("injected read"), { code: "EIO" }) }
    const body = await readFile(path)
    if (delayRead) { delayRead = false; begun.resolve(); await resume.promise }
    return body
  } } }))
  try {
    const { hash } = await run(cache.fetch("https://img.example/held.png")) as { hash: string }
    failRead = true
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(404)
    delayRead = true
    const retry = serveOnce(cache, `/media/${TOKEN}`, only(hash), method)
    await begun.promise
    await cache.sweep()
    expect(cache.stats().sure).toBe(true)
    resume.resolve()
    const response = await retry
    expect(response.status).toBe(200)
    expect(response.body).toEqual(method === "HEAD" ? undefined : Buffer.from(PNG))
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
  } finally { resume.resolve(); await run(close) }
})

it("r3 b4: a held read fault during an image write closes admission until inventory accounts for the renamed file", async () => {
  const { writeFile } = await import("node:fs/promises")
  const w = world(), issues = makeIssueRegistry()
  w.routes.set("img.example/held.png", () => reply(200, PNG, { "content-type": "image/png" }))
  w.routes.set("img.example/new.png", () => reply(200, Uint8Array.from([...PNG, 1]), { "content-type": "image/png" }))
  const begun = mediaGate(), resume = mediaGate()
  let failRead = false, delayWrite = false
  const { cache, dir, close } = await run(open(w, undefined, undefined, { issues, fs: {
    readFile: async (path) => {
      if (failRead) { failRead = false; throw Object.assign(new Error("injected read"), { code: "EIO" }) }
      return readFile(path)
    },
    writeFile: async (path, body, options) => {
      if (delayWrite) { delayWrite = false; begun.resolve(); await resume.promise }
      await writeFile(path, body, options)
    }
  } }))
  try {
    const { hash } = await run(cache.fetch("https://img.example/held.png")) as { hash: string }
    delayWrite = true
    const pending = run(cache.fetch("https://img.example/new.png"))
    await begun.promise
    failRead = true
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(404)
    resume.resolve()
    expect(await pending).toEqual({ refused: "unavailable" })
    expect(cache.stats()).toMatchObject({ files: 1, sure: false })
    expect(readdirSync(dir)).toHaveLength(2)
    expect(issues.all().map((i) => i.id)).toEqual(["media.cache"])
    expect((await serveOnce(cache, `/media/${TOKEN}`, only(hash))).status).toBe(200)
    await cache.sweep()
    expect(cache.stats()).toMatchObject({ files: 2, sure: true })
    expect(issues.all()).toEqual([])
    expect("hash" in await run(cache.fetch("https://img.example/new.png"))).toBe(true)
  } finally { resume.resolve(); await run(close) }
})

it("r3 b5: admission retires unrelated bytes that expired naturally while a sweep was waiting", async () => {
  const { performance: monotonic } = await import("node:perf_hooks")
  const w = world(), begun = mediaGate(), resume = mediaGate()
  let delayRemoval = false
  const old = Uint8Array.from([...PNG, 1]), next = Uint8Array.from([...PNG, 2, 3])
  const oldHash = createHash("sha256").update(old).digest("hex")
  w.routes.set("img.example/old.png", () => reply(200, old, { "content-type": "image/png" }))
  w.routes.set("img.example/held.png", () => reply(200, PNG, { "content-type": "image/png" }))
  w.routes.set("img.example/new.png", () => reply(200, next, { "content-type": "image/png" }))
  const { cache, close } = await run(open(w, undefined, { bytes: old.length + PNG.length }, { fs: { unlink: async (path) => {
    if (delayRemoval && path.endsWith(`${oldHash}.png`)) { begun.resolve(); await resume.promise }
    await unlink(path)
  } } }))
  try {
    await run(cache.fetch("https://img.example/old.png"))
    // Seed the second image so its day ends a little after the sweep starts.
    w.clock.now += 100
    await run(cache.fetch("https://img.example/held.png"))
    w.clock.now += MEDIA_KEEP_MS - 100
    // From here the wall clock runs forward normally; no correction is injected.
    const at = w.clock.now, start = monotonic.now()
    Object.defineProperty(w.clock, "now", { get: () => at + monotonic.now() - start })
    delayRemoval = true
    const sweeping = cache.sweep()
    await begun.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 110))
    const pending = run(cache.fetch("https://img.example/new.png"))
    resume.resolve()
    await sweeping
    const result = await pending
    expect("hash" in result).toBe(true)
    expect(cache.stats()).toMatchObject({ files: 1, bytes: next.length, sure: true })
    if ("hash" in result) expect((await serveOnce(cache, `/media/${TOKEN}`, only(result.hash))).status).toBe(200)
  } finally { resume.resolve(); await run(close) }
})
