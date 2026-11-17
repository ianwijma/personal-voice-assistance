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
  type TurnContext
} from "@pva/core"
import { endOfTurn } from "@pva/core/testing"
import type { ClientMessage, DeviceCapabilities, DeviceListInfo, ServerMessageOf } from "@pva/protocol"
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
    const page = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-tab-1" })
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
    expect(context).toContain("## This device\nDevice: Test browser (tablet-size screen, touch, speaker, microphone; room Kitchen; shared, usually Sam). Other screens: none.")
    expect(requests.at(-2)!.system).not.toContain("This device")

    // A spoken turn on the same device: the same room and person, source voice.
    await page.claim()
    await until("the recogniser stream", () => stt.open() === 1)
    const before = seen.length
    stt.emit(endOfTurn("where am I now"))
    await until("the spoken tool call", () => seen.length > before)
    expect(seen.at(-1)!.turn).toMatchObject({ source: "voice", deviceId: "kitchen-tab-1", room: "Kitchen", person: { id: samId, how: "device-default" } })
    await page.waitFor("turn.end", () => true, { timeoutMs: 10_000 })

    // Taking the screen away in admin: the assistant is told "voice only"; the record still has the declaration.
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-1" }, rev: rev(), settings: { capabilities: { noDisplay: true, excludeKinds: [], noSpeaker: false } } })).ok).toBe(true)
    await typed("and now?")
    expect(requests.at(-2)!.context).toContain("Device: Test browser (voice only, no screen; room Kitchen; shared, usually Sam).")
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

    // Removing Sam clears the device's default person (and the turn has nobody's data).
    expect((await request(admin, { type: "settings.update", sectionId: "members", patch: { values: { HOUSEHOLD_MEMBERS: [members[1]!] as never }, secrets: {} } })).ok).toBe(true)
    await until("the device's default person cleared", () => store.settings().devices["kitchen-tab-1"]?.own.place?.defaultPerson === null)
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

    const page = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-tab-2" })
    clients.push(page)
    await page.hello()
    const texts = (m: ServerMessageOf<"household.snapshot">) => m.collections.flatMap((c) => c.rows.map((r) => (r.value as { text: string }).text)).sort()
    // Shared and nobody's (the built-in): neither list.
    expect(texts(await page.waitFor("household.snapshot"))).toEqual([])
    await until("the device record", () => lastDevices(admin).some((d) => d.id === "kitchen-tab-2"))
    const rev = () => lastDevices(admin).find((d) => d.id === "kitchen-tab-2")?.rev ?? 0
    const place = { room: "Kitchen", privacy: "shared" as const, alwaysOn: false, acceptsFromOthers: true, quietRoom: false, defaultPerson: samId! }
    let from = page.messages.length
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place } })).ok).toBe(true)
    expect(texts(await page.waitFor("household.snapshot", () => true, { from }))).toEqual(["Sam's list"])
    // Live: Robin's new row does not reach Sam's kitchen; Sam's does.
    from = page.messages.length
    await Effect.runPromise(storeRef!.collection(items).insert({ text: "Robin's second" }, { scope: { kind: "person", id: robinId! } }))
    await Effect.runPromise(storeRef!.collection(items).insert({ text: "Sam's second" }, { scope: { kind: "person", id: samId! } }))
    const live = await page.waitFor("household.event", () => true, { from })
    expect((live.event.data as { value: { text: string } }).value.text).toBe("Sam's second")
    // Private: both; a change of privacy alone is a change of place, so a fresh snapshot again.
    from = page.messages.length
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place: { ...place, privacy: "private" } } })).ok).toBe(true)
    expect(texts(await page.waitFor("household.snapshot", () => true, { from }))).toEqual(["Robin's list", "Robin's second", "Sam's list", "Sam's second"])
    // Public: none.
    from = page.messages.length
    expect((await request(admin, { type: "device.save", target: { kind: "device", id: "kitchen-tab-2" }, rev: rev(), settings: { place: { ...place, privacy: "public" } } })).ok).toBe(true)
    expect(texts(await page.waitFor("household.snapshot", () => true, { from }))).toEqual([])
  })
})
