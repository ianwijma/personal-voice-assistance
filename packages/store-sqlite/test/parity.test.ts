// The SQLite store and the in-memory double are the same store: random programs of operations and transactions are
// applied to both, and after every step their answers, their errors, what they released to listeners (changes with
// every row's metadata and actor, events), what their hooks did and, at the end, every row of every owner are
// compared. The programs include transactions that throw part-way or catch a store failure and go on, `afterCommit`
// and `onRollback` hooks, functions that return a promise, an Effect or a generator, handles kept past their
// transaction and used later, two-field indexes and orders, redeclared collections (the same shape in another object,
// another shape at the same version, a new version with a migration), a core service's collections, conversation rows
// and their removal, and the numbers SQLite's own JSON parser would not keep. PARITY_SEEDS=n runs more programs.
import { assert, describe, it } from "@effect/vitest"
import { type Collection, CurrentTurn, defineCollection, type HouseholdStore, MAX_LIST_LIMIT, type ModuleStorage, type Released, type Row, type StoreTx, type TurnContext } from "@pva/core"
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
const addPlus = (v: Item) => ({ ...v, text: `${v.text}+`.slice(-40) })
/** The `items` declaration of data version `v` (the same shape at every version; values change by migration). */
const itemsAt = (v: number) =>
  defineCollection({
    name: "items",
    scope: "household",
    schema: Item,
    indexes: ["k", "n", "b", ["k", "n"], ["b", "k"]],
    migrate: Object.fromEntries(Array.from({ length: v - 1 }, (_, i) => [i + 1, addPlus]))
  })
/** Another shape of `items` (fewer indexes): refused at the same version. */
const itemsOtherShape = defineCollection({ name: "items", scope: "household", schema: Item, indexes: ["k"] })
const dev = defineCollection({ name: "dev", scope: "device", schema: Item, indexes: ["k"] })
const loose = defineCollection({ name: "loose", scope: "household", schema: Schema.Unknown })
const chat = defineCollection({ name: "chat", scope: "conversation", schema: Item, indexes: ["k"] })
const Job = Schema.Struct({ state: Schema.String, due: Schema.Unknown })
const jobs = defineCollection({ name: "jobs", scope: "household", schema: Job, indexes: ["state", ["state", "due"]] })
const CORE = [{ owner: "core.p" as const, storage: { collections: [jobs] } }]
const storageOf = (version: number, items: Collection<Item>): ModuleStorage => ({ version, collections: [items, dev, loose, chat] })

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
  "", "a", "B", "b", "é", "é", "😀", "￿", "日本", "a\u0000b", "\ud800", "x\udc00", "x".repeat(500), "x".repeat(501),
  0, -0, 1, -1, 1.5, 2, 10, 1e21, 2 ** 53, 2 ** 53 + 2, -1e-7, 123456789.125,
  // SQLite's JSON parser does not keep these; the store's key columns do.
  1000000000000000100, -1000000000000000100, 58.00995086, 5.82e-11, 3.202449336086709e+291, Number.MIN_VALUE,
  true, false, null, ["a"], { x: 1 }, [], {}
]
const IDS = ["a", "b", "c", "d", "e", "f"]
const BAD_IDS = ["a b", "", "a\u0000", "é"]
const DEVICES = ["kitchen-01", "study-001"]
const CONVERSATIONS = ["conv-a", "conv-b"]

/** What a program's hooks did, per store. */
interface World {
  readonly hooks: Array<string>
  kept: StoreTx | undefined
}
type Op = { readonly name: string; readonly run: (store: HouseholdStore, world: World) => Effect.Effect<unknown, unknown> }
type Step = Op | { readonly name: "tick"; readonly ms: number }

const turnIn = (conversationId: string): TurnContext => ({ turnId: 1, conversationId, source: "voice", deviceId: "kitchen-01" })

const program = (seed: number, steps: number): ReadonlyArray<Step> => {
  const r = random(seed)
  const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(r() * xs.length)]!
  const chance = (p: number) => r() < p
  // What the program has declared (the generator follows it; both stores see the same declarations).
  let version = 1
  let items: Collection<Item> = itemsAt(1)
  const valueOf = (): Record<string, unknown> => {
    const v: Record<string, unknown> = { text: pick(["milk", "eggs", "tea", ""]) }
    for (const f of ["k", "n", "b"]) if (chance(0.6)) v[f] = pick(SCALARS)
    return v
  }
  const idOf = () => (chance(0.05) ? pick(BAD_IDS) : pick(IDS))
  const scopeOf = () => ({ kind: "device" as const, id: chance(0.05) ? "x\u0000y" : pick(DEVICES) })
  const queryOf = (): Record<string, unknown> => {
    const q: Record<string, unknown> = { limit: pick([1, 3, 20, MAX_LIST_LIMIT, MAX_LIST_LIMIT + 1, 0]) }
    const shape = Math.floor(r() * 8)
    if (shape === 1) q.where = { [pick(["k", "n", "b", "text"])]: pick(SCALARS) }
    if (shape === 2) q.orderBy = { field: pick(["k", "n", "b", "createdAt", "updatedAt"]), direction: pick(["asc", "desc"]) }
    if (shape === 3) {
      const f = pick(["k", "n", "b"])
      q.where = { [f]: pick(SCALARS) }
      q.orderBy = { field: pick([f, "updatedAt", "createdAt"]), direction: pick(["asc", "desc"]) }
    }
    if (shape === 4) q.where = { k: pick(SCALARS), n: pick(SCALARS) }
    // Two-field indexes: where k ordered by n, where b ordered by k; and pairs that are not declared.
    if (shape === 5) {
      const [f, g] = pick([["k", "n"], ["b", "k"], ["n", "k"], ["k", "b"]] as const)
      q.where = { [f]: pick(SCALARS) }
      q.orderBy = { field: g, ...(chance(0.5) ? { direction: pick(["asc", "desc"]) } : {}) }
    }
    return q
  }
  /** One write inside a transaction, as a function of the handle and the world (it may throw). */
  const txStep = (): ((tx: StoreTx, world: World) => unknown) => {
    const kind = Math.floor(r() * 10)
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
    const label = `h${Math.floor(r() * 1000)}`
    const filter = pick(SCALARS)
    const it = items
    switch (kind) {
      case 0:
        return (tx) => tx.collection(it).insert(value as Item, { id: withId ? id : freshId }).id.length
      case 1:
        return (tx) => tx.collection(it).update(id, (v) => ({ ...v, ...value }) as Item, opts).rev
      case 2:
        return (tx) => tx.collection(it).remove(id, opts)
      case 3:
        return (tx) => tx.collection(dev).insert(value as Item, { id, scope }).rev
      case 4:
        return (tx) => tx.collection(dev).remove(id, { scope })
      case 5:
        return (tx) => tx.publish(type, { n })
      case 6:
        return (tx, world) => tx.afterCommit(() => world.hooks.push(`after ${label}`))
      case 7:
        return (tx, world) => tx.onRollback(() => world.hooks.push(`undo ${label}`))
      case 8:
        return (tx) => tx.collection(it).list({ where: { k: filter as never }, orderBy: { field: "n" }, limit: 5 }).map((x) => x.id)
      default:
        return (tx) => tx.collection(loose).insert(odd, { id }).rev
    }
  }
  const ops: Array<Step> = []
  for (let i = 0; i < steps; i++) {
    const kind = Math.floor(r() * 18)
    if (chance(0.3)) ops.push({ name: "tick", ms: Math.floor(r() * 3) })
    const id = idOf()
    const value = valueOf()
    const scope = scopeOf()
    const it = items
    switch (kind) {
      case 0:
      case 1: {
        const withId = chance(0.7)
        const fresh = `u${i}`
        ops.push({ name: "insert", run: (s) => s.forModule("p").collection(it).insert(value as Item, { id: withId ? id : fresh }) })
        break
      }
      case 2: {
        const throws = chance(0.1)
        ops.push({
          name: "update",
          run: (s) =>
            s.forModule("p").collection(it).update(id, (v) => {
              if (throws) throw new Error("update bug")
              return { ...v, ...value } as Item
            })
        })
        break
      }
      case 3:
        ops.push({ name: "remove", run: (s) => s.forModule("p").collection(it).remove(id) })
        break
      case 4:
        ops.push({ name: "get", run: (s) => s.forModule("p").collection(it).get(id) })
        break
      case 5:
      case 6: {
        const q = queryOf()
        ops.push({ name: "list", run: (s) => s.forModule("p").collection(it).list(q as never) })
        break
      }
      case 7:
        ops.push({ name: "dev", run: (s) => s.forModule("p").collection(dev).insert(value as Item, { id, scope }) })
        break
      case 8: {
        // A function that does not return a plain value: rolled back whole.
        const how = pick(["promise", "effect", "generator"] as const)
        const v = valueOf()
        ops.push({
          name: `async ${how}`,
          run: (s) =>
            s.forModule("p").transaction(((tx: StoreTx) => {
              tx.collection(it).insert(v as Item, { id: `a${i}` })
              if (how === "promise") return Promise.resolve(1)
              if (how === "effect") return Effect.succeed(1)
              return (function*() {
                yield 1
              })()
            }) as never)
        })
        break
      }
      case 9:
        // Keep a handle past its transaction.
        ops.push({
          name: "keep",
          run: (s, w) =>
            s.forModule("p").transaction((tx) => {
              w.kept = tx
              return 1
            })
        })
        break
      case 10: {
        // Use the kept handle: outside any transaction, or inside a later one (which goes on and commits).
        const inside = chance(0.5)
        const v = valueOf()
        ops.push({
          name: "use kept",
          run: (s, w) =>
            inside
              ? s.forModule("p").transaction((tx) => {
                let refused = "nothing kept"
                try {
                  w.kept?.collection(it).insert(v as Item)
                  refused = w.kept === undefined ? refused : "accepted"
                } catch (e) {
                  refused = `${(e as { _tag?: string })._tag}:${(e as { reason?: string }).reason}`
                }
                tx.collection(it).insert(v as Item, { id: `k${i}` })
                return refused
              })
              : Effect.sync(() => {
                try {
                  w.kept?.collection(it).list()
                  return "accepted"
                } catch (e) {
                  return `${(e as { _tag?: string })._tag}:${(e as { reason?: string }).reason}`
                }
              })
        })
        break
      }
      case 11: {
        // Redeclare: the same shape in another object, another shape at the same version (refused), back to the
        // current one, or a new version with a migration of every row.
        const how = pick(["same", "other shape", "current", "bump"] as const)
        if (how === "bump" && version < 4) {
          version++
          items = itemsAt(version)
        }
        const declared = how === "same" ? itemsAt(version) : how === "other shape" ? itemsOtherShape : items
        const v = version
        ops.push({ name: `redeclare ${how}`, run: (s) => Effect.map(s.prepare([{ id: "p", storage: storageOf(v, declared) }], CORE), () => s.availability("p")?.reason.slice(0, 30) ?? "ok") })
        break
      }
      case 12: {
        // A core service's collection: its own writes, and the host's transaction across a module and it.
        const due = pick(SCALARS)
        const state = pick(["scheduled", "done", ""])
        const both = chance(0.5)
        const fails = chance(0.3)
        ops.push({
          name: "core",
          run: (s) =>
            both
              ? s.transaction((tx) => {
                tx.forCore("core.p").collection(jobs).insert({ state, due }, { id: `j${i}` })
                tx.forModule("p").collection(it).insert(value as Item, { id: `m${i}` })
                if (fails) throw new Error("host part-way")
                return 2
              })
              : s.forCore("core.p").collection(jobs).insert({ state, due }, { id: `j${i}` })
        })
        break
      }
      case 13: {
        const st = pick(["scheduled", "done", "", 5])
        const direction = pick(["asc", "desc"] as const)
        ops.push({ name: "core list", run: (s) => s.forCore("core.p").collection(jobs).list({ where: { state: st as never }, orderBy: { field: "due", direction }, limit: 20 }) })
        break
      }
      case 14: {
        const conv = pick(CONVERSATIONS)
        ops.push({ name: "chat", run: (s) => s.forModule("p").collection(chat).insert(value as Item, { id }).pipe(Effect.provideService(CurrentTurn, turnIn(conv))) })
        break
      }
      case 15: {
        const conv = pick(CONVERSATIONS)
        const sweep = chance(0.3)
        ops.push({ name: sweep ? "sweep" : "end", run: (s) => (sweep ? s.sweepConversations : s.endConversation(conv)) })
        break
      }
      default: {
        const tsteps = Array.from({ length: 1 + Math.floor(r() * 5) }, () => txStep())
        const throwAt = chance(0.35) ? Math.floor(r() * (tsteps.length + 1)) : -1
        const catchFailures = chance(0.4)
        ops.push({
          name: "transaction",
          run: (s, w) =>
            s.forModule("p").transaction((tx) => {
              const out: Array<unknown> = []
              for (const [j, step] of tsteps.entries()) {
                if (j === throwAt) throw new Error("part-way")
                try {
                  out.push(step(tx, w))
                } catch (e) {
                  if (!catchFailures) throw e
                  out.push(`caught ${(e as { _tag?: string })._tag}`)
                }
              }
              if (throwAt === tsteps.length) throw new Error("at the end")
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

const rowOf = (row: Row<unknown> | undefined) =>
  row === undefined ? undefined : { id: row.id, rev: row.rev, scope: row.scope, value: row.value, createdAt: row.createdAt, updatedAt: row.updatedAt, updatedBy: row.updatedBy }

const releasedOf = (r: Released) =>
  r._tag === "change"
    ? { change: r.change.op, module: r.change.module, collection: r.change.collection, id: r.change.id, seq: r.change.seq, rev: r.change.rev, at: r.change.at, scope: r.change.scope, actor: r.change.actor, row: rowOf(r.change.row), before: rowOf(r.change.before) }
    : { event: r.event.type, scope: r.event.scope, data: r.event.data, at: r.event.at, actor: r.event.actor }

/** Every row of every collection and scope, paged through the host's reader (in the reader's order). */
const dump = (s: HouseholdStore, version: () => number) =>
  Effect.sync(() => {
    const rows: Record<string, unknown> = {}
    const all = (owner: string, c: Collection<any>, scope: Parameters<NonNullable<ReturnType<HouseholdStore["reader"]>>["page"]>[0]) => {
      const reader = s.reader(owner, c)
      if (reader === undefined) return `unavailable`
      const out: Array<unknown> = []
      let after: { updatedAt: number; createdAt: number; id: string } | undefined
      for (;;) {
        const page = reader.page(scope, after, MAX_LIST_LIMIT)
        out.push(...page.map(rowOf))
        if (page.length < MAX_LIST_LIMIT) return out
        const last = page.at(-1)!
        after = { updatedAt: last.updatedAt, createdAt: last.createdAt, id: last.id }
      }
    }
    rows.items = all("p", itemsAt(version()), { kind: "household" })
    for (const d of DEVICES) rows[d] = all("p", dev, { kind: "device", id: d })
    for (const c of CONVERSATIONS) rows[c] = all("p", chat, { kind: "conversation", id: c })
    rows.loose = all("p", loose, { kind: "household" })
    rows.jobs = all("core.p", jobs, { kind: "household" })
    rows.seq = Effect.runSync(s.lastSeq)
    rows.availability = s.availability("p")?.reason ?? null
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
    const worlds: [World, World] = [{ hooks: [], kept: undefined }, { hooks: [], kept: undefined }]
    const heard: [Array<unknown>, Array<unknown>] = [[], []]
    for (const [i, s] of [a, b].entries()) {
      yield* s.prepare([{ id: "p", storage: storageOf(1, itemsAt(1)) }], CORE)
      s.onCommit((released) => heard[i]!.push(released.map(releasedOf)))
    }
    let version = 1
    for (const [n, op] of program(seed, steps).entries()) {
      if (op.name === "tick") {
        yield* TestClock.adjust((op as { ms: number }).ms)
        continue
      }
      const o = op as Op
      if (o.name === "redeclare bump") version = Math.min(4, version + 1)
      const ra = outcome(yield* Effect.exit(o.run(a, worlds[0])))
      const rb = outcome(yield* Effect.exit(o.run(b, worlds[1])))
      // Let what an async transaction function left run (it finds its handle dead in both).
      yield* Effect.promise(() => Promise.resolve())
      assert.deepStrictEqual(rb, ra, `seed ${seed}, step ${n} (${o.name}): answers differ: ${JSON.stringify(rb)} vs ${JSON.stringify(ra)}`)
      seen.set(`${o.name} ${kindOf(ra)}`, (seen.get(`${o.name} ${kindOf(ra)}`) ?? 0) + 1)
      assert.deepStrictEqual(heard[1], heard[0], `seed ${seed}, step ${n} (${o.name}): released events differ: ${JSON.stringify(heard[1].at(-1))} vs ${JSON.stringify(heard[0].at(-1))}`)
      assert.deepStrictEqual(worlds[1].hooks, worlds[0].hooks, `seed ${seed}, step ${n} (${o.name}): hooks differ`)
    }
    // Back to the newest declaration (a program may end on a refused shape), then every row.
    for (const s of [a, b]) yield* s.prepare([{ id: "p", storage: storageOf(version, itemsAt(version)) }], CORE)
    assert.deepStrictEqual(yield* dump(b, () => version), yield* dump(a, () => version), `seed ${seed}: rows differ`)
    return heard[0].length
  })

const SEEDS = Number(process.env.PARITY_SEEDS ?? 400)

describe("the SQLite store and the in-memory double stay identical", () => {
  it.effect(`on ${SEEDS} random programs of 80 steps (SQLite in memory)`, () =>
    Effect.gen(function*() {
      let released = 0
      for (let seed = 1; seed <= SEEDS; seed++) released += yield* Effect.scoped(compare(seed, 80, () => makeSqliteStore({ filename: ":memory:" })))
      assert.isAbove(released, SEEDS * 10)
      for (const k of [
        "insert ok", "insert StoreError:invalid", "insert StoreConflict:", "insert StoreError:unavailable",
        "update ok", "update StoreNotFound:", "update StoreError:failed", "update StoreError:invalid",
        "remove ok", "get ok", "list ok:many", "list StoreError:invalid", "dev StoreError:invalid",
        "transaction ok:many", "transaction die", "transaction StoreError:invalid", "transaction StoreConflict:",
        "async promise StoreError:invalid", "async effect StoreError:invalid", "async generator StoreError:invalid",
        "keep ok", "use kept ok", "redeclare same ok", "redeclare bump ok", "core ok", "core die", "core list ok:many",
        "chat ok", "end ok", "sweep ok"
      ]) {
        assert.isAbove(seen.get(k) ?? 0, 0, `no "${k}" in ${JSON.stringify([...seen].sort())}`)
      }
      assert.isTrue([...seen.keys()].some((k) => k.startsWith("redeclare other shape ok")), "a refused shape")
    }), { timeout: 600_000 })

  it.effect("on 25 random programs on a file", () =>
    Effect.gen(function*() {
      for (let seed = 100_001; seed <= 100_025; seed++) {
        const dir = mkdtempSync(join(tmpdir(), "pva-parity-"))
        yield* Effect.scoped(compare(seed, 80, () => makeSqliteStore({ filename: join(dir, "household.db") })))
      }
    }), { timeout: 240_000 })
})
