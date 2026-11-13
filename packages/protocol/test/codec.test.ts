import { describe, expect, it } from "vitest"
import {
  ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  MAX_TEXT_FRAME_BYTES,
  PROTOCOL_VERSION,
  ServerMessage
} from "../src/index.ts"
import { clientExamples, serverExamples } from "../src/examples.ts"

const ok = <M>(result: { readonly _tag: string; readonly message?: M }): M => {
  expect(result._tag).toBe("Ok")
  return result.message as M
}

describe("examples", () => {
  it("cover every client message type", () => {
    expect(Object.keys(clientExamples).sort()).toEqual([...ClientMessage.discriminants].sort())
  })
  it("cover every server message type", () => {
    expect(Object.keys(serverExamples).sort()).toEqual([...ServerMessage.discriminants].sort())
  })
})

describe("round trip", () => {
  for (const message of Object.values(clientExamples)) {
    it(`client ${message.type}`, () => {
      const text = encodeClientMessage(message)
      expect(ok(decodeClientMessage(text))).toEqual(message)
    })
  }
  for (const message of Object.values(serverExamples)) {
    it(`server ${message.type}`, () => {
      const text = encodeServerMessage(message)
      expect(ok(decodeServerMessage(text))).toEqual(message)
    })
  }
})

describe("decoding", () => {
  it("rejects text that is not a JSON object with a type", () => {
    expect(decodeClientMessage("{nope")).toMatchObject({ _tag: "Invalid", reason: "not valid JSON" })
    expect(decodeClientMessage("[1,2]")).toMatchObject({ _tag: "Invalid", reason: "not a JSON object" })
    expect(decodeClientMessage("null")).toMatchObject({ _tag: "Invalid", reason: "not a JSON object" })
    expect(decodeClientMessage("\"hello\"")).toMatchObject({ _tag: "Invalid" })
    expect(decodeClientMessage("{}")).toMatchObject({ _tag: "Invalid", reason: "missing \"type\"" })
    expect(decodeClientMessage("{\"type\":7}")).toMatchObject({ _tag: "Invalid", reason: "missing \"type\"" })
  })

  it("reports an unknown type without failing, so it can be ignored", () => {
    expect(decodeServerMessage("{\"type\":\"future.thing\",\"x\":1}")).toEqual({ _tag: "Unknown", messageType: "future.thing" })
    // a server message type is unknown to the client decoder and vice versa
    expect(decodeClientMessage(encodeServerMessage(serverExamples.pong))).toEqual({ _tag: "Unknown", messageType: "pong" })
  })

  it("does not treat inherited object keys as message types", () => {
    expect(decodeClientMessage("{\"type\":\"toString\"}")).toEqual({ _tag: "Unknown", messageType: "toString" })
    expect(decodeClientMessage("{\"type\":\"__proto__\"}")).toEqual({ _tag: "Unknown", messageType: "__proto__" })
  })

  it("rejects a known type with missing or wrong fields", () => {
    const missing = decodeClientMessage("{\"type\":\"hello\",\"protocol\":1}")
    expect(missing).toMatchObject({ _tag: "Invalid", messageType: "hello" })
    const wrong = decodeClientMessage(JSON.stringify({ ...clientExamples["playback.progress"], playedSamples: -1 }))
    expect(wrong).toMatchObject({ _tag: "Invalid", messageType: "playback.progress" })
    const fraction = decodeClientMessage(JSON.stringify({ ...clientExamples["playback.progress"], playedSamples: 1.5 }))
    expect(fraction._tag).toBe("Invalid")
  })

  it("validates ids and limits", () => {
    const badModule = decodeClientMessage(JSON.stringify({ ...clientExamples["module.enable"], moduleId: "Weather!" }))
    expect(badModule._tag).toBe("Invalid")
    const turnZero = decodeClientMessage(JSON.stringify({ ...clientExamples.interrupt, turnId: 0 }))
    expect(turnZero._tag).toBe("Invalid")
    const turnTooBig = decodeServerMessage(JSON.stringify({ ...serverExamples["reply.end"], turnId: 2 ** 32 }))
    expect(turnTooBig._tag).toBe("Invalid")
    const emptyText = decodeClientMessage(JSON.stringify({ ...clientExamples["text.send"], text: "" }))
    expect(emptyText._tag).toBe("Invalid")
    const longText = decodeClientMessage(JSON.stringify({ ...clientExamples["text.send"], text: "a".repeat(4001) }))
    expect(longText._tag).toBe("Invalid")
    const badRate = decodeServerMessage(JSON.stringify({ ...serverExamples["reply.start"], sampleRate: 1000 }))
    expect(badRate._tag).toBe("Invalid")
    const badField = decodeServerMessage(JSON.stringify({
      ...serverExamples["section.changed"],
      section: {
        ...serverExamples["section.changed"].section,
        form: { ...serverExamples["section.changed"].section.form, fields: [{ type: "color", key: "x", label: "X", apply: "live" }] }
      }
    }))
    expect(badField._tag).toBe("Invalid")
  })

  it("rejects oversized frames before parsing", () => {
    const huge = `{"type":"ping","id":1,"pad":"${"x".repeat(MAX_TEXT_FRAME_BYTES)}"}`
    expect(decodeClientMessage(huge)).toMatchObject({ _tag: "Invalid" })
  })

  it("strips unknown fields (an older peer accepts a newer optional field)", () => {
    const decoded = ok(decodeClientMessage(JSON.stringify({ ...clientExamples.ping, extra: true })))
    expect(decoded).toEqual(clientExamples.ping)
  })

  it("accepts a protocol mismatch at the schema level, so the server can answer it", () => {
    const hello = ok(decodeClientMessage(JSON.stringify({ ...clientExamples.hello, protocol: PROTOCOL_VERSION + 1 })))
    expect(hello).toMatchObject({ type: "hello", protocol: PROTOCOL_VERSION + 1 })
  })
})

describe("encoding", () => {
  it("throws on an invalid message (a programming error)", () => {
    const bad = { ...clientExamples["playback.finished"], playedSamples: -5 }
    expect(() => encodeClientMessage(bad)).toThrow()
  })
  it("produces plain JSON with the type first-class", () => {
    expect(JSON.parse(encodeServerMessage(serverExamples.state))).toEqual({ type: "state", state: "speaking", turnId: 12 })
  })
})
