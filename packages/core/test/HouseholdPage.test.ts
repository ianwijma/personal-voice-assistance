// The page queue (`HouseholdPage`) as a property: random commits (puts, updates, removals in a household and a
// device-scoped collection, rows moving in and out of a page's view), module events for this page and for another
// device, device renames (a fresh snapshot), sends that fail (a restart) and slow sockets (a random number of steps
// between commits), with a small queue bound so it overflows. A model page applies what it is sent. Whenever the queue
// is drained: the page holds exactly the projection of the committed rows for its device now; it received every module
// event meant for it, in order, exactly once, unless a `household.gap` said otherwise; and nothing was dropped without
// one. The queue never holds more than its bound.
import { assert, describe, it } from "@effect/vitest"
import type { HouseholdChange } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { connectStoreToBus, defineEventType, makeEventBus } from "../src/EventBus.ts"
import { makeHouseholdFeed, mayRevealScopeTo, projectRow } from "../src/HouseholdFeed.ts"
import { makeHouseholdPage, type PageMessage } from "../src/HouseholdPage.ts"
import { defineCollection, type Row, type ScopeRef } from "../src/HouseholdStore.ts"
import { makeMemoryHouseholdStore } from "../src/MemoryHouseholdStore.ts"

const Note = Schema.Struct({ text: Schema.String, to: Schema.optionalKey(Schema.String) })
type Note = typeof Note.Type
const hh = defineCollection({ name: "hh", scope: "household", schema: Note, project: (row: Row<Note>, device) => (row.value.to === undefined || row.value.to === device.name ? { text: row.value.text } : undefined) })
const dv = defineCollection({ name: "dv", scope: "device", schema: Note, project: (row: Row<Note>) => ({ text: row.value.text }) })
const ping = defineEventType({ type: "ping", project: (e) => ({ n: (e.data as { n: number }).n }) })

const random = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DEVICES = ["kitchen-01", "study-001"]
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"]

/** A page as a browser would hold it: rows by `collection/id`, the module events it got, the gaps it was told of. */
const modelPage = () => {
  let rows = new Map<string, unknown>()
  let incoming = new Map<string, unknown>()
  const events: Array<number> = []
  let gaps = 0
  const apply = (m: PageMessage) => {
    if (m.type === "household.gap") gaps++
    else if (m.type === "household.snapshot") {
      if (m.part === 0) incoming = new Map()
      for (const c of m.collections) for (const r of c.rows) incoming.set(`${c.collection}/${r.id}`, r.value)
      if (m.final) {
        assert.deepStrictEqual(m.truncated, [])
        rows = incoming
      }
    } else if (m.event.type.endsWith(".changed")) {
      const ch = m.event.data as HouseholdChange
      if (ch.op === "put") rows.set(`${ch.collection}/${ch.id}`, ch.value)
      else {
        assert.deepStrictEqual(Object.keys(ch).sort(), ["collection", "id", "op"])
        rows.delete(`${ch.collection}/${ch.id}`)
      }
    } else events.push((m.event.data as { n: number }).n)
  }
  return { apply, rows: () => rows, events, gaps: () => gaps }
}

const run = (seed: number, steps: number) =>
  Effect.gen(function*() {
    const r = random(seed)
    const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(r() * xs.length)]!
    const chance = (p: number) => r() < p
    const store = makeMemoryHouseholdStore()
    yield* store.prepare([{ id: "m", storage: { collections: [hh, dv] } }])
    const bus = makeEventBus()
    connectStoreToBus(store, bus)
    const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "m", collections: [hh, dv], events: [ping] }] })
    let name = "Kitchen"
    const device = () => ({ id: "kitchen-01", name })
    const max = 3 + Math.floor(r() * 40)
    const page = makeHouseholdPage({ feed, device, maxQueued: max })
    store.onCommit((released) => {
      page.offer(released)
      assert.isAtMost(page.size(), max)
    })
    const model = modelPage()
    /** Module events meant for this page, in commit order. */
    const accepted: Array<number> = []
    let n = 0
    let overflowsOrRestarts = 0
    const m = store.forModule("m")
    const drain = () => {
      while (page.pending()) for (const msg of page.step()) model.apply(msg)
    }
    const check = () => {
      drain()
      const expected = new Map<string, unknown>()
      for (const c of [hh, dv]) {
        const reader = store.reader("m", c)!
        const scopes: ReadonlyArray<ScopeRef> = c.scope === "household" ? [{ kind: "household" }] : [{ kind: "device", id: "kitchen-01" }]
        for (const scope of scopes) {
          for (const row of reader.page(scope, undefined, 100)) {
            const value = projectRow(c, row, device())
            if (value !== undefined) expected.set(`${c.name}/${row.id}`, value)
          }
        }
      }
      assert.deepStrictEqual(Object.fromEntries([...model.rows()].sort()), Object.fromEntries([...expected].sort()), `seed ${seed}: rows`)
      if (model.gaps() === 0) assert.deepStrictEqual(model.events, accepted, `seed ${seed}: events without a gap`)
      else {
        // Each one at most once, in order; only what was accepted.
        for (let i = 1; i < model.events.length; i++) assert.isBelow(accepted.indexOf(model.events[i - 1]!), accepted.indexOf(model.events[i]!))
        for (const e of model.events) assert.include(accepted, e)
      }
      // Nothing dropped without a gap.
      if (model.events.length < accepted.length) assert.isAbove(model.gaps(), 0, `seed ${seed}: events lost without a gap`)
    }
    for (let i = 0; i < steps; i++) {
      const what = r()
      if (what < 0.55) {
        // A commit of one to four writes and maybe events.
        const writes = Array.from({ length: 1 + Math.floor(r() * 4) }, () => {
          const c = chance(0.6) ? hh : dv
          const scope: ScopeRef = c === hh ? { kind: "household" } : { kind: "device", id: pick(DEVICES) }
          return { c, scope, id: pick(IDS), op: pick(["put", "put", "remove"] as const), value: { text: `t${i}`, ...(chance(0.4) ? { to: pick(["Kitchen", "Guest"]) } : {}) } }
        })
        const events = Array.from({ length: chance(0.5) ? 1 + Math.floor(r() * 3) : 0 }, () => ({ n: n++, scope: pick<ScopeRef>([{ kind: "household" }, { kind: "device", id: "kitchen-01" }, { kind: "device", id: "study-001" }]) }))
        yield* m.transaction((tx) => {
          for (const w of writes) {
            const col = tx.collection(w.c)
            const there = col.get(w.id, { scope: w.scope })
            if (w.op === "remove") col.remove(w.id, { scope: w.scope })
            else if (there !== undefined) col.update(w.id, () => w.value, { scope: w.scope })
            else {
              try {
                col.insert(w.value, { id: w.id, scope: w.scope })
              } catch {
                // The id is taken in the other device's scope.
              }
            }
          }
          for (const e of events) tx.publish("ping", { n: e.n }, e.scope)
        })
        for (const e of events) if (mayRevealScopeTo(e.scope, device())) accepted.push(e.n)
      } else if (what < 0.62) {
        name = name === "Kitchen" ? "Guest" : "Kitchen"
        page.refresh()
      } else if (what < 0.64) {
        page.restart()
        overflowsOrRestarts++
      } else {
        // A slow socket: a few steps only.
        for (let k = Math.floor(r() * 6); k > 0 && page.pending(); k--) for (const msg of page.step()) model.apply(msg)
      }
      if (chance(0.1)) check()
    }
    check()
    return { gaps: model.gaps(), restarts: overflowsOrRestarts, events: accepted.length }
  })

describe("the page queue", () => {
  it.effect("a drained page holds the projection of the committed rows and every event meant for it, unless a gap said otherwise (500 random runs)", () =>
    Effect.gen(function*() {
      let gaps = 0
      let events = 0
      for (let seed = 1; seed <= Number(process.env.PAGE_SEEDS ?? 500); seed++) {
        const out = yield* run(seed, 150)
        gaps += out.gaps
        events += out.events
      }
      // The runs overflowed and restarted, and delivered events.
      assert.isAbove(gaps, 50)
      assert.isAbove(events, 1000)
    }), { timeout: 300_000 })
})
