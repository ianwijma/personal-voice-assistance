// A model-based, randomised test of the module host's interleavings (review round 2): random sequences of triggers
// (configure with shared and with overridable changes, assistant changes, enable and disable, vault lock and unlock,
// requestRestart from instances and shared parts of any generation, failing and slow starts, interrupted callers),
// issued concurrently against a provider and consumers linked by `uses`. After each quiescence the invariants hold:
//
// - no module has two live generations, and two live instances never share a key;
// - every started scope is either published or closed (nothing lingers past the grace period);
// - nothing of a withdrawn part is reachable: the service, the contributions and every tool of the snapshot belong
//   to live parts;
// - every module that should run but does not run as asked has a Health issue;
// - with the faults cleared and one retry, what is published is exactly what the desired state asks (no trigger's
//   change was lost);
// - closing the host closes every scope exactly once, instances before their shared part, consumers before providers.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Schema } from "effect"
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

interface World {
  /** Start ids by part: "prov:s3", "prov:i7"... */
  readonly started: Set<string>
  readonly closed: Array<string>
  /** Live parts, by the registrar's publish and withdraw: handle id → start id. */
  readonly live: Map<number, { readonly sid: string; readonly module: string; readonly kind: "shared" | "instance"; readonly key: string }>
  /** Which shared part an instance was started against. */
  readonly parentOf: Map<string, string>
  readonly restarters: Array<(reason: string) => Effect.Effect<void>>
  readonly faults: { sharedFail: boolean; slow: boolean; readonly instanceFail: Set<string> }
  next: number
  failures: number
}

const newWorld = (): World => ({
  started: new Set(),
  closed: [],
  live: new Map(),
  parentOf: new Map(),
  restarters: [],
  faults: { sharedFail: false, slow: false, instanceFail: new Set() },
  next: 0,
  failures: 0
})

const catalogOf = (w: World) => {
  const sid = (module: string, kind: string) => `${module}:${kind}${++w.next}`
  const opened = (id: string) =>
    Effect.gen(function*() {
      w.started.add(id)
      yield* Effect.addFinalizer(() => Effect.sync(() => void w.closed.push(id)))
      if (w.faults.slow) yield* Effect.sleep(40)
    })
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
        const id = sid("prov", "s")
        yield* opened(id)
        w.restarters.push(host.requestRestart)
        if (w.faults.sharedFail) {
          w.failures++
          return yield* new ModuleStartError({ message: "shared refused" })
        }
        return { value: { address: settings.address ?? "", sid: id }, services: [Svc.of({ address: settings.address ?? "", sid: id })], contributions: [Section.of(id)] }
      }),
    start: ({ host, settings, shared }) =>
      Effect.gen(function*() {
        const id = sid("prov", "i")
        w.parentOf.set(id, (shared as Svc).sid)
        yield* opened(id)
        w.restarters.push(host.requestRestart)
        if (w.faults.instanceFail.has(settings.place)) {
          w.failures++
          return yield* new ModuleStartError({ message: `no ${settings.place}` })
        }
        return { instructions: id, tools: [makeTool({ name: "prov_tool", description: "", parameters: Schema.Struct({}), execute: () => Effect.succeed(id) })] }
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
        const id = sid("cons", "s")
        yield* opened(id)
        w.restarters.push(host.requestRestart)
        return { value: { sid: id } }
      }),
    start: ({ host, shared }) =>
      Effect.gen(function*() {
        const id = sid("cons", "i")
        w.parentOf.set(id, (shared as { readonly sid: string }).sid)
        yield* opened(id)
        w.restarters.push(host.requestRestart)
        return { instructions: id, tools: [makeTool({ name: "cons_tool", description: "", parameters: Schema.Struct({}), execute: () => Effect.succeed(id) })] }
      })
  })
  const solo = defineModule({
    id: "solo",
    name: "Solo",
    description: "",
    enabledByDefault: false,
    enabledWhenSet: "token",
    settings: { token: Setting.secret({ label: "Token" }) },
    start: () =>
      Effect.gen(function*() {
        const id = sid("solo", "i")
        yield* opened(id)
        return { instructions: id, tools: [makeTool({ name: "solo_tool", description: "", parameters: Schema.Struct({}), execute: () => Effect.succeed(id) })] }
      })
  })
  return [cons, prov, solo]
}

/** Observes every part's publication through the registration seam, with the start id the module returned. */
const observer = (w: World): Registrar => ({ handle, instance, shared }) => {
  const sid = shared !== undefined ? (shared.value as { readonly sid: string }).sid : instance?.instructions ?? ""
  return [{
    kind: "model-observer",
    publish: () => void w.live.set(handle.id, { sid, module: handle.moduleId, kind: handle.kind, key: String(handle.id) }),
    withdraw: () => void w.live.delete(handle.id)
  }]
}

interface Assistant {
  prov: boolean
  cons: boolean
  place: string | undefined
}

const settle = Effect.repeat(Effect.yieldNow, { times: 30 })

const runSeed = (seed: number, steps: number) =>
  Effect.gen(function*() {
    const random = rng(seed)
    const pick = <A>(xs: ReadonlyArray<A>): A => xs[Math.floor(random() * xs.length)]!
    const w = newWorld()
    const assistants: Record<string, Assistant> = { a: { prov: false, cons: false, place: undefined }, b: { prov: false, cons: false, place: undefined }, c: { prov: false, cons: false, place: undefined } }
    const demand = () => {
      const out = new Map<string, Array<ModuleDemand>>([["prov", []], ["cons", []]])
      for (const [id, a] of Object.entries(assistants)) {
        if (a.prov) out.get("prov")!.push({ assistantId: id, ...(a.place !== undefined ? { own: { place: a.place } } : {}) })
        if (a.cons) out.get("cons")!.push({ assistantId: id })
      }
      return out
    }
    let unlocked = false
    let soloChosen: boolean | undefined
    const closedBefore = new Set<string>()
    const log: Array<string> = []
    let issuesSeen = 0

    yield* Effect.gen(function*() {
      const host: ModuleHost = yield* makeModuleHost({
        catalog: catalogOf(w),
        persistence: readOnlyPersistence(),
        env: {},
        demand,
        registrars: [observer(w)]
      })
      const fibers: Array<Fiber.Fiber<unknown>> = []
      // A trigger is issued when its fiber begins (it writes the desired state at once); interrupting it later only
      // interrupts its wait.
      const fork = <A>(label: string, effect: Effect.Effect<A>) =>
        Effect.gen(function*() {
          log.push(label)
          // Started at once: it runs up to its first wait (its write is synchronous) before the fork returns.
          fibers.push(yield* Effect.forkChild(effect, { startImmediately: true }))
        })
      yield* fork("startEnabled", host.startEnabled)

      const quiesce = Effect.gen(function*() {
        for (let i = 0; i < 8; i++) {
          yield* settle
          yield* TestClock.adjust(11_000)
        }
        yield* Effect.forEach(fibers, Fiber.await, { discard: true })
        fibers.length = 0
        yield* settle
      })

      /** Invariants that hold after every quiescence, whatever the faults. */
      const checkAlways = (when: string) =>
        Effect.gen(function*() {
          const where = `seed ${seed}, ${when}; ops: ${log.join(" | ")}`
          const live = [...w.live.values()]
          for (const module of ["prov", "cons"]) {
            assert.isAtMost(live.filter((p) => p.module === module && p.kind === "shared").length, 1, `${module}: two live generations (${where})`)
          }
          // Every started scope is published or closed (the grace period is over).
          const closed = new Set(w.closed)
          const liveIds = new Set(live.map((p) => p.sid))
          for (const id of w.started) {
            assert.isTrue(liveIds.has(id) !== closed.has(id), `${id}: ${liveIds.has(id) ? "live and closed" : "neither live nor closed"} (${where})`)
          }
          assert.strictEqual(w.closed.length, closed.size, `a scope closed twice (${where})`)
          // A live instance's shared part is live.
          for (const p of live) {
            if (p.kind !== "instance" || p.module === "solo") continue
            assert.isTrue(liveIds.has(w.parentOf.get(p.sid)!), `${p.sid} is live but its shared part ${w.parentOf.get(p.sid)} is not (${where})`)
          }
          // Nothing of a withdrawn part is reachable.
          const svc = host.service(Svc)
          const provShared = live.find((p) => p.module === "prov" && p.kind === "shared")
          assert.strictEqual(svc?.sid, provShared?.sid, `the service is not the live shared part's (${where})`)
          assert.deepStrictEqual(host.contributionsFor(Section, undefined), provShared === undefined ? [] : [provShared.sid], `contributions (${where})`)
          const snapshot = host.snapshot()
          for (const spec of snapshot.registry.specs) {
            const result = yield* snapshot.registry.run({ id: "x", name: spec.name, input: {} })
            assert.isFalse(result.isError, `${spec.name} failed: ${result.content} (${where})`)
            assert.isTrue(liveIds.has(result.content), `${spec.name} reached ${result.content}, which is not live (${where})`)
          }
          for (const [assistant, parts] of snapshot.assistantParts) {
            for (const part of parts) {
              for (const tool of part.module.tools ?? []) {
                const result = yield* Effect.exit(tool.execute({}))
                assert.isTrue(result._tag === "Success" && liveIds.has(String(result.value)), `${assistant}'s ${tool.name} is not live (${where})`)
              }
            }
          }
          issuesSeen += host.issues.all().length
          // A module that is asked to run but does not run as asked says why.
          for (const m of host.modules()) {
            if (!m.enabled) continue
            const asked = (demand().get(m.id) ?? []).map((d) => d.assistantId)
            const served = new Set((m.instances ?? []).filter((i) => i.state === "running").flatMap((i) => i.assistants))
            const ok = m.state === "running" && (m.instances ?? []).every((i) => i.state === "running") && asked.every((a) => served.has(a))
            if (ok) continue
            const issue = host.issues.all().some((i) => i.module === m.id && (i.id.endsWith(".start") || i.id.endsWith(".restart")))
            assert.isTrue(issue, `${m.id} is ${m.state}, not serving ${asked.filter((a) => !served.has(a)).join(", ") || "as asked"}, without a Health issue (${where})`)
          }
        })

      for (let step = 0; step < steps; step++) {
        const op = Math.floor(random() * 12)
        switch (op) {
          case 0:
            yield* fork("configure address", host.configure("prov", { values: { address: pick(["a1", "a2", "a3"]) }, secrets: {} }))
            break
          case 1:
            yield* fork("configure place", host.configure("prov", { values: { place: pick(["P1", "P2", "P3"]) }, secrets: {} }))
            break
          case 2:
          case 3: {
            const a = assistants[pick(["a", "b", "c"])]!
            const what = pick(["prov", "cons", "place"] as const)
            if (what === "place") a.place = pick([undefined, "P1", "P2", "P3"])
            else a[what] = !a[what]
            yield* fork(`assistants ${JSON.stringify(assistants)}`, host.refresh)
            break
          }
          case 4:
            soloChosen = random() < 0.5
            yield* fork(`solo ${soloChosen}`, soloChosen ? host.enable("solo") : host.disable("solo"))
            break
          case 5:
            unlocked = !unlocked
            yield* fork(`vault ${unlocked ? "unlocked" : "locked"}`, host.setSecrets(unlocked ? { solo: { token: "t" } } : {}))
            break
          case 6:
          case 7:
            if (w.restarters.length > 0) yield* fork("requestRestart", pick(w.restarters)("model"))
            break
          case 8:
            w.faults.sharedFail = random() < 0.3
            log.push(`sharedFail ${w.faults.sharedFail}`)
            break
          case 9: {
            const place = pick(["P1", "P2", "P3"])
            if (w.faults.instanceFail.has(place)) w.faults.instanceFail.delete(place)
            else if (random() < 0.5) w.faults.instanceFail.add(place)
            w.faults.slow = random() < 0.4
            log.push(`instanceFail ${[...w.faults.instanceFail].join(",")} slow ${w.faults.slow}`)
            break
          }
          case 10:
            if (fibers.length > 0) {
              log.push("interrupt a caller")
              yield* Fiber.interrupt(pick(fibers))
            }
            break
          case 11:
            yield* TestClock.adjust(Math.floor(random() * 60))
            break
        }
        yield* Effect.repeat(Effect.yieldNow, { times: Math.floor(random() * 6) })
        if (step % 8 === 7) {
          yield* quiesce
          yield* checkAlways(`after step ${step}`)
        }
      }
      yield* quiesce
      yield* checkAlways("at the end")

      // No change was lost: without faults and after one retry, what is published is what the desired state asks.
      w.faults.sharedFail = false
      w.faults.slow = false
      w.faults.instanceFail.clear()
      yield* fork("startEnabled (retry)", host.startEnabled)
      yield* quiesce
      yield* checkAlways("after the retry")
      const where = `seed ${seed}; ops: ${log.join(" | ")}`
      const live = [...w.live.values()]
      const committed = host.modules().find((m) => m.id === "prov")!.settings.values
      const consOn = Object.values(assistants).some((a) => a.cons)
      const provDirect = Object.values(assistants).filter((a) => a.prov)
      const provRuns = consOn || provDirect.length > 0
      const provShared = live.filter((p) => p.module === "prov" && p.kind === "shared")
      assert.strictEqual(provShared.length, provRuns ? 1 : 0, `prov runs (${where})`)
      if (provRuns) assert.strictEqual(host.service(Svc)?.address, committed.address, `prov runs with the committed address (${where})`)
      const places = new Set(provDirect.map((a) => a.place ?? String(committed.place)))
      const provInstances = live.filter((p) => p.module === "prov" && p.kind === "instance")
      assert.strictEqual(provInstances.length, places.size, `prov's instances (${where})`)
      const shown = (host.modules().find((m) => m.id === "prov")!.instances ?? [])
      assert.deepStrictEqual(new Set(shown.filter((i) => i.state === "running").flatMap((i) => i.assistants)), new Set(Object.entries(assistants).filter(([, a]) => a.prov).map(([id]) => id)), `prov's users (${where})`)
      assert.strictEqual(live.filter((p) => p.module === "cons" && p.kind === "shared").length, consOn ? 1 : 0, `cons runs (${where})`)
      assert.strictEqual(live.filter((p) => p.module === "cons" && p.kind === "instance").length, consOn ? 1 : 0, `cons's instance (${where})`)
      const soloLive = live.filter((p) => p.module === "solo").length
      if (soloChosen !== undefined) assert.strictEqual(soloLive, soloChosen ? 1 : 0, `solo follows its switch (${where})`)
      else if (unlocked) assert.strictEqual(soloLive, 1, `solo runs while its key is set (${where})`)
      for (const id of w.closed) closedBefore.add(id)
    }).pipe(Effect.scoped)

    stats.starts += w.started.size
    stats.closes += w.closed.length
    stats.ops += log.length
    stats.failedStarts += w.failures
    stats.issues += issuesSeen
    // Closing the host closed everything, once, in dependency order.
    const where = `seed ${seed}; ops: ${log.join(" | ")}`
    assert.strictEqual(new Set(w.closed).size, w.closed.length, `a scope closed twice (${where})`)
    for (const id of w.started) assert.include(w.closed, id, `${id} was never closed (${where})`)
    const atShutdown = w.closed.filter((id) => !closedBefore.has(id))
    const position = new Map(w.closed.map((id, i) => [id, i]))
    for (const [instance, parent] of w.parentOf) {
      if (position.has(instance) && position.has(parent)) {
        assert.isBelow(position.get(instance)!, position.get(parent)!, `${instance} closed after its shared part ${parent} (${where})`)
      }
    }
    const lastCons = Math.max(-1, ...atShutdown.filter((id) => id.startsWith("cons")).map((id) => atShutdown.indexOf(id)))
    const firstProv = Math.min(Infinity, ...atShutdown.filter((id) => id.startsWith("prov")).map((id) => atShutdown.indexOf(id)))
    assert.isBelow(lastCons, firstProv, `at shutdown, a consumer closed after its provider (${where})`)
  })

/** How much the seeds exercised (printed with `MODEL_STATS=1`). */
const stats = { starts: 0, closes: 0, failedStarts: 0, issues: 0, ops: 0 }

describe("the module host under random interleavings", () => {
  // `MODEL_SEEDS=2000` runs more (the suite keeps a size that takes a few seconds).
  const seeds = Number(process.env.MODEL_SEEDS ?? 60)
  const first = Number(process.env.MODEL_FIRST_SEED ?? 1)
  it.effect(`${seeds} seeds of 24 triggers each: every invariant after every quiescence`, () =>
    Effect.gen(function*() {
      for (let seed = first; seed < first + seeds; seed++) yield* runSeed(seed, 24)
      if (process.env.MODEL_STATS === "1") console.log(JSON.stringify(stats))
      assert.isAbove(stats.starts, seeds * 3, "the seeds start modules")
      assert.isAbove(stats.failedStarts, 0, "and some starts fail")
    }), { timeout: 120_000 })
})
