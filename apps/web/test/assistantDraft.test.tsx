import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import type { AssistantInfo } from "@pva/protocol"
import { exampleAssistantInfo } from "@pva/protocol/examples"
import type { Outcome } from "@/lib/assistants.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { ClientContext } from "@/components/context.tsx"
import { NumberControl, TextControl } from "@/components/settings/pages/assistants/parts.tsx"
import { useAssistantDraft } from "@/components/settings/pages/assistants/useAssistantDraft.ts"

const info = (patch: Partial<AssistantInfo> = {}): AssistantInfo => ({ ...exampleAssistantInfo, ...patch })

/** The draft hook with a client whose `saveAssistant` answers what the test says. */
const setup = (answer: Outcome | (() => Promise<Outcome>) = { kind: "ok" }) => {
  const saveAssistant = vi.fn(async (..._args: ReadonlyArray<unknown>): Promise<Outcome> => (typeof answer === "function" ? answer() : answer))
  const client = { saveAssistant } as unknown as AssistantClient
  const wrapper = ({ children }: { children: ReactNode }) => <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
  const hook = renderHook(({ info }) => useAssistantDraft(info), { wrapper, initialProps: { info: info() } })
  return { saveAssistant, ...hook }
}

describe("useAssistantDraft", () => {
  it("starts clean: the page shows what is saved, nothing to save or cancel", () => {
    const { result } = setup()
    expect(result.current.dirty).toBe(false)
    expect(result.current.current.name).toBe("Jeff")
    expect(result.current.tabChanged("basics")).toBe(false)
    expect(result.current.errors).toEqual([])
  })

  it("an edit makes the draft dirty and marks the field and its tab; editing back to the saved value is clean again", () => {
    const { result } = setup()
    act(() => result.current.set("llm.effort", "high"))
    expect(result.current.dirty).toBe(true)
    expect(result.current.current.llm.effort).toBe("high")
    expect(result.current.saved.llm.effort).toBe("low")
    expect(result.current.changed("llm.effort")).toBe(true)
    expect(result.current.changed("llm.model")).toBe(false)
    expect(result.current.tabChanged("model")).toBe(true)
    expect(result.current.tabChanged("voice")).toBe(false)
    act(() => result.current.set("llm.effort", "low"))
    expect(result.current.dirty).toBe(false)
  })

  it("reset puts one field back and leaves the others edited; cancel drops all edits", () => {
    const { result } = setup()
    act(() => result.current.set("name", "Mia"))
    act(() => result.current.set("llm.effort", "high"))
    act(() => result.current.reset("name"))
    expect(result.current.current.name).toBe("Jeff")
    expect(result.current.current.llm.effort).toBe("high")
    act(() => result.current.cancel())
    expect(result.current.dirty).toBe(false)
    expect(result.current.current.llm.effort).toBe("low")
  })

  it("update changes several fields in one edit", () => {
    const { result } = setup()
    act(() => result.current.update((a) => ({ ...a, name: "Mia", on: false }), "name"))
    expect(result.current.current).toMatchObject({ name: "Mia", on: false })
    expect(result.current.tabChanged("basics")).toBe(true)
  })

  it("saves the whole edited assistant under the revision the draft started from, and shows it as saved at once", async () => {
    const { result, saveAssistant } = setup()
    act(() => result.current.set("name", "Mia"))
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.save()
    })
    expect(outcome).toEqual({ kind: "ok" })
    expect(saveAssistant).toHaveBeenCalledTimes(1)
    const [sent, options] = saveAssistant.mock.calls[0]!
    expect(sent).toMatchObject({ id: "jeff", name: "Mia", rev: 3 })
    expect(options).toEqual({})
    // The push has not arrived yet: the page keeps showing the saved version, one revision on.
    expect(result.current.dirty).toBe(false)
    expect(result.current.justSaved).toBe(true)
    expect(result.current.current).toMatchObject({ name: "Mia", rev: 4 })
  })

  it("saveAnyway is sent only when asked for", async () => {
    const { result, saveAssistant } = setup()
    act(() => result.current.set("name", "Mia"))
    await act(async () => void (await result.current.save({ saveAnyway: true })))
    expect(saveAssistant.mock.calls[0]![1]).toEqual({ saveAnyway: true })
  })

  it("after a save the push with the new revision takes over, and a further edit is saved under it", async () => {
    const { result, rerender, saveAssistant } = setup()
    act(() => result.current.set("name", "Mia"))
    await act(async () => void (await result.current.save()))
    rerender({ info: info({ name: "Mia", rev: 4 }) })
    expect(result.current.current).toMatchObject({ name: "Mia", rev: 4 })
    expect(result.current.dirty).toBe(false)
    act(() => result.current.set("purpose", "Other"))
    await act(async () => void (await result.current.save()))
    expect(saveAssistant.mock.calls[1]![0]).toMatchObject({ name: "Mia", purpose: "Other", rev: 4 })
  })

  it("an edit clears 'just saved'", async () => {
    const { result } = setup()
    act(() => result.current.set("name", "Mia"))
    await act(async () => void (await result.current.save()))
    expect(result.current.justSaved).toBe(true)
    act(() => result.current.set("name", "Zed"))
    expect(result.current.justSaved).toBe(false)
  })

  it("saving with nothing edited sends nothing", async () => {
    const { result, saveAssistant } = setup()
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.save()
    })
    expect(outcome).toMatchObject({ kind: "refused" })
    expect(saveAssistant).not.toHaveBeenCalled()
  })

  it("a field that cannot take its text blocks the save until it can", async () => {
    const { result, saveAssistant } = setup()
    act(() => result.current.set("toolRounds", 5))
    act(() => result.current.setLocalError("toolRounds", "Not a number"))
    expect(result.current.localErrors).toEqual({ toolRounds: "Not a number" })
    await act(async () => void (await result.current.save()))
    expect(saveAssistant).not.toHaveBeenCalled()
    act(() => result.current.setLocalError("toolRounds", undefined))
    expect(result.current.localErrors).toEqual({})
    await act(async () => void (await result.current.save()))
    expect(saveAssistant).toHaveBeenCalledTimes(1)
  })

  it("setting the same local error twice changes nothing", () => {
    const { result } = setup()
    act(() => result.current.setLocalError("a", "x"))
    const first = result.current.localErrors
    act(() => result.current.setLocalError("a", "x"))
    expect(result.current.localErrors).toBe(first)
    act(() => result.current.setLocalError("b", undefined))
    expect(result.current.localErrors).toBe(first)
  })

  it("a refused save keeps the edits, puts each field error on its field and its tab; editing the field clears only its errors", async () => {
    const fieldErrors = [
      { key: "hearing.finalSilenceMs", message: "Longer than the eager pause." },
      { key: "name", message: "Taken." }
    ]
    const { result } = setup({ kind: "invalid", message: "Check the fields.", fieldErrors })
    act(() => result.current.set("name", "Mia"))
    await act(async () => void (await result.current.save()))
    expect(result.current.errors).toEqual(fieldErrors)
    expect(result.current.message).toBeUndefined()
    expect(result.current.tabErrors("hearing")).toBe(true)
    expect(result.current.tabErrors("basics")).toBe(true)
    expect(result.current.tabErrors("voice")).toBe(false)
    expect(result.current.current.name).toBe("Mia")
    act(() => result.current.set("name", "Mia2"))
    expect(result.current.errors).toEqual([fieldErrors[0]])
    // Editing a parent path clears the errors of its children.
    act(() => result.current.update((a) => a, "hearing"))
    expect(result.current.errors).toEqual([])
  })

  it("an error without a field shows its message at the top instead; one with fields does not", async () => {
    const { result } = setup({ kind: "invalid", message: "Too many assistants.", fieldErrors: [{ key: null, message: "Too many assistants." }] })
    act(() => result.current.set("name", "Mia"))
    await act(async () => void (await result.current.save()))
    expect(result.current.message).toBe("Too many assistants.")
    expect(result.current.tabErrors("basics")).toBe(false)
  })

  it("warnings wait for 'Save anyway'; an edit or dismissing removes them", async () => {
    const warnings = [{ key: "toolRounds", message: "That is a lot." }]
    const { result } = setup({ kind: "warnings", message: "Check.", warnings })
    act(() => result.current.set("toolRounds", 20))
    await act(async () => void (await result.current.save()))
    expect(result.current.warnings).toEqual(warnings)
    expect(result.current.errors).toEqual([])
    expect(result.current.dirty).toBe(true)
    act(() => result.current.dismissWarnings())
    expect(result.current.warnings).toEqual([])
    await act(async () => void (await result.current.save()))
    expect(result.current.warnings).toEqual(warnings)
    act(() => result.current.set("toolRounds", 5))
    expect(result.current.warnings).toEqual([])
  })

  it("another refusal shows its message and keeps the edits", async () => {
    const { result } = setup({ kind: "refused", code: "locked", message: "Unlock first." })
    act(() => result.current.set("name", "Mia"))
    await act(async () => void (await result.current.save()))
    expect(result.current.message).toBe("Unlock first.")
    expect(result.current.dirty).toBe(true)
    act(() => result.current.set("name", "Mia2"))
    expect(result.current.message).toBeUndefined()
  })

  it("a stale save drops the edits and shows what the server has now", async () => {
    const { result, rerender } = setup({ kind: "stale", message: "Jeff changed." })
    act(() => result.current.set("name", "Mia"))
    // The newest version is in the state by the time the answer comes.
    rerender({ info: info({ name: "Jeffrey", rev: 4 }) })
    await act(async () => void (await result.current.save()))
    expect(result.current.dirty).toBe(false)
    expect(result.current.current).toMatchObject({ name: "Jeffrey", rev: 4 })
    expect(result.current.errors).toEqual([])
  })

  it("while saving, a second save is not sent", async () => {
    let release: (o: Outcome) => void = () => {}
    const { result, saveAssistant } = setup(() => new Promise<Outcome>((r) => (release = r)))
    act(() => result.current.set("name", "Mia"))
    let first: Promise<Outcome> | undefined
    act(() => {
      first = result.current.save()
    })
    expect(result.current.saving).toBe(true)
    await act(async () => void (await result.current.save()))
    expect(saveAssistant).toHaveBeenCalledTimes(1)
    await act(async () => {
      release({ kind: "ok" })
      await first
    })
    expect(result.current.saving).toBe(false)
  })

  it("an edit made while the save is on its way is kept after it, on top of the saved revision, and saved next (PR #34 review, finding 1)", async () => {
    let release: (o: Outcome) => void = () => {}
    const { result, rerender, saveAssistant } = setup(() => new Promise<Outcome>((r) => (release = r)))
    act(() => result.current.set("purpose", "Mine"))
    let first: Promise<Outcome> | undefined
    act(() => {
      first = result.current.save()
    })
    act(() => result.current.set("handles", "Only lights."))
    await act(async () => {
      release({ kind: "ok" })
      await first
    })
    expect(result.current.saving).toBe(false)
    expect(result.current.current).toMatchObject({ purpose: "Mine", handles: "Only lights." })
    expect(result.current.saved).toMatchObject({ purpose: "Mine", rev: 4 })
    expect(result.current.dirty).toBe(true)
    expect(result.current.justSaved).toBe(false)
    expect(result.current.changed("handles")).toBe(true)
    expect(result.current.changed("purpose")).toBe(false)
    // The push of the first save is not "changed elsewhere".
    rerender({ info: info({ purpose: "Mine", rev: 4 }) })
    expect(result.current.behind).toBe(false)
    expect(result.current.dirty).toBe(true)
    let second: Promise<Outcome> | undefined
    act(() => {
      second = result.current.save()
    })
    await act(async () => {
      release({ kind: "ok" })
      await second
    })
    expect(saveAssistant.mock.calls[1]![0]).toMatchObject({ purpose: "Mine", handles: "Only lights.", rev: 4 })
  })

  it("an empty name is not sent: the name field says so, and nothing is left saving (PR #34 review, finding 2)", async () => {
    const { result, saveAssistant } = setup()
    act(() => result.current.set("name", ""))
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.save()
    })
    expect(outcome).toMatchObject({ kind: "invalid" })
    expect(saveAssistant).not.toHaveBeenCalled()
    expect(result.current.saving).toBe(false)
    expect(result.current.errors).toEqual([{ key: "name", message: "Enter a name." }])
    expect(result.current.tabErrors("basics")).toBe(true)
    act(() => result.current.set("name", "Mia"))
    expect(result.current.errors).toEqual([])
    await act(async () => void (await result.current.save()))
    expect(saveAssistant).toHaveBeenCalledTimes(1)
  })

  it("a save whose request fails returns the editor to editing, keeps the edits and says it did not save (PR #34 review, finding 2)", async () => {
    const { result } = setup(() => Promise.reject(new Error("encode failed")))
    act(() => result.current.set("purpose", "Mine"))
    let outcome: Outcome | undefined
    await act(async () => {
      outcome = await result.current.save()
    })
    expect(outcome).toMatchObject({ kind: "refused" })
    expect(result.current.saving).toBe(false)
    expect(result.current.dirty).toBe(true)
    expect(result.current.current.purpose).toBe("Mine")
    expect(result.current.message).toBe("Could not save. Try again.")
  })

  describe("a push while editing", () => {
    it("a clean draft follows it", () => {
      const { result, rerender } = setup()
      rerender({ info: info({ name: "Jeffrey", rev: 4 }) })
      expect(result.current.current.name).toBe("Jeffrey")
      expect(result.current.behind).toBe(false)
    })
    it("a dirty draft is marked behind, keeps the edits, and Cancel then shows the latest", () => {
      const { result, rerender } = setup()
      act(() => result.current.set("purpose", "Mine"))
      rerender({ info: info({ name: "Jeffrey", rev: 4 }) })
      expect(result.current.behind).toBe(true)
      expect(result.current.current.purpose).toBe("Mine")
      expect(result.current.saved.name).toBe("Jeffrey")
      act(() => result.current.cancel())
      expect(result.current.behind).toBe(false)
      expect(result.current.current).toMatchObject({ name: "Jeffrey", rev: 4 })
    })
    it("a push that brings the very edits made is not 'behind': the draft is clean", () => {
      const { result, rerender } = setup()
      act(() => result.current.set("name", "Mia"))
      rerender({ info: info({ name: "Mia", rev: 4 }) })
      expect(result.current.dirty).toBe(false)
      expect(result.current.behind).toBe(false)
    })
    it("a push with the same revision (a usedOn change) does not mark the draft behind", () => {
      const { result, rerender } = setup()
      act(() => result.current.set("name", "Mia"))
      rerender({ info: info({ usedOn: [] }) })
      expect(result.current.behind).toBe(false)
      expect(result.current.dirty).toBe(true)
    })
  })
})

/** The number field of a page with a Cancel button, on the real draft. */
function NumberPage({ value }: { readonly value: AssistantInfo }) {
  const draft = useAssistantDraft(value)
  return (
    <div>
      <TextControl draft={draft} path="purpose" max={80} label="Purpose" />
      <NumberControl draft={draft} path="toolRounds" min={0} max={10} unit="rounds" label="Tool rounds" />
      <button type="button" onClick={draft.cancel}>Cancel</button>
      <span data-testid="dirty">{String(draft.dirty)}</span>
    </div>
  )
}

describe("NumberControl", () => {
  it("Cancel puts back the saved number over text the draft never took (PR #34 review, finding 3)", () => {
    const client = { saveAssistant: vi.fn() } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><NumberPage value={info()} /></ClientContext.Provider>)
    const rounds = screen.getByLabelText("Tool rounds") as HTMLInputElement
    expect(rounds.value).toBe("3")
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Mine" } })
    fireEvent.change(rounds, { target: { value: "99" } })
    expect(rounds.value).toBe("99")
    expect(rounds.getAttribute("aria-invalid")).toBe("true")
    fireEvent.click(screen.getByText("Cancel"))
    expect(rounds.value).toBe("3")
    expect(rounds.getAttribute("aria-invalid")).toBeNull()
    expect(screen.getByTestId("dirty").textContent).toBe("false")
  })

  it("a valid number typed after an invalid one is kept as typed", () => {
    const client = { saveAssistant: vi.fn() } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><NumberPage value={info()} /></ClientContext.Provider>)
    const rounds = screen.getByLabelText("Tool rounds") as HTMLInputElement
    fireEvent.change(rounds, { target: { value: "99" } })
    fireEvent.change(rounds, { target: { value: "7" } })
    expect(rounds.value).toBe("7")
    expect(rounds.getAttribute("aria-invalid")).toBeNull()
    expect(screen.getByTestId("dirty").textContent).toBe("true")
  })
})
