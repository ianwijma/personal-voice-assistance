// The one decision of P10 (docs/PRESENTING.md "The decision"), complete: every combination of its inputs, against the
// table written out once more here; what a device shows of what applies to it; a device's outputs; the wire schemas.
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  decidePresentation,
  type DeviceCapabilities,
  devicePresentFrom,
  KNOWN_PRESENT_KINDS,
  MAX_PINNED_PER_DEVICE,
  NO_OVERRIDES,
  type PresentCandidate,
  PRESENT_KIND_NAMES,
  PRESENT_KIND_VERSIONS,
  type PresentDecision,
  PresentAction,
  presentationProblem,
  PresentationWire,
  selectPresentations
} from "../src/index.ts"
import { examplePresentation } from "../src/examples.ts"

/** The table, written out: the first row that applies wins. */
const expected = (c: { connected: boolean; personal: boolean; mayReveal: boolean; display: boolean; draws: boolean; touch: boolean }): PresentDecision => {
  if (!c.connected) return { show: false, why: "offline" }
  if (c.personal && !c.mayReveal) return { show: false, why: "private" }
  if (!c.display) return { show: false, why: "no-display" }
  if (!c.draws) return { show: false, why: "cannot-show-kind" }
  return { show: true, interactive: c.touch }
}

describe("decidePresentation", () => {
  const bools = [false, true]
  it("answers the table for every combination of its inputs and every kind", () => {
    let n = 0
    for (const kind of PRESENT_KIND_NAMES) {
      for (const connected of bools) for (const personal of bools) for (const mayReveal of bools) for (const display of bools) for (const draws of bools) for (const touch of bools) {
        const kinds = draws ? { [kind]: PRESENT_KIND_VERSIONS[kind] } : {}
        const got = decidePresentation({ kind, personal, mayReveal, device: { connected, display, kinds, touch } })
        expect(got, JSON.stringify({ kind, connected, personal, mayReveal, display, draws, touch })).toEqual(expected({ connected, personal, mayReveal, display, draws, touch }))
        n++
      }
    }
    expect(n).toBe(PRESENT_KIND_NAMES.length * 64)
  })

  it("a page that draws an older version of a kind, or another kind, cannot show it; household content ignores the privacy answer", () => {
    const device = (kinds: Record<string, number>) => ({ connected: true, display: true, kinds, touch: true })
    expect(decidePresentation({ kind: "card", personal: false, mayReveal: true, device: device({ card: 0 }) })).toEqual({ show: false, why: "cannot-show-kind" })
    expect(decidePresentation({ kind: "card", personal: false, mayReveal: true, device: device({ list: 1 }) })).toEqual({ show: false, why: "cannot-show-kind" })
    expect(decidePresentation({ kind: "card", personal: false, mayReveal: false, device: device({ card: 3 }) })).toEqual({ show: true, interactive: true })
  })
})

describe("selectPresentations", () => {
  const c = (id: string, lifetime: "transient" | "pinned", shownAt: number, show = true): PresentCandidate => ({ id, lifetime, shownAt, decision: show ? { show: true, interactive: true } : { show: false, why: "private" } })
  it("shows the allowed pinned ones oldest first, at most the bound, and the newest allowed transient", () => {
    const pinned = Array.from({ length: MAX_PINNED_PER_DEVICE + 2 }, (_, i) => c(`p${i}`, "pinned", i))
    const got = selectPresentations([...pinned, c("t1", "transient", 5), c("t2", "transient", 9), c("t3", "transient", 12, false), c("x", "pinned", -1, false)])
    expect(got.map((g) => g.id)).toEqual([...pinned.slice(0, MAX_PINNED_PER_DEVICE).map((p) => p.id), "t2"])
  })
  it("does not depend on the order it is given (ties by id)", () => {
    const xs = [c("b", "pinned", 1), c("a", "pinned", 1), c("z", "transient", 2), c("y", "transient", 2)]
    expect(selectPresentations(xs).map((g) => g.id)).toEqual(["a", "b", "z"])
    expect(selectPresentations([...xs].reverse()).map((g) => g.id)).toEqual(["a", "b", "z"])
  })
})

describe("devicePresentFrom", () => {
  const caps: DeviceCapabilities = { v: 1, display: { class: "standard", widthPx: 800, heightPx: 600, dpr: 1, touch: "coarse", colour: true }, present: { kinds: { card: 1, list: 1 } } }
  it("is what the page declared, minus the owner's overrides; nothing for a page that never declared", () => {
    expect(devicePresentFrom({ capabilities: NO_OVERRIDES }, caps)).toEqual({ display: true, kinds: { card: 1, list: 1 }, touch: true })
    expect(devicePresentFrom({ capabilities: { ...NO_OVERRIDES, excludeKinds: ["list"] } }, caps)).toEqual({ display: true, kinds: { card: 1 }, touch: true })
    expect(devicePresentFrom({ capabilities: { ...NO_OVERRIDES, noDisplay: true } }, caps)).toEqual({ display: false, kinds: {}, touch: false })
    expect(devicePresentFrom({ capabilities: NO_OVERRIDES }, undefined)).toEqual({ display: false, kinds: {}, touch: false })
    expect(devicePresentFrom({ capabilities: NO_OVERRIDES }, { ...caps, display: { ...caps.display!, touch: "none" } }).touch).toBe(false)
  })
  it("admin's switches know every kind of the first version", () => {
    expect([...KNOWN_PRESENT_KINDS].sort()).toEqual([...PRESENT_KIND_NAMES].sort())
  })
})

describe("the wire", () => {
  it("decodes the example and refuses text past its bound", () => {
    const decode = Schema.decodeUnknownSync(PresentationWire)
    expect(decode(examplePresentation).id).toBe("p-7c1d")
    expect(() => decode({ ...examplePresentation, content: { kind: "card", title: "x".repeat(61), facts: [] } })).toThrow()
    expect(() => decode({ ...examplePresentation, buttons: Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, label: "B" })) })).toThrow()
  })

  // Review round 2, finding 8: each bound of the one inbound message, at its maximum (accepted) and one past it
  // (refused), every other field valid.
  it("present.action: each bound accepted at its maximum and refused one past it", () => {
    const decode = Schema.decodeUnknownSync(PresentAction)
    const base = { type: "present.action", requestId: "r1", id: "p-1", revision: "show-1:1", action: "tick", item: "milk", done: true } as const
    const bounds: ReadonlyArray<readonly [string, (n: number) => Record<string, unknown>, number]> = [
      ["requestId", (n) => ({ requestId: "r".repeat(n) }), 64],
      ["id", (n) => ({ id: "p".repeat(n) }), 64],
      ["revision", (n) => ({ revision: "s".repeat(n) }), 96],
      ["action", (n) => ({ action: "a".repeat(n) }), 32],
      ["item", (n) => ({ item: "i".repeat(n) }), 40]
    ]
    expect(decode(base)).toEqual(base)
    for (const [field, at, max] of bounds) {
      expect(() => decode({ ...base, ...at(max) }), `${field} at ${max}`).not.toThrow()
      expect(() => decode({ ...base, ...at(max + 1) }), `${field} at ${max + 1}`).toThrow()
    }
    expect(() => decode({ ...base, requestId: "" })).toThrow()
    expect(() => decode({ ...base, id: "" })).toThrow()
    expect(() => decode({ ...base, item: "" })).toThrow()
  })
})

// a16: the module guide permits only five controls, even in multiline text and spoken fallback.
it("refuses DEL and C1 controls in card text and spoken, while permitted whitespace stays valid", () => {
  for (const field of ["text", "spoken"]) {
    for (const control of ["\u007f", "\u0085", "\u009f"]) {
      expect(presentationProblem({ kind: "card", title: "T", spoken: "S", [field]: `Before${control}After` }, 0)).toBeDefined()
    }
  }
  expect(presentationProblem({ kind: "card", title: "T", text: "Before\t\n\r\b\fAfter", spoken: "S" }, 0)).toBeUndefined()
})
