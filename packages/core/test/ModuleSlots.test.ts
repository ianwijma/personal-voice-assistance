// Review round 4 of PR 90: route handlers and "Test" presses run in slots of their module (`ModuleSlots`). A slot is
// taken before the code starts and given back exactly once, when its fiber has really ended; the answer never waits
// for cleanup (the first of result, deadline, stop signal, caller interruption).
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { defineModule } from "../src/ModuleDefinition.ts"
import { makeModuleHost, readOnlyPersistence } from "../src/ModuleHost.ts"
import { makeModuleSlots, MAX_PRESS_SLOTS, MAX_ROUTE_SLOTS } from "../src/ModuleSlots.ts"
import { Setting } from "../src/Settings.ts"

const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

/** Work that never answers and, asked to stop, cleans up for `cleanupMs`; `active` counts it from start to end of cleanup. */
const slow = (probe: { active: number; max: number; cleaned: number }, cleanupMs: number) =>
  Effect.suspend(() => {
    probe.active++
    probe.max = Math.max(probe.max, probe.active)
    return Effect.never.pipe(
      Effect.onInterrupt(() => Effect.sleep(cleanupMs)),
      Effect.ensuring(Effect.sync(() => {
        probe.active--
        probe.cleaned++
      }))
    )
  })

describe("ModuleSlots", () => {
  it("the caps", () => {
    assert.strictEqual(MAX_ROUTE_SLOTS, 16)
    assert.strictEqual(MAX_PRESS_SLOTS, 4)
  })

  it.effect("a slot is given back exactly once, after its fiber has ended, whatever ended the wait (deadline, then stop, then the caller)", () =>
    Effect.gen(function*() {
      const reports: Array<boolean> = []
      const slots = makeModuleSlots({ cap: 2, report: (_id, full) => reports.push(full) })
      const probe = { active: 0, max: 0, cleaned: 0 }
      const stop = Deferred.makeUnsafe<void>()
      // Times out, then is stopped too, then its caller would go: one slot, given back once.
      const first = yield* Effect.forkChild(slots.run("m", slow(probe, 1_000), { timeoutMs: 100, stopped: Deferred.await(stop) }))
      yield* advance(100)
      assert.deepStrictEqual(yield* Fiber.join(first), { _tag: "timeout" })
      assert.strictEqual(slots.taken("m"), 1)
      Deferred.doneUnsafe(stop, Effect.void)
      yield* advance(10)
      assert.strictEqual(slots.taken("m"), 1)
      // A second one, cancelled by its caller.
      const caller = yield* Effect.forkChild(slots.run("m", slow(probe, 1_000), { timeoutMs: 10_000 }))
      yield* advance(10)
      yield* Fiber.interrupt(caller)
      assert.strictEqual(slots.taken("m"), 2)
      // At the cap: refused before any code runs, reported once.
      assert.deepStrictEqual(yield* slots.run("m", Effect.sync(() => assert.fail("must not run")), { timeoutMs: 10 }), { _tag: "full" })
      assert.deepStrictEqual(yield* slots.run("m", Effect.sync(() => assert.fail("must not run")), { timeoutMs: 10 }), { _tag: "full" })
      assert.deepStrictEqual(reports, [true])
      // Another module is not affected.
      const other = yield* slots.run("other", Effect.succeed(1), { timeoutMs: 10 })
      assert.isTrue(other._tag === "done" && Exit.isSuccess(other.exit) && other.exit.value === 1)
      yield* advance(1_000)
      assert.strictEqual(probe.cleaned, 2)
      assert.strictEqual(slots.taken("m"), 0)
      assert.deepStrictEqual(reports, [true, false])
      // Free again, and never below zero: two more fit.
      const a = yield* Effect.forkChild(slots.run("m", Effect.as(Effect.sleep(10), "a"), { timeoutMs: 100 }))
      const b = yield* Effect.forkChild(slots.run("m", Effect.as(Effect.sleep(10), "b"), { timeoutMs: 100 }))
      yield* advance(1)
      assert.strictEqual(slots.taken("m"), 2)
      assert.deepStrictEqual((yield* slots.run("m", Effect.void, { timeoutMs: 10 }))._tag, "full")
      yield* advance(20)
      assert.strictEqual((yield* Fiber.join(a))._tag, "done")
      assert.strictEqual((yield* Fiber.join(b))._tag, "done")
      assert.strictEqual(slots.taken("m"), 0)
    }))

  it.effect("the stop signal answers at once while the cleanup still runs; the slot stays taken until it has ended", () =>
    Effect.gen(function*() {
      const slots = makeModuleSlots({ cap: 4 })
      const probe = { active: 0, max: 0, cleaned: 0 }
      const stop = Deferred.makeUnsafe<void>()
      const waiting = yield* Effect.forkChild(slots.run("m", slow(probe, 2_000), { timeoutMs: 30_000, stopped: Deferred.await(stop) }))
      yield* advance(10)
      Deferred.doneUnsafe(stop, Effect.void)
      yield* advance(1)
      assert.deepStrictEqual(yield* Fiber.join(waiting), { _tag: "stopped" })
      assert.strictEqual(probe.cleaned, 0)
      assert.strictEqual(slots.taken("m"), 1)
      yield* advance(2_000)
      assert.strictEqual(probe.cleaned, 1)
      assert.strictEqual(slots.taken("m"), 0)
    }))
})

/** A module with `n` buttons whose presses never answer and clean up for `cleanupMs` when asked to stop. */
const pressModule = (n: number, probe: { active: number; max: number; cleaned: number }, cleanupMs: number, apiVersion?: 2) => {
  const settings: Record<string, ReturnType<typeof Setting.action>> = {}
  const handlers: Record<string, () => Effect.Effect<{ ok: boolean; text: string }>> = {}
  for (let i = 0; i < n; i++) {
    settings[`b${i}`] = Setting.action({ label: `B${i}`, buttonLabel: "Go" })
    handlers[`b${i}`] = () => Effect.as(slow(probe, cleanupMs), { ok: true, text: "never" })
  }
  return apiVersion === 2
    ? defineModule({
      apiVersion: 2,
      id: "presser",
      name: "Presser",
      description: "Slow buttons",
      settings,
      shared: () => Effect.succeed({ value: undefined }),
      start: () => Effect.succeed({ fieldActions: handlers })
    })
    : defineModule({ id: "presser", name: "Presser", description: "Slow buttons", settings, fieldActions: handlers, start: () => Effect.succeed({}) })
}

const enabled = readOnlyPersistence({ modules: { presser: { enabled: true } }, secrets: {} })
const busyIssue = (host: { readonly issues: { readonly all: () => ReadonlyArray<{ readonly id: string }> } }) => host.issues.all().find((i) => i.id === "presser.presses-busy")

describe("presses run in slots (review round 4)", () => {
  it.effect("many concurrent presses with slow cleanup never hold more than MAX_PRESS_SLOTS; the rest are busy, Health says so, and it recovers", () =>
    Effect.gen(function*() {
      const probe = { active: 0, max: 0, cleaned: 0 }
      const host = yield* makeModuleHost({ catalog: [pressModule(12, probe, 3_000)], persistence: enabled, env: {} })
      yield* host.startEnabled
      const presses = yield* Effect.forEach(Array.from({ length: 12 }, (_, i) => i), (i) => Effect.forkChild(host.fieldAction("presser", `b${i}`)))
      yield* advance(10)
      assert.strictEqual(probe.active, MAX_PRESS_SLOTS)
      yield* advance(8_000)
      const results = yield* Effect.forEach(presses, Fiber.join)
      assert.strictEqual(results.filter((r) => r.ok).length, MAX_PRESS_SLOTS)
      const refused = results.filter((r) => !r.ok)
      assert.strictEqual(refused.length, 12 - MAX_PRESS_SLOTS)
      for (const r of refused) assert.match(r.ok ? "" : `${r.code}: ${r.message}`, /^busy: Presser has 4 button presses running already/)
      assert.isDefined(busyIssue(host))
      // After the deadline they clean up (3 s): still taken, still refused.
      yield* advance(1_000)
      assert.strictEqual((yield* host.fieldAction("presser", "b11")).ok, false)
      assert.isDefined(busyIssue(host))
      yield* advance(2_000)
      assert.strictEqual(probe.cleaned, MAX_PRESS_SLOTS)
      assert.isUndefined(busyIssue(host))
      assert.strictEqual(probe.max, MAX_PRESS_SLOTS)
      const again = yield* Effect.forkChild(host.fieldAction("presser", "b11"))
      yield* advance(10)
      assert.strictEqual(probe.active, 1)
      yield* advance(8_000)
      assert.match(JSON.stringify(yield* Fiber.join(again)), /Did not finish within 8 s/)
      yield* advance(3_000)
    }))

  it.effect("a press whose caller is cancelled keeps its slot (and its button) until its cleanup has ended", () =>
    Effect.gen(function*() {
      const probe = { active: 0, max: 0, cleaned: 0 }
      const host = yield* makeModuleHost({ catalog: [pressModule(MAX_PRESS_SLOTS + 1, probe, 2_000)], persistence: enabled, env: {} })
      yield* host.startEnabled
      const callers = yield* Effect.forEach(Array.from({ length: MAX_PRESS_SLOTS }, (_, i) => i), (i) => Effect.forkChild(host.fieldAction("presser", `b${i}`)))
      yield* advance(10)
      // Cancelled long before their deadline: the callers end at once, the presses clean up.
      for (const caller of callers) yield* Fiber.interrupt(caller)
      yield* advance(10)
      assert.strictEqual(probe.active, MAX_PRESS_SLOTS)
      assert.strictEqual(probe.cleaned, 0)
      const refused = yield* host.fieldAction("presser", `b${MAX_PRESS_SLOTS}`)
      assert.strictEqual(refused.ok ? undefined : refused.code, "busy")
      assert.isDefined(busyIssue(host))
      assert.deepStrictEqual(yield* host.fieldAction("presser", "b0"), { ok: false, code: "busy", message: "That button is still running" })
      yield* advance(2_000)
      assert.strictEqual(probe.cleaned, MAX_PRESS_SLOTS)
      assert.isUndefined(busyIssue(host))
      const admitted = yield* Effect.forkChild(host.fieldAction("presser", `b${MAX_PRESS_SLOTS}`))
      yield* advance(10)
      assert.strictEqual(probe.active, 1)
      yield* Fiber.interrupt(admitted)
      yield* advance(2_000)
    }))

  it.effect("a stop answers the press after the grace period while its cleanup still runs", () =>
    Effect.gen(function*() {
      const probe = { active: 0, max: 0, cleaned: 0 }
      const host = yield* makeModuleHost({ catalog: [pressModule(1, probe, 2_000, 2)], persistence: enabled, env: {}, graceMs: 100, stopTimeoutMs: 5_000 })
      yield* host.startEnabled
      const press = yield* Effect.forkChild(host.fieldAction("presser", "b0"))
      yield* advance(10)
      const disabled = yield* Effect.forkChild(host.disable("presser"))
      yield* advance(50)
      assert.isUndefined(press.pollUnsafe())
      yield* advance(60)
      // Answered right after the grace period, its cleanup (2 s) still running.
      assert.deepStrictEqual(yield* Fiber.join(press), { ok: false, code: "not_running", message: "Presser is not running" })
      assert.strictEqual(probe.cleaned, 0)
      yield* advance(2_000)
      assert.strictEqual(probe.cleaned, 1)
      assert.isTrue((yield* Fiber.join(disabled)).ok)
    }))

  it.effect("a press that timed out and is then stopped by a restart counts once: the new instance's presses are admitted up to the exact cap", () =>
    Effect.gen(function*() {
      const probe = { active: 0, max: 0, cleaned: 0 }
      const host = yield* makeModuleHost({ catalog: [pressModule(6, probe, 20_000, 2)], persistence: enabled, env: {}, graceMs: 0, stopTimeoutMs: 100 })
      yield* host.startEnabled
      const first = yield* Effect.forEach([0, 1], (i) => Effect.forkChild(host.fieldAction("presser", `b${i}`)))
      yield* advance(8_000)
      for (const f of first) assert.match(JSON.stringify(yield* Fiber.join(f)), /Did not finish/)
      // Disabled and enabled again: the old presses are stopped a second time (and their part abandoned past its limit).
      const off = yield* Effect.forkChild(host.disable("presser"))
      yield* advance(200)
      assert.isTrue((yield* Fiber.join(off)).ok)
      const on = yield* Effect.forkChild(host.enable("presser"))
      yield* advance(10)
      assert.isTrue((yield* Fiber.join(on)).ok)
      assert.strictEqual(probe.active, 2)
      // Two slots are taken, not four: two new presses run, the third is refused.
      const next = yield* Effect.forEach([2, 3], (i) => Effect.forkChild(host.fieldAction("presser", `b${i}`)))
      yield* advance(10)
      assert.strictEqual(probe.active, 4)
      const refused = yield* host.fieldAction("presser", "b4")
      assert.strictEqual(refused.ok ? undefined : refused.code, "busy")
      for (const f of next) yield* Fiber.interrupt(f)
      yield* advance(20_000)
      assert.strictEqual(probe.active, 0)
      assert.isUndefined(busyIssue(host))
    }))
})
