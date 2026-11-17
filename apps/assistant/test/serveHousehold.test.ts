// Household data in serve mode (docs/STORING-DATA.md): a version 2 module's rows reach voice pages only through its
// collection's projection, per device, on the snapshot, live after commit, and in the replay after a reconnect; the
// bus carries the hub's device events; a database from a newer assistant stops the start.
import { defineCollection, defineModule, type HouseholdEvent, type ModuleStore, type Row } from "@pva/core"
import type { HouseholdChange, ServerMessageOf } from "@pva/protocol"
import { Effect, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ScriptedClient, sleep } from "./support/scriptedClient.ts"
import { controlledStt, fakeBuild, greeterModule, scriptedLlm, startTestServer, type TestServer } from "./support/serveHarness.ts"

vi.setConfig({ testTimeout: 30_000 })

const Note = Schema.Struct({ text: Schema.String, device: Schema.optionalKey(Schema.String) })
type Note = typeof Note.Type
/** Shown on the device a note names, and on every device when it names none. */
const board = defineCollection({
  name: "board",
  scope: "household",
  schema: Note,
  project: (row: Row<Note>, device) => (row.value.device === undefined || row.value.device === device.id ? { text: row.value.text } : undefined)
})
/** Never sent: no projection. */
const scratch = defineCollection({ name: "scratch", scope: "household", schema: Note })

let store: ModuleStore | undefined
const busEvents: Array<HouseholdEvent> = []
const boards = defineModule({
  apiVersion: 2,
  id: "boards",
  name: "Boards",
  description: "Notes on screens",
  storage: { collections: [board, scratch] },
  shared: (ctx) =>
    Effect.gen(function*() {
      store = ctx.store
      yield* Effect.forkScoped(Stream.runForEach(ctx.events.subscribe({ prefix: "host.device." }), (e) => Effect.sync(() => busEvents.push(e))))
      return { value: undefined }
    }),
  start: () => Effect.succeed({})
})

let server: TestServer | undefined
const clients: Array<ScriptedClient> = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await server?.close()
  server = undefined
  store = undefined
  busEvents.length = 0
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const events = (c: ScriptedClient) => c.messages.filter((m): m is ServerMessageOf<"household.event"> => m.type === "household.event")
const changeOf = (m: ServerMessageOf<"household.event">) => m.event.data as HouseholdChange

describe("household data in serve mode", () => {
  it("projections per device on the snapshot, live and in the replay; nothing without a projection; device events on the bus", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-household-"))
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, boards] })
    // Before any page: one note for the kitchen, one for everyone.
    await run(store!.collection(board).insert({ text: "kitchen only", device: "kitchen-0001" }))
    await run(store!.collection(board).insert({ text: "for everyone" }))
    const kitchen = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    const study = await ScriptedClient.connect({ url: server.url, deviceId: "study-00001" })
    clients.push(kitchen, study)
    await kitchen.hello()
    await study.hello()
    const snapK = await kitchen.waitFor("household.snapshot")
    const snapS = await study.waitFor("household.snapshot")
    expect(snapK.collections.map((c) => c.collection)).toEqual(["board"])
    expect(snapK.collections[0]!.rows.map((r) => (r.value as Note).text).sort()).toEqual(["for everyone", "kitchen only"])
    expect(snapS.collections[0]!.rows.map((r) => r.value)).toEqual([{ text: "for everyone" }])

    // Live, after commit: the study's note reaches the study only; the scratch collection reaches nobody.
    await run(store!.collection(board).insert({ text: "study only", device: "study-00001" }))
    await run(store!.collection(scratch).insert({ text: "not for pages" }))
    const live = await study.waitFor("household.event")
    expect(changeOf(live)).toMatchObject({ collection: "board", op: "put", value: { text: "study only" } })
    await sleep(150)
    expect(events(kitchen)).toHaveLength(0)
    expect(JSON.stringify(kitchen.messages)).not.toContain("not for pages")
    expect(JSON.stringify(study.messages)).not.toContain("not for pages")

    // The kitchen goes away; meanwhile its note moves to the study and a new shared one is added.
    const seenSeq = snapK.seq
    kitchen.close()
    await sleep(100)
    const rows = await run(store!.collection(board).list())
    const moved = rows.find((r) => r.value.text === "kitchen only")!
    await run(store!.collection(board).update(moved.id, (v) => ({ ...v, text: "moved to the study", device: "study-00001" })))
    await run(store!.collection(board).insert({ text: "new for everyone" }))
    // It comes back with the last number it saw: a replay (not a snapshot), with today's values only.
    const back = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    clients.push(back)
    await back.hello({ householdSeq: seenSeq })
    await sleep(200)
    expect(back.messages.some((m) => m.type === "household.snapshot")).toBe(false)
    const replay = events(back).map(changeOf)
    expect(replay.map((c) => c.op).sort()).toEqual(["put", "remove"])
    expect(replay.find((c) => c.op === "put")?.value).toEqual({ text: "new for everyone" })
    expect(replay.find((c) => c.op === "remove")?.id).toBe(moved.id)
    expect(JSON.stringify(back.messages)).not.toContain("moved to the study")
    expect(JSON.stringify(back.messages)).not.toContain("study only")

    // The hub's device events reached a module's subscription on the bus.
    const types = busEvents.map((e) => `${e.type}:${(e.data as { deviceId: string }).deviceId}`)
    expect(types).toContain("host.device.connected:kitchen-0001")
    expect(types).toContain("host.device.disconnected:kitchen-0001")
    expect(types).toContain("host.device.connected:study-00001")
  })

  it("a household database from a newer assistant stops the start with a clear message", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-household-newer-"))
    const first = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }) })
    await first.close()
    const raw = new DatabaseSync(join(dataDir, "household.db"))
    raw.prepare("UPDATE pva_meta SET value = '7' WHERE key = 'schema'").run()
    raw.close()
    await expect(startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }) })).rejects.toThrow(/newer version of the assistant/)
  })
})
