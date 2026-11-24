// `InfoField.steps` (additive within protocol 12): a numbered guide in an info field. The bounds on the wire.
import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { InfoField, MAX_INFO_STEPS } from "../src/index.ts"

const field = (steps: unknown) => ({ type: "info", key: "guide", label: "Guide", apply: "live", steps })
const accepts = (steps: unknown) => Schema.is(InfoField)(field(steps))
const step = { text: "Do it." }

describe("info field steps", () => {
  it("accepts a guide with copy rows and an https link, and a field without steps", () => {
    expect(accepts([{ text: "Open it.", link: { href: "https://developer.spotify.com/dashboard", label: "Open" } }, { text: "Paste.", copy: [{ label: "URI", value: "{origin}/api/x" }] }])).toBe(true)
    expect(Schema.is(InfoField)({ type: "info", key: "guide", label: "Guide", apply: "live" })).toBe(true)
  })

  it("refuses a link that is not an absolute https address", () => {
    for (const href of ["http://example.com/", "/api/modules/media/x", "javascript:alert(1)", "//example.com", "https://user:pw@example.com/", "https://user@example.com/", "https://exa mple.com/", "https://example.com/a b", "https://example.com/\n", "https://", "ftp://example.com"]) {
      expect(accepts([{ text: "x", link: { href, label: "L" } }]), href).toBe(false)
    }
    expect(accepts([{ text: "x", link: { href: "https://example.com:8443/a?b=c#d", label: "L" } }])).toBe(true)
  })

  it("refuses overlong text, labels, values and links, too many steps and too many copy rows", () => {
    expect(accepts([{ text: "x".repeat(301) }])).toBe(false)
    expect(accepts([{ text: "x".repeat(300) }])).toBe(true)
    expect(accepts([{ text: "x", copy: [{ label: "x".repeat(41), value: "v" }] }])).toBe(false)
    expect(accepts([{ text: "x", copy: [{ label: "l", value: "v".repeat(301) }] }])).toBe(false)
    expect(accepts([{ text: "x", copy: Array.from({ length: 7 }, () => ({ label: "l", value: "v" })) }])).toBe(false)
    expect(accepts([{ text: "x", copy: Array.from({ length: 6 }, () => ({ label: "l", value: "v" })) }])).toBe(true)
    expect(accepts([{ text: "x", link: { href: `https://example.com/${"a".repeat(300)}`, label: "L" } }])).toBe(false)
    expect(accepts([{ text: "x", link: { href: "https://example.com/", label: "L".repeat(61) } }])).toBe(false)
    expect(accepts(Array.from({ length: MAX_INFO_STEPS }, () => step))).toBe(true)
    expect(accepts(Array.from({ length: MAX_INFO_STEPS + 1 }, () => step))).toBe(false)
  })
})
