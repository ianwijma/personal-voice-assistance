/**
 * The distribution artefacts and the installer (docs/VOICE-NODES.md §8, WP-4), end to end on this machine without
 * touching it: `scripts/bundle.mjs` builds the real `dist/` into a temporary directory, a local HTTP fixture serves
 * it under `/node/` (as the server will, WP-7), and `install.sh --root <dir>` stages an install there (no root, no
 * users, no packages, no systemd: those steps are only recorded in `actions.log`).
 *
 * The Node runtime is a stand-in tarball (a `bin/node` that runs this Node), pinned into a copy of the built
 * install.sh in place of the real nodejs.org pins, so no download happens.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, symlinkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { NodeManifest } from "@pva/protocol"
import { Schema } from "effect"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sha256Hex } from "../src/releases.ts"

const app = resolve(import.meta.dirname, "..")
const tools = ["curl", "tar", "gzip", "sha256sum", "sh"].every((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0)

let work: string
let dist: string
let installer: string
let runtimeTarball: string
let badTarball: string
let server: http.Server
let base: string
const requests: Array<string> = []
const pairBodies: Array<unknown> = []
let tamper: Record<string, Uint8Array> = {}

const NODE_VERSION = "22.23.5"

beforeAll(async () => {
  if (!tools) return
  work = mkdtempSync(join(tmpdir(), "pva-node-install-"))
  dist = join(work, "dist")
  execFileSync(process.execPath, [join(app, "scripts", "bundle.mjs"), "--out", dist], { stdio: "pipe" })

  // A stand-in runtime with the layout of the nodejs.org tarball.
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const name = `node-v${NODE_VERSION}-linux-${arch}`
  mkdirSync(join(work, "rt", name, "bin"), { recursive: true })
  writeFileSync(join(work, "rt", name, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`)
  chmodSync(join(work, "rt", name, "bin", "node"), 0o755)
  runtimeTarball = join(work, "node.tar.gz")
  execFileSync("tar", ["-czf", runtimeTarball, "-C", join(work, "rt"), name])
  badTarball = join(work, "bad.tar.gz")
  writeFileSync(badTarball, Buffer.concat([readFileSync(runtimeTarball), Buffer.from("x")]))
  const sha = sha256Hex(readFileSync(runtimeTarball))
  installer = join(work, "install.sh")
  writeFileSync(
    installer,
    readFileSync(join(dist, "install.sh"), "utf8")
      .replace(/^NODE_SHA256_(ARM64|X64)='.*'$/gm, (_m, a: string) => `NODE_SHA256_${a}='${sha}'`)
      .replace(/^NODE_VERSION='.*'$/m, `NODE_VERSION='${NODE_VERSION}'`)
  )
  // The manifest pins the same runtime version (bundle.mjs copies scripts/runtime.json): the installer insists.
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))
  expect(manifest.runtime.version).toBe(NODE_VERSION)

  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.method === "POST" && req.url === "/node/pair") {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        const json = JSON.parse(body)
        pairBodies.push(json)
        if (json.code !== "K7QM2XHP") res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad_code" }))
        else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ deviceId: "node-kitchen-1", credential: "A".repeat(43), name: "Kitchen" }))
      })
      return
    }
    const file = (req.url ?? "").replace(/^\/node\//, "")
    const body = tamper[file] ?? (/^[a-z.-]+$/.test(file) && existsSync(join(dist, file)) ? readFileSync(join(dist, file)) : undefined)
    if (body === undefined) res.writeHead(404).end()
    else res.writeHead(200).end(Buffer.from(body))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  if (!tools) return
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(work, { recursive: true, force: true })
})

let root: string
beforeEach(() => {
  if (!tools) return
  root = mkdtempSync(join(work, "root-"))
  requests.length = 0
  tamper = {}
})

/** Run a program without blocking the event loop (the fixture server answers it from this process). */
const run = (command: string, args: Array<string>, env: NodeJS.ProcessEnv = {}): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolveRun) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.on("close", (status) => {
      clearTimeout(timer)
      resolveRun({ status, stdout, stderr })
    })
  })

const install = (args: Array<string>, env: NodeJS.ProcessEnv = {}) => run("sh", [installer, "--root", root, ...args], env)

const at = (path: string) => join(root, path)
const mode = (path: string) => (statSync(at(path)).mode & 0o777).toString(8)

describe.skipIf(!tools)("bundle", { timeout: 60_000 }, () => {
  it("writes the bundle, boot guard, installer and a manifest that describes them", async () => {
    const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))
    for (const key of ["bundle", "boot", "installer"]) {
      const file = readFileSync(join(dist, manifest[key].path))
      expect(manifest[key]).toEqual({ path: manifest[key].path, sha256: sha256Hex(file), bytes: file.length })
    }
    expect(manifest).toMatchObject({ format: 1, protocol: expect.any(Number), version: expect.stringMatching(/^0\.0\.0\+/) })
    expect(Object.keys(manifest.runtime).sort()).toEqual(["linux-arm64", "linux-x64", "version"])
    const version = JSON.parse(execFileSync(process.execPath, [join(dist, "pva-node.mjs"), "version"], { encoding: "utf8" }))
    expect(version).toMatchObject({ version: manifest.version, protocol: manifest.protocol, bundled: true, bundleSha256: manifest.bundle.sha256, installed: false })
  })

  it("is reproducible: the same source gives the same bundle", async () => {
    const again = join(work, "dist-again")
    execFileSync(process.execPath, [join(app, "scripts", "bundle.mjs"), "--out", again], { stdio: "pipe" })
    expect(sha256Hex(readFileSync(join(again, "pva-node.mjs")))).toBe(sha256Hex(readFileSync(join(dist, "pva-node.mjs"))))
  }, 60_000)

  it("leaves no unfilled markers in the served install.sh, and the source copy refuses to run", async () => {
    const served = readFileSync(join(dist, "install.sh"), "utf8")
    expect(served).not.toMatch(/@@[A-Z ]+@@/)
    expect(served).toMatch(/^NODE_SHA256_X64='[0-9a-f]{64}'$/m)
    expect(served).toContain("ExecStart=/opt/pva-node/runtime/current/bin/node /opt/pva-node/pva-node-boot.mjs run")
    const r = await run("sh", [join(app, "install", "install.sh"), "--root", join(work, "unused"), "--server", base])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("source copy")
  })
})

describe.skipIf(!tools)("install.sh (staged with --root)", { timeout: 60_000 }, () => {
  it("installs runtime, boot guard, release, config and the system unit", async () => {
    const r = await install(["--server", `${base}/`, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])
    expect(r.stderr).toContain("staged under")
    expect(r.status).toBe(0)
    const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))

    expect(readlinkSync(at("opt/pva-node/runtime/current"))).toMatch(/^node-v22\.23\.5-linux-(x64|arm64)$/)
    expect(sha256Hex(readFileSync(at("opt/pva-node/pva-node-boot.mjs")))).toBe(manifest.boot.sha256)
    expect(readlinkSync(at("opt/pva-node/releases/current"))).toBe(manifest.bundle.sha256)
    expect(sha256Hex(readFileSync(at("opt/pva-node/releases/current/pva-node.mjs")))).toBe(manifest.bundle.sha256)

    expect(JSON.parse(readFileSync(at("etc/pva-node/node.json"), "utf8"))).toEqual({ server: base, deviceId: "node-kitchen-1", credential: "A".repeat(43), name: "Kitchen" })
    expect(mode("etc/pva-node/node.json")).toBe("600")
    expect(mode("var/lib/pva-node")).toBe("700")
    expect(readFileSync(at("etc/pva-node/install.env"), "utf8")).toContain(`VARIANT=system\nRUN_USER=pva-node\nAUDIO=alsa\nSERVER=${base}\n`)

    const unit = readFileSync(at("etc/systemd/system/pva-node.service"), "utf8")
    expect(unit).toContain("ExecStart=/opt/pva-node/runtime/current/bin/node /opt/pva-node/pva-node-boot.mjs run --config /etc/pva-node/node.json --audio alsa")
    expect(unit).toContain("User=pva-node")
    expect(unit).toContain("ReadWritePaths=/var/lib/pva-node /opt/pva-node/releases")
    expect(unit).not.toContain("@")

    const actions = readFileSync(at("actions.log"), "utf8")
    expect(actions).toContain("useradd --system --user-group --home-dir /var/lib/pva-node --no-create-home --shell /usr/sbin/nologin pva-node")
    expect(actions).toContain("usermod -a -G audio pva-node")
    expect(actions).toContain("chown -R pva-node:pva-node")
    expect(actions).toMatch(/systemctl daemon-reload\nsystemctl enable pva-node.service\nsystemctl restart pva-node.service\n$/)
  })

  it("the staged release runs through the boot guard and knows it is installed", async () => {
    expect((await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])).status).toBe(0)
    const r = await run(at("opt/pva-node/runtime/current/bin/node"), [at("opt/pva-node/pva-node-boot.mjs"), "version"], { PVA_NODE_RELEASES: at("opt/pva-node/releases") })
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ installed: true, bundleSha256: readlinkSync(at("opt/pva-node/releases/current")) })
  })

  it("is idempotent: a second run downloads nothing new, keeps the config and remembers the server", async () => {
    expect((await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])).status).toBe(0)
    const config = readFileSync(at("etc/pva-node/node.json"), "utf8")
    requests.length = 0
    const again = await install(["--runtime", runtimeTarball]) // no --server: from install.env
    expect(again.status).toBe(0)
    expect(again.stderr).toContain("Node 22.23.5 is installed")
    expect(again.stderr).toContain("is installed")
    expect(again.stderr).toContain("keeping")
    expect(requests).toEqual(["GET /node/manifest.json"])
    expect(readFileSync(at("etc/pva-node/node.json"), "utf8")).toBe(config)
  })

  it("pairs with --code (the code is normalised) and keeps the credential at 0600", async () => {
    const r = await install(["--server", base, "--code", "k7qm-2xhp", "--runtime", runtimeTarball])
    expect(r.status).toBe(0)
    expect(pairBodies.at(-1)).toMatchObject({ code: "K7QM2XHP", version: expect.stringMatching(/^0\.0\.0\+/), platform: { os: "linux" } })
    expect(JSON.parse(readFileSync(at("etc/pva-node/node.json"), "utf8"))).toEqual({ server: base, deviceId: "node-kitchen-1", credential: "A".repeat(43), name: "Kitchen" })
    expect(mode("etc/pva-node/node.json")).toBe("600")
    const wrong = await install(["--server", base, "--code", "AAAA-BBBB", "--runtime", runtimeTarball])
    expect(wrong.status).toBe(1)
    expect(wrong.stderr).toContain("the code is wrong")
  })

  it("fails closed on a bundle that does not match the manifest, leaving the installed release alone", async () => {
    expect((await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])).status).toBe(0)
    const before = readlinkSync(at("opt/pva-node/releases/current"))
    const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))
    const other = Buffer.from("x".repeat(manifest.bundle.bytes))
    tamper = { "manifest.json": Buffer.from(JSON.stringify({ ...manifest, bundle: { ...manifest.bundle, sha256: "e".repeat(64) } })), "pva-node.mjs": other }
    const r = await install(["--runtime", runtimeTarball])
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/pva-node\.mjs has SHA-256 [0-9a-f]{64}, the manifest says e{64}; nothing was changed/)
    expect(readlinkSync(at("opt/pva-node/releases/current"))).toBe(before)
    expect(existsSync(at(`opt/pva-node/releases/${"e".repeat(64)}`))).toBe(false)
  })

  it("fails closed on a runtime tarball that does not match the pin, and installs nothing", async () => {
    const r = await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", badTarball])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("nothing was installed")
    expect(existsSync(at("opt/pva-node/runtime/current"))).toBe(false)
    expect(existsSync(at("opt/pva-node/releases/current"))).toBe(false)
  })

  it("refuses a manifest that pins another runtime than the installer (a stale install.sh)", async () => {
    const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))
    tamper = { "manifest.json": Buffer.from(JSON.stringify({ ...manifest, runtime: { ...manifest.runtime, version: "22.99.0" } })) }
    const r = await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("download install.sh from the server again")
  })

  it("has no unpaired mode any more: --no-pair and --device-id are unknown options", async () => {
    for (const option of [["--no-pair"], ["--device-id", "node-test-01"]]) {
      const r = await install(["--server", base, ...option, "--runtime", runtimeTarball])
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(`unknown option ${option[0]}`)
    }
    expect(existsSync(at("etc/pva-node/node.json"))).toBe(false)
    expect(existsSync(at("opt/pva-node/releases/current"))).toBe(false)
  })

  it("pairs again over a config from before pairing (no credential) instead of keeping it", async () => {
    mkdirSync(at("etc/pva-node"), { recursive: true })
    writeFileSync(at("etc/pva-node/node.json"), JSON.stringify({ server: base, deviceId: "node-test-01" }))
    const r = await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])
    expect(r.status).toBe(0)
    expect(JSON.parse(readFileSync(at("etc/pva-node/node.json"), "utf8"))).toMatchObject({ deviceId: "node-kitchen-1", credential: "A".repeat(43) })
  })

  it("the built manifest decodes as the NodeManifest of @pva/protocol", () => {
    const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"))
    expect(Schema.decodeUnknownSync(NodeManifest)(manifest)).toEqual(manifest)
  })

  it("refuses 32-bit ARM, a bad server URL and PipeWire without a user", async () => {
    const shim = join(work, "shim")
    mkdirSync(shim, { recursive: true })
    writeFileSync(join(shim, "uname"), `#!/bin/sh\n[ "$1" = "-m" ] && { echo armv7l; exit 0; }\nexec /usr/bin/env -i PATH=/usr/bin:/bin uname "$@"\n`)
    chmodSync(join(shim, "uname"), 0o755)
    const arm = await install(["--server", base], { PATH: `${shim}:${process.env["PATH"]}` })
    expect(arm.status).toBe(1)
    expect(arm.stderr).toContain("32-bit ARM is not supported")
    expect((await install(["--server", "ftp://x"])).stderr).toContain("--server must be an http")
    expect((await install(["--server", base, "--audio", "pipewire"])).stderr).toContain("--user")
  })

  it("installs a PipeWire user unit for --user", async () => {
    const r = await install(["--server", base, "--code", "K7QM-2XHP", "--audio", "pipewire", "--user", "ian", "--runtime", runtimeTarball])
    expect(r.status).toBe(0)
    const unit = readFileSync(at("home/ian/.config/systemd/user/pva-node.service"), "utf8")
    expect(unit).toContain("--audio pipewire")
    expect(unit).toContain("WantedBy=default.target")
    expect(existsSync(at("etc/systemd/system/pva-node.service"))).toBe(false)
    const actions = readFileSync(at("actions.log"), "utf8")
    expect(actions).toContain("loginctl enable-linger ian")
    expect(actions).toContain("systemctl --user -M ian@ restart pva-node.service")
    expect(actions).not.toContain("useradd")
  })

  it("a re-run keeps the release previous points at and removes other old releases", async () => {
    expect((await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])).status).toBe(0)
    const releases = at("opt/pva-node/releases")
    const kept = "a".repeat(64)
    const orphan = "b".repeat(64)
    for (const sha of [kept, orphan]) {
      mkdirSync(join(releases, sha))
      writeFileSync(join(releases, sha, "pva-node.mjs"), "// old\n")
    }
    symlinkSync(kept, join(releases, "previous"))
    expect((await install(["--runtime", runtimeTarball])).status).toBe(0)
    expect(readlinkSync(join(releases, "previous"))).toBe(kept)
    expect(existsSync(join(releases, kept, "pva-node.mjs"))).toBe(true)
    expect(existsSync(join(releases, orphan))).toBe(false)
  })

  it("--upgrade-runtime and --uninstall", async () => {
    expect((await install(["--server", base, "--code", "K7QM-2XHP", "--runtime", runtimeTarball])).status).toBe(0)
    const up = await install(["--upgrade-runtime", "--runtime", runtimeTarball])
    expect(up.status).toBe(0)
    expect(up.stderr).toContain("runs on Node 22.23.5")
    const r = await install(["--uninstall"])
    expect(r.status).toBe(0)
    for (const path of ["opt/pva-node", "etc/pva-node", "var/lib/pva-node", "etc/systemd/system/pva-node.service"]) {
      expect(existsSync(at(path))).toBe(false)
    }
    const actions = readFileSync(at("actions.log"), "utf8")
    expect(actions).toContain("systemctl disable --now pva-node.service")
    expect(actions).toContain("userdel pva-node")
    expect(lstatSync(root).isDirectory()).toBe(true)
  })
})
