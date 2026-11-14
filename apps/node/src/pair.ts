/**
 * Pairing (docs/VOICE-NODES.md §5.1): `pva-node pair --server <url> --code <code>` redeems an admin-issued code with
 * `POST <server>/node/pair` and writes `node.json` with the device id and credential it gets back. install.sh runs
 * it. Built in WP-4 because the installer needs it; WP-10 owns it from then on (the server side is WP-7).
 *
 * The code is a secret for ten minutes: with a `tlsPin`, the server's key is checked before the body is sent.
 */
import { readFileSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import { arch, hostname } from "node:os"
import type { TLSSocket } from "node:tls"
import { Effect, Schema } from "effect"
import { ConfigError, type NodeConfig, NodeConfig as NodeConfigSchema, writeConfig } from "./config.ts"
import { nodeBaseUrl, NODE_VERSION, parseTlsPin, peerKeySha256 } from "./update.ts"

/** `hello.node.platform` (§4.2). */
export interface NodePlatform {
  readonly os: "linux"
  readonly arch: "arm64" | "x64" | "arm"
  readonly hostname: string
  readonly model?: string
}

export const platformInfo = (): NodePlatform => {
  const a = arch()
  let model: string | undefined
  try {
    // Raspberry Pi and other device-tree boards: "Raspberry Pi 4 Model B Rev 1.4\0".
    model = readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim().slice(0, 120) || undefined
  } catch {
    model = undefined
  }
  return {
    os: "linux",
    arch: a === "arm64" ? "arm64" : a === "arm" ? "arm" : "x64",
    hostname: hostname().slice(0, 64),
    ...(model !== undefined ? { model } : {})
  }
}

/** Crockford base32, 8 characters, shown as `K7QM-2XHP`; spaces, dashes and case do not matter. */
export const normalizePairingCode = (code: string): string | undefined => {
  const cleaned = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(cleaned) ? cleaned : undefined
}

const PairResponse = Schema.Struct({ deviceId: Schema.String, credential: Schema.String, name: Schema.optionalKey(Schema.String) })

export const pairUrl = (server: string): URL => new URL("pair", nodeBaseUrl(server))

/** POST JSON and return the status and the parsed body. With a pin, the body is sent only after the key matched. */
export const postJson = (url: URL, body: unknown, tlsPin: string | undefined, timeoutMs = 15_000) =>
  Effect.callback<{ readonly status: number; readonly json: unknown }, ConfigError>((resume) => {
    const pin = parseTlsPin(tlsPin)
    const data = Buffer.from(JSON.stringify(body))
    let done = false
    const fail = (message: string) => {
      if (done) return
      done = true
      resume(Effect.fail(new ConfigError({ message: `${url.href}: ${message}` })))
    }
    const options = {
      method: "POST",
      agent: false as const,
      headers: { "content-type": "application/json", "content-length": String(data.length), "user-agent": `pva-node/${NODE_VERSION}` },
      timeout: timeoutMs
    }
    const onResponse = (res: http.IncomingMessage) => {
      const chunks: Array<Buffer> = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        if (done) return
        done = true
        let json: unknown = undefined
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          json = undefined
        }
        resume(Effect.succeed({ status: res.statusCode ?? 0, json }))
      })
    }
    const req = url.protocol === "https:"
      ? https.request(url, { ...options, ...(pin !== undefined ? { rejectUnauthorized: false } : {}) }, onResponse)
      : http.request(url, options, onResponse)
    req.on("error", (e) => fail(e.message))
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)))
    if (pin !== undefined && url.protocol === "https:") {
      req.on("socket", (socket) => {
        socket.once("secureConnect", () => {
          if (peerKeySha256(socket as TLSSocket) !== pin) {
            fail("the server's certificate does not match --tls-pin; nothing was sent")
            req.destroy()
          } else req.end(data)
        })
      })
    } else req.end(data)
    return Effect.sync(() => void req.destroy())
  })

export interface PairOptions {
  readonly server: string
  readonly code: string
  readonly configPath: string
  readonly tlsPin?: string | undefined
  readonly name?: string | undefined
}

/** Redeem the code and write the config (0600). Returns the config written. */
export const pair = (options: PairOptions): Effect.Effect<NodeConfig, ConfigError> =>
  Effect.gen(function*() {
    const code = normalizePairingCode(options.code)
    if (code === undefined) return yield* new ConfigError({ message: "a pairing code has 8 letters and digits, like K7QM-2XHP" })
    const platform = platformInfo()
    const { status, json } = yield* postJson(pairUrl(options.server), { code, hostname: platform.hostname, platform, version: NODE_VERSION }, options.tlsPin)
    if (status !== 200) {
      const error = typeof json === "object" && json !== null && "error" in json ? String((json as { error: unknown }).error) : `HTTP ${status}`
      const why = error === "bad_code"
        ? "the code is wrong or was already used"
        : error === "expired"
        ? "the code has expired; make a new one in admin"
        : error === "admin_disabled"
        ? "the server has no admin (PVA_ADMIN_PASSWORD is not set), so it cannot pair nodes"
        : status === 404
        ? "the server does not offer pairing (/node/pair); update the assistant"
        : error
      return yield* new ConfigError({ message: `pairing failed: ${why}` })
    }
    const answer = yield* Schema.decodeUnknownEffect(PairResponse)(json).pipe(
      Effect.mapError(() => new ConfigError({ message: "pairing failed: the server's answer is not a pairing result" }))
    )
    const name = options.name ?? answer.name
    const config = yield* Schema.decodeUnknownEffect(NodeConfigSchema)({
      server: options.server,
      deviceId: answer.deviceId,
      credential: answer.credential,
      ...(name !== undefined ? { name } : {}),
      ...(options.tlsPin !== undefined ? { tlsPin: options.tlsPin } : {})
    }).pipe(Effect.mapError((e) => new ConfigError({ message: `pairing failed: the server's answer does not make a valid config: ${e.message}` })))
    yield* writeConfig(options.configPath, config)
    return config
  })
