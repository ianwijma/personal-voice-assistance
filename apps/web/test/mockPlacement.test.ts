import { describe, expect, it } from "vitest"
import { withPlacement } from "../mock/assistants.ts"

// PR #35 review 3, note: the mock places a created assistant as the server's `withPlacement` does.
describe("mock withPlacement", () => {
  const list = [{ assistant: "jeff", phrases: ["hey jeff"] }]

  it("appends an assistant that is not in the list, with its phrase", () => {
    expect(withPlacement(list, "mia", "hey mia")).toEqual([...list, { assistant: "mia", phrases: ["hey mia"] }])
    expect(withPlacement(list, "mia", undefined)).toEqual([...list, { assistant: "mia", phrases: [] }])
  })

  it("one already in it (a device following its type, placed on the type first) gets the phrase, not a second entry", () => {
    const followed = withPlacement(list, "mia", "hey mia")
    expect(withPlacement(followed, "mia", "mia please")).toEqual([...list, { assistant: "mia", phrases: ["hey mia", "mia please"] }])
    expect(withPlacement(followed, "mia", "hey mia")).toBe(followed)
    expect(withPlacement(followed, "mia", undefined)).toBe(followed)
  })
})
