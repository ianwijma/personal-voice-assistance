// A model-based, randomised test of the module host (review round 3, finding 19). Random sequences of triggers are
// issued concurrently against a provider, a consumer that `uses` it, and a version 1 module: configure (shared and
// overridable values), assistants switching modules on and off and changing their own values, enable and disable,
// vault lock and unlock, `requestRestart` from parts of any start (stale ones included), tool calls of random
// length, faults (a start that fails, throws a defect, interrupts itself or hangs; a finalizer that hangs),
// interrupted callers, clock jumps, and closing the host at a random moment.
//
// The expected side never reads the host's bookkeeping or uses its functions. It is the test's own model of the
// desired state (what the triggers asked, in the order they were issued), its own reachability through `uses` (the
// consumer brings the provider), its own count of restarts and attempts, and invariants stated independently:
//
// - at no moment has one module two published sets of registrations (checked inside every publish and withdraw);
// - no tool call enters module code of a part that is not published;
// - every scope that was opened is published, closed, or reported as abandoned (a finalizer the test made hang);
// - every module that should run and does not has a Health issue saying why;
// - the worker is alive: a trigger after the sequence completes;
// - with the faults cleared and Check again, what is published is exactly the plan for the final desired state (no
//   trigger's change was lost);
// - closing the host returns within its bound and leaves nothing open that was not reported.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeTool } from "../src/Module.ts"
import { ContributionKey, ServiceKey } from "../src/ModuleApi.ts"
import { defineModule, ModuleStartError } from "../src/ModuleDefinition.ts"
import { type ModuleDemand, type ModuleHost, makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import type { Registrar } from "../src/ModuleRegistrations.ts"
import { Setting } from "../src/Settings.ts"

/** mulberry32: a small seeded generator. */
const rng = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Svc {
  readonly address: string
  readonly sid: string
}
const Svc = ServiceKey<Svc>("model.svc")
const Section = ContributionKey<string>("model.section")

type Mode = "ok" | "fail" | "defect" | "interrupt" | "hang"
const MODES: ReadonlyArray<Mode> = ["ok", "fail", "defect", "interrupt", "hang"]
const MODULES = ["prov", "cons", "solo"] as const
type ModuleId = (typeof MODULES)[number]

/** What the test sees of the world, from module code only. */
interface World {
  readonly opened: Map<string, ModuleId>
  readonly closed: Set<string>
  /** Finalizers that the test made hang, and that were entered. */
  readonly hung: Set<string>
  /** Published parts, by the test registrar: sid → module, and an instance's parent (its shared part's sid). */
  readonly live: Map<string, { readonly module: ModuleId; readonly parent: string | undefined }>
  readonly parentOf: Map<string, string>
  readonly sidOfTool: Map<unknown, string>
  readonly restarters: Array<(reason: string) => Effect.Effect<void>>
  /** The restarter of each shared part of the provider, by its sid. */
  readonly restarterOf: Map<string, (reason: string) => Effect.Effect<void>>
  readonly violations: Array<string>
  readonly faults: { readonly start: Record<ModuleId, Mode>; readonly hangClose: Record<ModuleId, boolean> }
  /** Abandoned closes the host reported, per module (titles seen on the Health page). */
  readonly reported: Record<ModuleId, number>
  next: number
}

const newWorld = (): World => ({
  opened: new Map(),
  closed: new Set(),
  hung: new Set(),
  live: new Map(),
  parentOf: new Map(),
  sidOfTool: new Map(),
  restarters: [],
  restarterOf: new Map(),
  violations: [],
  faults: { start: { prov: "ok", cons: "ok", solo: "ok" }, hangClose: { prov: false, cons: false, solo: false } },
  reported: { prov: 0, cons: 0, solo: 0 },
  next: 0
})

const catalogOf = (w: World) => {
  /** A part's start: its scope's finalizer (which may hang), then its fault. */
  const begin = (module: ModuleId, kind: "s" | "i") =>
    Effect.gen(function*() {
      const id = `${module}:${kind}${++w.next}`
      w.opened.set(id, module)
      const hang = w.faults.hangClose[module]
      yield* Effect.addFinalizer(() =>
        hang
          ? Effect.andThen(Effect.sync(() => void w.hung.add(id)), Effect.never)
          : Effect.sync(() => void w.closed.add(id))
      )
      const mode = w.faults.start[module]
      if (mode === "fail") return yield* new ModuleStartError({ message: `${module} refused` })
      if (mode === "defect") throw new Error(`${module} threw`)
      if (mode === "interrupt") return yield* Effect.interrupt
      if (mode === "hang") return yield* Effect.never
      return id
    })
  const tool = (name: string, id: string) => {
    const t = makeTool({
      name,
      description: "",
      parameters: Schema.Struct({ ms: Schema.Number }),
      execute: ({ ms }) =>
        Effect.gen(function*() {
          if (!w.live.has(id)) w.violations.push(`a call entered ${id}, which is not published`)
          yield* Effect.sleep(ms)
          return id
        })
    })
    w.sidOfTool.set(t, id)
    return t
  }
  const prov = defineModule({
    apiVersion: 2,
    id: "prov",
    name: "Prov",
    description: "",
    settings: {
      address: Setting.text({ label: "Address", default: "a1" }),
      place: Setting.text({ label: "Place", default: "P1", overridable: true })
    },
    shared: ({ host, settings }) =>
      Effect.gen(function*() {
        const id = yield* begin("prov", "s")
        w.restarters.push(host.requestRestart)
        w.restarterOf.set(id, host.requestRestart)
        const address = settings.address ?? ""
        return { value: { address, sid: id }, services: [Svc.of({ address, sid: id })], contributions: [Section.of(id)] }
      }),
    start: ({ host, settings, shared }) =>
      Effect.gen(function*() {
        const id = yield* begin("prov", "i")
        w.parentOf.set(id, (shared as Svc).sid)
        w.restarters.push(host.requestRestart)
        return { instructions: `prov ${settings.place}`, tools: [tool("prov_tool", id)] }
      })
  })
  const cons = defineModule({
    apiVersion: 2,
    id: "cons",
    name: "Cons",
    description: "",
    uses: ["prov"],
    shared: ({ host }) =>
      Effect.gen(function*() {
        const id = yield* begin("cons", "s")
        w.restarters.push(host.requestRestart)
        return { value: { sid: id } }
      }),
    start: ({ host, shared }) =>
      Effect.gen(function*() {
        const id = yield* begin("cons", "i")
        w.parentOf.set(id, (shared as { readonly sid: string }).sid)
        w.restarters.push(host.requestRestart)
        return { instructions: "cons", tools: [tool("cons_tool", id)] }
      })
  })
  const solo = defineModule({
    id: "solo",
    name: "Solo",
    description: "",
    enabledByDefault: false,
    enabledWhenSet: "token",
    settings: { token: Setting.secret({ label: "Token" }) },
    start: () => Effect.map(begin("solo", "i"), (id) => ({ instructions: "solo", tools: [tool("solo_tool", id)] }))
  })
  return [prov, cons, solo]
}

/**
 * The test's registration kind: one per part. Its publish and withdraw check, at that very moment, that the module
 * has one published set of parts: at most one shared part, and every published instance belongs to it.
 */
const witness = (w: World): Registrar => ({ handle, instance, shared }) => {
  const module = handle.moduleId as ModuleId
  const id = shared !== undefined ? (shared.value as { readonly sid: string }).sid : w.sidOfTool.get(instance!.tools![0]!)!
  const parent = shared !== undefined ? undefined : w.parentOf.get(id)
  return [{
    kind: "witness",
    publish: () => {
      for (const [other, part] of w.live) {
        if (part.module !== module) continue
        const sameSet = parent !== undefined && (other === parent || part.parent === parent)
        if (!sameSet) w.violations.push(`${module}: ${id} published beside ${other}, of another start`)
      }
      w.live.set(id, { module, parent })
    },
    withdraw: () => {
      if (!w.live.delete(id)) w.violations.push(`${module}: ${id} withdrawn without being published`)
    }
  }]
}

/** The desired state, as the test issued it. */
interface Model {
  address: string
  placeDefault: string
  readonly assistants: Map<string, { prov: boolean; cons: boolean; own: string | undefined }>
  soloChosen: boolean | undefined
  token: string | undefined
}

const PLACES = ["P1", "P2", "P3"]
const ADDRESSES = ["a1", "a2", "a3"]
const ASSISTANTS = ["x", "y", "z"]

const demandOfModel = (m: Model): ReadonlyMap<string, ReadonlyArray<ModuleDemand>> => {
  const prov: Array<ModuleDemand> = []
  const cons: Array<ModuleDemand> = []
  for (const [id, a] of m.assistants) {
    if (a.prov) prov.push({ assistantId: id, ...(a.own !== undefined ? { own: { place: a.own } } : {}) })
    if (a.cons) cons.push({ assistantId: id })
  }
  return new Map([["prov", prov], ["cons", cons]])
}

/** What should run for the final desired state: the planner's demand, and the instances by effective settings. */
const expectedOf = (m: Model) => {
  const demand = demandOfModel(m)
  const soloOn = m.soloChosen ?? m.token !== undefined
  // The consumer `uses` the provider: wanting the consumer brings the provider (the model's own rule).
  const consRuns = demand.get("cons")!.length > 0
  const reached = new Set([...(demand.get("prov")!.length > 0 || consRuns ? ["prov"] : []), ...(consRuns ? ["cons"] : []), ...(soloOn ? ["solo"] : [])])
  const places = new Map<string, Array<string>>()
  for (const d of demand.get("prov")!) {
    const place = (d.own?.place as string | undefined) ?? m.placeDefault
    places.set(place, [...(places.get(place) ?? []), d.assistantId])
  }
  return {
    running: { prov: reached.has("prov"), cons: reached.has("cons"), solo: reached.has("solo") },
    provInstances: [...places].map(([place, users]) => ({ place, users: users.sort() })).sort((a, b) => a.place.localeCompare(b.place)),
    consUsers: demand.get("cons")!.map((d) => d.assistantId).sort(),
    address: m.address
  }
}

const quiet = Effect.repeat(Effect.yieldNow, { times: 30 })
/** Let time pass in steps (timers of grace periods, start and stop limits, restart intervals). */
const pass = (ms: number) =>
  Effect.gen(function*() {
    for (let left = ms; left > 0; left -= 1_000) {
      yield* quiet
      yield* TestClock.adjust(Math.min(1_000, left))
    }
    yield* quiet
  })

/** Wait for a fiber while letting the test clock run (bounded: a hung worker fails the test). */
const joinWithin = <A>(fiber: Fiber.Fiber<A, unknown>, ms: number, what: string) =>
  Effect.gen(function*() {
    for (let t = 0; t <= ms; t += 1_000) {
      yield* quiet
      const done = fiber.pollUnsafe()
      if (done !== undefined) return done
      yield* TestClock.adjust(1_000)
    }
    return assert.fail(`${what} did not finish within ${ms} ms of test time`)
  })

/** Let time pass until the worker is idle: no module starting or stopping (bounded). */
const settleAll = (host: ModuleHost) =>
  Effect.gen(function*() {
    yield* pass(6_000)
    for (let i = 0; i < 300; i++) {
      if (host.modules().every((m) => m.state !== "starting" && m.state !== "stopping")) {
        yield* pass(6_000)
        if (host.modules().every((m) => m.state !== "starting" && m.state !== "stopping")) return
      }
      yield* pass(1_000)
    }
    assert.fail("the worker never became idle")
  })

const checkInvariants = (w: World, host: ModuleHost, m: Model, label: string) => {
  assert.deepStrictEqual(w.violations, [], `${label}: a module had two published sets, or a call entered an unpublished part`)
  // Every opened scope: published, closed, or its finalizer hung (and the host said so).
  const hungBy: Record<ModuleId, number> = { prov: 0, cons: 0, solo: 0 }
  for (const [sid, module] of w.opened) {
    if (w.live.has(sid) || w.closed.has(sid)) continue
    if (w.hung.has(sid)) {
      hungBy[module]++
      continue
    }
    assert.fail(`${label}: ${sid} was opened and is neither published, closed nor hung (${JSON.stringify(host.modules().map((i) => [i.id, i.state, i.error]))} ${JSON.stringify(host.issues.all().map((i) => i.title))})`)
  }
  for (const module of MODULES) {
    // A hung finalizer of a part whose close the host is still waiting for (at most one per module) is not yet reported.
    assert.isAtLeast(w.reported[module] + 1, hungBy[module], `${label}: ${module}: every abandoned close is reported`)
  }
  // Every module that should run and does not has a Health issue saying why.
  const expected = expectedOf(m)
  for (const info of host.modules()) {
    const should = expected.running[info.id as ModuleId]
    if (!should || info.state === "running") continue
    if (info.state === "starting" || info.state === "stopping") continue
    assert.isTrue(host.issues.all().some((i) => i.module === info.id && i.severity === "error"), `${label}: ${info.id} is ${info.state} without an error on the Health page`)
  }
}

const runSeed = (seed: number, steps: number) =>
  Effect.gen(function*() {
    const random = rng(seed)
    const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(random() * xs.length)]!
    const w = newWorld()
    const m: Model = { address: "a1", placeDefault: "P1", assistants: new Map(ASSISTANTS.map((id) => [id, { prov: false, cons: false, own: undefined }])), soloChosen: undefined, token: undefined }
    let demand = demandOfModel(m)
    const scope = yield* Scope.make()
    const host = yield* makeModuleHost({
      catalog: catalogOf(w),
      persistence: readOnlyPersistence(),
      env: {},
      demand: () => new Map([...demand].filter(([id]) => id !== "solo")),
      registrars: [witness(w)],
      stopTimeoutMs: 2_000,
      startTimeoutMs: 3_000,
      graceMs: 4_000,
      closeTimeoutMs: 20_000
    }).pipe(Scope.provide(scope))
    // Every report of an abandoned close that appears on the Health page, counted once.
    const showing: Record<ModuleId, number> = { prov: 0, cons: 0, solo: 0 }
    host.issues.subscribe(() => {
      for (const module of MODULES) {
        const n = host.issues.all().filter((i) => i.module === module && /did not finish stopping/.test(i.title)).length
        if (n > showing[module]) w.reported[module] += n - showing[module]
        showing[module] = n
      }
    })
    const callers: Array<Fiber.Fiber<unknown, unknown>> = []
    const fork = (effect: Effect.Effect<unknown, unknown>) => Effect.map(Effect.forkChild(effect, { startImmediately: true }), (f) => void callers.push(f))
    yield* fork(host.startEnabled)
    let closedEarly = false
    const snapshots: Array<ReturnType<ModuleHost["snapshot"]>> = []
    for (let step = 0; step < steps; step++) {
      const roll = random()
      if (roll < 0.1) {
        m.address = pick(ADDRESSES)
        yield* fork(host.configure("prov", { values: { address: m.address }, secrets: {} }))
      } else if (roll < 0.17) {
        m.placeDefault = pick(PLACES)
        yield* fork(host.configure("prov", { values: { place: m.placeDefault }, secrets: {} }))
      } else if (roll < 0.32) {
        const a = m.assistants.get(pick(ASSISTANTS))!
        const what = random()
        if (what < 0.4) a.prov = !a.prov
        else if (what < 0.7) a.cons = !a.cons
        else a.own = random() < 0.3 ? undefined : pick(PLACES)
        demand = demandOfModel(m)
        yield* fork(host.refresh)
      } else if (roll < 0.37) {
        m.soloChosen = random() < 0.5
        yield* fork(m.soloChosen ? host.enable("solo") : host.disable("solo"))
      } else if (roll < 0.42) {
        m.token = random() < 0.5 ? undefined : "t"
        yield* fork(host.setSecrets(m.token === undefined ? {} : { solo: { token: m.token } }))
      } else if (roll < 0.5) {
        // A restart from any part ever started: a stopped one's host object answers with a defect.
        if (w.restarters.length > 0) yield* fork(Effect.exit(pick(w.restarters)("random restart")))
      } else if (roll < 0.62) {
        const module = pick(MODULES)
        w.faults.start[module] = random() < 0.5 ? "ok" : pick(MODES)
      } else if (roll < 0.67) {
        const module = pick(MODULES)
        w.faults.hangClose[module] = random() < 0.25
      } else if (roll < 0.77) {
        // A tool call of random length, through the current snapshot or one a turn kept from earlier.
        snapshots.push(host.snapshot())
        const snapshot = random() < 0.5 ? host.snapshot() : pick(snapshots)
        const parts = [...snapshot.parts, ...[...snapshot.assistantParts.values()].flat()]
        const part = parts.length === 0 ? undefined : pick(parts)
        const tool = part?.module.tools?.[0]
        if (tool !== undefined) yield* fork(host.gateway.tool(part!.moduleId, tool, { ms: Math.floor(random() * 6_000) }).pipe(Effect.exit))
      } else if (roll < 0.85) {
        const caller = callers.length === 0 ? undefined : pick(callers)
        if (caller !== undefined) yield* Fiber.interrupt(caller)
      } else if (roll < 0.99) {
        yield* pass(Math.floor(random() * 6_000))
      } else {
        closedEarly = true
        break
      }
      if (step % 8 === 7) {
        yield* settleAll(host)
        checkInvariants(w, host, m, `seed ${seed}, step ${step}`)
      }
    }
    if (!closedEarly) {
      // Before anything else is written: what runs is what the latest desired state asks (a module that is down
      // because of a fault is not judged here; one that runs must not run an older picture).
      yield* settleAll(host)
      const now = expectedOf(m)
      for (const info of host.modules()) {
        if (info.state !== "running") continue
        const module = info.id as ModuleId
        if (module === "solo") {
          if (m.soloChosen !== undefined) assert.strictEqual(m.soloChosen, true, `seed ${seed}: solo runs though it was switched off`)
          continue
        }
        assert.isTrue(now.running[module], `seed ${seed}: ${module} runs though nothing wants it`)
        if (module === "prov") {
          assert.strictEqual(host.service(Svc)?.address, now.address, `seed ${seed}: prov runs an older address`)
          const users = (info.instances ?? []).map((i) => [...i.assistants].sort().join()).sort()
          assert.deepStrictEqual(users, now.provInstances.map((i) => i.users.join()).sort(), `seed ${seed}: prov runs older instances`)
        }
        if (module === "cons") assert.deepStrictEqual((info.instances ?? []).flatMap((i) => [...i.assistants]).sort(), now.consUsers, `seed ${seed}: cons runs older users`)
      }
      // Clear the faults, Check again (it retries every module down after a failed start), and let it settle.
      for (const module of MODULES) {
        w.faults.start[module] = "ok"
        w.faults.hangClose[module] = false
      }
      m.token = "t"
      yield* fork(host.setSecrets({ solo: { token: "t" } }))
      yield* settleAll(host)
      const rechecked = yield* Effect.forkChild(host.recheck)
      yield* joinWithin(rechecked, 120_000, `seed ${seed}: Check again`)
      yield* settleAll(host)
      // The worker is alive: one more trigger completes.
      const alive = yield* Effect.forkChild(host.refresh)
      yield* joinWithin(alive, 60_000, `seed ${seed}: a refresh after the sequence`)
      checkInvariants(w, host, m, `seed ${seed}, final`)
      const expected = expectedOf(m)
      const modules = new Map(host.modules().map((i) => [i.id, i]))
      for (const module of MODULES) {
        assert.strictEqual(modules.get(module)!.state, expected.running[module] ? "running" : "disabled", `seed ${seed}: ${module}'s state`)
      }
      if (expected.running.prov) {
        assert.strictEqual(host.service(Svc)?.address, expected.address, `seed ${seed}: the last configured address runs`)
        const instances = (modules.get("prov")!.instances ?? []).map((i) => ({ users: [...i.assistants].sort() })).sort((a, b) => a.users.join().localeCompare(b.users.join()))
        assert.deepStrictEqual(instances, expected.provInstances.map((i) => ({ users: i.users })).sort((a, b) => a.users.join().localeCompare(b.users.join())), `seed ${seed}: prov's instances`)
        for (const i of expected.provInstances) {
          for (const user of i.users) {
            const part = host.snapshot().assistantParts.get(user)?.find((p) => p.moduleId === "prov")
            assert.strictEqual(part?.instructions, `prov ${i.place}`, `seed ${seed}: ${user} uses the instance of its place`)
          }
        }
      } else assert.strictEqual(host.service(Svc), undefined, `seed ${seed}: no service while prov does not run`)
      if (expected.running.cons) {
        assert.deepStrictEqual((modules.get("cons")!.instances ?? []).flatMap((i) => [...i.assistants]).sort(), expected.consUsers, `seed ${seed}: cons's users`)
      }
      if (expected.running.prov) {
        // A restart asked for by the live shared part: exactly one more attempt of the provider, and a new shared part.
        const shareds = () => [...w.opened.keys()].filter((sid) => sid.startsWith("prov:s")).length
        const live = [...w.live].find(([, part]) => part.module === "prov" && part.parent === undefined)?.[0]
        assert.isDefined(live, `seed ${seed}: prov's shared part is published`)
        const before = shareds()
        yield* w.restarterOf.get(live!)!("the model's restart")
        yield* settleAll(host)
        assert.strictEqual(shareds(), before + 1, `seed ${seed}: one restart is one more attempt`)
        assert.isTrue(w.closed.has(live!) || w.hung.has(live!), `seed ${seed}: the restarted shared part was closed (or its finalizer, made to hang when it opened, entered)`)
        assert.isFalse(w.live.has(live!), `seed ${seed}: and a new one is published instead`)
      }
    }
    // Close the host (at a random moment, or after the sequence): it returns within its bound.
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* joinWithin(closing, 60_000, `seed ${seed}: closing the host`)
    assert.deepStrictEqual(w.violations, [], `seed ${seed}: after close`)
    for (const [sid] of w.opened) {
      if (w.closed.has(sid) || w.hung.has(sid)) continue
      assert.fail(`seed ${seed}: ${sid} is still open after the host closed`)
    }
    assert.strictEqual(w.live.size, 0, `seed ${seed}: everything withdrawn at close`)
    return { opened: w.opened.size, hung: w.hung.size, closedEarly }
  })

describe("the module host under random interleavings", () => {
  const seeds = Number(process.env.MODEL_SEEDS ?? 300)
  const first = Number(process.env.MODEL_FIRST_SEED ?? 1)
  const steps = Number(process.env.MODEL_STEPS ?? 30)
  it.effect(`${seeds} seeds of ${steps} triggers each: every invariant at every quiescence, and the plan at the end`, () =>
    Effect.gen(function*() {
      let opened = 0
      let hung = 0
      let closedEarly = 0
      for (let seed = first; seed < first + seeds; seed++) {
        const r = yield* runSeed(seed, steps)
        opened += r.opened
        hung += r.hung
        if (r.closedEarly) closedEarly++
      }
      if (process.env.MODEL_SEEDS !== undefined) console.log(`model: ${seeds} seeds from ${first}: ${opened} scopes opened, ${hung} finalizers hung, ${closedEarly} hosts closed mid-sequence`)
      assert.isAbove(opened, 0)
    }), { timeout: 600_000 })
})

