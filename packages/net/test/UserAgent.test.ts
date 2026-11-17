import { describe, expect, it } from "@effect/vitest"
import { userAgent } from "../src/UserAgent.ts"

describe("userAgent", () => {
  it("puts the contact in brackets after the product token", () => {
    expect(userAgent("me@example.com")).toBe("personal-voice-assistance/1 (me@example.com)")
    expect(userAgent("https://example.com/about", "pva", "2")).toBe("pva/2 (https://example.com/about)")
  })
  it("leaves the contact out cleanly when none is set", () => {
    for (const none of [undefined, "", "   ", "\n\t", "()"]) expect(userAgent(none)).toBe("personal-voice-assistance/1")
  })
  it("cannot be used to break the header", () => {
    expect(userAgent("a@b.c\r\nX-Evil: 1")).toBe("personal-voice-assistance/1 (a@b.c X-Evil: 1)")
    expect(userAgent("x) (y")).toBe("personal-voice-assistance/1 (x y)")
    expect(userAgent("a".repeat(500)).length).toBeLessThan(260)
  })
  it("tidies an odd product token", () => {
    expect(userAgent(undefined, "my app", "1.2 beta")).toBe("my-app/1.2beta")
  })
})
