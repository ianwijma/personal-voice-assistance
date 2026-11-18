// Review round 4 (p1-r4c finding 2): the field and count maxima of protocol 9 allowed a health list that escapes to over
// 2 MB, past the frame limit; the whole `HealthInfo` is now bounded by its serialised size (`MAX_HEALTH_BYTES`).
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { decodeServerMessage, encodeServerMessage, HealthInfo, MAX_HEALTH_BYTES, MAX_HEALTH_ISSUES, MAX_TEXT_FRAME_BYTES } from "../src/index.ts"

const nul = (n: number) => "\u0000".repeat(n)
/** The reviewer's fixture: every field at its maximum, every character one that JSON escapes to six. */
const worst = (count: number): HealthInfo => ({
  issues: Array.from({ length: count }, (_, i) => ({
    id: `i${i}`,
    severity: "error" as const,
    title: nul(200),
    device: nul(200),
    detail: nul(2000),
    fix: { kind: "command" as const, label: nul(200), value: nul(1000) }
  })),
  checking: false
})

describe("health stays under the frame limit", () => {
  it("a list at every field and count maximum, all escaped, is refused by the schema and by the encoder", () => {
    const health = worst(MAX_HEALTH_ISSUES)
    expect(JSON.stringify(health).length).toBeGreaterThan(MAX_TEXT_FRAME_BYTES)
    expect(Schema.is(HealthInfo)(health)).toBe(false)
    expect(() => encodeServerMessage({ type: "health", health })).toThrow()
  })

  it("anything the schema accepts encodes to a frame the decoder takes", () => {
    // As many worst-case issues as fit the byte bound: accepted, and well under the frame limit.
    let n = 0
    while (Schema.is(HealthInfo)(worst(n + 1))) n++
    expect(n).toBeGreaterThan(0)
    const text = encodeServerMessage({ type: "health", health: worst(n) })
    expect(new TextEncoder().encode(text).length).toBeLessThan(MAX_HEALTH_BYTES + 1024)
    expect(decodeServerMessage(text)._tag).toBe("Ok")
  })
})
