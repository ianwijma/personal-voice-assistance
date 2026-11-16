import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  Assignment,
  AssistantId,
  BUILT_IN_WEB_VOICE_SETTINGS,
  DEVICE_SETTINGS_KEYS,
  DEVICE_TYPES,
  DeviceSettings,
  DeviceSettingsPatch,
  DeviceTarget,
  deviceTypeOf,
  makeAssistantId,
  nameKey,
  phraseKey,
  settingsKey,
  ToolName,
  validateDeviceSettings,
  WEB_VOICE_DEVICE_TYPE,
  WithoutPhrase
} from "../src/index.ts"

// Boundaries and helpers of the assistant and device schemas that assistants.test.ts does not pin down.

const accepts = (schema: Schema.Top, value: unknown) =>
  Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success"

describe("AssistantId", () => {
  it("accepts 1 to 32 characters: a lowercase letter, then lowercase letters, digits and dashes", () => {
    for (const id of ["a", "jeff", "t3", "keuken-2", "a-b-c", "a".repeat(32), "a--b"]) expect(accepts(AssistantId, id), id).toBe(true)
  })
  it("refuses everything else", () => {
    for (const id of ["", "A", "Jeff", "1a", "-a", "a_b", "a b", "é", "a".repeat(33), "a.b", "a\n"]) {
      expect(accepts(AssistantId, id), JSON.stringify(id)).toBe(false)
    }
  })
  it("makeAssistantId never makes an id the schema refuses, whatever the name", () => {
    for (const name of ["", " ", "-", "9 lives", "Ünïcödé", "日本語", "a".repeat(40), "A-".repeat(30), "x y z"]) {
      expect(accepts(AssistantId, makeAssistantId(name)), JSON.stringify(name)).toBe(true)
    }
  })
  it("makeAssistantId keeps ids apart when the same name is made again and again", () => {
    const taken: Array<string> = []
    for (let i = 0; i < 5; i++) taken.push(makeAssistantId("Jeff", taken))
    expect(taken).toEqual(["jeff", "jeff-2", "jeff-3", "jeff-4", "jeff-5"])
  })
})

describe("ToolName", () => {
  it("is 1 to 64 characters", () => {
    expect(accepts(ToolName, "x")).toBe(true)
    expect(accepts(ToolName, "x".repeat(64))).toBe(true)
    expect(accepts(ToolName, "")).toBe(false)
    expect(accepts(ToolName, "x".repeat(65))).toBe(false)
  })
})

describe("Assignment follow-up seconds", () => {
  const base = { assistant: "jeff", phrases: [] }
  it("accepts the ends of the range, whole seconds only", () => {
    expect(accepts(Assignment, { ...base, followUpSeconds: 0 })).toBe(true)
    expect(accepts(Assignment, { ...base, followUpSeconds: 120 })).toBe(true)
    expect(accepts(Assignment, { ...base, followUpSeconds: -1 })).toBe(false)
    expect(accepts(Assignment, { ...base, followUpSeconds: 1.5 })).toBe(false)
    expect(accepts(Assignment, { ...base, followUpSeconds: "5" })).toBe(false)
  })
  it("takes at most 12 phrases and refuses a phrase longer than 60 characters", () => {
    expect(accepts(Assignment, { ...base, phrases: Array.from({ length: 12 }, (_, i) => `hey ${i}`) })).toBe(true)
    expect(accepts(Assignment, { ...base, phrases: ["hey " + "x".repeat(56)] })).toBe(true)
    expect(accepts(Assignment, { ...base, phrases: ["hey " + "x".repeat(57)] })).toBe(false)
    expect(accepts(Assignment, { ...base, phrases: ["one two three four five six seven"] })).toBe(false)
  })
})

describe("WithoutPhrase TypeSafe give-up time", () => {
  const typesafe = (giveUpMs: unknown) => ({ mode: "typesafe", fallback: null, giveUpMs })
  it("accepts 100 to 2000 whole milliseconds", () => {
    expect(accepts(WithoutPhrase, typesafe(100))).toBe(true)
    expect(accepts(WithoutPhrase, typesafe(2000))).toBe(true)
    expect(accepts(WithoutPhrase, typesafe(400.5))).toBe(false)
    expect(accepts(WithoutPhrase, typesafe("400"))).toBe(false)
  })
  it("a fallback must be an assistant id or null", () => {
    expect(accepts(WithoutPhrase, { mode: "typesafe", fallback: "Jeff", giveUpMs: 400 })).toBe(false)
    expect(accepts(WithoutPhrase, { mode: "typesafe", giveUpMs: 400 })).toBe(false)
  })
  it("mode assistant refuses a malformed id", () => {
    expect(accepts(WithoutPhrase, { mode: "assistant", assistant: "Not An Id" })).toBe(false)
  })
})

describe("DeviceTarget", () => {
  it("is a type or a device, with the matching field", () => {
    expect(accepts(DeviceTarget, { kind: "type", type: "web-voice" })).toBe(true)
    expect(accepts(DeviceTarget, { kind: "device", id: "device-12345" })).toBe(true)
    expect(accepts(DeviceTarget, { kind: "device", id: "short" })).toBe(false)
    expect(accepts(DeviceTarget, { kind: "device", id: "has spaces here" })).toBe(false)
    expect(accepts(DeviceTarget, { kind: "type", id: "device-12345" })).toBe(false)
    expect(accepts(DeviceTarget, { kind: "group", id: "device-12345" })).toBe(false)
  })
})

describe("DeviceSettingsPatch", () => {
  it("accepts null for every section, which means 'back to the type defaults'", () => {
    const patch = Object.fromEntries(DEVICE_SETTINGS_KEYS.map((k) => [k, null]))
    expect(accepts(DeviceSettingsPatch, patch)).toBe(true)
  })
  it("accepts an empty patch and drops a section that does not exist", () => {
    expect(accepts(DeviceSettingsPatch, {})).toBe(true)
    expect(Schema.decodeUnknownSync(DeviceSettingsPatch)({ nope: 1 })).toEqual({})
  })
  it("refuses an invalid value in a section", () => {
    expect(accepts(DeviceSettingsPatch, { interruptMode: "sometimes" })).toBe(false)
    expect(accepts(DeviceSettingsPatch, { matching: 3 })).toBe(false)
  })
})

describe("device types", () => {
  it("deviceTypeOf finds the registered kind and nothing else", () => {
    expect(deviceTypeOf("web-voice")).toBe(WEB_VOICE_DEVICE_TYPE)
    expect(deviceTypeOf("")).toBeUndefined()
    expect(deviceTypeOf("toaster")).toBeUndefined()
  })
  it("every type has a distinct kind, its sections are real, and its built-in values are a complete valid DeviceSettings", () => {
    const kinds = DEVICE_TYPES.map((t) => t.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const type of DEVICE_TYPES) {
      for (const key of type.keys) expect(DEVICE_SETTINGS_KEYS).toContain(key)
      expect(accepts(DeviceSettings, type.builtIn), type.kind).toBe(true)
    }
  })
  it("the built-in browser answers nobody and has no assistant assigned", () => {
    expect(BUILT_IN_WEB_VOICE_SETTINGS.assistants).toEqual([])
    expect(BUILT_IN_WEB_VOICE_SETTINGS.withoutPhrase).toEqual({ mode: "nobody" })
    expect(validateDeviceSettings(BUILT_IN_WEB_VOICE_SETTINGS, new Set()).errors).toEqual([])
  })
})

describe("keys", () => {
  it("nameKey trims and ignores case", () => {
    expect(nameKey("  Jeff ")).toBe("jeff")
    expect(nameKey("JEFF")).toBe(nameKey("jeff"))
    expect(nameKey("Jeff")).not.toBe(nameKey("Jeffrey"))
  })
  it("phraseKey normalises like the matcher: case, punctuation, apostrophes and accents", () => {
    expect(phraseKey("Hey Jeff")).toBe("hey jeff")
    expect(phraseKey("  hey,   JEFF!! ")).toBe("hey jeff")
    expect(phraseKey("Hé Jeff")).toBe("he jeff")
    expect(phraseKey("Jeff's")).toBe("jeffs")
    expect(phraseKey("Jeff’s")).toBe("jeffs")
    expect(phraseKey("hey jeff")).not.toBe(phraseKey("hey jev"))
    expect(phraseKey("!!!")).toBe("")
  })
  it("settingsKey is the same for the same values in any key order and differs when a value differs", () => {
    expect(settingsKey({ a: 1, b: "x" })).toBe(settingsKey({ b: "x", a: 1 }))
    expect(settingsKey({ a: 1 })).not.toBe(settingsKey({ a: 2 }))
    expect(settingsKey({ a: 1 })).not.toBe(settingsKey({ b: 1 }))
    expect(settingsKey({ a: "1" })).not.toBe(settingsKey({ a: 1 }))
    expect(settingsKey({})).toBe(settingsKey({}))
  })
})
