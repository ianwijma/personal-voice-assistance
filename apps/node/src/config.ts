/**
 * The node's own file, `/etc/pva-node/node.json` (docs/VOICE-NODES.md §2, §7.1): where the server is and who this
 * node is. Everything else (wake phrases, voice, volume, audio devices) comes from the server's profile.
 *
 * WP-3 (protocol 5): `credential` and `tlsPin` are read and kept but not used yet. WP-10 sends the credential in
 * `hello.node` and makes it required; `pair --code` (WP-10) writes this file with `writeConfig`.
 */
import { chmod, readFile, rename, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { DeviceId, DeviceName, MAX_DEVICE_NAME_CHARS, WS_PATH } from "@pva/protocol"
import { Effect, Schema } from "effect"

export const DEFAULT_CONFIG_PATH = "/etc/pva-node/node.json"

export const NodeConfig = Schema.Struct({
  /** The assistant server: `http(s)://host:port` (as admin shows it) or a `ws(s)://…/ws` URL. */
  server: Schema.String.check(Schema.isPattern(/^(https?|wss?):\/\/[^\s/]+/)),
  deviceId: DeviceId,
  /** Suggested device name for `hello` (the server keeps the admin-set name for a paired node). Default: hostname. */
  name: Schema.optionalKey(DeviceName),
  /** The node credential from pairing (WP-10 sends it; unused on protocol 5). */
  credential: Schema.optionalKey(Schema.String),
  /** `sha256:<hex>` of a self-signed server certificate (WP-10; unused on protocol 5). */
  tlsPin: Schema.optionalKey(Schema.String)
})
export type NodeConfig = typeof NodeConfig.Type

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String
}) {}

const decode = Schema.decodeUnknownEffect(NodeConfig)

export const parseConfig = (text: string, path = "node.json"): Effect.Effect<NodeConfig, ConfigError> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => new ConfigError({ message: `${path} is not valid JSON` })
  }).pipe(
    Effect.flatMap((json) =>
      decode(json).pipe(Effect.mapError((e) => new ConfigError({ message: `${path} is not a valid node config: ${e.message}` })))
    )
  )

export const readConfig = (path: string): Effect.Effect<NodeConfig, ConfigError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new ConfigError({ message: `cannot read ${path}: ${(cause as Error).message}` })
  }).pipe(Effect.flatMap((text) => parseConfig(text, path)))

/** Write atomically with mode 0600 (it holds the credential). */
export const writeConfig = (path: string, config: NodeConfig): Effect.Effect<void, ConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(Schema.encodeSync(NodeConfig)(config), null, 2)}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, path)
    },
    catch: (cause) => new ConfigError({ message: `cannot write ${path}: ${(cause as Error).message}` })
  })

/** The WebSocket URL for `server`: `http` → `ws`, `https` → `wss`, `/ws` added when the URL has no path. */
export const webSocketUrl = (server: string): string => {
  const url = new URL(server)
  if (url.protocol === "http:") url.protocol = "ws:"
  else if (url.protocol === "https:") url.protocol = "wss:"
  if (url.pathname === "" || url.pathname === "/") url.pathname = WS_PATH
  return url.toString()
}

/** A device id for development runs without a config file: stable per host, so the server sees one device. */
export const defaultDeviceId = (host = hostname()): string => {
  const cleaned = host.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 50)
  return `node-${cleaned}`.padEnd(8, "0")
}

export const defaultDeviceName = (host = hostname()): string => {
  const name = host.trim().slice(0, MAX_DEVICE_NAME_CHARS)
  return name === "" ? "Voice node" : name
}
