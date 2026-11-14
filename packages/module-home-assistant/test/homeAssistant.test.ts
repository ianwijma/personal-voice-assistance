import { assert, describe, expect, it } from "@effect/vitest"
import { type ActionDefinition, type ExtendedModuleInstance, makeToolRegistry, paramOptions, resolveSettings } from "@pva/core"
type StatusLine = { readonly text: string; readonly tone: string }
import { Effect, Exit, Scope } from "effect"
import { buildHouse, checkAliases, describeLights, homeAssistantModule, makeHomeAssistantClient, normalizeBaseUrl, parseAliases, serviceTarget } from "../src/index.ts"
import { defaultAreas, defaultLights, startFakeHomeAssistant } from "./fakeHomeAssistant.ts"

const inventory = () => ({
  areas: Object.entries(defaultAreas()).map(([id, a]) => ({ id, name: a.name, lights: a.lights })),
  lights: Object.entries(defaultLights()).map(([id, l]) => ({ id, name: l.name, state: l.state, brightness: l.brightness ?? null }))
})

describe("house model", () => {
  it("builds targets: one per area, one per light, and all, with generated and owner aliases", () => {
    const house = buildHouse(inventory(), "Living room: lounge, woonkamer\nlight.desk_lamp = bureaulamp\nall: alles", 0)
    expect(house.targets.map((t) => t.value)).toEqual([
      "area:living_room",
      "area:kitchen",
      "area:bedroom",
      "light.ceiling",
      "light.reading_lamp",
      "light.kitchen",
      "light.desk_lamp",
      "all"
    ])
    const living = house.targets[0]!
    expect(living.label).toBe("Living room")
    expect(living.aliases).toEqual(["lounge", "woonkamer", "Living room lights", "Living room light"])
    expect(house.targets.find((t) => t.value === "light.desk_lamp")?.aliases).toEqual(["bureaulamp"])
    expect(house.targets.find((t) => t.value === "light.desk_lamp")?.description).toBe("One light")
    expect(house.targets.find((t) => t.value === "light.ceiling")?.description).toBe("One light, in the Living room")
    expect(house.targets.at(-1)?.aliases).toContain("alles")
    expect(house.lights.find((l) => l.entityId === "light.ceiling")?.brightnessPct).toBe(50)
  })

  it("maps targets to service data; unknown values are refused", () => {
    const house = buildHouse(inventory(), "", 0)
    expect(serviceTarget(house, "area:kitchen")).toEqual({ area_id: "kitchen" })
    expect(serviceTarget(house, "light.desk_lamp")).toEqual({ entity_id: "light.desk_lamp" })
    expect(serviceTarget(house, "all")).toEqual({ entity_id: ["light.ceiling", "light.reading_lamp", "light.kitchen", "light.desk_lamp"] })
    expect(serviceTarget(house, "area:garage")).toBeUndefined()
    expect(serviceTarget(house, "light.nope")).toBeUndefined()
  })

  it("describes which lights are on in a spoken sentence", () => {
    expect(describeLights(buildHouse(inventory(), "", 0))).toBe("Ceiling and Desk lamp are on.")
    const off = inventory()
    off.lights = off.lights.map((l) => ({ ...l, state: "off" }))
    expect(describeLights(buildHouse(off, "", 0))).toBe("All lights are off.")
  })

  it("parses the alias setting and reports bad lines", () => {
    expect(parseAliases("# comment\nKitchen: keuken\n\nKitchen = cooking area").aliases.get("kitchen")).toEqual(["keuken", "cooking area"])
    expect(checkAliases("Kitchen keuken")).toBe("Line 1: write \"Name: alias, alias\"")
    expect(checkAliases("Kitchen:")).toBe("Line 1: write \"Name: alias, alias\"")
    expect(checkAliases("")).toBeUndefined()
  })

  it("normalises the address", () => {
    expect(normalizeBaseUrl("http://ha.local:8123/")).toBe("http://ha.local:8123")
    expect(normalizeBaseUrl(" https://ha.example.org/api ")).toBe("https://ha.example.org")
    expect(normalizeBaseUrl("ha.local:8123")).toBeUndefined()
    expect(normalizeBaseUrl("ftp://ha")).toBeUndefined()
  })
})

const settingsFor = (url: string, token: string | undefined, extra: { aliases?: string; timeoutMs?: number } = {}) => ({
  baseUrl: url,
  token,
  domains: ["light"] as ReadonlyArray<"light">,
  aliases: extra.aliases ?? "",
  timeoutMs: extra.timeoutMs ?? 1000
})

/** Start the module in a scope the test closes; returns the instance and the status lines. */
const start = (url: string, token: string | undefined, extra: { aliases?: string; timeoutMs?: number; refreshMs?: number } = {}) =>
  Effect.gen(function*() {
    const statuses: Array<StatusLine | undefined> = []
    const scope = yield* Scope.make()
    const exit = yield* homeAssistantModule({ refreshMs: extra.refreshMs ?? 60_000 }).start({
      settings: settingsFor(url, token, extra),
      setStatus: (s) => statuses.push(s)
    }).pipe(Scope.provide(scope), Effect.exit)
    return { exit, statuses, close: Scope.close(scope, Exit.void) }
  })

const instanceOf = (exit: Exit.Exit<unknown, unknown>): ExtendedModuleInstance => {
  assert.isTrue(Exit.isSuccess(exit), String(exit))
  return (exit as Exit.Success<ExtendedModuleInstance>).value
}
const startMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  assert.isTrue(Exit.isFailure(exit))
  const text = String((exit as Exit.Failure<unknown, { message: string }>).cause)
  return text
}
const action = (instance: ExtendedModuleInstance, id: string): ActionDefinition<any> => {
  const found = instance.actions?.find((a) => a.id === id)
  assert.isDefined(found, id)
  return found!
}

describe("home-assistant module", () => {
  it("declares its settings: env names, required token, nothing happens until it is enabled", () => {
    const module = homeAssistantModule()
    expect(module.enabledByDefault).toBe(false)
    const resolved = resolveSettings(module.settings, { stored: {}, secrets: {}, env: { HOME_ASSISTANT_URL: "http://ha.local:8123" } })
    expect(resolved.value).toBeUndefined() // token missing
    expect(resolved.form.errors).toEqual([{ key: "token", message: "Not set (enter it here or set HOME_ASSISTANT_TOKEN)" }])
    expect(resolved.form.values.baseUrl).toBe("http://ha.local:8123")
    expect(resolved.form.values.timeoutMs).toBe(2000)
    const bad = resolveSettings(module.settings, { stored: { baseUrl: "ha.local" }, secrets: { token: "t" }, env: {} })
    expect(bad.form.errors[0]?.key).toBe("baseUrl")
  })

  it.live("starts: checks the token, loads areas and lights in one template call, sets the status line", () =>
    Effect.gen(function*() {
      const ha = yield* Effect.promise(() => startFakeHomeAssistant())
      const { exit, statuses, close } = yield* start(`${ha.url}/`, ha.token, { aliases: "Living room: woonkamer" })
      const instance = instanceOf(exit)
      expect(ha.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/config", "POST /api/template"])
      expect(ha.requests.every((r) => r.authorization === "Bearer good-token")).toBe(true)
      expect(statuses.at(-1)).toEqual({ text: "3 areas · 4 lights · HA 2026.11.1", tone: "ok" })
      expect(instance.actions?.map((a) => a.id)).toEqual(["lights_on", "lights_off", "set_brightness", "lights_status"])
      const options = paramOptions(action(instance, "lights_on").params.target)
      expect(options.find((o) => o.value === "area:living_room")?.aliases).toContain("woonkamer")
      expect(instance.info?.().lists).toMatch(/^3 areas, 4 lights, fetched \d\d:\d\d$/)
      expect(ha.requests).toHaveLength(2) // reading options and info makes no request
      yield* close
      yield* Effect.promise(() => ha.close())
    }))

  it.live("lights_on / lights_off / set_brightness call the light services with area, entity or the full list", () =>
    Effect.gen(function*() {
      const ha = yield* Effect.promise(() => startFakeHomeAssistant())
      const { exit, close } = yield* start(ha.url, ha.token)
      const instance = instanceOf(exit)
      const on = action(instance, "lights_on")
      expect(on.announce?.({ target: "area:kitchen" })).toBe("Kitchen on.")
      yield* on.run({ target: "area:kitchen" })
      expect(ha.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/services/light/turn_on", body: { area_id: "kitchen" } })
      expect(ha.lights["light.kitchen"]?.state).toBe("on")

      yield* action(instance, "lights_off").run({ target: "all" })
      expect(ha.requests.at(-1)?.body).toEqual({ entity_id: ["light.ceiling", "light.reading_lamp", "light.kitchen", "light.desk_lamp"] })
      expect(Object.values(ha.lights).every((l) => l.state === "off")).toBe(true)

      const dim = action(instance, "set_brightness")
      expect(dim.announce?.({ target: "light.desk_lamp", level: 40 })).toBe("Desk lamp at 40 percent.")
      yield* dim.run({ target: "light.desk_lamp", level: 40 })
      expect(ha.requests.at(-1)).toMatchObject({ path: "/api/services/light/turn_on", body: { entity_id: "light.desk_lamp", brightness_pct: 40 } })

      const status = yield* action(instance, "lights_status").run({})
      expect(status).toEqual({ say: "Desk lamp is on." })
      expect(action(instance, "lights_status").speculative).toBe(true)
      yield* close
      yield* Effect.promise(() => ha.close())
    }))

  it.live("the home_state tool reads live state, and is speculative", () =>
    Effect.gen(function*() {
      const ha = yield* Effect.promise(() => startFakeHomeAssistant())
      const { exit, close } = yield* start(ha.url, ha.token)
      const instance = instanceOf(exit)
      const registry = makeToolRegistry([{ name: "home-assistant", tools: instance.tools ?? [] }])
      assert.isTrue(registry.isSpeculative("home_state"))
      const result = yield* registry.run({ id: "1", name: "home_state", input: {} })
      assert.isFalse(result.isError, result.content)
      expect(JSON.parse(result.content)).toEqual({
        areas: [
          { name: "Living room", lights: [{ name: "Ceiling", state: "on", brightnessPct: 50 }, { name: "Reading lamp", state: "off" }] },
          { name: "Kitchen", lights: [{ name: "Kitchen light", state: "off" }] },
          { name: "Bedroom", lights: [] }
        ],
        lightsWithoutArea: [{ name: "Desk lamp", state: "on" }]
      })
      yield* close
      yield* Effect.promise(() => ha.close())
    }))

  it.live("action failures are speakable ActionErrors", () =>
    Effect.gen(function*() {
      const ha = yield* Effect.promise(() => startFakeHomeAssistant())
      const { exit, close } = yield* start(ha.url, ha.token, { timeoutMs: 300 })
      const instance = instanceOf(exit)
      const on = action(instance, "lights_on")

      ha.failNextWith(500)
      const e500 = yield* Effect.flip(on.run({ target: "area:kitchen" }))
      expect(e500.message).toBe("Home Assistant reported an error.")

      const unknown = yield* Effect.flip(on.run({ target: "area:garage" }))
      expect(unknown.message).toBe("I don't know a room or light called area:garage.")

      ha.setDelay(1000)
      const slow = yield* Effect.flip(on.run({ target: "area:kitchen" }))
      expect(slow.message).toBe("Home Assistant didn't answer in time.")
      ha.setDelay(0)

      yield* Effect.promise(() => ha.close())
      const down = yield* Effect.flip(on.run({ target: "area:kitchen" }))
      expect(down.message).toBe("I couldn't reach Home Assistant.")
      yield* close
    }))

  it.live("start errors are clear settings errors, never crashes", () =>
    Effect.gen(function*() {
      const ha = yield* Effect.promise(() => startFakeHomeAssistant())
      const wrongToken = yield* start(ha.url, "wrong")
      expect(startMessage(wrongToken.exit)).toMatch(/Home Assistant rejected the token\. Create a long-lived access token/)

      const noUrl = yield* start("", "t")
      expect(startMessage(noUrl.exit)).toMatch(/Enter the address of your Home Assistant server/)

      const nonAdmin = yield* Effect.promise(() => startFakeHomeAssistant({ nonAdmin: true }))
      const forbidden = yield* start(nonAdmin.url, nonAdmin.token)
      expect(startMessage(forbidden.exit)).toMatch(/the token's user must be an administrator/)

      const slow = yield* Effect.promise(() => startFakeHomeAssistant({ delayMs: 1000 }))
      const timedOut = yield* start(slow.url, slow.token, { timeoutMs: 300 })
      expect(startMessage(timedOut.exit)).toMatch(/Could not reach Home Assistant at .*no answer within 300 ms.*Check the address/)

      yield* Effect.promise(() => ha.close())
      const down = yield* start(ha.url, ha.token)
      expect(startMessage(down.exit)).toMatch(/Could not reach Home Assistant at http:\/\/127\.0\.0\.1:\d+ .*Check the address/)
      yield* Effect.promise(() => Promise.all([nonAdmin.close(), slow.close()]))
    }))

  it.live("refreshes the lists in the background; a failed refresh keeps the old list and warns", () =>
    Effect.gen(function*() {
      const ha = yield* Effect.promise(() => startFakeHomeAssistant())
      const { exit, statuses, close } = yield* start(ha.url, ha.token, { refreshMs: 100 })
      const instance = instanceOf(exit)
      ha.areas.garage = { name: "Garage", lights: [] }
      yield* Effect.sleep("250 millis")
      const options = paramOptions(action(instance, "lights_on").params.target)
      expect(options.map((o) => o.label)).toContain("Garage")
      expect(statuses.at(-1)).toEqual({ text: "4 areas · 4 lights · HA 2026.11.1", tone: "ok" })

      ha.failNextWith(500)
      yield* Effect.sleep("120 millis")
      expect(statuses.some((s) => s?.tone === "warning" && /Couldn't refresh from Home Assistant/.test(s.text))).toBe(true)
      expect(paramOptions(action(instance, "lights_on").params.target).map((o) => o.label)).toContain("Garage")

      yield* close
      const before = ha.requests.length
      yield* Effect.sleep("250 millis")
      expect(ha.requests.length).toBe(before) // closing the scope stopped the refresh
      yield* Effect.promise(() => ha.close())
    }))
})

describe("client errors (review regressions)", () => {
  it.live("an error body that echoes the token never reaches the error detail", () =>
    Effect.gen(function*() {
      const token = "eyJhbGciOiJIUzI1NiJ9.secretpayload.signature"
      const fakeFetch = (status: number) => (async () =>
        new Response(`proxy says: bad token ${token} (Authorization: Bearer ${token})`, { status })) as typeof fetch
      for (const [status, call] of [[500, "config"], [403, "template"], [502, "service"]] as const) {
        const client = makeHomeAssistantClient({ baseUrl: "http://ha.local:8123", token, timeoutMs: 1000, fetch: fakeFetch(status) })
        const effect = call === "config"
          ? client.config
          : call === "template"
          ? client.renderTemplate("x")
          : client.callService("light", "turn_on", {})
        const error = yield* Effect.flip(effect)
        expect(error.detail).toContain(String(status))
        expect(error.detail).not.toContain(token)
        expect(error.message).not.toContain(token)
      }
    }))
})

describe("successful answers are content, not diagnostics (fourth review, finding 4)", () => {
  it.live("room and light names beginning with Basic, Token or Bearer reach the house model unchanged, with a credential configured", () =>
    Effect.gen(function*() {
      const token = "eyJhbGciOiJIUzI1NiJ9.unrelatedpayload.signature"
      const body = JSON.stringify({
        areas: [
          { id: "basic_bedroom", name: "Basic Bedroom", lights: ["light.token_lamp"] },
          { id: "bearer_hall", name: "Bearer Hallway", lights: [] }
        ],
        lights: [
          { id: "light.token_lamp", name: "Token Lamp Stand", state: "on", brightness: 255 },
          { id: "light.sk_lamp", name: "sk-livingroom-floorlamp", state: "off", brightness: null }
        ]
      })
      const client = makeHomeAssistantClient({
        baseUrl: "http://ha.local:8123",
        token,
        timeoutMs: 1000,
        fetch: (async () => new Response(body, { status: 200 })) as typeof fetch
      })
      const text = yield* client.renderTemplate("x")
      expect(text).toBe(body)
      const house = buildHouse(JSON.parse(text), "", 0)
      expect(house.targets.map((t) => t.label)).toEqual(["Basic Bedroom", "Bearer Hallway", "Token Lamp Stand", "sk-livingroom-floorlamp", expect.any(String)])
      expect(describeLights(house)).toBe("Token Lamp Stand is on.")
    }))
})
