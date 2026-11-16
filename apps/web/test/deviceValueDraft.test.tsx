import { act, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { PresetControl } from "@/components/settings/pages/assistants/parts.tsx"
import { useValueDraft } from "@/components/settings/pages/devices/parts.tsx"

const PATH = "fu-jeff"
const PRESETS = [[0, "Off"], [5, "5 seconds"], [8, "8 seconds"]] as const

/**
 * The follow-up field of a device page as `AssignSection` wires it: one value through `useValueDraft`, the preset
 * control keyed by the editor's generation. Cancel puts the value back and starts a new generation, as the editor does.
 */
function Field({ onBlocked }: { readonly onBlocked: (id: string, blocked: boolean) => void }) {
  const [value, setValue] = useState(8)
  const [generation, setGeneration] = useState(0)
  const draft = useValueDraft(PATH, value, (v) => setValue(v as number), onBlocked)
  return (
    <div>
      <PresetControl key={generation} draft={draft} path={PATH} presets={PRESETS} unit="seconds" min={1} max={120} customDefault={10} label="Keep listening" />
      <p data-testid="error">{draft.localErrors[PATH] ?? ""}</p>
      <button
        type="button"
        onClick={() => {
          setValue(8)
          setGeneration((g) => g + 1)
        }}
      >
        Cancel
      </button>
    </div>
  )
}

// Review of PR #35, finding 2: Cancel (and a section Reset) must also drop a typed number that cannot be saved.
describe("a device page's number field after Cancel", () => {
  it("drops the typed text, its error and the blocked Save", () => {
    const onBlocked = vi.fn()
    const v = render(<Field onBlocked={onBlocked} />)
    fireEvent.change(v.getByLabelText("Keep listening"), { target: { value: "__custom" } })
    const number = v.getByLabelText("Keep listening in seconds") as HTMLInputElement
    expect(number.value).toBe("10")
    fireEvent.change(number, { target: { value: "999" } })
    expect(v.getByTestId("error").textContent).toBe("Between 1 and 120 seconds.")
    expect(onBlocked).toHaveBeenLastCalledWith(PATH, true)

    act(() => v.getByText("Cancel").click())
    expect(v.getByTestId("error").textContent).toBe("")
    expect(onBlocked).toHaveBeenLastCalledWith(PATH, false)
    expect(v.queryByLabelText("Keep listening in seconds")).toBeNull()
    expect((v.getByLabelText("Keep listening") as HTMLSelectElement).value).toBe("8")
  })
})
