// The worst legal `list` (docs/STORING-DATA.md "Lists" and "Latency"): structured values at the three ends of the list
// rule (rows × maxChars within LIST_BUDGET_CHARS) on both stores, the first call after a start and later ones. Alone in
// its file, so the worker that runs it has decoded none of these schemas before (vitest isolates each file): the first
// call after `prepare` is timed as it is after a restart of the server. The numbers are printed.
import { assert, describe, it } from "@effect/vitest"
import { type Collection, DEFAULT_MAX_CHARS, defineCollection, type HouseholdStore, LIST_BUDGET_CHARS, MAX_LIST_LIMIT, MAX_VALUE_CHARS, maxListRows } from "@pva/core"
import { makeMemoryHouseholdStore } from "@pva/core/testing"
import { Effect, Schema } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { makeSqliteStore } from "../src/index.ts"
import { bound } from "./latencyBound.ts"

/**
 * The worst legal lists: structured values filling `maxChars` exactly, `maxListRows` of them, at the three ends of the
 * list rule (the most rows, of the smallest values that still give MAX_LIST_LIMIT rows; the default maxChars; the
 * largest maxChars). The shapes are the costliest ordinary built-in schemas found to decode (docs/STORING-DATA.md
 * "Lists"): arrays of small objects, arrays of numbers, Sol's array of an untagged union of four struct shapes (every
 * element matching the last one), and an array of nested structs whose fields are all optional, literal unions among
 * them (every element `{}`). `make` gives fresh schemas each time, so a store that has never decoded them can be timed.
 */
const shapes = {
  "objects": { element: () => Schema.Struct({ x: Schema.Finite }), instance: { x: 0 } },
  "numbers": { element: () => Schema.Finite, instance: 0 },
  "an untagged union of four structs": {
    element: () => Schema.Union([Schema.Struct({ x: Schema.String }), Schema.Struct({ x: Schema.Boolean }), Schema.Struct({ x: Schema.Null }), Schema.Struct({ x: Schema.Finite })]),
    instance: { x: 0 }
  },
  "optional fields and literal unions in nested structs": {
    element: () =>
      Schema.Struct({
        state: Schema.optionalKey(Schema.Literals(["on", "off", "idle", "gone"])),
        n: Schema.optional(Schema.Finite),
        detail: Schema.optionalKey(Schema.Struct({ kind: Schema.optionalKey(Schema.Literals(["a", "b", "c"])), on: Schema.optionalKey(Schema.Boolean) }))
      }),
    instance: {}
  }
} as const
const listEnds = [Math.floor(LIST_BUDGET_CHARS / MAX_LIST_LIMIT), DEFAULT_MAX_CHARS, MAX_VALUE_CHARS]
const listFixtures = () =>
  listEnds.flatMap((maxChars) =>
    Object.entries(shapes).map(([what, shape], k) => {
      const c = defineCollection({ name: `shape${k}_${maxChars}`, scope: "household", schema: Schema.Struct({ tag: Schema.String, values: Schema.Array(shape.element()) }), indexes: ["tag"], maxChars })
      const element = JSON.stringify(shape.instance)
      return { what, maxChars, c: c as unknown as Collection<unknown>, value: () => fillTo(maxChars, element, (n) => ({ tag: "t", values: Array.from({ length: n }, () => structuredClone(shape.instance)) })) }
    })
  )
/** The largest value of the shape `make(n)` whose JSON fits `maxChars` (each element `element` plus a comma). */
const fillTo = <A>(maxChars: number, element: string, make: (n: number) => A): A => {
  const base = JSON.stringify(make(0)).length
  const value = make(Math.floor((maxChars - base + 1) / (element.length + 1)))
  if (JSON.stringify(value).length > maxChars) throw new Error("fixture too large")
  return value
}


/** The worst of `n` calls. */
const worstOf = (n: number, effect: Effect.Effect<unknown, unknown>) =>
  Effect.gen(function*() {
    let worst = 0
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      yield* effect
      worst = Math.max(worst, performance.now() - t0)
    }
    return worst
  })

/**
 * The rows written straight into the file, in the store's own format (the JSON of each value, which for these shapes
 * is the value; the indexed `tag` in k0), so nothing in this process has encoded or decoded them before the timed store.
 */
const fillFile = (file: string, fixtures: ReturnType<typeof listFixtures>) => {
  const db = new DatabaseSync(file)
  const doc = db.prepare(`INSERT INTO pva_docs (owner, collection, id, scope_kind, scope_id, rev, value, created_at, updated_at, updated_by, k0)
    VALUES ('lists', ?, ?, 'household', '', ?, ?, ?, ?, '{"kind":"system","name":"fill"}', 't')`)
  let rev = 0
  db.exec("BEGIN")
  for (const f of fixtures) {
    const text = JSON.stringify(f.value())
    for (let i = 0; i < maxListRows(f.c); i++) {
      rev++
      doc.run(f.c.name, `r${i}`, rev, text, rev, rev)
    }
  }
  db.prepare("UPDATE pva_meta SET value = ? WHERE key = 'rev'").run(String(rev))
  db.exec("COMMIT")
  db.close()
}

describe("the worst legal list", () => {
  it.live("on both stores: structured values at the three ends of the list rule (rows × maxChars ≤ LIST_BUDGET_CHARS) block the main thread under 10 ms, the first call after a start as well as later ones", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "pva-list-"))
      const file = join(dir, "household.db")
      // SQLite: the collections are made by a store that is then closed, their rows written into the file, and a
      // fresh store prepared (a start of the server, which warms what a first read would compile) is timed.
      const declared = listFixtures()
      yield* Effect.scoped(Effect.gen(function*() {
        const store = yield* makeSqliteStore({ filename: file })
        yield* store.prepare([{ id: "lists", storage: { collections: declared.map((f) => f.c) } }])
      }))
      fillFile(file, declared)
      const sqlite = yield* makeSqliteStore({ filename: file })
      const timedSqlite = listFixtures()
      yield* sqlite.prepare([{ id: "lists", storage: { collections: timedSqlite.map((f) => f.c) } }])
      const results: Array<string> = []
      let worstCold = 0
      let worstWarm = 0
      const time = (kind: string, store: HouseholdStore, fixtures: ReturnType<typeof listFixtures>) =>
        Effect.gen(function*() {
          for (const f of fixtures) {
            const rows = maxListRows(f.c)
            assert.isAtMost(rows * f.maxChars, LIST_BUDGET_CHARS)
            const list = store.forModule("lists").collection(f.c).list({ where: { tag: "t" }, limit: rows })
            // Blocked time: the call is synchronous, so its duration is how long the main thread is held.
            const t0 = performance.now()
            const first = yield* list
            const cold = performance.now() - t0
            assert.strictEqual(first.length, rows)
            assert.deepStrictEqual(first[0]!.value, f.value())
            const warm = yield* worstOf(30, list)
            worstCold = Math.max(worstCold, cold)
            worstWarm = Math.max(worstWarm, warm)
            results.push(`${kind}: ${rows} rows of ${f.what} at maxChars ${f.maxChars} (${JSON.stringify(first[0]!.value).length} characters each): first ${cold.toFixed(2)} ms, then worst ${warm.toFixed(2)} ms`)
          }
        })
      yield* time("SQLite", sqlite, timedSqlite)
      // In memory (no file, no start): written by the store that is timed.
      const memory = makeMemoryHouseholdStore()
      const timedMemory = listFixtures()
      yield* memory.prepare([{ id: "lists", storage: { collections: timedMemory.map((f) => f.c) } }])
      for (const f of timedMemory) {
        const value = f.value()
        yield* memory.forModule("lists").transaction((tx) => {
          for (let i = 0; i < maxListRows(f.c); i++) tx.collection(f.c).insert(value)
        })
      }
      yield* time("in memory", memory, timedMemory)
      console.log(`Household store, the worst legal list (LIST_BUDGET_CHARS ${LIST_BUDGET_CHARS}; the first call after prepare, then the worst of 30):\n  ${results.join("\n  ")}`)
      assert.isBelow(worstCold, bound(10))
      assert.isBelow(worstWarm, bound(10))
    }).pipe(Effect.scoped), { timeout: 120_000 })
})
