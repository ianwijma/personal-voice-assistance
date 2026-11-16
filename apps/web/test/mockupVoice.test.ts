import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { loadMockup } from "./mockupPage"

// The voice mock-up (docs/mockups/assistants/voice.html). A typed message gets its canned reply
// 700 ms later.
beforeAll(() => {
  // Fake before loading, so the page's own intervals never run after the test file ends.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  loadMockup("voice")
  ;(document.getElementById("chat-btn") as HTMLButtonElement).click()
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const input = () => document.getElementById("chat-input") as HTMLTextAreaElement
const type = (text: string) => {
  input().value = text
  input().dispatchEvent(new Event("input", { bubbles: true }))
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}
const turns = () => [...document.querySelectorAll("#msgs .turn")]
const newConversation = () => (document.getElementById("chat-new") as HTMLButtonElement).click()

describe("voice mock-up typed replies", () => {
  beforeEach(() => {
    newConversation()
    vi.advanceTimersByTime(1000)
  })

  it("answers each of two quick messages", () => {
    type("first")
    type("second")
    vi.advanceTimersByTime(700)
    const t = turns()
    expect(t).toHaveLength(2)
    expect(t[0]!.querySelector(".msg.you")?.textContent).toContain("first")
    expect(t[0]!.querySelector(".msg.voice")).not.toBeNull()
    expect(t[1]!.querySelector(".msg.you")?.textContent).toContain("second")
    expect(t[1]!.querySelector(".msg.voice")).not.toBeNull()
  })

  it("drops the reply when a new conversation starts before it arrives", () => {
    type("hello")
    expect(turns()).toHaveLength(1)
    newConversation()
    expect(() => vi.advanceTimersByTime(700)).not.toThrow()
    expect(turns()).toHaveLength(0)
    expect(document.querySelector("#msgs .empty-chat")).not.toBeNull()
  })
})
