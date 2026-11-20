// Protocol 11 (docs/MODULES-PLAN.md §4 P5): what a device declares, what the owner can take away, and the two new
// device settings sections, resolved like every other section.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  BUILT_IN_PLACE,
  BUILT_IN_WEB_VOICE_SETTINGS,
  capabilitiesDifferMaterially,
  canSpeak,
  capabilityWords,
  speakerMediaWords,
  DEVICE_SETTINGS_KEYS,
  DeviceCapabilities,
  DeviceOwn,
  DeviceSettings,
  displayClassOf,
  effectiveCapabilities,
  effectiveDeviceSettings,
  NO_CAPABILITIES,
  NO_OVERRIDES,
  PROTOCOL_VERSION,
  sameRoom
} from "../src/index.ts"
import { clientExamples } from "../src/examples.ts"
import { decodeClientMessage } from "../src/codec.ts"

const tablet: DeviceCapabilities = {
  v: 1,
  display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true },
  present: { kinds: { card: 1, list: 2, timer: 1 } },
  speaker: { media: ["speech", "audio"] },
  microphone: { farField: false }
}

describe("DeviceCapabilities", () => {
  it("absent means cannot: the smallest declaration decodes and has nothing", () => {
    const decode = Schema.decodeUnknownSync(DeviceCapabilities)
    expect(decode({ v: 1 })).toEqual({ v: 1 })
    expect(effectiveCapabilities(decode({ v: 1 }))).toEqual(NO_CAPABILITIES)
    expect(() => decode({ v: 2 })).toThrow()
    expect(() => decode({ v: 1, display: { class: "huge", widthPx: 1, heightPx: 1, dpr: 1, touch: "none", colour: true } })).toThrow()
    // A kind that is not a kind name never gets through: refused, or left out of the record.
    let kept: ReadonlyArray<string> = []
    try {
      kept = Object.keys(decode({ v: 1, present: { kinds: { "Not A Kind": 1, card: 2 } } }).present?.kinds ?? {})
    } catch {
      kept = []
    }
    console.log(`a bad kind name: ${kept.length === 0 ? "refused" : `kept ${kept.join(", ")}`}`)
    expect(kept).not.toContain("Not A Kind")
  })

  it("a device that never declared anything can do nothing", () => {
    expect(effectiveCapabilities(undefined, NO_OVERRIDES)).toEqual({ v: 1 })
    expect(effectiveCapabilities(undefined, { noDisplay: false, noSpeaker: false, excludeKinds: [] })).toEqual({ v: 1 })
    expect(capabilityWords(NO_CAPABILITIES)).toBe("nothing declared")
  })

  it("overrides can only remove: no display (and with it every kind), excluded kinds, no speaker", () => {
    expect(effectiveCapabilities(tablet, NO_OVERRIDES)).toEqual(tablet)
    const noScreen = effectiveCapabilities(tablet, { ...NO_OVERRIDES, noDisplay: true })
    expect(noScreen.display).toBeUndefined()
    expect(noScreen.present).toBeUndefined()
    expect(noScreen.speaker).toEqual(tablet.speaker)
    expect(effectiveCapabilities(tablet, { ...NO_OVERRIDES, excludeKinds: ["list", "gallery"] }).present).toEqual({ kinds: { card: 1, timer: 1 } })
    expect(effectiveCapabilities(tablet, { ...NO_OVERRIDES, noSpeaker: true }).speaker).toBeUndefined()
    // Nothing is ever added: a speaker without a screen stays without one whatever the overrides say.
    const speaker: DeviceCapabilities = { v: 1, speaker: { media: ["speech"] }, microphone: { farField: true } }
    for (const o of [NO_OVERRIDES, { ...NO_OVERRIDES, noDisplay: true }, { ...NO_OVERRIDES, excludeKinds: ["card"] }]) {
      const e = effectiveCapabilities(speaker, o)
      expect(e.display).toBeUndefined()
      expect(e.present).toBeUndefined()
      expect(e.openUrl).toBeUndefined()
    }
  })

  it("the size class comes from the viewport; a resize alone is not a material change", () => {
    expect(displayClassOf(320, 240)).toBe("glance")
    expect(displayClassOf(390, 844)).toBe("compact")
    expect(displayClassOf(844, 390)).toBe("compact")
    expect(displayClassOf(1024, 768)).toBe("standard")
    expect(displayClassOf(1920, 1080)).toBe("large")
    const resized = { ...tablet, display: { ...tablet.display!, widthPx: 1000, heightPx: 700 } }
    expect(capabilitiesDifferMaterially(tablet, resized)).toBe(false)
    expect(capabilitiesDifferMaterially(tablet, { ...tablet, openUrl: true })).toBe(true)
    expect(capabilitiesDifferMaterially(undefined, tablet)).toBe(true)
  })

  it("words for the context line and admin", () => {
    expect(capabilityWords(tablet)).toBe(`tablet-size screen, touch, speaker (${speakerMediaWords(tablet.speaker!.media)}), microphone`)
    expect(capabilityWords({ v: 1, speaker: { media: ["speech"] }, microphone: { farField: true } })).toBe("voice only (speech), no screen")
    expect(capabilityWords({ v: 1, speaker: { media: ["speech"] } })).toBe("voice only (speech), no screen, no microphone")
    expect(capabilityWords({ v: 1, display: { class: "large", widthPx: 1920, heightPx: 1080, dpr: 1, touch: "none", colour: true } })).toBe("large screen, no speaker")
  })

  it("a speaker is described by its actual media set, and only speech counts as speaking", () => {
    const cases: ReadonlyArray<readonly [ReadonlyArray<"speech" | "audio" | "video">, string, boolean]> = [
      [[], "nothing", false],
      [["speech"], "speech", true],
      [["audio"], "sound, no speech", false],
      [["video"], "video, no speech", false],
      [["speech", "audio"], "speech and sound", true],
      [["speech", "video"], "speech and video", true],
      [["audio", "video"], "sound and video, no speech", false],
      [["speech", "audio", "video"], "speech, sound and video", true]
    ]
    for (const [media, words, speaks] of cases) {
      expect(speakerMediaWords(media)).toBe(words)
      expect(canSpeak({ v: 1, speaker: { media } })).toBe(speaks)
      // Without a screen, "voice only" only where speech is played.
      expect(capabilityWords({ v: 1, speaker: { media }, microphone: { farField: false } })).toBe(speaks ? `voice only (${words}), no screen` : `no screen, speaker (${words}), microphone`)
    }
    expect(canSpeak(undefined)).toBe(false)
    expect(canSpeak({ v: 1 })).toBe(false)
  })

  it("rooms compare without case or surrounding space; an empty room is in no room", () => {
    expect(sameRoom("Kitchen", " kitchen ")).toBe(true)
    expect(sameRoom("Kitchen", "Hall")).toBe(false)
    expect(sameRoom("", "")).toBe(false)
    expect(sameRoom(undefined, "Kitchen")).toBe(false)
  })

  it("hello.device.capabilities and device.caps decode", () => {
    const hello = decodeClientMessage(JSON.stringify(clientExamples.hello))
    expect(hello._tag).toBe("Ok")
    const caps = decodeClientMessage(JSON.stringify({ type: "device.caps", live: { visible: false } }))
    expect(caps._tag).toBe("Ok")
    expect(decodeClientMessage(JSON.stringify({ type: "device.caps", capabilities: { v: 1, openUrl: "yes" } }))._tag).toBe("Invalid")
  })
})

describe("the place and capabilities sections (protocol 11)", () => {
  it("are new section keys, required in complete settings, so the protocol is 11", () => {
    expect(PROTOCOL_VERSION).toBe(12)
    expect(DEVICE_SETTINGS_KEYS).toContain("place")
    expect(DEVICE_SETTINGS_KEYS).toContain("capabilities")
    expect(BUILT_IN_WEB_VOICE_SETTINGS.place).toEqual(BUILT_IN_PLACE)
    expect(BUILT_IN_PLACE).toEqual({ room: "", privacy: "shared", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: null })
    expect(BUILT_IN_WEB_VOICE_SETTINGS.capabilities).toEqual({ noDisplay: false, excludeKinds: [], noSpeaker: false })
    const { place: _p, ...without } = BUILT_IN_WEB_VOICE_SETTINGS
    expect(() => Schema.decodeUnknownSync(DeviceSettings)(without)).toThrow()
    // No trusted flag and no kids flag (docs/MODULES-PLAN.md §2 rows 5 and 9).
    expect(Object.keys(BUILT_IN_PLACE)).not.toContain("trusted")
    expect(Object.keys(BUILT_IN_PLACE)).not.toContain("kids")
  })

  it("resolve like every section: own value, then type defaults, then built-in, each taken whole", () => {
    const typePlace = { ...BUILT_IN_PLACE, privacy: "public" as const, room: "Hall" }
    const typeDefaults = Schema.decodeUnknownSync(DeviceOwn)({ place: typePlace })
    expect(effectiveDeviceSettings(BUILT_IN_WEB_VOICE_SETTINGS, undefined, undefined).place).toEqual(BUILT_IN_PLACE)
    expect(effectiveDeviceSettings(BUILT_IN_WEB_VOICE_SETTINGS, typeDefaults, undefined).place).toEqual(typePlace)
    const own = { ...BUILT_IN_PLACE, room: "Kitchen", defaultPerson: "p-sam00001" }
    expect(effectiveDeviceSettings(BUILT_IN_WEB_VOICE_SETTINGS, typeDefaults, { place: own }).place).toEqual(own)
    const overrides = { noDisplay: true, excludeKinds: [], noSpeaker: false }
    expect(effectiveDeviceSettings(BUILT_IN_WEB_VOICE_SETTINGS, typeDefaults, { capabilities: overrides }).capabilities).toEqual(overrides)
    expect(effectiveDeviceSettings(BUILT_IN_WEB_VOICE_SETTINGS, typeDefaults, { capabilities: overrides }).place).toEqual(typePlace)
  })

  it("a default person must be a person id; a room has at most 60 characters", () => {
    const decode = Schema.decodeUnknownSync(DeviceOwn)
    expect(() => decode({ place: { ...BUILT_IN_PLACE, defaultPerson: "Not An Id" } })).toThrow()
    expect(() => decode({ place: { ...BUILT_IN_PLACE, room: "x".repeat(61) } })).toThrow()
    expect(() => decode({ place: { ...BUILT_IN_PLACE, privacy: "secret" } })).toThrow()
  })
})
