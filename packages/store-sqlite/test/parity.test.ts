// The SQLite store and the in-memory double are the same store: random sequences of operations and transactions
// (some of which throw part-way, some of which catch a store failure and go on) are applied to both, and after every
// step their answers, their errors, what they released to listeners and, at the end, every row are compared.
import { assert, describe, it } from "@effect/vitest"
import { defineCollection, type HouseholdStore, type Released, type StoreTx } from "@pva/core"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import { Cause, Effect, Exit, Schema } from "effect"
import { TestClock } from "effect/testing"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeSqliteStore } from "../src/index.ts"

const Item = Schema.Struct({
  text: Schema.String,
  k: Schema.optionalKey(Schema.Unknown),
  n: Schema.optionalKey(Schema.Unknown),
  b: Schema.optionalKey(Schema.Unknown)
})
type Item = typeof Item.Type
const items = defineCollection({ name: "items", scope: "household", schema: Item, indexes: ["k", "n", "b"] })
const dev = defineCollection({ name: "dev", scope: "device", schema: Item, indexes: ["k"] })
const loose = defineCollection({ name: "loose", scope: "household", schema: Schema.Unknown })
const MODULES = [{ id: "p", storage: { collections: [items, dev, loose] } }]

/** A small deterministic generator (mulberry32). */
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

const SCALARS: ReadonlyArray<unknown> = [
  "", "a", "B", "b", "é", "é", "😀", "￿", "日本", "a\u0000b", "\ud800", "x\udc00", "x".repeat(500), "x".repeat(501),
  0, -0, 1, -1, 1.5, 2, 10, 1e21, 2 ** 53, -1e-7, 123456789.125,
  true, false, null, ["a"], { x: 1 }, [], {}
]
const IDS = ["a", "b", "c", "d", "e", "f"]
const BAD_IDS = ["a b", "", "a\u0000", "é"]
const DEVICES = ["kitchen-01", "study-001"]

type Op = { readonly name: string; readonly run: (store: HouseholdStore) => Effect.Effect<unknown, unknown> }

const program = (seed: number, steps: number): ReadonlyArray<Op | { readonly name: "tick"; readonly ms: number }> => {
  const r = random(seed)
  const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(r() * xs.length)]!
  const chance = (p: number) => r() < p
  const valueOf = (): Record<string, unknown> => {
    const v: Record<string, unknown> = { text: pick(["milk", "eggs", "tea", ""]) }
    for (const f of ["k", "n", "b"]) if (chance(0.6)) v[f] = pick(SCALARS)
    return v
  }
  const idOf = () => (chance(0.05) ? pick(BAD_IDS) : pick(IDS))
  const scopeOf = () => ({ kind: "device" as const, id: chance(0.05) ? "x\u0000y" : pick(DEVICES) })
  const queryOf = (): Record<string, unknown> => {
    const q: Record<string, unknown> = { limit: pick([1, 3, 100, 1000, 0]) }
    const shape = Math.floor(r() * 6)
    if (shape === 1) q.where = { [pick(["k", "n", "b", "text"])]: pick(SCALARS) }
    if (shape === 2) q.orderBy = { field: pick(["k", "n", "b", "createdAt", "updatedAt"]), direction: pick(["asc", "desc"]) }
    if (shape === 3) {
      const f = pick(["k", "n", "b"])
      q.where = { [f]: pick(SCALARS) }
      q.orderBy = { field: pick([f, "updatedAt", "createdAt"]), direction: pick(["asc", "desc"]) }
    }
    if (shape === 4) q.where = { k: pick(SCALARS), n: pick(SCALARS) }
    return q
  }
  /** One write inside a transaction, as a function of the handle (it may throw). */
  const txStep = (): ((tx: StoreTx) => unknown) => {
    const kind = Math.floor(r() * 7)
    const id = idOf()
    const value = valueOf()
    const scope = scopeOf()
    const expect = chance(0.3) ? Math.floor(r() * 30) : undefined
    const opts = expect === undefined ? {} : { expectRev: expect }
    const withId = chance(0.5)
    const freshId = `t${Math.floor(r() * 1e9)}`
    const type = pick(["stock.low", "Bad Type", "ping"])
    const n = Math.floor(r() * 10)
    const odd = pick([{ a: 1 }, "text", 5, null, [1], { b: "x" }])
    switch (kind) {
      case 0:
        return (tx) => tx.collection(items).insert(value as Item, { id: withId ? id : freshId }).id.length
      case 1:
        return (tx) => tx.collection(items).update(id, (v) => ({ ...v, ...value }) as Item, opts).rev
      case 2:
        return (tx) => tx.collection(items).remove(id, opts)
      case 3:
        return (tx) => tx.collection(dev).insert(value as Item, { id, scope }).rev
      case 4:
        return (tx) => tx.collection(dev).remove(id, { scope })
      case 5:
        return (tx) => tx.publish(type, { n })
      default:
        return (tx) => tx.collection(loose).insert(odd, { id }).rev
    }
  }
  const ops: Array<Op | { readonly name: "tick"; readonly ms: number }> = []
  for (let i = 0; i < steps; i++) {
    const kind = Math.floor(r() * 10)
    if (chance(0.3)) ops.push({ name: "tick", ms: Math.floor(r() * 3) })
    const id = idOf()
    const value = valueOf()
    const scope = scopeOf()
    switch (kind) {
      case 0:
      case 1: {
        const withId = chance(0.7)
        // A fresh id of the program's own (random ids would order ties differently in the two stores).
        const fresh = `u${i}`
        ops.push({ name: "insert", run: (s) => s.forModule("p").collection(items).insert(value as Item, { id: withId ? id : fresh }) })
        break
      }
      case 2: {
        const throws = chance(0.1)
        ops.push({
          name: "update",
          run: (s) =>
            s.forModule("p").collection(items).update(id, (v) => {
              if (throws) throw new Error("update bug")
              return { ...v, ...value } as Item
            })
        })
        break
      }
      case 3:
        ops.push({ name: "remove", run: (s) => s.forModule("p").collection(items).remove(id) })
        break
      case 4:
        ops.push({ name: "get", run: (s) => s.forModule("p").collection(items).get(id) })
        break
      case 5: {
        const q = queryOf()
        ops.push({ name: "list", run: (s) => s.forModule("p").collection(items).list(q as never) })
        break
      }
      case 6:
        ops.push({ name: "dev", run: (s) => s.forModule("p").collection(dev).insert(value as Item, { id, scope }) })
        break
      default: {
        const steps = Array.from({ length: 1 + Math.floor(r() * 5) }, () => txStep())
        const throwAt = chance(0.35) ? Math.floor(r() * (steps.length + 1)) : -1
        const catchFailures = chance(0.4)
        ops.push({
          name: "transaction",
          run: (s) =>
            s.forModule("p").transaction((tx) => {
              const out: Array<unknown> = []
              for (const [i, step] of steps.entries()) {
                if (i === throwAt) throw new Error("part-way")
                try {
                  out.push(step(tx))
                } catch (e) {
                  if (!catchFailures) throw e
                  out.push(`caught ${(e as { _tag?: string })._tag}`)
                }
              }
              if (throwAt === steps.length) throw new Error("at the end")
              return out
            })
        })
      }
    }
  }
  return ops
}

/** An answer as plain JSON: values, or the failure's tag and reason (a defect as such). */
const outcome = (exit: Exit.Exit<unknown, unknown>): unknown => {
  if (Exit.isSuccess(exit)) return { ok: JSON.parse(JSON.stringify(exit.value ?? null)) }
  const fail = exit.cause.reasons.find((x) => x._tag === "Fail") as { error: { _tag?: string; reason?: string } } | undefined
  if (fail !== undefined) return { fail: fail.error._tag, reason: fail.error.reason }
  return { die: Cause.hasDies(exit.cause), ...(process.env.PARITY_DEBUG ? { why: String(Cause.squash(exit.cause)).slice(0, 300) } : {}) }
}

const releasedOf = (r: Released) =>
  r._tag === "change"
    ? { change: r.change.op, id: r.change.id, seq: r.change.seq, rev: r.change.rev, at: r.change.at, scope: r.change.scope, row: r.change.row?.value, before: r.change.before?.value }
    : { event: r.event.type, scope: r.event.scope, data: r.event.data, at: r.event.at }

const dump = (s: HouseholdStore) =>
  Effect.gen(function*() {
    const p = s.forModule("p")
    const rows: Record<string, unknown> = {}
    rows.items = yield* Effect.exit(p.collection(items).list({ limit: 1000, orderBy: { field: "createdAt", direction: "asc" } })).pipe(Effect.map(outcome))
    for (const d of DEVICES) rows[d] = yield* Effect.exit(p.collection(dev).list({ limit: 1000, scope: { kind: "device", id: d } })).pipe(Effect.map(outcome))
    rows.loose = yield* Effect.exit(p.collection(loose).list({ limit: 1000 })).pipe(Effect.map(outcome))
    rows.seq = yield* s.lastSeq
    return rows
  })

/** How often each kind of answer came up (the programs must exercise them all). */
const seen = new Map<string, number>()
const kindOf = (o: unknown) => {
  const x = o as { ok?: unknown; fail?: string; reason?: string; die?: boolean }
  return "ok" in x ? (Array.isArray(x.ok) && x.ok.length > 1 ? "ok:many" : "ok") : x.fail !== undefined ? `${x.fail}:${x.reason ?? ""}` : "die"
}

const compare = (seed: number, steps: number, sqlite: () => Effect.Effect<HouseholdStore, unknown, import("effect").Scope.Scope>) =>
  Effect.gen(function*() {
    const a = makeMemoryHouseholdStore()
    const b = yield* sqlite()
    const heard: [Array<unknown>, Array<unknown>] = [[], []]
    for (const [i, s] of [a, b].entries()) {
      yield* s.prepare(MODULES)
      s.onCommit((released) => heard[i]!.push(released.map(releasedOf)))
    }
    for (const [n, op] of program(seed, steps).entries()) {
      if (op.name === "tick") {
        yield* TestClock.adjust((op as { ms: number }).ms)
        continue
      }
      const o = op as Op
      const ra = outcome(yield* Effect.exit(o.run(a)))
      const rb = outcome(yield* Effect.exit(o.run(b)))
      assert.deepStrictEqual(rb, ra, `seed ${seed}, step ${n} (${o.name}): answers differ: ${JSON.stringify(rb)} vs ${JSON.stringify(ra)}`)
      seen.set(`${o.name} ${kindOf(ra)}`, (seen.get(`${o.name} ${kindOf(ra)}`) ?? 0) + 1)
      assert.deepStrictEqual(heard[1], heard[0], `seed ${seed}, step ${n} (${o.name}): released events differ: ${JSON.stringify(heard[1].at(-1))} vs ${JSON.stringify(heard[0].at(-1))}`)
    }
    assert.deepStrictEqual(yield* dump(b), yield* dump(a), `seed ${seed}: rows differ`)
    return heard[0].length
  })

describe("the SQLite store and the in-memory double stay identical", () => {
  it.effect("on 300 random programs of 80 steps (SQLite in memory)", () =>
    Effect.gen(function*() {
      let released = 0
      for (let seed = 1; seed <= 300; seed++) released += yield* Effect.scoped(compare(seed, 80, () => makeSqliteStore({ filename: ":memory:" })))
      // The programs exercised commits, not only refusals, and every kind of answer.
      assert.isAbove(released, 3000)
      for (const k of ["insert ok", "insert StoreError:invalid", "insert StoreConflict:", "update ok", "update StoreNotFound:", "update StoreError:failed", "update StoreError:invalid", "remove ok", "get ok", "list ok:many", "list StoreError:invalid", "dev StoreError:invalid", "transaction ok:many", "transaction die", "transaction StoreError:invalid", "transaction StoreConflict:"]) {
        assert.isAbove(seen.get(k) ?? 0, 0, `no "${k}" in ${JSON.stringify([...seen])}`)
      }
    }), { timeout: 120_000 })

  it.effect("on 20 random programs on a file", () =>
    Effect.gen(function*() {
      for (let seed = 1001; seed <= 1020; seed++) {
        const dir = mkdtempSync(join(tmpdir(), "pva-parity-"))
        yield* Effect.scoped(compare(seed, 80, () => makeSqliteStore({ filename: join(dir, "household.db") })))
      }
    }), { timeout: 120_000 })
})
