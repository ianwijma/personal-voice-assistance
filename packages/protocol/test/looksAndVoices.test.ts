// Protocol 8 (docs/LOOKS-AND-VOICES.md §2): the `look` and `voice` device sections are a closed-set change, so the
// version moved from 7 to 8. A peer of the other version must get the mismatch close, not misread devices.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  BUILT_IN_WEB_VOICE_SETTINGS,
  decodeClientMessage,
  decodeServerMessage,
  DEVICE_SETTINGS_KEYS,
  DeviceSettings,
  DeviceSettingsKey,
  PROTOCOL_VERSION
} from "../src/index.ts"
import { assistantsClientExamples, clientExamples, exampleDevice, serverExamples } from "../src/examples.ts"

const decodes = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success"

describe("protocol 8", () => {
  it("is protocol version 8, and the examples speak it", () => {
    expect(PROTOCOL_VERSION).toBe(8)
    expect(serverExamples.welcome.protocol).toBe(8)
    expect(clientExamples.hello.protocol).toBe(8)
  })

  it("a version 7 hello still decodes, so the server can answer it with the mismatch close", () => {
    expect(decodeClientMessage(JSON.stringify({ ...clientExamples.hello, protocol: 7 }))).toMatchObject({ _tag: "Ok", message: { type: "hello", protocol: 7 } })
  })

  it("look and voice are members of the closed DeviceSettingsKey set (why 7 could not carry them)", () => {
    expect(DEVICE_SETTINGS_KEYS).toContain("look")
    expect(DEVICE_SETTINGS_KEYS).toContain("voice")
    expect(decodes(DeviceSettingsKey, "look")).toBe(true)
  })

  it("version 7 device settings (no look, no voice) are not version 8 device settings", () => {
    const { look: _look, voice: _voice, ...v7 } = BUILT_IN_WEB_VOICE_SETTINGS
    expect(decodes(DeviceSettings, BUILT_IN_WEB_VOICE_SETTINGS)).toBe(true)
    expect(decodes(DeviceSettings, v7)).toBe(false)
    const v7Device = { ...exampleDevice, settings: v7 }
    expect(decodeServerMessage(JSON.stringify({ type: "devices", devices: [v7Device] }))).toMatchObject({ _tag: "Invalid", messageType: "devices" })
  })

  it("a device.save with a look or a voice section and assistant.create with saveAnyway decode", () => {
    const save = { ...assistantsClientExamples["device.save"], settings: { look: { from: "device", look: { character: "flame" } }, voice: { from: "assistant" } } }
    expect(decodeClientMessage(JSON.stringify(save))).toMatchObject({ _tag: "Ok" })
    const create = { ...assistantsClientExamples["assistant.create"], saveAnyway: true }
    expect(decodeClientMessage(JSON.stringify(create))).toMatchObject({ _tag: "Ok", message: { saveAnyway: true } })
  })
})
