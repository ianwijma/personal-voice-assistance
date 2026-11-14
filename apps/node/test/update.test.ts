/**
 * Self-update and rollback (docs/VOICE-NODES.md §7.3, WP-4): the release bookkeeping of `releases.ts`, the updater
 * of `update.ts` against a local HTTP(S) fixture serving a manifest and bundles, the hooks in `runNode` (a check
 * before every hello and after a 4400, confirmation at `welcome`, a failed start on probation), and the boot guard
 * as a real process loading good and broken bundles.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { X509Certificate } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { AudioInput, AudioOutput } from "@pva/core"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NodeAudioInfo } from "../src/audio.ts"
import { countsAsFailedStart, type NodeExit, type NodeRunOptions, type NodeUpdates, runNode } from "../src/node.ts"
import {
  bootStart,
  confirmRelease,
  installRelease,
  linkedRelease,
  MAX_FAILED_STARTS,
  pointTo,
  readState,
  ReleaseInstallError,
  releaseFile,
  sha256Hex,
  writeState
} from "../src/releases.ts"
import { type CheckResult, httpFetch, makeUpdater, manifestUrl, nodeBaseUrl, parseTlsPin } from "../src/update.ts"
import { makeFakeInput, makeFakeOutput } from "./support/fakeAudio.ts"
import { FakeServer } from "./support/fakeServer.ts"

const bytes = (text: string) => new Uint8Array(Buffer.from(text))
const A = bytes("// release A\n")
const B = bytes("// release B\n")
const C = bytes("// release C\n")
const shaA = sha256Hex(A)
const shaB = sha256Hex(B)
const shaC = sha256Hex(C)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pva-node-releases-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A releases directory with A installed and confirmed, as install.sh leaves it. */
const installedA = () => {
  mkdirSync(join(dir, shaA))
  writeFileSync(releaseFile(dir, shaA), A)
  pointTo(dir, "current", shaA)
}

describe("releases: switching", () => {
  it("refuses bytes whose hash is not the release's, and writes nothing", () => {
    installedA()
    expect(() => installRelease(dir, shaB, C)).toThrow(ReleaseInstallError)
    expect(existsSync(join(dir, shaB))).toBe(false)
    expect(linkedRelease(dir, "current")).toBe(shaA)
    expect(readState(dir).pending).toBeUndefined()
  })

  it("stores the release, keeps the running one as previous and switches current with a rename", () => {
    installedA()
    installRelease(dir, shaB, B, 1000)
    expect(readFileSync(releaseFile(dir, shaB))).toEqual(Buffer.from(B))
    expect(lstatSync(join(dir, "current")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dir, "current"))).toBe(shaB) // relative: the directory can move
    expect(linkedRelease(dir, "previous")).toBe(shaA)
    expect(readState(dir).pending).toEqual({ sha256: shaB, previous: shaA, starts: 0, since: 1000 })
    // No temporary links or files are left behind.
    expect(readdirSync(dir).filter((f) => f.includes("tmp"))).toEqual([])
    expect(readdirSync(join(dir, shaB))).toEqual(["pva-node.mjs"])
  })

  it("while the running release is itself unconfirmed, the release to go back to stays the last confirmed one", () => {
    installedA()
    installRelease(dir, shaB, B)
    installRelease(dir, shaC, C) // B never reached welcome
    expect(linkedRelease(dir, "current")).toBe(shaC)
    expect(linkedRelease(dir, "previous")).toBe(shaA)
    expect(readState(dir).pending?.previous).toBe(shaA)
  })
})

describe("releases: boot and rollback", () => {
  it(`counts the starts of a new release and rolls it back on the start after ${MAX_FAILED_STARTS} without a welcome`, () => {
    installedA()
    installRelease(dir, shaB, B)
    for (let start = 1; start <= MAX_FAILED_STARTS; start++) {
      expect(bootStart(dir, 5000)).toEqual({ _tag: "Run", sha256: shaB, start })
      expect(readState(dir).pending?.starts).toBe(start)
    }
    const decision = bootStart(dir, 5000)
    expect(decision).toMatchObject({ _tag: "RolledBack", from: shaB, to: shaA })
    expect(linkedRelease(dir, "current")).toBe(shaA)
    expect(linkedRelease(dir, "previous")).toBeUndefined()
    const state = readState(dir)
    expect(state.pending).toBeUndefined()
    expect(state.bad).toEqual([shaB])
    expect(state.lastError).toEqual({ message: expect.stringContaining("rolled back"), at: 5000 })
    // The good release runs from then on, without counting.
    expect(bootStart(dir)).toEqual({ _tag: "Run", sha256: shaA })
    expect(bootStart(dir)).toEqual({ _tag: "Run", sha256: shaA })
  })

  it("a welcome confirms the release: no more counting, and releases other than current and previous are removed", () => {
    installedA()
    installRelease(dir, shaB, B)
    installRelease(dir, shaC, C)
    expect(bootStart(dir)).toMatchObject({ _tag: "Run", sha256: shaC, start: 1 })
    expect(confirmRelease(dir, shaC)).toBe(true)
    expect(readState(dir).pending).toBeUndefined()
    expect(readdirSync(dir).filter((f) => /^[0-9a-f]{64}$/.test(f)).sort()).toEqual([shaA, shaC].sort())
    for (let i = 0; i < MAX_FAILED_STARTS + 2; i++) expect(bootStart(dir)).toEqual({ _tag: "Run", sha256: shaC })
    expect(confirmRelease(dir, shaC)).toBe(false)
  })

  it("gives up (keeps running it) when there is nothing to go back to", () => {
    mkdirSync(join(dir, shaB))
    writeFileSync(releaseFile(dir, shaB), B)
    pointTo(dir, "current", shaB)
    writeState(dir, { bad: [], pending: { sha256: shaB, starts: MAX_FAILED_STARTS, since: 0 } })
    expect(bootStart(dir)).toMatchObject({ _tag: "GaveUp", sha256: shaB })
    expect(linkedRelease(dir, "current")).toBe(shaB)
    expect(readState(dir).pending).toBeUndefined()
  })

  it("drops a pending entry that does not match current, and reports a missing release", () => {
    installedA()
    writeState(dir, { bad: [], pending: { sha256: shaB, starts: 2, since: 0 } })
    expect(bootStart(dir)).toEqual({ _tag: "Run", sha256: shaA })
    expect(readState(dir).pending).toBeUndefined()
    rmSync(join(dir, "current"))
    expect(bootStart(dir)).toEqual({ _tag: "NoRelease" })
  })

  it("reads a damaged state file as empty", () => {
    writeFileSync(join(dir, "state.json"), "{ not json")
    expect(readState(dir)).toEqual({ bad: [] })
    writeFileSync(join(dir, "state.json"), JSON.stringify({ bad: ["nope", shaA], pending: { sha256: "x", starts: 1 } }))
    expect(readState(dir)).toEqual({ bad: [shaA] })
  })
})

// --- the updater against a local HTTP fixture --------------------------------------------------------------------

interface Fixture {
  readonly url: string
  readonly requests: Array<string>
  manifest: unknown
  files: Record<string, Uint8Array>
  readonly close: () => Promise<void>
}

const startFixture = (options: { readonly tls?: { key: string; cert: string } } = {}): Promise<Fixture> =>
  new Promise((resolveFixture) => {
    const fixture = { requests: [] as Array<string>, manifest: {} as unknown, files: {} as Record<string, Uint8Array> }
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      fixture.requests.push(req.url ?? "")
      if (req.url === "/node/manifest.json") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(fixture.manifest))
        return
      }
      const file = fixture.files[(req.url ?? "").replace(/^\/node\//, "")]
      if (file === undefined) res.writeHead(404).end()
      else res.writeHead(200).end(Buffer.from(file))
    }
    const server = options.tls !== undefined ? https.createServer(options.tls, handler) : http.createServer(handler)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port
      resolveFixture(Object.assign(fixture, {
        url: `${options.tls !== undefined ? "https" : "http"}://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      }))
    })
  })

const manifestFor = (bundle: Uint8Array, overrides: { readonly sha256?: string; readonly bytes?: number } = {}) => ({
  format: 1,
  protocol: 5,
  version: "0.0.0+test",
  bundle: { path: "pva-node.mjs", sha256: overrides.sha256 ?? sha256Hex(bundle), bytes: overrides.bytes ?? bundle.length },
  boot: { path: "pva-node-boot.mjs", sha256: "0".repeat(64), bytes: 1 },
  runtime: {
    version: process.versions.node,
    "linux-arm64": { url: "https://example.invalid/a.tar.gz", sha256: "1".repeat(64) },
    "linux-x64": { url: "https://example.invalid/x.tar.gz", sha256: "2".repeat(64) }
  }
})

describe("update: manifest URL", () => {
  it("is /node/ under the server, from any form of its URL", () => {
    expect(manifestUrl("http://assistant.lan:8787").href).toBe("http://assistant.lan:8787/node/manifest.json")
    expect(manifestUrl("http://assistant.lan:8787/").href).toBe("http://assistant.lan:8787/node/manifest.json")
    expect(manifestUrl("ws://assistant.lan:8787/ws").href).toBe("http://assistant.lan:8787/node/manifest.json")
    expect(manifestUrl("wss://home.example/assistant/ws").href).toBe("https://home.example/assistant/node/manifest.json")
    expect(nodeBaseUrl("https://home.example/assistant").href).toBe("https://home.example/assistant/node/")
  })

  it("takes a pin as sha256:<hex> only", () => {
    expect(parseTlsPin(undefined)).toBeUndefined()
    expect(parseTlsPin(`sha256:${"AB".repeat(32)}`)).toBe("ab".repeat(32))
    expect(() => parseTlsPin("sha256//abc=")).toThrow(/sha256:/)
  })
})

describe("update: check", () => {
  let fixture: Fixture
  const logs: Array<string> = []
  beforeEach(async () => {
    fixture = await startFixture()
    logs.length = 0
    installedA()
  })
  afterEach(() => fixture.close())

  const updater = (extra: Partial<Parameters<typeof makeUpdater>[0]> = {}) =>
    makeUpdater({ server: fixture.url, releasesDir: dir, runningSha: shaA, fetch: httpFetch(), log: (l) => logs.push(l), ...extra })

  it("does nothing when the server's bundle is the running one", async () => {
    fixture.manifest = manifestFor(A)
    expect(await Effect.runPromise(updater().check)).toEqual({ _tag: "UpToDate" })
    expect(fixture.requests).toEqual(["/node/manifest.json"])
  })

  it("downloads a different bundle, checks it and switches to it", async () => {
    fixture.manifest = manifestFor(B)
    fixture.files["pva-node.mjs"] = B
    const result = await Effect.runPromise(updater().check)
    expect(result).toEqual({ _tag: "Switched", from: shaA, to: shaB, version: "0.0.0+test" })
    expect(fixture.requests).toEqual(["/node/manifest.json", "/node/pva-node.mjs"])
    expect(linkedRelease(dir, "current")).toBe(shaB)
    expect(linkedRelease(dir, "previous")).toBe(shaA)
    expect(readState(dir).pending).toMatchObject({ sha256: shaB, previous: shaA, starts: 0 })
  })

  it("refuses a bundle whose hash does not match the manifest, records why, and stays", async () => {
    fixture.manifest = manifestFor(B, { sha256: shaB, bytes: C.length })
    fixture.files["pva-node.mjs"] = C // same length, other content
    const result = await Effect.runPromise(updater().check)
    expect(result).toMatchObject({ _tag: "Failed", unreachable: false, message: expect.stringContaining("SHA-256") })
    expect(linkedRelease(dir, "current")).toBe(shaA)
    expect(existsSync(join(dir, shaB))).toBe(false)
    expect(readState(dir).lastError?.message).toContain("update refused")
  })

  it("refuses a bundle longer than the manifest says (and stops reading it)", async () => {
    fixture.manifest = manifestFor(B, { bytes: B.length - 3 })
    fixture.files["pva-node.mjs"] = B
    const result = await Effect.runPromise(updater().check)
    expect(result).toMatchObject({ _tag: "Failed", unreachable: false, message: expect.stringContaining("longer than") })
    expect(linkedRelease(dir, "current")).toBe(shaA)
  })

  it("never switches to a release that was rolled back here", async () => {
    writeState(dir, { bad: [shaB] })
    fixture.manifest = manifestFor(B)
    fixture.files["pva-node.mjs"] = B
    expect(await Effect.runPromise(updater().check)).toEqual({ _tag: "Skipped", sha256: shaB })
    expect(fixture.requests).toEqual(["/node/manifest.json"])
  })

  it("treats a server that is away as unreachable (not an error to record)", async () => {
    await fixture.close()
    const u = updater({ server: "http://127.0.0.1:1" })
    const result = await Effect.runPromise(u.check)
    expect(result).toMatchObject({ _tag: "Failed", unreachable: true })
    expect(readState(dir).lastError).toBeUndefined()
    fixture = await startFixture() // for afterEach
  })

  it("refuses a manifest that is not one", async () => {
    fixture.manifest = { format: 2, bundle: {} }
    expect(await Effect.runPromise(updater().check)).toMatchObject({ _tag: "Failed", unreachable: false })
    expect(linkedRelease(dir, "current")).toBe(shaA)
  })

  it("says once when the server pins another Node runtime", async () => {
    fixture.manifest = manifestFor(A)
    const u = updater({ nodeVersion: "22.0.0", platform: "linux-x64" })
    await Effect.runPromise(u.check)
    await Effect.runPromise(u.check)
    expect(logs.filter((l) => l.includes("--upgrade-runtime"))).toHaveLength(1)
  })

  it("a welcome confirms a release on probation, once", async () => {
    installRelease(dir, shaB, B)
    const u = makeUpdater({ server: fixture.url, releasesDir: dir, runningSha: shaB, fetch: httpFetch(), log: (l) => logs.push(l) })
    expect(u.onProbation()).toBe(true)
    await Effect.runPromise(u.welcomed)
    expect(u.onProbation()).toBe(false)
    expect(readState(dir).pending).toBeUndefined()
  })
})

describe("update: TLS pin", () => {
  const openssl = spawnSync("openssl", ["version"]).status === 0
  it.skipIf(!openssl)("accepts a self-signed server whose public key matches the pin, and only that", async () => {
    const keyFile = join(dir, "key.pem")
    const certFile = join(dir, "cert.pem")
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" })
    const cert = readFileSync(certFile, "utf8")
    const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })
    const pin = `sha256:${sha256Hex(spki)}`
    const fixture = await startFixture({ tls: { key: readFileSync(keyFile, "utf8"), cert } })
    try {
      fixture.manifest = manifestFor(A)
      const url = new URL("/node/manifest.json", fixture.url)
      const fetch = (p?: string) => Effect.runPromise(Effect.exit(httpFetch(p)(url, { maxBytes: 65536, timeoutMs: 3000 })))
      const pinned = await fetch(pin)
      expect(Exit.isSuccess(pinned)).toBe(true)
      const wrong = await fetch(`sha256:${"0".repeat(64)}`)
      expect(Exit.isFailure(wrong) && String(wrong.cause)).toContain("does not match tlsPin")
      const unpinned = await fetch(undefined) // self-signed, no pin: the system CAs refuse it
      expect(Exit.isFailure(unpinned)).toBe(true)
    } finally {
      await fixture.close()
    }
  })
})

// --- the hooks in runNode -----------------------------------------------------------------------------------------

const fastTiming = { backoffBaseMs: 40, backoffMaxMs: 200, claimRetryMs: 100, unauthorizedRetryMs: 60_000, pingEveryMs: 1000, openTimeoutMs: 500 }

const runWith = (options: Omit<NodeRunOptions, "log">) => {
  const logs: Array<string> = []
  const mic = makeFakeInput()
  const out = makeFakeOutput(50)
  const layer = Layer.succeedContext(
    Context.make(AudioInput, mic.input).pipe(
      Context.add(AudioOutput, out.output),
      Context.add(NodeAudioInfo, NodeAudioInfo.of({ input: "file", output: "file", outputLatencyMs: 0, cueOutput: out.output }))
    )
  )
  const fiber = Effect.runFork(Effect.scoped(runNode({ ...options, log: (l) => logs.push(l) })).pipe(Effect.provide(layer)))
  const exit = Effect.runPromise(Fiber.join(fiber)) as Promise<NodeExit>
  exit.catch(() => {})
  return {
    logs,
    exit,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber))
  }
}

const scriptedUpdates = (results: Array<CheckResult["_tag"]>, probation = false) => {
  const calls: Array<string> = []
  let onProbation = probation
  const updates: NodeUpdates = {
    check: Effect.sync(() => {
      calls.push("check")
      return { _tag: results.shift() ?? "UpToDate" }
    }),
    welcomed: Effect.sync(() => {
      calls.push("welcomed")
      onProbation = false
    }),
    onProbation: () => onProbation
  }
  return { calls, updates }
}

describe("runNode: update hooks", () => {
  let server: FakeServer
  beforeEach(async () => {
    server = await FakeServer.start()
  })
  afterEach(() => server.stop())
  const config = () => ({ server: server.url, deviceId: "node-test-1" as never })

  it("checks before the hello, and exits for a new release without connecting", async () => {
    const { calls, updates } = scriptedUpdates(["Switched"])
    const node = runWith({ config: config(), timing: fastTiming, updates })
    expect(await node.exit).toEqual({ _tag: "Updated", exitCode: 0 })
    expect(calls).toEqual(["check"])
    expect(server.connections).toHaveLength(0)
  })

  it("confirms the release at welcome", async () => {
    const { calls, updates } = scriptedUpdates([], true)
    const node = runWith({ config: config(), timing: fastTiming, updates })
    const c = await server.connection(1)
    await c.waitFor("audio.claim")
    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toEqual(["check", "welcomed"])
    await node.stop()
  })

  it("a 4400 triggers a check right away, and a new release ends the run", async () => {
    server.options.welcome = false
    const { calls, updates } = scriptedUpdates(["UpToDate", "Switched"])
    const node = runWith({ config: config(), timing: fastTiming, updates })
    const c = await server.connection(1)
    await c.waitFor("hello")
    c.close(4400, "protocol mismatch")
    expect(await node.exit).toEqual({ _tag: "Updated", exitCode: 0 })
    expect(calls).toEqual(["check", "check"])
  })

  it("on probation, a server that refuses the release (4400, nothing newer) is a failed start", async () => {
    server.options.welcome = false
    const { updates } = scriptedUpdates([], true)
    const node = runWith({ config: config(), timing: fastTiming, updates })
    const c = await server.connection(1)
    await c.waitFor("hello")
    c.close(4400, "protocol mismatch")
    expect(await node.exit).toMatchObject({ _tag: "FailedStart", exitCode: 1 })
  })

  it("on probation, a server that is away is not the release's fault: it keeps retrying", async () => {
    const { calls, updates } = scriptedUpdates([], true)
    const node = runWith({ config: { server: "http://127.0.0.1:1", deviceId: "node-test-1" as never }, timing: fastTiming, updates })
    await new Promise((r) => setTimeout(r, 400))
    expect(calls.filter((c) => c === "check").length).toBeGreaterThanOrEqual(2)
    await node.stop()
  })

  it("counts only refusals and a missing welcome as failed starts", () => {
    const lost = (code: number, reason = "", welcomed = false) => ({ code, reason, welcomed }) as never
    expect(countsAsFailedStart(lost(4400))).toBe(true)
    expect(countsAsFailedStart(lost(1008))).toBe(true)
    expect(countsAsFailedStart(lost(0, "no welcome"))).toBe(true)
    expect(countsAsFailedStart(lost(0, "connect ECONNREFUSED"))).toBe(false)
    expect(countsAsFailedStart(lost(1001, "going away"))).toBe(false)
    expect(countsAsFailedStart(lost(4403, "unauthorized"))).toBe(false)
    expect(countsAsFailedStart(lost(4400, "", true))).toBe(false)
  })
})

// --- the boot guard as a process -----------------------------------------------------------------------------------

describe("boot guard", () => {
  const tsx = resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx")
  const boot = resolve(import.meta.dirname, "..", "src", "boot.ts")
  const start = (...args: Array<string>) =>
    spawnSync(tsx, [boot, ...args], { env: { ...process.env, PVA_NODE_RELEASES: dir }, encoding: "utf8", timeout: 30_000 })

  const release = (source: string) => {
    const b = bytes(source)
    const sha = sha256Hex(b)
    mkdirSync(join(dir, sha), { recursive: true })
    writeFileSync(releaseFile(dir, sha), b)
    return { sha, b }
  }

  it("loads current with the arguments, and rolls back a bundle that cannot even load after three starts", () => {
    const out = join(dir, "ran.json")
    const good = release(`import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), boot: process.env.PVA_NODE_BOOT !== undefined, self: process.argv[1] }))\n`)
    pointTo(dir, "current", good.sha)

    const first = start("run", "--config", "/etc/pva-node/node.json")
    expect(first.status).toBe(0)
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ argv: ["run", "--config", "/etc/pva-node/node.json"], boot: true, self: join(dir, "current", "pva-node.mjs") })
    rmSync(out)

    const broken = release("this is not JavaScript {\n")
    installRelease(dir, broken.sha, broken.b)
    for (let i = 1; i <= MAX_FAILED_STARTS; i++) {
      const r = start("run")
      expect(r.status).toBe(1)
      expect(r.stderr).toContain("failed to load")
    }
    expect(existsSync(out)).toBe(false)
    const fourth = start("run")
    expect(fourth.stderr).toContain("rolled back")
    expect(fourth.status).toBe(0)
    expect(JSON.parse(readFileSync(out, "utf8")).argv).toEqual(["run"])
    expect(linkedRelease(dir, "current")).toBe(good.sha)
    expect(readState(dir).bad).toEqual([broken.sha])
  })

  it("refuses to start without a release", () => {
    const r = start("run")
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("no release installed")
  })
})
