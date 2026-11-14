import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  applyProfilePatch,
  DEFAULT_DEVICE_PROFILE,
  decodeClientMessage,
  decodeServerMessage,
  DeviceProfile,
  effectiveProfile,
  encodeServerMessage,
  engineSummary,
  PROFILE_FIELDS,
  ProfileField,
  ProfileOverrides,
  ProfilePatch,
  patchFields,
  PROTOCOL_VERSION,
  wakeWords
} from "../src/index.ts"
import {
  clientExamples,
  exampleAdminHello,
  exampleEngineStatus,
  exampleLoginResult,
  serverExamples
} from "../src/examples.ts"

const decodeProfile = Schema.decodeUnknownResult(DeviceProfile)
const okProfile = (v: unknown) => decodeProfile(v)._tag === "Success"

describe("protocol 5", () => {

  it("hello needs a front-end role; device and adminToken are optional and validated", () => {
    const { frontend: _f, ...noRole } = clientExamples.hello
    expect(decodeClientMessage(JSON.stringify(noRole))).toMatchObject({ _tag: "Invalid", messageType: "hello" })
    expect(decodeClientMessage(JSON.stringify({ ...clientExamples.hello, frontend: "kiosk" }))._tag).toBe("Invalid")
    expect(decodeClientMessage(JSON.stringify(exampleAdminHello))).toEqual({ _tag: "Ok", message: exampleAdminHello })
    expect(decodeClientMessage(JSON.stringify({ ...exampleAdminHello, adminToken: "short" }))._tag).toBe("Invalid")
    const badDevice = { ...clientExamples.hello, device: { id: "x", kind: "web-voice", name: "A" } }
    expect(decodeClientMessage(JSON.stringify(badDevice))._tag).toBe("Invalid")
    const blankName = { ...clientExamples.hello, device: { ...clientExamples.hello.device!, name: "   " } }
    expect(decodeClientMessage(JSON.stringify(blankName))._tag).toBe("Invalid")
  })

  it("audio.claim and audio.config no longer carry interruptMode (stripped like any unknown field)", () => {
    const decoded = decodeClientMessage(JSON.stringify({ ...clientExamples["audio.claim"], interruptMode: "manual" }))
    expect(decoded).toEqual({ _tag: "Ok", message: clientExamples["audio.claim"] })
  })

  it("the welcome snapshot has no admin data", () => {
    const snapshot = serverExamples.welcome.snapshot as Record<string, unknown>
    for (const key of ["modules", "sections", "traces", "vault", "env", "models", "jobs", "frontends", "devices"]) {
      expect(key in snapshot).toBe(false)
    }
    // An admin field sent in the voice snapshot is stripped, never passed on.
    const withModules = { ...serverExamples.welcome, snapshot: { ...serverExamples.welcome.snapshot, modules: [] } }
    const decoded = decodeServerMessage(JSON.stringify(withModules))
    expect(decoded._tag).toBe("Ok")
    expect("modules" in (decoded as { message: { snapshot: object } }).message.snapshot).toBe(false)
  })

  it("asleep is a server state", () => {
    expect(decodeServerMessage(JSON.stringify({ type: "state", state: "asleep" }))._tag).toBe("Ok")
  })

  it("a successful login result carries the session", () => {
    expect(decodeServerMessage(encodeServerMessage(exampleLoginResult))).toEqual({ _tag: "Ok", message: exampleLoginResult })
  })

  it("admin_required and unknown_device are error codes", () => {
    for (const code of ["admin_required", "unknown_device"]) {
      const message = { type: "result", requestId: "r1", ok: false, error: { code, message: "x" } }
      expect(decodeServerMessage(JSON.stringify(message))._tag).toBe("Ok")
    }
  })

  it("engineSummary: ready and the enabled voices only", () => {
    const withDisabled = {
      ...exampleEngineStatus,
      voices: [...exampleEngineStatus.voices, { ...exampleEngineStatus.voices[0]!, name: "off", enabled: false, isDefault: false }]
    }
    expect(engineSummary(withDisabled)).toEqual({
      ready: true,
      state: "ready",
      voices: [
        { name: "standard", description: "Everyday answers: quick and clear.", isDefault: true },
        { name: "natural", description: "Longer replies where warmth matters.", isDefault: false }
      ]
    })
    expect(engineSummary({ ...exampleEngineStatus, state: "failed" })).toEqual({ ready: false, state: "failed", voices: [] })
    expect(engineSummary({ ...exampleEngineStatus, state: "starting" })).toEqual({ ready: false, state: "starting", voices: [] })
  })
})

describe("device profiles", () => {
  it("the built-in defaults are a valid profile and every field is listed", () => {
    expect(okProfile(DEFAULT_DEVICE_PROFILE)).toBe(true)
    expect([...PROFILE_FIELDS].sort()).toEqual(Object.keys(DEFAULT_DEVICE_PROFILE).sort())
    expect([...ProfileField.literals].sort()).toEqual(Object.keys(ProfileOverrides.fields).sort())
    expect([...ProfileField.literals].sort()).toEqual(Object.keys(ProfilePatch.fields).sort())
  })

  it("bounds: phrases 1..12, 1..6 words each; follow-up 0..60 whole seconds; prebuffer 20..500", () => {
    const p = DEFAULT_DEVICE_PROFILE
    expect(okProfile({ ...p, wakePhrases: [] })).toBe(false)
    expect(okProfile({ ...p, wakePhrases: Array.from({ length: 12 }, (_, i) => `hey ${i}`) })).toBe(true)
    expect(okProfile({ ...p, wakePhrases: Array.from({ length: 13 }, (_, i) => `hey ${i}`) })).toBe(false)
    expect(okProfile({ ...p, wakePhrases: ["one two three four five six"] })).toBe(true)
    expect(okProfile({ ...p, wakePhrases: ["one two three four five six seven"] })).toBe(false)
    expect(okProfile({ ...p, wakePhrases: ["  ,!  "] })).toBe(false)
    expect(okProfile({ ...p, wakePhrases: ["x".repeat(61)] })).toBe(false)
    expect(okProfile({ ...p, followUpSeconds: 0 })).toBe(true)
    expect(okProfile({ ...p, followUpSeconds: 60 })).toBe(true)
    expect(okProfile({ ...p, followUpSeconds: 61 })).toBe(false)
    expect(okProfile({ ...p, followUpSeconds: 1.5 })).toBe(false)
    expect(okProfile({ ...p, prebufferMs: 19 })).toBe(false)
    expect(okProfile({ ...p, prebufferMs: 500 })).toBe(true)
    expect(okProfile({ ...p, activation: "sometimes" })).toBe(false)
  })

  it("wakeWords normalises case, diacritics, punctuation and apostrophes", () => {
    expect(wakeWords("Hé, JEFF!  what's up?")).toEqual(["he", "jeff", "whats", "up"])
    expect(wakeWords("Hey  Jeff’s")).toEqual(["hey", "jeffs"])
    expect(wakeWords("...")).toEqual([])
  })

  it("patches: a value sets, null removes, absent keeps", () => {
    const start: ProfileOverrides = { voice: "natural", captions: false }
    const next = applyProfilePatch(start, { voice: null, followUpSeconds: 12 })
    expect(next).toEqual({ captions: false, followUpSeconds: 12 })
    expect(start).toEqual({ voice: "natural", captions: false })
    expect(patchFields({ voice: null, activation: "always" }).sort()).toEqual(["activation", "voice"])
    expect(patchFields({})).toEqual([])
  })

  it("effective profile: built-in ← kind ← device", () => {
    const profile = effectiveProfile({ activation: "wake-phrase", voice: "standard" }, { voice: "natural" })
    expect(profile).toEqual({ ...DEFAULT_DEVICE_PROFILE, activation: "wake-phrase", voice: "natural" })
  })

  it("device.update and frontend.update validate their patches", () => {
    const bad = { ...clientExamples["device.update"], patch: { followUpSeconds: 99 } }
    expect(decodeClientMessage(JSON.stringify(bad))._tag).toBe("Invalid")
    const badKind = { ...clientExamples["frontend.update"], kind: "Web Voice" }
    expect(decodeClientMessage(JSON.stringify(badKind))._tag).toBe("Invalid")
  })
})
