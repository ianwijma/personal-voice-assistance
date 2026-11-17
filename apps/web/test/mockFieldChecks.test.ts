import { describe, expect, it } from "vitest"
import { fieldValueError } from "../mock/fieldChecks.ts"

// P2 review round 3, finding 8: the mock refuses the Home values the real server refuses. These are unit cases of the helper; that a
// refused save keeps the old values and revision is tested through the mock's save handler in mockHomeSave.test.ts (round 4).
describe("mock field checks", () => {
  const text = (key: string, maxLength?: number) => ({ key, type: "text", ...(maxLength !== undefined ? { maxLength } : {}) })
  const cup = { key: "HOME_CUP_SIZE", type: "choice", options: [{ value: "metric" }, { value: "us" }] }

  it("the reviewer's values are refused", () => {
    expect(fieldValueError(text("HOME_CURRENCY", 3), "eur")).toBeDefined()
    expect(fieldValueError(cup, "teacup")).toBeDefined()
    expect(fieldValueError(text("HOME_API_CONTACT", 200), "a\r\nX-Evil: 1")).toBeDefined()
    expect(fieldValueError(text("HOME_TIME_ZONE", 64), "+01:00")).toBeDefined()
    expect(fieldValueError(text("HOME_TIME_ZONE", 64), "Mars/Olympus")).toBeDefined()
    expect(fieldValueError(text("HOME_LOCATION", 5), "Amsterdam")).toBeDefined()
    expect(fieldValueError({ key: "HOME_UNITS", type: "choice", options: [{ value: "metric" }] }, 3)).toBeDefined()
  })
  it("the values the real server accepts pass", () => {
    expect(fieldValueError(text("HOME_CURRENCY", 3), "ZZZ")).toBeUndefined()
    expect(fieldValueError(cup, "us")).toBeUndefined()
    expect(fieldValueError(text("HOME_API_CONTACT", 200), "you@example.com")).toBeUndefined()
    expect(fieldValueError(text("HOME_TIME_ZONE", 64), "")).toBeUndefined()
    expect(fieldValueError(text("HOME_TIME_ZONE", 64), " europe/amsterdam ")).toBeUndefined()
    expect(fieldValueError(text("HOME_CURRENCY", 3), null)).toBeUndefined()
  })
})
