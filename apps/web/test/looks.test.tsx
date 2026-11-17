import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import type { Look } from "@pva/protocol"
import { BASELINE_ID } from "@/characters/choice.ts"
import type { Character } from "@/characters/contract.ts"
import { registry } from "@/characters/registry.ts"
import { LookOptions } from "@/components/looks/LookOptions.tsx"
import { assistantLook, canonicalLook, changedCount, resetAll, resetOption, setOption, switchCharacter, valuesOf } from "@/lib/looks.ts"

/** Editing a look (src/lib/looks.ts, docs/LOOKS-AND-VOICES.md §2): the canonical stored form, validation through options.ts. */

const lantern = {
  id: "lantern",
  version: "1.2.0",
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.5, step: 0.05, default: 1, unit: "×", help: "How big." },
    { id: "glow", kind: "toggle", label: "Glow", default: true },
    { id: "style", kind: "choice", label: "Style", choices: [{ value: "candle", label: "Candle" }, { value: "torch", label: "Torch" }], default: "candle" },
    { id: "tint", kind: "color", label: "Tint", default: "voice" }
  ]
} as unknown as Character

const plain = { id: "plain", version: "2.0.0", options: [{ id: "speed", kind: "number", label: "Speed", min: 0.5, max: 2, step: 0.1, default: 1 }, { id: "glow", kind: "number", label: "Glow", min: 0, max: 2, step: 0.1, default: 1 }] } as unknown as Character

describe("the canonical look", () => {
  it("keeps only values that differ from their defaults, with the character's version; nothing differs: no options", () => {
    expect(canonicalLook(lantern, {})).toEqual({ character: "lantern", version: "1.2.0" })
    expect(canonicalLook(lantern, { size: 1, glow: true, style: "candle", tint: "voice", $sensitivity: 1 })).toEqual({ character: "lantern", version: "1.2.0" })
    expect(canonicalLook(lantern, { size: 1.2, glow: false, $you: "#FF8800" })).toEqual({ character: "lantern", version: "1.2.0", options: { size: 1.2, glow: false, $you: "#ff8800" } })
  })
  it("validates every value with options.ts: clamped and snapped numbers, unknown choices and wrong types become the default, unknown ids go", () => {
    expect(canonicalLook(lantern, { size: 9, style: "bonfire", glow: "maybe", nope: 3, $sensitivity: 1.234 }).options).toEqual({ size: 1.5, $sensitivity: 1.25 })
    expect(setOption(lantern, undefined, "size", "1.13").options).toEqual({ size: 1.15 })
    expect(setOption(lantern, undefined, "tint", "not a colour").options).toBeUndefined()
  })
  it("round-trips: what valuesOf reads back is what was set, complete with defaults", () => {
    const look = setOption(lantern, setOption(lantern, undefined, "style", "torch"), "size", 0.75)
    expect(valuesOf(lantern, look)).toEqual({ size: 0.75, glow: true, style: "torch", tint: "voice", $you: "you", $voice: "voice", $sensitivity: 1 })
    expect(changedCount(lantern, look)).toBe(2)
  })
  it("a value edited back to its default leaves the same look as before the edit (nothing to save)", () => {
    const saved = setOption(lantern, undefined, "glow", false)
    expect(setOption(lantern, setOption(lantern, saved, "size", 1.3), "size", 1)).toEqual(saved)
  })
})

describe("resets", () => {
  const look: Look = { character: "lantern", version: "1.2.0", options: { size: 1.3, glow: false, $voice: "#112233" } }
  it("one option", () => expect(resetOption(lantern, look, "size").options).toEqual({ glow: false, $voice: "#112233" }))
  it("all of the character's own, keeping the host-level settings", () => expect(resetAll(lantern, look, false)).toEqual({ character: "lantern", version: "1.2.0", options: { $voice: "#112233" } }))
  it("everything", () => expect(resetAll(lantern, look, true)).toEqual({ character: "lantern", version: "1.2.0" }))
})

describe("switching character", () => {
  it("keeps the host-level settings and the reserved ids the new character offers with that kind; drops the rest", () => {
    const look: Look = { character: "lantern", version: "1.2.0", options: { size: 1.3, glow: false, style: "torch", $sensitivity: 1.5, $you: "#00ff00" } }
    // plain has no size, and its glow is a number (lantern's was a toggle): neither carries over.
    expect(switchCharacter(look, plain)).toEqual({ character: "plain", version: "2.0.0", options: { $sensitivity: 1.5, $you: "#00ff00" } })
    expect(switchCharacter({ character: "plain", options: { speed: 1.5, glow: 0.4 } }, lantern)).toEqual({ character: "lantern", version: "1.2.0" })
    expect(switchCharacter(undefined, lantern)).toEqual({ character: "lantern", version: "1.2.0" })
  })
})

describe("an assistant's look", () => {
  it("the baseline with every default is stored as no look (absent = the baseline); anything else is kept", () => {
    expect(assistantLook({ character: BASELINE_ID, version: registry.baseline.version })).toBeUndefined()
    expect(assistantLook({ character: BASELINE_ID, options: {} })).toBeUndefined()
    expect(assistantLook({ character: BASELINE_ID, options: { $sensitivity: 1.5 } })).toEqual({ character: BASELINE_ID, options: { $sensitivity: 1.5 } })
    expect(assistantLook({ character: "flame" })).toEqual({ character: "flame" })
  })
})

function Harness({ initial }: { readonly initial: Look | undefined }) {
  const [look, setLook] = useState(initial)
  return (
    <>
      <LookOptions character={lantern} look={look} onChange={setLook} idPrefix="t" />
      <pre data-testid="stored">{JSON.stringify(look ?? null)}</pre>
    </>
  )
}
const stored = () => JSON.parse(screen.getByTestId("stored").textContent!) as Look | null

describe("the options form (LookOptions)", () => {
  it("renders each kind from the manifest: slider with its value, switch, segmented choice, colour; help text", () => {
    render(<Harness initial={undefined} />)
    expect(screen.getByLabelText("Size")).toHaveAttribute("type", "range")
    expect(screen.getByRole("switch", { name: "Glow" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radiogroup", { name: "Style" })).toBeInTheDocument()
    expect(screen.getByLabelText("Tint").tagName).toBe("SELECT")
    expect(screen.getByText("How big.")).toBeInTheDocument()
    expect(screen.getByLabelText("Sensitivity")).toHaveAttribute("type", "range")
    expect(screen.queryAllByTestId("option-reset")).toHaveLength(0)
    expect(screen.getByTestId("reset-all")).toBeDisabled()
  })
  it("an edit stores the validated canonical look; Reset and Reset all put the defaults back", () => {
    render(<Harness initial={undefined} />)
    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "1.25" } })
    fireEvent.click(screen.getByRole("switch", { name: "Glow" }))
    fireEvent.click(screen.getByRole("radio", { name: "Torch" }))
    expect(stored()).toEqual({ character: "lantern", version: "1.2.0", options: { size: 1.25, glow: false, style: "torch" } })
    expect(screen.getByTestId("reset-all")).toHaveTextContent("Reset all (3)")
    fireEvent.click(screen.getByRole("button", { name: /Reset Size to its default/ }))
    expect(stored()?.options).toEqual({ glow: false, style: "torch" })
    fireEvent.change(screen.getByLabelText("Sensitivity"), { target: { value: "1.5" } })
    fireEvent.click(screen.getByTestId("reset-all"))
    expect(stored()).toEqual({ character: "lantern", version: "1.2.0", options: { $sensitivity: 1.5 } })
  })
  it("a custom colour shows a colour input, and a theme colour again stores nothing for the default", () => {
    render(<Harness initial={{ character: "lantern", options: { tint: "#AA0000" } }} />)
    expect(screen.getByLabelText("Tint")).toHaveValue("custom")
    expect(screen.getByLabelText("Custom colour")).toHaveValue("#aa0000")
    fireEvent.change(screen.getByLabelText("Tint"), { target: { value: "voice" } })
    expect(stored()).toEqual({ character: "lantern", version: "1.2.0" })
  })
})
