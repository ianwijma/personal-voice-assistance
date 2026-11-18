// The house as it is read: in pages of a bounded size, people first, the exposed kinds before the module's other
// kinds, at most the supported number of entities, incomplete beyond it (and every answer that depends on the whole
// list says so), the main thread never held for long, and nothing that holds a configured secret kept.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant } from "@pva/module-contracts"
import { Effect } from "effect"
import { HOUSE_LIMITS, homeAssistantModule } from "../src/index.ts"
import { configured, type FakeEntity, makeFakeHa, TOKEN } from "./fakeHa.ts"

const POLL = 60_000
/** As the store's latency tests: the bound measured here, three times it on a shared CI runner. */
const bound = (ms: number): number => (process.env.CI ? ms * 3 : ms)

/** `n` lights over 40 areas, with names like a real house's. */
const lights = (n: number, state = "off"): Record<string, FakeEntity> => {
  const out: Record<string, FakeEntity> = {}
  for (let i = 0; i < n; i++) out[`light.l${String(i).padStart(4, "0")}`] = { name: `Lamp ${i} by the window`, state, area: `area_${i % 40}`, brightness: 128 }
  return out
}
const areas40 = () => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`area_${i}`, `Room ${i}`]))

/** Let a background read that was started finish (it reads several pages, each a real yield). */
const settle = Effect.repeat(Effect.yieldNow, { times: 400 })

describe("home-assistant: the house in pages", () => {
  it.effect("each page asks for at most the page size after the last id it saw, people first, then what the service exposes, then the rest", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { ...lights(450), "person.sam": { name: "Sam", state: "home" }, "climate.hall": { name: "Hall", state: "heat", area: "area_1" } }
      const ha = makeFakeHa({ areas: areas40(), entities })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ domains: ["light"] }))
      const pages = ha.pages()
      assert.deepStrictEqual(pages.map((p) => [p.domains.join(","), p.after, p.size]), [
        ["person", "", HOUSE_LIMITS.pageRows],
        ["light", "", HOUSE_LIMITS.pageRows],
        ["light", "light.l0199", HOUSE_LIMITS.pageRows],
        ["light", "light.l0399", HOUSE_LIMITS.pageRows],
        ["switch,fan,input_boolean,climate,cover,media_player,sensor,binary_sensor,lock,alarm_control_panel", "", HOUSE_LIMITS.pageRows]
      ])
      // Every text is cut by Home Assistant at the longest bound plus the longest secret, so a secret is seen whole.
      assert.isTrue(pages.every((p) => p.keep === HOUSE_LIMITS.idChars + TOKEN.length + 1))
      assert.strictEqual(kit.service(HomeAssistant)!.entities().length, 451)
      assert.include(String(kit.info()?.settings.values.lists), "450 lights")
    }))

  it.effect("a page whose answer is over the byte limit is asked again in eighths; no answer of one page is read past the limit", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {}
      // Each light's name is control characters, six characters of JSON each: about 1.7 KB a row, so 200 rows are over the limit.
      for (let i = 0; i < 300; i++) entities[`light.q${String(i).padStart(3, "0")}`] = { name: "\u0001".repeat(300), state: "off" }
      const ha = makeFakeHa({ entities })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ domains: ["light"] }))
      assert.strictEqual(kit.service(HomeAssistant)!.entities().length, 300)
      assert.include(ha.pages().map((p) => p.size), HOUSE_LIMITS.pageRows / 8)
    }))
})

describe("home-assistant: the supported size", () => {
  it.effect("a house of more than the supported size is incomplete: \"all\" asks for a room, the status questions and home_state say so, nothing claims a total", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({ areas: areas40(), entities: lights(HOUSE_LIMITS.supported + 1) })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      ha.requests.length = 0
      // The provider keeps the supported number: one less than Home Assistant has.
      assert.strictEqual(kit.service(HomeAssistant)!.entities().length, HOUSE_LIMITS.supported)
      for (const target of ["all lights", "all"]) {
        assert.deepStrictEqual(yield* kit.action("lights_on", { target }), { ok: true, say: "Your house has more devices than I can read, so I can't reach all the lights. Which room do you mean?" }, target)
      }
      assert.deepStrictEqual((yield* kit.tool("home-assistant_lights_on", { target: "all lights" })).value, "Your house has more devices than I can read, so I can't reach all the lights. Which room do you mean?")
      assert.deepStrictEqual(ha.calls(), [])
      // A room is reached, and said to be what it knows of the room.
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "Room 3" }), { ok: true, say: "I've turned on the lights I know of in Room 3." })
      assert.strictEqual((ha.calls()[0]!.body as { entity_id: Array<string> }).entity_id.length, 50)
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "Lamp 3 by the window, Lamp 43 by the window, Lamp 83 by the window and 47 more are on. Your house has more than I can read, so there may be more." })
      const state = yield* kit.tool("home_state", { kind: "light" })
      assert.strictEqual((state.value as { incomplete?: string }).incomplete, "Your house has more than I can read, so there may be more.")
      assert.include(String(kit.info()?.settings.values.lists), `incomplete: the house has more than the ${HOUSE_LIMITS.supported} entities this version reads`)
      assert.include(kit.info()?.status?.text ?? "", "incomplete")
      // Exactly the supported size, read in full: complete.
      const full = makeFakeHa({ areas: areas40(), entities: lights(HOUSE_LIMITS.supported) })
      const ok = yield* startTestModule(homeAssistantModule({ fetch: full.fetch }), configured())
      assert.deepStrictEqual(yield* ok.action("lights_off", { target: "all lights" }), { ok: true, say: "I've turned off all the lights." })
      assert.strictEqual(full.calls().flatMap((c) => (c.body as { entity_id: Array<string> }).entity_id).length, HOUSE_LIMITS.supported)
      assert.deepStrictEqual(yield* ok.action("lights_status"), { ok: true, say: "All the lights are off." })
    }), 60_000)

  it.effect("the provider's room is the exposed kinds' and the people's: kinds it does not expose never take it, and nobody is left out for them", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { "media_player.kitchen": { name: "Kitchen speaker", state: "idle" }, "person.sam": { name: "Sam", state: "home" } }
      for (let i = 0; i < HOUSE_LIMITS.supported + 100; i++) entities[`climate.c${String(i).padStart(4, "0")}`] = { name: `Thermostat ${i}`, state: "heat" }
      const ha = makeFakeHa({ entities })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ domains: ["media_player"] }))
      const service = kit.service(HomeAssistant)!
      assert.deepStrictEqual(service.entities().map((e) => e.entityId), ["media_player.kitchen", "person.sam"])
      assert.deepStrictEqual(service.people().map((p) => p.name), ["Sam"])
    }), 60_000)

  it.effect(`a poll of the largest supported house holds the main thread less than 10 ms at a time`, () =>
    Effect.gen(function*() {
      const entities = lights(HOUSE_LIMITS.supported - 1)
      entities["person.sam"] = { name: "Sam", state: "home" }
      const ha = makeFakeHa({ areas: areas40(), entities })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const service = kit.service(HomeAssistant)!
      for (const e of Object.values(entities)) e.state = e.state === "off" ? "on" : "not_home"
      // A 1 ms timer: the longest gap between its ticks is the longest the main thread was held.
      let last = performance.now()
      let worst = 0
      const timer = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }, 1)
      try {
        // Two polls, so the second compares every entity with the first and publishes 2,000 changes.
        for (let poll = 0; poll < 2; poll++) {
          yield* kit.advance(POLL)
          yield* settle
          for (const e of Object.values(entities)) e.state = e.state === "on" ? "off" : e.state
        }
      } finally {
        clearInterval(timer)
      }
      worst = Math.max(worst, performance.now() - last)
      assert.strictEqual(service.entities().length, HOUSE_LIMITS.supported)
      // Both polls were taken in: the last one switched every light back off.
      assert.strictEqual(service.entity("light.l0000")?.state, "off")
      assert.strictEqual(service.entity("person.sam")?.state, "not_home")
      console.log(`longest stop during two polls of ${HOUSE_LIMITS.supported} entities: ${worst.toFixed(1)} ms`)
      assert.isBelow(worst, bound(10))
    }), 60_000)
})

describe("home-assistant: what holds a configured secret is left out whole", () => {
  it.effect("a light, an area or a media title that holds the token is dropped and counted, never rewritten; nothing returned, said or kept holds it", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {
        "light.kitchen": { name: "Kitchen light", state: "off", area: "kitchen" },
        "light.echo": { name: `Echo ${TOKEN}`, state: "off", area: "kitchen" },
        // The clipping boundary: the token starts just inside the 200 characters a name keeps and ends beyond them.
        "light.long": { name: `${"x".repeat(HOUSE_LIMITS.nameChars - 15)}${TOKEN}`, state: "off", area: "kitchen" },
        "media_player.kitchen": { name: "Kitchen speaker", state: "playing", area: "kitchen", title: `Song ${TOKEN}` },
        "light.basic": { name: "Basic Bedroom lamp", state: "off", area: "secret_room" },
        "person.sam": { name: "Sam", state: TOKEN }
      }
      const ha = makeFakeHa({ entities, areas: { kitchen: "Kitchen", secret_room: `Room ${TOKEN}` } })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const service = kit.service(HomeAssistant)!
      assert.deepStrictEqual(service.entities().map((e) => e.entityId), ["light.basic", "light.kitchen"])
      assert.deepStrictEqual(service.areas().map((a) => a.id), ["kitchen"])
      // A name like "Basic Bedroom lamp" is kept as it is: no generic pattern is applied to names.
      assert.strictEqual(service.entity("light.basic")?.name, "Basic Bedroom lamp")
      const results: Array<unknown> = [
        yield* kit.tool("home_state", {}),
        yield* kit.action("lights_on", { target: "light.echo" }),
        yield* kit.tool("home-assistant_lights_on", { target: "light.long" }),
        yield* kit.action("lights_on", { target: "kitchen" }),
        yield* kit.action("lights_status"),
        service.entities(),
        service.areas(),
        service.people(),
        kit.info()
      ]
      assert.deepStrictEqual(ha.calls(), [{ service: "light.turn_on", body: { entity_id: ["light.kitchen"] } }])
      assert.include(String(kit.info()?.settings.values.lists), "5 left out because a name or state held the token or the address's secret")
      for (const r of results) assert.notInclude(JSON.stringify(r), TOKEN.slice(0, 12))
      yield* kit.expectNoSecrets(results)
    }))

  it.effect("a location name that holds the token is not shown; a service answer that holds it is cut", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({ locationName: `Home ${TOKEN}` })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      assert.notInclude(JSON.stringify(kit.info()), TOKEN)
      assert.include(String(kit.info()?.settings.values.server), "Home Assistant at")
      ha.respondWith({ echo: `queue of ${TOKEN}` })
      const service = kit.service(HomeAssistant)!
      const answered = yield* service.callService({ domain: "music_assistant", service: "get_queue", target: { entityIds: ["media_player.kitchen"] }, returnResponse: true })
      assert.deepStrictEqual(answered, { responseCut: true })
      yield* kit.expectNoSecrets(answered, kit.info())
    }))
})
