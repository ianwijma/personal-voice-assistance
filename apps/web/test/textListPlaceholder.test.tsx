// A text list's input shows its example only while the list is empty (the Members page showed "nuts" in grey beside
// the chip "nuts"); with an item it is the generic "Add…", and nothing once the list is full.
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { TextListField, textListPlaceholder } from "@/components/fields/TextListField.tsx"

const field = { type: "textList" as const, key: "allergies", label: "Allergies", apply: "live" as const, default: [], placeholder: "nuts", maxItems: 3 }

const renderWith = (value: ReadonlyArray<string>) =>
  render(<TextListField field={field} id="allergies" describedBy="" value={[...value]} onChange={() => {}} onSecretChange={() => {}} onLocalError={() => {}} disabled={false} invalid={false} />)

describe("a text list's placeholder", () => {
  it("is the example while empty, Add… with items, nothing when full", () => {
    expect(textListPlaceholder("nuts", 0, 3)).toBe("nuts")
    expect(textListPlaceholder("nuts", 1, 3)).toBe("Add…")
    expect(textListPlaceholder(undefined, 0, 3)).toBe("Add…")
    expect(textListPlaceholder("nuts", 3, 3)).toBe("")
  })

  it("the input beside a real chip says Add…, not the example", () => {
    const { unmount } = renderWith([])
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("nuts")
    unmount()
    renderWith(["nuts"])
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Add…")
  })
})
