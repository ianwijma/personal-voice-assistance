// The voice API's shapes changed with per-assistant voices (docs/ASSISTANTS.md §5.5): a voice lists the assistants that
// speak with it (`usedBy`, which replaces `selected`) and the default voice can come from an assistant.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DefaultVoice, VoiceEntry } from "../src/index.ts"

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success"

const entry = (extra: Record<string, unknown> = {}) => ({
  voice: { provider: "sherpa", voiceId: "kokoro-af_heart" },
  key: "sherpa:kokoro-af_heart",
  name: "Heart",
  tags: [],
  previewable: true,
  usedBy: [],
  favourite: false,
  ...extra
})

describe("VoiceEntry.usedBy", () => {
  it("lists the ids of the assistants that speak with the voice; none is an empty list", () => {
    expect(accepts(VoiceEntry, entry())).toBe(true)
    expect(accepts(VoiceEntry, entry({ usedBy: ["alpha", "bravo-2"] }))).toBe(true)
  })

  it("is required: the old `selected` flag alone is not an entry any more", () => {
    const { usedBy: _usedBy, ...withoutUsedBy } = entry()
    expect(accepts(VoiceEntry, { ...withoutUsedBy, selected: true })).toBe(false)
  })

  it("only takes assistant ids (lower-case, starts with a letter, at most 32 characters)", () => {
    expect(accepts(VoiceEntry, entry({ usedBy: ["Alpha"] }))).toBe(false)
    expect(accepts(VoiceEntry, entry({ usedBy: ["1st"] }))).toBe(false)
    expect(accepts(VoiceEntry, entry({ usedBy: [""] }))).toBe(false)
    expect(accepts(VoiceEntry, entry({ usedBy: ["a".repeat(32)] }))).toBe(true)
    expect(accepts(VoiceEntry, entry({ usedBy: ["a".repeat(33)] }))).toBe(false)
    expect(accepts(VoiceEntry, entry({ usedBy: "alpha" }))).toBe(false)
  })
})

describe("DefaultVoice.source", () => {
  const defaultVoice = (source: string) => ({
    voice: { provider: "sherpa", voiceId: "kokoro-af_heart" },
    key: "sherpa:kokoro-af_heart",
    source,
    locked: false,
    reloadPending: false,
    notes: []
  })

  it("accepts `assistant` next to the earlier sources", () => {
    for (const source of ["saved", "environment", "migrated", "default", "assistant"]) {
      expect(accepts(DefaultVoice, defaultVoice(source))).toBe(true)
    }
  })

  it("refuses a source it does not know", () => {
    expect(accepts(DefaultVoice, defaultVoice("assistants"))).toBe(false)
  })
})

describe("VoiceEntry.usedByDevices", () => {
  const kitchen = { target: { kind: "device", id: "d-kitchen-ipad-0001" }, name: "Kitchen iPad" }
  it("is optional (an older server leaves it out) and lists devices and device types with their names", () => {
    expect(accepts(VoiceEntry, entry())).toBe(true)
    expect(accepts(VoiceEntry, entry({ usedByDevices: [] }))).toBe(true)
    expect(accepts(VoiceEntry, entry({ usedByDevices: [kitchen, { target: { kind: "type", type: "web-voice" }, name: "Every browser" }] }))).toBe(true)
  })
  it("refuses a user without a target or a name", () => {
    expect(accepts(VoiceEntry, entry({ usedByDevices: [{ name: "x" }] }))).toBe(false)
    expect(accepts(VoiceEntry, entry({ usedByDevices: [{ target: kitchen.target }] }))).toBe(false)
    expect(accepts(VoiceEntry, entry({ usedByDevices: [{ target: { kind: "device", id: "x" }, name: "x" }] }))).toBe(false)
  })
})
