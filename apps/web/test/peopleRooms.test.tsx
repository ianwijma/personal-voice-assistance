import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type ClientMessage, type DeviceCapabilities, type DeviceListInfo, type SettingField, type SettingsSection, type SettingValue } from "@pva/protocol"
import { exampleAssistantInfo, exampleDevice, exampleDeviceType, exampleVoiceSection } from "@pva/protocol/examples"
import type { Outcome } from "@/lib/assistants.ts"
import { type CapabilityEnv, measureCapabilities, watchCapabilities } from "@/lib/capabilities.ts"
import type { AssistantClient } from "@/lib/client.ts"
import { declaredRows, kindsFor, membersOf } from "@/lib/place.ts"
import { buildSettingsTree, typePageId } from "@/lib/settingsTree.ts"
import { initialState, reducer } from "@/lib/state.ts"
import { createStore } from "@/lib/store.ts"
import { rendererFor } from "@/ui/fieldRenderers.ts"
import { ClientContext } from "@/components/context.tsx"
import { DevicePage } from "@/components/settings/pages/DevicesPages.tsx"

// Protocol 11 (docs/MODULES-PLAN.md §4 P5): what the voice page declares and when it says so again, the admin's Place
// and "What it can do" sections, Members with a hidden id, and where Members sits among the shared pages.

const env = (over: Partial<CapabilityEnv> = {}): CapabilityEnv => ({
  width: 1024,
  height: 768,
  dpr: 2,
  matches: (q) => q === "(pointer: coarse)",
  userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
  audioOut: true,
  microphone: true,
  ...over
})

describe("measuring what this browser can do", () => {
  it("a tablet, a desktop window, a phone, and a page without audio", () => {
    expect(measureCapabilities(env())).toEqual({
      v: 1,
      display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true },
      // P10: the page draws every kind of the first version.
      present: { kinds: { card: 1, list: 1, timer: 1, image: 1, weather: 1 } },
      speaker: { media: ["speech", "audio"] },
      microphone: { farField: false }
    })
    const desktop = measureCapabilities(env({ width: 1600, height: 900, dpr: 1, matches: (q) => q === "(pointer: fine)", userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130" }))
    expect(desktop.display).toMatchObject({ class: "large", touch: "fine" })
    expect(desktop.openUrl).toBeUndefined()
    const phone = measureCapabilities(env({ width: 390, height: 844, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile" }))
    expect(phone).toMatchObject({ display: { class: "compact" }, openUrl: true })
    const quiet = measureCapabilities(env({ audioOut: false, microphone: false, matches: (q) => q === "(monochrome)" }))
    expect(quiet.speaker).toBeUndefined()
    expect(quiet.microphone).toBeUndefined()
    expect(quiet.display).toMatchObject({ touch: "none", colour: false })
  })
})

describe("telling the server again (device.caps)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const harness = () => {
    let measured: DeviceCapabilities = measureCapabilities(env())
    let visible = true
    let connected = true
    const sent: Array<ClientMessage> = []
    const target = new EventTarget()
    const doc = new EventTarget()
    const watch = watchCapabilities({
      send: (m) => {
        if (!connected) return false
        sent.push(m)
        return true
      },
      measure: () => measured,
      visible: () => visible,
      now: () => Date.now(),
      target: target as unknown as Window,
      doc: doc as unknown as Document
    })
    return {
      sent,
      watch,
      resize: (w: number, h: number) => {
        measured = measureCapabilities(env({ width: w, height: h }))
        target.dispatchEvent(new Event("resize"))
      },
      hide: (hidden: boolean) => {
        visible = !hidden
        doc.dispatchEvent(new Event("visibilitychange"))
      },
      touch: () => target.dispatchEvent(new Event("pointerdown")),
      disconnect: (off: boolean) => {
        connected = !off
      }
    }
  }

  it("only what changed, at most once a second, the last change winning", () => {
    const h = harness()
    // A resize event that changes nothing sends nothing.
    h.resize(1024, 768)
    vi.advanceTimersByTime(1000)
    expect(h.sent).toEqual([])
    h.resize(800, 600)
    vi.advanceTimersByTime(0)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]).toMatchObject({ type: "device.caps", capabilities: { display: { widthPx: 800, heightPx: 600 } } })
    expect("live" in h.sent[0]!).toBe(false)
    // Three more within the second: one message, with the last size.
    h.resize(700, 600)
    h.resize(390, 844)
    h.hide(true)
    vi.advanceTimersByTime(999)
    expect(h.sent).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toMatchObject({ capabilities: { display: { class: "compact", widthPx: 390 } }, live: { visible: false } })
    h.watch.stop()
  })

  it("an interaction is live state; while disconnected nothing is lost: after the next welcome the live state goes again", () => {
    const h = harness()
    vi.setSystemTime(50_000)
    h.touch()
    vi.advanceTimersByTime(0)
    expect(h.sent.at(-1)).toEqual({ type: "device.caps", live: { visible: true, lastInteractionAt: 50_000 } })
    h.disconnect(true)
    vi.advanceTimersByTime(2000)
    h.hide(true)
    vi.advanceTimersByTime(2000)
    expect(h.sent).toHaveLength(1)
    h.disconnect(false)
    h.watch.resync()
    vi.advanceTimersByTime(1000)
    // The server forgot this tab's live state with the old connection: all of it goes again, with the declaration.
    expect(h.sent.at(-1)).toMatchObject({ type: "device.caps", capabilities: { v: 1 }, live: { visible: false, lastInteractionAt: 50_000 } })
    h.watch.stop()
  })

  it("a media-query change alone (pointer, colour, pixel ratio) is measured again; the resolution query is re-armed; stop removes all (round 2)", () => {
    // Fake media query lists: one per query, with their listeners; `fire` changes one.
    const lists = new Map<string, { listeners: Set<() => void>; legacy: boolean }>()
    const matchMedia = (q: string) => {
      const legacy = q === "(monochrome)" // an older browser: addListener only
      const list = lists.get(q) ?? { listeners: new Set<() => void>(), legacy }
      lists.set(q, list)
      return legacy
        ? { addListener: (f: () => void) => void list.listeners.add(f), removeListener: (f: () => void) => void list.listeners.delete(f) }
        : { addEventListener: (_: "change", f: () => void) => void list.listeners.add(f), removeEventListener: (_: "change", f: () => void) => void list.listeners.delete(f) }
    }
    const fire = (q: string) => {
      for (const f of [...(lists.get(q)?.listeners ?? [])]) f()
    }
    let pointer: "coarse" | "fine" = "fine"
    let ratio = 2
    const measuredNow = () => measureCapabilities(env({ matches: (q) => q === `(pointer: ${pointer})`, dpr: ratio }))
    const sent: Array<ClientMessage> = []
    const watch = watchCapabilities({
      send: (m) => {
        sent.push(m)
        return true
      },
      measure: measuredNow,
      visible: () => true,
      now: () => Date.now(),
      target: new EventTarget() as unknown as Window,
      doc: new EventTarget() as unknown as Document,
      matchMedia,
      dpr: () => ratio
    })
    for (const q of ["(pointer: coarse)", "(pointer: fine)", "(monochrome)", "(resolution: 2dppx)"]) expect(lists.get(q)?.listeners.size, q).toBe(1)
    // A pen tablet switched to touch, nothing resized.
    pointer = "coarse"
    fire("(pointer: coarse)")
    vi.advanceTimersByTime(1000)
    expect(sent.at(-1)).toMatchObject({ type: "device.caps", capabilities: { display: { touch: "coarse" } } })
    // Moved to a screen with another pixel ratio: measured again, and the query is now the new one's.
    ratio = 1
    fire("(resolution: 2dppx)")
    vi.advanceTimersByTime(1000)
    expect(sent.at(-1)).toMatchObject({ capabilities: { display: { dpr: 1 } } })
    expect(lists.get("(resolution: 2dppx)")!.listeners.size).toBe(0)
    expect(lists.get("(resolution: 1dppx)")!.listeners.size).toBe(1)
    watch.stop()
    for (const [q, list] of lists) expect(list.listeners.size, q).toBe(0)
    // Without matchMedia at all: nothing breaks.
    watchCapabilities({ send: () => true, measure: measuredNow, target: new EventTarget() as unknown as Window, doc: new EventTarget() as unknown as Document, matchMedia: undefined }).stop()
  })

  it("a change between hello and welcome is not lost: after every welcome the current declaration is sent (finding 22)", () => {
    const h = harness()
    // hello went with 1024 × 768; before the welcome (nothing can be sent) the tablet rotates to a phone-size window.
    h.disconnect(true)
    h.resize(390, 844)
    vi.advanceTimersByTime(2000)
    expect(h.sent).toEqual([])
    h.disconnect(false)
    h.watch.resync()
    vi.advanceTimersByTime(1000)
    expect(h.sent.at(-1)).toMatchObject({ type: "device.caps", capabilities: { display: { class: "compact", widthPx: 390, heightPx: 844 } } })
    // A reconnect with nothing changed still sends it (the server ignores a declaration it already has).
    const before = h.sent.length
    h.watch.resync()
    vi.advanceTimersByTime(1000)
    expect(h.sent.length).toBe(before + 1)
    expect(h.sent.at(-1)).toMatchObject({ capabilities: { display: { widthPx: 390 } } })
    h.watch.stop()
  })
})

const members = (people: ReadonlyArray<Record<string, unknown>>): SettingsSection => ({
  ...exampleVoiceSection,
  id: "members",
  title: "Members",
  group: "modules",
  page: { id: "members", title: "Members" },
  form: { fields: [], values: { HOUSEHOLD_MEMBERS: people as unknown as SettingValue }, secrets: {}, errors: [] }
})

describe("Members", () => {
  it("the people a device may name (records the server has given an id), and the rows of a declaration", () => {
    expect(membersOf([members([{ id: "p-sam00001", name: "Sam" }, { id: "", name: "New" }, { name: "No id" }, { id: "p-x0000001", name: " " }])])).toEqual([{ id: "p-sam00001", name: "Sam" }])
    expect(membersOf([])).toEqual([])
    const rows = declaredRows({ v: 1, display: { class: "compact", widthPx: 412, heightPx: 915, dpr: 2.63, touch: "coarse", colour: true }, speaker: { media: ["speech"] }, openUrl: true })
    expect(rows.map((r) => [r.label, r.value, r.has])).toEqual([
      ["Screen", "Phone-size screen, 412 × 915 at ×2.63, touch", true],
      ["Speaker", "Speech", true],
      ["Microphone", "None", false],
      ["Opens links", "Yes (a phone)", true]
    ])
    // The speaker row names the actual media set (round 2): no "Speech" where none is played.
    const speaker = (media: ReadonlyArray<"speech" | "audio" | "video">) => declaredRows({ v: 1, speaker: { media } }).find((r) => r.key === "speaker")!.value
    expect(speaker(["speech", "audio"])).toBe("Speech and sound")
    expect(speaker(["audio"])).toBe("Sound, no speech")
    expect(speaker(["video"])).toBe("Video, no speech")
    expect(speaker([])).toBe("Plays nothing")
  })

  it("a hidden record field (a person's id) is kept in each record but not drawn", () => {
    const field: Extract<SettingField, { type: "records" }> = {
      type: "records",
      key: "HOUSEHOLD_MEMBERS",
      label: "People",
      apply: "live",
      default: [],
      itemFields: [
        { type: "text", key: "id", label: "Id", default: "", hidden: true },
        { type: "text", key: "name", label: "Name", default: "" }
      ],
      itemLabel: "person",
      titleKey: "name",
      orderable: false
    }
    const values: Array<SettingValue> = []
    function Harness() {
      const [value, setValue] = useState<SettingValue>([{ id: "p-sam00001", name: "Sam" }] as unknown as SettingValue)
      const Renderer = rendererFor(field)
      return <Renderer field={field} id="f" describedBy="f-d" value={value} onChange={(v) => {
        setValue(v)
        values.push(v)
      }} onSecretChange={() => undefined} disabled={false} invalid={false} onLocalError={() => undefined} />
    }
    render(<Harness />)
    const row = screen.getByTestId("record")
    expect(row).toHaveTextContent("Sam")
    expect(row).not.toHaveTextContent("p-sam00001")
    fireEvent.click(within(row).getByRole("button", { name: "Sam" }))
    expect(screen.queryByLabelText("Id")).toBeNull()
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Samantha" } })
    expect(values.at(-1)).toEqual([{ id: "p-sam00001", name: "Samantha" }])
    fireEvent.click(screen.getByRole("button", { name: "Add person" }))
    expect(values.at(-1)).toEqual([{ id: "p-sam00001", name: "Samantha" }, { id: "", name: "" }])
  })

  it("has its own page under Shared settings, right after Home", () => {
    const home: SettingsSection = { ...exampleVoiceSection, id: "home", title: "Home", group: "modules", page: { id: "home", title: "Home" }, form: { fields: [{ type: "text", key: "HOME_LOCATION", label: "Location", apply: "live", default: "" }], values: {}, secrets: {}, errors: [] } }
    const m = { ...members([]), form: { fields: [{ type: "textList", key: "HOUSEHOLD_DIET_DIETS", label: "Household diets", apply: "live", default: [], maxItems: 30, itemMaxLength: 60 } as SettingField], values: {}, secrets: {}, errors: [] } }
    const tree = buildSettingsTree({ sections: [home, m], modules: [], clientPages: [] })
    const shared = tree.find((g) => g.slug === "shared")!
    expect(shared.pages.map((p) => p.id).slice(0, 3)).toEqual(["home", "members", "modules"])
    expect(shared.pages.find((p) => p.id === "members")!.title).toBe("Members")
  })
})

describe("Devices › a device: Place and What it can do", () => {
  const declared: DeviceListInfo = {
    ...exampleDevice,
    connections: 0,
    declared: { capabilities: { v: 1, display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true }, present: { kinds: { card: 1 } }, speaker: { media: ["speech"] } }, seenAt: Date.now() - 5 * 60_000 }
  }
  const setup = (page: "device" | "type", device: DeviceListInfo = declared) => {
    const store = createStore(
      {
        ...initialState,
        deviceTypes: [exampleDeviceType],
        devices: [device],
        sections: [members([{ id: "p-sam00001", name: "Sam" }, { id: "p-robin001", name: "Robin" }])],
        assistants: [exampleAssistantInfo],
        ui: { ...initialState.ui, settingsOpen: true, settingsPath: ["devices", page === "device" ? device.id : typePageId(exampleDeviceType.kind)] }
      },
      reducer
    )
    const saveDevice = vi.fn<(...args: ReadonlyArray<unknown>) => Promise<Outcome>>(async () => ({ kind: "ok", rev: device.rev + 1 }))
    const client = { store, saveDevice, settings: vi.fn(), wakeTest: vi.fn(async () => ({ type: "result", requestId: "r", ok: true })) } as unknown as AssistantClient
    render(<ClientContext.Provider value={client}><DevicePage /></ClientContext.Provider>)
    return { saveDevice, store }
  }

  it("shows what it declared (Detected, when), picks the room, privacy and default person, takes the screen away; saved as two own sections", async () => {
    const t = setup("device")
    const caps = screen.getByTestId("section-capabilities")
    expect(within(caps).getByTestId("detected-chip")).toHaveTextContent("Detected")
    expect(within(caps).getByTestId("caps-seen")).toHaveTextContent("Last seen, declared 5 min ago")
    expect(within(caps).getByTestId("caps-row-display")).toHaveTextContent("Tablet-size screen, 1024 × 768 at ×2, touch")
    expect(within(caps).getByTestId("caps-row-microphone")).toHaveTextContent("None")
    expect(within(caps).getByTestId("caps-effective")).toHaveTextContent("The assistant is told: tablet-size screen, touch, speaker (speech).")
    const place = screen.getByTestId("section-place")
    expect(within(place).getByTestId("marks-Place")).toHaveAttribute("data-own", "false")
    // Next to privacy and the default person: saving a change of either ends the device's session.
    const notes = within(place).getAllByTestId("place-boundary-note")
    expect(notes).toHaveLength(2)
    for (const note of notes) expect(note).toHaveTextContent("Saving a change here ends the session on this device: its pages reconnect at once")
    // And next to the speaker, the screen and the kinds; not next to the room or the other place switches (two in Place).
    expect(within(caps).getAllByTestId("caps-boundary-note")).toHaveLength(3)
    const person = within(place).getByTestId("place-person") as HTMLSelectElement
    expect([...person.options].map((o) => o.textContent)).toEqual(["Nobody: household data", "Sam", "Robin"])
    fireEvent.change(within(place).getByTestId("place-room"), { target: { value: "Kitchen" } })
    fireEvent.change(person, { target: { value: "p-sam00001" } })
    fireEvent.click(within(place).getByRole("radio", { name: "Private" }))
    fireEvent.click(within(within(caps).getByTestId("caps-display")).getByRole("switch"))
    expect(within(caps).getByTestId("caps-effective")).toHaveTextContent("The assistant is told: voice only (speech), no screen, no microphone")
    // The kinds it renders are switches too (only when it declared some).
    expect(within(caps).getByTestId("caps-kinds")).toHaveTextContent("card")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    expect(t.saveDevice).toHaveBeenCalledTimes(1)
    const patch = t.saveDevice.mock.calls[0]![2] as Record<string, unknown>
    expect(patch).toEqual({
      place: { room: "Kitchen", privacy: "private", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: "p-sam00001" },
      capabilities: { noDisplay: true, excludeKinds: [], noSpeaker: false }
    })
  })

  it("a device that never declared says so; the type's defaults have the place and the switches but nothing detected", () => {
    const { declared: _never, ...undeclared } = exampleDevice
    setup("device", undeclared)
    expect(screen.getByTestId("caps-undeclared")).toHaveTextContent("Not declared yet")
  })

  it("a default person who left Members is shown as removed, with what to do", () => {
    setup("device", { ...declared, own: { place: { room: "", privacy: "shared", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: "p-gone0001" } }, settings: { ...declared.settings, place: { room: "", privacy: "shared", alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: "p-gone0001" } } })
    const place = screen.getByTestId("section-place")
    expect(within(place).getByTestId("field-error")).toHaveTextContent("no longer in Members")
    expect(within(place).getByTestId("marks-Place")).toHaveAttribute("data-own", "true")
  })

  it("on a type's defaults page", () => {
    setup("type")
    expect(screen.queryByTestId("caps-declared")).toBeNull()
    expect(screen.queryByTestId("caps-undeclared")).toBeNull()
    expect(screen.getByTestId("section-place")).toBeInTheDocument()
    expect(screen.getByTestId("caps-display")).toBeInTheDocument()
    expect(within(screen.getByTestId("section-place")).getAllByTestId("place-boundary-note")[0]).toHaveTextContent("every device that follows these defaults")
  })

  it("a type's defaults can exclude a kind its devices declared, without a representative device: save, put back, Cancel (round 2)", async () => {
    // The type's page: the kinds come from every device of the type (here one that declared a card).
    const t = setup("type")
    const caps = screen.getByTestId("section-capabilities")
    const kinds = within(caps).getByTestId("caps-kinds")
    expect(kinds).toHaveTextContent("card")
    const show = within(kinds).getByRole("switch", { name: "Show card" })
    expect(show).toHaveAttribute("aria-checked", "true")
    fireEvent.click(show)
    expect(within(kinds).getByRole("switch", { name: "Show card" })).toHaveAttribute("aria-checked", "false")
    // Put back and excluded again: the switch stays (an excluded kind is always offered).
    fireEvent.click(within(kinds).getByRole("switch", { name: "Show card" }))
    fireEvent.click(within(kinds).getByRole("switch", { name: "Show card" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    expect(t.saveDevice).toHaveBeenCalledTimes(1)
    expect((t.saveDevice.mock.calls[0]![2] as Record<string, unknown>).capabilities).toEqual({ noDisplay: false, excludeKinds: ["card"], noSpeaker: false })
  })

  // Review round 3 (p5-r3b findings 2 and 3): a field shown invalid blocks Save.
  const saveButton = () => screen.getByRole("button", { name: "Save" })

  it("a default person removed in another tab while the draft names them: the error at the field, and Save blocked until another is picked", () => {
    const t = setup("device")
    const place = screen.getByTestId("section-place")
    fireEvent.change(within(place).getByTestId("place-person"), { target: { value: "p-sam00001" } })
    fireEvent.change(within(place).getByTestId("place-room"), { target: { value: "Den" } })
    expect(saveButton()).toBeEnabled()
    // Another admin page removes Sam: the Members section changes under the draft.
    act(() => t.store.dispatch({ type: "section.changed", section: members([{ id: "p-robin001", name: "Robin" }]) }))
    expect(within(place).getByTestId("field-error")).toHaveTextContent("That person is no longer in Members")
    expect(within(place).getByTestId("place-person")).toHaveAttribute("aria-invalid", "true")
    expect(saveButton()).toBeDisabled()
    fireEvent.change(within(place).getByTestId("place-person"), { target: { value: "" } })
    expect(within(place).queryByTestId("field-error")).toBeNull()
    expect(saveButton()).toBeEnabled()
  })

  it("a room the wire refuses (a direction or control character) is shown at the field and blocks Save", () => {
    setup("device")
    const place = screen.getByTestId("section-place")
    for (const bad of ["Kitchen\u202Edesk", "Kitchen\u0007"]) {
      fireEvent.change(within(place).getByTestId("place-room"), { target: { value: bad } })
      expect(within(place).getByTestId("field-error")).toHaveTextContent("A room is one line of text")
      expect(saveButton()).toBeDisabled()
    }
    fireEvent.change(within(place).getByTestId("place-room"), { target: { value: "Kitchen desk" } })
    expect(within(place).queryByTestId("field-error")).toBeNull()
    expect(saveButton()).toBeEnabled()
  })

  it("64 kinds switched off and a newly declared one: switching it off too shows the limit and blocks Save; nothing stored is dropped", () => {
    const stored = Array.from({ length: 64 }, (_, i) => `k${String(i).padStart(2, "0")}`)
    const caps = { noDisplay: false, excludeKinds: stored, noSpeaker: false }
    const kinds = Object.fromEntries([...stored, "fresh"].map((k) => [k, 1]))
    const device: DeviceListInfo = {
      ...declared,
      own: { ...declared.own, capabilities: caps },
      settings: { ...declared.settings, capabilities: caps },
      declared: { capabilities: { ...declared.declared!.capabilities, present: { kinds } }, seenAt: Date.now() }
    }
    setup("device", device)
    const section = screen.getByTestId("section-capabilities")
    expect(section).toHaveTextContent("At most 64 kinds can be switched off (64 now).")
    fireEvent.change(within(screen.getByTestId("section-place")).getByTestId("place-room"), { target: { value: "Den" } })
    expect(saveButton()).toBeEnabled()
    fireEvent.click(within(section).getByRole("switch", { name: "Show fresh" }))
    expect(within(section).getByTestId("field-error")).toHaveTextContent("At most 64 kinds can be switched off: switch one back on to save.")
    expect(saveButton()).toBeDisabled()
    // What is stored stays switched off and offered.
    for (const k of stored) expect(within(section).getByRole("switch", { name: `Show ${k}` })).toHaveAttribute("aria-checked", "false")
    fireEvent.click(within(section).getByRole("switch", { name: "Show k07" }))
    expect(within(section).queryByTestId("field-error")).toBeNull()
    expect(saveButton()).toBeEnabled()
  })

  it("with no device that declared a kind: the kinds the protocol knows (P10's five) are offered", () => {
    const { declared: _never, ...undeclared } = exampleDevice
    setup("type", undeclared)
    expect(screen.queryByTestId("caps-kinds-none")).toBeNull()
    const section = screen.getByTestId("section-capabilities")
    for (const k of ["card", "image", "list", "timer", "weather"]) expect(within(section).getByRole("switch", { name: `Show ${k}` })).toHaveAttribute("aria-checked", "true")
    expect(kindsFor({ known: [], declared: [], excluded: [] })).toEqual([])
    expect(kindsFor({ known: ["list"], declared: [{ declared: { capabilities: { v: 1, present: { kinds: { card: 1 } } } } }], excluded: ["timer"] })).toEqual(["card", "list", "timer"])
  })
})
