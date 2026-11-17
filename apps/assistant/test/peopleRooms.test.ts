// P5 on the server's own parts (docs/MODULES-PLAN.md §4): Members ids and the People service over the settings,
// loading files from before protocol 11, a removed person cleared from devices, what a device declared (kept, written
// only when it matters), and the device facts: places, targets, the turn's room and person, and the context line
// inside its budget, measured with TurnTrace.
import {
  Conversation,
  type ConversationEvent,
  CurrentTurn,
  makeToolRegistry,
  type Trace,
  TurnTrace,
  withContextProvider
} from "@pva/core"
import { endOfTurn, makeMarkerTts, makeRecordingAudioOutput, makeScriptedLlm, speechStarted, textDelta } from "@pva/core/testing"
import { BUILT_IN_PLACE, BUILT_IN_WEB_VOICE_SETTINGS, type DeviceCapabilities, type SettingsPatch, type SettingValue, WEB_VOICE_KIND } from "@pva/protocol"
import { Effect, Layer, Queue, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { makeDeviceFacts } from "../src/serve/deviceFacts.ts"
import { makeDeviceRegistry } from "../src/serve/devices.ts"
import { DIET_KEYS, makePeopleService, MEMBERS_KEY, peopleFrom, withPersonIds } from "../src/serve/people.ts"
import { readStoredSettings, type SettingsFile } from "../src/serve/SettingsStore.ts"
import { openStore } from "./support/store.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const tmp = () => mkdtempSync(join(tmpdir(), "pva-people-unit-"))
type Json = Record<string, any>

const tablet: DeviceCapabilities = {
  v: 1,
  display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true },
  present: { kinds: {} },
  speaker: { media: ["speech"] },
  microphone: { farField: false }
}

describe("Members: ids and the People service", () => {
  it("a new person gets an id, a valid one is kept, a copied one is replaced; other keys are left alone", () => {
    let n = 0
    const random = () => ((n++ * 7) % 36) / 36
    const out = withPersonIds({ [MEMBERS_KEY]: [{ name: "Sam" }, { id: "p-robin001", name: "Robin" }, { id: "p-robin001", name: "Copy" }, { id: "Bad Id", name: "Jo" }] as never, OTHER: 1 }, random)
    const list = out[MEMBERS_KEY] as unknown as ReadonlyArray<Json>
    expect(list[1]!.id).toBe("p-robin001")
    expect(new Set(list.map((m) => m.id)).size).toBe(4)
    for (const m of list) expect(m.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/)
    expect(out.OTHER).toBe(1)
    const same = { [MEMBERS_KEY]: [{ id: "p-a0000001", name: "A" }] as never }
    expect(withPersonIds(same)).toBe(same)
    expect(peopleFrom([{ id: "p-a0000001", name: " A ", aliases: ["Ay", 3] }, { name: "no id" }, { id: "p-b0000001", name: "" }, "junk"])).toEqual([
      { id: "p-a0000001", name: "A", aliases: ["Ay"], pronunciation: "", diet: { allergies: [], diets: [], dislikes: [] } }
    ])
  })

  it("list, get, find, diets, and a diet written through the settings like an admin edit", async () => {
    let values: Record<string, unknown> = {
      [MEMBERS_KEY]: [{ id: "p-sam00001", name: "Sam", aliases: ["Sammie"], pronunciation: "", allergies: ["nuts"], diets: [], dislikes: [] }],
      [DIET_KEYS.allergies]: ["shellfish"],
      [DIET_KEYS.diets]: ["vegetarian"],
      [DIET_KEYS.dislikes]: []
    }
    const patches: Array<SettingsPatch> = []
    const people = makePeopleService({
      value: (k) => values[k],
      update: (patch) =>
        Effect.sync(() => {
          patches.push(patch)
          values = { ...values, ...patch.values }
          return { ok: true as const }
        })
    })
    expect(people.list().map((p) => p.name)).toEqual(["Sam"])
    expect(people.get("p-sam00001")?.aliases).toEqual(["Sammie"])
    expect(people.find("sammie")).toMatchObject({ kind: "found", person: { id: "p-sam00001" } })
    expect(people.dietOf("p-sam00001")).toEqual({ allergies: ["nuts"], diets: ["vegetarian"], dislikes: [] })
    expect(people.dietOf(undefined)).toEqual({ allergies: ["shellfish"], diets: ["vegetarian"], dislikes: [] })
    // The list is read once per saved value: the same objects while nothing is saved.
    expect(people.list()).toBe(people.list())

    await run(people.setDiet({ person: "p-sam00001" }, { dislikes: ["olives", "Olives", " "] }))
    expect(patches.at(-1)!.values[MEMBERS_KEY]).toEqual([{ id: "p-sam00001", name: "Sam", aliases: ["Sammie"], pronunciation: "", allergies: ["nuts"], diets: [], dislikes: ["olives"] }])
    expect(people.dietOf("p-sam00001").dislikes).toEqual(["olives"])
    await run(people.setDiet("household", { allergies: ["sesame"] }))
    expect(patches.at(-1)!.values).toEqual({ [DIET_KEYS.allergies]: ["sesame"] })
    const missing = await run(Effect.flip(people.setDiet({ person: "p-nobody00" }, { allergies: ["x"] })))
    expect(missing).toMatchObject({ code: "unknown_person" })
    const refusing = makePeopleService({ value: (k) => values[k], update: () => Effect.succeed({ ok: false as const, message: "nope" }) })
    expect(await run(Effect.flip(refusing.setDiet("household", { diets: ["vegan"] })))).toMatchObject({ code: "not_saved", message: "nope" })
  })
})

describe("settings saved before protocol 11", () => {
  const OLD_TYPE = {
    assistants: [],
    withoutPhrase: { mode: "nobody" },
    matching: "close",
    voicePage: { pick: false },
    interruptMode: "manual",
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, speakAloud: true, outputPath: "direct", prebufferMs: 60 },
    captions: { captions: false, speakTyped: true },
    look: { from: "assistant" },
    voice: { from: "assistant" },
    rev: 3
  }
  const v4 = (deviceTypes: Json, devices: Json = {}) => ({ version: 4, modules: {}, assistant: {}, assistants: { order: [], byId: {} }, deviceTypes, devices })

  it("a type entry without place and capabilities loads whole and takes the built-in sections", () => {
    const read = readStoredSettings(v4({ "web-voice": OLD_TYPE }, { "dev-old-01": { kind: "web-voice", name: "Old", firstSeen: 1, lastSeen: 2, own: { interruptMode: "instant" }, rev: 1 } }))
    expect(read?.problems).toEqual([])
    const file = (read!.file as { file: SettingsFile }).file
    expect(file.deviceTypes["web-voice"]).toMatchObject({ interruptMode: "manual", place: BUILT_IN_PLACE, capabilities: { noDisplay: false, excludeKinds: [], noSpeaker: false }, rev: 3 })
    expect(file.devices["dev-old-01"]!.own).toEqual({ interruptMode: "instant" })
    expect(file.devices["dev-old-01"]!.declared).toBeUndefined()
  })

  it("a version 3 file migrates with the built-in place; the store loads, saves and reloads it", async () => {
    const dir = tmp()
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 3, modules: {}, assistant: {}, frontends: { [WEB_VOICE_KIND]: { interruptMode: "instant" } }, devices: {} }))
    const store = await run(openStore(dir))
    expect(store.settings().deviceTypes[WEB_VOICE_KIND]?.place).toEqual(BUILT_IN_PLACE)
    const next = { ...store.settings().deviceTypes[WEB_VOICE_KIND]!, place: { ...BUILT_IN_PLACE, room: "Hall", privacy: "public" as const } }
    const { rev: _rev, ...settings } = next
    await run(store.saveDeviceType(WEB_VOICE_KIND, next.rev, settings))
    const again = await run(openStore(dir))
    expect(again.settings().deviceTypes[WEB_VOICE_KIND]?.place).toMatchObject({ room: "Hall", privacy: "public" })
  })
})

describe("a removed person", () => {
  it("is no device's or type's default person any more; others are left as they are", async () => {
    const dir = tmp()
    const placeOf = (person: string | null) => ({ ...BUILT_IN_PLACE, defaultPerson: person })
    writeFileSync(join(dir, "settings.json"), JSON.stringify({
      version: 4,
      modules: {},
      assistant: {},
      assistants: { order: [], byId: {} },
      deviceTypes: { [WEB_VOICE_KIND]: { ...BUILT_IN_WEB_VOICE_SETTINGS, place: placeOf("p-gone0001"), rev: 2 } },
      devices: {
        "phone-0001": { kind: WEB_VOICE_KIND, name: "Phone", firstSeen: 1, lastSeen: 2, own: { place: placeOf("p-gone0001") }, rev: 5 },
        "tablet-001": { kind: WEB_VOICE_KIND, name: "Tablet", firstSeen: 1, lastSeen: 2, own: { place: placeOf("p-kept0001") }, rev: 1 },
        "laptop-001": { kind: WEB_VOICE_KIND, name: "Laptop", firstSeen: 1, lastSeen: 2, own: {}, rev: 0 }
      }
    }))
    const store = await run(openStore(dir))
    expect(await run(store.clearDefaultPeople(new Set(["p-kept0001"])))).toBe(2)
    const s = store.settings()
    expect(s.deviceTypes[WEB_VOICE_KIND]).toMatchObject({ place: { defaultPerson: null }, rev: 3 })
    expect(s.devices["phone-0001"]).toMatchObject({ own: { place: { defaultPerson: null } }, rev: 6 })
    expect(s.devices["tablet-001"]).toMatchObject({ own: { place: { defaultPerson: "p-kept0001" } }, rev: 1 })
    expect(s.devices["laptop-001"]!.rev).toBe(0)
    // Nothing more to do: nothing is written.
    const before = readFileSync(join(dir, "settings.json"), "utf8")
    expect(await run(store.clearDefaultPeople(new Set(["p-kept0001"])))).toBe(0)
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before)
  })
})

describe("what a device declared", () => {
  it("is kept in its record; a resize stays in memory until the next write, a real change is written at once", async () => {
    const dir = tmp()
    const store = await run(openStore(dir))
    let now = 1_000
    const registry = makeDeviceRegistry({ store, now: () => now })
    await run(registry.seen({ id: "tab-000001", kind: WEB_VOICE_KIND, name: "Tablet", capabilities: tablet }, new Set()))
    expect(store.settings().devices["tab-000001"]!.declared).toEqual({ capabilities: tablet, seenAt: 1_000 })
    const disk = () => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).devices["tab-000001"].declared
    // Resized: memory only.
    now = 2_000
    const resized = { ...tablet, display: { ...tablet.display!, widthPx: 900 } }
    await run(registry.declare("tab-000001", resized))
    expect(registry.declaredOf("tab-000001")).toEqual({ capabilities: resized, seenAt: 2_000 })
    expect(disk().capabilities.display.widthPx).toBe(1024)
    // Rotated to a phone-sized class with a link-opening browser: written.
    now = 3_000
    const phone = { ...tablet, display: { ...tablet.display!, class: "compact" as const }, openUrl: true }
    await run(registry.declare("tab-000001", phone))
    expect(disk()).toEqual({ capabilities: phone, seenAt: 3_000 })
    // An unknown device's declaration is ignored; forgetting drops it.
    await run(registry.declare("never-seen", tablet))
    expect(registry.declaredOf("never-seen")).toBeUndefined()
    await run(registry.forget("tab-000001"))
    expect(registry.declaredOf("tab-000001")).toBeUndefined()
  })
})

const fileWithDevices = (devices: Json, assistant: Json = {}): SettingsFile =>
  ({
    version: 4,
    modules: {},
    assistant,
    assistants: { order: [], byId: {} },
    deviceTypes: {},
    devices
  }) as unknown as SettingsFile

describe("device facts", () => {
  const people = new Map([["p-sam00001", "Sam"]])
  const file = fileWithDevices({
    "kitchen-01": { kind: WEB_VOICE_KIND, name: "Kitchen speaker", firstSeen: 1, lastSeen: 5, own: { place: { ...BUILT_IN_PLACE, room: " Kitchen ", defaultPerson: "p-sam00001" } }, rev: 1, declared: { capabilities: { v: 1, speaker: { media: ["speech"] }, microphone: { farField: true } }, seenAt: 5 } },
    "ipad-00001": { kind: WEB_VOICE_KIND, name: "Kitchen iPad", firstSeen: 1, lastSeen: 4, own: { place: { ...BUILT_IN_PLACE, room: "kitchen" } }, rev: 1, declared: { capabilities: tablet, seenAt: 4 } },
    "gone-00001": { kind: WEB_VOICE_KIND, name: "Old phone", firstSeen: 1, lastSeen: 3, own: { place: { ...BUILT_IN_PLACE, privacy: "private", defaultPerson: "p-removed1" } }, rev: 1 },
    "tv-0000001": { kind: WEB_VOICE_KIND, name: "Living room TV", firstSeen: 1, lastSeen: 2, own: { capabilities: { noDisplay: true, excludeKinds: [], noSpeaker: false } }, rev: 1, declared: { capabilities: tablet, seenAt: 2 } }
  })
  const connected = new Set(["kitchen-01", "ipad-00001"])
  const facts = makeDeviceFacts({
    file: () => file,
    declaredOf: () => undefined,
    live: (id) => ({ connected: connected.has(id), visible: true }),
    isPerson: (id) => people.has(id),
    nameOfPerson: (id) => people.get(id),
    peopleVersion: () => people
  })

  it("places (a removed person is nobody), targets for the feed, and a turn's room and person", () => {
    expect(facts.placeOf("kitchen-01")).toMatchObject({ room: " Kitchen ", defaultPerson: "p-sam00001" })
    expect(facts.placeOf("gone-00001").defaultPerson).toBeNull()
    expect(facts.placeOf("never-seen")).toEqual(BUILT_IN_PLACE)
    expect(facts.targetOf({ id: "kitchen-01", name: "x" })).toEqual({ id: "kitchen-01", name: "Kitchen speaker", room: "Kitchen", privacy: "shared", defaultPerson: "p-sam00001" })
    expect(facts.targetOf(undefined)).toEqual({})
    expect(facts.originOf("kitchen-01")).toEqual({ room: "Kitchen", person: { id: "p-sam00001", how: "device-default" } })
    expect(facts.originOf("gone-00001")).toEqual({})
    expect(facts.privacy.mayReveal("p-sam00001", "kitchen-01")).toBe(true)
    expect(facts.privacy.mayReveal("p-sam00001", "ipad-00001")).toBe(false)
    expect(facts.privacy.mayReveal("p-sam00001", "gone-00001")).toBe(true)
    expect(facts.privacy.mayReveal("p-sam00001", "never-seen")).toBe(false)
  })

  it("Devices: effective capabilities, connected, and the best other screen; an override removes the TV's screen", () => {
    expect(facts.devices.get("tv-0000001")!.capabilities.display).toBeUndefined()
    expect(facts.devices.get("tv-0000001")!.declared!.capabilities.display).toBeDefined()
    expect(facts.devices.get("gone-00001")!.capabilities).toEqual({ v: 1 })
    expect(facts.devices.bestOtherScreen("kitchen-01")?.id).toBe("ipad-00001")
    expect(facts.devices.list().map((d) => d.id)).toEqual(["kitchen-01", "ipad-00001", "gone-00001", "tv-0000001"])
    // Live state is read again after `changed()`.
    connected.delete("ipad-00001")
    expect(facts.devices.get("ipad-00001")!.connected).toBe(true)
    facts.changed()
    expect(facts.devices.get("ipad-00001")!.connected).toBe(false)
    connected.add("ipad-00001")
    facts.changed()
  })

  it("the context line: from the cache, well inside 50 ms", () => {
    expect(facts.contextLine("kitchen-01")).toBe("Device: Kitchen speaker (voice only, no screen; room Kitchen; shared, usually Sam). Other screens: Kitchen iPad (on).")
    const times: Array<number> = []
    for (let i = 0; i < 2000; i++) {
      if (i % 100 === 0) facts.changed() // a rebuild now and then, as connections come and go
      const t0 = performance.now()
      facts.contextLine("kitchen-01")
      times.push(performance.now() - t0)
    }
    const sorted = [...times].sort((a, b) => a - b)
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!
    const worst = sorted.at(-1)!
    console.log(`device context line (4 devices): median ${sorted[1000]!.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms, worst ${worst.toFixed(3)} ms`)
    expect(p95).toBeLessThan(1)
    expect(worst).toBeLessThan(50)
  })

  it("TurnTrace: end of turn → request sent and → playback start, with the device line and without", async () => {
    const TURNS = 150
    const median = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const p95 = (xs: ReadonlyArray<number>) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!
    const measure = (withLine: boolean) =>
      Effect.gen(function*() {
        const base = makeToolRegistry([])
        const registry = withLine ? withContextProvider(base, facts.contextProvider) : base
        const ended = yield* Queue.unbounded<Trace>()
        const onEvent = (e: ConversationEvent) => {
          if (e._tag === "TurnEnded") Queue.offerUnsafe(ended, e.trace)
        }
        const sent: Array<number> = []
        const audible: Array<number> = []
        const contexts: Array<string | undefined> = []
        const events = Stream.range(1, TURNS).pipe(
          Stream.flatMap((i) =>
            Stream.make(speechStarted, endOfTurn(`What is on screen ${i}?`)).pipe(Stream.concat(Stream.fromEffectDrain(Effect.gen(function*() {
              const t = yield* Queue.take(ended)
              sent.push(t.marks.llmRequestSent! - t.marks.endOfTurn!)
              audible.push(t.marks.playbackStart! - t.marks.endOfTurn!)
            })))), { concurrency: 1 })
        )
        const llm = makeScriptedLlm((request) => {
          contexts.push(request.context)
          return [textDelta("Nothing.")]
        })
        const layer = Conversation.layerWithSetup({
          onEvent,
          setup: Effect.succeed({ system: "Benchmark.", registry, turnContext: { deviceId: "kitchen-01", assistantId: "jev" } })
        }).pipe(Layer.provideMerge(Layer.mergeAll(llm.layer, TurnTrace.layer())))
        yield* Effect.gen(function*() {
          const c = yield* Conversation
          yield* c.voice(events)
        }).pipe(Effect.provide(Layer.mergeAll(layer, makeMarkerTts().layer, makeRecordingAudioOutput({ chunkMillis: 0 }).layer)))
        return { sent: median(sent.slice(20)), sentP95: p95(sent.slice(20)), audible: median(audible.slice(20)), context: contexts.at(-1) }
      })
    const off: Array<{ sent: number; sentP95: number; audible: number }> = []
    const on: Array<{ sent: number; sentP95: number; audible: number; context: string | undefined }> = []
    for (let i = 0; i < 3; i++) {
      off.push(await run(measure(false)))
      on.push(await run(measure(true)))
    }
    const m = (xs: ReadonlyArray<{ sent: number; sentP95: number; audible: number }>, k: "sent" | "sentP95" | "audible") => median(xs.map((x) => x[k]))
    console.log(
      `TurnTrace, zero-delay fakes, median of ${TURNS - 20} turns x 3 runs: end of turn -> llmRequestSent ` +
        `without the line ${m(off, "sent").toFixed(3)} ms (p95 ${m(off, "sentP95").toFixed(3)}), with it ${m(on, "sent").toFixed(3)} ms (p95 ${m(on, "sentP95").toFixed(3)}); ` +
        `end of turn -> playbackStart without ${m(off, "audible").toFixed(3)} ms, with ${m(on, "audible").toFixed(3)} ms`
    )
    expect(on[0]!.context).toContain("## This device\nDevice: Kitchen speaker")
    expect(m(on, "sent")).toBeLessThan(m(off, "sent") + 5)
  }, 120_000)

  it("a provider outside a turn says nothing", async () => {
    expect(await run(facts.contextProvider.get)).toBe("")
    expect(await run(facts.contextProvider.get.pipe(Effect.provideService(CurrentTurn, { turnId: 1, conversationId: "c", source: "text" })))).toMatch(/^Device: a voice page without a known device/)
  })
})

// `SettingValue` is used for the casts above; keep the import honest.
export type _Unused = SettingValue
