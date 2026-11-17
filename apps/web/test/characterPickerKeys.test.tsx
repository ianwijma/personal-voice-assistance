import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Look } from "@pva/protocol"
import type { Loaded } from "@/characters/catalog.ts"
import { registry } from "@/characters/registry.ts"

// PR #84 review 5: the picker's arrow keys move from the focused card, not from the selected one. A pick only becomes
// the selection once its chunk has loaded, so while a load is on its way (or after one failed) the two differ, and
// moving from the selection stalled on that card. The chunk loads are held here, so the test decides when each one
// arrives and whether it fails; `loadedNow` knows what has arrived, as the real catalog does.
const held = vi.hoisted(() => ({ waiting: new Map<string, Array<(r: Loaded) => void>>(), known: new Map<string, Loaded>() }))
vi.mock("@/characters/catalog.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/characters/catalog.ts")>()
  return {
    ...real,
    loadedNow: (id: string) => (id === registry.baseline.id ? real.loadedNow(id) : held.known.get(id)),
    loadCharacter: (id: string) => {
      if (id === registry.baseline.id) return real.loadCharacter(id)
      const now = held.known.get(id)
      if (now !== undefined) return Promise.resolve(now)
      return new Promise<Loaded>((resolve) => held.waiting.set(id, [...(held.waiting.get(id) ?? []), resolve]))
    }
  }
})
vi.mock("@/components/looks/LookPreview.tsx", () => ({ LookPreview: () => null }))
// The cards' live previews (a canvas loop) are not the subject here.
vi.mock("@/characters/preview.ts", () => ({
  createPreviewLoop: () => ({ add: () => ({ setVisible: () => {}, setStored: () => {}, dispose: () => {} }), stop: () => {} })
}))

const { LookEditor } = await import("@/components/looks/LookEditor.tsx")

const ids = registry.ids
const at = (i: number) => ids[((i % ids.length) + ids.length) % ids.length]!
const fake = (id: string): Loaded => ({ kind: "ready", character: { ...registry.baseline, id, name: `Fake ${id}`, version: "1.0.0" } })
const settle = async (id: string, r: Loaded) => {
  await act(async () => {
    held.known.set(id, r)
    for (const resolve of held.waiting.get(id) ?? []) resolve(r)
    held.waiting.delete(id)
    await Promise.resolve()
    await Promise.resolve()
  })
}
const card = (id: string) => document.querySelector<HTMLElement>(`[data-character="${CSS.escape(id)}"][role="radio"]`)!
const key = (k: string) => fireEvent.keyDown(document.activeElement!, { key: k })
const selected = () => screen.getByTestId("look-editor").getAttribute("data-character")

function Harness() {
  const [look, setLook] = useState<Look | undefined>(undefined)
  return <LookEditor value={look} onChange={setLook} idPrefix="k" whose="Jeff's" />
}

beforeEach(() => {
  held.waiting.clear()
  held.known.clear()
})

describe("CharacterPicker: arrows move from the focused card", () => {
  expect(ids.length).toBeGreaterThanOrEqual(4)
  const b = ids.indexOf(registry.baseline.id)

  it("Right onto a card still loading, then Right again: focus moves on to the card after it", async () => {
    render(<Harness />)
    card(at(b)).focus()
    key("ArrowRight")
    expect(document.activeElement).toBe(card(at(b + 1)))
    key("ArrowRight")
    expect(document.activeElement).toBe(card(at(b + 2)))
    expect(card(at(b + 2)).tabIndex).toBe(0)
    expect(card(at(b + 1)).tabIndex).toBe(-1)
    // Both loads arrive; only the newest pick applies.
    await settle(at(b + 1), fake(at(b + 1)))
    expect(selected()).toBe(registry.baseline.id)
    await settle(at(b + 2), fake(at(b + 2)))
    expect(selected()).toBe(at(b + 2))
    expect(card(at(b + 2)).getAttribute("aria-checked")).toBe("true")
  })

  it("a card whose load fails while focused does not trap forward movement", async () => {
    render(<Harness />)
    card(at(b)).focus()
    key("ArrowRight")
    await settle(at(b + 1), { kind: "unavailable", reason: "chunk failed" })
    expect(card(at(b + 1)).getAttribute("aria-disabled")).toBe("true")
    expect(card(at(b + 1)).textContent).toContain("Not available")
    expect(selected()).toBe(registry.baseline.id)
    key("ArrowRight")
    expect(document.activeElement).toBe(card(at(b + 2)))
    await settle(at(b + 2), fake(at(b + 2)))
    expect(selected()).toBe(at(b + 2))
  })

  it("a card known to be unavailable is skipped, both ways", async () => {
    held.known.set(at(b + 1), { kind: "unavailable", reason: "chunk failed" })
    render(<Harness />)
    card(at(b)).focus()
    key("ArrowRight")
    expect(document.activeElement).toBe(card(at(b + 2)))
    key("ArrowLeft")
    expect(document.activeElement).toBe(card(at(b)))
  })

  it("Home and End go to the first and last card from wherever focus is, and the last loaded pick is the selection", async () => {
    render(<Harness />)
    card(at(b)).focus()
    key("ArrowRight")
    key("End")
    expect(document.activeElement).toBe(card(ids[ids.length - 1]!))
    key("Home")
    expect(document.activeElement).toBe(card(ids[0]!))
    for (const id of ids) if (id !== registry.baseline.id) await settle(id, fake(id))
    expect(selected()).toBe(ids[0])
  })

  it("the tab stop goes back to the selected card when focus leaves the group", async () => {
    render(<><Harness /><button type="button">after</button></>)
    card(at(b)).focus()
    key("ArrowRight")
    expect(card(at(b + 1)).tabIndex).toBe(0)
    act(() => screen.getByRole("button", { name: "after" }).focus())
    expect(card(at(b)).tabIndex).toBe(0)
    expect(card(at(b + 1)).tabIndex).toBe(-1)
  })
})
