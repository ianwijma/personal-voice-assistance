// The HTTP/WebSocket front door (http.ts): sockets the hub rejects, misbehaving peers, and the Host check.
import { ConfigProvider, Effect, Exit, Scope } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { allowedHostsFrom, hostAllowed, startHttp } from "../src/serve/http.ts"
import { ServeConfig } from "../src/serve/serveMode.ts"
import type { ConnectionHandlers, HubConnection, SessionHub } from "../src/serve/SessionHub.ts"

const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** A hub that rejects every socket, as the real one does past its connection limit. */
const rejectingHub = (): SessionHub & { rejected: number } => {
  const hub = {
    rejected: 0,
    accept: (connection: HubConnection): ConnectionHandlers | undefined => {
      hub.rejected++
      connection.close(4429, "too many connections")
      return undefined
    },
    broadcast: () => {},
    toSession: () => {},
    sessionsChanged: () => {},
    sessionDiscarded: () => {},
    closeAll: () => {},
    size: () => 0,
    micFramesLost: () => 0,
    vaultChanged: () => {},
    refreshDevices: () => {},
    wakeHeard: () => {},
    deviceViews: () => []
  }
  return hub
}

const start = async (hub: SessionHub, extra: { allowedHosts?: ReadonlyArray<string>; host?: string } = {}) => {
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const dir = mkdtempSync(join(tmpdir(), "pva-http-"))
  return Effect.runPromise(
    startHttp({ host: extra.host ?? "127.0.0.1", port: 0, webDir: join(dir, "none"), allowedOrigins: [], hub, ...(extra.allowedHosts ? { allowedHosts: extra.allowedHosts } : {}) })
      .pipe(Scope.provide(scope))
  )
}

const upgradeRequest = (port: number, headers: Record<string, string> = {}) =>
  [
    "GET /ws HTTP/1.1",
    `Host: ${headers.Host ?? `127.0.0.1:${port}`}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).filter(([k]) => k !== "Host").map(([k, v]) => `${k}: ${v}`),
    "",
    ""
  ].join("\r\n")

/** Captures uncaught exceptions while `body` runs (an unhandled `error` event on a socket ends up there). */
const uncaught = async (body: () => Promise<void>) => {
  const errors: Array<unknown> = []
  const listener = (error: unknown) => errors.push(error)
  process.on("uncaughtException", listener)
  try {
    await body()
  } finally {
    process.off("uncaughtException", listener)
  }
  return errors
}

describe("http: rejected and misbehaving sockets", () => {
  it("a socket the hub rejects that then sends a malformed frame does not crash the process, and is terminated", async () => {
    const hub = rejectingHub()
    const server = await start(hub)
    const errors = await uncaught(async () => {
      const socket = net.connect(server.port, "127.0.0.1")
      const received: Array<Buffer> = []
      socket.on("data", (d) => received.push(d))
      socket.on("error", () => {})
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()))
      socket.write(upgradeRequest(server.port))
      await new Promise<void>((resolve) => socket.once("data", () => resolve()))
      // FIN + RSV1 + text, masked, empty: "RSV1 must be clear" on a server without compression.
      socket.write(Buffer.from([0xc1, 0x80, 0, 0, 0, 0]))
      await Promise.race([closed, new Promise((r) => setTimeout(r, 3_000))])
      expect(socket.destroyed || socket.readableEnded).toBe(true)
      const text = Buffer.concat(received).toString("latin1")
      expect(text).toContain("101 Switching Protocols")
      // The client still got the close code (0x88 = close frame; 4429 = 0x114d).
      expect(Buffer.concat(received).includes(Buffer.from([0x11, 0x4d]))).toBe(true)
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(hub.rejected).toBe(1)
    expect(errors).toEqual([])
  })

  it("a rejected socket that never answers the close handshake is terminated promptly", async () => {
    const server = await start(rejectingHub())
    const socket = net.connect(server.port, "127.0.0.1")
    socket.on("error", () => {})
    socket.resume() // read (and ignore) what arrives, so the end of the stream is seen
    const closedAt = new Promise<number>((resolve) => socket.on("close", () => resolve(performance.now())))
    socket.write(upgradeRequest(server.port))
    const t0 = performance.now()
    const at = await Promise.race([closedAt, new Promise<number>((r) => setTimeout(() => r(Infinity), 3_500))])
    expect(at - t0).toBeLessThan(2_500)
  })

  it("a peer that resets right after a refused upgrade does not crash the process", async () => {
    const server = await start(rejectingHub())
    const errors = await uncaught(async () => {
      for (let i = 0; i < 30; i++) {
        const socket = net.connect(server.port, "127.0.0.1")
        socket.on("error", () => {})
        await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
        socket.write(upgradeRequest(server.port, { Origin: "http://evil.example" }))
        socket.resetAndDestroy()
      }
      await new Promise((r) => setTimeout(r, 200))
    })
    expect(errors).toEqual([])
  })
})

describe("http: Host check (DNS rebinding)", () => {
  it("allows IP literals, localhost and configured names; refuses other host names", () => {
    const allowed = allowedHostsFrom(["assistant.lan"], ["http://localhost:3000", "https://phone.example:8443"])
    for (const host of ["127.0.0.1:8787", "192.168.1.67:8787", "[::1]:8787", "localhost:8787", "LOCALHOST", "assistant.lan:8787", "phone.example"]) {
      expect(hostAllowed(host, allowed), host).toBe(true)
    }
    for (const host of [undefined, "", "evil.example:8787", "localhost.evil.example", "assistant.lan.evil.example", "127.0.0.1.nip.io:8787"]) {
      expect(hostAllowed(host, allowed), String(host)).toBe(false)
    }
  })

  it("a page on a rebinding host name (Origin and Host both evil.example) cannot open the socket or load the UI", async () => {
    const hub = rejectingHub()
    const server = await start(hub)
    const socket = net.connect(server.port, "127.0.0.1")
    socket.on("error", () => {})
    const data = new Promise<string>((resolve) => socket.once("data", (d) => resolve(d.toString("latin1"))))
    socket.write(upgradeRequest(server.port, { Host: `evil.example:${server.port}`, Origin: `http://evil.example:${server.port}` }))
    expect(await data).toMatch(/^HTTP\/1\.1 403/)
    expect(hub.rejected).toBe(0)
    socket.destroy()

    const page = await new Promise<number>((resolve, reject) => {
      const s = net.connect(server.port, "127.0.0.1")
      s.on("error", reject)
      s.once("data", (d) => {
        resolve(Number(d.toString("latin1").split(" ")[1]))
        s.destroy()
      })
      s.write(`GET / HTTP/1.1\r\nHost: evil.example:${server.port}\r\n\r\n`)
    })
    expect(page).toBe(403)
  })

  it("the owner's address (an IP literal, own origin) and a configured host name still connect", async () => {
    const hub = rejectingHub()
    const server = await start(hub, { allowedHosts: ["assistant.lan"] })
    for (const host of [`127.0.0.1:${server.port}`, `assistant.lan:${server.port}`]) {
      const socket = net.connect(server.port, "127.0.0.1")
      socket.on("error", () => {})
      const data = new Promise<string>((resolve) => socket.once("data", (d) => resolve(d.toString("latin1"))))
      socket.write(upgradeRequest(server.port, { Host: host, Origin: `http://${host}` }))
      expect(await data).toContain("101 Switching Protocols")
      socket.destroy()
    }
    expect(hub.rejected).toBe(2)
  })
})

/**
 * Connects with `allowHalfOpen` (the peer never sends FIN), sends `request`, reads the answer, then keeps
 * writing a byte every 100 ms. Resolves with the answer and whether the server cut the socket (a reset)
 * within `ms`. A server that only half-closes its side keeps accepting the writes forever.
 */
const halfOpenPeer = (port: number, request: string, ms: number) =>
  new Promise<{ answer: string; cut: boolean }>((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true })
    let answer = ""
    let timer: ReturnType<typeof setInterval> | undefined
    const done = (cut: boolean) => {
      if (timer !== undefined) clearInterval(timer)
      clearTimeout(deadline)
      socket.destroy()
      resolve({ answer, cut })
    }
    const deadline = setTimeout(() => done(false), ms)
    socket.on("data", (d) => {
      answer += d.toString("latin1")
      timer ??= setInterval(() => socket.write("x"), 100)
    })
    socket.on("error", () => done(true))
    socket.on("close", () => done(true))
    socket.write(request)
  })

describe("http: refused upgrades never hold a socket", () => {
  it("a peer refused for its Host, path or Origin that never sends FIN is cut within the deadline", async () => {
    const hub = rejectingHub()
    const server = await start(hub)
    const cases = [
      upgradeRequest(server.port, { Host: `evil.example:${server.port}` }),
      upgradeRequest(server.port).replace("GET /ws ", "GET /elsewhere "),
      upgradeRequest(server.port, { Origin: "http://evil.example" })
    ]
    const results = await Promise.all(cases.map((request) => halfOpenPeer(server.port, request, 3_000)))
    expect(results.map((r) => r.answer.split("\r\n")[0])).toEqual(["HTTP/1.1 403 Forbidden", "HTTP/1.1 404 Not Found", "HTTP/1.1 403 Forbidden"])
    expect(results.map((r) => r.cut)).toEqual([true, true, true])
    expect(hub.rejected).toBe(0)
    expect(server.openSockets()).toBe(0)
  })

  it("a burst of refused half-open peers leaves no socket behind; shutdown is prompt with refused sockets open", async () => {
    const server = await start(rejectingHub())
    const peers = Array.from({ length: 40 }, () => halfOpenPeer(server.port, upgradeRequest(server.port, { Origin: "http://evil.example" }), 3_000))
    expect((await Promise.all(peers)).every((r) => r.cut)).toBe(true)
    expect(server.openSockets()).toBe(0)
  })

  it("closing the server destroys sockets still waiting on an upgrade answer", async () => {
    const scope = Effect.runSync(Scope.make())
    const dir = mkdtempSync(join(tmpdir(), "pva-http-"))
    const server = await Effect.runPromise(
      startHttp({ host: "127.0.0.1", port: 0, webDir: join(dir, "none"), allowedOrigins: [], hub: rejectingHub() }).pipe(Scope.provide(scope))
    )
    // An upgrade request that is never completed (no final blank line) and a peer that never reads.
    const sockets = Array.from({ length: 5 }, () => {
      const s = net.connect({ port: server.port, host: "127.0.0.1", allowHalfOpen: true })
      s.on("error", () => {})
      s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\n`)
      return s
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(server.openSockets()).toBe(5)
    const t0 = performance.now()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    expect(performance.now() - t0).toBeLessThan(1_000)
    for (const s of sockets) s.destroy()
  })
})

describe("http: socket limits", () => {
  it("sockets past the server's limit are refused at once; the server keeps serving after they go", async () => {
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const dir = mkdtempSync(join(tmpdir(), "pva-http-"))
    const server = await Effect.runPromise(
      startHttp({ host: "127.0.0.1", port: 0, webDir: join(dir, "none"), allowedOrigins: [], hub: rejectingHub(), maxSockets: 10 }).pipe(Scope.provide(scope))
    )
    const idle = Array.from({ length: 30 }, () => {
      const s = net.connect({ port: server.port, host: "127.0.0.1", allowHalfOpen: true })
      s.on("error", () => {})
      return s
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(server.openSockets()).toBeLessThanOrEqual(10)
    for (const s of idle) s.destroy()
    await new Promise((r) => setTimeout(r, 100))
    const status = await new Promise<string>((resolve) => {
      const s = net.connect(server.port, "127.0.0.1")
      s.once("data", (d) => {
        resolve(d.toString("latin1").split("\r\n")[0]!)
        s.destroy()
      })
      s.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`)
    })
    expect(status).toBe("HTTP/1.1 503 Service Unavailable") // the "UI not built" page: the server still answers
  })

  it("a socket the hub accepted and then closed (no hello) is cut within the close deadline when the peer never answers", async () => {
    // The hub closes the connection itself (as on a missing hello or a bad first message).
    const closingHub: SessionHub = {
      ...rejectingHub(),
      accept: (connection) => {
        setTimeout(() => connection.close(4401, "no hello"), 10)
        return { onText: () => {}, onBinary: () => {}, onClose: () => {} }
      }
    }
    const server = await start(closingHub)
    const result = await halfOpenPeer(server.port, upgradeRequest(server.port), 3_500)
    expect(result.answer).toContain("101 Switching Protocols")
    expect(result.cut).toBe(true)
    expect(server.openSockets()).toBe(0)
  })
})

/** Paths of this process's open file descriptors (Linux: /proc/self/fd). */
const openFiles = (): Array<string> => {
  const out: Array<string> = []
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      out.push(readlinkSync(`/proc/self/fd/${fd}`))
    } catch {
      // closed meanwhile
    }
  }
  return out
}

describe("http: static downloads never hold a file", () => {
  it.skipIf(!existsSync("/proc/self/fd"))("a client that stops reading a large asset and then disconnects leaves no open file behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-http-static-"))
    const asset = join(dir, "big.js")
    writeFileSync(asset, Buffer.alloc(32 * 1024 * 1024, 0x61))
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const server = await Effect.runPromise(
      startHttp({ host: "127.0.0.1", port: 0, webDir: dir, allowedOrigins: [], hub: rejectingHub() }).pipe(Scope.provide(scope))
    )
    for (let round = 0; round < 3; round++) {
      const socket = net.connect(server.port, "127.0.0.1")
      socket.on("error", () => {})
      await new Promise<void>((resolve) => socket.once("connect", () => resolve()))
      socket.write(`GET /big.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`)
      // Read the first bytes, then stop reading: the response backs up and the file stream pauses.
      await new Promise<void>((resolve) => socket.once("data", () => resolve()))
      socket.pause()
      await new Promise((r) => setTimeout(r, 200))
      expect(openFiles().filter((f) => f === asset).length).toBe(1)
      socket.resetAndDestroy()
      for (let i = 0; i < 50 && openFiles().includes(asset); i++) await new Promise((r) => setTimeout(r, 20))
      expect(openFiles().filter((f) => f === asset), `round ${round}`).toEqual([])
    }
    expect(server.openSockets()).toBe(0)
  })
})

describe("http: TLS handshakes", () => {
  it("a TCP connection that never starts its TLS handshake is cut within the handshake deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-http-tls-"))
    const pems = selfSignedCertificate(dir)
    if (pems === undefined) return // no openssl on this machine
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const server = await Effect.runPromise(
      startHttp({ host: "127.0.0.1", port: 0, webDir: join(dir, "none"), allowedOrigins: [], hub: rejectingHub(), tls: pems, handshakeTimeoutMs: 300 })
        .pipe(Scope.provide(scope))
    )
    const socket = net.connect({ port: server.port, host: "127.0.0.1", allowHalfOpen: true })
    socket.on("error", () => {})
    const t0 = performance.now()
    const closedAt = await new Promise<number>((resolve) => {
      socket.on("end", () => resolve(performance.now()))
      socket.on("close", () => resolve(performance.now()))
      socket.resume()
      setTimeout(() => resolve(Infinity), 3_000)
    })
    expect(closedAt - t0).toBeLessThan(2_000)
    socket.destroy()
    for (let i = 0; i < 50 && server.openSockets() > 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(server.openSockets()).toBe(0)
  })
})

/** A throwaway self-signed certificate made with the openssl command, or undefined when it is missing. */
const selfSignedCertificate = (dir: string) => {
  const certFile = join(dir, "cert.pem")
  const keyFile = join(dir, "key.pem")
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", keyFile, "-out", certFile
  ], { stdio: "ignore" })
  return result.status === 0 ? { certFile, keyFile } : undefined
}

describe("http: cross-origin isolation headers (SERVE_CROSS_ORIGIN_ISOLATION)", () => {
  const isolation = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "same-origin"
  }
  /** A built UI: the page, a script, a worklet and a 404 page; and a second root with no 404 page. */
  const site = (with404: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "pva-http-coi-"))
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>")
    mkdirSync(join(dir, "_next/static/chunks"), { recursive: true })
    writeFileSync(join(dir, "_next/static/chunks/app.js"), "console.log(1)")
    mkdirSync(join(dir, "worklets"))
    writeFileSync(join(dir, "worklets/player.js"), "registerProcessor")
    if (with404) writeFileSync(join(dir, "404.html"), "<!doctype html><title>404</title>")
    return dir
  }
  const serve = async (webDir: string, crossOriginIsolation: boolean | undefined) => {
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const server = await Effect.runPromise(
      startHttp({
        host: "127.0.0.1",
        port: 0,
        webDir,
        allowedOrigins: [],
        hub: rejectingHub(),
        ...(crossOriginIsolation === undefined ? {} : { crossOriginIsolation })
      }).pipe(Scope.provide(scope))
    )
    return async (path: string, method = "GET") => {
      const res = await fetch(`${server.url}${path}`, { method })
      await res.arrayBuffer()
      const got: Record<string, string | null> = {}
      for (const name of Object.keys(isolation)) got[name] = res.headers.get(name)
      return { status: res.status, type: res.headers.get("content-type"), got }
    }
  }
  const responses = async (crossOriginIsolation: boolean | undefined) => {
    const built = await serve(site(true), crossOriginIsolation)
    const bare = await serve(site(false), crossOriginIsolation)
    const notBuilt = await serve(join(mkdtempSync(join(tmpdir(), "pva-http-coi-")), "none"), crossOriginIsolation)
    return {
      "the page (/)": await built("/"),
      "the page (/index.html)": await built("/index.html"),
      "a script": await built("/_next/static/chunks/app.js"),
      "a worklet module": await built("/worklets/player.js"),
      "HEAD of the page": await built("/", "HEAD"),
      "404 (the export's 404.html)": await built("/nope"),
      "404 (plain, no 404.html)": await bare("/nope"),
      "UI not built (503)": await notBuilt("/"),
      "method not allowed (405)": await built("/", "POST")
    }
  }

  it("on (the default): every static response, error pages included, carries COOP, COEP and CORP", async () => {
    const all = await responses(undefined)
    expect(Object.fromEntries(Object.entries(all).map(([k, r]) => [k, r.status]))).toEqual({
      "the page (/)": 200,
      "the page (/index.html)": 200,
      "a script": 200,
      "a worklet module": 200,
      "HEAD of the page": 200,
      "404 (the export's 404.html)": 404,
      "404 (plain, no 404.html)": 404,
      "UI not built (503)": 503,
      "method not allowed (405)": 405
    })
    for (const [name, r] of Object.entries(all)) expect(r.got, name).toEqual(isolation)
    expect(all["a worklet module"].type).toBe("text/javascript; charset=utf-8")
    expect(await responses(true)).toEqual(all)
  })

  it("off: none of the three headers, on any of those responses (statuses unchanged)", async () => {
    const all = await responses(false)
    const on = await responses(true)
    for (const [name, r] of Object.entries(all)) {
      expect(r.got, name).toEqual({ "cross-origin-opener-policy": null, "cross-origin-embedder-policy": null, "cross-origin-resource-policy": null })
      expect(r.status, name).toBe(on[name as keyof typeof on].status)
    }
  })

  it("the setting: on by default; SERVE_CROSS_ORIGIN_ISOLATION=false turns it off", () => {
    const read = (env: Record<string, string>) =>
      Effect.runSync(Effect.gen(function*() {
        return (yield* ServeConfig).crossOriginIsolation
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({ PVA_DATA_DIR: "/tmp/x", ...env }))
      ))
    expect(read({})).toBe(true)
    expect(read({ SERVE_CROSS_ORIGIN_ISOLATION: "false" })).toBe(false)
    expect(read({ SERVE_CROSS_ORIGIN_ISOLATION: "true" })).toBe(true)
  })
})

describe("http: the admin front end at /admin/", () => {
  /** A UI export with the voice page and the admin page in one of Next's two layouts. */
  const site = (layout: "admin.html" | "admin/index.html") => {
    const dir = mkdtempSync(join(tmpdir(), "pva-http-admin-"))
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>voice</title>")
    if (layout === "admin.html") writeFileSync(join(dir, "admin.html"), "<!doctype html><title>admin</title>")
    else {
      mkdirSync(join(dir, "admin"))
      writeFileSync(join(dir, "admin/index.html"), "<!doctype html><title>admin</title>")
    }
    writeFileSync(join(dir, "404.html"), "<!doctype html><title>404</title>")
    return dir
  }
  const serve = async (webDir: string) => {
    const scope = Effect.runSync(Scope.make())
    scopes.push(scope)
    const server = await Effect.runPromise(
      startHttp({ host: "127.0.0.1", port: 0, webDir, allowedOrigins: [], hub: rejectingHub() }).pipe(Scope.provide(scope))
    )
    return async (path: string) => {
      const res = await fetch(`${server.url}${path}`, { redirect: "manual" })
      return {
        status: res.status,
        location: res.headers.get("location"),
        body: await res.text(),
        type: res.headers.get("content-type"),
        coop: res.headers.get("cross-origin-opener-policy"),
        coep: res.headers.get("cross-origin-embedder-policy"),
        corp: res.headers.get("cross-origin-resource-policy"),
        nosniff: res.headers.get("x-content-type-options")
      }
    }
  }

  it("trailingSlash export (admin/index.html): /admin redirects to /admin/ (308, query kept), with the page's headers", async () => {
    const get = await serve(site("admin/index.html"))
    const voice = await get("/")
    for (const [path, to] of [["/admin", "/admin/"], ["/admin?x=1", "/admin/?x=1"]] as const) {
      const r = await get(path)
      expect(r.status, path).toBe(308)
      expect(r.location, path).toBe(to)
      expect([r.coop, r.coep, r.corp, r.nosniff], path).toEqual([voice.coop, voice.coep, voice.corp, voice.nosniff])
    }
    expect((await get("/")).status).toBe(200)
    expect((await get("/nope")).status).toBe(404)
  })

  for (const layout of ["admin.html", "admin/index.html"] as const) {
    it(`serves the admin page at /admin/ and its file path (export layout ${layout}), with the page's headers`, async () => {
      const get = await serve(site(layout))
      const voice = await get("/")
      for (const path of [...(layout === "admin.html" ? ["/admin", "/admin?x=1"] : []), "/admin/", `/${layout}`, "/admin/?x=1"]) {
        const r = await get(path)
        expect(r.status, path).toBe(200)
        expect(r.body, path).toContain("<title>admin</title>")
        expect({ ...r, body: undefined }, path).toEqual({ ...voice, body: undefined })
      }
      expect((await get("/admin/nope")).status).toBe(404)
      expect((await get("/adminx")).status).toBe(404)
    })
  }
})
