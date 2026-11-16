import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { exampleAssistant } from "@pva/protocol/examples"
import { useWizardDraft } from "@/components/settings/pages/assistants/useWizardDraft.ts"

// The wizard's assistant as an `AssistantDraft` (docs/ASSISTANTS.md §7.1): edits are held, nothing is "saved".
describe("useWizardDraft", () => {
  const start = () => renderHook(() => useWizardDraft(() => exampleAssistant))

  it("shows no unsaved mark and no save bar: it is never dirty, saving or changed", () => {
    const { result } = start()
    const d = result.current
    expect(d.current).toBe(exampleAssistant)
    expect(d.saved).toBe(d.current)
    expect([d.dirty, d.saving, d.justSaved, d.behind]).toEqual([false, false, false, false])
    expect(d.changed("name")).toBe(false)
    expect(d.tabChanged("model" as never)).toBe(false)
    expect(d.tabErrors("model" as never)).toBe(false)
    expect(d.warnings).toEqual([])
  })

  it("set edits a field by its dotted path and keeps the rest", () => {
    const { result } = start()
    act(() => result.current.set("name", "Zed"))
    act(() => result.current.set("llm.model", "claude-opus-5-5"))
    expect(result.current.current.name).toBe("Zed")
    expect(result.current.current.llm.model).toBe("claude-opus-5-5")
    expect(result.current.current.llm.account).toBe(exampleAssistant.llm.account)
    expect(result.current.current.prompt).toBe(exampleAssistant.prompt)
    // The saved one follows the draft: there is nothing to compare against.
    expect(result.current.saved).toBe(result.current.current)
  })

  it("update replaces the assistant by a function", () => {
    const { result } = start()
    act(() => result.current.update((a) => ({ ...a, purpose: "Other" })))
    expect(result.current.current.purpose).toBe("Other")
  })

  it("replace swaps in a whole assistant", () => {
    const { result } = start()
    const next = { ...exampleAssistant, name: "Replaced" }
    act(() => result.current.replace(next))
    expect(result.current.current).toBe(next)
  })

  it("reset, cancel and dismissWarnings do nothing", () => {
    const { result } = start()
    act(() => result.current.set("name", "Zed"))
    act(() => {
      result.current.reset("name")
      result.current.cancel()
      result.current.dismissWarnings()
    })
    expect(result.current.current.name).toBe("Zed")
  })

  it("save is refused: the wizard creates, it does not save", async () => {
    const { result } = start()
    await expect(result.current.save()).resolves.toMatchObject({ kind: "refused", code: "internal" })
  })

  describe("the errors of a refused create", () => {
    const errors = [
      { key: "name", message: "Name is taken" },
      { key: "hearing.finalSilenceMs", message: "Too short" },
      { key: "hearing.model", message: "Unknown model" },
      { key: null, message: "The form as a whole" }
    ]

    it("setErrors puts them on the fields, with the message", () => {
      const { result } = start()
      act(() => result.current.setErrors(errors, "Could not create"))
      expect(result.current.errors).toEqual(errors)
      expect(result.current.message).toBe("Could not create")
    })

    it("editing a field clears its own error and the errors beneath it, not the others", () => {
      const { result } = start()
      act(() => result.current.setErrors(errors))
      act(() => result.current.set("hearing", { finalSilenceMs: 600 }))
      expect(result.current.errors.map((e) => e.key)).toEqual(["name", null])
      // A prefix is a path segment, not a string prefix: "nam" does not clear "name".
      act(() => result.current.set("nam", "x"))
      expect(result.current.errors.map((e) => e.key)).toEqual(["name", null])
      act(() => result.current.set("name", "Zed"))
      expect(result.current.errors.map((e) => e.key)).toEqual([null])
    })

    it("any edit clears the message; an edit through update without `touched` keeps the field errors", () => {
      const { result } = start()
      act(() => result.current.setErrors(errors, "Could not create"))
      act(() => result.current.update((a) => ({ ...a, purpose: "x" })))
      expect(result.current.message).toBeUndefined()
      expect(result.current.errors).toEqual(errors)
      act(() => result.current.update((a) => ({ ...a, purpose: "y" }), "hearing.model"))
      expect(result.current.errors.map((e) => e.key)).toEqual(["name", "hearing.finalSilenceMs", null])
    })

    it("a new refusal replaces the old errors", () => {
      const { result } = start()
      act(() => result.current.setErrors(errors, "one"))
      act(() => result.current.setErrors([{ key: "purpose", message: "Needed" }]))
      expect(result.current.errors).toEqual([{ key: "purpose", message: "Needed" }])
      expect(result.current.message).toBeUndefined()
    })
  })

  describe("local errors (a number field that cannot take its text)", () => {
    it("setLocalError sets and clears one path; clearing an absent path changes nothing", () => {
      const { result } = start()
      act(() => result.current.setLocalError("toolRounds", "Not a number"))
      act(() => result.current.setLocalError("followUpSeconds", "Too big"))
      expect(result.current.localErrors).toEqual({ toolRounds: "Not a number", followUpSeconds: "Too big" })
      act(() => result.current.setLocalError("toolRounds", undefined))
      expect(result.current.localErrors).toEqual({ followUpSeconds: "Too big" })
      const before = result.current.localErrors
      act(() => result.current.setLocalError("toolRounds", undefined))
      expect(result.current.localErrors).toBe(before)
    })

    it("the same message for the same path keeps the object (no re-render)", () => {
      const { result } = start()
      act(() => result.current.setLocalError("toolRounds", "Not a number"))
      const before = result.current.localErrors
      act(() => result.current.setLocalError("toolRounds", "Not a number"))
      expect(result.current.localErrors).toBe(before)
    })
  })
})
