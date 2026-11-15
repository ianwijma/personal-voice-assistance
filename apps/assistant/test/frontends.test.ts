// Front-end kinds, devices and profiles on the server (`serve/frontends.ts`) on a real settings store, through the
// store's legacy view of version 4 (docs/FRONTENDS-AND-ACTIVATION.md §2, docs/ASSISTANTS.md §6).
import { DEFAULT_DEVICE_PROFILE, MAX_DEVICES, WEB_VOICE_KIND } from "@pva/protocol"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FRONTEND_KINDS, makeFrontends } from "../src/serve/frontends.ts"
import type { DeviceRecord } from "../src/serve/SettingsStore.ts"
import { openStore } from "./support/store.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmp = () => mkdtempSync(join(tmpdir(), "pva-frontends-"))
const hello = (id: string) => ({ id, kind: WEB_VOICE_KIND, name: `Device ${id}` })

describe("settings store: front-end data of older files", () => {
  it("a version-2 file is migrated to version 4 at load (original kept); kind defaults save into the browser defaults; bad entries are dropped", async () => {
    const dir = tmp()
    const v2 = JSON.stringify({ version: 2, revision: 5, modules: {}, assistant: { A: 1 } })
    writeFileSync(join(dir, "settings.json"), v2)
    const store = await run(openStore(dir))
    expect(store.settings()).toMatchObject({ version: 4, devices: {}, assistant: { A: 1 }, revision: 5 })
    expect(store.frontendData()).toEqual({ frontends: {}, devices: {} })
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).version).toBe(4) // written at load, same revision
    expect(readFileSync(join(dir, "settings.json.v3-backup"), "utf8")).toBe(v2)
    await run(store.saveFrontends("kind defaults", (d) => ({ ...d, frontends: { [WEB_VOICE_KIND]: { captions: false } } })))
    const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))
    expect(saved).toMatchObject({ version: 4, assistant: { A: 1 }, deviceTypes: { [WEB_VOICE_KIND]: { captions: { captions: false }, rev: 1 } }, devices: {} })
    expect(store.frontendData().frontends).toEqual({ [WEB_VOICE_KIND]: { captions: false } })
    expect(saved.revision).toBeGreaterThan(5)

    const good: DeviceRecord = { kind: WEB_VOICE_KIND, name: "Phone", firstSeen: 1, lastSeen: 2, overrides: { voice: "x" } }
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      version: 3,
      modules: {},
      assistant: {},
      frontends: { [WEB_VOICE_KIND]: { prebufferMs: 9_999 }, "Bad Kind": {} },
      devices: { "phone-0001": good, short: good, "tablet-0001": { ...good, name: "" } }
    }))
    const reloaded = await run(openStore(dir))
    expect(reloaded.frontendData().frontends).toEqual({})
    // A device's own voice is retired (docs/ASSISTANTS.md §6): dropped, with a note.
    expect(reloaded.frontendData().devices).toEqual({ "phone-0001": { ...good, overrides: {} } })
    expect(reloaded.problems).toHaveLength(5)
    expect(reloaded.problems.at(-1)).toContain("own voice was dropped")
  })
})

describe("frontends: profiles and devices", () => {
  it("effective profile = built-in ← kind ← device; a voice that is not enabled falls back to \"\"", async () => {
    const store = await run(openStore(tmp()))
    let voices = new Set(["standard", "bright"])
    const f = makeFrontends({ store, enabledVoices: () => voices })
    expect(f.profile(undefined)).toEqual(DEFAULT_DEVICE_PROFILE)
    expect((await run(f.updateKind(WEB_VOICE_KIND, { captions: false, interruptMode: "manual" }))).ok).toBe(true)
    await run(f.seen(hello("phone-0001"), new Set()))
    expect((await run(f.updateOwn(hello("phone-0001"), { voice: "bright" }, new Set()))).ok).toBe(true)
    expect((await run(f.updateDevice("phone-0001", undefined, { interruptMode: "instant" }))).ok).toBe(true)
    // A device's own voice is retired (the assistant's voice speaks): accepted, not kept.
    expect(f.profile("phone-0001")).toEqual({ ...DEFAULT_DEVICE_PROFILE, captions: false, interruptMode: "instant", voice: "" })
    voices = new Set(["standard"])
    expect(f.profile("phone-0001").voice).toBe("")
    expect(f.kinds()).toEqual([{
      id: WEB_VOICE_KIND,
      title: FRONTEND_KINDS[0]!.title,
      description: FRONTEND_KINDS[0]!.description,
      fields: [...FRONTEND_KINDS[0]!.fields],
      defaults: { captions: false, interruptMode: "manual" },
      profile: { ...DEFAULT_DEVICE_PROFILE, captions: false, interruptMode: "manual" }
    }])
    // Clearing the last kind default removes the kind's entry.
    expect((await run(f.updateKind(WEB_VOICE_KIND, { captions: null, interruptMode: null }))).ok).toBe(true)
    expect(store.frontendData().frontends).toEqual({})
  })

  it("a device's first hello is saved with its name; later hellos within 10 minutes write nothing", async () => {
    let now = 1_000_000
    const store = await run(openStore(tmp()))
    const f = makeFrontends({ store, enabledVoices: () => new Set(), now: () => now })
    await run(f.seen(hello("phone-0001"), new Set()))
    const first = store.revision()
    expect(store.frontendData().devices["phone-0001"]).toEqual({ kind: WEB_VOICE_KIND, name: "Device phone-0001", firstSeen: now, lastSeen: now, overrides: {} })
    now += 60_000
    await run(f.seen({ ...hello("phone-0001"), name: "Renamed by the browser" }, new Set()))
    expect(store.revision()).toBe(first)
    expect(f.devices(() => ({ connections: 0, audioOwner: false }))[0]).toMatchObject({ name: "Device phone-0001", lastSeen: now })
    now += 11 * 60_000
    await run(f.seen(hello("phone-0001"), new Set()))
    expect(store.revision()).not.toBe(first)
    expect(store.frontendData().devices["phone-0001"]?.lastSeen).toBe(now)
  })

  it(`at most ${MAX_DEVICES} devices: the least recently seen without overrides goes first, connected ones never`, async () => {
    const dir = tmp()
    const devices: Record<string, DeviceRecord> = {}
    for (let i = 0; i < MAX_DEVICES; i++) {
      const id = `device-${String(i).padStart(4, "0")}`
      devices[id] = { kind: WEB_VOICE_KIND, name: id, firstSeen: i, lastSeen: 1_000 + i, overrides: i < 3 ? { captions: false } : {} }
    }
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 3, modules: {}, assistant: {}, frontends: {}, devices }))
    const store = await run(openStore(dir))
    const f = makeFrontends({ store, enabledVoices: () => new Set(), now: () => 5_000 })
    // device-0003 is the oldest without overrides but connected: device-0004 goes.
    await run(f.seen(hello("newcomer-01"), new Set(["device-0003"])))
    const ids = Object.keys(store.frontendData().devices)
    expect(ids).toHaveLength(MAX_DEVICES)
    expect(ids).toContain("newcomer-01")
    expect(ids).toContain("device-0003")
    expect(ids).not.toContain("device-0004")
    expect(ids).toEqual(expect.arrayContaining(["device-0000", "device-0001", "device-0002"]))
  })

  it("device.update from the device: editable fields only (admin_required otherwise), creating its record if needed", async () => {
    const store = await run(openStore(tmp()))
    const f = makeFrontends({ store, enabledVoices: () => new Set(["standard"]) })
    expect(await run(f.updateOwn(hello("fresh-0001"), { captions: false, voice: "standard" }, new Set()))).toMatchObject({ ok: false, error: { code: "admin_required" } })
    expect(store.frontendData().devices).toEqual({})
    expect((await run(f.updateOwn(hello("fresh-0001"), { activation: "wake-phrase" }, new Set()))).ok).toBe(true)
    expect(store.frontendData().devices["fresh-0001"]).toMatchObject({ name: "Device fresh-0001", overrides: { activation: "wake-phrase" } })
    expect((await run(f.forget("fresh-0001"))).ok).toBe(true)
    expect(f.known("fresh-0001")).toBe(false)
  })
})
