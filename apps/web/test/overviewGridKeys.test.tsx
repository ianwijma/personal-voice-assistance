import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WEB_VOICE_KIND } from "@pva/protocol"
import { exampleAssistantInfo, exampleDevice, exampleDeviceType } from "@pva/protocol/examples"
import type { AssistantClient } from "@/lib/client.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { ClientContext } from "@/components/context.tsx"
import { WhoAnswersWhere } from "@/components/settings/pages/OverviewPage.tsx"

// PR #35 review 6, sweep of finding 1's class: the grid's group headings sit in the same list as the device rows, so
// their keys must not be something a device id can be (`g-web-voice` is a valid device id).
describe("Overview › Who answers where: row keys", () => {
  it("a device whose id looks like a group heading's old key keeps its own row, with no duplicate keys", () => {
    const lookalike = { ...exampleDevice, id: `g-${WEB_VOICE_KIND}`, name: "Look-alike" }
    const store = createStore({ ...initialState, deviceTypes: [exampleDeviceType], devices: [lookalike], assistants: [exampleAssistantInfo] }, reducer)
    const client = { store, settings: vi.fn() } as unknown as AssistantClient
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const { container } = render(<ClientContext.Provider value={client}><WhoAnswersWhere /></ClientContext.Provider>)
      expect(container.querySelectorAll(`[data-row="${lookalike.id}"]`)).toHaveLength(1)
      expect(container.querySelectorAll(`[data-row="type:${WEB_VOICE_KIND}"]`)).toHaveLength(1)
      expect(errors.mock.calls.some((c) => c.some((x) => typeof x === "string" && x.includes("same key")))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })
})
