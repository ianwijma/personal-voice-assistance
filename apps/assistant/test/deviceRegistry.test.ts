// The device registry (`serve/devices.ts`: devices seen, their last visits, forgotten) and the settings store's load of
// older files, on a real settings store (docs/FRONTENDS-AND-ACTIVATION.md §2, docs/ASSISTANTS.md §2.5, §6).
import { BUILT_IN_WEB_VOICE_SETTINGS, MAX_DEVICES, WEB_VOICE_KIND } from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeDeviceRegistry } from "../src/serve/devices.ts"
import { openStore } from "./support/store.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmp = () => mkdtempSync(join(tmpdir(), "pva-frontends-"))
const hello = (id: string) => ({ id, kind: WEB_VOICE_KIND, name: `Device ${id}` })

describe("settings store: older files", () => {
  it("a version-2 file is migrated to version 4 at load (original kept); a device type saves into the browser defaults; bad entries are dropped", async () => {
    const dir = tmp()
    const v2 = JSON.stringify({ version: 2, revision: 5, modules: {}, assistant: { A: 1 } })
    writeFileSync(join(dir, "settings.json"), v2)
    const store = await run(openStore(dir))
    expect(store.settings()).toMatchObject({ version: 4, devices: {}, assistant: { A: 1 }, revision: 5 })
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).version).toBe(4) // written at load, same revision
    expect(readFileSync(join(dir, "settings.json.v3-backup"), "utf8")).toBe(v2)
    await run(store.saveDeviceType(WEB_VOICE_KIND, 0, { ...BUILT_IN_WEB_VOICE_SETTINGS, captions: { ...BUILT_IN_WEB_VOICE_SETTINGS.captions, captions: false } }))
    const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))
    expect(saved).toMatchObject({ version: 4, assistant: { A: 1 }, deviceTypes: { [WEB_VOICE_KIND]: { captions: { captions: false }, rev: 1 } }, devices: {} })
    expect(saved.revision).toBeGreaterThan(5)

    const good = { kind: WEB_VOICE_KIND, name: "Phone", firstSeen: 1, lastSeen: 2, overrides: { voice: "x" } }
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      version: 3,
      modules: {},
      assistant: {},
      frontends: { [WEB_VOICE_KIND]: { prebufferMs: 9_999 }, "Bad Kind": {} },
      devices: { "phone-0001": good, short: good, "tablet-0001": { ...good, name: "" } }
    }))
    const reloaded = await run(openStore(dir))
    // The kind defaults did not decode (a prebuffer out of bounds) and are dropped: the type keeps its built-in defaults.
    expect(reloaded.settings().deviceTypes[WEB_VOICE_KIND]?.audio.prebufferMs).toBe(BUILT_IN_WEB_VOICE_SETTINGS.audio.prebufferMs)
    // A device's own voice is retired (docs/ASSISTANTS.md §6): dropped, with a note.
    expect(reloaded.settings().devices).toEqual({ "phone-0001": { kind: WEB_VOICE_KIND, name: "Phone", firstSeen: 1, lastSeen: 2, own: {}, rev: 0 } })
    expect(reloaded.problems).toHaveLength(5)
    expect(reloaded.problems.at(-1)).toContain("own voice was dropped")
  })
})

describe("device registry", () => {
  it("a device's first hello is saved with its name; later hellos within 10 minutes write nothing", async () => {
    let now = 1_000_000
    const store = await run(openStore(tmp()))
    const f = makeDeviceRegistry({ store, now: () => now })
    await run(f.seen(hello("phone-0001"), new Set()))
    const first = store.revision()
    expect(store.settings().devices["phone-0001"]).toEqual({ kind: WEB_VOICE_KIND, name: "Device phone-0001", firstSeen: now, lastSeen: now, own: {}, rev: 0 })
    now += 60_000
    await run(f.seen({ ...hello("phone-0001"), name: "Renamed by the browser" }, new Set()))
    expect(store.revision()).toBe(first)
    expect(f.devices(() => ({ connections: 0, audioOwner: false }))[0]).toMatchObject({ name: "Device phone-0001", lastSeen: now })
    now += 11 * 60_000
    await run(f.seen(hello("phone-0001"), new Set()))
    expect(store.revision()).not.toBe(first)
    expect(store.settings().devices["phone-0001"]?.lastSeen).toBe(now)
  })

  it(`at most ${MAX_DEVICES} devices: the least recently seen without own settings goes first, connected ones never`, async () => {
    const dir = tmp()
    const devices: Record<string, unknown> = {}
    for (let i = 0; i < MAX_DEVICES; i++) {
      const id = `device-${String(i).padStart(4, "0")}`
      devices[id] = { kind: WEB_VOICE_KIND, name: id, firstSeen: i, lastSeen: 1_000 + i, overrides: i < 3 ? { captions: false } : {} }
    }
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 3, modules: {}, assistant: {}, frontends: {}, devices }))
    const store = await run(openStore(dir))
    const f = makeDeviceRegistry({ store, now: () => 5_000 })
    // device-0003 is the oldest without own settings but connected: device-0004 goes.
    await run(f.seen(hello("newcomer-01"), new Set(["device-0003"])))
    const ids = Object.keys(store.settings().devices)
    expect(ids).toHaveLength(MAX_DEVICES)
    expect(ids).toContain("newcomer-01")
    expect(ids).toContain("device-0003")
    expect(ids).not.toContain("device-0004")
    expect(ids).toEqual(expect.arrayContaining(["device-0000", "device-0001", "device-0002"]))
  })

  it("forget removes the record; an unknown device is unknown_device", async () => {
    const store = await run(openStore(tmp()))
    const f = makeDeviceRegistry({ store })
    await run(f.seen(hello("fresh-0001"), new Set()))
    expect(f.known("fresh-0001")).toBe(true)
    expect(f.nameOf("fresh-0001")).toBe("Device fresh-0001")
    expect(f.kindOfDevice("fresh-0001")).toBe(WEB_VOICE_KIND)
    expect((await run(f.forget("fresh-0001"))).ok).toBe(true)
    expect(f.known("fresh-0001")).toBe(false)
    expect(await run(f.forget("fresh-0001"))).toMatchObject({ ok: false, error: { code: "unknown_device" } })
  })
})
