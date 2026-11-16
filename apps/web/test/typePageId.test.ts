import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { DeviceId } from "@pva/protocol"
import { exampleDevice } from "@pva/protocol/examples"
import { buildSettingsTree, isTypePageId, resolveSettingsPath, typePageId } from "@/lib/settingsTree.ts"

// PR #35 review 6, sweep of finding 1's class (a sentinel in the same namespace as real ids): a device type's defaults
// page sits next to the device pages under Devices, so its id must never be a device id.
describe("a device type's defaults page id", () => {
  const pages = [
    { group: "devices", id: "all", title: "All devices", order: 0 },
    { group: "devices", id: "device-type", title: "Device type", order: 10, perItem: true },
    { group: "devices", id: "device", title: "Device", order: 100, perItem: true }
  ]

  it("is never a device id, and only it counts as a type page", () => {
    expect(Schema.is(DeviceId)(typePageId("web-voice"))).toBe(false)
    expect(isTypePageId(typePageId("web-voice"))).toBe(true)
    expect(isTypePageId(exampleDevice.id)).toBe(false)
    expect(isTypePageId(undefined)).toBe(false)
  })

  it("a device whose id looks like the old one (type-web-voice) keeps its own page, apart from the type's", () => {
    const lookalike = { ...exampleDevice, id: "type-web-voice", name: "Look-alike" }
    expect(Schema.is(DeviceId)(lookalike.id)).toBe(true)
    expect(isTypePageId(lookalike.id)).toBe(false)
    const tree = buildSettingsTree({ sections: [], modules: [], clientPages: pages, deviceTypes: [{ kind: "web-voice", title: "Browsers" }], devices: [lookalike] })
    const ids = tree.find((g) => g.slug === "devices")!.pages.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(resolveSettingsPath(tree, ["devices", lookalike.id], true).page?.source).toEqual({ kind: "client", id: "device" })
    expect(resolveSettingsPath(tree, ["devices", typePageId("web-voice")], true).page?.source).toEqual({ kind: "client", id: "device-type" })
  })
})
