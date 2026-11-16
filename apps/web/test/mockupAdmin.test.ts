import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { loadMockup } from "./mockupPage"

// The admin mock-up (docs/mockups/assistants/admin.html). Errors thrown in its event handlers
// are reported on window rather than to the caller, so they are collected here.
const errors: Array<unknown> = []
const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message)

beforeAll(() => {
  window.addEventListener("error", onError)
  window.history.replaceState(null, "", "#overview")
  loadMockup("admin")
})
afterAll(() => {
  window.removeEventListener("error", onError)
  vi.unstubAllGlobals()
})

const title = () => document.getElementById("page-title")?.textContent

describe("admin mock-up", () => {
  it("still renders Overview after a device with a voice session is forgotten", async () => {
    expect(title()).toBe("Overview")
    expect(document.querySelector('a.row[href="#devices/desk"]')).not.toBeNull()

    location.hash = "#devices/desk"
    await vi.waitFor(() => expect(document.querySelector('[data-act="forget"][data-id="desk"]')).not.toBeNull())
    ;(document.querySelector('[data-act="forget"][data-id="desk"]') as HTMLButtonElement).click()
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("#overlay [data-dlg]")].find(
      (b) => b.textContent === "Forget"
    )
    expect(confirm).toBeDefined()
    confirm!.click()
    await vi.waitFor(() => expect(document.querySelector('[data-act="forget"]')).toBeNull())

    location.hash = "#overview"
    await vi.waitFor(() => expect(title()).toBe("Overview"))
    expect(errors).toEqual([])
    expect(document.querySelector('a[href="#devices/desk"]')).toBeNull()
    expect(document.querySelector('a.row[href="#devices/iphone"]')).not.toBeNull()
    expect(document.body.textContent).toContain("0 talking · 2 of 4")
  })
})
