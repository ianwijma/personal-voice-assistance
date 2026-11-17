// Review round 5 of PR 90 (5A-3): the admin view lists at most a hundred of a module's tools and says how many more.
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { exampleWeatherModule } from "@pva/protocol/examples"
import { ModuleTools } from "@/components/settings/ModuleHeader.tsx"

describe("a module's tools on its page", () => {
  it("says how many tools are not listed", () => {
    render(<ModuleTools module={{ ...exampleWeatherModule, toolsLeft: 50 }} />)
    expect(screen.getByTestId("tools-left")).toHaveTextContent("and 50 more")
  })

  it("says how many there are when none is listed, and nothing when none is left out", () => {
    const { unmount } = render(<ModuleTools module={{ ...exampleWeatherModule, tools: [], toolsLeft: 3 }} />)
    expect(screen.getByTestId("tools-left")).toHaveTextContent("3 tools")
    unmount()
    render(<ModuleTools module={exampleWeatherModule} />)
    expect(screen.queryByTestId("tools-left")).toBeNull()
  })
})
