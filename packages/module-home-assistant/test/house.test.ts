// The house as it is read: in pages of a bounded size, people first, the exposed kinds before the module's other
// kinds, at most the supported number of entities, incomplete beyond it (and every answer that depends on the whole
// list says so), the main thread never held for long, and nothing that holds a configured secret kept.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant } from "@pva/module-contracts"
import { Effect } from "effect"
import { HOUSE_LIMITS, homeAssistantModule, keepChars, pageRows, worstRow } from "../src/index.ts"
import { secretForms } from "../src/secrets.ts"
import { configured, type FakeEntity, makeFakeHa, TOKEN } from "./fakeHa.ts"

const POLL = 60_000

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
  it.effect("the areas first in pages of their own, then each page after the last id it saw: people, then what the service exposes, then the rest", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { ...lights(450), "person.sam": { name: "Sam", state: "home" }, "climate.hall": { name: "Hall", state: "heat", area: "area_1" } }
      const ha = makeFakeHa({ areas: areas40(), entities })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ domains: ["light"] }))
      const keep = keepChars(secretForms([TOKEN]))
      // The token is 24 characters; its longest form (base64) 32: Home Assistant keeps 80 + 32 + 1 of a name.
      assert.strictEqual(keep, 113)
      const rows = pageRows("entity", keep)
      assert.strictEqual(rows, 107)
      assert.deepStrictEqual(ha.pages().map((p) => [p.mode, p.domains.join(","), p.after, p.size]), [
        ["areas", "", "", HOUSE_LIMITS.pageRows],
        ["entities", "person", "", rows],
        ["entities", "light", "", rows],
        ["entities", "light", "light.l0106", rows],
        ["entities", "light", "light.l0213", rows],
        ["entities", "light", "light.l0320", rows],
        ["entities", "light", "light.l0427", rows],
        ["entities", "switch,fan,input_boolean,climate,cover,media_player,sensor,binary_sensor,lock,alarm_control_panel", "", rows]
      ])
      assert.isTrue(ha.pages().every((p) => p.keep === keep))
      assert.strictEqual(kit.service(HomeAssistant)!.entities().length, 451)
      assert.include(String(kit.info()?.settings.values.lists), "450 lights")
    }))
})

describe("home-assistant: the supported size", () => {
  it.effect("a house of more than the supported size is incomplete: \"all\" asks for a room, the status questions and home_state say so, nothing claims a total", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({ areas: areas40(), entities: lights(HOUSE_LIMITS.supported + 1) })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
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
      const ok = yield* startTestModule(homeAssistantModule({ net: full.net }), configured())
      assert.deepStrictEqual(yield* ok.action("lights_off", { target: "all lights" }), { ok: true, say: "I've turned off all the lights." })
      assert.strictEqual(full.calls().flatMap((c) => (c.body as { entity_id: Array<string> }).entity_id).length, HOUSE_LIMITS.supported)
      assert.deepStrictEqual(yield* ok.action("lights_status"), { ok: true, say: "All the lights are off." })
    }), 60_000)

  it.effect("the provider's room is the exposed kinds' and the people's: kinds it does not expose never take it, and nobody is left out for them", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { "media_player.kitchen": { name: "Kitchen speaker", state: "idle" }, "person.sam": { name: "Sam", state: "home" } }
      for (let i = 0; i < HOUSE_LIMITS.supported + 100; i++) entities[`climate.c${String(i).padStart(4, "0")}`] = { name: `Thermostat ${i}`, state: "heat" }
      const ha = makeFakeHa({ entities })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ domains: ["media_player"] }))
      const service = kit.service(HomeAssistant)!
      assert.deepStrictEqual(service.entities().map((e) => e.entityId), ["media_player.kitchen", "person.sam"])
      assert.deepStrictEqual(service.people().map((p) => p.name), ["Sam"])
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
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
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
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      assert.notInclude(JSON.stringify(kit.info()), TOKEN)
      assert.include(String(kit.info()?.settings.values.server), "Home Assistant at")
      ha.respondWith({ echo: `queue of ${TOKEN}` })
      const service = kit.service(HomeAssistant)!
      const answered = yield* service.callService({ domain: "media_player", service: "browse_media", target: { entityIds: ["media_player.kitchen"] }, returnResponse: true })
      assert.deepStrictEqual(answered, { responseCut: true })
      yield* kit.expectNoSecrets(answered, kit.info())
    }))
})

describe("home-assistant: Home Assistant's template limit", () => {
  const LIMIT = HOUSE_LIMITS.templateChars
  const chars = (text: string) => [...text].length
  const tooLarge = { status: 400, headers: { "content-type": "application/json" }, body: { message: `Error rendering template: Template output exceeded maximum size of ${LIMIT} characters` } }

  it.effect("the worst legal page stays under it: every text at its cut and escaped, every number at its longest", () =>
    Effect.gen(function*() {
      const far = -1.2345678901234567e-300
      const entities: Record<string, FakeEntity> = {}
      for (let i = 0; i < 300; i++) {
        entities[`light.${"w".repeat(240)}${String(i).padStart(9, "0")}`] = {
          name: "\"".repeat(400), state: "\\".repeat(255), area: "a".repeat(255), class: "\"".repeat(32), unit: "\"".repeat(16), title: "\"".repeat(400), artist: "\"".repeat(400),
          modes: ["off", "heat", "cool", "heat_cool", "auto", "dry", "fan_only", "heat"], colorModes: ["onoff"], brightness: far, current: far, target: far, position: far, features: far, volume: far, changed: far
        }
      }
      const ha = makeFakeHa({ entities })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ domains: ["light"] }))
      assert.strictEqual(kit.service(HomeAssistant)!.entities().length, 300)
      const keep = keepChars(secretForms([TOKEN]))
      const asked = ha.pages().filter((p) => p.mode === "entities" && p.domains.includes("light"))
      // Asked once each, at the size the worst row allows: Home Assistant never refused one.
      assert.deepStrictEqual(asked.map((p) => p.size), [pageRows("entity", keep), pageRows("entity", keep), pageRows("entity", keep)])
      for (const p of asked) {
        const page = ha.render({ method: "POST", body: JSON.stringify({ variables: p }), signal: new AbortController().signal, headers: {} }) as { rows: Array<unknown> }
        assert.isBelow(chars(JSON.stringify(page)), LIMIT)
        // Each row within the bound the page size was computed from.
        for (const row of page.rows) assert.isAtMost(chars(JSON.stringify(row)), worstRow.entity(keep))
      }
    }))

  it.effect("that exact answer is asked again with fewer rows; any other 400 is not", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({ entities: lights(150) })
      let first = true
      ha.answer("template", (init) => {
        const v = (JSON.parse(String(init?.body)) as { variables: { mode: string; domains: Array<string> } }).variables
        if (first && v.mode === "entities" && v.domains.includes("light")) {
          first = false
          return tooLarge
        }
        return { status: 200, headers: { "content-type": "text/plain" }, body: JSON.stringify(ha.render(init)) }
      })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ domains: ["light"] }))
      assert.strictEqual(kit.service(HomeAssistant)!.entities().length, 150)
      const rows = pageRows("entity", keepChars(secretForms([TOKEN])))
      assert.deepStrictEqual(ha.pages().filter((p) => p.domains.includes("light")).map((p) => p.size).slice(0, 2), [rows, Math.floor(rows / 8)])
      // Another error of rendering: not a size, so not asked again smaller.
      const other = makeFakeHa({ entities: lights(150) })
      other.answer("template", (init) => {
        const v = (JSON.parse(String(init?.body)) as { variables: { mode: string } }).variables
        return v.mode === "entities" ? { status: 400, headers: { "content-type": "application/json" }, body: { message: "Error rendering template: UndefinedError: 'area_id' is undefined" } } : { status: 200, headers: { "content-type": "text/plain" }, body: JSON.stringify(other.render(init)) }
      })
      const failed = yield* startTestModule(homeAssistantModule({ net: other.net }), configured({ domains: ["light"] }))
      assert.include(failed.info()?.status?.text ?? "", "Can't read Home Assistant yet")
      assert.deepStrictEqual(other.pages().filter((p) => p.mode === "entities").map((p) => p.size), [rows])
    }))
})

describe("home-assistant: areas in pages of their own", () => {
  it.effect("500 areas with names of 80 multi-byte characters, and one light: every area read", () =>
    Effect.gen(function*() {
      const areas: Record<string, string> = {}
      for (let i = 0; i < 500; i++) areas[`area_${String(i).padStart(3, "0")}`] = `${i} ${"漢".repeat(80)}`.slice(0, 80)
      const ha = makeFakeHa({ areas, entities: { "light.one": { name: "One", state: "off", area: "area_499" } } })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      const service = kit.service(HomeAssistant)!
      assert.strictEqual(service.areas().length, 500)
      assert.strictEqual(service.entity("light.one")?.areaId, "area_499")
      const pages = ha.pages().filter((p) => p.mode === "areas")
      // At most one more than the 500 kept, to know whether there are more.
      assert.deepStrictEqual(pages.map((p) => [p.after, p.size]), [["", 200], ["area_199", 200], ["area_399", 101]])
    }))
})

describe("home-assistant: every named scene is read", () => {
  it.effect("100 named scenes of 55 lights and 255-character names: read in pages, one shrunk, none lost or read twice", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = {}
      const members = Array.from({ length: 55 }, (_, i) => `light.m${String(i).padStart(2, "0")}`)
      for (const m of members) entities[m] = { name: m, state: "off" }
      const ids = Array.from({ length: 100 }, (_, i) => `scene.s${String(i).padStart(2, "0")}`)
      for (const [i, id] of ids.entries()) entities[id] = { name: `${i} ${"€".repeat(255)}`, state: "x", members }
      const aliases = ids.map((id) => `${id}: ${id.slice(6)}`).join("\n")
      assert.isBelow(aliases.length, 1_500)
      const ha = makeFakeHa({ entities })
      let shrunk = false
      ha.answer("template", (init) => {
        const v = (JSON.parse(String(init?.body)) as { variables: { ids: Array<string> | null; after: string } }).variables
        // The first page of scenes is too large for Home Assistant once: it is asked again smaller, then the rest.
        if (!shrunk && v.ids !== null && v.after === "") {
          shrunk = true
          return { status: 400, headers: { "content-type": "application/json" }, body: { message: "Error rendering template: Template output exceeded maximum size of 262144 characters" } }
        }
        return { status: 200, headers: { "content-type": "text/plain" }, body: JSON.stringify(ha.render(init)) }
      })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ aliases }))
      const scenePages = ha.pages().filter((p) => p.ids !== null)
      const rows = pageRows("scene", keepChars(secretForms([TOKEN])))
      assert.deepStrictEqual(scenePages.slice(0, 3).map((p) => [p.after, p.size]), [["", rows], ["", 1], ["scene.s00", rows]])
      // Each page goes on after the last one seen: strictly forward, so none twice.
      const afters = scenePages.slice(1).map((p) => p.after)
      assert.isTrue(afters.every((a, i) => i === 0 || a > afters[i - 1]!))
      for (const id of [ids[0]!, ids[57]!, ids[99]!]) {
        const r = yield* kit.action("scene_activate", { scene: id })
        assert.isTrue(r.ok && (r as { say: string }).say.startsWith("I've started"), id)
      }
      assert.include(String(kit.info()?.settings.values.lists), "scenes that can be started")
      assert.notInclude(String(kit.info()?.settings.values.lists), "not started by voice")
    }), 60_000)
})
