import { Schema } from "effect"
import { RequestId } from "./common.ts"
import { DeviceId, DeviceName } from "./frontends.ts"

/**
 * Voice nodes (docs/VOICE-NODES.md §3, §5; protocol 9): headless speaker-and-microphone boxes, paired once with a
 * code and then connecting with a credential. Schemas for the node's `hello`, its status and level messages, the
 * admin's pairing and command messages, the `/node/*` HTTP bodies and the release manifest. Browser-safe.
 */

/** The device kind a voice node reports. */
export const VOICE_NODE_KIND = "voice-node"

/** SHA-256 as 64 lower-case hex characters. */
export const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export type Hex64 = typeof Hex64.Type

/** The secret a node presents in `hello.node.credential`: 32 random bytes, 43 base64url characters. */
export const NodeCredential = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/))
export type NodeCredential = typeof NodeCredential.Type

/** A pairing code as typed on the box: 8 Crockford base32 characters, upper case, no dash. */
export const NodePairCode = Schema.String.check(Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{8}$/))
export type NodePairCode = typeof NodePairCode.Type

// -- Settings sections a node adds (§3.2) ----------------------------------------------------------------------------

export const NodeSound = Schema.Struct({
  /** 0..100; the node applies a software gain of (volume / 100)². */
  volume: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** Wake and lapse cues on / off (identify always plays). */
  cues: Schema.Boolean
})
export type NodeSound = typeof NodeSound.Type

/** `""` = the backend's default device; else an ALSA `plughw:CARD=…,DEV=0` or a PipeWire `node.name`. */
export const NodeSoundDevices = Schema.Struct({
  input: Schema.String.check(Schema.isMaxLength(200)),
  output: Schema.String.check(Schema.isMaxLength(200))
})
export type NodeSoundDevices = typeof NodeSoundDevices.Type

// -- hello.node (§5.2) -----------------------------------------------------------------------------------------------

export const NodePlatform = Schema.Struct({
  os: Schema.Literal("linux"),
  arch: Schema.Literals(["arm64", "x64", "arm"]),
  hostname: Schema.String.check(Schema.isMaxLength(64)),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120)))
})
export type NodePlatform = typeof NodePlatform.Type

/** `hello.node`: required when the device is a node. */
export const NodeHello = Schema.Struct({
  credential: NodeCredential,
  /** `"<package version>+<10-char git sha>[.dirty][.<label>]"`, or `"dev"`. */
  version: Schema.String.check(Schema.isMaxLength(64)),
  /** The running release; absent when run from source. */
  bundleSha256: Schema.optionalKey(Hex64),
  platform: NodePlatform
})
export type NodeHello = typeof NodeHello.Type

// -- Status and levels (§5.3) ----------------------------------------------------------------------------------------

export const AudioDeviceInfo = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(200)),
  name: Schema.String.check(Schema.isMaxLength(120)),
  isDefault: Schema.Boolean
})
export type AudioDeviceInfo = typeof AudioDeviceInfo.Type

/** The fields of `node.status` without its `type` (also `NodeInfo.status`). */
export const NodeStatusBody = Schema.Struct({
  backend: Schema.Literals(["pipewire", "alsa", "file"]),
  inputs: Schema.Array(AudioDeviceInfo).check(Schema.isMaxLength(64)),
  outputs: Schema.Array(AudioDeviceInfo).check(Schema.isMaxLength(64)),
  input: Schema.optionalKey(Schema.Struct({
    opened: Schema.String.check(Schema.isMaxLength(200)),
    sampleRate: Schema.Int
  })),
  output: Schema.optionalKey(Schema.Struct({ opened: Schema.String.check(Schema.isMaxLength(200)) })),
  missingTools: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(8))),
  lastError: Schema.optionalKey(Schema.Struct({
    message: Schema.String.check(Schema.isMaxLength(500)),
    at: Schema.Finite
  }))
})
export type NodeStatusBody = typeof NodeStatusBody.Type

/** Node → server, after `welcome` and on any change (at most once a second). Not from a connection that is not a node: `bad_message`. */
export const NodeStatus = Schema.Struct({
  type: Schema.Literal("node.status"),
  ...NodeStatusBody.fields
})
export type NodeStatus = typeof NodeStatus.Type

/** Node → server, 5 a second, only while a `test-mic` runs. */
export const NodeLevel = Schema.Struct({
  type: Schema.Literal("node.level"),
  rmsDbfs: Schema.Finite,
  peakDbfs: Schema.Finite
})
export type NodeLevel = typeof NodeLevel.Type

// -- Commands (§5.3) -------------------------------------------------------------------------------------------------

export const NodeCommandName = Schema.Literals(["identify", "test-speaker", "test-mic", "restart", "update"])
export type NodeCommandName = typeof NodeCommandName.Type

/** Server → node. */
export const NodeCommand = Schema.Struct({
  type: Schema.Literal("node.command"),
  command: NodeCommandName,
  durationMs: Schema.optionalKey(Schema.Int)
})
export type NodeCommand = typeof NodeCommand.Type

/** Admin only: `unknown_device` when the id is not a node or has no connection; `result { ok }` when sent. */
export const NodeCommandSend = Schema.Struct({
  type: Schema.Literal("node.command.send"),
  requestId: RequestId,
  id: DeviceId,
  command: NodeCommandName,
  durationMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 30_000 })))
})
export type NodeCommandSend = typeof NodeCommandSend.Type

// -- Pairing (§5.3) --------------------------------------------------------------------------------------------------

/**
 * Admin only. `replace`: pair again into an existing node record (keeps its settings; the old credential stops
 * working when the code is redeemed). Answered with `result { ok, pairing }`.
 */
export const NodePairCreate = Schema.Struct({
  type: Schema.Literal("node.pair.create"),
  requestId: RequestId,
  name: Schema.optionalKey(DeviceName),
  replace: Schema.optionalKey(DeviceId)
})
export type NodePairCreate = typeof NodePairCreate.Type

/** Admin only. */
export const NodePairCancel = Schema.Struct({
  type: Schema.Literal("node.pair.cancel"),
  requestId: RequestId,
  code: Schema.String
})
export type NodePairCancel = typeof NodePairCancel.Type

/** Server → admin only: the code was redeemed. */
export const NodePaired = Schema.Struct({
  type: Schema.Literal("node.paired"),
  code: Schema.String,
  deviceId: DeviceId,
  name: DeviceName
})
export type NodePaired = typeof NodePaired.Type

/** Server → admin only: a relayed `node.level` during a `test-mic`. */
export const NodeMeter = Schema.Struct({
  type: Schema.Literal("node.meter"),
  deviceId: DeviceId,
  rmsDbfs: Schema.Finite,
  peakDbfs: Schema.Finite
})
export type NodeMeter = typeof NodeMeter.Type

/** `result.pairing`: what the Add voice node dialog shows. */
export const NodePairing = Schema.Struct({
  /** 8 Crockford characters, no dash (`"K7QM2XHP"`); the page shows `K7QM-2XHP`. */
  code: Schema.String,
  /** Epoch ms. */
  expiresAt: Schema.Finite,
  replace: Schema.optionalKey(DeviceId),
  /** The server itself serves https/wss. */
  tls: Schema.Boolean,
  /** `"sha256:<64 hex>"` of `SERVE_TLS_CERT`'s SPKI; present when `tls`. */
  tlsPin: Schema.optionalKey(Schema.String),
  /** `SERVE_HOST` is a loopback address: nodes cannot reach it. */
  loopbackOnly: Schema.Boolean,
  /** `null`: `apps/node/dist` is not built. */
  bundle: Schema.NullOr(Schema.Struct({ version: Schema.String, sha256: Hex64 }))
})
export type NodePairing = typeof NodePairing.Type

/** What admin knows about a node (`DeviceListInfo.node`). */
export const NodeInfo = Schema.Struct({
  /** Epoch ms. */
  pairedAt: Schema.Finite,
  version: Schema.optionalKey(Schema.String),
  bundleSha256: Schema.optionalKey(Hex64),
  /** `hello.node.bundleSha256` equals the manifest's bundle; absent when from source or no bundle is built. */
  upToDate: Schema.optionalKey(Schema.Boolean),
  platform: Schema.optionalKey(NodePlatform),
  /** The last `node.status`, kept after a disconnect until the server restarts. */
  status: Schema.optionalKey(NodeStatusBody),
  /** As the server sees the connection. */
  transport: Schema.optionalKey(Schema.Literals(["ws", "wss"]))
})
export type NodeInfo = typeof NodeInfo.Type

// -- HTTP `/node/*` (§5.5; not part of the WebSocket protocol) -------------------------------------------------------

/** `POST /node/pair`, JSON, at most 4 KiB. */
export const NodePairRequest = Schema.Struct({
  code: NodePairCode,
  hostname: Schema.String.check(Schema.isMaxLength(64)),
  platform: NodePlatform,
  version: Schema.String.check(Schema.isMaxLength(64))
})
export type NodePairRequest = typeof NodePairRequest.Type

/** `200` answer of `POST /node/pair`. */
export const NodePairAnswer = Schema.Struct({
  deviceId: DeviceId,
  credential: NodeCredential,
  name: DeviceName
})
export type NodePairAnswer = typeof NodePairAnswer.Type

/** `/node/manifest.json` (moved from `apps/node/src/update.ts`, unchanged). */
export const NODE_MANIFEST_FORMAT = 1
/** A file next to the manifest. `path` is resolved against the manifest's URL. */
export const NodeArtifact = Schema.Struct({
  path: Schema.String,
  sha256: Hex64,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
})
const NodeRuntimePin = Schema.Struct({ url: Schema.String, sha256: Hex64 })

export const NodeManifest = Schema.Struct({
  format: Schema.Literal(NODE_MANIFEST_FORMAT),
  /** `PROTOCOL_VERSION` of the bundle. */
  protocol: Schema.Int,
  version: Schema.String,
  builtAt: Schema.optionalKey(Schema.String),
  /** `pva-node.mjs`: what the node runs. */
  bundle: NodeArtifact,
  /** `pva-node-boot.mjs`: the boot guard (installed by install.sh, never by the node). */
  boot: NodeArtifact,
  /** `install.sh`, for admin's command and for checking a downloaded copy. */
  installer: Schema.optionalKey(NodeArtifact),
  /** The pinned Node runtime (`scripts/runtime.json`). */
  runtime: Schema.Struct({ version: Schema.String, "linux-arm64": NodeRuntimePin, "linux-x64": NodeRuntimePin })
})
export type NodeManifest = typeof NodeManifest.Type
