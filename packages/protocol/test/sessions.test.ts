// Protocol 6: voice sessions and conversations (docs/VOICE-SESSIONS.md §4).
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  CONVERSATION_IDLE_MINUTES_LIMITS,
  DEFAULT_CONVERSATION_IDLE_MINUTES,
  DEFAULT_DEVICE_PROFILE,
  decodeClientMessage,
  decodeServerMessage,
  DeviceProfile,
  encodeServerMessage,
  ErrorCode,
  PROFILE_FIELDS,
  PROTOCOL_VERSION
} from "../src/index.ts"
import { clientExamples, exampleAdminSnapshot, exampleSnapshot, serverExamples } from "../src/examples.ts"

const valid = (schema: Schema.Codec<unknown, unknown>, value: unknown) => Schema.decodeUnknownResult(schema as never)(value)._tag === "Success"

describe("protocol 6", () => {
  it("is version 9 now (6 added these)", () => {
    expect(PROTOCOL_VERSION).toBe(11)
  })

  it("conversation.new is a request with an id", () => {
    expect(decodeClientMessage(JSON.stringify(clientExamples["conversation.new"]))).toEqual({ _tag: "Ok", message: clientExamples["conversation.new"] })
    expect(decodeClientMessage(JSON.stringify({ type: "conversation.new" }))).toMatchObject({ _tag: "Invalid", messageType: "conversation.new" })
  })

  it("conversation: id, reason new / idle / resumed, startedAt", () => {
    const message = serverExamples.conversation
    for (const reason of ["new", "idle", "resumed"]) {
      expect(decodeServerMessage(encodeServerMessage({ ...message, reason } as never))._tag).toBe("Ok")
    }
    expect(decodeServerMessage(JSON.stringify({ ...message, reason: "restart" }))._tag).toBe("Invalid")
    expect(decodeServerMessage(JSON.stringify({ ...message, id: "" }))._tag).toBe("Invalid")
    const { startedAt: _s, ...noStart } = message
    expect(decodeServerMessage(JSON.stringify(noStart))._tag).toBe("Invalid")
  })

  it("the snapshot carries the conversations (required); the admin snapshot the sessions (required)", () => {
    const welcome = serverExamples.welcome
    const { conversations: _c, ...without } = exampleSnapshot
    expect(decodeServerMessage(JSON.stringify({ ...welcome, snapshot: without }))._tag).toBe("Invalid")
    const { sessions: _s, ...noSessions } = exampleAdminSnapshot
    expect(decodeServerMessage(JSON.stringify({ type: "admin.snapshot", snapshot: noSessions }))._tag).toBe("Invalid")
    expect(decodeServerMessage(encodeServerMessage({ type: "admin.snapshot", snapshot: exampleAdminSnapshot }))._tag).toBe("Ok")
  })

  it("sessions: a session without a device has no deviceId and may have no turn yet", () => {
    const decoded = decodeServerMessage(encodeServerMessage({ type: "sessions", sessions: exampleAdminSnapshot.sessions }))
    expect(decoded).toEqual({ _tag: "Ok", message: { type: "sessions", sessions: exampleAdminSnapshot.sessions } })
    const [one] = exampleAdminSnapshot.sessions
    expect(decodeServerMessage(JSON.stringify({ type: "sessions", sessions: [{ ...one, turns: -1 }] }))._tag).toBe("Invalid")
    expect(decodeServerMessage(JSON.stringify({ type: "sessions", sessions: [{ ...one, deviceId: "x" }] }))._tag).toBe("Invalid")
  })

  it("trace: a session's finished turn for admin, with the session's key, device and name", () => {
    const message = serverExamples.trace
    expect(message.trace.session).toBe("iPhone · Safari")
    expect(decodeServerMessage(encodeServerMessage(message))).toEqual({ _tag: "Ok", message })
    const { deviceId: _d, ...withoutDevice } = message
    expect(decodeServerMessage(JSON.stringify(withoutDevice))._tag).toBe("Ok")
    expect(decodeServerMessage(JSON.stringify({ ...message, key: "" }))._tag).toBe("Invalid")
    expect(decodeServerMessage(JSON.stringify({ ...message, deviceId: "x" }))._tag).toBe("Invalid")
    const { trace: _t, ...withoutTrace } = message
    expect(decodeServerMessage(JSON.stringify(withoutTrace))._tag).toBe("Invalid")
  })

  it("sessions_full is an error code", () => {
    expect(valid(ErrorCode as never, "sessions_full")).toBe(true)
  })

  it("wake.test may name a device", () => {
    const { deviceId: _d, ...any } = clientExamples["wake.test"]
    expect(decodeClientMessage(JSON.stringify(any))._tag).toBe("Ok")
    expect(decodeClientMessage(JSON.stringify(clientExamples["wake.test"]))).toEqual({ _tag: "Ok", message: clientExamples["wake.test"] })
    expect(decodeClientMessage(JSON.stringify({ ...any, deviceId: "no" }))._tag).toBe("Invalid")
  })

  it("profile field conversationIdleMinutes: whole minutes 0..240, default 10, in every profile", () => {
    expect(PROFILE_FIELDS).toContain("conversationIdleMinutes")
    expect(DEFAULT_DEVICE_PROFILE.conversationIdleMinutes).toBe(DEFAULT_CONVERSATION_IDLE_MINUTES)
    expect(CONVERSATION_IDLE_MINUTES_LIMITS).toEqual({ min: 0, max: 240, default: 10 })
    for (const [value, ok] of [[0, true], [240, true], [10, true], [-1, false], [241, false], [2.5, false]] as const) {
      expect(valid(DeviceProfile as never, { ...DEFAULT_DEVICE_PROFILE, conversationIdleMinutes: value })).toBe(ok)
    }
    const { conversationIdleMinutes: _m, ...missing } = DEFAULT_DEVICE_PROFILE
    expect(valid(DeviceProfile as never, missing)).toBe(false)
  })
})
