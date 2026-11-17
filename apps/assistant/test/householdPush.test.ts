// The household push to voice pages (docs/STORING-DATA.md "Pages"), on the in-memory store: every frame is built when
// it is handed to the socket; nothing of the queue comes before a snapshot's final part, and nothing is lost after it;
// module events keep their place among the changes; a renamed device's pages get a fresh snapshot; an overflow too.
import { assert, describe, it } from "@effect/vitest"
import { connectStoreToBus, defineCollection, defineEventType, makeEventBus, makeHouseholdFeed, type Row, type TargetDevice } from "@pva/core"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import type { HouseholdChange, ServerMessage } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { makeHouseholdPush, MAX_QUEUED } from "../src/serve/HouseholdPush.ts"

const Note = Schema.Struct({ text: Schema.String, to: Schema.optionalKey(Schema.String) })
type Note = typeof Note.Type
/** Shown to the device named in `to` (by its recorded name), or to every device. */
const notes = defineCollection({
  name: "notes",
  scope: "household",
  schema: Note,
  project: (row: Row<Note>, device) => (row.value.to === undefined || row.value.to === device.name ? { text: row.value.text } : undefined)
})
const ping = defineEventType({ type: "ping", project: (e, device) => ({ n: (e.data as { n: number }).n, to: device.name ?? null }) })

const setup = Effect.gen(function*() {
  const store = makeMemoryHouseholdStore()
  yield* store.prepare([{ id: "m", storage: { collections: [notes] } }])
  const bus = makeEventBus()
  connectStoreToBus(store, bus)
  const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "m", collections: [notes], events: [ping] }] })
  const names = new Map<string, string>([["kitchen-01", "Kitchen"]])
  const scope = yield* Effect.scope
  const services = yield* Effect.context<never>()
  const push = makeHouseholdPush({
    feed,
    bus,
    store,
    device: (id): TargetDevice => (id === undefined ? {} : names.has(id) ? { id, name: names.get(id)! } : { id }),
    run: (effect) => void Effect.runForkWith(services)(Effect.forkIn(effect, scope)),
    log: () => {}
  })
  yield* push.forward
  const sent: Array<ServerMessage> = []
  const page = { id: "c1", deviceId: "kitchen-01", send: (m: ServerMessage) => void sent.push(JSON.parse(JSON.stringify(m)) as ServerMessage) }
  const m = store.forModule("m")
  return { store, bus, push, sent, page, names, m, events: bus.forModule("m") }
})

const settle = Effect.repeat(Effect.yieldNow, { times: 200 })
const kinds = (sent: ReadonlyArray<ServerMessage>) =>
  sent.map((x) => (x.type === "household.snapshot" ? `snapshot${x.part}${x.final ? "!" : ""}` : x.type === "household.event" ? (x.event.data as HouseholdChange).op ?? x.event.type : x.type))
const held = (sent: ReadonlyArray<ServerMessage>) => {
  let rows = new Map<string, unknown>()
  let incoming = new Map<string, unknown>()
  for (const x of sent) {
    if (x.type === "household.snapshot") {
      if (x.part === 0) incoming = new Map()
      for (const c of x.collections) for (const r of c.rows) incoming.set(r.id, r.value)
      if (x.final) rows = incoming
    } else if (x.type === "household.event" && x.event.type.endsWith(".changed")) {
      const ch = x.event.data as HouseholdChange
      if (ch.op === "put") rows.set(ch.id, ch.value)
      else rows.delete(ch.id)
    }
  }
  return rows
}

describe("household push", () => {
  it.effect("nothing of the queue before the snapshot's final part; module events keep their place among the changes", () =>
    Effect.gen(function*() {
      const { m, page, push, sent, events } = yield* setup
      // Enough rows for a snapshot of several steps.
      yield* m.transaction((tx) => {
        for (let i = 0; i < 100; i++) tx.collection(notes).insert({ text: `n${i}` }, { id: `n${String(i).padStart(3, "0")}` })
      })
      push.hooks.connected(page)
      // While the snapshot is being sent: a change and an event in one transaction, then an event alone.
      yield* Effect.yieldNow
      yield* m.transaction((tx) => {
        tx.collection(notes).insert({ text: "during" }, { id: "during" })
        tx.publish("ping", { n: 1 })
      })
      yield* events.publish("ping", { n: 2 })
      yield* settle
      const k = kinds(sent)
      const final = k.indexOf(k.find((x) => x.endsWith("!"))!)
      assert.isAbove(final, 0)
      assert.isTrue(k.slice(0, final + 1).every((x) => x.startsWith("snapshot")), k.join(" "))
      assert.deepStrictEqual(k.slice(final + 1), ["put", "m.ping", "m.ping"])
      const pings = sent.flatMap((x) => (x.type === "household.event" && x.event.type === "m.ping" ? [x.event.data] : []))
      assert.deepStrictEqual(pings, [{ n: 1, to: "Kitchen" }, { n: 2, to: "Kitchen" }])
      assert.strictEqual(held(sent).size, 101)
    }).pipe(Effect.scoped))

  it.effect("a frame is built when it is sent: a row shown and then hidden before that never travels", () =>
    Effect.gen(function*() {
      const { m, page, push, sent } = yield* setup
      push.hooks.connected(page)
      yield* settle
      // Two commits one after the other in this fiber (the page's fiber does not run in between): its frame is built
      // after both.
      yield* m.collection(notes).insert({ text: "secret for the kitchen", to: "Kitchen" }, { id: "s" })
      yield* m.collection(notes).update("s", (v) => ({ ...v, to: "Study" }))
      yield* settle
      assert.isFalse(JSON.stringify(sent).includes("secret"))
      // Shown, sent, then removed: the page is told.
      yield* m.collection(notes).insert({ text: "shown" }, { id: "x" })
      yield* settle
      yield* m.collection(notes).remove("x")
      yield* settle
      assert.deepStrictEqual(kinds(sent).slice(-2), ["put", "remove"])
      assert.strictEqual(held(sent).size, 0)
    }).pipe(Effect.scoped))

  it.effect("a renamed device's pages get a fresh snapshot made with its new record; others are left alone", () =>
    Effect.gen(function*() {
      const { m, page, push, sent, names } = yield* setup
      yield* m.collection(notes).insert({ text: "for the kitchen", to: "Kitchen" }, { id: "k" })
      push.hooks.connected(page)
      yield* settle
      assert.deepStrictEqual([...held(sent).values()], [{ text: "for the kitchen" }])
      // A save that changed nothing of this device: no snapshot.
      const before = sent.length
      push.hooks.devicesChanged()
      yield* settle
      assert.strictEqual(sent.length, before)
      // Renamed to Guest: a fresh snapshot without the kitchen's row; later changes are judged by the new name too.
      names.set("kitchen-01", "Guest")
      push.hooks.devicesChanged()
      yield* settle
      assert.deepStrictEqual(held(sent).size, 0)
      yield* m.collection(notes).update("k", (v) => ({ ...v, text: "still for the kitchen" }))
      yield* settle
      assert.isFalse(JSON.stringify(sent.slice(before)).includes("still for the kitchen"))
    }).pipe(Effect.scoped))

  it.effect("a page with more waiting than its queue holds gets a fresh snapshot, and ends with what it may see", () =>
    Effect.gen(function*() {
      const { m, page, push, sent } = yield* setup
      push.hooks.connected(page)
      yield* settle
      const snapshots = () => sent.filter((x) => x.type === "household.snapshot" && x.part === 0).length
      assert.strictEqual(snapshots(), 1)
      // More rows in one commit than the queue holds, before the page's fiber runs again.
      Effect.runSync(m.transaction((tx) => {
        for (let i = 0; i < MAX_QUEUED + 10; i++) tx.collection(notes).insert({ text: `b${i}` }, { id: `b${i}` })
      }))
      yield* settle
      assert.strictEqual(snapshots(), 2)
      // The snapshot holds at most 500 rows per collection; it says so.
      const last = sent.filter((x) => x.type === "household.snapshot")
      assert.isTrue(last.some((x) => x.type === "household.snapshot" && x.collections.some((c) => c.truncated)))
      // It ends with what it may see, as far as a snapshot holds it.
      assert.strictEqual(held(sent).size, 500)
    }).pipe(Effect.scoped))
})
