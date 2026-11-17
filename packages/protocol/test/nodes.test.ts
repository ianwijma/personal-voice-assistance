import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  BUILT_IN_VOICE_NODE_SETTINGS,
  BUILT_IN_WEB_VOICE_SETTINGS,
  CloseCode,
  decodeClientMessage,
  decodeServerMessage,
  DEVICE_TYPES,
  deviceSetupFrom,
  deviceTypeOf,
  effectiveFollowUpSeconds,
  encodeClientMessage,
  encodeServerMessage,
  followUpMsFor,
  NodeManifest,
  NodePairAnswer,
  NodePairing,
  NodePairRequest,
  PROTOCOL_VERSION,
  routeConfigFrom,
  validateDeviceSettings,
  VOICE_NODE_DEVICE_TYPE,
  WEB_VOICE_DEVICE_TYPE
} from "../src/index.ts"
import {
  clientExamples,
  exampleAssistant,
  exampleAssistantT3,
  exampleDevice,
  exampleNodeHello,
  exampleNodeHelloMessage,
  exampleNodePairing,
  exampleNodePairResult,
  nodeClientExamples,
  nodeServerExamples
} from "../src/examples.ts"

const sha = "3b1f0c9e5a7d4b8e2c6f1a0d9e8b7c6a5f4e3d2c1b0a9f8e7d6c5b4a39281706"
const assistants = new Map([exampleAssistant, exampleAssistantT3].map((a) => [a.id, a]))
const decodes = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success"

describe("protocol 9: voice nodes", () => {
  it("is version 9 and CloseCode.unauthorized is 4403", () => {
    expect(PROTOCOL_VERSION).toBe(9)
    expect(CloseCode.unauthorized).toBe(4403)
  })

  it("every new message example round-trips", () => {
    for (const m of Object.values(nodeClientExamples)) {
      expect(decodeClientMessage(encodeClientMessage(m))).toEqual({ _tag: "Ok", message: m })
    }
    for (const m of Object.values(nodeServerExamples)) {
      expect(decodeServerMessage(encodeServerMessage(m))).toEqual({ _tag: "Ok", message: m })
    }
    expect(decodeClientMessage(encodeClientMessage(exampleNodeHelloMessage))).toEqual({ _tag: "Ok", message: exampleNodeHelloMessage })
    expect(decodeServerMessage(encodeServerMessage(exampleNodePairResult))).toEqual({ _tag: "Ok", message: exampleNodePairResult })
    expect(Object.keys(nodeClientExamples)).toEqual(["node.status", "node.level", "node.command.send", "node.pair.create", "node.pair.cancel"])
    expect(Object.keys(nodeServerExamples)).toEqual(["node.command", "node.paired", "node.meter"])
  })

  it("a browser hello stays valid without node; node fields are bounded", () => {
    expect(decodeClientMessage(encodeClientMessage(clientExamples.hello))._tag).toBe("Ok")
    const bad = (node: object) => decodeClientMessage(JSON.stringify({ ...exampleNodeHelloMessage, node: { ...exampleNodeHello, ...node } }))._tag
    expect(bad({ credential: "short" })).toBe("Invalid")
    expect(bad({ platform: { os: "linux", arch: "mips", hostname: "x" } })).toBe("Invalid")
    expect(bad({ bundleSha256: "ABC" })).toBe("Invalid")
    expect(decodeClientMessage(JSON.stringify({ ...nodeClientExamples["node.command.send"], durationMs: 50 }))._tag).toBe("Invalid")
    expect(decodeClientMessage(JSON.stringify({ ...nodeClientExamples["node.command.send"], command: "reboot" }))._tag).toBe("Invalid")
  })

  it("HTTP bodies decode", () => {
    expect(decodes(NodePairing, exampleNodePairing)).toBe(true)
    expect(decodes(NodePairing, { ...exampleNodePairing, bundle: null })).toBe(true)
    const request = { code: "K7QM2XHP", hostname: "kitchen-pi", platform: exampleNodeHello.platform, version: "dev" }
    expect(decodes(NodePairRequest, request)).toBe(true)
    expect(decodes(NodePairRequest, { ...request, code: "k7qm2xhp" })).toBe(false)
    expect(decodes(NodePairRequest, { ...request, code: "K7QM2XHI" })).toBe(false)
    expect(decodes(NodePairAnswer, { deviceId: "n-8e2a41c7d0", credential: exampleNodeHello.credential, name: "Kitchen" })).toBe(true)
  })

  it("NodeManifest decodes a manifest as apps/node's bundle script writes it", () => {
    const artifact = (path: string) => ({ path, sha256: sha, bytes: 1234 })
    const manifest = {
      format: 1,
      protocol: PROTOCOL_VERSION,
      version: "0.1.0+a1b2c3d4e5",
      builtAt: "2026-11-18T01:02:03.000Z",
      bundle: artifact("pva-node.mjs"),
      boot: artifact("pva-node-boot.mjs"),
      installer: artifact("install.sh"),
      runtime: {
        version: "22.12.0",
        "linux-arm64": { url: "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-arm64.tar.xz", sha256: sha },
        "linux-x64": { url: "https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz", sha256: sha }
      }
    }
    expect(decodes(NodeManifest, manifest)).toBe(true)
    expect(decodes(NodeManifest, { ...manifest, format: 2 })).toBe(false)
  })

  it("the voice-node type is registered and the browser type ignores the node sections", () => {
    expect(DEVICE_TYPES.map((t) => t.kind)).toEqual(["web-voice", "voice-node"])
    expect(deviceTypeOf("voice-node")).toBe(VOICE_NODE_DEVICE_TYPE)
    expect(VOICE_NODE_DEVICE_TYPE.keys).toEqual(["assistants", "withoutPhrase", "matching", "voice", "interruptMode", "sound", "soundDevices"])
    expect(WEB_VOICE_DEVICE_TYPE.keys).not.toContain("sound")
    expect(WEB_VOICE_DEVICE_TYPE.keys).not.toContain("soundDevices")
    expect(BUILT_IN_WEB_VOICE_SETTINGS.sound).toEqual({ volume: 80, cues: true })
    expect(BUILT_IN_VOICE_NODE_SETTINGS.soundDevices).toEqual({ input: "", output: "" })
  })

  it("followUpUnset sits between the assignment and the assistant", () => {
    const jeff = { followUpSeconds: 8 }
    expect(effectiveFollowUpSeconds({}, jeff)).toBe(8)
    expect(effectiveFollowUpSeconds({}, jeff, WEB_VOICE_DEVICE_TYPE)).toBe(8)
    expect(effectiveFollowUpSeconds({}, jeff, VOICE_NODE_DEVICE_TYPE)).toBe(0)
    expect(effectiveFollowUpSeconds({ followUpSeconds: 20 }, jeff, VOICE_NODE_DEVICE_TYPE)).toBe(20)
    const settings = { assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }, { assistant: "t3", phrases: ["hey t3"], followUpSeconds: 15 }] }
    expect(followUpMsFor(settings, assistants, "jeff")).toBe(exampleAssistant.followUpSeconds * 1000)
    expect(followUpMsFor(settings, assistants, "jeff", VOICE_NODE_DEVICE_TYPE)).toBe(0)
    expect(followUpMsFor(settings, assistants, "t3", VOICE_NODE_DEVICE_TYPE)).toBe(15_000)
    const route = (type?: typeof VOICE_NODE_DEVICE_TYPE) => routeConfigFrom({ ...settings, withoutPhrase: { mode: "nobody" }, matching: "close" }, assistants, type)
    expect(route().followUpMs.jeff).toBe(exampleAssistant.followUpSeconds * 1000)
    expect(route(VOICE_NODE_DEVICE_TYPE).followUpMs).toEqual({ jeff: 0, t3: 15_000 })
  })

  it("answers_everything warns on a voice node that answers without a phrase, and only there", () => {
    const known = new Set(["jeff", "t3"])
    const base = { assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }] }
    const codes = (wp: Parameters<typeof validateDeviceSettings>[0]["withoutPhrase"], type?: { kind: string }) =>
      validateDeviceSettings({ ...base, withoutPhrase: wp }, known, type === undefined ? {} : { type }).warnings.map((w) => w.code)
    expect(codes({ mode: "nobody" }, VOICE_NODE_DEVICE_TYPE)).not.toContain("answers_everything")
    expect(codes({ mode: "assistant", assistant: "jeff" }, VOICE_NODE_DEVICE_TYPE)).toContain("answers_everything")
    expect(codes({ mode: "typesafe", fallback: null, giveUpMs: 400 }, VOICE_NODE_DEVICE_TYPE)).toContain("answers_everything")
    expect(codes({ mode: "assistant", assistant: "jeff" }, WEB_VOICE_DEVICE_TYPE)).not.toContain("answers_everything")
    expect(codes({ mode: "assistant", assistant: "jeff" })).not.toContain("answers_everything")
  })

  it("deviceSetupFrom includes sound and soundDevices only for a type that has the keys", () => {
    const settings = { ...exampleDevice.settings, sound: { volume: 55, cues: false }, soundDevices: { input: "a", output: "b" } }
    const plain = deviceSetupFrom(settings, assistants, { canAuto: false })
    expect(plain).not.toHaveProperty("sound")
    const web = deviceSetupFrom(settings, assistants, { canAuto: false, keys: WEB_VOICE_DEVICE_TYPE.keys })
    expect(web).not.toHaveProperty("sound")
    expect(web).not.toHaveProperty("soundDevices")
    const node = deviceSetupFrom(settings, assistants, { canAuto: false, keys: VOICE_NODE_DEVICE_TYPE.keys })
    expect(node.sound).toEqual({ volume: 55, cues: false })
    expect(node.soundDevices).toEqual({ input: "a", output: "b" })
  })
})
