import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { defineAction } from "../../src/Actions.ts"
import { ContributionKey } from "../../src/ModuleApi.ts"
import { defineModule } from "../../src/ModuleDefinition.ts"
import { startTestModule } from "../../src/ModuleTestKit.ts"
import { CurrentPrincipal, CurrentTurn, type Principal } from "../../src/TurnContext.ts"
import { presentFaultyStore, presentPrepared, presentWorld, PRESENT_DEVICES } from "../../src/presentContract.ts"
import { makeMemoryHouseholdStore } from "../../src/testing.ts"
import { makeBell } from "../notify/bell.ts"

const yields = Effect.repeat(Effect.yieldNow, { times: 100 })
const card = (title: string) => ({ kind: "card" as const, title, spoken: title })

describe("presentation round 5", () => {
  for (const retry of [false, true]) for (const move of [false, true]) {
    it.effect(`a1: an older accepted transient cannot end a newer room card (retry=${retry}, move=${move})`, () => Effect.gen(function*() {
      const f = presentFaultyStore(yield* presentPrepared(makeMemoryHouseholdStore()))
      const devices = PRESENT_DEVICES.map((d) => ({ ...d, place: { ...d.place } }))
      const tablet = devices[0]!, office = devices[1]!
      office.room = office.place.room = "Office"
      const w = yield* presentWorld(f.store, { devices })
      yield* w.settle
      const gate = yield* Deferred.make<void>()
      if (retry) f.faults.writes = 1
      else f.gate.wait = gate
      yield* w.toolOn(tablet.id, { forModel: "OK", present: card("Earlier tablet") })
      yield* yields
      yield* TestClock.adjust(retry ? 25 : 2500)
      const newer = yield* w.board().show({ room: "Office" }, card("Later office"))
      yield* yields
      if (move) tablet.room = tablet.place.room = "Office"
      w.present.reconcileAll()
      yield* yields
      assert.deepStrictEqual(w.shownOn(office.id).map((p) => p.id), [newer.id])
      if (move) assert.deepStrictEqual(w.shownOn(tablet.id).map((p) => p.id), [newer.id])
      if (retry) yield* TestClock.adjust(100)
      else yield* Deferred.succeed(gate, undefined)
      yield* w.settle
      assert.deepStrictEqual(w.shownOn(office.id).map((p) => p.id), [newer.id], "the other room screen keeps the newer card")
      assert.deepStrictEqual(w.shownOn(tablet.id).map((p) => p.content.kind === "card" ? p.content.title : ""), [move ? "Later office" : "Earlier tablet"])
      assert.isUndefined((yield* w.rows).find((r) => r.id === newer.id)?.value.ended)
      assert.strictEqual(f.faults.failed, retry ? 1 : 0)
    }))
  }

  for (const action of ["stop", "snooze"]) {
    it.effect(`a2: a prebuilt ${action} press uses the connection when it starts after reconnect`, () => Effect.gen(function*() {
      const bell = makeBell()
      bell.parts.answer = () => Effect.succeed({ say: "Snoozed", keepOpen: true })
      const kit = yield* startTestModule(bell.definition)
      const device = "kitchen-display"
      const sent = yield* kit.tool("bell_ring", { title: "Pasta", ring: true }, { device })
      const id = (sent.value as { id: string }).id
      yield* kit.notify.settle
      yield* kit.notify.disconnect(device)
      const answer = yield* Effect.andThen(kit.notify.connect(device), kit.notify.press(id, action, { device }))
      assert.isTrue(answer.ok)
      assert.strictEqual((yield* kit.notify.all).find((n) => n.id === id)?.state, action === "stop" ? "resolved" : "open")
      assert.strictEqual(bell.parts.presses.length, action === "stop" ? 0 : 1)
    }))
  }

  it.effect("a2: synthesized asTurn context is resolved at execution; an explicit context stays fixed", () => Effect.gen(function*() {
    const kit = yield* startTestModule(makeBell().definition)
    const device = "kitchen-display"
    const original = kit.turn({ device })
    const synthesized = kit.asTurn(CurrentTurn, { device })
    const explicit = kit.asTurn(CurrentTurn, original)
    yield* kit.notify.disconnect(device)
    yield* kit.notify.connect(device)
    assert.strictEqual((yield* synthesized)?.connection?.id, kit.turn({ device }).connection?.id)
    assert.strictEqual((yield* explicit)?.connection?.id, original.connection?.id)
    assert.isUndefined(kit.people.deviceOfConnection(original.connection!))
  }))

  it.effect("a2: prebuilt action and contribution helpers synthesize their turn after reconnect", () => Effect.gen(function*() {
    const lines = ContributionKey<string>("test.reconnect-lines")
    const kit = yield* startTestModule(defineModule({ apiVersion: 2, id: "board", name: "Board", description: "Turn timing",
      shared: () => Effect.succeed({ value: undefined, contributions: [lines.of("Connected")] }),
      start: () => Effect.succeed({
        actions: [defineAction({ id: "who", label: "Who", description: "Who", params: {},
          run: () => Effect.map(CurrentTurn, (turn) => ({ say: turn?.connection?.id ?? "missing" })) })]
      })
    }))
    const action = kit.action("who")
    const contributions = kit.contributions(lines)
    yield* kit.notify.disconnect("kitchen-display")
    yield* kit.notify.connect("kitchen-display")
    assert.deepStrictEqual(yield* action, { ok: true, say: kit.turn().connection!.id })
    assert.deepStrictEqual(yield* contributions, ["Connected"])
  }))

  it.effect("a2: a started press keeps its old principal across reconnect", () => Effect.gen(function*() {
    const bell = makeBell()
    const entered = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    let principal: Principal | undefined
    let finished: Principal | undefined
    bell.parts.answer = () => Effect.gen(function*() {
      principal = yield* CurrentPrincipal
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(finish)
      finished = yield* CurrentPrincipal
      return { say: "Done", keepOpen: true }
    })
    const kit = yield* startTestModule(bell.definition)
    const device = "kitchen-display"
    const sent = yield* kit.tool("bell_ring", { title: "Pasta", ring: true }, { device })
    const press = yield* Effect.forkChild(kit.notify.press((sent.value as { id: string }).id, "snooze", { device }))
    yield* Deferred.await(entered)
    assert.strictEqual(principal?._tag, "notification")
    const original = principal?._tag === "notification" ? principal.notification.connection : undefined
    assert.isDefined(original)
    yield* kit.notify.disconnect(device)
    yield* kit.notify.connect(device)
    yield* Deferred.succeed(finish, undefined)
    yield* Fiber.join(press)
    assert.notStrictEqual(original?.id, kit.turn({ device }).connection?.id)
    assert.strictEqual(finished, principal)
  }))
})
