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
