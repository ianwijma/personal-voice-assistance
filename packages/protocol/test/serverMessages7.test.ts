// Protocol 7 on the wire: the messages merged into the main unions, decoded through the codec the way a peer receives
// them (docs/ASSISTANTS.md §5). Complements assistants.test.ts, which checks the schemas and examples directly.
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  AdminSnapshot,
  decodeClientMessage,
  decodeServerMessage,
  DeviceListInfo,
  FieldError,
  FieldPath,
  PROTOCOL_VERSION
} from "../src/index.ts"
import {
  assistantsClientExamples,
  assistantsServerExamples,
  clientExamples,
  exampleAdminSnapshot,
  exampleDevice,
  exampleSnapshot,
  serverExamples
} from "../src/examples.ts"

const accepts = (schema: Schema.Codec<any, any>, value: unknown) => Schema.decodeUnknownResult(schema as never)(value)._tag === "Success"

describe("FieldPath", () => {
  it("accepts a form key and the dotted path of an assistant or device field", () => {
    for (const path of ["voice", "hearing.finalSilenceMs", "modules.weather.own.units", "assistants.0.phrases", "a-b_c.d"]) {
      expect(accepts(FieldPath, path), path).toBe(true)
    }
  })
  it("rejects an empty path, a leading digit, dot or dash, spaces, other characters and more than 128 characters", () => {
    for (const path of ["", "1abc", ".hearing", "-x", "hearing finalSilenceMs", "hearing[0]", "héaring", "a\n"]) {
      expect(accepts(FieldPath, path), JSON.stringify(path)).toBe(false)
    }
    expect(accepts(FieldPath, "a".repeat(128))).toBe(true)
    expect(accepts(FieldPath, "a".repeat(129))).toBe(false)
  })
  it("a FieldError names a path, or null for the form as a whole", () => {
    expect(accepts(FieldError, { key: "hearing.finalSilenceMs", message: "m" })).toBe(true)
    expect(accepts(FieldError, { key: null, message: "m" })).toBe(true)
    expect(accepts(FieldError, { key: "hearing..", message: "m" })).toBe(true)
    expect(accepts(FieldError, { key: "no spaces", message: "m" })).toBe(false)
    expect(accepts(FieldError, { message: "m" })).toBe(false)
  })
})

describe("result on the wire", () => {
  // not `encodeServerMessage`: it validates, and these are frames a misbehaving peer could send
  const failed = (error: object) => JSON.stringify({ type: "result", requestId: "r", ok: false, error })

  it("carries dotted field errors and warnings of a refused save", () => {
    const message = {
      type: "result",
      requestId: "r7",
      ok: false,
      error: {
        code: "invalid_settings",
        message: "Check the values",
        fieldErrors: [{ key: "hearing.finalSilenceMs", message: "Too short" }, { key: null, message: "Nothing to save" }],
        warnings: [{ key: "llm.model", message: "Not downloaded yet" }]
      }
    } as const
    expect(decodeServerMessage(JSON.stringify(message))).toEqual({ _tag: "Ok", message })
  })
  it("a field error with a bad path makes the whole message invalid", () => {
    const text = failed({ code: "invalid_settings", message: "m", fieldErrors: [{ key: "bad path", message: "m" }] })
    expect(decodeServerMessage(text)).toMatchObject({ _tag: "Invalid", messageType: "result" })
  })
  it("assistantId is optional, and an assistant id of the wrong shape is refused", () => {
    expect(decodeServerMessage(JSON.stringify({ type: "result", requestId: "r", ok: true }))).toMatchObject({ _tag: "Ok" })
    for (const assistantId of ["Keuken", "", "has space", 7]) {
      const text = JSON.stringify({ type: "result", requestId: "r", ok: true, assistantId })
      expect(decodeServerMessage(text), JSON.stringify(assistantId)).toMatchObject({ _tag: "Invalid", messageType: "result" })
    }
  })
  it("each protocol 7 error code decodes from its wire spelling; its near misses do not", () => {
    for (const code of ["stale", "duplicate_phrase", "unknown_assistant", "limit_reached", "not_allowed"]) {
      expect(decodeServerMessage(failed({ code, message: "m" })), code).toMatchObject({ _tag: "Ok" })
    }
    for (const code of ["Stale", "duplicate-phrase", "unknown_assistants", "limit", "not allowed", ""]) {
      expect(decodeServerMessage(failed({ code, message: "m" })), code).toMatchObject({ _tag: "Invalid" })
    }
  })
})

describe("DeviceListInfo", () => {
  const without = <K extends keyof DeviceListInfo>(key: K) => {
    const { [key]: _removed, ...rest } = exampleDevice
    return rest
  }

  it("is the protocol 5 entry plus own, settings, hearer and rev: every one of the four is required", () => {
    expect(accepts(DeviceListInfo, exampleDevice)).toBe(true)
    for (const key of ["own", "settings", "hearer", "rev"] as const) expect(accepts(DeviceListInfo, without(key)), key).toBe(false)
    // the protocol 5 fields that stayed are still required; the profile fields (overrides, profile) are gone
    for (const key of ["connections", "audioOwner"] as const) expect(accepts(DeviceListInfo, without(key)), key).toBe(false)
    expect(Object.keys(DeviceListInfo.fields)).not.toContain("overrides")
    expect(Object.keys(DeviceListInfo.fields)).not.toContain("profile")
    expect(exampleDevice).not.toHaveProperty("overrides")
    expect(exampleDevice).not.toHaveProperty("profile")
  })
  it("hearer is an assistant id or null (no assistant: no recogniser)", () => {
    expect(accepts(DeviceListInfo, { ...exampleDevice, hearer: null })).toBe(true)
    expect(accepts(DeviceListInfo, { ...exampleDevice, hearer: "t3" })).toBe(true)
    for (const hearer of ["", "Jeff", "a b", undefined, 3]) expect(accepts(DeviceListInfo, { ...exampleDevice, hearer }), String(hearer)).toBe(false)
  })
  it("rev is a whole number from 0 up", () => {
    expect(accepts(DeviceListInfo, { ...exampleDevice, rev: 0 })).toBe(true)
    for (const rev of [-1, 0.5, Number.NaN, "1"]) expect(accepts(DeviceListInfo, { ...exampleDevice, rev }), String(rev)).toBe(false)
  })
  it("own holds only valid sections; settings must be complete", () => {
    expect(accepts(DeviceListInfo, { ...exampleDevice, own: {} })).toBe(true)
    expect(accepts(DeviceListInfo, { ...exampleDevice, own: { interruptMode: "sometimes" } })).toBe(false)
    expect(accepts(DeviceListInfo, { ...exampleDevice, own: { assistants: [{ assistant: "Jeff", phrases: [] }] } })).toBe(false)
    const { audio: _audio, ...incomplete } = exampleDevice.settings
    expect(accepts(DeviceListInfo, { ...exampleDevice, settings: incomplete })).toBe(false)
  })
  it("a devices message and admin.snapshot.devices reject a device without the protocol 7 fields", () => {
    const old = without("hearer")
    expect(decodeServerMessage(JSON.stringify({ type: "devices", devices: [exampleDevice, old] }))).toMatchObject({ _tag: "Invalid", messageType: "devices" })
    expect(accepts(AdminSnapshot, { ...exampleAdminSnapshot, devices: [old] })).toBe(false)
    expect(accepts(AdminSnapshot, { ...exampleAdminSnapshot, devices: [exampleDevice] })).toBe(true)
  })
})

describe("the new messages through the codec", () => {
  it("a client message of protocol 7 that breaks a rule is Invalid with its type, not Unknown", () => {
    const ex = assistantsClientExamples
    const bad: ReadonlyArray<object> = [
      { ...ex["assistant.delete"], rev: -1 },
      { ...ex["assistant.delete"], id: "Not An Id" },
      { ...ex["device.pick"], withoutPhrase: "Jeff" },
      { ...ex["device.save"], target: { kind: "device", id: "" } },
      { ...ex["conversation.read"], assistantId: "" },
      { ...ex["assistant.create"], assistant: { ...ex["assistant.create"].assistant, name: undefined } },
      { ...ex["assistant.create"], copyOf: "Not An Id" }
    ]
    for (const message of bad) {
      expect(decodeClientMessage(JSON.stringify(message)), JSON.stringify(message).slice(0, 60)).toMatchObject({
        _tag: "Invalid",
        messageType: (message as { type: string }).type
      })
    }
  })
  it("conversation.history needs the request it answers, an assistant, a conversation id and a history", () => {
    const ok = assistantsServerExamples["conversation.history"]
    expect(decodeServerMessage(JSON.stringify(ok))).toEqual({ _tag: "Ok", message: ok })
    expect(decodeServerMessage(JSON.stringify({ ...ok, history: [] }))).toMatchObject({ _tag: "Ok" })
    for (const patch of [{ requestId: undefined }, { assistantId: "Jeff" }, { id: "" }, { id: "x".repeat(65) }, { history: undefined }, { history: [{ role: "robot" }] }]) {
      expect(decodeServerMessage(JSON.stringify({ ...ok, ...patch })), JSON.stringify(patch)).toMatchObject({ _tag: "Invalid", messageType: "conversation.history" })
    }
  })
  it("device.setup is the setup's own fields next to the tag; deviceId may be absent (a connection without a device)", () => {
    const setup = assistantsServerExamples["device.setup"]
    const { deviceId: _deviceId, ...noDevice } = setup
    expect(decodeServerMessage(JSON.stringify(noDevice))).toEqual({ _tag: "Ok", message: noDevice })
    expect(decodeServerMessage(JSON.stringify({ ...setup, withoutPhrase: { mode: "assistant" } }))).toMatchObject({ _tag: "Invalid", messageType: "device.setup" })
    expect(decodeServerMessage(JSON.stringify({ ...setup, withoutPhrase: { mode: "everyone" } }))).toMatchObject({ _tag: "Invalid" })
    expect(decodeServerMessage(JSON.stringify({ ...setup, canPick: "yes" }))).toMatchObject({ _tag: "Invalid" })
    // a typesafe fallback may be null (no assistant to fall back on)
    expect(decodeServerMessage(JSON.stringify({ ...setup, withoutPhrase: { mode: "typesafe", fallback: null } }))).toMatchObject({ _tag: "Ok" })
  })
  it("a setup or device list does not decode as the other message of the same shape", () => {
    expect(decodeServerMessage(JSON.stringify({ ...assistantsServerExamples["device.setup"], type: "device.types" }))).toMatchObject({ _tag: "Invalid", messageType: "device.types" })
    expect(decodeServerMessage(JSON.stringify({ type: "assistants", assistants: assistantsServerExamples["device.types"].types }))).toMatchObject({ _tag: "Invalid", messageType: "assistants" })
  })
  it("the protocol 5 front-end messages that stayed are in the unions next to the new ones; the replaced ones are Unknown", () => {
    expect(decodeClientMessage(JSON.stringify(clientExamples["device.forget"]))).toMatchObject({ _tag: "Ok" })
    expect(decodeClientMessage(JSON.stringify(clientExamples["wake.test"]))).toMatchObject({ _tag: "Ok" })
    expect(decodeServerMessage(JSON.stringify(serverExamples.devices))).toMatchObject({ _tag: "Ok" })
    expect(decodeClientMessage(JSON.stringify({ type: "device.update", requestId: "r", patch: {} }))).toEqual({ _tag: "Unknown", messageType: "device.update" })
    expect(decodeServerMessage(JSON.stringify({ type: "frontends", frontends: [] }))).toEqual({ _tag: "Unknown", messageType: "frontends" })
  })
})

describe("version 7 handling", () => {
  it("the welcome example and the hello example speak the current version", () => {
    expect(PROTOCOL_VERSION).toBe(7)
    expect(serverExamples.welcome.protocol).toBe(PROTOCOL_VERSION)
    expect(clientExamples.hello.protocol).toBe(PROTOCOL_VERSION)
  })
  it("a hello of another version still decodes (the server answers with the mismatch close), a fractional one does not", () => {
    for (const protocol of [0, 6, 8]) {
      expect(decodeClientMessage(JSON.stringify({ ...clientExamples.hello, protocol })), String(protocol)).toMatchObject({ _tag: "Ok" })
    }
    expect(decodeClientMessage(JSON.stringify({ ...clientExamples.hello, protocol: 7.5 }))).toMatchObject({ _tag: "Invalid", messageType: "hello" })
  })
  it("a welcome carries the voice snapshot's setup and conversations, and refuses a setup that is not one", () => {
    const { type: _type, ...setup } = assistantsServerExamples["device.setup"]
    const conversations = [{ assistantId: "jeff", id: "c1", startedAt: 1_763_099_400_000, turns: 2 }]
    const welcome = (snapshot: object) => JSON.stringify({ ...serverExamples.welcome, snapshot })
    expect(decodeServerMessage(welcome({ ...exampleSnapshot, setup, conversations }))).toMatchObject({
      _tag: "Ok",
      message: { snapshot: { setup: { canPick: setup.canPick }, conversations } }
    })
    expect(decodeServerMessage(welcome({ ...exampleSnapshot, setup: { ...setup, canPick: 1 } }))).toMatchObject({ _tag: "Invalid", messageType: "welcome" })
    expect(decodeServerMessage(welcome({ ...exampleSnapshot, conversations: [{ ...conversations[0], turns: -1 }] }))).toMatchObject({ _tag: "Invalid", messageType: "welcome" })
  })
})
