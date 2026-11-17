// P5 in serve mode (docs/MODULES-PLAN.md §4): Members with generated ids, a device's place and what it declared,
// `CurrentTurn.room` and `.person` in a tool call of a typed and a spoken turn, the `People`, `Privacy` and `Devices`
// services through `host.service`, the per-turn device line, a fresh household snapshot when a device's default person
// changes, and a removed person cleared from every device.
import {
  CurrentTurn,
  defineCollection,
  defineModule,
  Devices,
  Llm,
  type LlmEvent,
  type LlmRequest,
  makeTool,
  type ModuleHostApi,
  type ModuleStore,
  People,
  Privacy,
  type Row,
  Tts,
  type TtsAudio,
  type TurnContext
} from "@pva/core"
import { endOfTurn } from "@pva/core/testing"
import { type ClientMessage, CloseCode, type DeviceCapabilities, type DeviceListInfo, type ServerMessageOf } from "@pva/protocol"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LlmBuilder } from "../src/serve/Resources.ts"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, TEST_ADMIN_PASSWORD, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 40_000 })

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
})

type Json = Record<string, any>

/** What the probe's tool saw in each call. */
const seen: Array<{ readonly turn: TurnContext | undefined; readonly found: unknown; readonly diet: unknown; readonly reveal: { readonly sam: boolean; readonly robin: boolean }; readonly screens: number }> = []
let hostRef: ModuleHostApi | undefined
let storeRef: ModuleStore | undefined

const Item = Schema.Struct({ text: Schema.String })
const items = defineCollection({ name: "items", scope: "person", schema: Item, project: (row: Row<typeof Item.Type>) => ({ text: row.value.text }) })

const probe = defineModule({
  apiVersion: 2,
  id: "probe",
  name: "Probe",
  description: "Reads the turn and the core's services",
  storage: { collections: [items] },
  shared: (ctx) =>
    Effect.sync(() => {
      hostRef = ctx.host
      storeRef = ctx.store
      return { value: undefined }
    }),
  start: (ctx) =>
    Effect.succeed({
      tools: [makeTool({
        name: "where",
        description: "Where am I and who is this?",
        parameters: Schema.Struct({}),
        speculative: true,
        execute: () =>
          Effect.gen(function*() {
            const turn = yield* CurrentTurn
            const people = ctx.host.service(People)!
            const privacy = ctx.host.service(Privacy)!
            const devices = ctx.host.service(Devices)!
            const sam = people.find("Sammie")
            const samId = sam.kind === "found" ? sam.person.id : undefined
            const robin = people.find("robin")
            seen.push({
              turn,
              found: sam,
              diet: people.dietOf(turn?.person?.id),
              reveal: {
                sam: privacy.mayReveal(samId, turn),
                robin: privacy.mayReveal(robin.kind === "found" ? robin.person.id : undefined, turn)
              },
              screens: devices.list().length
            })
            return "noted"
          })
      })]
    })
})

/** Calls the probe's tool, then answers; records every request (its per-turn context). */
const requests: Array<LlmRequest> = []
const toolThenText: LlmBuilder = () =>
  Effect.succeed(Llm.of({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(request)
        const last = request.messages.at(-1)
        const events: Array<LlmEvent> = last?.role === "tool"
          ? [{ _tag: "TextDelta", text: "Done." }, { _tag: "Done", stopReason: "end" }]
          : [{ _tag: "ToolCall", id: `c${requests.length}`, name: "where", input: {} }, { _tag: "Done", stopReason: "tool_use" }]
        return Stream.fromIterable(events)
      })
  }))

/** One assistant, Alpha, with the probe on; it answers on every browser without a phrase. */
const dataDirWithAlpha = async (): Promise<string> => {
  const dataDir = mkdtempSync(join(tmpdir(), "pva-people-"))
  const first = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "").llm }), dataDir })
  await first.close()
  const path = join(dataDir, "settings.json")
  const file = JSON.parse(readFileSync(path, "utf8")) as Json
  const base = file.assistants.byId[file.assistants.order[0]]
  const alpha = { ...base, id: "alpha", rev: 0, name: "Alpha", toolRounds: 3, llm: { ...base.llm, account: "anthropic", model: "model-a" }, modules: { probe: { on: true, offTools: [] } } }
  file.assistants = { order: ["alpha"], byId: { alpha } }
  file.deviceTypes["web-voice"] = { ...file.deviceTypes["web-voice"], assistants: [{ assistant: "alpha", phrases: [] }], withoutPhrase: { mode: "assistant", assistant: "alpha" }, interruptMode: "instant" }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return dataDir
}

let requestCounter = 0
type Request = Extract<ClientMessage, { requestId: string }>
type WithoutId<T> = T extends unknown ? Omit<T, "requestId"> : never
const request = async (client: ScriptedClient, message: WithoutId<Request>) => {
  const requestId = `r${++requestCounter}`
  const from = client.messages.length
  client.send({ ...message, requestId } as ClientMessage)
  return client.waitFor("result", (m) => m.requestId === requestId, { from, timeoutMs: 10_000 })
}

const until = async (what: string, check: () => boolean) => {
  for (let i = 0; i < 800 && !check(); i++) await sleep(10)
  if (!check()) throw new Error(`Timed out waiting for ${what}`)
}

const tablet: DeviceCapabilities = {
  v: 1,
  display: { class: "standard", widthPx: 1024, heightPx: 768, dpr: 2, touch: "coarse", colour: true },
  present: { kinds: {} },
  speaker: { media: ["speech", "audio"] },
  microphone: { farField: false }
}

/**
 * P5 round 2: a change of what a device may be told or sent ends its session; its page is closed with
 * `settingsChanged` and reconnects (as the web client does by itself): the same device and tab, a fresh hello.
 */
const reconnect = async (page: ScriptedClient, capabilities: DeviceCapabilities | undefined = tablet) => {
  const closed = await page.closed
  expect(closed.code).toBe(CloseCode.settingsChanged)
  const next = await ScriptedClient.connect({ url: server!.url, deviceId: page.device.id, clientId: page.clientId })
  clients.push(next)
  await next.hello({ device: { ...next.device, ...(capabilities !== undefined ? { capabilities } : {}) } })
  return next
}

const lastDevices = (admin: ScriptedClient): ReadonlyArray<DeviceListInfo> => {
  const pushed = admin.messages.filter((m): m is ServerMessageOf<"devices"> => m.type === "devices").at(-1)
  return pushed?.devices ?? admin.messages.flatMap((m) => (m.type === "admin.snapshot" ? [m.snapshot.devices] : [])).at(-1) ?? []
}

describe("people, rooms and device capabilities in serve mode", () => {
  it("Members, a device's place, CurrentTurn.room and .person in typed and spoken turns, the services, the device line", async () => {
    seen.length = 0
    requests.length = 0
    const dataDir = await dataDirWithAlpha()
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "").llm }), buildLlm: toolThenText, dataDir, catalog: [greeterModule, probe] })
    const store = server.handle.store
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)

    // Members: two people, no ids: the server makes them; an empty name is refused.
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "" }] }, secrets: {} } })).ok).toBe(false)
    const saved = await request(admin, {
      type: "settings.update",
      sectionId: "members",
      patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: ["Sammie"], allergies: ["nuts"] }, { name: "Robin" }], HOUSEHOLD_DIET_DIETS: ["vegetarian"] }, secrets: {} }
    })
    expect(saved.ok).toBe(true)
    const members = store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>
    expect(members.map((m) => m.name)).toEqual(["Sam", "Robin"])
    for (const m of members) expect(m.id).toMatch(/^p-[a-z0-9]{8}$/)
    const [samId, robinId] = [members[0]!.id as string, members[1]!.id as string]
    // Saving again keeps the ids.
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: members as never }, secrets: {} } })).ok).toBe(true)
    expect((store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).map((m) => m.id)).toEqual([samId, robinId])

    // A voice page that declares a tablet; the record keeps the declaration; admin sees it.
    let page = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-tab-1" })
    clients.push(page)
    await page.hello({ device: { ...page.device, capabilities: tablet } })
    await until("the device record", () => store.settings().devices["kitchen-tab-1"]?.declared !== undefined)
    expect(store.settings().devices["kitchen-tab-1"]!.declared!.capabilities).toEqual(tablet)
    await until("admin's list with the declaration", () => lastDevices(admin).some((d) => d.id === "kitchen-tab-1" && d.declared !== undefined))

    // Its place: the Kitchen, shared, Sam's by default. A person who is not in Members is refused.
    const rev = () => lastDevices(admin).find((d) => d.id === "kitchen-tab-1")?.rev ?? 0
    const place = { room: "Kitchen", privacy: "shared" as const, alwaysOn: true, acceptsFromOthers: true, quietRoom: false, defaultPerson: samId }
    const refused = await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-1" }, rev: rev(), settings: { place: { ...place, defaultPerson: "p-nobody00" } } })
    expect(refused.ok).toBe(false)
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-1" }, rev: rev(), settings: { place } })).ok).toBe(true)
    // A default person is a boundary: the page's session ended; it reconnects.
    page = await reconnect(page)

    // A typed turn: the tool sees the room and the device's default person, and the services answer.
    const typed = async (text: string) => {
      const before = seen.length
      const from = page.messages.length
      page.send({ type: "text.send", requestId: `t${++requestCounter}`, text, speak: false })
      await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
      await until("the tool call", () => seen.length > before)
      return seen.at(-1)!
    }
    const t1 = await typed("where am I?")
    expect(t1.turn).toMatchObject({ source: "text", deviceId: "kitchen-tab-1", room: "Kitchen", person: { id: samId, how: "device-default" } })
    expect(t1.found).toMatchObject({ kind: "found", person: { id: samId, name: "Sam" } })
    expect(t1.diet).toEqual({ allergies: ["nuts"], diets: ["vegetarian"], dislikes: [] })
    expect(t1.reveal).toEqual({ sam: true, robin: false })
    expect(t1.screens).toBe(1)
    // The device line is per-turn context, never part of the cached system prompt.
    const context = requests.at(-2)!.context ?? ""
    expect(context).toContain("## This device\nDevice: \"Test browser\" (tablet-size screen, touch, speaker (speech and sound), microphone; room \"Kitchen\"; shared, usually \"Sam\"). Other screens: none.")
    expect(requests.at(-2)!.system).not.toContain("This device")

    // A spoken turn on the same device: the same room and person, source voice.
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)
    const before = seen.length
    stt.emit(endOfTurn("where am I now"))
    await until("the spoken tool call", () => seen.length > before)
    expect(seen.at(-1)!.turn).toMatchObject({ source: "voice", deviceId: "kitchen-tab-1", room: "Kitchen", person: { id: samId, how: "device-default" } })
    await page.waitFor("turn.end", () => true, { timeoutMs: 10_000 })

    // Taking the screen away in admin (a boundary: the page reconnects): the assistant is told "voice only"; the
    // record still has the declaration.
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-1" }, rev: rev(), settings: { capabilities: { noDisplay: true, excludeKinds: [], noSpeaker: false } } })).ok).toBe(true)
    page = await reconnect(page)
    await typed("and now?")
    expect(requests.at(-2)!.context).toContain("Device: \"Test browser\" (voice only (speech and sound), no screen; room \"Kitchen\"; shared, usually \"Sam\").")
    expect(hostRef!.service(Devices)!.get("kitchen-tab-1")!.capabilities.display).toBeUndefined()
    expect(hostRef!.service(Devices)!.get("kitchen-tab-1")!.declared!.capabilities.display).toEqual(tablet.display)

    // A live update (a phone-like declaration) reaches the record and admin; a page hidden is no longer "on".
    page.send({ type: "device.caps", capabilities: { ...tablet, openUrl: true }, live: { visible: false, lastInteractionAt: Date.now() } })
    await until("the new declaration", () => store.settings().devices["kitchen-tab-1"]?.declared?.capabilities.openUrl === true)
    await until("admin sees it", () => lastDevices(admin).find((d) => d.id === "kitchen-tab-1")?.live?.visible === false)
    expect(hostRef!.service(Devices)!.get("kitchen-tab-1")).toMatchObject({ connected: true, visible: false })

    // A module records a diet: saved like an admin edit, seen by admin and by the next read.
    const from = admin.messages.length
    await Effect.runPromise(hostRef!.service(People)!.setDiet({ person: samId }, { dislikes: ["olives", " olives "] }))
    expect(hostRef!.service(People)!.dietOf(samId).dislikes).toEqual(["olives"])
    await admin.waitFor("section.changed", (m) => m.section.id === "members", { from })
    await expect(Effect.runPromise(hostRef!.service(People)!.setDiet({ person: "p-nobody00" }, { allergies: ["x"] }))).rejects.toBeDefined()

    // Removing Sam clears the device's default person (and the turn has nobody's data); the session ended.
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [members[1]!] as never }, secrets: {} } })).ok).toBe(true)
    await until("the device's default person cleared", () => store.settings().devices["kitchen-tab-1"]?.own.place?.defaultPerson === null)
    page = await reconnect(page, { ...tablet, openUrl: true })
    const t3 = await typed("who am I?")
    expect(t3.turn?.person).toBeUndefined()
    expect(t3.turn?.room).toBe("Kitchen")
    expect(t3.reveal).toEqual({ sam: false, robin: false })
  })

  it("a person's household rows reach a shared page only for its default person, with a fresh snapshot when that changes", async () => {
    const dataDir = await dataDirWithAlpha()
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), dataDir, catalog: [greeterModule, probe] })
    const store = server.handle.store
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    await admin.admin(TEST_ADMIN_PASSWORD)
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam" }, { name: "Robin" }] }, secrets: {} } })).ok).toBe(true)
    const [samId, robinId] = (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).map((m) => m.id as string)
    await until("the probe's store", () => storeRef !== undefined)
    await Effect.runPromise(storeRef!.collection(items).insert({ text: "Sam's list" }, { scope: { kind: "person", id: samId! } }))
    await Effect.runPromise(storeRef!.collection(items).insert({ text: "Robin's list" }, { scope: { kind: "person", id: robinId! } }))

    let page = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-tab-2" })
    clients.push(page)
    await page.hello()
    const texts = (m: ServerMessageOf<"household.snapshot">) => m.collections.flatMap((c) => c.rows.map((r) => (r.value as { text: string }).text)).sort()
    // Shared and nobody's (the built-in): neither list.
    expect(texts(await page.waitFor("household.snapshot"))).toEqual([])
    await until("the device record", () => lastDevices(admin).some((d) => d.id === "kitchen-tab-2"))
    const rev = () => lastDevices(admin).find((d) => d.id === "kitchen-tab-2")?.rev ?? 0
    const place = { room: "Kitchen", privacy: "shared" as const, alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: samId! }
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place } })).ok).toBe(true)
    // A new default person ends the page's session: its successor's first snapshot is of the new place.
    page = await reconnect(page, undefined)
    expect(texts(await page.waitFor("household.snapshot"))).toEqual(["Sam's list"])
    let from = page.messages.length
    // Live: Robin's new row does not reach Sam's kitchen; Sam's does.
    from = page.messages.length
    await Effect.runPromise(storeRef!.collection(items).insert({ text: "Robin's second" }, { scope: { kind: "person", id: robinId! } }))
    await Effect.runPromise(storeRef!.collection(items).insert({ text: "Sam's second" }, { scope: { kind: "person", id: samId! } }))
    const live = await page.waitFor("household.event", () => true, { from })
    expect((live.event.data as { value: { text: string } }).value.text).toBe("Sam's second")
    // Private: both (a change of privacy ends the session too).
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place: { ...place, privacy: "private" } } })).ok).toBe(true)
    page = await reconnect(page, undefined)
    expect(texts(await page.waitFor("household.snapshot"))).toEqual(["Robin's list", "Robin's second", "Sam's list", "Sam's second"])
    // Public: none.
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place: { ...place, privacy: "public" } } })).ok).toBe(true)
    page = await reconnect(page, undefined)
    expect(texts(await page.waitFor("household.snapshot"))).toEqual([])
    // Only the room: the same page goes on, with a fresh snapshot of the new place.
    from = page.messages.length
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place: { ...place, privacy: "public", room: "Den" } } })).ok).toBe(true)
    expect(texts(await page.waitFor("household.snapshot", () => true, { from }))).toEqual([])
  })
})

// ---- Review round 1 (docs/MODULES-PLAN.md §4 P5): the privacy boundary, the speaker, flooding, Members in one operation

/** A server with Alpha and the probe, Sam and Robin in Members, and an admin connection. */
const boot = async (extra: Partial<Parameters<typeof startTestServer>[0]> = {}) => {
  const dataDir = await dataDirWithAlpha()
  const stt = controlledStt()
  server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "").llm }), buildLlm: toolThenText, dataDir, catalog: [greeterModule, probe], ...extra })
  const store = server.handle.store
  const admin = await ScriptedClient.connect({ url: server.url })
  clients.push(admin)
  await admin.admin(TEST_ADMIN_PASSWORD)
  expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam" }, { name: "Robin" }] }, secrets: {} } })).ok).toBe(true)
  const [samId, robinId] = (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).map((m) => m.id as string) as [string, string]
  return { store, admin, stt, samId, robinId }
}

const placeOf = (defaultPerson: string | null, privacy: "private" | "shared" | "public" = "shared") => ({ room: "Kitchen", privacy, alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson })

const pageOn = async (deviceId: string, capabilities: DeviceCapabilities = tablet) => {
  const store = server!.handle.store
  const page = await ScriptedClient.connect({ url: server!.url, deviceId })
  clients.push(page)
  await page.hello({ device: { ...page.device, capabilities } })
  await until("the device record", () => store.settings().devices[deviceId] !== undefined)
  return page
}

const saveDevice = (admin: ScriptedClient, id: string, settings: Json) =>
  request(admin, { type: "device.save", target: { kind: "device", id }, rev: server!.handle.store.settings().devices[id]?.rev ?? 0, settings: settings as never })

const historyOf = async (page: ScriptedClient, assistantId = "alpha") => {
  const requestId = `h${++requestCounter}`
  const from = page.messages.length
  page.send({ type: "conversation.read", requestId, assistantId })
  return page.waitFor("conversation.history", (m) => m.requestId === requestId, { from, timeoutMs: 10_000 })
}

const typedOn = async (page: ScriptedClient, text: string, speak = false) => {
  const from = page.messages.length
  page.send({ type: "text.send", requestId: `t${++requestCounter}`, text, speak })
  return page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
}

describe("review round 2: a change of what a device may be told or sent ends its session", () => {
  it("privacy, default person and output overrides close the page with settingsChanged; its successor has a new conversation; a room alone does not", async () => {
    const { admin, samId, robinId } = await boot()
    let page = await pageOn("kitchen-hb-01")
    expect((await saveDevice(admin, "kitchen-hb-01", { place: placeOf(samId) })).ok).toBe(true)
    page = await reconnect(page)
    await typedOn(page, "what is on Sam's list?")
    const before = await historyOf(page)
    expect(before.history.length).toBeGreaterThan(0)

    // Each boundary: the old connection closes (nothing after the commit), the new one starts with nothing.
    const boundaries: ReadonlyArray<Json> = [
      { place: placeOf(samId, "public") },
      { place: placeOf(robinId, "public") },
      { capabilities: { noDisplay: false, excludeKinds: [], noSpeaker: true } },
      { capabilities: { noDisplay: true, excludeKinds: [], noSpeaker: true } },
      { capabilities: { noDisplay: true, excludeKinds: ["card"], noSpeaker: true } }
    ]
    let previous = before.id
    for (const change of boundaries) {
      await typedOn(page, "and now?")
      expect((await saveDevice(admin, "kitchen-hb-01", change)).ok).toBe(true)
      const old = page
      page = await reconnect(page)
      const after = await historyOf(page)
      expect(after.id).not.toBe(previous)
      expect(after.history).toEqual([])
      expect(old.messages.at(-1)?.type).not.toBe("conversation.history")
      previous = after.id
    }

    // Only the room: what it may be told did not change, so the conversation goes on, on the same connection.
    await typedOn(page, "still here?")
    const kept = await historyOf(page)
    const from = page.messages.length
    expect((await saveDevice(admin, "kitchen-hb-01", { place: { ...placeOf(robinId, "public"), room: "Den" } })).ok).toBe(true)
    await sleep(300)
    expect(page.messages.slice(from).some((m) => m.type === "conversation")).toBe(false)
    expect((await historyOf(page)).id).toBe(kept.id)
  })

  it("removing any member of the household ends every device's session, not only where they were the default person", async () => {
    const { admin, store, samId, robinId } = await boot()
    let samsPage = await pageOn("kitchen-hb-02")
    expect((await saveDevice(admin, "kitchen-hb-02", { place: placeOf(samId, "private") })).ok).toBe(true)
    samsPage = await reconnect(samsPage)
    const other = await pageOn("hallway-hb-03")
    await typedOn(samsPage, "remember Robin's thing")
    await typedOn(other, "hello")
    // Robin goes (not the default person anywhere): both devices' sessions end.
    const sam = (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).find((m) => m.id === samId)!
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [sam] as never }, secrets: {} } })).ok).toBe(true)
    samsPage = await reconnect(samsPage)
    const next = await reconnect(other)
    expect((await historyOf(samsPage)).history).toEqual([])
    expect((await historyOf(next)).history).toEqual([])
    expect(store.settings().devices["kitchen-hb-02"]!.own.place?.defaultPerson).toBe(samId)
    // Removing the default person: the same, and the reference is cleared.
    await typedOn(samsPage, "remember this")
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [] as never }, secrets: {} } })).ok).toBe(true)
    samsPage = await reconnect(samsPage)
    expect((await historyOf(samsPage)).history).toEqual([])
    await until("the reference cleared", () => store.settings().devices["kitchen-hb-02"]!.own.place?.defaultPerson === null)
    void robinId
  })

  it("a device type's output override ends the session of every device of that type, and of a page without a device", async () => {
    const { admin } = await boot()
    const page = await pageOn("type-hb-0001")
    const bare = await ScriptedClient.connect({ url: server!.url })
    clients.push(bare)
    await bare.hello({ device: false })
    const type = server!.handle.store.settings().deviceTypes["web-voice"]
    const saved = await request(admin, {
      type: "device.save",
      target: { kind: "type", type: "web-voice" },
      rev: type?.rev ?? 0,
      settings: { capabilities: { noDisplay: false, excludeKinds: [], noSpeaker: true } } as never
    })
    expect(saved.ok).toBe(true)
    expect((await page.closed).code).toBe(CloseCode.settingsChanged)
    expect((await bare.closed).code).toBe(CloseCode.settingsChanged)
  })

  it("forgetting a connected device ends its session; it says hello again as a new device with what it declares then", async () => {
    const { admin, store } = await boot()
    const page = await pageOn("forget-hb-01")
    await typedOn(page, "hi")
    expect((await request(admin, { type: "device.forget", id: "forget-hb-01" })).ok).toBe(true)
    const phone = { ...tablet, openUrl: true }
    const next = await reconnect(page, phone)
    expect(store.settings().devices["forget-hb-01"]?.declared?.capabilities).toEqual(phone)
    expect((await historyOf(next)).history).toEqual([])
  })
})

describe("review round 1: \"Don't use its speaker\" is true", () => {
  const replies = (page: ScriptedClient, from: number) => page.messages.slice(from).filter((m) => m.type === "reply.start").length
  const samples = (page: ScriptedClient) => [...page.replySamples.values()].reduce((a, b) => a + b, 0)

  it("no reply audio for spoken or typed turns, and the setup says so; a page claiming a speaker cannot get it back", async () => {
    const { admin, stt } = await boot()
    const page = await pageOn("speaker-off-1")
    // The control: with its speaker, a spoken turn plays.
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)
    let from = page.messages.length
    stt.emit(endOfTurn("hello there"))
    await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    await until("the reply audio", () => samples(page) > 0)
    expect(replies(page, from)).toBeGreaterThan(0)

    // "Don't use its speaker": the session ends; the new one's setup has speaking off, and nothing is sent to be played.
    expect((await saveDevice(admin, "speaker-off-1", { capabilities: { noDisplay: false, excludeKinds: [], noSpeaker: true } })).ok).toBe(true)
    const heard = samples(page)
    const next = await reconnect(page)
    const setup = next.messages.find((m): m is ServerMessageOf<"welcome"> => m.type === "welcome")!.snapshot.setup!
    expect(setup.audio.speakAloud).toBe(false)
    expect(setup.captions.speakTyped).toBe(false)
    await next.claim()
    await until("the recogniser stream", () => stt.open() >= 1)
    from = next.messages.length
    stt.emit(endOfTurn("say something"))
    await next.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    // The page (falsely) declares a speaker again and asks for a spoken typed reply: still nothing.
    next.send({ type: "device.caps", capabilities: { ...tablet, speaker: { media: ["speech", "audio", "video"] } } })
    await typedOn(next, "speak this", true)
    await sleep(300)
    expect(replies(next, from)).toBe(0)
    expect(samples(next)).toBe(0)
    expect(samples(page)).toBe(heard)
  })

  it("a declaration without speech: the setup says nothing is spoken, at hello and live; a speaker declared later speaks again", async () => {
    await boot()
    const { speaker: _, ...mute } = tablet
    const page = await pageOn("speaker-decl1", mute)
    const welcome = page.messages.find((m): m is ServerMessageOf<"welcome"> => m.type === "welcome")!
    expect(welcome.snapshot.setup!.audio.speakAloud).toBe(false)
    expect(welcome.snapshot.setup!.captions.speakTyped).toBe(false)
    let from = page.messages.length
    page.send({ type: "device.caps", capabilities: { ...mute, speaker: { media: ["audio"] } } })
    await sleep(700)
    // Sound but no speech: still no speaking.
    expect(page.messages.slice(from).some((m) => m.type === "device.setup" && m.audio.speakAloud)).toBe(false)
    from = page.messages.length
    page.send({ type: "device.caps", capabilities: tablet })
    const live = await page.waitFor("device.setup", (m) => m.audio.speakAloud, { from, timeoutMs: 5000 })
    expect(live.captions.speakTyped).toBe(true)
    // The same device, known now, says hello again without speech: its welcome already says so.
    page.close()
    const again = await ScriptedClient.connect({ url: server!.url, deviceId: "speaker-decl1" })
    clients.push(again)
    const second = await again.hello({ device: { ...again.device, capabilities: mute } })
    expect(second.snapshot.setup!.audio.speakAloud).toBe(false)
  })

  it("a page that declares no speaker gets no reply audio either", async () => {
    const { stt } = await boot()
    const { speaker: _, ...mute } = tablet
    const page = await pageOn("speaker-none1", mute)
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)
    const from = page.messages.length
    stt.emit(endOfTurn("hello"))
    await page.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    await typedOn(page, "speak this", true)
    await sleep(300)
    expect(replies(page, from)).toBe(0)
    expect(samples(page)).toBe(0)
  })
})

describe("review round 2: permission is decided where output leaves, against committed state", () => {
  const samples = (page: ScriptedClient) => [...page.replySamples.values()].reduce((a, b) => a + b, 0)

  it("a new device's welcome waits for its first registration: nothing is decided for it before its record exists", async () => {
    let hold: Promise<void> | undefined
    const { store } = await boot({ settingsBeforeStep: () => hold })
    let release!: () => void
    hold = new Promise((r) => (release = r))
    const page = await ScriptedClient.connect({ url: server!.url, deviceId: "held-reg-0001" })
    clients.push(page)
    const welcome = page.hello({ device: { ...page.device, capabilities: tablet } })
    await sleep(300)
    expect(page.messages.some((m) => m.type === "welcome")).toBe(false)
    expect(store.settings().devices["held-reg-0001"]).toBeUndefined()
    hold = undefined
    release()
    await welcome
    expect(store.settings().devices["held-reg-0001"]?.declared?.capabilities).toEqual(tablet)
  })

  it("a page without a device follows its type's \"Don't use its speaker\": no reply audio, and its setup says so", async () => {
    const { admin, stt } = await boot()
    expect((await request(admin, {
      type: "device.save",
      target: { kind: "type", type: "web-voice" },
      rev: server!.handle.store.settings().deviceTypes["web-voice"]?.rev ?? 0,
      settings: { capabilities: { noDisplay: false, excludeKinds: [], noSpeaker: true } } as never
    })).ok).toBe(true)
    const bare = await ScriptedClient.connect({ url: server!.url })
    clients.push(bare)
    const welcome = await bare.hello({ device: false })
    expect(welcome.snapshot.setup!.audio.speakAloud).toBe(false)
    await bare.claim()
    await until("the recogniser stream", () => stt.open() >= 1)
    const from = bare.messages.length
    stt.emit(endOfTurn("hello"))
    await bare.waitFor("turn.end", () => true, { from, timeoutMs: 10_000 })
    await typedOn(bare, "speak this", true)
    await sleep(300)
    expect(bare.messages.slice(from).some((m) => m.type === "reply.start")).toBe(false)
    expect(samples(bare)).toBe(0)
  })

  it("a declaration without speech during a long reply: no frame after it is handled", async () => {
    // A slow voice: 80 chunks of 40 ms, 25 ms apart.
    const slowTts = Tts.of({
      sampleRate: 22_050,
      synthesize: (clauses) =>
        clauses.pipe(Stream.zipWithIndex, Stream.flatMap(([, clause]) =>
          Stream.fromIterable(Array.from({ length: 80 }, (): TtsAudio => ({ audio: new Uint8Array(new Int16Array(882).fill(800).buffer), clause }))).pipe(
            Stream.tap(() => Effect.sleep(25))
          )
        ))
    })
    const dataDir = await dataDirWithAlpha()
    const stt = controlledStt()
    server = await startTestServer({ build: fakeBuild({ stt: stt.stt, llm: scriptedLlm(() => "A long answer.").llm, tts: slowTts }), dataDir })
    const page = await pageOn("revoke-tab-01")
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)
    const from = page.messages.length
    stt.emit(endOfTurn("tell me a story"))
    await until("the first audio", () => samples(page) > 0)
    const { speaker: _, ...mute } = tablet
    page.send({ type: "device.caps", capabilities: mute })
    await sleep(150)
    const atRevoke = samples(page)
    await page.waitFor("turn.end", () => true, { from, timeoutMs: 15_000 })
    await sleep(200)
    // At most what was already on the way (a frame or two), never the rest of the 80.
    expect(samples(page) - atRevoke).toBeLessThanOrEqual(2 * 882)
    expect(samples(page)).toBeLessThan(40 * 882)
  })
})

describe("review round 1: device.caps is bounded on the server", () => {
  it("a flood is coalesced to the latest declaration, written at most about once a second; empty and unchanged ones do nothing", async () => {
    let writes = 0
    await boot({ settingsBeforeStep: (step) => {
      if (step === "settings") writes++
    } })
    const store = server!.handle.store
    const page = await pageOn("flood-tab-01")
    await sleep(200)
    const before = writes
    const phone = { ...tablet, openUrl: true }
    for (let i = 0; i < 400; i++) {
      page.send({ type: "device.caps", capabilities: i % 2 === 0 ? phone : tablet, live: { visible: i % 3 !== 0, lastInteractionAt: Date.now() } })
      page.send({ type: "device.caps" } as ClientMessage)
    }
    page.send({ type: "device.caps", capabilities: phone })
    await until("the latest declaration in memory", () => hostRef!.service(Devices)!.get("flood-tab-01")?.declared?.capabilities.openUrl === true)
    await until("the latest declaration on disk", () => store.settings().devices["flood-tab-01"]?.declared?.capabilities.openUrl === true)
    await sleep(1500)
    // 800 messages, a handful of writes.
    expect(writes - before).toBeGreaterThan(0)
    expect(writes - before).toBeLessThanOrEqual(4)
    // The same declaration again changes nothing on disk.
    const settled = writes
    for (let i = 0; i < 20; i++) page.send({ type: "device.caps", capabilities: phone })
    await sleep(1200)
    expect(writes).toBe(settled)
    // A page that goes away mid-flood leaves nothing running: the server keeps answering.
    for (let i = 0; i < 50; i++) page.send({ type: "device.caps", capabilities: i % 2 === 0 ? tablet : phone })
    page.close()
    await sleep(800)
    const other = await pageOn("flood-tab-02")
    expect(other.messages.some((m) => m.type === "welcome")).toBe(true)
  })
})

describe("review round 1: Members and the references to them change in one serialized operation", () => {
  /** Holds the next settings write until released. */
  const holder = () => {
    let armed = false
    let release: (() => void) | undefined
    return {
      arm: () => {
        armed = true
        release = undefined
      },
      held: () => release !== undefined,
      release: () => release?.(),
      step: async (step: string) => {
        if (step !== "settings" || !armed) return
        armed = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    }
  }

  it("two diets written at once both land (read, check and write are one step)", async () => {
    const hold = holder()
    const { samId, robinId, store } = await boot({ settingsBeforeStep: (s) => hold.step(s) })
    await until("the probe", () => hostRef !== undefined)
    const people = hostRef!.service(People)!
    hold.arm()
    const first = Effect.runPromise(people.setDiet({ person: samId }, { dislikes: ["olives"] }))
    await until("the first diet's write held", () => hold.held())
    const second = Effect.runPromise(people.setDiet({ person: robinId }, { allergies: ["sesame"] }))
    await sleep(150)
    hold.release()
    await Promise.all([first, second])
    const saved = store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>
    expect(saved.find((m) => m.id === samId)!.dislikes).toEqual(["olives"])
    expect(saved.find((m) => m.id === robinId)!.allergies).toEqual(["sesame"])
  })

  it("a diet written while the person is being removed does not bring them back", async () => {
    const hold = holder()
    const { admin, samId, robinId, store } = await boot({ settingsBeforeStep: (s) => hold.step(s) })
    await until("the probe", () => hostRef !== undefined)
    const robin = (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).find((m) => m.id === robinId)!
    hold.arm()
    const removal = request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [robin] as never }, secrets: {} } })
    await until("the removal's write held", () => hold.held())
    const diet = Effect.runPromise(Effect.result(hostRef!.service(People)!.setDiet({ person: samId }, { dislikes: ["olives"] })))
    await sleep(150)
    hold.release()
    expect((await removal).ok).toBe(true)
    const r = await diet
    expect(r._tag).toBe("Failure")
    expect((store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).map((m) => m.id)).toEqual([robinId])
  })

  it("a device or device type saved with a person who is being removed: refused, never a dangling reference", async () => {
    const hold = holder()
    const { admin, samId, robinId, store } = await boot({ settingsBeforeStep: (s) => hold.step(s) })
    await pageOn("race-tab-001")
    await sleep(200)
    const robin = (store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).find((m) => m.id === robinId)!
    hold.arm()
    const removal = request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [robin] as never }, secrets: {} } })
    await until("the removal's write held", () => hold.held())
    const device = saveDevice(admin, "race-tab-001", { place: placeOf(samId) })
    const typeRev = store.settings().deviceTypes["web-voice"]?.rev ?? 0
    const type = request(admin, { type: "device.save", target: { kind: "type", type: "web-voice" }, rev: typeRev, settings: { place: placeOf(samId) } as never })
    await sleep(150)
    hold.release()
    expect((await removal).ok).toBe(true)
    expect((await device).ok).toBe(false)
    expect((await type).ok).toBe(false)
    await sleep(200)
    expect(store.settings().devices["race-tab-001"]!.own.place?.defaultPerson ?? null).toBeNull()
    expect(store.settings().deviceTypes["web-voice"]?.place?.defaultPerson ?? null).toBeNull()
  })
})

describe("review round 1: Members never come from the environment; the server makes every id", () => {
  it("HOUSEHOLD_MEMBERS in the environment is not read, and the environment view says why", async () => {
    const dataDir = await dataDirWithAlpha()
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), dataDir, catalog: [greeterModule, probe], env: { HOUSEHOLD_MEMBERS: JSON.stringify([{ name: "Sam" }, { id: "p-dup", name: "A" }, { id: "p-dup", name: "B" }]) } })
    await until("the probe", () => hostRef !== undefined)
    expect(hostRef!.service(People)!.list()).toEqual([])
    const admin = await ScriptedClient.connect({ url: server.url })
    clients.push(admin)
    const snapshot = await admin.admin(TEST_ADMIN_PASSWORD)
    const entry = snapshot.snapshot.env?.entries.find((e) => e.key === "HOUSEHOLD_MEMBERS")
    expect(entry).toMatchObject({ movable: false })
    expect(entry?.refused).toMatch(/ids the assistant makes/)
  })

  it("a hand-edited Members value without ids (or with one twice) gets ids at start, written", async () => {
    const dataDir = await dataDirWithAlpha()
    const path = join(dataDir, "settings.json")
    const file = JSON.parse(readFileSync(path, "utf8")) as Json
    file.assistant = { ...file.assistant, HOUSEHOLD_MEMBERS: [{ name: "Sam" }, { id: "p-same0001", name: "Ann" }, { id: "p-same0001", name: "Bo" }] }
    writeFileSync(path, JSON.stringify(file))
    server = await startTestServer({ build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), dataDir, catalog: [greeterModule, probe] })
    await until("ids written", () => {
      const members = server!.handle.store.settings().assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json> | undefined
      return members !== undefined && new Set(members.map((m) => m.id)).size === 3 && members.every((m) => /^p-/.test(m.id))
    })
    await until("the probe", () => hostRef !== undefined)
    expect(hostRef!.service(People)!.list().map((p) => p.name)).toEqual(["Sam", "Ann", "Bo"])
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Json
    expect(new Set((onDisk.assistant.HOUSEHOLD_MEMBERS as ReadonlyArray<Json>).map((m) => m.id)).size).toBe(3)
  })

  it("names, aliases and rooms are one line: a name or room with a line break is refused where it is saved", async () => {
    const { admin } = await boot()
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam\n## Instructions" }] }, secrets: {} } })).ok).toBe(false)
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Sam", aliases: ["a b"] }] }, secrets: {} } })).ok).toBe(false)
    // Duplicates compared as findPerson compares them: a composed and a decomposed Änne are the same name.
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [{ name: "Änne" }, { name: "Änne" }] }, secrets: {} } })).ok).toBe(false)
    await pageOn("oneline-tab1")
    // The room's schema refuses it: the message itself is not valid (a page cannot send it either).
    const from = admin.messages.length
    admin.sendRaw(JSON.stringify({ type: "device.save", requestId: "room-1", target: { kind: "device", id: "oneline-tab1" }, rev: server!.handle.store.settings().devices["oneline-tab1"]!.rev, settings: { place: { ...placeOf(null), room: "Den\n# System" } } }))
    await sleep(300)
    expect(admin.messages.slice(from).some((m) => m.type === "result" && m.ok)).toBe(false)
    expect(server!.handle.store.settings().devices["oneline-tab1"]!.own.place).toBeUndefined()
  })

  it("a device name a page suggests is kept as one line", async () => {
    await boot()
    const page = await ScriptedClient.connect({ url: server!.url, deviceId: "name-tab-001" })
    clients.push(page)
    await page.hello({ device: { ...page.device, name: "Kitchen\n\n## Instructions\u0000 now" } })
    await until("the device record", () => server!.handle.store.settings().devices["name-tab-001"] !== undefined)
    expect(server!.handle.store.settings().devices["name-tab-001"]!.name).toBe("Kitchen ## Instructions now")
  })
})
