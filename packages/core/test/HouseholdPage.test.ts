// The page queue (`HouseholdPage`) as a property: random commits (puts, updates, removals in a household and a
// device-scoped collection, rows moving in and out of a page's view), module events for this page and for another
// device, device renames (a fresh snapshot), sends that fail (a restart) and slow sockets (a random number of steps
// between commits), with a small queue bound so it overflows. A model page applies what it is sent. Whenever the queue
// is drained: the page holds exactly the projection of the committed rows for its device now; it received every module
// event meant for it, in order, exactly once, except that events accepted before a `household.gap` may be missing:
// after the gap and the final part of the snapshot that follows it, delivery is exact again (every event accepted since
// that final part, and nothing in between missing) until the next gap. The queue never holds more than its bound,
// checked after every operation (never inside a commit listener, whose failures the store swallows).
import { assert, describe, it } from "@effect/vitest"
import type { HouseholdChange } from "@pva/protocol"
import { Effect, Schema } from "effect"
import { connectStoreToBus, defineEventType, makeEventBus } from "../src/EventBus.ts"
import { makeHouseholdFeed, mayRevealScopeTo, projectRow } from "../src/HouseholdFeed.ts"
import { type HouseholdPage, makeHouseholdPage, MAX_QUEUED, type PageMessage } from "../src/HouseholdPage.ts"
import { defineCollection, type Released, type Row, type ScopeRef } from "../src/HouseholdStore.ts"
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

/**
 * A page as a browser would hold it: rows by `collection/id`, the module events it got, the gaps it was told of; and
 * the current epoch: the events received since the final snapshot part after the last gap (all of them before any
 * gap), and how many events had been accepted (`acceptedNow`) when that epoch began.
 */
const modelPage = (acceptedNow: () => number) => {
  let rows = new Map<string, unknown>()
  let incoming = new Map<string, unknown>()
  const events: Array<number> = []
  let gaps = 0
  let gapPending = false
  let epoch: Array<number> = []
  let epochFrom = 0
  const apply = (m: PageMessage) => {
    if (m.type === "household.gap") {
      gaps++
      gapPending = true
    } else if (m.type === "household.snapshot") {
      if (m.part === 0) incoming = new Map()
      for (const c of m.collections) for (const r of c.rows) incoming.set(`${c.collection}/${r.id}`, r.value)
      if (m.final) {
        assert.deepStrictEqual(m.truncated, [])
        rows = incoming
        if (gapPending) {
          gapPending = false
          epoch = []
          epochFrom = acceptedNow()
        }
      }
    } else if (m.event.type.endsWith(".changed")) {
      const ch = m.event.data as HouseholdChange
      if (ch.op === "put") rows.set(`${ch.collection}/${ch.id}`, ch.value)
      else {
        assert.deepStrictEqual(Object.keys(ch).sort(), ["collection", "id", "op"])
        rows.delete(`${ch.collection}/${ch.id}`)
      }
    } else {
      assert.isFalse(gapPending, "a module event between a gap and the final part of its snapshot")
      events.push((m.event.data as { n: number }).n)
      epoch.push((m.event.data as { n: number }).n)
    }
  }
  return { apply, rows: () => rows, events, gaps: () => gaps, epoch: () => epoch, epochFrom: () => epochFrom }
}

/**
 * The events of a drained page against what was accepted: the current epoch is exactly the newest accepted events,
 * from no later than where the epoch began (so every event accepted since then arrived); before any gap, all of them.
 * Everything delivered was accepted, once each, in order.
 */
const checkEvents = (model: ReturnType<typeof modelPage>, accepted: ReadonlyArray<number>, what: string) => {
  const epoch = model.epoch()
  const from = accepted.length - epoch.length
  assert.deepStrictEqual(epoch, accepted.slice(Math.max(0, from)), `${what}: the events since the last gap's snapshot are not the newest accepted, in order`)
  assert.isAtMost(from, model.epochFrom(), `${what}: events accepted after the last gap's snapshot were lost without a gap`)
  if (model.gaps() === 0) assert.deepStrictEqual(model.events, accepted, `${what}: events without a gap`)
  for (let i = 1; i < model.events.length; i++) assert.isBelow(accepted.indexOf(model.events[i - 1]!), accepted.indexOf(model.events[i]!), what)
  for (const e of model.events) assert.include(accepted, e, what)
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
    // Only recorded here: an assertion in a commit listener would be swallowed by the store's dispatcher.
    let largest = 0
    store.onCommit((released) => {
      page.offer(released)
      largest = Math.max(largest, page.size())
    })
    const bounded = (what: string) => {
      largest = Math.max(largest, page.size())
      assert.isAtMost(largest, max, `seed ${seed}: the queue exceeded its bound (${what})`)
    }
    /** Module events meant for this page, in commit order. */
    const accepted: Array<number> = []
    const model = modelPage(() => accepted.length)
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
      checkEvents(model, accepted, `seed ${seed}`)
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
        bounded("a commit")
      } else if (what < 0.62) {
        name = name === "Kitchen" ? "Guest" : "Kitchen"
        page.refresh()
        bounded("a refresh")
      } else if (what < 0.64) {
        page.restart()
        overflowsOrRestarts++
        bounded("a restart")
      } else {
        // A slow socket: a few steps only.
        for (let k = Math.floor(r() * 6); k > 0 && page.pending(); k--) for (const msg of page.step()) model.apply(msg)
        bounded("steps")
      }
      if (chance(0.1)) check()
    }
    check()
    bounded("the end")
    return { gaps: model.gaps(), restarts: overflowsOrRestarts, events: accepted.length }
  })

/** A page fed directly (no store listener): `n` module events for it, in one release each. */
const directPage = (maxQueued?: number) =>
  Effect.gen(function*() {
    const store = makeMemoryHouseholdStore()
    yield* store.prepare([{ id: "m", storage: { collections: [hh] } }])
    const feed = makeHouseholdFeed({ store, modules: [{ moduleId: "m", collections: [hh], events: [ping] }] })
    const page = makeHouseholdPage({ feed, device: () => ({ id: "kitchen-01", name: "Kitchen" }), ...(maxQueued !== undefined ? { maxQueued } : {}) })
    const event = (n: number): ReadonlyArray<Released> => [{ _tag: "event", event: { at: n, module: "m", type: "m.ping", scope: { kind: "household" }, actor: { kind: "module", moduleId: "m" }, data: { n } } }]
    return { page, event }
  })

const drainInto = (page: HouseholdPage, model: ReturnType<typeof modelPage>) => {
  while (page.pending()) for (const msg of page.step()) model.apply(msg)
}

describe("the page queue", () => {
  it.effect("the bound holds across a refresh: a full queue of accepted events, then a fresh snapshot, keeps every event within MAX_QUEUED; one more overflows with a gap", () =>
    Effect.gen(function*() {
      const { page, event } = yield* directPage()
      const accepted: Array<number> = []
      const model = modelPage(() => accepted.length)
      drainInto(page, model)
      // The most events that fit with room kept for a snapshot.
      for (let n = 0; n < MAX_QUEUED - 1; n++) {
        page.offer(event(n))
        accepted.push(n)
      }
      assert.strictEqual(page.size(), MAX_QUEUED - 1)
      page.refresh()
      assert.strictEqual(page.size(), MAX_QUEUED)
      drainInto(page, model)
      assert.strictEqual(model.gaps(), 0)
      checkEvents(model, accepted, "full queue, then a refresh")
      // One more than fits: the queue overflows, and says so.
      for (let n = MAX_QUEUED; n < 2 * MAX_QUEUED; n++) {
        page.offer(event(n))
        accepted.push(n)
        assert.isAtMost(page.size(), MAX_QUEUED)
      }
      page.refresh()
      assert.isAtMost(page.size(), MAX_QUEUED)
      drainInto(page, model)
      assert.strictEqual(model.gaps(), 1)
      checkEvents(model, accepted, "an overflow")
    }))

  it.effect("after a gap and its snapshot, delivery is exact again: events accepted then and dropped silently fail the check (shown on a page that drops them)", () =>
    Effect.gen(function*() {
      const sequence = (broken: boolean) =>
        Effect.gen(function*() {
          const { page: real, event } = yield* directPage(20)
          // The broken page drops every module event after the snapshot that follows a gap, and says nothing.
          let afterGap = false
          let gapSeen = false
          const page: HouseholdPage = {
            ...real,
            step: () =>
              real.step().filter((m) => {
                if (m.type === "household.gap") gapSeen = true
                if (m.type === "household.snapshot" && m.final && gapSeen) afterGap = true
                return !(broken && afterGap && m.type === "household.event")
              })
          }
          const accepted: Array<number> = []
          const model = modelPage(() => accepted.length)
          drainInto(page, model)
          let n = 0
          // A gap (a restart), its snapshot drained.
          page.offer(event(n))
          accepted.push(n++)
          page.restart()
          drainInto(page, model)
          // Three events accepted after it.
          for (let i = 0; i < 3; i++) {
            page.offer(event(n))
            accepted.push(n++)
          }
          drainInto(page, model)
          checkEvents(model, accepted, broken ? "broken page" : "page")
        })
      yield* sequence(false)
      const broken = yield* Effect.exit(sequence(true))
      assert.isTrue(broken._tag === "Failure", "the check must fail for a page that drops events after a gap's snapshot")
    }))

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
