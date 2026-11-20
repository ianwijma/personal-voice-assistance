// The `HomeAssistant` transport (packages/module-contracts/src/homeAssistant.ts), "in this version the provider
// polls", operation by operation against the contract's text, through the test kit and the in-process fake: the state,
// the connection, snapshots and changes across polls, a slow subscriber, two subscribers, every refusal of
// `callService`, the module stopped and started, and a consumer beside it that uses the service through `useService`.
import { assert, describe, it } from "@effect/vitest"
import { defineModule, isModuleStopped, makeTool } from "@pva/core"
import { startTestModule } from "@pva/core/testing"
import { HA_LIMITS, type HaChange, HomeAssistant, type HomeAssistantService, providerOffText, useService } from "@pva/module-contracts"
import { Cause, Deferred, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { CHANGED_AT, configured, type FakeEntity, makeFakeHa } from "./fakeHa.ts"

const POLL = 60_000
/** Let a background read of a house of several pages finish (each page is a real yield). */
const settle = Effect.repeat(Effect.yieldNow, { times: 200 })

const start = (options: { readonly entities?: Record<string, FakeEntity>; readonly down?: boolean; readonly settings?: Readonly<Record<string, unknown>> } = {}) =>
  Effect.gen(function*() {
    const ha = makeFakeHa(options.entities !== undefined ? { entities: options.entities } : {})
    if (options.down === true) ha.down()
    const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ aliases: "scene.movie_time: movie time", ...options.settings }))
    const service = kit.service(HomeAssistant)
    assert.isDefined(service)
    ha.requests.length = 0
    return { ha, kit, service: service! }
  })

/** Run a subscription in the test's scope, collecting what it sends; `ended` says whether its stream ended. */
const subscribe = (service: HomeAssistantService) =>
  Effect.gen(function*() {
    const got: Array<HaChange> = []
    const fiber = yield* Effect.forkScoped(Stream.runForEach(service.changes(), (c) => Effect.sync(() => void got.push(c))))
    yield* Effect.yieldNow
    return { got, fiber }
  })

/** What a change is, in one word, for comparing sequences. */
const tag = (c: HaChange): string =>
  c._tag === "snapshot" ? `snapshot:${c.reason}` : c._tag === "connection" ? `connection:${c.connection}` : c._tag === "changed" ? `changed:${c.entity.entityId}` : `removed:${c.entityId}`

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)

describe("HomeAssistant service: state", () => {
  it.effect("entities, entity, areas, people and the connection answer from the cache; what is exposed is the chosen kinds and people", () =>
    Effect.gen(function*() {
      const { ha, service } = yield* start()
      assert.strictEqual(service.connection(), "connected")
      const ids = service.entities().map((e) => e.entityId)
      // Every chosen kind, and the person; never a scene, a script or a sensor without a class.
      assert.deepStrictEqual(ids, [
        "alarm_control_panel.home",
        "binary_sensor.back_door",
        "climate.living_room",
        "cover.bedroom_blinds",
        "cover.garage_door",
        "cover.living_room_blinds",
        "fan.bedroom",
        "light.bedside",
        "light.ceiling",
        "light.kitchen",
        "light.reading_lamp",
        "lock.front_door",
        "media_player.kitchen",
        "person.robin",
        "sensor.kitchen_temperature",
        "switch.coffee"
      ])
      assert.deepStrictEqual(service.entity("climate.living_room"), {
        entityId: "climate.living_room",
        domain: "climate",
        name: "Living room thermostat",
        aliases: [],
        areaId: "living_room",
        state: "heat",
        attributes: { current_temperature: 18.5, temperature: 20, hvac_modes: ["off", "heat", "auto"] },
        attributesCut: false,
        lastChanged: CHANGED_AT * 1000
      })
      // A person: its name, state and last change, nothing more.
      assert.deepStrictEqual(service.entity("person.robin"), { entityId: "person.robin", domain: "person", name: "Robin", aliases: [], state: "not_home", attributes: {}, attributesCut: false, lastChanged: CHANGED_AT * 1000 })
      assert.deepStrictEqual(service.people(), [{ entityId: "person.robin", name: "Robin", state: "not_home", since: CHANGED_AT * 1000 }])
      assert.isUndefined(service.entity("scene.movie_time"))
      assert.isUndefined(service.entity("sensor.robins_phone_geocoded_location"))
      assert.deepStrictEqual(service.areas().map((a) => a.id), ["bedroom", "garage", "hall", "kitchen", "living_room"])
      // No network: every read above came from the cache.
      assert.deepStrictEqual(ha.requests, [])
    }))

  it.effect("the shared choice of kinds decides what is exposed; people are always", () =>
    Effect.gen(function*() {
      const { service } = yield* start({ settings: { domains: ["media_player"] } })
      assert.deepStrictEqual(service.entities().map((e) => e.entityId), ["media_player.kitchen", "person.robin"])
    }))

  it.effect("bounds: an entity whose id breaks the bound or Home Assistant's form is left out, never cut (the number of entities: house.test.ts)", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { [`light.${"a".repeat(HA_LIMITS.idChars)}`]: { state: "on" }, "light.Upper": { state: "on" }, "person.sam": { name: "Sam", state: "home" } }
      const { service } = yield* start({ entities })
      assert.deepStrictEqual(service.entities().map((e) => e.entityId), ["person.sam"])
    }))

  it.effect("unknown before the first good poll (the cache empty), connected after it", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start({ down: true })
      assert.strictEqual(service.connection(), "unknown")
      assert.deepStrictEqual(service.entities(), [])
      assert.deepStrictEqual(service.people(), [])
      ha.ok()
      yield* kit.advance(POLL)
      // The read brought a named scene, a kind no instance offered: the module started again, so this is a new provider
      // (as the contract says, a consumer looks it up again) and the old one answers ModuleStopped.
      assert.throws(() => service.connection())
      const now = kit.service(HomeAssistant)
      assert.isDefined(now)
      assert.strictEqual(now!.people().length, 1)
      assert.strictEqual(now!.connection(), "connected")
    }))
})

describe("HomeAssistant service: changes", () => {
  it.effect("a subscription starts with a snapshot; after each poll the differences, in entity id order", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start()
      const { got } = yield* subscribe(service)
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed"])
      const first = got[0] as Extract<HaChange, { _tag: "snapshot" }>
      assert.strictEqual(first.connection, "connected")
      assert.strictEqual(first.entities.length, service.entities().length)
      // Nothing changed: a poll sends nothing.
      yield* kit.advance(POLL)
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed"])
      // A light switched, a person came home, the bedside lamp removed: one each, by id.
      ha.entities["light.kitchen"]!.state = "on"
      ha.entities["person.robin"]!.state = "home"
      ha.entities["person.robin"]!.changed = CHANGED_AT + 3600
      delete ha.entities["light.bedside"]
      yield* kit.advance(POLL)
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed", "removed:light.bedside", "changed:light.kitchen", "changed:person.robin"])
      const arrived = got[3] as Extract<HaChange, { _tag: "changed" }>
      assert.strictEqual(arrived.previous?.state, "not_home")
      assert.strictEqual(arrived.entity.state, "home")
      assert.strictEqual(arrived.entity.lastChanged, (CHANGED_AT + 3600) * 1000)
      assert.deepStrictEqual(service.people(), [{ entityId: "person.robin", name: "Robin", state: "home", since: (CHANGED_AT + 3600) * 1000 }])
      // A new entity is a change with no previous.
      ha.entities["light.porch"] = { name: "Porch light", state: "off" }
      yield* kit.advance(POLL)
      const added = got.at(-1) as Extract<HaChange, { _tag: "changed" }>
      assert.deepStrictEqual([added.entity.entityId, added.previous], ["light.porch", undefined])
    }))

  it.effect("a failed poll is a connection change and keeps the cache; the next good one is one snapshot, never changes", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start()
      const { got } = yield* subscribe(service)
      ha.down()
      yield* kit.advance(POLL)
      assert.strictEqual(service.connection(), "reconnecting")
      assert.strictEqual(service.entity("light.ceiling")?.state, "on")
      // A second failed poll: nothing new.
      yield* kit.advance(POLL)
      // Robin came home while it was down: the reconnect is a state, not news.
      ha.entities["person.robin"]!.state = "home"
      ha.ok()
      yield* kit.advance(POLL)
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed", "connection:reconnecting", "connection:connected", "snapshot:reconnected"])
      const snap = got[3] as Extract<HaChange, { _tag: "snapshot" }>
      assert.strictEqual(snap.connection, "connected")
      assert.strictEqual(snap.entities.find((e) => e.entityId === "person.robin")?.state, "home")
    }))

  it.effect("subscribed while unknown: an empty snapshot, then the first good poll as one snapshot (reconnected)", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start({ down: true })
      const { got } = yield* subscribe(service)
      const first = got[0] as Extract<HaChange, { _tag: "snapshot" }>
      assert.deepStrictEqual([first.reason, first.connection, first.entities.length], ["subscribed", "unknown", 0])
      // A failed poll while unknown is no change.
      yield* kit.advance(POLL)
      assert.strictEqual(got.length, 1)
      ha.ok()
      yield* kit.advance(POLL)
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed", "connection:connected", "snapshot:reconnected"])
      assert.isAbove((got[2] as Extract<HaChange, { _tag: "snapshot" }>).entities.length, 10)
    }))

  it.effect("two subscribers each get their own snapshot and the same changes", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start()
      const a = yield* subscribe(service)
      ha.entities["light.kitchen"]!.state = "on"
      yield* kit.advance(POLL)
      const b = yield* subscribe(service)
      ha.entities["light.kitchen"]!.state = "off"
      yield* kit.advance(POLL)
      assert.deepStrictEqual(a.got.map(tag), ["snapshot:subscribed", "changed:light.kitchen", "changed:light.kitchen"])
      assert.deepStrictEqual(b.got.map(tag), ["snapshot:subscribed", "changed:light.kitchen"])
      assert.strictEqual((b.got[0] as Extract<HaChange, { _tag: "snapshot" }>).entities.find((e) => e.entityId === "light.kitchen")?.state, "on")
    }))

  it.effect("a subscriber that falls more than the queue behind gets a fresh snapshot (overflow) instead, then the changes after it", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {}
      for (let i = 0; i < HA_LIMITS.queue + 50; i++) entities[`light.l${String(i).padStart(4, "0")}`] = { state: "off" }
      const { ha, kit, service } = yield* start({ entities })
      const release = yield* Deferred.make<void>()
      const got: Array<HaChange> = []
      // A slow consumer: it takes the first snapshot, then waits.
      yield* Effect.forkScoped(Stream.runForEach(service.changes(), (c) => Effect.andThen(Effect.sync(() => void got.push(c)), Effect.suspend(() => (got.length === 1 ? Deferred.await(release) : Effect.void)))))
      yield* Effect.yieldNow
      for (const e of Object.values(entities)) e.state = "on"
      yield* kit.advance(POLL)
      yield* settle
      yield* Deferred.succeed(release, undefined)
      yield* kit.advance(0)
      entities["light.l0000"]!.state = "off"
      yield* kit.advance(POLL)
      yield* settle
      assert.deepStrictEqual(got.map(tag), ["snapshot:subscribed", "snapshot:overflow", "changed:light.l0000"])
      const overflow = got[1] as Extract<HaChange, { _tag: "snapshot" }>
      assert.isTrue(overflow.entities.every((e) => e.state === "on"))
      // Nothing of the dropped changes reached it, and Home Assistant was asked nothing for it.
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("the module stopped: the stream ends, the old provider answers ModuleStopped; started again, a new provider", () =>
    Effect.gen(function*() {
      const { kit, service } = yield* start()
      const { fiber } = yield* subscribe(service)
      yield* kit.stop
      assert.isUndefined(kit.service(HomeAssistant))
      const ended = yield* Fiber.join(fiber).pipe(Effect.exit)
      assert.isTrue(Exit.isSuccess(ended))
      for (const read of [() => service.entities(), () => service.connection(), () => service.people(), () => service.areas(), () => service.entity("light.kitchen"), () => service.changes()]) {
        assert.throws(read)
        try {
          read()
        } catch (e) {
          assert.isTrue(isModuleStopped(e))
        }
      }
      const call = yield* Effect.exit(service.callService({ domain: "light", service: "turn_on", target: { entityIds: ["light.kitchen"] } }))
      assert.isTrue(Exit.isFailure(call) && Cause.hasDies(call.cause) && isModuleStopped(failureOf(call)))
      yield* kit.start
      const again = kit.service(HomeAssistant)
      assert.isDefined(again)
      assert.notStrictEqual(again, service)
      assert.strictEqual(again!.connection(), "connected")
    }))
})

describe("HomeAssistant service: callService", () => {
  it.effect("an exposed entity by id: one request with the entity ids in the body; a response when asked for", () =>
    Effect.gen(function*() {
      const { ha, service } = yield* start()
      assert.deepStrictEqual(yield* service.callService({ domain: "media_player", service: "media_pause", target: { entityIds: ["media_player.kitchen"] } }), {})
      assert.deepStrictEqual(ha.calls(), [{ service: "media_player.media_pause", body: { entity_id: ["media_player.kitchen"] } }])
      ha.respondWith({ "media_player.kitchen": { volume: 0.4 } })
      const answered = yield* service.callService({ domain: "media_player", service: "browse_media", target: { entityIds: ["media_player.kitchen"] }, data: { media_content_type: "music" }, returnResponse: true })
      assert.deepStrictEqual(answered, { response: { "media_player.kitchen": { volume: 0.4 } } })
      assert.include(ha.requests.at(-1)!.path, "/api/services/media_player/browse_media")
      ha.respondWith({ big: "x".repeat(HA_LIMITS.responseChars) })
      assert.deepStrictEqual(yield* service.callService({ domain: "media_player", service: "browse_media", target: { entityIds: ["media_player.kitchen"] }, returnResponse: true }), { responseCut: true })
    }))

  it.effect("every refusal of the contract, before anything reaches Home Assistant", () =>
    Effect.gen(function*() {
      const { ha, service } = yield* start()
      const reasonOf = (call: unknown) =>
        Effect.map(Effect.flip(service.callService(call as never)), (e) => e.reason)
      const cases: ReadonlyArray<readonly [string, unknown, string]> = [
        ["no target", { domain: "light", service: "turn_on" }, "refused"],
        ["an area", { domain: "light", service: "turn_on", target: { areaIds: ["kitchen"] } }, "refused"],
        ["entity ids and an area", { domain: "light", service: "turn_on", target: { entityIds: ["light.kitchen"], areaIds: ["garage"] } }, "refused"],
        ["no entity ids", { domain: "light", service: "turn_on", target: { entityIds: [] } }, "refused"],
        ["a target in data", { domain: "light", service: "turn_on", target: { entityIds: ["light.kitchen"] }, data: { entity_id: "lock.front_door" } }, "refused"],
        ["a target deep in data", { domain: "media_player", service: "play_media", target: { entityIds: ["media_player.kitchen"] }, data: { extra: [{ area_id: "garage" }] } }, "refused"],
        ["a lock", { domain: "lock", service: "unlock", target: { entityIds: ["lock.front_door"] } }, "refused"],
        ["the alarm", { domain: "alarm_control_panel", service: "alarm_disarm", target: { entityIds: ["alarm_control_panel.home"] } }, "refused"],
        ["a script", { domain: "script", service: "turn_on", target: { entityIds: ["script.goodnight"] } }, "refused"],
        ["homeassistant.turn_off", { domain: "homeassistant", service: "turn_off", target: { entityIds: ["light.kitchen"] } }, "refused"],
        ["a lock through another domain", { domain: "light", service: "turn_on", target: { entityIds: ["lock.front_door"] } }, "refused"],
        ["a garage door", { domain: "cover", service: "open_cover", target: { entityIds: ["cover.garage_door"] } }, "refused"],
        ["a garage door among blinds", { domain: "cover", service: "close_cover", target: { entityIds: ["cover.living_room_blinds", "cover.garage_door"] } }, "refused"],
        ["not in Home Assistant", { domain: "light", service: "turn_on", target: { entityIds: ["light.nope"] } }, "unknown_entity"],
        ["a scene the owner did not name", { domain: "scene", service: "turn_on", target: { entityIds: ["scene.elsewhere"] } }, "refused"],
        ["a service not in the table (a classless sensor)", { domain: "sensor", service: "reload", target: { entityIds: ["sensor.robins_phone_geocoded_location"] } }, "refused"],
        ["not exposed (a classless sensor)", { domain: "switch", service: "turn_on", target: { entityIds: ["switch.robins_phone"] } }, "unknown_entity"],
        ["not an entity id", { domain: "light", service: "turn_on", target: { entityIds: ["Kitchen"] } }, "unknown_entity"],
        ["a domain that is not a-z0-9_", { domain: "Light", service: "turn_on", target: { entityIds: ["light.kitchen"] } }, "invalid"],
        ["a service that is not a-z0-9_", { domain: "light", service: "turn on", target: { entityIds: ["light.kitchen"] } }, "invalid"],
        ["too many entities", { domain: "light", service: "turn_on", target: { entityIds: Array.from({ length: HA_LIMITS.targets + 1 }, () => "light.kitchen") } }, "invalid"],
        ["data too long", { domain: "light", service: "turn_on", target: { entityIds: ["light.kitchen"] }, data: { effect: "x".repeat(HA_LIMITS.dataChars) } }, "invalid"]
      ]
      for (const [what, call, reason] of cases) assert.strictEqual(yield* reasonOf(call), reason, what)
      assert.deepStrictEqual(ha.calls(), [])
    }))

  it.effect("down: not connected at once, never queued; no answer in time: timeout within the contract's limit; an error: failed", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start({ settings: { timeoutMs: 10_000 } })
      const pause = { domain: "media_player", service: "media_pause", target: { entityIds: ["media_player.kitchen"] } }
      ha.hang("service")
      const slow = yield* Effect.forkChild(Effect.flip(service.callService(pause)))
      yield* kit.advance(HA_LIMITS.callTimeoutMs)
      assert.strictEqual((yield* Fiber.join(slow)).reason, "timeout")
      // A 500 may come after part of the call was carried out: it may or may not have happened.
      ha.answer("service", () => new Response("{\"message\": \"boom\"}", { status: 500, headers: { "content-type": "application/json" } }))
      assert.strictEqual((yield* Effect.flip(service.callService(pause))).reason, "timeout")
      // A 400 is refused before Home Assistant acts: failed.
      ha.answer("service", () => new Response("{\"message\": \"bad\"}", { status: 400, headers: { "content-type": "application/json" } }))
      const failed = yield* Effect.flip(service.callService(pause))
      assert.strictEqual(failed.reason, "failed")
      assert.notInclude(failed.detail, configured().secrets.token)
      ha.ok()
      ha.down()
      yield* kit.advance(POLL)
      const before = ha.requests.length
      assert.strictEqual((yield* Effect.flip(service.callService(pause))).reason, "not_connected")
      assert.strictEqual(ha.requests.length, before)
    }))

  it.effect("scripts are cut: a script named under Other names is ignored (the setting stays valid), no action runs one, and no consumer may", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start({ settings: { aliases: "script.goodnight: goodnight\nscene.movie_time: movie time" } })
      assert.strictEqual(kit.info()?.state, "running")
      assert.include(String(kit.info()?.settings.values.lists), "1 script named under Other names: scripts are not run in this version")
      const r = yield* kit.action("scene_activate", { scene: "goodnight" })
      assert.isFalse(r.ok)
      const tool = yield* kit.tool("home-assistant_scene_activate", { scene: "script.goodnight" })
      assert.isFalse(tool.ok)
      const consumer = yield* Effect.flip(service.callService({ domain: "script", service: "turn_on", target: { entityIds: ["script.goodnight"] } }))
      assert.strictEqual(consumer.reason, "refused")
      const through = yield* Effect.flip(service.callService({ domain: "homeassistant", service: "turn_on", target: { entityIds: ["script.goodnight"] } }))
      assert.strictEqual(through.reason, "refused")
      assert.deepStrictEqual(ha.calls(), [])
      // Not even read: no page since the start asked for a script (the kit's network recorded every request).
      const asked = ha.sent.filter((r) => r.url.endsWith("/api/template")).map((r) => (JSON.parse(r.body!) as { variables: { domains: Array<string>; ids: Array<string> | null } }).variables)
      assert.isAbove(asked.length, 0)
      assert.isFalse(asked.some((p) => p.domains.includes("script") || (p.ids ?? []).includes("script.goodnight")))
    }))
})

// A consumer beside the module, as presence or music would be: it finds the service through useService and words
// ProviderOff when the provider is off.
const consumer = defineModule({
  apiVersion: 2,
  id: "ha-consumer",
  name: "Consumer",
  description: "Uses the HomeAssistant service.",
  enabledByDefault: false,
  start: (ctx) =>
    Effect.succeed({
      tools: [
        makeTool({
          name: "consumer_pause",
          description: "Pause the kitchen speaker.",
          parameters: Schema.Struct({}),
          risk: "change",
          execute: () =>
            useService(ctx.host, HomeAssistant, (ha) => ha.callService({ domain: "media_player", service: "media_pause", target: { entityIds: ["media_player.kitchen"] } })).pipe(
              Effect.as("Paused."),
              Effect.catchTag("ProviderOff", () => Effect.succeed(providerOffText("en", "Home Assistant"))),
              Effect.catchTag("HomeAssistantError", (e) => Effect.succeed(`Not paused: ${e.reason}.`))
            )
        }),
        makeTool({
          name: "consumer_people",
          description: "Who Home Assistant knows.",
          parameters: Schema.Struct({}),
          speculative: true,
          execute: () =>
            useService(ctx.host, HomeAssistant, (ha) => Effect.sync(() => ha.people().map((p) => `${p.name}: ${p.state}`).join(", "))).pipe(
              Effect.catchTag("ProviderOff", () => Effect.succeed(providerOffText("en", "Home Assistant")))
            )
        })
      ]
    })
})

describe("HomeAssistant service: a consumer beside it", () => {
  it.effect("finds the service through useService, calls it as its own tool's call, and words the provider being off", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), { ...configured(), others: [consumer] })
      assert.strictEqual((yield* kit.tool("consumer_people", {})).value, "Robin: not_home")
      assert.strictEqual((yield* kit.tool("consumer_pause", {})).value, "Paused.")
      assert.deepStrictEqual(ha.calls(), [{ service: "media_player.media_pause", body: { entity_id: ["media_player.kitchen"] } }])
      yield* kit.stop
      assert.strictEqual((yield* kit.tool("consumer_pause", {})).value, "The Home Assistant module is off.")
      yield* kit.start
      assert.strictEqual((yield* kit.tool("consumer_people", {})).value, "Robin: not_home")
      assert.strictEqual(ha.calls().length, 1)
    }))
})
