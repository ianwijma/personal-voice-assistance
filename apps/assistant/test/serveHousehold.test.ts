// Household data in serve mode (docs/STORING-DATA.md): a version 2 module's rows reach voice pages only through its
// collection's projection, per device, on the snapshot (after every hello) and after each commit; a page that sees a
// burst of changes ends where the store is; a failing projection stops nothing else; the bus carries the hub's device
// events; a database from a newer assistant stops the start.
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
/** Like the board (for a burst of another device's rows that must not crowd the board's snapshot). */
const wall = defineCollection({ ...board, name: "wall" })
/** Never sent: no projection. */
const scratch = defineCollection({ name: "scratch", scope: "household", schema: Note })
/** A projection with a bug: a row whose text is "bigint" cannot be sent (not JSON). */
const flaky = defineCollection({
  name: "flaky",
  scope: "household",
  schema: Note,
  project: (row: Row<Note>) => (row.value.text === "bigint" ? { n: 1n } : { text: row.value.text })
})

let store: ModuleStore | undefined
const busEvents: Array<HouseholdEvent> = []
const boards = defineModule({
  apiVersion: 2,
  id: "boards",
  name: "Boards",
  description: "Notes on screens",
  storage: { collections: [board, scratch, flaky, wall] },
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

/** What a page holds after applying every household message it got, in order (as P10's page will). */
const held = (c: ScriptedClient): Map<string, unknown> => {
  let rows = new Map<string, unknown>()
  let incoming = new Map<string, unknown>()
  for (const m of c.messages) {
    if (m.type === "household.snapshot") {
      if (m.part === 0) incoming = new Map()
      for (const col of m.collections) for (const r of col.rows) incoming.set(`${col.collection}/${r.id}`, r.value)
      if (m.final) rows = incoming
    } else if (m.type === "household.event") {
      const ch = m.event.data as HouseholdChange
      if (ch.op === "put") rows.set(`${ch.collection}/${ch.id}`, ch.value)
      else rows.delete(`${ch.collection}/${ch.id}`)
    }
  }
  return rows
}

describe("household data in serve mode", () => {
  it("projections per device on the snapshot, live and after a reconnect; nothing without a projection; device events on the bus", async () => {
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
    await kitchen.waitFor("household.snapshot", (m) => m.final)
    await study.waitFor("household.snapshot", (m) => m.final)
    // A collection with nothing the page may see is not in its snapshot.
    expect(snapK.collections.map((c) => c.collection)).toEqual(["board"])
    expect([...held(kitchen).values()].map((v) => (v as Note).text).sort()).toEqual(["for everyone", "kitchen only"])
    expect([...held(study).values()]).toEqual([{ text: "for everyone" }])

    // Live, after commit: the study's note reaches the study only; the scratch collection reaches nobody.
    await run(store!.collection(board).insert({ text: "study only", device: "study-00001" }))
    await run(store!.collection(scratch).insert({ text: "not for pages" }))
    const live = await study.waitFor("household.event")
    expect(changeOf(live)).toMatchObject({ collection: "board", op: "put", value: { text: "study only" } })
    await sleep(150)
    // The kitchen could have been shown a household row, so it is told this one is not for it: the collection and the
    // id only, nothing of the row.
    expect(events(kitchen).map((e) => Object.keys(changeOf(e)).sort())).toEqual([["collection", "id", "op"]])
    expect(JSON.stringify(kitchen.messages)).not.toContain("study only")
    expect(JSON.stringify(kitchen.messages)).not.toContain("not for pages")
    expect(JSON.stringify(study.messages)).not.toContain("not for pages")

    // The kitchen goes away; meanwhile its note moves to the study and a new shared one is added.
    kitchen.close()
    await sleep(100)
    const rows = await run(store!.collection(board).list())
    const moved = rows.find((r) => r.value.text === "kitchen only")!
    await run(store!.collection(board).update(moved.id, (v) => ({ ...v, text: "moved to the study", device: "study-00001" })))
    await run(store!.collection(board).insert({ text: "new for everyone" }))
    // It comes back: a fresh snapshot of what it may see now (a page never keeps rows across connections).
    const back = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    clients.push(back)
    await back.hello()
    const again = await back.waitFor("household.snapshot")
    expect(again.part).toBe(0)
    await back.waitFor("household.snapshot", (m) => m.final)
    expect([...held(back).values()].map((v) => (v as Note).text).sort()).toEqual(["for everyone", "new for everyone"])
    expect(JSON.stringify(back.messages)).not.toContain("moved to the study")
    expect(JSON.stringify(back.messages)).not.toContain("study only")

    // The hub's device events reached a module's subscription on the bus.
    const types = busEvents.map((e) => `${e.type}:${(e.data as { deviceId: string }).deviceId}`)
    expect(types).toContain("host.device.connected:kitchen-0001")
    expect(types).toContain("host.device.disconnected:kitchen-0001")
    expect(types).toContain("host.device.connected:study-00001")
  })

  it("a page that sees a burst of changes (and changes during its snapshot) ends with exactly what it may see now", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-household-burst-"))
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, boards] })
    for (let i = 0; i < 150; i++) await run(store!.collection(board).insert({ text: `before ${i}`, ...(i % 3 === 0 ? { device: "study-00001" } : {}) }, { id: `b${i}` }))
    const kitchen = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    const study = await ScriptedClient.connect({ url: server.url, deviceId: "study-00001" })
    clients.push(kitchen, study)
    await kitchen.hello()
    await kitchen.waitFor("household.snapshot", (m) => m.final)
    // The study says hello while the writes below run, so they meet its snapshot. The kitchen gets a burst (450 rows in
    // one commit, within what a snapshot holds), rows shown and hidden, rows removed.
    const studyHello = study.hello()
    await run(store!.transaction((tx) => {
      for (let i = 0; i < 450; i++) tx.collection(wall).insert({ text: `burst ${i}`, device: "kitchen-0001" }, { id: `x${i}` })
    }))
    for (let i = 0; i < 150; i += 2) await run(store!.collection(board).update(`b${i}`, (v) => (v.device === undefined ? { ...v, device: "study-00001" } : { text: v.text })))
    for (let i = 0; i < 450; i += 5) await run(store!.collection(wall).remove(`x${i}`))
    await studyHello
    // What is committed now, from the writes above.
    const all = new Map<string, Note>()
    for (let i = 0; i < 150; i++) {
      const before: Note = { text: `before ${i}`, ...(i % 3 === 0 ? { device: "study-00001" } : {}) }
      all.set(`board/b${i}`, i % 2 !== 0 ? before : before.device === undefined ? { ...before, device: "study-00001" } : { text: before.text })
    }
    for (let i = 0; i < 450; i++) if (i % 5 !== 0) all.set(`wall/x${i}`, { text: `burst ${i}`, device: "kitchen-0001" })
    const visibleTo = (device: string) => new Map([...all].filter(([, v]) => v.device === undefined || v.device === device).map(([key, v]) => [key, { text: v.text }] as const))
    for (const [client, device] of [[kitchen, "kitchen-0001"], [study, "study-00001"]] as const) {
      const expected = visibleTo(device)
      for (let t = 0; t < 100 && held(client).size !== expected.size; t++) await sleep(50)
      expect(held(client)).toEqual(expected)
    }
  })

  it("a projection that cannot be sent hides only that row; the next changes reach the pages", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pva-household-flaky-"))
    server = await startTestServer({ dataDir, build: fakeBuild({ stt: controlledStt().stt, llm: scriptedLlm(() => "Ok.").llm }), catalog: [greeterModule, boards] })
    const kitchen = await ScriptedClient.connect({ url: server.url, deviceId: "kitchen-0001" })
    const study = await ScriptedClient.connect({ url: server.url, deviceId: "study-00001" })
    clients.push(kitchen, study)
    await kitchen.hello()
    await study.hello()
    // A new device's feed starts once its record is written (P5): both snapshots first, then the changes.
    await kitchen.waitFor("household.snapshot")
    await study.waitFor("household.snapshot")
    await run(store!.collection(flaky).insert({ text: "bigint" }))
    await run(store!.collection(flaky).insert({ text: "fine" }))
    await run(store!.collection(board).insert({ text: "for the study", device: "study-00001" }))
    const live = await study.waitFor("household.event", (m) => (m.event.data as HouseholdChange).value !== undefined && JSON.stringify(m.event.data).includes("for the study"))
    expect(changeOf(live).op).toBe("put")
    for (let t = 0; t < 40 && held(kitchen).size < 1; t++) await sleep(50)
    expect([...held(kitchen).values()]).toEqual([{ text: "fine" }])
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
