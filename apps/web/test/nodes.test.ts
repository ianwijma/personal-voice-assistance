import { describe, expect, it } from "vitest"
import { type DeviceListInfo, type DeviceTypeInfo, VOICE_NODE_DEVICE_TYPE, WEB_VOICE_DEVICE_TYPE } from "@pva/protocol"
import { exampleDevice, exampleNodeCapabilities, exampleNodePairing, exampleNodeStatus, nodeServerExamples, serverExamples } from "@pva/protocol/examples"
import { baseOfDevice, baseOfType, isOwn, patchOf, resetSection, sectionsOf, setKeys, settingsOf, noEdit } from "@/lib/devices.ts"
import {
  capabilitiesText,
  countdownText,
  formatPairCode,
  installCommand,
  isLoopbackHost,
  nodeOnlineText,
  packageFor,
  parsePin,
  parseServerAddress,
  pinBase64,
  platformText,
  reportedSoundDevices,
  serverOriginOf,
  soundDeviceOptions,
  unencrypted,
  updatePending
} from "@/lib/nodes.ts"
import { type Action, type ClientState, initialState, MAX_PAIRED_NODES, reducer } from "@/lib/state.ts"

// Voice nodes in admin (docs/VOICE-NODES.md §7): the reducer's node parts, the Add voice node dialog's code and install
// command, the status words, and which sections a node's page has.

const run = (actions: ReadonlyArray<Action>, from: ClientState = initialState) => actions.reduce(reducer, from)
const HEX = exampleNodePairing.tlsPin!.slice("sha256:".length)
const B64 = Buffer.from(HEX, "hex").toString("base64")

const nodeType: DeviceTypeInfo = {
  kind: VOICE_NODE_DEVICE_TYPE.kind,
  title: VOICE_NODE_DEVICE_TYPE.title,
  one: VOICE_NODE_DEVICE_TYPE.one,
  many: VOICE_NODE_DEVICE_TYPE.many,
  description: VOICE_NODE_DEVICE_TYPE.description,
  keys: [...VOICE_NODE_DEVICE_TYPE.keys],
  settings: VOICE_NODE_DEVICE_TYPE.builtIn,
  rev: 1,
  followUpUnset: 0
}
const status = { ...exampleNodeStatus, inputs: [...exampleNodeStatus.inputs], outputs: [...exampleNodeStatus.outputs], missingTools: [...exampleNodeStatus.missingTools] }
const node: DeviceListInfo = {
  ...exampleDevice,
  id: "vn-kitchen",
  kind: "voice-node",
  name: "Kitchen",
  own: {},
  settings: VOICE_NODE_DEVICE_TYPE.builtIn,
  hearer: null,
  node: { pairedAt: 1_763_000_000_000, version: "0.1.0+a1b2c3d4e5", upToDate: false, transport: "ws", status, platform: { os: "linux", arch: "arm64", hostname: "kitchen-pi", model: "Raspberry Pi 4 Model B" } },
  capabilities: exampleNodeCapabilities
}

describe("reducer", () => {
  it("`devices` carries a node's info and capabilities through", () => {
    const s = run([{ type: "devices", devices: [node] }])
    expect(s.devices[0]?.node?.status?.backend).toBe("alsa")
    expect(s.devices[0]?.capabilities).toEqual(exampleNodeCapabilities)
  })

  it("`node.paired` is remembered by its code (newest last, one entry per code, at most a few) and goes at logout", () => {
    let s = run([serverExamples.welcome, nodeServerExamples["node.paired"]])
    expect(s.pairedNodes).toEqual([{ code: "K7QM2XHP", deviceId: "n-8e2a41c7d0", name: "Kitchen" }])
    s = run([{ ...nodeServerExamples["node.paired"], name: "Kitchen 2" }], s)
    expect(s.pairedNodes).toEqual([{ code: "K7QM2XHP", deviceId: "n-8e2a41c7d0", name: "Kitchen 2" }])
    for (let i = 0; i < MAX_PAIRED_NODES + 2; i++) s = run([{ type: "node.paired", code: `CODE000${i}`, deviceId: `vn-${i}`, name: `Box ${i}` }], s)
    expect(s.pairedNodes).toHaveLength(MAX_PAIRED_NODES)
    expect(s.pairedNodes.at(-1)?.code).toBe(`CODE000${MAX_PAIRED_NODES + 1}`)
    s = run([{ type: "admin.state", admin: { enabled: true, loggedIn: false } }], s)
    expect(s.pairedNodes).toEqual([])
  })

  it("`node.command` and `node.meter` leave the page's state as it is", () => {
    const s = run([serverExamples.welcome])
    expect(run([nodeServerExamples["node.command"]], s)).toBe(s)
    expect(run([nodeServerExamples["node.meter"]], s)).toBe(s)
  })
})

describe("the install command", () => {
  it("http: download the installer and pair with the code", () => {
    expect(installCommand({ url: "http://192.168.1.20:8787", code: "K7QM2XHP" })).toBe(
      "curl -fsSL http://192.168.1.20:8787/node/install.sh | sudo sh -s -- --server http://192.168.1.20:8787 --code K7QM2XHP"
    )
  })

  it("https with the server's pin: curl checks the certificate by its pin, and the node gets the pin", () => {
    expect(installCommand({ url: "https://assistant.home:8443", code: "K7QM2XHP", pin: exampleNodePairing.tlsPin })).toBe(
      `curl -fsSL -k --pinnedpubkey 'sha256//${B64}' https://assistant.home:8443/node/install.sh | sudo sh -s -- --server https://assistant.home:8443 --tls-pin sha256:${HEX} --code K7QM2XHP`
    )
  })

  it("https without a pin (a public certificate, a proxy): no -k, no pin", () => {
    expect(installCommand({ url: "https://assistant.example.org", code: "K7QM2XHP" })).toBe(
      "curl -fsSL https://assistant.example.org/node/install.sh | sudo sh -s -- --server https://assistant.example.org --code K7QM2XHP"
    )
  })

  it("a pin is not used over http, and an address the shell would read is quoted", () => {
    expect(installCommand({ url: "http://box", code: "K7QM2XHP", pin: exampleNodePairing.tlsPin })).not.toContain("pinnedpubkey")
    expect(installCommand({ url: "http://[fe80::1]:8787", code: "K7QM2XHP" })).toContain("--server 'http://[fe80::1]:8787'")
  })

  it("pins: curl's base64 from the hex; pasted as hex, with colons, as sha256// or as openssl prints it", () => {
    expect(pinBase64(exampleNodePairing.tlsPin!)).toBe(B64)
    expect(pinBase64("sha256:nothex")).toBeUndefined()
    expect(parsePin(`sha256:${HEX}`)).toBe(`sha256:${HEX}`)
    expect(parsePin(HEX.toUpperCase().match(/../g)!.join(":"))).toBe(`sha256:${HEX}`)
    expect(parsePin(`sha256//${B64}`)).toBe(`sha256:${HEX}`)
    expect(parsePin(B64)).toBe(`sha256:${HEX}`)
    expect(parsePin(`SHA2-256(stdin)= ${HEX}`)).toBe(`sha256:${HEX}`)
    expect(parsePin("sha256:1234")).toBeUndefined()
    expect(parsePin("")).toBeUndefined()
  })
})

describe("the code and the address", () => {
  it("the code is shown in two groups of four; the countdown in minutes and seconds", () => {
    expect(formatPairCode("K7QM2XHP")).toBe("K7QM-2XHP")
    expect(countdownText(9 * 60_000 + 5_000)).toBe("9:05")
    expect(countdownText(500)).toBe("0:01")
    expect(countdownText(-10)).toBe("0:00")
  })

  it("the server address: its origin, http or https only, and loopback names marked", () => {
    expect(parseServerAddress(" https://assistant.home:8443/admin/#settings ")).toEqual({ ok: true, url: "https://assistant.home:8443", secure: true, loopback: false })
    expect(parseServerAddress("http://localhost:3000")).toMatchObject({ ok: true, loopback: true, secure: false })
    expect(parseServerAddress("assistant.home")).toMatchObject({ ok: false })
    expect(parseServerAddress("ftp://x")).toMatchObject({ ok: false })
    expect(parseServerAddress("")).toMatchObject({ ok: false })
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "0.0.0.0", "app.localhost"]) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ["192.168.1.20", "assistant.home", "10.0.0.1"]) expect(isLoopbackHost(h)).toBe(false)
  })

  it("the prefilled address is the page's server: its WebSocket address as http(s)", () => {
    expect(serverOriginOf("wss://assistant.home:8443/ws", "https://x")).toBe("https://assistant.home:8443")
    expect(serverOriginOf("ws://127.0.0.1:8787/ws", "http://x")).toBe("http://127.0.0.1:8787")
    expect(serverOriginOf("not a url", "http://x")).toBe("http://x")
  })
})

describe("status words", () => {
  it("online, or offline since; Update pending; Unencrypted; the box; what it can do; what to install", () => {
    const now = new Date(2026, 10, 18, 15, 0).getTime()
    expect(nodeOnlineText({ connections: 1, lastSeen: 0 }, now)).toBe("Online")
    expect(nodeOnlineText({ connections: 0, lastSeen: new Date(2026, 10, 18, 9, 5).getTime() }, now)).toMatch(/^Offline since 0?9.05/)
    expect(nodeOnlineText({ connections: 0, lastSeen: new Date(2026, 10, 12, 9, 5).getTime() }, now)).toMatch(/^Offline since .*12/)
    expect(updatePending(node.node)).toBe(true)
    expect(updatePending({ pairedAt: 0 })).toBe(false)
    expect(unencrypted(node.node)).toBe(true)
    expect(platformText(node.node!.platform!)).toBe("Raspberry Pi 4 Model B · Linux arm64 · host kitchen-pi")
    expect(capabilitiesText(exampleNodeCapabilities)).toBe("Speaks, listens; no screen")
    expect(capabilitiesText(undefined)).toBeUndefined()
    expect(packageFor("arecord")).toBe("alsa-utils")
    expect(packageFor("pw-record")).toBe("pipewire-bin")
  })
})

describe("sections by type keys", () => {
  it("a voice node has no Look, voice page, Captions or browser Audio, and has Sound and Sound devices", () => {
    expect(sectionsOf(nodeType)).toEqual(["assign", "phrases", "voice", "interrupting", "sound", "soundDevices"])
    expect(sectionsOf({ keys: [...WEB_VOICE_DEVICE_TYPE.keys] })).not.toContain("sound")
    expect(sectionsOf({ keys: [...WEB_VOICE_DEVICE_TYPE.keys] })).not.toContain("soundDevices")
  })

  it("Sound and Sound devices are own values on a node like any section: saved as values, reset as null", () => {
    const base = baseOfDevice(node, nodeType)
    const e = setKeys(base, noEdit, { sound: { volume: 40, cues: false } })
    expect(isOwn(base, e, "sound")).toBe(true)
    expect(patchOf(base, e)).toEqual({ sound: { volume: 40, cues: false } })
    const saved = baseOfDevice({ ...node, own: { soundDevices: { input: "plughw:CARD=Gone,DEV=0", output: "" } } }, nodeType)
    expect(patchOf(saved, resetSection(saved, noEdit, "soundDevices"))).toEqual({ soundDevices: null })
    expect(settingsOf(baseOfType(nodeType), noEdit).sound).toEqual({ volume: 80, cues: true })
  })
})

describe("sound devices", () => {
  it("System default first, the reported devices, and a stored one that is gone kept as (not connected)", () => {
    expect(soundDeviceOptions(status.inputs, "plughw:CARD=Gone,DEV=0")).toEqual([
      { value: "", label: "System default (USB Speakerphone)" },
      { value: "plughw:CARD=Speaker,DEV=0", label: "USB Speakerphone · plughw:CARD=Speaker,DEV=0" },
      { value: "plughw:CARD=Gone,DEV=0", label: "plughw:CARD=Gone,DEV=0 (not connected)" }
    ])
    expect(soundDeviceOptions([], "")).toEqual([{ value: "", label: "System default" }])
  })

  it("a node's own list, every node's on the defaults page, and nothing before any status", () => {
    expect(reportedSoundDevices([node], "inputs")).toEqual(status.inputs)
    expect(reportedSoundDevices([{ node: { pairedAt: 0 } }], "inputs")).toBeUndefined()
    expect(reportedSoundDevices([node, node], "outputs")).toHaveLength(2)
  })
})
