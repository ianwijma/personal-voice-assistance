import { act, fireEvent, render } from "@testing-library/react"
import { useRef, useState } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { useDialog } from "@/components/ui/Panel.tsx"

// jsdom has no layout: every element would count as hidden (`offsetParent === null`).
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get() { return this.parentNode } })
})
afterEach(() => {
  document.body.innerHTML = ""
})

function Dialog({ onClose, initial, textareaDisabled, buttonsDisabled, inert = false }: {
  readonly onClose: () => void
  readonly initial?: string
  readonly textareaDisabled?: boolean
  readonly buttonsDisabled?: boolean
  readonly inert?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useDialog(ref, true, onClose, initial, { inertBackground: inert })
  return (
    <div>
      <main data-testid="behind"><button>behind</button></main>
      <div data-keep-active="" data-testid="toasts" />
      <div ref={ref} role="dialog" data-testid="dialog">
        <button data-testid="close" disabled={buttonsDisabled}>Close</button>
        <textarea id="input" data-testid="input" disabled={textareaDisabled} />
        <button data-testid="last" disabled={buttonsDisabled}>Last</button>
      </div>
    </div>
  )
}

describe("dialog focus (review round 3)", () => {
  it("focuses the chosen control when it is enabled", () => {
    const v = render(<Dialog onClose={() => undefined} initial="#input" />)
    expect(document.activeElement).toBe(v.getByTestId("input"))
  })

  it("falls back to the first enabled control when the chosen one is disabled", () => {
    const v = render(<Dialog onClose={() => undefined} initial="#input" textareaDisabled />)
    expect(document.activeElement).toBe(v.getByTestId("close"))
  })

  it("falls back to the dialog itself when nothing in it is enabled, and keeps Tab and Esc there", () => {
    const onClose = vi.fn()
    const v = render(<Dialog onClose={onClose} initial="#input" textareaDisabled buttonsDisabled />)
    const dialog = v.getByTestId("dialog")
    expect(dialog.getAttribute("tabindex")).toBe("-1")
    expect(document.activeElement).toBe(dialog)
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    dialog.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("handles Esc when focus has dropped to the page body", () => {
    const onClose = vi.fn()
    render(<Dialog onClose={onClose} />)
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("brings focus back into the dialog when the focused control becomes disabled", async () => {
    function Busy() {
      const [busy, setBusy] = useState(false)
      const ref = useRef<HTMLDivElement>(null)
      useDialog(ref, true, () => undefined)
      return (
        <div ref={ref} data-testid="dialog">
          <button data-testid="go" disabled={busy} onClick={() => setBusy(true)}>Go</button>
          <button data-testid="other" disabled={busy}>Other</button>
        </div>
      )
    }
    const v = render(<Busy />)
    v.getByTestId("go").focus()
    await act(async () => {
      fireEvent.click(v.getByTestId("go"))
      await Promise.resolve()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(document.activeElement).toBe(v.getByTestId("dialog"))
  })

  it("makes everything outside inert while open (except what is kept active) and restores it", () => {
    const v = render(<Dialog onClose={() => undefined} inert />)
    expect(v.getByTestId("behind").inert).toBe(true)
    expect(v.getByTestId("toasts").inert).not.toBe(true)
    v.unmount()
    expect(document.querySelector("main")).toBeNull()
  })

  it("restores the background when the dialog closes", () => {
    function Host() {
      const [open, setOpen] = useState(true)
      const ref = useRef<HTMLDivElement>(null)
      useDialog(ref, open, () => setOpen(false), undefined, { inertBackground: true })
      return (
        <div>
          <main data-testid="behind" />
          {open && <div ref={ref} />}
          <button data-testid="x" onClick={() => setOpen(false)} />
        </div>
      )
    }
    const v = render(<Host />)
    expect(v.getByTestId("behind").inert).toBe(true)
    fireEvent.keyDown(document.body, { key: "Escape" })
    expect(v.getByTestId("behind").inert).not.toBe(true)
  })
})


it("r7 b1: modal Tab includes arriving fixed notification controls without moving them inside the dialog", () => {
  function Host({ ring }: { readonly ring: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    useDialog(ref, true, () => undefined, undefined, { extraFocus: "#fixed-notifications" })
    return <>
      <div id="fixed-notifications">{ring && <><button data-testid="stop">Stop</button><button disabled>Snooze</button></>}</div>
      <div ref={ref}><button data-testid="first">First</button><button data-testid="last">Last</button></div>
    </>
  }
  const v = render(<Host ring={false} />)
  v.getByTestId("last").focus()
  v.rerender(<Host ring />)
  expect(document.activeElement).toBe(v.getByTestId("last"))
  fireEvent.keyDown(document.activeElement!, { key: "Tab" })
  expect(document.activeElement).toBe(v.getByTestId("stop"))
  fireEvent.keyDown(document.activeElement!, { key: "Tab" })
  expect(document.activeElement).toBe(v.getByTestId("first"))
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true })
  expect(document.activeElement).toBe(v.getByTestId("stop"))
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true })
  expect(document.activeElement).toBe(v.getByTestId("last"))
})
