import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AdminSnapshot,
  applicableOwn,
  Assignment,
  Assistant,
  AssistantBody,
  AssistantInfo,
  assistantsById,
  AssistantsClientMessage,
  ClientMessage,
  ServerMessage,
  AssistantsServerMessage,
  assistantUsedOn,
  BUILT_IN_WEB_VOICE_SETTINGS,
  DEVICE_SETTINGS_KEYS,
  DeviceOwn,
  DeviceRecord,
  DeviceRecordInfo,
  DeviceSettings,
  DeviceSettingsPatch,
  DeviceSetup,
  deviceSetupFrom,
  DeviceTarget,
  DeviceTypeInfo,
  effectiveDeviceSettings,
  effectiveFollowUpSeconds,
  followUpMsFor,
  hearerOf,
  hearingFor,
  homeLineOf,
  linkedModuleDefaults,
  makeAssistantId,
  moduleInstances,
  PROTOCOL_VERSION,
  QuietSpell,
  reachOf,
  removeAssistantFromSettings,
  resolveModuleSettings,
  routeConfigFrom,
  Snapshot,
  toolAllowed,
  TraceInfo,
  typedTextTarget,
  typesafeCandidates,
  typesafeFallback,
  validateAssistant,
  validateDeviceSettings,
  WithoutPhrase
} from "../src/index.ts"
import {
  assistantsClientExamples,
  assistantsServerExamples,
  exampleAdminSnapshot,
  exampleAssistant,
  exampleAssistantInfo,
  exampleAssistantT3,
  exampleDevice,
  exampleDeviceRecord,
  exampleDeviceSettings,
  exampleDeviceSetup,
  exampleDeviceType,
  exampleSnapshot,
  exampleTrace
} from "../src/examples.ts"

const roundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A): A => {
  const encoded = Schema.encodeSync(schema)(value)
  // through JSON, as on the wire
  return Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(encoded)))
}
const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(value)._tag === "Success"

const jeff = exampleAssistant
const t3 = exampleAssistantT3
const byId = assistantsById([jeff, t3])
const settings = (patch: Partial<DeviceSettings> = {}): DeviceSettings => ({ ...exampleDeviceSettings, ...patch })

describe("protocol 7", () => {
  it("is protocol version 8 now (7 added these)", () => {
    expect(PROTOCOL_VERSION).toBe(8)
  })
})

describe("schema round trips", () => {
  it("Assistant, AssistantBody, AssistantInfo", () => {
    expect(roundTrip(Assistant, jeff)).toEqual(jeff)
    expect(roundTrip(Assistant, t3)).toEqual(t3)
    const { id: _i, rev: _r, ...body } = jeff
    expect(roundTrip(AssistantBody, body)).toEqual(body)
    expect(roundTrip(AssistantInfo, exampleAssistantInfo)).toEqual(exampleAssistantInfo)
  })
  it("Assistant bounds", () => {
    expect(accepts(Assistant, { ...jeff, id: "Jeff" })).toBe(false)
    expect(accepts(Assistant, { ...jeff, id: "1jeff" })).toBe(false)
    expect(accepts(Assistant, { ...jeff, id: "a".repeat(33) })).toBe(false)
    expect(accepts(Assistant, { ...jeff, name: "" })).toBe(false)
    expect(accepts(Assistant, { ...jeff, name: "x".repeat(33) })).toBe(false)
    expect(accepts(Assistant, { ...jeff, prompt: "x".repeat(4001) })).toBe(false)
    expect(accepts(Assistant, { ...jeff, toolRounds: 11 })).toBe(false)
    expect(accepts(Assistant, { ...jeff, followUpSeconds: 121 })).toBe(false)
    expect(accepts(Assistant, { ...jeff, confirmActions: "on" })).toBe(false)
    expect(accepts(Assistant, { ...jeff, llm: { ...jeff.llm, account: "openai" } })).toBe(false)
    expect(accepts(Assistant, { ...jeff, llm: { ...jeff.llm, maxTokens: 63 } })).toBe(false)
    expect(accepts(Assistant, { ...jeff, hearing: { ...jeff.hearing, language: "xx" } })).toBe(false)
    expect(accepts(Assistant, { ...jeff, hearing: { ...jeff.hearing, vadThreshold: 0.96 } })).toBe(false)
    expect(accepts(Assistant, { ...jeff, voice: { provider: "Piper", voiceId: "x" } })).toBe(false)
    expect(accepts(Assistant, { ...jeff, modules: { weather: { on: true, offTools: Array.from({ length: 65 }, (_, i) => `t${i}`) } } })).toBe(false)
    expect(accepts(Assistant, { ...jeff, rev: -1 })).toBe(false)
  })
  it("QuietSpell", () => {
    for (const v of ["never", 1, 1440] as const) expect(roundTrip(QuietSpell, v)).toBe(v)
    expect(accepts(QuietSpell, 0)).toBe(false)
    expect(accepts(QuietSpell, 1441)).toBe(false)
    expect(accepts(QuietSpell, "sometimes")).toBe(false)
  })
  it("Assignment and WithoutPhrase", () => {
    const a = { assistant: "jeff", phrases: ["hey jeff"], followUpSeconds: 0 }
    expect(roundTrip(Assignment, a)).toEqual(a)
    expect(roundTrip(Assignment, { assistant: "jeff", phrases: [] })).toEqual({ assistant: "jeff", phrases: [] })
    expect(accepts(Assignment, { assistant: "jeff", phrases: Array.from({ length: 13 }, (_, i) => `hey ${i}`) })).toBe(false)
    expect(accepts(Assignment, { assistant: "jeff", phrases: ["!!!"] })).toBe(false)
    expect(accepts(Assignment, { assistant: "jeff", phrases: [], followUpSeconds: 121 })).toBe(false)
    for (const w of [
      { mode: "nobody" },
      { mode: "assistant", assistant: "t3" },
      { mode: "typesafe", fallback: null, giveUpMs: 400 },
      { mode: "typesafe", fallback: "jeff", giveUpMs: 100 }
    ] as const) expect(roundTrip(WithoutPhrase, w)).toEqual(w)
    expect(accepts(WithoutPhrase, { mode: "typesafe", fallback: null, giveUpMs: 99 })).toBe(false)
    expect(accepts(WithoutPhrase, { mode: "typesafe", fallback: null, giveUpMs: 2001 })).toBe(false)
    expect(accepts(WithoutPhrase, { mode: "assistant" })).toBe(false)
    expect(accepts(WithoutPhrase, { mode: "anyone" })).toBe(false)
  })
  it("DeviceSettings, DeviceOwn, DeviceSettingsPatch, DeviceRecord", () => {
    expect(roundTrip(DeviceSettings, exampleDeviceSettings)).toEqual(exampleDeviceSettings)
    expect(roundTrip(DeviceSettings, BUILT_IN_WEB_VOICE_SETTINGS)).toEqual(BUILT_IN_WEB_VOICE_SETTINGS)
    const own = { interruptMode: "instant", captions: { captions: false, speakTyped: true } } as const
    expect(roundTrip(DeviceOwn, own)).toEqual(own)
    expect(roundTrip(DeviceOwn, {})).toEqual({})
    expect(accepts(DeviceOwn, { audio: { echoCancellation: true } })).toBe(false)
    const patch = { audio: null, assistants: [{ assistant: "jeff", phrases: [] }] }
    expect(roundTrip(DeviceSettingsPatch, patch)).toEqual(patch)
    const record = { kind: "web-voice", name: "Desk", firstSeen: 1, lastSeen: 2, own }
    expect(roundTrip(DeviceRecord, record)).toEqual(record)
    expect(accepts(DeviceRecord, { ...record, name: "  " })).toBe(false)
    expect(accepts(DeviceSettings, { ...exampleDeviceSettings, assistants: Array.from({ length: 9 }, () => ({ assistant: "jeff", phrases: [] })) })).toBe(false)
    expect(accepts(DeviceSettings, { ...exampleDeviceSettings, interruptMode: "never" })).toBe(false)
    expect(accepts(DeviceSettings, { ...exampleDeviceSettings, audio: { ...exampleDeviceSettings.audio, prebufferMs: 10 } })).toBe(false)
  })
  it("DeviceTarget, DeviceTypeInfo, DeviceRecordInfo, DeviceSetup", () => {
    for (const t of [{ kind: "type", type: "web-voice" }, { kind: "device", id: "d-5c1e0b7a42" }] as const) {
      expect(roundTrip(DeviceTarget, t)).toEqual(t)
    }
    expect(accepts(DeviceTarget, { kind: "device", id: "x" })).toBe(false)
    expect(roundTrip(DeviceTypeInfo, exampleDeviceType)).toEqual(exampleDeviceType)
    expect(roundTrip(DeviceRecordInfo, exampleDeviceRecord)).toEqual(exampleDeviceRecord)
    expect(roundTrip(DeviceSetup, exampleDeviceSetup)).toEqual(exampleDeviceSetup)
  })
  it("Snapshot, AdminSnapshot and TraceInfo carry the protocol 7 additions", () => {
    const snapshot = {
      ...exampleSnapshot,
      conversations: [{ assistantId: "jeff", id: "c1", startedAt: 5, turns: 2 }],
      setup: exampleDeviceSetup
    }
    expect(roundTrip(Snapshot, snapshot)).toEqual(snapshot)
    const admin = { ...exampleAdminSnapshot, assistants: [exampleAssistantInfo], deviceTypes: [exampleDeviceType] }
    expect(roundTrip(AdminSnapshot, admin)).toEqual(admin)
    const routes = [
      { by: "phrase", phrase: "hey jeff" },
      { by: "armed", phrase: "hey t3" },
      { by: "follow-up" },
      { by: "default" },
      { by: "typed" },
      { by: "typesafe", outcome: "chosen", probability: 0.93, fits: 2, ms: 212, fallback: false },
      { by: "typesafe", outcome: "timeout", ms: 400, fallback: true }
    ] as const
    for (const route of routes) {
      const trace = {
        ...exampleTrace,
        assistant: { id: "jeff", name: "Jeff" },
        deviceId: "d-5c1e0b7a42",
        device: "iPhone",
        route,
        marks: { ...exampleTrace.marks, routeSent: -300, routeReceived: -90 },
        config: {
          llm: { account: "anthropic", model: "m", effort: "low", thinking: "off", maxTokens: 1024 },
          hearing: { hearer: "jeff", engine: "sherpa", model: "nemotron-3.5", language: "en", eagerSilenceMs: 250, finalSilenceMs: 600 },
          voice: "piper:en_US-lessac-medium",
          modules: 2,
          tools: 5,
          replyEarly: true,
          toolRounds: 3
        }
      }
      expect(roundTrip(TraceInfo, trace)).toEqual(trace)
    }
    expect(accepts(TraceInfo, { ...exampleTrace, route: { by: "magic" } })).toBe(false)
  })
  it("existing snapshots and traces still decode unchanged", () => {
    expect(roundTrip(Snapshot, exampleSnapshot)).toEqual(exampleSnapshot)
    expect(roundTrip(AdminSnapshot, exampleAdminSnapshot)).toEqual(exampleAdminSnapshot)
  })
})

describe("protocol 7 messages", () => {
  it("examples cover every new message type", () => {
    expect(Object.keys(assistantsClientExamples).sort()).toEqual([...AssistantsClientMessage.discriminants].sort())
    expect(Object.keys(assistantsServerExamples).sort()).toEqual([...AssistantsServerMessage.discriminants].sort())
  })
  for (const message of Object.values(assistantsClientExamples)) {
    it(`client ${message.type} round trips`, () => {
      expect(roundTrip(AssistantsClientMessage, message)).toEqual(message)
    })
  }
  for (const message of Object.values(assistantsServerExamples)) {
    it(`server ${message.type} round trips`, () => {
      expect(roundTrip(AssistantsServerMessage, message)).toEqual(message)
    })
  }
  it("rejects bad new messages", () => {
    const ex = assistantsClientExamples
    expect(accepts(AssistantsClientMessage, { ...ex["assistant.delete"], rev: -1 })).toBe(false)
    expect(accepts(AssistantsClientMessage, { ...ex["assistant.save"], assistant: { ...jeff, rev: undefined } })).toBe(false)
    expect(accepts(AssistantsClientMessage, { ...ex["device.pick"], withoutPhrase: "Jeff" })).toBe(false)
    expect(accepts(AssistantsClientMessage, { ...ex["device.pick"], withoutPhrase: "" })).toBe(true)
    expect(accepts(AssistantsClientMessage, { ...ex["device.save"], target: { kind: "device", id: "x" } })).toBe(false)
    expect(accepts(AssistantsClientMessage, { ...ex["device.save"], settings: { interruptMode: "x" } })).toBe(false)
  })
  it("a successful create result carries the id; the new error codes decode on the one result", () => {
    const ok = { type: "result", requestId: "a1", ok: true, assistantId: "keuken-2" } as const
    expect(roundTrip(ServerMessage, ok)).toEqual(ok)
    for (const code of ["stale", "duplicate_phrase", "unknown_assistant", "limit_reached", "not_allowed", "admin_required", "invalid_settings"]) {
      expect(accepts(ServerMessage, { type: "result", requestId: "r", ok: false, error: { code, message: "m" } })).toBe(true)
    }
    expect(accepts(ServerMessage, { type: "result", requestId: "r", ok: false, error: { code: "nope", message: "m" } })).toBe(false)
    expect(accepts(ServerMessage, { type: "result", requestId: "r", ok: false, error: { code: "invalid_settings", message: "m", fieldErrors: [{ key: "hearing.finalSilenceMs", message: "m" }] } })).toBe(true)
  })
  it("the new messages are members of the main unions; devices entries are a superset of the protocol 5 ones", () => {
    for (const type of AssistantsClientMessage.discriminants) expect(ClientMessage.discriminants).toContain(type)
    for (const type of AssistantsServerMessage.discriminants) expect(ServerMessage.discriminants).toContain(type)
    const { own: _o, settings: _s, hearer: _h, rev: _r, ...old } = exampleDevice
    expect(accepts(ServerMessage, { type: "devices", devices: [old] })).toBe(false)
    expect(accepts(ServerMessage, { type: "devices", devices: [exampleDevice] })).toBe(true)
  })
})

describe("effectiveDeviceSettings (section 2.6)", () => {
  const builtIn = BUILT_IN_WEB_VOICE_SETTINGS
  const typeDefaults = { interruptMode: "manual", assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }] } as const

  it("a device without its own section follows the type defaults", () => {
    const eff = effectiveDeviceSettings(builtIn, typeDefaults, {})
    expect(eff.interruptMode).toBe("manual")
    expect(eff.assistants).toEqual(typeDefaults.assistants)
  })
  it("its own section wins, whole, with no merging inside it", () => {
    const own = { audio: { ...builtIn.audio, speakAloud: false }, assistants: [{ assistant: "t3", phrases: [] }] }
    const eff = effectiveDeviceSettings(builtIn, typeDefaults, own)
    expect(eff.audio.speakAloud).toBe(false)
    expect(eff.assistants).toEqual([{ assistant: "t3", phrases: [] }])
    expect(eff.interruptMode).toBe("manual")
  })
  it("a section neither has comes from the built-in values", () => {
    const eff = effectiveDeviceSettings(builtIn, typeDefaults, undefined)
    expect(eff.captions).toEqual(builtIn.captions)
    expect(eff.matching).toBe("close")
    expect(Object.keys(eff).sort()).toEqual([...DEVICE_SETTINGS_KEYS].sort())
  })
  it("a type default entry that is complete hides the built-in values entirely", () => {
    const eff = effectiveDeviceSettings(builtIn, { ...builtIn, interruptMode: "instant" }, {})
    expect(eff.interruptMode).toBe("instant")
  })
  it("a changed type default reaches devices that have no own value, not the others", () => {
    const own = { interruptMode: "confirm" } as const
    expect(effectiveDeviceSettings(builtIn, { interruptMode: "instant" }, {}).interruptMode).toBe("instant")
    expect(effectiveDeviceSettings(builtIn, { interruptMode: "instant" }, own).interruptMode).toBe("confirm")
  })
  it("sections that do not apply to the kind are dropped from own by applicableOwn", () => {
    const own = { audio: builtIn.audio, captions: builtIn.captions, interruptMode: "instant" } as const
    expect(applicableOwn({ keys: ["interruptMode", "audio"] }, own)).toEqual({ audio: builtIn.audio, interruptMode: "instant" })
  })
})

describe("hearer, follow-up (section 2.6)", () => {
  it("the hearer is the assistant that answers without a phrase", () => {
    expect(hearerOf(settings({ withoutPhrase: { mode: "assistant", assistant: "t3" } }))).toBe("t3")
  })
  it("else the first in the list, also with TypeSafe and with nobody", () => {
    expect(hearerOf(settings({ withoutPhrase: { mode: "nobody" } }))).toBe("jeff")
    expect(hearerOf(settings({ withoutPhrase: { mode: "typesafe", fallback: "t3", giveUpMs: 400 } }))).toBe("jeff")
  })
  it("no assignment: no hearer", () => {
    expect(hearerOf(settings({ assistants: [], withoutPhrase: { mode: "nobody" } }))).toBeNull()
  })
  it("switching the hearer off does not change who hears", () => {
    const off = assistantsById([{ ...jeff, on: false }, t3])
    expect(hearerOf(settings())).toBe("jeff")
    expect(hearingFor(settings(), off)).toEqual(jeff.hearing)
  })
  it("the hearing settings are the hearer's, not the others'", () => {
    const other = { ...t3, hearing: { ...t3.hearing, language: "nl" as const } }
    const map = assistantsById([jeff, other])
    expect(hearingFor(settings({ withoutPhrase: { mode: "assistant", assistant: "t3" } }), map)?.language).toBe("nl")
    expect(hearingFor(settings(), map)?.language).toBe("auto")
    expect(hearingFor(settings({ assistants: [] }), map)).toBeUndefined()
  })
  it("the device's follow-up override wins over the assistant's, 0 included", () => {
    expect(effectiveFollowUpSeconds({}, jeff)).toBe(8)
    expect(effectiveFollowUpSeconds({ followUpSeconds: 20 }, jeff)).toBe(20)
    expect(effectiveFollowUpSeconds({ followUpSeconds: 0 }, jeff)).toBe(0)
    expect(followUpMsFor(settings(), byId, "jeff")).toBe(8000)
    expect(followUpMsFor(settings(), byId, "t3")).toBe(20_000)
    expect(followUpMsFor(settings(), byId, "nobody")).toBe(0)
    expect(followUpMsFor(settings({ assistants: [] }), byId, "jeff")).toBe(0)
  })
})

describe("routeConfigFrom", () => {
  it("collects every assignment's phrases in list order and keeps the matching", () => {
    const cfg = routeConfigFrom(settings({ matching: "exact" }), [jeff, t3])
    expect(cfg.phrases).toEqual([
      { phrase: "hey jeff", assistant: "jeff" },
      { phrase: "hey jev", assistant: "jeff" },
      { phrase: "hey t3", assistant: "t3" }
    ])
    expect(cfg.match).toBe("exact")
    expect(cfg.off.size).toBe(0)
    expect(cfg.armedMs).toBeUndefined()
  })
  it("withoutPhrase: nobody, assistant (with the default) and decide for TypeSafe", () => {
    expect(routeConfigFrom(settings({ withoutPhrase: { mode: "nobody" } }), [jeff, t3])).toMatchObject({ withoutPhrase: "nobody" })
    const one = routeConfigFrom(settings({ withoutPhrase: { mode: "assistant", assistant: "t3" } }), [jeff, t3])
    expect(one).toMatchObject({ withoutPhrase: "assistant", defaultAssistant: "t3" })
    const decide = routeConfigFrom(settings(), [jeff, t3])
    expect(decide.withoutPhrase).toBe("decide")
    expect("defaultAssistant" in decide).toBe(false)
  })
  it("a switched-off assistant is in off, and so is one that does not exist", () => {
    const cfg = routeConfigFrom(settings({ assistants: [...settings().assistants, { assistant: "ghost", phrases: ["hey ghost"] }] }), [{ ...jeff, on: false }, t3])
    expect([...cfg.off].sort()).toEqual(["ghost", "jeff"])
    // its phrase is still in the list, so the gate drops the utterance instead of letting another assistant take it
    expect(cfg.phrases.some((p) => p.assistant === "jeff")).toBe(true)
  })
  it("accepts a map as well as a list", () => {
    expect(routeConfigFrom(settings(), byId).phrases).toHaveLength(3)
  })
  it("is a plain structural value", () => {
    const cfg = routeConfigFrom(settings(), [jeff, t3])
    expect(Object.keys(cfg).sort()).toEqual(["fallback", "followUpMs", "match", "off", "phrases", "withoutPhrase"])
  })
})

describe("typed text, TypeSafe candidates and fallback (section 2.6)", () => {
  const on = byId
  it("the named assistant first", () => {
    expect(typedTextTarget(settings({ withoutPhrase: { mode: "assistant", assistant: "jeff" } }), on, { named: "t3", followUpHolder: "jeff" })).toEqual({ assistant: "t3" })
  })
  it("else the follow-up holder", () => {
    expect(typedTextTarget(settings({ withoutPhrase: { mode: "assistant", assistant: "jeff" } }), on, { followUpHolder: "t3" })).toEqual({ assistant: "t3" })
  })
  it("else the without-phrase assistant, else the TypeSafe fallback, else the first", () => {
    expect(typedTextTarget(settings({ withoutPhrase: { mode: "assistant", assistant: "t3" } }), on)).toEqual({ assistant: "t3" })
    expect(typedTextTarget(settings({ withoutPhrase: { mode: "typesafe", fallback: "t3", giveUpMs: 400 } }), on)).toEqual({ assistant: "t3" })
    expect(typedTextTarget(settings({ withoutPhrase: { mode: "typesafe", fallback: null, giveUpMs: 400 } }), on)).toEqual({ assistant: "jeff" })
    expect(typedTextTarget(settings({ withoutPhrase: { mode: "nobody" } }), on)).toEqual({ assistant: "jeff" })
  })
  it("an unknown name is ignored; an empty list or a switched-off target drops the text", () => {
    expect(typedTextTarget(settings(), on, { named: "ghost" })).toEqual({ assistant: "jeff" })
    expect(typedTextTarget(settings({ assistants: [], withoutPhrase: { mode: "nobody" } }), on)).toEqual({ dropped: "none" })
    expect(typedTextTarget(settings(), assistantsById([{ ...t3, on: false }, jeff]), { named: "t3" })).toEqual({ dropped: "off" })
  })
  it("a named assistant that is not assigned to this device is ignored, even when it exists and is on", () => {
    const jeffOnly = settings({ assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }], withoutPhrase: { mode: "assistant", assistant: "jeff" } })
    expect(typedTextTarget(jeffOnly, on, { named: "t3" })).toEqual({ assistant: "jeff" })
  })
  it("TypeSafe never offers an off assistant; a fallback that is off means nobody", () => {
    const map = assistantsById([jeff, { ...t3, on: false }])
    expect(typesafeCandidates(settings(), map)).toEqual(["jeff"])
    expect(typesafeFallback(settings({ withoutPhrase: { mode: "typesafe", fallback: "t3", giveUpMs: 400 } }), map)).toBeNull()
    expect(typesafeFallback(settings({ withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 } }), map)).toBe("jeff")
    expect(typesafeFallback(settings({ withoutPhrase: { mode: "nobody" } }), map)).toBeNull()
    expect(typesafeFallback(settings({ withoutPhrase: { mode: "typesafe", fallback: null, giveUpMs: 400 } }), map)).toBeNull()
    expect(typesafeFallback(settings({ assistants: [], withoutPhrase: { mode: "typesafe", fallback: "jeff", giveUpMs: 400 } }), map)).toBeNull()
  })
})

describe("reach and where used", () => {
  it("reach order: without-phrase, phrase, typesafe, unreachable", () => {
    const s = settings({
      assistants: [
        { assistant: "jeff", phrases: ["hey jeff"] },
        { assistant: "t3", phrases: [] }
      ],
      withoutPhrase: { mode: "assistant", assistant: "jeff" }
    })
    expect(reachOf(s, "jeff")).toBe("without-phrase")
    expect(reachOf(s, "t3")).toBe("unreachable")
    expect(reachOf({ ...s, withoutPhrase: { mode: "typesafe", fallback: null, giveUpMs: 400 } }, "t3")).toBe("typesafe")
    expect(reachOf({ ...s, withoutPhrase: { mode: "nobody" } }, "jeff")).toBe("phrase")
    expect(reachOf(s, "other")).toBeUndefined()
  })
  it("usedOn lists the entries that assign the assistant, with the hearer", () => {
    const typeS = settings({ withoutPhrase: { mode: "nobody" } })
    const deviceS = settings({ assistants: [{ assistant: "t3", phrases: ["hey t3"] }], withoutPhrase: { mode: "nobody" } })
    const used = assistantUsedOn("t3", [
      { target: { kind: "type", type: "web-voice" }, settings: typeS },
      { target: { kind: "device", id: "d-5c1e0b7a42" }, settings: deviceS }
    ])
    expect(used).toEqual([
      { target: { kind: "type", type: "web-voice" }, hears: false, reach: "phrase" },
      { target: { kind: "device", id: "d-5c1e0b7a42" }, hears: true, reach: "phrase" }
    ])
  })
})

describe("validateDeviceSettings", () => {
  const known = new Set(["jeff", "t3"])
  const codes = (s: Parameters<typeof validateDeviceSettings>[0]) => validateDeviceSettings(s, known).errors.map((e) => e.code)

  it("accepts the example", () => {
    expect(validateDeviceSettings(exampleDeviceSettings, known)).toEqual({ errors: [], warnings: [] })
  })
  it("duplicate_phrase: the same phrase on two assignments, after normalisation", () => {
    expect(codes({
      assistants: [{ assistant: "jeff", phrases: ["Hey Jeff"] }, { assistant: "t3", phrases: ["hey, jeff!"] }],
      withoutPhrase: { mode: "nobody" }
    })).toEqual(["duplicate_phrase"])
  })
  it("duplicate_phrase: also twice on one assignment", () => {
    expect(codes({ assistants: [{ assistant: "jeff", phrases: ["hey jeff", "HEY JEFF"] }], withoutPhrase: { mode: "nobody" } })).toEqual(["duplicate_phrase"])
  })
  it("unknown_assistant in the list, withoutPhrase and fallback", () => {
    expect(codes({ assistants: [{ assistant: "ghost", phrases: ["a"] }], withoutPhrase: { mode: "nobody" } })).toEqual(["unknown_assistant"])
    expect(codes({ assistants: [{ assistant: "jeff", phrases: ["a"] }], withoutPhrase: { mode: "assistant", assistant: "ghost" } })).toEqual(["unknown_assistant"])
    expect(codes({ assistants: [{ assistant: "jeff", phrases: ["a"] }], withoutPhrase: { mode: "typesafe", fallback: "ghost", giveUpMs: 400 } })).toEqual(["unknown_assistant"])
  })
  it("an assistant once in the list; withoutPhrase and fallback only name assigned assistants", () => {
    expect(codes({ assistants: [{ assistant: "jeff", phrases: ["a"] }, { assistant: "jeff", phrases: ["b"] }], withoutPhrase: { mode: "nobody" } })).toEqual(["invalid"])
    expect(codes({ assistants: [{ assistant: "jeff", phrases: ["a"] }], withoutPhrase: { mode: "assistant", assistant: "t3" } })).toEqual(["invalid"])
    expect(codes({ assistants: [{ assistant: "jeff", phrases: ["a"] }], withoutPhrase: { mode: "typesafe", fallback: "t3", giveUpMs: 400 } })).toEqual(["invalid"])
  })
  it("limits: 8 assignments, 32 phrases per device", () => {
    const ids = Array.from({ length: 9 }, (_, i) => `a${i}`)
    expect(validateDeviceSettings({ assistants: ids.map((assistant) => ({ assistant, phrases: [] })), withoutPhrase: { mode: "nobody" } }, new Set(ids)).errors.map((e) => e.code)).toContain("limit_reached")
    const many = ["a", "b", "c"].map((assistant, i) => ({ assistant, phrases: Array.from({ length: 12 }, (_, j) => `hey ${i} ${j}`) }))
    expect(validateDeviceSettings({ assistants: many, withoutPhrase: { mode: "nobody" } }, new Set(["a", "b", "c"])).errors.map((e) => e.code)).toEqual(["limit_reached"])
  })
  it("warns about an assistant that cannot be reached, not when TypeSafe is on", () => {
    const s = { assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }, { assistant: "t3", phrases: [] }], withoutPhrase: { mode: "nobody" } } as const
    const v = validateDeviceSettings(s, known)
    expect(v.errors).toEqual([])
    expect(v.warnings.map((w) => w.code)).toEqual(["unreachable"])
    expect(validateDeviceSettings({ ...s, withoutPhrase: { mode: "typesafe", fallback: null, giveUpMs: 400 } }, known).warnings).toEqual([])
  })
})

describe("deleting an assistant (section 2.6)", () => {
  const list = [{ assistant: "jeff", phrases: ["hey jeff"] }, { assistant: "t3", phrases: ["hey t3"] }, { assistant: "keuken", phrases: [] }]
  it("is removed from every assignment list", () => {
    const out = removeAssistantFromSettings({ assistants: list }, "t3")
    expect(out.assistants?.map((a) => a.assistant)).toEqual(["jeff", "keuken"])
  })
  it("withoutPhrase naming it becomes nobody", () => {
    expect(removeAssistantFromSettings({ assistants: list, withoutPhrase: { mode: "assistant", assistant: "t3" } }, "t3").withoutPhrase).toEqual({ mode: "nobody" })
    expect(removeAssistantFromSettings({ withoutPhrase: { mode: "assistant", assistant: "jeff" } }, "t3").withoutPhrase).toEqual({ mode: "assistant", assistant: "jeff" })
  })
  it("a TypeSafe fallback naming it becomes the first remaining assistant, or null", () => {
    const wp = { mode: "typesafe", fallback: "jeff", giveUpMs: 250 } as const
    expect(removeAssistantFromSettings({ assistants: list, withoutPhrase: wp }, "jeff").withoutPhrase).toEqual({ ...wp, fallback: "t3" })
    expect(removeAssistantFromSettings({ assistants: [list[0]!], withoutPhrase: wp }, "jeff").withoutPhrase).toEqual({ ...wp, fallback: null })
    expect(removeAssistantFromSettings({ assistants: list, withoutPhrase: wp }, "t3").withoutPhrase).toEqual(wp)
  })
  it("a device's own withoutPhrase uses the inherited list when it has none of its own", () => {
    const wp = { mode: "typesafe", fallback: "jeff", giveUpMs: 400 } as const
    const out = removeAssistantFromSettings({ withoutPhrase: wp }, "jeff", list)
    expect(out.withoutPhrase).toEqual({ ...wp, fallback: "t3" })
    expect("assistants" in out).toBe(false)
  })
  it("deleting the last assistant leaves an empty list", () => {
    const out = removeAssistantFromSettings({ assistants: [list[0]!], withoutPhrase: { mode: "assistant", assistant: "jeff" } }, "jeff")
    expect(out).toEqual({ assistants: [], withoutPhrase: { mode: "nobody" } })
    expect(hearerOf({ assistants: out.assistants!, withoutPhrase: out.withoutPhrase! })).toBeNull()
  })
  it("does not change the input", () => {
    const input = { assistants: list }
    removeAssistantFromSettings(input, "jeff")
    expect(input.assistants).toHaveLength(3)
  })
})

describe("switched off (section 2.6)", () => {
  it("keeps assignments and phrases, and still hears", () => {
    const off = [{ ...jeff, on: false }, t3]
    const cfg = routeConfigFrom(settings(), off)
    expect(cfg.phrases.filter((p) => p.assistant === "jeff")).toHaveLength(2)
    expect(hearerOf(settings())).toBe("jeff")
    expect(cfg.off.has("jeff")).toBe(true)
  })
  it("the device setup still lists it, marked off", () => {
    const setup = deviceSetupFrom(settings(), assistantsById([{ ...jeff, on: false }, t3]), { canAuto: true })
    expect(setup.assistants.find((a) => a.id === "jeff")?.on).toBe(false)
  })
})

describe("deviceSetupFrom", () => {
  it("lists the assignments in order with phrases, never a prompt, model or handles", () => {
    expect(exampleDeviceSetup.assistants.map((a) => a.id)).toEqual(["jeff", "t3"])
    expect(exampleDeviceSetup.assistants[0]?.phrases).toEqual(["hey jeff", "hey jev"])
    expect(exampleDeviceSetup.withoutPhrase).toEqual({ mode: "typesafe", fallback: "jeff" })
    expect(JSON.stringify(exampleDeviceSetup)).not.toContain(jeff.prompt)
    expect(JSON.stringify(exampleDeviceSetup)).not.toContain(jeff.handles)
    expect(JSON.stringify(exampleDeviceSetup)).not.toContain(jeff.llm.model)
  })
  it("canPick needs the section on and more than one assistant", () => {
    expect(deviceSetupFrom(settings(), byId, { canAuto: false }).canPick).toBe(true)
    expect(deviceSetupFrom(settings({ voicePage: { pick: false } }), byId, { canAuto: false }).canPick).toBe(false)
    expect(deviceSetupFrom(settings({ assistants: [exampleDeviceSettings.assistants[0]!] }), byId, { canAuto: false }).canPick).toBe(false)
    expect(deviceSetupFrom(settings(), byId, { canAuto: false }).canAuto).toBe(false)
  })
  it("leaves out an assignment of an assistant that does not exist", () => {
    const s = settings({ assistants: [...settings().assistants, { assistant: "ghost", phrases: [] }] })
    expect(deviceSetupFrom(s, byId, { canAuto: true }).assistants).toHaveLength(2)
  })
})

describe("module settings (section 2.6)", () => {
  const overridable = ["units", "defaultPlace"]
  const shared = { units: "celsius", defaultPlace: "Amsterdam", apiKey: "shared" }
  const defaults = { units: "celsius", defaultPlace: "", extra: true }

  it("own value first, then shared, then the module default", () => {
    const eff = resolveModuleSettings({ choice: { own: { units: "fahrenheit" } }, overridable, shared: { defaultPlace: "Amsterdam" }, defaults })
    expect(eff).toEqual({ units: "fahrenheit", defaultPlace: "Amsterdam", extra: true })
  })
  it("shared by default: no own settings means the shared ones", () => {
    expect(resolveModuleSettings({ choice: { own: {} }, overridable, shared, defaults })).toEqual({ units: "celsius", defaultPlace: "Amsterdam", apiKey: "shared", extra: true })
    expect(resolveModuleSettings({ choice: undefined, overridable, shared, defaults })).toEqual({ units: "celsius", defaultPlace: "Amsterdam", apiKey: "shared", extra: true })
  })
  it("an own value for a field that is not overridable is ignored", () => {
    const eff = resolveModuleSettings({ choice: { own: { apiKey: "mine", units: "fahrenheit" } }, overridable, shared, defaults })
    expect(eff.apiKey).toBe("shared")
    expect(eff.units).toBe("fahrenheit")
  })
  it("linked defaults come from Home", () => {
    expect(linkedModuleDefaults({ units: "imperial", timeZone: "Europe/Amsterdam", dateFormat: "nl-NL" })).toEqual({
      weather: { defaultPlace: "", units: "fahrenheit" },
      clock: { timeZone: "Europe/Amsterdam", locale: "nl-NL" }
    })
    expect(linkedModuleDefaults({ units: "metric", timeZone: "", dateFormat: "en-GB" }).weather?.units).toBe("celsius")
    // Home accepts a zone with spaces around it (its check trims); the linked default is the bare zone.
    expect(linkedModuleDefaults({ location: " Utrecht ", units: "metric", timeZone: " Asia/Tokyo ", dateFormat: "en-GB" })).toEqual({
      weather: { defaultPlace: "Utrecht", units: "celsius" },
      clock: { timeZone: "Asia/Tokyo", locale: "en-GB" }
    })
    const eff = resolveModuleSettings({
      choice: undefined,
      overridable: ["timeZone", "locale"],
      shared: {},
      defaults: linkedModuleDefaults({ units: "metric", timeZone: "Europe/Berlin", dateFormat: "en-US" }).clock!
    })
    expect(eff).toEqual({ timeZone: "Europe/Berlin", locale: "en-US" })
    expect(linkedModuleDefaults({ location: "Utrecht", units: "metric", timeZone: "", dateFormat: "en-GB" }).weather).toEqual({ defaultPlace: "Utrecht", units: "celsius" })
  })
  it("the Home line: location, time zone (the machine's when Home names none), language", () => {
    expect(homeLineOf({ location: "Amsterdam, Netherlands", timeZone: "Europe/Amsterdam", language: "nl-NL" })).toBe(
      "Home: Amsterdam, Netherlands; time zone Europe/Amsterdam; language nl-NL."
    )
    expect(homeLineOf({ location: " ", timeZone: "", language: "en-GB", machineTimeZone: "Europe/London" })).toBe("Home: time zone Europe/London; language en-GB.")
    expect(homeLineOf({ location: "", timeZone: "", language: "" })).toBe("")
  })
  it("the Home line: trims every part, the machine's zone only when Home names none, nothing to say is empty", () => {
    expect(homeLineOf({ location: "  Utrecht ", timeZone: " Europe/Berlin ", language: " de-DE ", machineTimeZone: "Asia/Tokyo" })).toBe(
      "Home: Utrecht; time zone Europe/Berlin; language de-DE."
    )
    expect(homeLineOf({ location: "Utrecht", timeZone: "  ", language: "" })).toBe("Home: Utrecht.")
    expect(homeLineOf({ location: "", timeZone: "", language: "", machineTimeZone: "" })).toBe("")
    expect(homeLineOf({ location: "", timeZone: "", language: "nl-NL" })).toBe("Home: language nl-NL.")
  })
  it("linked defaults: Home without a location leaves the weather place empty; imperial maps to Fahrenheit", () => {
    expect(linkedModuleDefaults({ units: "imperial", timeZone: "", dateFormat: "nl-NL" })).toEqual({
      weather: { defaultPlace: "", units: "fahrenheit" },
      clock: { timeZone: "", locale: "nl-NL" }
    })
  })
  it("tools: allowed when the module is on and the tool not switched off", () => {
    expect(toolAllowed(jeff, "weather", "weather")).toBe(true)
    expect(toolAllowed(jeff, "clock", "set_timer")).toBe(false)
    expect(toolAllowed(jeff, "clock", "time")).toBe(true)
    expect(toolAllowed(jeff, "lights", "on")).toBe(false)
    expect(toolAllowed({ modules: { weather: { on: false, offTools: [] } } }, "weather", "weather")).toBe(false)
  })

  const modules = { weather: { overridable, tools: ["weather"] }, clock: { overridable: ["locale"], tools: ["time", "set_timer"] } }
  const sharedAll = { weather: { units: "celsius", defaultPlace: "" }, clock: { locale: "en-GB" } }
  const choice = (own?: Record<string, string>) => ({ on: true, offTools: [], ...(own ? { own } : {}) })

  it("a module runs while a switched-on assistant has it on; equal effective settings share one instance", () => {
    const a = { ...jeff, id: "a", modules: { weather: choice() } }
    const b = { ...jeff, id: "b", modules: { weather: choice({ units: "celsius" }) } }
    const c = { ...jeff, id: "c", modules: { weather: choice({ units: "fahrenheit" }) } }
    const list = moduleInstances({ assistants: [a, b, c], modules, shared: sharedAll, defaults: {} })
    expect(list).toHaveLength(2)
    expect(list.find((i) => i.assistants.includes("a"))?.assistants).toEqual(["a", "b"])
    expect(list.find((i) => i.assistants.includes("c"))?.settings.units).toBe("fahrenheit")
  })
  it("a switched-off assistant, an off module and an unconfigured module need no instance", () => {
    const a = { ...jeff, id: "a", on: false, modules: { weather: choice() } }
    const b = { ...jeff, id: "b", modules: { weather: { on: false, offTools: [] }, clock: choice() } }
    expect(moduleInstances({ assistants: [a, b], modules, shared: sharedAll, defaults: {} }).map((i) => i.moduleId)).toEqual(["clock"])
    expect(moduleInstances({ assistants: [b], modules, shared: sharedAll, defaults: {}, isConfigured: () => false })).toEqual([])
  })
  it("a module the catalog does not know is skipped", () => {
    const a = { ...jeff, id: "a", modules: { nope: choice() } }
    expect(moduleInstances({ assistants: [a], modules, shared: {}, defaults: {} })).toEqual([])
  })
  it("the instance key does not depend on key order", () => {
    const a = { ...jeff, id: "a", modules: { weather: choice() } }
    const x = moduleInstances({ assistants: [a], modules, shared: { weather: { units: "celsius", defaultPlace: "x" } }, defaults: {} })
    const y = moduleInstances({ assistants: [a], modules, shared: { weather: { defaultPlace: "x", units: "celsius" } }, defaults: {} })
    expect(x[0]?.key).toBe(y[0]?.key)
  })
})

describe("validateAssistant", () => {
  const { id: _i, rev: _r, ...body } = jeff
  const ctx = { others: [{ id: "t3", name: "T3" }] }
  const paths = (b: typeof body & { id?: string }, c: Parameters<typeof validateAssistant>[1] = ctx) => validateAssistant(b, c).map((i) => i.path)

  it("accepts the example", () => {
    expect(validateAssistant({ ...body, id: "jeff" }, ctx)).toEqual([])
  })
  it("a duplicate name, case-insensitively and trimmed; its own name is fine", () => {
    expect(paths({ ...body, name: " t3 " })).toEqual(["name"])
    expect(paths({ ...body, id: "t3", name: "T3" })).toEqual([])
  })
  it("a blank name", () => {
    expect(paths({ ...body, name: "   " })).toEqual(["name"])
  })
  it("final pause not above the eager pause", () => {
    expect(paths({ ...body, hearing: { ...body.hearing, eagerSilenceMs: 600, finalSilenceMs: 600 } })).toEqual(["hearing.finalSilenceMs"])
    expect(paths({ ...body, hearing: { ...body.hearing, eagerSilenceMs: 700, finalSilenceMs: 600 } })).toEqual(["hearing.finalSilenceMs"])
  })
  it("Deepgram thresholds: eager above 0 and not below the end-of-turn threshold", () => {
    const dg = (eager: number, eot: number) => ({ ...body, hearing: { ...body.hearing, deepgram: { ...body.hearing.deepgram, eagerEotThreshold: eager, eotThreshold: eot } } })
    expect(paths(dg(0.8, 0.7))).toEqual(["hearing.deepgram.eagerEotThreshold"])
    expect(paths(dg(0.7, 0.7))).toEqual(["hearing.deepgram.eagerEotThreshold"])
    expect(paths(dg(0, 0.7))).toEqual([])
    expect(paths(dg(0.4, 0.7))).toEqual([])
  })
  it("an empty model only for offline", () => {
    expect(paths({ ...body, llm: { ...body.llm, model: "" } })).toEqual(["llm.model"])
    expect(paths({ ...body, llm: { ...body.llm, account: "offline", model: "" } })).toEqual([])
  })
  it("own keys must be overridable and offTools must exist, when the catalog is given", () => {
    const modules = { weather: { overridable: ["units"], tools: ["weather"] }, clock: { overridable: [], tools: ["time", "set_timer"] } }
    expect(paths(body, { ...ctx, modules })).toEqual([])
    const bad = { ...body, modules: { weather: { on: true, offTools: ["forecast"], own: { apiKey: "x", units: "celsius" } } } }
    expect(paths(bad, { ...ctx, modules })).toEqual(["modules.weather.own.apiKey", "modules.weather.offTools"])
    expect(paths(bad, ctx)).toEqual([])
  })
})

describe("makeAssistantId", () => {
  it("makes ids that the schema accepts", () => {
    for (const name of ["Jeff", "T3", "Keuken", "  Éloïse's bot  ", "123", "!!!", "x".repeat(80)]) {
      const id = makeAssistantId(name)
      expect(accepts(Assistant.fields.id, id), `${name} -> ${id}`).toBe(true)
    }
    expect(makeAssistantId("Jeff")).toBe("jeff")
    expect(makeAssistantId("Éloïse")).toBe("eloise")
    expect(makeAssistantId("123")).toBe("a123")
    expect(makeAssistantId("!!!")).toBe("assistant")
  })
  it("never makes the device.pick value for \"whichever fits\", and the schema refuses it as an id", () => {
    const id = makeAssistantId("TypeSafe")
    expect(id).toBe("typesafe-2")
    expect(accepts(Assistant.fields.id, id)).toBe(true)
    expect(accepts(Assistant.fields.id, "typesafe")).toBe(false)
  })
  it("adds a number when the id is taken", () => {
    expect(makeAssistantId("Keuken", ["keuken"])).toBe("keuken-2")
    expect(makeAssistantId("Keuken", ["keuken", "keuken-2"])).toBe("keuken-3")
    const long = "x".repeat(32)
    const id = makeAssistantId(long, [long])
    expect(id).toHaveLength(32)
    expect(accepts(Assistant.fields.id, id)).toBe(true)
    expect(id.endsWith("-2")).toBe(true)
  })
})

describe("reserved assistant ids", () => {
  it("never gives an assistant an id the admin pages use as an address", () => {
    expect(makeAssistantId("All")).toBe("all-2")
    expect(makeAssistantId("New")).toBe("new-2")
  })
})
