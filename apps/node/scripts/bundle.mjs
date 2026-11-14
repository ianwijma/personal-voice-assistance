#!/usr/bin/env node
/**
 * The node's distribution artefacts (docs/VOICE-NODES.md §7.3): `pnpm --filter @pva/node bundle`.
 *
 *   dist/pva-node.mjs        the node program: src/main.ts with every workspace and npm dependency (esbuild, ESM)
 *   dist/pva-node-boot.mjs   the boot guard: src/boot.ts + src/releases.ts, no dependencies
 *   dist/install.sh          install/install.sh with the runtime pins and both unit templates filled in
 *   dist/manifest.json       what the server serves at /node/manifest.json (format: src/update.ts `Manifest`)
 *
 * The server (WP-7) serves these four files as they are under /node/. The bundle depends only on the source tree
 * (no timestamps), so the same commit always gives the same SHA-256 and nodes do not update for nothing.
 *
 *   node scripts/bundle.mjs [--out <dir>]
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { build } from "esbuild"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const { values } = parseArgs({ options: { out: { type: "string" } } })
const out = resolve(values.out ?? join(root, "dist"))

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const artifact = (path) => {
  const bytes = readFileSync(path)
  return { sha256: sha256(bytes), bytes: bytes.length }
}

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return undefined
  }
}

// "<package version>+<git short sha>" (§4.2), ".dirty" when the node's sources differ from that commit.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const commit = git("rev-parse", "--short=10", "HEAD") ?? "unknown"
const dirty = git("status", "--porcelain", "--", ".", "../../packages", "../../pnpm-lock.yaml")
const version = `${pkg.version}+${commit}${dirty ? ".dirty" : ""}`
if (version.length > 64) throw new Error(`version ${version} is longer than 64 characters`)

const runtime = JSON.parse(readFileSync(join(root, "scripts", "runtime.json"), "utf8"))
for (const key of ["linux-arm64", "linux-x64"]) {
  if (!/^[0-9a-f]{64}$/.test(runtime[key]?.sha256 ?? "") || !String(runtime[key]?.url).startsWith("https://")) {
    throw new Error(`scripts/runtime.json: ${key} needs an https url and a sha256`)
  }
}

const stage = mkdtempSync(join(dirname(out), ".pva-node-bundle-"))
try {
  const common = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    legalComments: "eof",
    logLevel: "warning",
    absWorkingDir: root
  }

  const main = await build({
    ...common,
    entryPoints: [join(root, "src", "main.ts")],
    outfile: join(stage, "pva-node.mjs"),
    define: { __PVA_NODE_BUILD__: JSON.stringify({ version }) },
    // CommonJS dependencies (ws) call require(); ESM output needs a real one. ws's optional native helpers are
    // not installed and not wanted (ws falls back to JavaScript).
    banner: { js: "import { createRequire as __pvaNodeCreateRequire } from \"node:module\";\nconst require = __pvaNodeCreateRequire(import.meta.url);" },
    external: ["bufferutil", "utf-8-validate"],
    metafile: true
  })

  await build({
    ...common,
    entryPoints: [join(root, "src", "boot.ts")],
    outfile: join(stage, "pva-node-boot.mjs")
  })
  // The guard must stay dependency-free: it runs when the bundle cannot.
  const bootText = readFileSync(join(stage, "pva-node-boot.mjs"), "utf8")
  const foreign = [...bootText.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1]).filter((m) => !m.startsWith("node:"))
  if (foreign.length > 0) throw new Error(`the boot guard imports ${foreign.join(", ")}; it may use node: modules only`)

  // install.sh: pins and unit templates in, so the served file is self-contained.
  const unit = (name) => {
    const text = readFileSync(join(root, "install", name), "utf8")
    if (/^PVA_UNIT_END$/m.test(text)) throw new Error(`${name} contains the heredoc terminator`)
    return text.replace(/\n$/, "")
  }
  const pins = [
    `NODE_VERSION='${runtime.version}'`,
    `NODE_URL_ARM64='${runtime["linux-arm64"].url}'`,
    `NODE_SHA256_ARM64='${runtime["linux-arm64"].sha256}'`,
    `NODE_URL_X64='${runtime["linux-x64"].url}'`,
    `NODE_SHA256_X64='${runtime["linux-x64"].sha256}'`,
    `INSTALLER_VERSION='${version}'`
  ].join("\n")
  let installer = readFileSync(join(root, "install", "install.sh"), "utf8")
  const replaceOnce = (pattern, value, what) => {
    if (!pattern.test(installer)) throw new Error(`install/install.sh has no ${what} marker`)
    installer = installer.replace(pattern, () => value)
  }
  replaceOnce(/^# @@PINS@@.*\n[\s\S]*?^# @@END PINS@@$/m, pins, "pins")
  replaceOnce(/^@@SYSTEM_UNIT@@$/m, unit("pva-node.service"), "system unit")
  replaceOnce(/^@@USER_UNIT@@$/m, unit("pva-node-user.service"), "user unit")
  writeFileSync(join(stage, "install.sh"), installer, { mode: 0o755 })

  // The bundle must start: this also reads the protocol version it speaks.
  const info = JSON.parse(execFileSync(process.execPath, [join(stage, "pva-node.mjs"), "version"], { encoding: "utf8" }))
  const bundle = artifact(join(stage, "pva-node.mjs"))
  if (info.version !== version || info.bundleSha256 !== bundle.sha256) {
    throw new Error(`the bundle reports ${JSON.stringify(info)}, expected version ${version} and hash ${bundle.sha256}`)
  }

  const { comment: _, ...pinned } = runtime
  const manifest = {
    format: 1,
    protocol: info.protocol,
    version,
    builtAt: new Date().toISOString(),
    bundle: { path: "pva-node.mjs", ...bundle },
    boot: { path: "pva-node-boot.mjs", ...artifact(join(stage, "pva-node-boot.mjs")) },
    installer: { path: "install.sh", ...artifact(join(stage, "install.sh")) },
    runtime: pinned
  }
  writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  // Into place one file at a time (each rename is atomic), the manifest last: a node never sees a manifest whose
  // files are not there yet.
  mkdirSync(out, { recursive: true })
  for (const file of ["pva-node.mjs", "pva-node-boot.mjs", "install.sh", "manifest.json"]) {
    renameSync(join(stage, file), join(out, file))
  }

  const inputs = Object.keys(main.metafile.inputs)
  const kb = (n) => `${(n / 1024).toFixed(0)} KiB`
  process.stdout.write(
    `pva-node ${version} (protocol ${info.protocol}): ${out}\n` +
      `  pva-node.mjs       ${kb(bundle.bytes)}  ${bundle.sha256}  (${inputs.length} inputs)\n` +
      `  pva-node-boot.mjs  ${kb(manifest.boot.bytes)}  ${manifest.boot.sha256}\n` +
      `  install.sh         ${kb(statSync(join(out, "install.sh")).size)}  ${manifest.installer.sha256}\n` +
      `  runtime            Node ${runtime.version}\n`
  )
} finally {
  rmSync(stage, { recursive: true, force: true })
}
