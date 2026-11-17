/**
 * The mock's voice nodes (protocol 9, docs/VOICE-NODES.md §5, §6.1, §7.4): the pairing settings the server would
 * report, one-time codes, the node records a redeemed code makes, and the three sample nodes of the `nodes` scenario
 * (online and up to date; online with "Update pending" on plain `ws`; offline with a last error). No socket here: the
 * server (`server.ts`) answers the messages and stands in for the boxes (a sample node is "online" without a socket).
 */
import { randomBytes } from "node:crypto"
import { type DeviceCapabilities, type NodeInfo, type NodePairing, type NodePlatform, type NodeStatusBody, VOICE_NODE_KIND } from "@pva/protocol"
import { exampleNodeCapabilities, exampleNodeHello, exampleNodePairing, exampleNodeStatus } from "@pva/protocol/examples"

/** What `node.pair.create` reports about the server, and how the mock plays the box (POST /mock/nodes changes it). */
export interface PairingConfig {
  /** The server serves https/wss itself (with `tlsPin`). */
  tls: boolean
  tlsPin: string | undefined
  /** SERVE_HOST is a loopback address. */
  loopbackOnly: boolean
  /** `false`: apps/node/dist is not built (`pairing.bundle: null`). */
  built: boolean
  /** The box redeems the code by itself this long after it was made; 0: only POST /mock/node/redeem does. */
  redeemAfterMs: number
  /** How long a code lives (10 minutes on the real server). */
  ttlMs: number
  /** The host name the box pairs with (its name when the admin gave none). */
  hostname: string
  /** How the box connects after pairing. */
  transport: "ws" | "wss"
}

export const defaultPairingConfig = (): PairingConfig => ({
  tls: false,
  tlsPin: undefined,
  loopbackOnly: false,
  built: true,
  redeemAfterMs: 2000,
  ttlMs: 10 * 60_000,
  hostname: "raspberrypi",
  transport: "ws"
})

/** The release the server has (`pairing.bundle`, and what an up-to-date node runs). */
export const BUNDLE = exampleNodePairing.bundle!

export interface NodeRecord {
  id: string
  kind: string
  name: string
  firstSeen: number
  lastSeen: number
  node: NodeInfo
  capabilities: DeviceCapabilities
  /** Online without a socket: the mock stands in for the box. */
  virtual: boolean
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** 40 random bits as 8 Crockford base32 characters, as the server makes them. */
export const newPairCode = (): string => {
  const bytes = randomBytes(5)
  let bits = 0n
  for (const b of bytes) bits = (bits << 8n) | BigInt(b)
  let out = ""
  for (let i = 0; i < 8; i++) {
    out = CROCKFORD[Number(bits & 31n)]! + out
    bits >>= 5n
  }
  return out
}

/** `vn-` + 16 base64url characters. */
export const newNodeId = (): string => `vn-${randomBytes(12).toString("base64url")}`

export const pairingOf = (config: PairingConfig, code: string, expiresAt: number, replace?: string): NodePairing => ({
  code,
  expiresAt,
  ...(replace !== undefined ? { replace } : {}),
  tls: config.tls,
  ...(config.tls && config.tlsPin !== undefined ? { tlsPin: config.tlsPin } : {}),
  loopbackOnly: config.loopbackOnly,
  bundle: config.built ? { ...BUNDLE } : null
})

const status = (s: NodeStatusBody): NodeStatusBody => structuredClone(s)

/** What a freshly paired box reports (a Raspberry Pi with a USB speakerphone, as the protocol's example). */
export const pairedNodeInfo = (config: PairingConfig, now: number): NodeInfo => {
  const { missingTools: _none, lastError: _clean, ...healthy } = exampleNodeStatus
  return {
    pairedAt: now,
    version: BUNDLE.version,
    bundleSha256: BUNDLE.sha256,
    upToDate: true,
    platform: { ...exampleNodeHello.platform, hostname: config.hostname },
    status: status({ ...healthy, inputs: [...healthy.inputs], outputs: [...healthy.outputs] }),
    transport: config.transport
  }
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const OLD_BUNDLE = "0f9e8d7c6b5a49382716051a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e"
const LIVING_INPUT_GONE = "alsa_input.usb-Anker_PowerConf-00.mono-fallback"

/** The `nodes` scenario's three boxes. */
export const seedNodes = (now: number): Array<NodeRecord> => {
  const kitchen: NodePlatform = { ...exampleNodeHello.platform }
  const { missingTools: _none, lastError: _clean, ...healthy } = exampleNodeStatus
  return [
    {
      id: "vn-kitchen-speaker01",
      kind: VOICE_NODE_KIND,
      name: "Kitchen speaker",
      firstSeen: now - 6 * DAY,
      lastSeen: now,
      virtual: true,
      capabilities: structuredClone(exampleNodeCapabilities),
      node: {
        pairedAt: now - 6 * DAY,
        version: BUNDLE.version,
        bundleSha256: BUNDLE.sha256,
        upToDate: true,
        platform: kitchen,
        status: status({ ...healthy, inputs: [...healthy.inputs], outputs: [...healthy.outputs] }),
        transport: "wss"
      }
    },
    {
      id: "vn-living-room-nuc2",
      kind: VOICE_NODE_KIND,
      name: "Living room",
      firstSeen: now - 20 * DAY,
      lastSeen: now,
      virtual: true,
      capabilities: structuredClone(exampleNodeCapabilities),
      node: {
        pairedAt: now - 20 * DAY,
        version: "0.0.9+0f9e8d7c6b",
        bundleSha256: OLD_BUNDLE,
        upToDate: false,
        platform: { os: "linux", arch: "x64", hostname: "living-room-nuc", model: "Intel NUC7i3BNH" },
        status: {
          backend: "pipewire",
          inputs: [
            { id: "alsa_input.usb-Jabra_SPEAK_510-00.mono-fallback", name: "Jabra SPEAK 510", isDefault: true },
            { id: "alsa_input.pci-0000_00_1f.3.analog-stereo", name: "Built-in Audio Analog Stereo", isDefault: false }
          ],
          outputs: [
            { id: "alsa_output.usb-Jabra_SPEAK_510-00.analog-stereo", name: "Jabra SPEAK 510", isDefault: true },
            { id: "alsa_output.pci-0000_00_1f.3.hdmi-stereo", name: "HDMI / DisplayPort", isDefault: false }
          ],
          input: { opened: "alsa_input.usb-Jabra_SPEAK_510-00.mono-fallback", sampleRate: 16_000 },
          output: { opened: "alsa_output.usb-Jabra_SPEAK_510-00.analog-stereo" },
          lastError: { message: `Could not open ${LIVING_INPUT_GONE}; using the default device.`, at: now - 40 * MIN }
        },
        transport: "ws"
      }
    },
    {
      id: "vn-garage-pi-zero03",
      kind: VOICE_NODE_KIND,
      name: "Garage",
      firstSeen: now - 3 * DAY,
      lastSeen: now - 3 * HOUR,
      virtual: false,
      capabilities: structuredClone(exampleNodeCapabilities),
      node: {
        pairedAt: now - 3 * DAY,
        version: BUNDLE.version,
        bundleSha256: BUNDLE.sha256,
        upToDate: true,
        platform: { os: "linux", arch: "arm64", hostname: "garage-pi", model: "Raspberry Pi Zero 2 W Rev 1.0" },
        status: {
          backend: "alsa",
          inputs: [],
          outputs: [{ id: "plughw:CARD=Headphones,DEV=0", name: "bcm2835 Headphones", isDefault: true }],
          output: { opened: "plughw:CARD=Headphones,DEV=0" },
          missingTools: ["arecord"],
          lastError: { message: "No microphone: arecord is not installed.", at: now - 3 * HOUR - 2 * MIN }
        },
        transport: "wss"
      }
    }
  ]
}

/** The sample nodes' own settings: the living room keeps a microphone that is unplugged now. */
export const seedNodeOwn = (): ReadonlyArray<{ readonly id: string; readonly settings: Record<string, unknown> }> => [
  { id: "vn-living-room-nuc2", settings: { soundDevices: { input: LIVING_INPUT_GONE, output: "" }, sound: { volume: 60, cues: true } } }
]

/** The `nodes` scenario's Every voice node, as the owner left it after the seeding: Jeff and T3, each by its phrase. */
export const seedNodeType = {
  assistants: [{ assistant: "jeff", phrases: ["Hey Jeff"] }, { assistant: "t3", phrases: ["Hey T3"] }],
  withoutPhrase: { mode: "nobody" as const },
  matching: "close" as const
}

/** `name`, or with " 2", " 3" … when another device has it. */
export const uniqueName = (name: string, taken: ReadonlyArray<string>): string => {
  if (!taken.includes(name)) return name
  for (let i = 2; ; i++) if (!taken.includes(`${name} ${i}`)) return `${name} ${i}`
}
