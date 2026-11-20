// Serving the voice node (nodeDist.ts): a fixture dist/, the four files, reload, and POST /node/pair.
import { Effect, Exit, Scope } from "effect"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { startHttp } from "../src/serve/http.ts"
import { makeNodeDist, type Redeem } from "../src/serve/nodeDist.ts"
import type { ConnectionHandlers, HubConnection, SessionHub } from "../src/serve/SessionHub.ts"

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const pin = { url: "https://example.invalid/node.tar.gz", sha256: "a".repeat(64) }

const BUNDLE = Buffer.from("export const bundle = 1\n")
const BOOT = Buffer.from("export const boot = 1\n")
const INSTALL = Buffer.from("#!/bin/sh\necho hi\n")

const writeDist = (dir: string, bundle: Buffer = BUNDLE, claimedSha = sha(bundle)) => {
  writeFileSync(join(dir, "pva-node.mjs"), bundle)
  writeFileSync(join(dir, "pva-node-boot.mjs"), BOOT)
  writeFileSync(join(dir, "install.sh"), INSTALL)
  const manifest = {
    format: 1,
    protocol: 12,
    version: "1.2.3",
    bundle: { path: "pva-node.mjs", sha256: claimedSha, bytes: bundle.length },
    boot: { path: "pva-node-boot.mjs", sha256: sha(BOOT), bytes: BOOT.length },
    installer: { path: "install.sh", sha256: sha(INSTALL), bytes: INSTALL.length },
    runtime: { version: "22.0.0", "linux-arm64": pin, "linux-x64": pin }
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  writeFileSync(join(dir, "manifest.json"), text)
  return text
}

const dirs: Array<string> = []
const servers: Array<http.Server> = []
const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r)).catch(() => {})
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "pva-nodedist-"))
  dirs.push(dir)
  return dir
}

const calls: Array<{ body: unknown; address: string }> = []
const okRedeem: Redeem = (body, address) => {
  calls.push({ body, address })
  return Effect.succeed({ status: 200, json: { deviceId: "vn-x", credential: "c".repeat(43), name: "box" } })
}

const serve = async (dist: ReturnType<typeof makeNodeDist>, redeem: Redeem = okRedeem) => {
  const server = http.createServer((req, res) => dist.handle(req, res, redeem))
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  return (server.address() as { port: number }).port
}

const request = (port: number, method: string, path: string, body?: string | Buffer, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Array<Buffer> = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end(body)
  })

const pairBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ code: "K7QM2XHP", hostname: "kitchen", platform: { os: "linux", arch: "arm64", hostname: "kitchen" }, version: "1.2.3", ...over })

describe("makeNodeDist: files", () => {
  it("serves the four files byte for byte with their headers", async () => {
    const dir = fixture()
    const manifestText = writeDist(dir)
    const lines: Array<string> = []
    const dist = makeNodeDist(dir, { log: (l) => lines.push(l) })
    const port = await serve(dist)

    const manifest = await request(port, "GET", "/node/manifest.json")
    expect(manifest.status).toBe(200)
    expect(manifest.body.toString()).toBe(manifestText)
    expect(manifest.headers["cache-control"]).toBe("no-store")

    const bundle = await request(port, "GET", "/node/pva-node.mjs")
    expect(bundle.body.equals(BUNDLE)).toBe(true)
    expect(bundle.headers["cache-control"]).toBe("no-cache")
    expect(bundle.headers.etag).toBe(`"${sha(BUNDLE)}"`)
    expect((await request(port, "GET", "/node/pva-node.mjs", undefined, { "If-None-Match": `"${sha(BUNDLE)}"` })).status).toBe(304)

    const boot = await request(port, "GET", "/node/pva-node-boot.mjs")
    expect(boot.body.equals(BOOT)).toBe(true)

    const install = await request(port, "GET", "/node/install.sh")
    expect(install.body.equals(INSTALL)).toBe(true)
    expect(install.headers["content-type"]).toBe("text/plain; charset=utf-8")
    expect(install.headers["cache-control"]).toBe("no-store")

    const head = await request(port, "HEAD", "/node/manifest.json")
    expect(head.status).toBe(200)
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(manifestText)))
    expect(head.body.length).toBe(0)

    expect(dist.manifest()?.version).toBe("1.2.3")
    expect(lines).toEqual([])
  })

  it("answers 404 not_built when dist/ is missing, and plain 404 for other paths", async () => {
    const dist = makeNodeDist(join(fixture(), "missing"), { log: () => {} })
    const port = await serve(dist)
    for (const f of ["manifest.json", "pva-node.mjs", "pva-node-boot.mjs", "install.sh"]) {
      const r = await request(port, "GET", `/node/${f}`)
      expect(r.status).toBe(404)
      expect(JSON.parse(r.body.toString())).toEqual({ error: "not_built" })
    }
    expect(dist.manifest()).toBeUndefined()
    const other = await request(port, "GET", "/node/other.txt")
    expect(other.status).toBe(404)
    expect(other.body.toString()).toBe("Not found")
    expect((await request(port, "GET", "/node/../secret")).status).toBe(404)
    expect((await request(port, "POST", "/node/manifest.json", "")).status).toBe(405)
  })

  it("refuses a file that does not match the manifest, logs it, and heals on the next load", async () => {
    const dir = fixture()
    writeDist(dir, BUNDLE, "b".repeat(64))
    const lines: Array<string> = []
    const dist = makeNodeDist(dir, { log: (l) => lines.push(l) })
    const port = await serve(dist)
    expect((await request(port, "GET", "/node/pva-node.mjs")).status).toBe(404)
    expect((await request(port, "GET", "/node/manifest.json")).status).toBe(404)
    expect(dist.manifest()).toBeUndefined()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain("SHA-256")
    // Asked again with nothing changed: still refused, not logged again.
    await request(port, "GET", "/node/install.sh")
    expect(lines.length).toBe(1)

    // Rebuilt: the manifest's mtime moves, the next request loads it.
    writeDist(dir)
    utimesSync(join(dir, "manifest.json"), new Date(), new Date(Date.now() + 5000))
    expect((await request(port, "GET", "/node/pva-node.mjs")).status).toBe(200)
    expect(dist.manifest()).toBeDefined()
  })

  it("reloads after the files are rewritten", async () => {
    const dir = fixture()
    writeDist(dir)
    const dist = makeNodeDist(dir, { log: () => {} })
    const port = await serve(dist)
    expect((await request(port, "GET", "/node/pva-node.mjs")).body.equals(BUNDLE)).toBe(true)

    const next = Buffer.from("export const bundle = 2 // longer\n")
    writeDist(dir, next)
    utimesSync(join(dir, "manifest.json"), new Date(), new Date(Date.now() + 5000))
    expect((await request(port, "GET", "/node/pva-node.mjs")).body.equals(next)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).bundle.sha256).toBe(dist.manifest()?.bundle.sha256)
  })

  it("refuses a manifest that does not decode", async () => {
    const dir = fixture()
    writeFileSync(join(dir, "manifest.json"), "{\"format\":2}")
    const lines: Array<string> = []
    const dist = makeNodeDist(dir, { log: (l) => lines.push(l) })
    const port = await serve(dist)
    expect((await request(port, "GET", "/node/install.sh")).status).toBe(404)
    expect(lines.length).toBe(1)
  })
})

describe("makeNodeDist: POST /node/pair", () => {
  it("passes the parsed body and the remote address to redeem and relays its answer", async () => {
    calls.length = 0
    const port = await serve(makeNodeDist(fixture(), { log: () => {} }))
    const r = await request(port, "POST", "/node/pair", pairBody(), { "Content-Type": "application/json" })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body.toString()).deviceId).toBe("vn-x")
    expect(r.headers["cache-control"]).toBe("no-store")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.address).toMatch(/127\.0\.0\.1$/)
    expect(calls[0]!.body).toMatchObject({ code: "K7QM2XHP", hostname: "kitchen", version: "1.2.3" })
  })

  it("relays 403, 503 and 429 (with Retry-After), and turns a failed redeem into 503 unavailable", async () => {
    let next: { status: number; json: unknown } | "die" = { status: 403, json: { error: "bad_code" } }
    const port = await serve(makeNodeDist(fixture(), { log: () => {} }), () => next === "die" ? Effect.die("boom") : Effect.succeed(next))
    expect(JSON.parse((await request(port, "POST", "/node/pair", pairBody())).body.toString())).toEqual({ error: "bad_code" })
    next = { status: 429, json: { error: "rate_limited", retryAfterMs: 29_500 } }
    const limited = await request(port, "POST", "/node/pair", pairBody())
    expect(limited.status).toBe(429)
    expect(limited.headers["retry-after"]).toBe("30")
    next = { status: 503, json: { error: "admin_disabled" } }
    expect((await request(port, "POST", "/node/pair", pairBody())).status).toBe(503)
    next = "die"
    const dead = await request(port, "POST", "/node/pair", pairBody())
    expect(dead.status).toBe(503)
    expect(JSON.parse(dead.body.toString())).toEqual({ error: "unavailable" })
  })

  it("rejects bad bodies with 400 bad_request without calling redeem", async () => {
    calls.length = 0
    const port = await serve(makeNodeDist(fixture(), { log: () => {} }))
    const bad = async (body: string | Buffer) => {
      const r = await request(port, "POST", "/node/pair", body)
      expect(r.status).toBe(400)
      expect(JSON.parse(r.body.toString())).toEqual({ error: "bad_request" })
    }
    await bad("not json")
    await bad("")
    await bad(pairBody({ code: "k7qm-2xhp" }))
    await bad(pairBody({ hostname: "h".repeat(65) }))
    await bad(pairBody({ version: undefined }))
    await bad(pairBody({ padding: "x".repeat(5000) }))
    await bad(Buffer.alloc(100_000, 0x20))
    expect(calls).toHaveLength(0)
    expect((await request(port, "GET", "/node/pair")).status).toBe(405)
  })

  it("refuses a request with an Origin header", async () => {
    calls.length = 0
    const port = await serve(makeNodeDist(fixture(), { log: () => {} }))
    const r = await request(port, "POST", "/node/pair", pairBody(), { Origin: "http://evil.example" })
    expect(r.status).toBe(403)
    expect(JSON.parse(r.body.toString())).toEqual({ error: "bad_origin" })
    expect(calls).toHaveLength(0)
  })
})

describe("http.ts node option", () => {
  const hub = (): SessionHub => ({
    accept: (c: HubConnection): ConnectionHandlers | undefined => (c.close(4429, "no"), undefined),
    broadcast: () => {},
    toSession: () => {},
    sessionsChanged: () => {},
    sessionDiscarded: () => {},
    closeAll: () => {},
    size: () => 0,
    micFramesLost: () => 0,
    vaultChanged: () => {},
    refreshDevices: () => {},
    nodeBundleChanged: () => {},
    wakeHeard: () => {},
    deviceViews: () => [],
    voiceConnections: () => [],
    deviceLive: () => ({ connected: false, visible: false }),
    entitiesChanged: () => undefined,
    endSessions: () => 0,
    audioOwnerOf: () => undefined,
    deviceOfConnection: () => undefined,
    deviceConnected: () => false
  })

  it("hands /node/ to the option after the host check, and leaves other paths to the static handler", async () => {
    const dir = fixture()
    writeDist(dir)
    const dist = makeNodeDist(dir, { log: () => {} })
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const server = await Effect.runPromise(
      startHttp({
        host: "127.0.0.1", port: 0, webDir: join(dir, "none"), allowedOrigins: [], hub: hub(),
        node: (req, res) => dist.handle(req, res, okRedeem)
      }).pipe(Scope.provide(scope))
    )
    expect((await request(server.port, "GET", "/node/install.sh")).body.equals(INSTALL)).toBe(true)
    expect((await request(server.port, "POST", "/node/pair", pairBody())).status).toBe(200)
    // Host check first: an unlisted name gets 403 and never reaches the node handler.
    const before = calls.length
    const rebound = await request(server.port, "POST", "/node/pair", pairBody(), { Host: "evil.example" })
    expect(rebound.status).toBe(403)
    expect(calls.length).toBe(before)
    // Not under /node/: the static page (not built here → 503).
    expect((await request(server.port, "GET", "/nodes")).status).toBe(503)
  })

  it("without the option /node/ is the static 404/503", async () => {
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const server = await Effect.runPromise(
      startHttp({ host: "127.0.0.1", port: 0, webDir: join(fixture(), "none"), allowedOrigins: [], hub: hub() }).pipe(Scope.provide(scope))
    )
    expect((await request(server.port, "GET", "/node/install.sh")).status).toBe(503)
  })
})
