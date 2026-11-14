import { describe, expect, it } from "vitest"
import { moduleBadge, moduleSwitchBusy } from "@/components/settings/ModuleHeader.tsx"

describe("module card", () => {
  it("shows a disabled module in its 10 s grace (stopping) as off: no badge, no busy switch", () => {
    expect(moduleBadge("stopping")).toBeUndefined()
    expect(moduleSwitchBusy("stopping", false)).toBe(false)
    expect(moduleBadge("starting")).toBe("Starting")
    expect(moduleSwitchBusy("starting", false)).toBe(true)
    expect(moduleSwitchBusy("running", true)).toBe(true)
    expect(moduleBadge("error")).toBe("Error")
  })
})
