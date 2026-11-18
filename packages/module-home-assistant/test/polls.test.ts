// Polls that overlap, a subscriber that falls behind with changes already waiting, a stream that ends with its
// consumer's scope, a kind that disappears, people as the contract allows them, and a successful answer too large to
// read: each against the HomeAssistant contract's text.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HA_LIMITS, type HaChange, HomeAssistant, type HomeAssistantService } from "@pva/module-contracts"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { makeTransport } from "../src/service.ts"
import { configured, defaultEntities, type FakeEntity, makeFakeHa } from "./fakeHa.ts"

const POLL = 60_000
const settle = Effect.repeat(Effect.yieldNow, { times: 200 })
const tag = (c: HaChange): string =>
  c._tag === "snapshot" ? `snapshot:${c.reason}` : c._tag === "connection" ? `connection:${c.connection}` : c._tag === "changed" ? `changed:${c.entity.entityId}` : `removed:${c.entityId}`

const subscribe = (service: HomeAssistantService) =>
  Effect.gen(function*() {
    const got: Array<HaChange> = []
    const fiber = yield* Effect.forkScoped(Stream.runForEach(service.changes(), (c) => Effect.sync(() => void got.push(c))))
    yield* Effect.yieldNow
    return { got, fiber }
  })

/**
 * A fake whose next page of lights is held: it is rendered when it is asked for (the state then), and answered when
 * the test releases it, with that page or with an error. Every other template page is answered at once, or fails
 * while `failOthers` is set.
 */
const holding = () => {
  const ha = makeFakeHa()
  let holdNext = false
  let failOthers = false
  let release: ((ok: boolean) => void) | undefined
  ha.answer("template", (init) => {
    const page = ha.render(init)
    const domains = (JSON.parse(String(init?.body)) as { variables: { domains: Array<string> } }).variables.domains
    if (holdNext && domains.includes("light")) {
      holdNext = false
      return new Promise<Response>((resolve) => {
        release = (ok) => resolve(ok ? new Response(JSON.stringify(page)) : new Response("{\"message\": \"boom\"}", { status: 500 }))
      })
    }
    return failOthers ? new Response("{\"message\": \"boom\"}", { status: 500 }) : new Response(JSON.stringify(page))
  })
  return {
    ha,
    holdNext: () => void (holdNext = true),
    failOthers: (on: boolean) => void (failOthers = on),
    release: (ok: boolean) => release!(ok)
  }
}

describe("HomeAssistant: reads that overlap", () => {
  const begin = Effect.gen(function*() {
    const h = holding()
    const kit = yield* startTestModule(homeAssistantModule({ fetch: h.ha.fetch }), configured())
    const service = kit.service(HomeAssistant)!
    const sub = yield* subscribe(service)
    // 59 s in: the next background read is a second away.
    yield* kit.advance(POLL - 1_000)
    return { ...h, kit, service, sub }
  })
  const kitchenLight = (value: unknown) => ((value as { rooms: Array<{ things: Array<string> }> }).rooms.flatMap((r) => r.things).find((t) => t.startsWith("Kitchen light")))

  it.effect("an older read overtaken by a newer good one answers with the newer house, and the change comes once", () =>
    Effect.gen(function*() {
      const t = yield* begin
      t.holdNext()
      const older = yield* Effect.forkChild(t.kit.tool("home_state", { area: "kitchen", kind: "light" }))
      yield* settle
      t.ha.entities["light.kitchen"]!.state = "on"
      yield* t.kit.advance(1_000)
      yield* settle
      t.release(true)
      const answer = yield* Fiber.join(older)
      assert.strictEqual(kitchenLight(answer.value), "Kitchen light: on")
      assert.deepStrictEqual(t.sub.got.map(tag), ["snapshot:subscribed", "changed:light.kitchen"])
      assert.strictEqual(t.service.entity("light.kitchen")?.state, "on")
    }))

  it.effect("an older read that fails after a newer good one answers with the newer house, not its own failure", () =>
    Effect.gen(function*() {
      const t = yield* begin
      t.holdNext()
      const older = yield* Effect.forkChild(t.kit.tool("home_state", { area: "kitchen", kind: "light" }))
      yield* settle
      t.ha.entities["light.kitchen"]!.state = "on"
      yield* t.kit.advance(1_000)
      yield* settle
      t.release(false)
      const answer = yield* Fiber.join(older)
      assert.isTrue(answer.ok)
      assert.strictEqual(kitchenLight(answer.value), "Kitchen light: on")
      assert.deepStrictEqual(t.sub.got.map(tag), ["snapshot:subscribed", "changed:light.kitchen"])
      assert.strictEqual(t.service.connection(), "connected")
    }))

  it.effect("an older good read overtaken by a newer failed one answers with the failure, and its house is not taken in", () =>
    Effect.gen(function*() {
      const t = yield* begin
      t.ha.entities["light.kitchen"]!.state = "on"
      t.holdNext()
      const older = yield* Effect.forkChild(t.kit.tool("home_state", { area: "kitchen", kind: "light" }))
      yield* settle
      t.failOthers(true)
      yield* t.kit.advance(1_000)
      yield* settle
      t.release(true)
      const answer = yield* Fiber.join(older)
      assert.deepStrictEqual([answer.ok, answer.content], [false, "Home Assistant reported an error."])
      // Nothing of the older read was kept: no change, the light as the last kept poll had it.
      assert.deepStrictEqual(t.sub.got.map(tag), ["snapshot:subscribed", "connection:reconnecting"])
      assert.strictEqual(t.service.entity("light.kitchen")?.state, "off")
    }))

  it.effect("reads that end in the order they began: both kept, each change once", () =>
    Effect.gen(function*() {
      const t = yield* begin
      t.ha.entities["light.kitchen"]!.state = "on"
      t.holdNext()
      const older = yield* Effect.forkChild(t.kit.tool("home_state", { area: "kitchen", kind: "light" }))
      yield* settle
      t.release(true)
      assert.strictEqual(kitchenLight((yield* Fiber.join(older)).value), "Kitchen light: on")
      t.ha.entities["light.bedside"]!.state = "on"
      yield* t.kit.advance(1_000)
      yield* settle
      assert.deepStrictEqual(t.sub.got.map(tag), ["snapshot:subscribed", "changed:light.kitchen", "changed:light.bedside"])
    }))
})

describe("HomeAssistant: a subscriber that falls behind", () => {
  it.effect("changes already waiting are dropped too: the next thing it reads after an overflow is the fresh snapshot", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {}
      for (let i = 0; i < HA_LIMITS.queue + 100; i++) entities[`light.l${String(i).padStart(4, "0")}`] = { state: "off" }
      const ha = makeFakeHa({ entities })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const service = kit.service(HomeAssistant)!
      const release = yield* Deferred.make<void>()
      const got: Array<HaChange> = []
      yield* Effect.forkScoped(Stream.runForEach(service.changes(), (c) => Effect.andThen(Effect.sync(() => void got.push(c)), Effect.suspend(() => (got.length === 1 ? Deferred.await(release) : Effect.void)))))
      yield* settle
      // Poll A: two changes wait for it (one of them could already have been handed on in a buffer).
      entities["light.l0000"]!.state = "on"
      entities["light.l0001"]!.state = "on"
      yield* kit.advance(POLL)
      yield* settle
      // Poll B, while it still waits: more than the queue.
      for (const e of Object.values(entities)) e.state = "on"
      entities["light.l0000"]!.state = "off"
      yield* kit.advance(POLL)
      yield* settle
      yield* Deferred.succeed(release, undefined)
      yield* settle
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed", "snapshot:overflow"])
      const snap = got[1] as Extract<HaChange, { _tag: "snapshot" }>
      assert.strictEqual(snap.entities.find((e) => e.entityId === "light.l0000")?.state, "off")
      assert.strictEqual(snap.entities.find((e) => e.entityId === "light.l0001")?.state, "on")
    }), 30_000)
})

describe("HomeAssistant: lifetimes", () => {
  it.effect("a consumer's subscription ends with its scope: the provider forgets it", () =>
    Effect.gen(function*() {
      const transport = makeTransport({ call: () => Effect.succeed(undefined), timeoutMs: 1_000, secrets: [] })
      const got: Array<HaChange> = []
      yield* Effect.scoped(Effect.gen(function*() {
        yield* Effect.forkScoped(Stream.runForEach(transport.service.changes(), (c) => Effect.sync(() => void got.push(c))))
        yield* settle
        assert.strictEqual(transport.subscriberCount(), 1)
      }))
      yield* settle
      assert.strictEqual(transport.subscriberCount(), 0)
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed"])
      // The part closing ends a stream that is still running.
      const fiber = yield* Effect.forkChild(Stream.runCollect(transport.service.changes()))
      yield* settle
      transport.close()
      const all = yield* Fiber.join(fiber)
      assert.deepStrictEqual([...all].map(tag), ["snapshot:subscribed"])
      assert.strictEqual(transport.subscriberCount(), 0)
    }))

  it.effect("a kind that disappears keeps the same provider and the same stream: the consumer is not cut off", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const service = kit.service(HomeAssistant)!
      const { got, fiber } = yield* subscribe(service)
      delete ha.entities["climate.living_room"]
      yield* kit.advance(POLL)
      yield* settle
      yield* kit.advance(10_000)
      assert.strictEqual(kit.service(HomeAssistant), service)
      assert.strictEqual(service.connection(), "connected")
      assert.isUndefined(fiber.pollUnsafe())
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed", "removed:climate.living_room"])
    }))

  it.effect("a person carries its id, name, state and last change only, whatever else the answer holds for it", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({
        entities: {
          ...defaultEntities(),
          "person.sam": { name: "Sam", state: "home", extra: { area: "kitchen", class: "presence", brightness: 5, title: "Sam's song", artist: "x", unit: "m", current: 3, latitude: 52.1, attributes: { gps: [52.1, 5.1] } } }
        }
      })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const sam = kit.service(HomeAssistant)!.entity("person.sam")
      assert.deepStrictEqual(sam, { entityId: "person.sam", domain: "person", name: "Sam", aliases: [], state: "home", attributes: {}, attributesCut: false, lastChanged: (Date.UTC(2026, 10, 18, 8, 0, 0)) })
    }))
})

describe("HomeAssistant: answers too large to read", () => {
  it.effect("a successful answer over the response bound, or over the transport's byte limit, is a success with responseCut; an error answer stays failed", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const service = kit.service(HomeAssistant)!
      const call = { domain: "music_assistant", service: "get_queue", target: { entityIds: ["media_player.kitchen"] }, returnResponse: true } as const
      ha.respondWith({ big: "x".repeat(HA_LIMITS.responseChars + 10) })
      assert.deepStrictEqual(yield* service.callService(call), { responseCut: true })
      ha.respondWith({ huge: "x".repeat(300_000) })
      assert.deepStrictEqual(yield* service.callService(call), { responseCut: true })
      ha.answer("service", () => new Response(JSON.stringify({ message: "x".repeat(300_000) }), { status: 500 }))
      assert.strictEqual((yield* Effect.flip(service.callService(call))).reason, "failed")
      assert.strictEqual(ha.calls().length, 3)
    }))
})
