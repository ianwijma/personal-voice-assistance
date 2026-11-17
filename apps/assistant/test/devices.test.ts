// The protocol 7 view of device types and devices (`serve/devices.ts`): pure functions of the settings file.
import { BUILT_IN_WEB_VOICE_SETTINGS, DEVICE_TYPES, type DeviceInfo, type DeviceOwn, WEB_VOICE_KIND } from "@pva/protocol"
import { exampleDevice } from "@pva/protocol/examples"
import { describe, expect, it } from "vitest"
import { deviceListInfos, deviceSettingsFrom, deviceTypeInfos, typeSettingsFrom } from "../src/serve/devices.ts"
import type { SettingsFile } from "../src/serve/SettingsStore.ts"

const builtIn = BUILT_IN_WEB_VOICE_SETTINGS

/** Only the two maps these functions read; the rest of a settings file is irrelevant to them. */
const fileWith = (
  deviceTypes: Record<string, DeviceOwn & { rev: number }> = {},
  devices: Record<string, { kind: string; name: string; firstSeen: number; lastSeen: number; own: DeviceOwn; rev: number }> = {}
): SettingsFile => ({ deviceTypes, devices }) as unknown as SettingsFile

const device = (own: DeviceOwn, rev = 0, kind: string = WEB_VOICE_KIND) => ({ kind, name: "Kitchen", firstSeen: 1, lastSeen: 2, own, rev })

describe("typeSettingsFrom", () => {
  it("a type that was never saved is the built-in defaults", () => {
    expect(typeSettingsFrom(fileWith(), WEB_VOICE_KIND)).toEqual(builtIn)
  })
  it("saved sections win over the built-in, each as a whole", () => {
    const file = fileWith({ [WEB_VOICE_KIND]: { rev: 3, interruptMode: "instant", captions: { captions: false, speakTyped: true } } })
    const settings = typeSettingsFrom(file, WEB_VOICE_KIND)
    expect(settings.interruptMode).toBe("instant")
    expect(settings.captions).toEqual({ captions: false, speakTyped: true })
    expect(settings.audio).toEqual(builtIn.audio)
  })
  it("never leaks the stored rev into the settings", () => {
    expect(typeSettingsFrom(fileWith({ [WEB_VOICE_KIND]: { rev: 3 } }), WEB_VOICE_KIND)).not.toHaveProperty("rev")
  })
  it("an unknown kind is read as the browser type, from its own (absent) entry", () => {
    const file = fileWith({ [WEB_VOICE_KIND]: { rev: 1, interruptMode: "instant" } })
    expect(typeSettingsFrom(file, "kiosk")).toEqual(builtIn)
  })
})

describe("deviceSettingsFrom", () => {
  const file = fileWith(
    { [WEB_VOICE_KIND]: { rev: 1, interruptMode: "manual", assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }] } },
    { d1: device({ interruptMode: "instant" }), d2: device({}) }
  )

  it("its own section wins over the type's, the type's over the built-in", () => {
    const settings = deviceSettingsFrom(file, "d1")
    expect(settings.interruptMode).toBe("instant")
    expect(settings.assistants).toEqual([{ assistant: "jeff", phrases: ["hey jeff"] }])
    expect(settings.matching).toBe(builtIn.matching)
  })
  it("a device with nothing of its own follows the type", () => {
    expect(deviceSettingsFrom(file, "d2").interruptMode).toBe("manual")
  })
  it("no device, or a device that was never remembered, gets the type defaults (the browser's when the kind is not given)", () => {
    expect(deviceSettingsFrom(file, undefined).interruptMode).toBe("manual")
    expect(deviceSettingsFrom(file, "never-seen").interruptMode).toBe("manual")
    expect(deviceSettingsFrom(fileWith(), undefined)).toEqual(builtIn)
  })
  it("a record's own kind decides which type defaults apply, not the kind passed in", () => {
    const kinds = fileWith({ [WEB_VOICE_KIND]: { rev: 1, interruptMode: "manual" } }, { d1: device({}) })
    expect(deviceSettingsFrom(kinds, "d1", "kiosk").interruptMode).toBe("manual")
    // no record: the passed kind is used, and a type without an entry of its own is the built-in
    expect(deviceSettingsFrom(kinds, "unseen", "kiosk").interruptMode).toBe(builtIn.interruptMode)
  })
})

describe("deviceTypeInfos", () => {
  it("lists every registered type with its texts, sections, complete defaults and rev", () => {
    const infos = deviceTypeInfos(fileWith({ [WEB_VOICE_KIND]: { rev: 4, interruptMode: "instant" } }))
    expect(infos.map((t) => t.kind)).toEqual(DEVICE_TYPES.map((t) => t.kind))
    const web = infos.find((t) => t.kind === WEB_VOICE_KIND)!
    expect(web).toMatchObject({ title: "Browsers", one: "browser", many: "browsers", rev: 4 })
    expect(web.keys).toEqual([...DEVICE_TYPES[0]!.keys])
    expect(web.settings.interruptMode).toBe("instant")
    expect(web.settings.audio).toEqual(builtIn.audio)
  })
  it("a type never saved is rev 0, with the built-in defaults", () => {
    const [web] = deviceTypeInfos(fileWith())
    expect(web).toMatchObject({ rev: 0, settings: builtIn })
  })
  it("hands out its own copy of the keys (a caller cannot change the registry)", () => {
    const [web] = deviceTypeInfos(fileWith())
    ;(web!.keys as Array<string>).pop()
    expect(deviceTypeInfos(fileWith())[0]!.keys).toEqual([...DEVICE_TYPES[0]!.keys])
  })
})

describe("deviceListInfos", () => {
  const base = (id: string): DeviceInfo => {
    const { own: _o, settings: _s, hearer: _h, rev: _r, ...protocol5 } = exampleDevice
    return { ...protocol5, id }
  }
  const file = fileWith(
    { [WEB_VOICE_KIND]: { rev: 1, assistants: [{ assistant: "jeff", phrases: ["hey jeff"] }, { assistant: "t3", phrases: ["hey t3"] }] } },
    {
      own: device({ withoutPhrase: { mode: "assistant", assistant: "t3" } }, 5),
      plain: device({}, 2)
    }
  )

  it("keeps every protocol 5 field and adds own, effective settings, hearer and rev", () => {
    const [entry] = deviceListInfos(file, [base("own")])
    expect(entry).toMatchObject({ ...base("own"), own: { withoutPhrase: { mode: "assistant", assistant: "t3" } }, rev: 5, hearer: "t3" })
    expect(entry!.settings.withoutPhrase).toEqual({ mode: "assistant", assistant: "t3" })
    expect(entry!.settings.assistants.map((a) => a.assistant)).toEqual(["jeff", "t3"])
  })
  it("without its own pick the hearer is the first assigned assistant", () => {
    const [entry] = deviceListInfos(file, [base("plain")])
    expect(entry).toMatchObject({ own: {}, rev: 2, hearer: "jeff" })
  })
  it("a device that is not in the file (not saved yet) is rev 0 with nothing of its own", () => {
    const [entry] = deviceListInfos(file, [base("fresh")])
    expect(entry).toMatchObject({ own: {}, rev: 0, hearer: "jeff" })
  })
  it("no assistant on the type: hearer is null", () => {
    const [entry] = deviceListInfos(fileWith(), [base("fresh")])
    expect(entry).toMatchObject({ hearer: null, settings: builtIn })
  })
  it("keeps the order of the list it is given, and an empty list stays empty", () => {
    expect(deviceListInfos(file, [base("plain"), base("own"), base("fresh")]).map((d) => d.id)).toEqual(["plain", "own", "fresh"])
    expect(deviceListInfos(file, [])).toEqual([])
  })
})
