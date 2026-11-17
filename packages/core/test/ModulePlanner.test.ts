// The module host's decisions as pure functions (docs/ARCHITECTURE.md "Module host: the reconciler"), tested with a
// table of cases: what to start, keep, retire, and when a failed start is not tried again.
import { describe, expect, it } from "vitest"
import { type Failure, type InstanceTarget, isEmptyPlan, type ModuleCurrent, type ModulePlan, type ModuleTarget, planModule, reachedBy, usesOrder } from "../src/ModulePlanner.ts"

const inst = (key: string, users: Array<string> = [], fingerprint = `fp-${key}`, invalid?: string): InstanceTarget => ({
  key,
  users,
  ownKeys: [],
  invalid,
  fingerprint
})
const target = (instances: Array<InstanceTarget>, shared?: { key: string; fingerprint: string }, runs = true): ModuleTarget => ({
  id: "m",
  runs,
  shared: shared === undefined ? undefined : { ...shared, invalid: undefined },
  instances
})
const current = (
  generation: string | undefined,
  instances: Record<string, { fingerprint: string; users?: Array<string> }>,
  extra: { failedGeneration?: Failure; failedInstances?: Record<string, Failure>; retry?: number } = {}
): ModuleCurrent => ({
  generation,
  instances: new Map(Object.entries(instances).map(([k, v]) => [k, { fingerprint: v.fingerprint, users: v.users ?? [] }])),
  failedGeneration: extra.failedGeneration,
  failedInstances: new Map(Object.entries(extra.failedInstances ?? {})),
  retry: extra.retry ?? 0
})
const summary = (plan: ModulePlan) => ({
  generation: plan.generation?.fingerprint,
  start: plan.start.map((i) => i.key),
  retire: [...plan.retire],
  stop: plan.stop,
  keep: plan.keep.map((k) => `${k.key}:${k.users.join("+")}`),
  kept: plan.kept
})

describe("planModule", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly target: ModuleTarget; readonly current: ModuleCurrent; readonly plan: ReturnType<typeof summary> }> = [
    {
      name: "not running, nothing published: nothing",
      target: target([], undefined, false),
      current: current(undefined, {}),
      plan: { generation: undefined, start: [], retire: [], stop: false, keep: [], kept: false }
    },
    {
      name: "should not run: everything retired, the shared part too",
      target: target([], undefined, false),
      current: current("g1", { a: { fingerprint: "x" } }),
      plan: { generation: undefined, start: [], retire: ["a"], stop: true, keep: [], kept: false }
    },
    {
      name: "a first generation: the shared part and every instance, together",
      target: target([inst("a"), inst("b")], { key: "k", fingerprint: "g1" }),
      current: current(undefined, {}),
      plan: { generation: "g1", start: ["a", "b"], retire: [], stop: false, keep: [], kept: false }
    },
    {
      name: "a changed shared setting: a new generation with every instance; all published ones are replaced",
      target: target([inst("a", ["x"], "fa2")], { key: "k2", fingerprint: "g2" }),
      current: current("g1", { a: { fingerprint: "fa1", users: ["x"] } }),
      plan: { generation: "g2", start: ["a"], retire: ["a"], stop: false, keep: [], kept: false }
    },
    {
      name: "that generation failed at this retry: the old one is kept, with the assistants still on it",
      target: target([inst("a2", ["x"], "fa2")], { key: "k2", fingerprint: "g2" }),
      current: current("g1", { a: { fingerprint: "fa1", users: ["x", "y"] }, b: { fingerprint: "fb1", users: ["z"] } }, {
        failedGeneration: { fingerprint: "g2", retry: 3, message: "no" },
        retry: 3
      }),
      plan: { generation: undefined, start: [], retire: ["b"], stop: false, keep: ["a:x"], kept: true }
    },
    {
      name: "the retry counter moved on: the failed generation is tried again",
      target: target([inst("a2", ["x"], "fa2")], { key: "k2", fingerprint: "g2" }),
      current: current("g1", { a: { fingerprint: "fa1", users: ["x"] } }, { failedGeneration: { fingerprint: "g2", retry: 3, message: "no" }, retry: 4 }),
      plan: { generation: "g2", start: ["a2"], retire: ["a"], stop: false, keep: [], kept: false }
    },
    {
      name: "within the generation: an unchanged instance is kept with its new users, a new one starts, a gone one retires",
      target: target([inst("a", ["x", "y"], "fa"), inst("c", ["z"], "fc")], { key: "k", fingerprint: "g1" }),
      current: current("g1", { a: { fingerprint: "fa", users: ["x"] }, b: { fingerprint: "fb", users: ["z"] } }),
      plan: { generation: undefined, start: ["c"], retire: ["b"], stop: false, keep: ["a:x+y"], kept: false }
    },
    {
      name: "a restart counter (or configured secret) moved: the instance starts again and keeps serving until then",
      target: target([inst("a", ["x"], "fa-restart1")], { key: "k", fingerprint: "g1" }),
      current: current("g1", { a: { fingerprint: "fa", users: ["x"] } }),
      plan: { generation: undefined, start: ["a"], retire: [], stop: false, keep: [], kept: false }
    },
    {
      name: "that restart failed at this retry: the running one is kept",
      target: target([inst("a", ["x"], "fa-restart1")], { key: "k", fingerprint: "g1" }),
      current: current("g1", { a: { fingerprint: "fa", users: ["x"] } }, { failedInstances: { a: { fingerprint: "fa-restart1", retry: 0, message: "no" } } }),
      plan: { generation: undefined, start: [], retire: [], stop: false, keep: ["a:x"], kept: false }
    },
    {
      name: "a new instance that failed at this retry is not tried again",
      target: target([inst("a", ["x"], "fa"), inst("b", ["y"], "fb")]),
      current: current(undefined, { a: { fingerprint: "fa", users: ["x"] } }, { failedInstances: { b: { fingerprint: "fb", retry: 2, message: "no" } }, retry: 2 }),
      plan: { generation: undefined, start: [], retire: [], stop: false, keep: ["a:x"], kept: false }
    },
    {
      name: "without a shared part: instances only (version 1)",
      target: target([inst("a", [], "fa2")]),
      current: current(undefined, { old: { fingerprint: "f-old" } }),
      plan: { generation: undefined, start: ["a"], retire: ["old"], stop: false, keep: [], kept: false }
    },
    {
      name: "a shared-only provider (demanded through `uses`): a generation with no instances",
      target: target([], { key: "k", fingerprint: "g1" }),
      current: current(undefined, {}),
      plan: { generation: "g1", start: [], retire: [], stop: false, keep: [], kept: false }
    }
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(summary(planModule(c.target, c.current))).toEqual(c.plan)
    })
  }

  it("a fixpoint: once published as planned, the planner asks for nothing", () => {
    const t = target([inst("a", ["x"], "fa"), inst("b", ["y"], "fb")], { key: "k", fingerprint: "g1" })
    const published = current("g1", { a: { fingerprint: "fa", users: ["x"] }, b: { fingerprint: "fb", users: ["y"] } })
    expect(isEmptyPlan(planModule(t, published), published)).toBe(true)
    const moved = current("g1", { a: { fingerprint: "fa", users: ["y"] }, b: { fingerprint: "fb", users: ["y"] } })
    expect(isEmptyPlan(planModule(t, moved), moved)).toBe(false)
  })
})

describe("reachedBy and usesOrder", () => {
  it("demand reaches through `uses`, transitively; a blocked module is reached but passes nothing on", () => {
    const nodes = [
      { id: "a", wanted: true, blocked: false, uses: ["b"] },
      { id: "b", wanted: false, blocked: false, uses: ["c"] },
      { id: "c", wanted: false, blocked: false, uses: [] },
      { id: "d", wanted: true, blocked: true, uses: ["e"] },
      { id: "e", wanted: false, blocked: false, uses: [] },
      { id: "f", wanted: false, blocked: false, uses: ["a"] }
    ]
    expect([...reachedBy(nodes)].sort()).toEqual(["a", "b", "c", "d"])
  })

  it("providers come before the modules that use them; otherwise catalogue order; a cycle keeps its order", () => {
    expect(usesOrder([{ id: "a", uses: ["c"] }, { id: "b", uses: [] }, { id: "c", uses: ["b"] }], new Set())).toEqual(["b", "c", "a"])
    expect(usesOrder([{ id: "x", uses: ["y"] }, { id: "y", uses: ["x"] }, { id: "z", uses: [] }], new Set(["x", "y"]))).toEqual(["x", "y", "z"])
  })
})
