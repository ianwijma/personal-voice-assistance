import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { AssistantInfo, DeviceUser, VoiceEntry } from "@pva/protocol"
import { exampleAssistant } from "@pva/protocol/examples"
import { ClientContext } from "@/components/context.tsx"
import { UsedBy } from "@/components/pickers/UsedBy.tsx"
import { mapVoice } from "@/components/voices/VoicePicker.tsx"
import type { AssistantClient } from "@/lib/client.ts"
import { deviceUserPath } from "@/lib/catalogPicker.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"

// A voice's users: the assistants and, new, the devices (and device types' defaults) that use it as their own.
const kitchen: DeviceUser = { target: { kind: "device", id: "d-kitchen-ipad-0001" }, name: "Kitchen iPad" }
const everyBrowser: DeviceUser = { target: { kind: "type", type: "web-voice" }, name: "Every browser" }

const view = (assistants: ReadonlyArray<string>, devices: ReadonlyArray<DeviceUser>, plain = false) => {
  const info = (id: string, name: string) => ({ ...exampleAssistant, id, name, usedOn: [], resources: { llm: "unused", voice: "unused" }, problems: [] }) as unknown as AssistantInfo
  const store = createStore({ ...initialState, assistants: [info("jeff", "Jeff"), info("t3", "T3")] }, reducer)
  const client = { store } as unknown as AssistantClient
  return render(<ClientContext.Provider value={client}><UsedBy assistants={assistants} devices={devices} plain={plain} /></ClientContext.Provider>)
}

describe("UsedBy", () => {
  it("names the assistants, then the devices, each linking to its page", () => {
    view(["jeff", "t3"], [kitchen, everyBrowser])
    expect(screen.getByTestId("used-by").textContent).toBe("Used by Jeff, T3 · Kitchen iPad, Every browser")
    const links = screen.getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])
    expect(links).toEqual([
      ["Jeff", "#settings/assistants/jeff/voice"],
      ["T3", "#settings/assistants/t3/voice"],
      ["Kitchen iPad", "#settings/devices/d-kitchen-ipad-0001"],
      ["Every browser", "#settings/devices/type.web-voice"]
    ])
  })

  it("plain (a picker row): the same names, no links, so the row's Tab order is unchanged", () => {
    view(["jeff"], [kitchen], true)
    expect(screen.getByTestId("used-by").textContent).toBe("Used by Jeff · Kitchen iPad")
    expect(screen.queryAllByRole("link")).toEqual([])
  })

  it("shows devices alone, assistants alone, and nothing when there are none", () => {
    const first = view([], [kitchen])
    expect(screen.getByTestId("used-by").textContent).toBe("Used by Kitchen iPad")
    first.unmount()
    const second = view(["jeff"], [])
    expect(screen.getByTestId("used-by").textContent).toBe("Used by Jeff")
    second.unmount()
    view([], [])
    expect(screen.queryByTestId("used-by")).toBeNull()
  })
})

describe("the voice catalogue's rows", () => {
  const entry = (extra: Partial<VoiceEntry>): VoiceEntry => ({ voice: { provider: "sherpa", voiceId: "x" }, key: "sherpa:x", name: "X", tags: [], previewable: true, usedBy: ["jeff"], favourite: false, ...extra })

  it("carry the devices of the entry; an older server's answer (no field) is an empty list", () => {
    expect(mapVoice(entry({ usedByDevices: [kitchen] })).usedByDevices).toEqual([kitchen])
    expect(mapVoice(entry({})).usedByDevices).toEqual([])
    expect(mapVoice(entry({})).usedBy).toEqual(["jeff"])
  })

  it("link a type's defaults to their page", () => {
    expect(deviceUserPath(everyBrowser)).toEqual(["devices", "type.web-voice"])
    expect(deviceUserPath(kitchen)).toEqual(["devices", "d-kitchen-ipad-0001"])
  })
})
