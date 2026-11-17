import { act, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { AssistantInfo, DeviceUser, VoiceEntry } from "@pva/protocol"
import { exampleAssistant, exampleDevice, exampleDeviceType } from "@pva/protocol/examples"
import { ClientContext } from "@/components/context.tsx"
import { UsedBy } from "@/components/pickers/UsedBy.tsx"
import type { PickerSource } from "@/components/pickers/CatalogPicker.tsx"
import { mapVoice, voiceSource } from "@/components/voices/VoicePicker.tsx"
import { catalogFor } from "@/components/voices/useVoiceCatalog.ts"
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

describe("the voice picker's users follow the admin state (the catalogue is loaded once)", () => {
  const lessac = { provider: "piper", voiceId: "en_US-lessac-medium" } as const
  const amy = { provider: "piper", voiceId: "en_US-amy-medium" } as const
  const entry = (voice: { readonly provider: string; readonly voiceId: string }, name: string): VoiceEntry =>
    ({ voice, key: `${voice.provider}:${voice.voiceId}`, name, tags: [], previewable: true, usedBy: [], favourite: false })
  const info = (id: string, name: string, voice: typeof lessac | typeof amy) =>
    ({ ...exampleAssistant, id, name, voice, usedOn: [], resources: { llm: "unused", voice: "unused" }, problems: [] }) as unknown as AssistantInfo

  function Probe({ source }: { readonly source: PickerSource }) {
    const { lists } = source.useState()
    return (
      <ul>
        {lists.flatMap((p) => p.rows).map((r) => (
          <li key={r.key} data-testid={r.key}>{[...r.usedBy, "|", ...(r.usedByDevices ?? []).map((d) => d.name)].join(" ")}</li>
        ))}
      </ul>
    )
  }

  it("a device's own voice, then its reset, and an assistant's new voice show at once", () => {
    const store = createStore({
      ...initialState,
      adminReady: true,
      assistants: [info("jeff", "Jeff", lessac)],
      devices: [exampleDevice],
      deviceTypes: [exampleDeviceType]
    }, reducer)
    const client = { store, subscribe: store.subscribe } as unknown as AssistantClient
    const catalog = catalogFor(client)
    // The catalogue's answer, loaded before any of the saves below (its own users are those of that moment).
    catalog.store.dispatch({
      load: "ready",
      lists: [{ provider: { id: "piper", label: "Piper", location: "local", status: "ready", settingsPath: [] }, voices: [entry(lessac, "Lessac"), entry(amy, "Amy")] }] as never
    })
    render(<ClientContext.Provider value={client}><Probe source={voiceSource(catalog)} /></ClientContext.Provider>)
    const users = (key: string) => screen.getByTestId(key).textContent
    expect(users("piper:en_US-lessac-medium")).toBe("jeff |")
    expect(users("piper:en_US-amy-medium")).toBe("|")

    // The device gets its own voice (device.save → `devices`).
    const own = { ...exampleDevice, own: { ...exampleDevice.own, voice: { from: "device" as const, voice: amy } }, settings: { ...exampleDevice.settings, voice: { from: "device" as const, voice: amy } } }
    act(() => store.dispatch({ type: "devices", devices: [own] }))
    expect(users("piper:en_US-amy-medium")).toBe("| iPhone · Safari")

    // The type's defaults get one too, and then the device is reset (follows the type again: it speaks with the type's voice).
    act(() => store.dispatch({ type: "device.types", types: [{ ...exampleDeviceType, settings: { ...exampleDeviceType.settings, voice: { from: "device", voice: lessac } } }] }))
    act(() => store.dispatch({ type: "devices", devices: [{ ...exampleDevice, settings: { ...exampleDevice.settings, voice: { from: "device", voice: lessac } } }] }))
    expect(users("piper:en_US-amy-medium")).toBe("|")
    expect(users("piper:en_US-lessac-medium")).toBe("jeff | Every browser iPhone · Safari")

    // The assistant's voice changes (assistant.save → `assistants`).
    act(() => store.dispatch({ type: "assistants", assistants: [info("jeff", "Jeff", amy)] }))
    expect(users("piper:en_US-amy-medium")).toBe("jeff |")
    expect(users("piper:en_US-lessac-medium")).toBe("| Every browser iPhone · Safari")
  })

  it("before the admin state has arrived, the catalogue's own answer is shown", () => {
    const store = createStore({ ...initialState, adminReady: false }, reducer)
    const client = { store } as unknown as AssistantClient
    const catalog = catalogFor(client)
    catalog.store.dispatch({
      load: "ready",
      lists: [{ provider: { id: "piper", label: "Piper", location: "local", status: "ready", settingsPath: [] }, voices: [{ ...entry(lessac, "Lessac"), usedBy: ["jeff"], usedByDevices: [kitchen] }] }] as never
    })
    render(<ClientContext.Provider value={client}><Probe source={voiceSource(catalog)} /></ClientContext.Provider>)
    expect(screen.getByTestId("piper:en_US-lessac-medium").textContent).toBe("jeff | Kitchen iPad")
  })
})
