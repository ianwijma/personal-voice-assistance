/**
 * Pairing (docs/VOICE-NODES.md §5.5, §6.1, §8): `pva-node pair --server <url> --code <code>` redeems an admin-issued
 * code with `POST <server>/node/pair` (`NodePairRequest` / `NodePairAnswer` of `@pva/protocol`) and writes
 * `node.json` with the device id and credential it gets back. install.sh runs it. A protocol 12 server refuses a node
 * that was not paired, so this is the only way to a working config.
 *
 * The code is a secret for ten minutes: with a `tlsPin`, the server's key is checked before the body is sent.
 */
import { readFileSync } from "node:fs"
import * as http from "node:http"
import * as https from "node:https"
import { arch, hostname } from "node:os"
import type { TLSSocket } from "node:tls"
import { type NodePairRequest, NodePairAnswer, type NodePlatform } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { ConfigError, type NodeConfig, NodeConfig as NodeConfigSchema, writeConfig } from "./config.ts"
import { nodeBaseUrl, NODE_VERSION, parseTlsPin, peerKeySha256 } from "./update.ts"

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

/** A sentence for a refused `POST /node/pair` (§5.5): `403 bad_code | expired`, `429`, `503`, `400`, or something else. */
export const refusal = (status: number, json: unknown): string => {
  const body = typeof json === "object" && json !== null ? json as { error?: unknown; retryAfterMs?: unknown } : {}
  const error = typeof body.error === "string" ? body.error : `HTTP ${status}`
  switch (error) {
    case "bad_code":
      return "the code is wrong or was already used"
    case "expired":
      return "the code has expired; make a new one in admin"
    case "rate_limited": {
      const seconds = typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs) ? Math.max(1, Math.ceil(body.retryAfterMs / 1000)) : undefined
      return `too many wrong codes: try again${seconds !== undefined ? ` in ${seconds} s` : " later"}`
    }
    case "admin_disabled":
      return "the server has no admin (PVA_ADMIN_PASSWORD is not set), so it cannot pair nodes"
    case "unavailable":
      return "the server cannot save the new node right now; try again in a moment"
    case "bad_request":
      return "the server did not accept the request (bad_request); is this pva-node as new as the assistant?"
    case "bad_origin":
      return "the server refused the request (bad_origin)"
    default:
      return status === 404 ? "the server does not offer pairing (/node/pair); update the assistant" : error
  }
}

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
    const request: NodePairRequest = { code, hostname: platform.hostname, platform, version: NODE_VERSION.slice(0, 64) }
    const { status, json } = yield* postJson(pairUrl(options.server), request, options.tlsPin)
    if (status !== 200) return yield* new ConfigError({ message: `pairing failed: ${refusal(status, json)}` })
    const answer = yield* Schema.decodeUnknownEffect(NodePairAnswer)(json).pipe(
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
