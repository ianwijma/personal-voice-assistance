// The module host's pure planner (docs/ARCHITECTURE.md "Module host"): one table of cases, each a target (what the
// desired state asks) and what runs now, with the plan expected. Stop before start; a failed attempt is not tried
// again until something in its attempt key changes; it is forgotten when the module should not run.
import { describe, expect, it } from "vitest"
import { type ModuleCurrent, type ModulePlan, type ModuleTarget, planModule, reachedBy, usesOrder } from "../src/ModulePlanner.ts"

const target = (fingerprint: string, extra: Partial<ModuleTarget> = {}): ModuleTarget => ({
  id: "m",
  runs: true,
  invalid: undefined,
  instances: [{ key: "k", users: ["a"], ownKeys: [], invalid: undefined }],
  fingerprint,
  attempt: `${fingerprint}/0`,
  ...extra
})
const off: ModuleTarget = { id: "m", runs: false, invalid: undefined, instances: [], fingerprint: "", attempt: "" }
const now = (running?: string, failed?: string): ModuleCurrent => ({ running, failed })
const plan = (p: Partial<Omit<ModulePlan, "id">>): ModulePlan => ({ id: "m", stop: false, start: false, keep: false, forget: false, ...p })

const cases: ReadonlyArray<{ readonly name: string; readonly target: ModuleTarget; readonly current: ModuleCurrent; readonly plan: ModulePlan }> = [
  { name: "should not run, nothing runs: forget any failure", target: off, current: now(), plan: plan({ forget: true }) },
  { name: "should not run, it runs: stop it, forget any failure", target: off, current: now("f1"), plan: plan({ stop: true, forget: true }) },
  { name: "should not run after a failure: the failure is forgotten (a new demand tries again)", target: off, current: now(undefined, "f1/0"), plan: plan({ forget: true }) },
  { name: "nothing runs: start it", target: target("f1"), current: now(), plan: plan({ start: true }) },
  { name: "what runs is what should run: keep it (users may move)", target: target("f1"), current: now("f1"), plan: plan({ keep: true }) },
  { name: "something else runs: stop it, then start the target", target: target("f2"), current: now("f1"), plan: plan({ stop: true, start: true }) },
  { name: "that very attempt failed: stay down", target: target("f1"), current: now(undefined, "f1/0"), plan: plan({}) },
  { name: "the attempt key changed since (vault, probes, retry, settings): try again", target: target("f1", { attempt: "f1/1" }), current: now(undefined, "f1/0"), plan: plan({ start: true }) },
  {
    name: "settings not valid: stop what runs, start nothing",
    target: target("f2", { invalid: "The settings are not valid: x" }),
    current: now("f1"),
    plan: plan({ stop: true })
  },
  { name: "settings not valid, nothing runs: nothing", target: target("f2", { invalid: "x" }), current: now(), plan: plan({}) },
  {
    // Review round 5 (p1-r5a finding 2): settings that cannot be read can leave the fingerprint as it was.
    name: "settings not valid at the very fingerprint that runs: stop it, start nothing (never kept)",
    target: target("f1", { invalid: "The settings could not be read" }),
    current: now("f1"),
    plan: plan({ stop: true })
  },
  {
    name: "a restart (its counter is in the fingerprint): stop, then start",
    target: target("[\"s\",[\"k\"],0,1]"),
    current: now("[\"s\",[\"k\"],0,0]"),
    plan: plan({ stop: true, start: true })
  }
]

describe("planModule", () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(planModule(c.target, c.current)).toEqual(c.plan)
    })
  }

  it("a fixpoint: once the target runs, the planner asks for nothing but keeping it", () => {
    for (const c of cases) {
      if (!c.plan.start) continue
      expect(planModule(c.target, now(c.target.fingerprint))).toEqual(plan({ keep: true }))
    }
  })

  it("never asks to start while something runs without stopping it first (no two of a module)", () => {
    for (const c of cases) {
      const p = planModule(c.target, c.current)
      if (p.start && c.current.running !== undefined) expect(p.stop).toBe(true)
      if (p.keep) expect(p.stop || p.start).toBe(false)
    }
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
