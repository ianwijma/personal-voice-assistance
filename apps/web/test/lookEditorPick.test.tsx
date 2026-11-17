import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import type { Look } from "@pva/protocol"
import type { Loaded } from "@/characters/catalog.ts"
import { registry } from "@/characters/registry.ts"

// A pick is only applied when it is still the newest one (LookEditor): picking the current character again drops a
// load that is still on its way. The chunk loads are held here, so the test decides when each one arrives.
const held = vi.hoisted(() => new Map<string, (r: Loaded) => void>())
vi.mock("@/characters/catalog.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/characters/catalog.ts")>()
  return {
    ...real,
    loadCharacter: (id: string) => (id === registry.baseline.id ? real.loadCharacter(id) : new Promise<Loaded>((resolve) => held.set(id, resolve)))
  }
})
// The preview runs the real character host (a canvas); the picker's cards load previews. Neither is the subject here.
vi.mock("@/components/looks/LookPreview.tsx", () => ({ LookPreview: () => null }))
vi.mock("@/components/looks/CharacterPicker.tsx", () => ({
  CharacterPicker: ({ ids, onPick }: { readonly ids: ReadonlyArray<string>; readonly onPick: (id: string) => void }) => (
    <div>{ids.map((id) => <button key={id} type="button" onClick={() => onPick(id)}>{id}</button>)}</div>
  )
}))

const { LookEditor } = await import("@/components/looks/LookEditor.tsx")

function Harness() {
  const [look, setLook] = useState<Look | undefined>(undefined)
  return <LookEditor value={look} onChange={setLook} idPrefix="t" whose="Jeff's" />
}

describe("LookEditor: the newest pick wins", () => {
  it("Flame picked while Sine lines is shown, then Sine lines again before Flame has loaded: the look stays Sine lines", async () => {
    const flame = { ...registry.baseline, id: "flame", name: "Flame", version: "1.0.0" }
    expect(registry.ids).toContain("flame")
    render(<Harness />)
    const editor = screen.getByTestId("look-editor")
    expect(editor.getAttribute("data-character")).toBe(registry.baseline.id)

    fireEvent.click(screen.getByRole("button", { name: "flame" }))
    expect(held.has("flame")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: registry.baseline.id }))
    await act(async () => {
      held.get("flame")!({ kind: "ready", character: flame })
      await Promise.resolve()
    })
    expect(editor.getAttribute("data-character")).toBe(registry.baseline.id)
  })

  it("Flame picked alone still applies when it has loaded", async () => {
    held.clear()
    const flame = { ...registry.baseline, id: "flame", name: "Flame", version: "1.0.0" }
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "flame" }))
    await act(async () => {
      held.get("flame")!({ kind: "ready", character: flame })
      await Promise.resolve()
    })
    expect(screen.getByTestId("look-editor").getAttribute("data-character")).toBe("flame")
  })
})

// A load still on its way when the editor goes away, or when its look is changed from outside it, is dropped: it must
// not bring back a character the person has since removed.
type DeviceLookState = { readonly from: "assistant" } | { readonly from: "device"; readonly look: Look | undefined }
const flame = { ...registry.baseline, id: "flame", name: "Flame", version: "1.0.0" }
// An edit not saved yet (Cancel takes the look back to the saved one: none, the baseline).
const sine: Look = { character: registry.baseline.id, options: { $sensitivity: 0.8 } }
const arrive = async (id: string) => {
  await act(async () => {
    held.get(id)!({ kind: "ready", character: flame })
    await Promise.resolve()
  })
}

describe("LookEditor: a pending pick is dropped when the editor leaves or the look changes from outside", () => {
  it("Flame picked, then \"Each assistant's own look\" before it has loaded: the device keeps following the assistant", async () => {
    held.clear()
    let state: DeviceLookState = { from: "device", look: undefined }
    function Device() {
      const [look, setLook] = useState<DeviceLookState>(state)
      state = look
      return (
        <>
          <button type="button" onClick={() => setLook({ from: "assistant" })}>Each assistant's own look</button>
          {look.from === "device" && <LookEditor value={look.look} onChange={(l) => setLook({ from: "device", look: l })} idPrefix="d" whose="Kitchen's own" foldPicker />}
        </>
      )
    }
    render(<Device />)
    fireEvent.click(screen.getByRole("button", { name: "flame" }))
    fireEvent.click(screen.getByRole("button", { name: "Each assistant's own look" }))
    expect(screen.queryByTestId("look-editor")).toBeNull()
    await arrive("flame")
    expect(state).toEqual({ from: "assistant" })
    expect(screen.queryByTestId("look-editor")).toBeNull()
  })

  it("Flame picked, then Cancel before it has loaded: the look stays the saved one", async () => {
    held.clear()
    let draft: Look | undefined
    function Tab() {
      const [look, setLook] = useState<Look | undefined>(sine)
      draft = look
      return (
        <>
          <button type="button" onClick={() => setLook(undefined)}>Cancel</button>
          <LookEditor value={look} onChange={setLook} idPrefix="a" whose="Jeff's" />
        </>
      )
    }
    render(<Tab />)
    fireEvent.click(screen.getByRole("button", { name: "flame" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await arrive("flame")
    expect(draft).toBeUndefined()
    expect(screen.getByTestId("look-editor").getAttribute("data-character")).toBe(registry.baseline.id)
  })

  it("Flame picked, then the editor unmounts before it has loaded: onChange is not called", async () => {
    held.clear()
    const onChange = vi.fn()
    const { unmount } = render(<LookEditor value={undefined} onChange={onChange} idPrefix="u" whose="Jeff's" />)
    fireEvent.click(screen.getByRole("button", { name: "flame" }))
    unmount()
    await arrive("flame")
    expect(onChange).not.toHaveBeenCalled()
  })

  it("the editor's own pick landing does not drop a later pick still on its way", async () => {
    held.clear()
    function Harness2() {
      const [look, setLook] = useState<Look | undefined>(undefined)
      return <LookEditor value={look} onChange={setLook} idPrefix="t2" whose="Jeff's" />
    }
    render(<Harness2 />)
    fireEvent.click(screen.getByRole("button", { name: "flame" }))
    await arrive("flame")
    expect(screen.getByTestId("look-editor").getAttribute("data-character")).toBe("flame")
    const other = registry.ids.find((x) => x !== "flame" && x !== registry.baseline.id)!
    fireEvent.click(screen.getByRole("button", { name: other }))
    await act(async () => {
      held.get(other)!({ kind: "ready", character: { ...registry.baseline, id: other, name: other, version: "1.0.0" } })
      await Promise.resolve()
    })
    expect(screen.getByTestId("look-editor").getAttribute("data-character")).toBe(other)
  })
})

