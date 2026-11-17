import type { AudioDeviceInfo, DeviceCapabilities, DeviceListInfo, DeviceTypeInfo, NodeInfo, NodePlatform } from "@pva/protocol"
import { VOICE_NODE_KIND } from "@pva/protocol"

/**
 * Voice nodes in admin (docs/VOICE-NODES.md §7), as pure functions: the pairing code and the install command of the
 * Add voice node dialog, and the words the Devices list and a node's page use for its status. No React, no network.
 */

export const isNodeKind = (kind: string | undefined): boolean => kind === VOICE_NODE_KIND
export const isNodeType = (type: Pick<DeviceTypeInfo, "kind"> | undefined): boolean => isNodeKind(type?.kind)

// ---- The pairing code

/** "K7QM2XHP" → "K7QM-2XHP": how the page shows it (the box takes it with or without the dash). */
export const formatPairCode = (code: string): string => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code)

/** What is left of the code, "9:05"; "0:00" once it has expired. */
export const countdownText = (msLeft: number): string => {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

// ---- The server address the node uses

/** A host name a box cannot reach this server at: it would be the box itself. */
export const isLoopbackHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

export type ServerAddress =
  | { readonly ok: true; readonly url: string; readonly secure: boolean; readonly loopback: boolean }
  | { readonly ok: false; readonly message: string }

/** The address as typed → its origin (`https://assistant.home:8443`), or what is wrong with it. */
export const parseServerAddress = (text: string): ServerAddress => {
  const t = text.trim()
  if (t === "") return { ok: false, message: "Type the address the box uses to reach this server." }
  if (!/^https?:\/\//i.test(t)) return { ok: false, message: "Start with http:// or https://." }
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return { ok: false, message: "This is not an address." }
  }
  if (u.hostname === "") return { ok: false, message: "This is not an address." }
  return { ok: true, url: u.origin, secure: u.protocol === "https:", loopback: isLoopbackHost(u.hostname) }
}

/** The page's own server as the box would see it: the WebSocket address the page uses, as http(s). */
export const serverOriginOf = (wsUrl: string, fallback: string): string => {
  try {
    const u = new URL(wsUrl)
    if (u.protocol === "ws:" || u.protocol === "wss:") return `${u.protocol === "wss:" ? "https" : "http"}://${u.host}`
  } catch {
    // fall through
  }
  return fallback
}

// ---- TLS pins

const HEX64 = /^[0-9a-f]{64}$/

const hexToBase64 = (hex: string): string => {
  let bin = ""
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
  return btoa(bin)
}

const base64ToHex = (b64: string): string | undefined => {
  try {
    const bin = atob(b64)
    if (bin.length !== 32) return undefined
    return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
  } catch {
    return undefined
  }
}

/** `"sha256:<hex>"` → the base64 digest curl's `--pinnedpubkey sha256//…` takes. */
export const pinBase64 = (pin: string): string | undefined => {
  const hex = pin.replace(/^sha256:/i, "").toLowerCase()
  return HEX64.test(hex) ? hexToBase64(hex) : undefined
}

/**
 * A pin as pasted (the SPKI SHA-256 of the certificate): `sha256:<hex>`, the hex alone (colons and spaces allowed, as
 * `openssl dgst` prints it), or curl's `sha256//<base64>` / the base64 alone → `"sha256:<hex>"`; undefined if it is none.
 */
export const parsePin = (text: string): string | undefined => {
  const t = text.trim().replace(/^SHA2?-?256(\(stdin\))?\s*=\s*/i, "")
  if (t === "") return undefined
  const hex = t.replace(/^sha256:/i, "").replace(/[:\s]/g, "").toLowerCase()
  if (HEX64.test(hex)) return `sha256:${hex}`
  const b64 = base64ToHex(t.replace(/^sha256\/\//i, ""))
  return b64 === undefined ? undefined : `sha256:${b64}`
}

// ---- The install command

/** A word for the shell: as is when it has nothing the shell would read, else in single quotes. */
const shellWord = (s: string): string => (/^[A-Za-z0-9._:/@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`)

/**
 * The command to run on the box (docs/VOICE-NODES.md §7.3): download the installer from this server and pair with
 * `code`. With an https address and a pin (`"sha256:<hex>"`) curl checks the certificate by the pin (`-k
 * --pinnedpubkey`) and the node is told the pin; otherwise curl checks it as usual (a public certificate).
 */
export const installCommand = (options: { readonly url: string; readonly code: string; readonly pin?: string | undefined }): string => {
  const url = shellWord(options.url)
  const installer = shellWord(`${options.url}/node/install.sh`)
  const b64 = options.url.startsWith("https:") && options.pin !== undefined ? pinBase64(options.pin) : undefined
  if (b64 !== undefined) {
    const hex = options.pin!.replace(/^sha256:/i, "").toLowerCase()
    return `curl -fsSL -k --pinnedpubkey 'sha256//${b64}' ${installer} | sudo sh -s -- --server ${url} --tls-pin sha256:${hex} --code ${options.code}`
  }
  return `curl -fsSL ${installer} | sudo sh -s -- --server ${url} --code ${options.code}`
}

// ---- Status words

/** Whether a device is a node that runs an older release than the server has. */
export const updatePending = (node: NodeInfo | undefined): boolean => node?.upToDate === false
export const unencrypted = (node: NodeInfo | undefined): boolean => node?.transport === "ws"
/**
 * The node is connected and said it runs no release bundle (`pva-node` from a checkout). Only while it is connected:
 * the running bundle is known from its hello, so a node that is offline (just paired, or since the server restarted)
 * has no `bundleSha256` without running from source.
 */
export const runsFromSource = (d: Pick<DeviceListInfo, "connections" | "node">): boolean =>
  d.connections > 0 && d.node?.version !== undefined && d.node.upToDate === undefined && d.node.bundleSha256 === undefined

/** "Offline since 14:02" today; "Offline since 12 Nov" before; with the year when it is another year. */
export const offlineSinceText = (lastSeen: number, now: number): string => {
  const at = new Date(lastSeen)
  const today = new Date(now)
  if (at.toDateString() === today.toDateString()) return `Offline since ${at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
  return `Offline since ${at.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(at.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) })}`
}

/** "Online", or when it went away. */
export const nodeOnlineText = (d: Pick<DeviceListInfo, "connections" | "lastSeen">, now: number): string => (d.connections > 0 ? "Online" : offlineSinceText(d.lastSeen, now))

/** "Raspberry Pi 4 Model B · Linux arm64 · host kitchen-pi". */
export const platformText = (p: NodePlatform): string => [p.model, `Linux ${p.arch}`, `host ${p.hostname}`].filter((x): x is string => x !== undefined && x !== "").join(" · ")

/** "Speaks, listens; no screen" from what the device declared. */
export const capabilitiesText = (c: DeviceCapabilities | undefined): string | undefined => {
  if (c === undefined) return undefined
  const can = [c.speaker !== undefined ? "speaks" : undefined, c.microphone !== undefined ? "listens" : undefined].filter((x): x is string => x !== undefined)
  const text = `${can.length === 0 ? "nothing it says" : can.join(", ")}; no screen`
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const TOOL_PACKAGES: Readonly<Record<string, string>> = { arecord: "alsa-utils", aplay: "alsa-utils", "pw-record": "pipewire-bin", "pw-play": "pipewire-bin", "pw-cat": "pipewire-bin" }

/** What to install on the box for a missing tool: "arecord" → "alsa-utils". */
export const packageFor = (tool: string): string => TOOL_PACKAGES[tool] ?? tool

export const BACKEND_NAMES = { pipewire: "PipeWire", alsa: "ALSA", file: "Files (test)" } as const

// ---- Sound devices

export interface SoundOption {
  readonly value: string
  readonly label: string
}

/**
 * The choices of a Sound devices select: "System default" (`""`), each device the node(s) reported, and a stored id
 * that is not among them, marked "(not connected)" so it stays selected and is not lost by saving.
 */
export const soundDeviceOptions = (list: ReadonlyArray<AudioDeviceInfo>, stored: string): ReadonlyArray<SoundOption> => {
  const seen = new Set<string>()
  const unique = list.filter((d) => (d.id === "" || seen.has(d.id) ? false : (seen.add(d.id), true)))
  const fallback = unique.find((d) => d.isDefault)
  return [
    { value: "", label: fallback !== undefined ? `System default (${fallback.name})` : "System default" },
    ...unique.map((d) => ({ value: d.id, label: d.name === d.id || d.name === "" ? d.id : `${d.name} · ${d.id}` })),
    ...(stored !== "" && !seen.has(stored) ? [{ value: stored, label: `${stored} (not connected)` }] : [])
  ]
}

/** The devices to choose from on a node's page (its last status), or on Every voice node (every node's, together). */
export const reportedSoundDevices = (nodes: ReadonlyArray<Pick<DeviceListInfo, "node">>, which: "inputs" | "outputs"): ReadonlyArray<AudioDeviceInfo> | undefined => {
  const statuses = nodes.flatMap((d) => (d.node?.status !== undefined ? [d.node.status] : []))
  if (statuses.length === 0) return undefined
  return statuses.flatMap((s) => s[which])
}
