/**
 * Self-update from the node's own server (docs/VOICE-NODES.md §7.3).
 *
 * Before every connection attempt (and after a 4400, and on WP-10's `node.command update`) the node fetches
 * `<server>/node/manifest.json`. When the manifest's `bundle.sha256` is not the running bundle's, it downloads the
 * bundle (at most `bundle.bytes`), refuses it unless its length and SHA-256 match the manifest, stores it as a new
 * release, switches `current` atomically and exits 0; the service manager starts the new release through the boot
 * guard (`boot.ts`), which rolls it back if it does not reach `welcome` in three starts (`releases.ts`). A release
 * that was rolled back is never switched to again. A server that cannot be reached is not an error here: the
 * connection attempt that follows reports it.
 *
 * Self-update is on only when the node runs from an installed release (`releases/<sha256>/pva-node.mjs`, the
 * directory named by the file's own SHA-256). A development run (`tsx src/main.ts`) or a bundle started from
 * `dist/` never replaces itself.
 *
 * The manifest format (`Manifest`) is the contract with the server's `/node/*` routes (WP-7); `scripts/bundle.mjs`
 * writes it.
 */
import { X509Certificate } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import { arch } from "node:os"
import { basename, dirname } from "node:path"
import type { TLSSocket } from "node:tls"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { installRelease, isSha256, readState, recordError, ReleaseInstallError, confirmRelease, sha256Hex } from "./releases.ts"

/** Filled in by `scripts/bundle.mjs` (esbuild `define`); absent in a development run. */
declare const __PVA_NODE_BUILD__: { readonly version: string } | undefined

/** Only what is derived from the source goes in, so the same commit always gives the same bundle (and hash). */
export const BUILD: { readonly version: string } | undefined =
  typeof __PVA_NODE_BUILD__ === "undefined" ? undefined : __PVA_NODE_BUILD__

/** `"<package version>+<git short sha>"` of the bundle, `"dev"` when running from source. */
export const NODE_VERSION = BUILD?.version ?? "dev"

// --- the manifest ------------------------------------------------------------------------------------------------

export const MANIFEST_FORMAT = 1
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
/** A file next to the manifest. `path` is resolved against the manifest's URL. */
export const Artifact = Schema.Struct({ path: Schema.String, sha256: Sha256, bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) })
const RuntimePin = Schema.Struct({ url: Schema.String, sha256: Sha256 })

export const Manifest = Schema.Struct({
  format: Schema.Literal(MANIFEST_FORMAT),
  /** `PROTOCOL_VERSION` of the bundle. */
  protocol: Schema.Int,
  version: Schema.String,
  builtAt: Schema.optionalKey(Schema.String),
  /** `pva-node.mjs`: what the node runs. */
  bundle: Artifact,
  /** `pva-node-boot.mjs`: the boot guard (installed by install.sh, never by the node). */
  boot: Artifact,
  /** `install.sh`, for admin's command and for checking a downloaded copy. */
  installer: Schema.optionalKey(Artifact),
  /** The pinned Node runtime (`scripts/runtime.json`). */
  runtime: Schema.Struct({ version: Schema.String, "linux-arm64": RuntimePin, "linux-x64": RuntimePin })
})
export type Manifest = typeof Manifest.Type

export class UpdateError extends Schema.TaggedError<UpdateError>()("UpdateError", {
  message: Schema.String,
  /** The server could not be reached or answered with an error (not worth recording as the node's last error). */
  unreachable: Schema.Boolean
}) {}

/** The HTTP(S) base of the server for `/node/*`: `ws` → `http`, `wss` → `https`, a trailing `/ws` dropped. */
export const nodeBaseUrl = (server: string): URL => {
  const url = new URL(server)
  if (url.protocol === "ws:") url.protocol = "http:"
  else if (url.protocol === "wss:") url.protocol = "https:"
  let path = url.pathname.endsWith("/ws") ? url.pathname.slice(0, -3) : url.pathname
  if (!path.endsWith("/")) path += "/"
  url.pathname = `${path}node/`
  url.search = ""
  url.hash = ""
  return url
}

export const manifestUrl = (server: string): URL => new URL("manifest.json", nodeBaseUrl(server))

export const decodeManifest = (bytes: Uint8Array): Effect.Effect<Manifest, UpdateError> =>
  Effect.try({
    try: (): unknown => JSON.parse(Buffer.from(bytes).toString("utf8")),
    catch: () => new UpdateError({ message: "the manifest is not valid JSON", unreachable: false })
  }).pipe(
    Effect.flatMap((json) => Schema.decodeUnknownEffect(Manifest)(json)),
    Effect.mapError((e) => e instanceof UpdateError ? e : new UpdateError({ message: `not a node manifest: ${e.message}`, unreachable: false }))
  )

// --- fetching ----------------------------------------------------------------------------------------------------

export interface FetchOptions {
  /** Longer bodies are refused (and the download aborted). */
  readonly maxBytes: number
  readonly timeoutMs: number
}

export type Fetch = (url: URL, options: FetchOptions) => Effect.Effect<Uint8Array, UpdateError>

/** `sha256:<64 hex>`: SHA-256 of the server certificate's public key (DER SubjectPublicKeyInfo), as curl's `--pinnedpubkey`. */
export const parseTlsPin = (pin: string | undefined): string | undefined => {
  if (pin === undefined || pin === "") return undefined
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(pin.trim())
  if (m === null) throw new Error(`tlsPin must be sha256:<64 hex digits>, not ${pin}`)
  return m[1]!.toLowerCase()
}

/**
 * SHA-256 (hex) of the peer certificate's public key as DER SubjectPublicKeyInfo — what `tlsPin` and curl's
 * `--pinnedpubkey sha256//…` compare. (`getPeerCertificate().pubkey` is not SPKI for every key type: for EC keys it
 * is the bare point, so the key is taken from the certificate itself.) `undefined` without a certificate.
 */
export const peerKeySha256 = (socket: TLSSocket): string | undefined => {
  const raw = socket.getPeerCertificate().raw
  if (raw === undefined || raw.length === 0) return undefined
  return sha256Hex(new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" }))
}

/**
 * GET over `http:` / `https:` with Node's own client. With `tlsPin`, an `https:` server is accepted when its
 * certificate's public key has that SHA-256, whoever signed it (a self-signed server); without, the system's CAs
 * decide. Only public files are fetched here (no credential is sent), so checking the pin when the response
 * arrives is enough.
 */
export const httpFetch = (tlsPin?: string): Fetch => {
  const pin = parseTlsPin(tlsPin)
  return (url, options) =>
    Effect.callback<Uint8Array, UpdateError>((resume) => {
      let done = false
      const finish = (effect: Effect.Effect<Uint8Array, UpdateError>) => {
        if (done) return
        done = true
        resume(effect)
      }
      const fail = (message: string, unreachable: boolean) => finish(Effect.fail(new UpdateError({ message: `${url.href}: ${message}`, unreachable })))
      const onResponse = (res: http.IncomingMessage) => {
        if (pin !== undefined && url.protocol === "https:") {
          if (peerKeySha256(res.socket as TLSSocket) !== pin) {
            res.destroy()
            return fail("the server's certificate does not match tlsPin", false)
          }
        }
        if (res.statusCode !== 200) {
          res.resume()
          return fail(`HTTP ${res.statusCode ?? "?"}`, true)
        }
        const chunks: Array<Buffer> = []
        let length = 0
        res.on("data", (chunk: Buffer) => {
          length += chunk.length
          if (length > options.maxBytes) {
            res.destroy()
            fail(`longer than the ${options.maxBytes} bytes expected`, false)
          } else chunks.push(chunk)
        })
        res.on("end", () => {
          const body = Buffer.concat(chunks)
          finish(Effect.succeed(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)))
        })
        res.on("error", (e) => fail(e.message, true))
      }
      const headers = { "user-agent": `pva-node/${NODE_VERSION}` }
      const req = url.protocol === "https:"
        ? https.get(url, { headers, ...(pin !== undefined ? { rejectUnauthorized: false } : {}) }, onResponse)
        : url.protocol === "http:"
        ? http.get(url, { headers }, onResponse)
        : undefined
      if (req === undefined) {
        fail("only http and https are supported", false)
        return Effect.void
      }
      req.on("error", (e) => fail(e.message, true))
      return Effect.sync(() => void req.destroy())
    }).pipe(
      Effect.timeoutOrElse({
        duration: options.timeoutMs,
        orElse: () => Effect.fail(new UpdateError({ message: `${url.href}: no answer within ${options.timeoutMs} ms`, unreachable: true }))
      })
    )
}

// --- where the node runs from ------------------------------------------------------------------------------------

export type InstallInfo =
  /** Running from source (`tsx`): no bundle hash, no self-update. */
  | { readonly _tag: "Dev" }
  /** A bundle outside the release layout (e.g. `node apps/node/dist/pva-node.mjs`): known hash, no self-update. */
  | { readonly _tag: "NotInstalled"; readonly sha256: string }
  | { readonly _tag: "Installed"; readonly sha256: string; readonly releasesDir: string; readonly bootPath?: string }

/** Where this bundle runs from (`file` defaults to this module's own file, i.e. the bundle). */
export const detectInstall = (file: string = fileURLToPath(import.meta.url), env: NodeJS.ProcessEnv = process.env, bundled = BUILD !== undefined): InstallInfo => {
  if (!bundled) return { _tag: "Dev" }
  const real = realpathSync(file)
  const sha256 = sha256Hex(readFileSync(real))
  const releaseDir = dirname(real)
  const releasesDir = dirname(releaseDir)
  if (basename(releaseDir) !== sha256 || !existsSync(`${releasesDir}/current`)) return { _tag: "NotInstalled", sha256 }
  const boot = env["PVA_NODE_BOOT"]
  return { _tag: "Installed", sha256, releasesDir, ...(boot !== undefined && boot !== "" ? { bootPath: boot } : {}) }
}

// --- the updater -------------------------------------------------------------------------------------------------

export type CheckResult =
  | { readonly _tag: "UpToDate" }
  /** A new release is in place; exit so it starts. */
  | { readonly _tag: "Switched"; readonly from: string; readonly to: string; readonly version: string }
  /** The server's bundle was rolled back here before; stay on this one. */
  | { readonly _tag: "Skipped"; readonly sha256: string }
  | { readonly _tag: "Failed"; readonly message: string; readonly unreachable: boolean }

export interface UpdaterOptions {
  readonly server: string
  readonly releasesDir: string
  /** SHA-256 of the running bundle. */
  readonly runningSha: string
  readonly fetch: Fetch
  readonly log: (line: string) => void
  /** The boot guard's path (`PVA_NODE_BOOT`), to tell when the installer should be run again. */
  readonly bootPath?: string | undefined
  /** `linux-arm64` / `linux-x64` key of `manifest.runtime`, and the running Node version (for the runtime hint). */
  readonly platform?: string
  readonly nodeVersion?: string
  readonly manifestTimeoutMs?: number
  readonly bundleTimeoutMs?: number
  readonly now?: () => number
}

export interface Updater {
  /** Fetch the manifest and switch to the server's bundle when it differs. Never fails. */
  readonly check: Effect.Effect<CheckResult>
  /** The server welcomed this node: the running release is confirmed. */
  readonly welcomed: Effect.Effect<void>
  /** The running release was switched to and has not been welcomed yet. */
  readonly onProbation: () => boolean
}

export const MAX_MANIFEST_BYTES = 64 * 1024
/** Upper bound for any bundle, whatever the manifest says (a 30 MB bundle would be a build mistake). */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024

export const makeUpdater = (options: UpdaterOptions): Updater => {
  const dir = options.releasesDir
  const now = options.now ?? Date.now
  const platform = options.platform ?? `linux-${arch()}`
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const hinted = new Set<string>()
  const hint = (key: string, line: string) => {
    if (hinted.has(key)) return
    hinted.add(key)
    options.log(line)
  }
  let probation = readState(dir).pending?.sha256 === options.runningSha

  const notes = (manifest: Manifest) => {
    const pinned = (manifest.runtime as Record<string, unknown>)[platform] !== undefined ? manifest.runtime.version : undefined
    if (pinned !== undefined && pinned !== nodeVersion) {
      hint(`runtime:${pinned}`, `the server pins Node ${pinned}, this node runs ${nodeVersion}; run install.sh --upgrade-runtime on this box to change it`)
    }
    if (options.bootPath !== undefined) {
      try {
        if (sha256Hex(readFileSync(options.bootPath)) !== manifest.boot.sha256) {
          hint(`boot:${manifest.boot.sha256}`, `the server has another boot guard than ${options.bootPath}; run install.sh again on this box to install it`)
        }
      } catch {
        // unreadable: nothing to compare
      }
    }
  }

  const check: Effect.Effect<CheckResult> = Effect.gen(function*() {
    const url = manifestUrl(options.server)
    const manifest = yield* options.fetch(url, { maxBytes: MAX_MANIFEST_BYTES, timeoutMs: options.manifestTimeoutMs ?? 5000 }).pipe(
      Effect.flatMap(decodeManifest)
    )
    notes(manifest)
    const target = manifest.bundle.sha256
    if (target === options.runningSha) return { _tag: "UpToDate" } as const
    if (readState(dir).bad.includes(target)) {
      hint(`bad:${target}`, `the server's bundle ${target.slice(0, 12)} (${manifest.version}) was rolled back on this node before; staying on ${options.runningSha.slice(0, 12)}`)
      return { _tag: "Skipped", sha256: target } as const
    }
    if (manifest.bundle.bytes > MAX_BUNDLE_BYTES) {
      return yield* new UpdateError({ message: `the manifest announces a ${manifest.bundle.bytes}-byte bundle (at most ${MAX_BUNDLE_BYTES})`, unreachable: false })
    }
    options.log(`the server has ${manifest.version} (${target.slice(0, 12)}); downloading it`)
    const bytes = yield* options.fetch(new URL(manifest.bundle.path, url), {
      maxBytes: manifest.bundle.bytes,
      timeoutMs: options.bundleTimeoutMs ?? 120_000
    })
    if (bytes.length !== manifest.bundle.bytes) {
      return yield* new UpdateError({ message: `the bundle has ${bytes.length} bytes, the manifest says ${manifest.bundle.bytes}`, unreachable: false })
    }
    yield* Effect.try({
      try: () => installRelease(dir, target, bytes, now()),
      catch: (e) => new UpdateError({ message: e instanceof ReleaseInstallError ? e.message : `cannot store the new release: ${(e as Error).message}`, unreachable: false })
    })
    options.log(`switched to ${manifest.version} (${target.slice(0, 12)}); restarting`)
    return { _tag: "Switched", from: options.runningSha, to: target, version: manifest.version } as const
  }).pipe(
    Effect.catch((e: UpdateError) =>
      Effect.sync((): CheckResult => {
        if (!e.unreachable) {
          options.log(`update refused: ${e.message}`)
          try {
            recordError(dir, `update refused: ${e.message}`, now())
          } catch {
            // the state file is best effort
          }
        }
        return { _tag: "Failed", message: e.message, unreachable: e.unreachable }
      })
    )
  )

  const welcomed = Effect.sync(() => {
    if (!probation) return
    probation = false
    try {
      if (confirmRelease(dir, options.runningSha)) options.log(`release ${options.runningSha.slice(0, 12)} confirmed`)
    } catch (e) {
      options.log(`cannot confirm the release: ${(e as Error).message}`)
    }
  })

  return { check, welcomed, onProbation: () => probation }
}

/** The updater for this process, or why there is none. */
export const updaterFor = (server: string, tlsPin: string | undefined, log: (line: string) => void, install: InstallInfo = detectInstall()):
  | { readonly updater: Updater }
  | { readonly reason: string } =>
{
  if (install._tag === "Dev") return { reason: "running from source" }
  if (install._tag === "NotInstalled") return { reason: "not running from an installed release" }
  if (!isSha256(install.sha256)) return { reason: "no bundle hash" }
  return {
    updater: makeUpdater({
      server,
      releasesDir: install.releasesDir,
      runningSha: install.sha256,
      fetch: httpFetch(tlsPin),
      log,
      bootPath: install.bootPath
    })
  }
}
