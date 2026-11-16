/**
 * `pva-node pair` (docs/VOICE-NODES.md §5.1): code normalisation, and `pair()` against a local HTTP server that
 * answers like `POST /node/pair`. install.test.ts covers the happy path through install.sh; these cover the
 * refusals and how each server answer is reported.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { normalizePairingCode, pair, pairUrl, platformInfo, postJson } from "../src/pair.ts"

describe("normalizePairingCode", () => {
  it("ignores case, spaces and dashes", () => {
    expect(normalizePairingCode("K7QM-2XHP")).toBe("K7QM2XHP")
    expect(normalizePairingCode("  k7qm 2xhp ")).toBe("K7QM2XHP")
    expect(normalizePairingCode("k7-qm-2x-hp")).toBe("K7QM2XHP")
  })

  it("reads O as 0 and I or L as 1, as Crockford base32 does", () => {
    expect(normalizePairingCode("OILOILOI")).toBe("01101101")
    expect(normalizePairingCode("oilo-iloi")).toBe("01101101")
  })

  it("refuses codes of the wrong length or with letters outside the alphabet", () => {
    expect(normalizePairingCode("")).toBeUndefined()
    expect(normalizePairingCode("K7QM2XH")).toBeUndefined() // 7
    expect(normalizePairingCode("K7QM2XHPZ")).toBeUndefined() // 9
    expect(normalizePairingCode("K7QM-2XHU")).toBeUndefined() // U is not in the alphabet
    expect(normalizePairingCode("K7QM-2XH!")).toBeUndefined()
  })
})

describe("pairUrl", () => {
  it("is /node/pair under the server, from any form of its URL", () => {
    expect(pairUrl("http://assistant.lan:8787").href).toBe("http://assistant.lan:8787/node/pair")
    expect(pairUrl("https://assistant.lan/").href).toBe("https://assistant.lan/node/pair")
    expect(pairUrl("ws://10.0.0.2:8787/ws").href).toBe("http://10.0.0.2:8787/node/pair")
    expect(pairUrl("wss://assistant.lan/prefix/ws").href).toBe("https://assistant.lan/prefix/node/pair")
  })
})

describe("platformInfo", () => {
  it("describes this host in the shape hello.node.platform takes", () => {
    const info = platformInfo()
    expect(info.os).toBe("linux")
    expect(["arm64", "x64", "arm"]).toContain(info.arch)
    expect(info.hostname.length).toBeGreaterThan(0)
    expect(info.hostname.length).toBeLessThanOrEqual(64)
    if (info.model !== undefined) {
      expect(info.model).not.toContain("\0")
      expect(info.model.length).toBeLessThanOrEqual(120)
    }
  })
})

interface Reply {
  readonly status: number
  readonly body: string
}

describe("pair", () => {
  let server: http.Server
  let base: string
  let dir: string
  let reply: Reply = { status: 200, body: "{}" }
  const received: Array<{ method: string | undefined; url: string | undefined; contentType: string | undefined; body: unknown }> = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pva-pair-"))
    server = http.createServer((req, res) => {
      let text = ""
      req.on("data", (c) => (text += c))
      req.on("end", () => {
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
        received.push({ method: req.method, url: req.url, contentType: req.headers["content-type"], body })
        res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  afterEach(() => {
    received.length = 0
    reply = { status: 200, body: "{}" }
  })

  const configPath = (name: string) => join(dir, `${name}.json`)
  const run = (code: string, extra: { name?: string; tlsPin?: string } = {}, path = configPath("node")) =>
    Effect.runPromise(Effect.flip(pair({ server: base, code, configPath: path, ...extra })))
  const answer = (json: unknown, status = 200): Reply => ({ status, body: JSON.stringify(json) })

  it("posts the normalised code and this host's platform, and writes the credential it gets back at 0600", async () => {
    reply = answer({ deviceId: "node-kitchen-1", credential: "A".repeat(43), name: "Kitchen" })
    const path = configPath("ok")
    const config = await Effect.runPromise(pair({ server: base, code: "k7qm-2xhp", configPath: path }))

    expect(config).toEqual({ server: base, deviceId: "node-kitchen-1", credential: "A".repeat(43), name: "Kitchen" })
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(config)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/node/pair",
      contentType: "application/json",
      body: { code: "K7QM2XHP", platform: { os: "linux" }, version: expect.any(String) }
    })
    expect((received[0]!.body as { hostname: string }).hostname).toBe(platformInfo().hostname)
  })

  it("lets --name win over the name the server suggests, keeps the tls pin, and works without a name", async () => {
    const pin = `sha256:${"ab".repeat(32)}`
    reply = answer({ deviceId: "node-kitchen-1", credential: "B".repeat(43), name: "Kitchen" })
    // A pin only matters for https; over plain http it is kept in the config and not checked.
    const named = await Effect.runPromise(pair({ server: base, code: "K7QM2XHP", configPath: configPath("named"), name: "Hall", tlsPin: pin }))
    expect(named.name).toBe("Hall")
    expect(named.tlsPin).toBe(pin)

    reply = answer({ deviceId: "node-kitchen-2", credential: "C".repeat(43) })
    const unnamed = await Effect.runPromise(pair({ server: base, code: "K7QM2XHP", configPath: configPath("unnamed") }))
    expect(unnamed).toEqual({ server: base, deviceId: "node-kitchen-2", credential: "C".repeat(43) })
    expect("name" in unnamed).toBe(false)
  })

  it("refuses a malformed code before sending anything", async () => {
    const error = await run("NOT-A-CODE!")
    expect(error.message).toContain("8 letters and digits")
    expect(received).toHaveLength(0)
  })

  it("tells a wrong, used, expired or admin-less server apart", async () => {
    reply = answer({ error: "bad_code" }, 403)
    expect((await run("K7QM2XHP")).message).toBe("pairing failed: the code is wrong or was already used")

    reply = answer({ error: "expired" }, 410)
    expect((await run("K7QM2XHP")).message).toBe("pairing failed: the code has expired; make a new one in admin")

    reply = answer({ error: "admin_disabled" }, 503)
    expect((await run("K7QM2XHP")).message).toContain("PVA_ADMIN_PASSWORD is not set")
  })

  it("says so when the server has no pairing, and passes an unknown error through", async () => {
    reply = { status: 404, body: "Not found" }
    expect((await run("K7QM2XHP")).message).toContain("does not offer pairing (/node/pair)")

    reply = answer({ error: "rate_limited" }, 429)
    expect((await run("K7QM2XHP")).message).toBe("pairing failed: rate_limited")

    reply = { status: 500, body: "<html>oops</html>" }
    expect((await run("K7QM2XHP")).message).toBe("pairing failed: HTTP 500")
  })

  it("refuses an answer that is not a pairing result, or that does not make a valid config, and writes nothing", async () => {
    const path = configPath("refused")
    reply = answer({ hello: "world" })
    expect((await run("K7QM2XHP", {}, path)).message).toContain("not a pairing result")

    reply = { status: 200, body: "not json" }
    expect((await run("K7QM2XHP", {}, path)).message).toContain("not a pairing result")

    reply = answer({ deviceId: "x", credential: "A".repeat(43) }) // device ids have a minimum length
    expect((await run("K7QM2XHP", {}, path)).message).toContain("does not make a valid config")

    expect(() => statSync(path)).toThrow()
  })

  it("reports a server that is not there, naming the URL", async () => {
    const closed = http.createServer()
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()))
    const port = (closed.address() as AddressInfo).port
    await new Promise<void>((r) => closed.close(() => r()))
    const error = await Effect.runPromise(Effect.flip(pair({ server: `http://127.0.0.1:${port}`, code: "K7QM2XHP", configPath: configPath("away") })))
    expect(error.message).toContain(`http://127.0.0.1:${port}/node/pair`)
    expect(error.message).toMatch(/ECONNREFUSED/)
  })

  it("reports a server that does not answer in time", async () => {
    const silent = http.createServer(() => {})
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()))
    const port = (silent.address() as AddressInfo).port
    try {
      const url = new URL(`http://127.0.0.1:${port}/node/pair`)
      const error = await Effect.runPromise(Effect.flip(postJson(url, {}, undefined, 100)))
      expect(error.message).toContain("no answer within 100 ms")
    } finally {
      silent.closeAllConnections()
      await new Promise<void>((r) => silent.close(() => r()))
    }
  })
})
