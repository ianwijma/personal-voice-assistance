// The module as a whole, through the real host and gateway (the test kit): conformance, off by default, the start,
// the status line and the form, settings that are invalid, health, the Test button, a restart, and the kinds of
// devices it offers per assistant and per house.
import { assert, describe, it } from "@effect/vitest"
import { checkModule, expectOffByDefault, startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { catalog, homeAssistant, homeAssistantModule, texts } from "../src/index.ts"
import { configured, makeFakeHa, TOKEN, URL_BASE } from "./fakeHa.ts"

const valueOf = (kit: { info: () => { readonly settings: { readonly values: Readonly<Record<string, unknown>> } } | undefined }, key: string) => String(kit.info()?.settings.values[key] ?? "")

describe("home-assistant: the module", () => {
  it.effect("passes the conformance check, with its texts in both languages", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      yield* checkModule(homeAssistantModule({ fetch: ha.fetch }), { ...configured({ aliases: "scene.movie_time: movie time" }), texts })
    }))

  it.effect("is off by default, and the package's catalogue holds the production definition", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(catalog, [homeAssistant])
      assert.strictEqual(homeAssistant.id, "home-assistant")
      assert.strictEqual(homeAssistant.apiVersion, 2)
      yield* expectOffByDefault(catalog)
    }))

  it.effect("keeps the settings an owner already has: the same fields, in the same order, with the same switches", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      assert.deepStrictEqual(kit.info()?.settings.fields.map((f) => [f.key, f.overridable === true]), [
        ["baseUrl", false],
        ["token", false],
        ["domains", true],
        ["aliases", false],
        ["timeoutMs", false],
        ["server", false],
        ["lists", false],
        ["test", false]
      ])
      // An owner's old choice ("lights only") is still a valid value.
      const old = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ domains: ["light"], aliases: "Living room: lounge", timeoutMs: 2000 }))
      assert.strictEqual(old.info()?.state, "running")
      assert.deepStrictEqual(old.toolNames(), ["home_state", "home-assistant_lights_on", "home-assistant_lights_off", "home-assistant_set_brightness", "home-assistant_lights_status"])
    }))

  it.effect("starts with one config request and the house in pages; its status line and form say what it read", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ aliases: "scene.movie_time: movie time" }))
      assert.strictEqual(kit.info()?.state, "running")
      // The config, then one page each: the people (with the areas), the kinds the service exposes, the named scene.
      assert.deepStrictEqual(ha.requests.map((r) => `${r.method} ${r.path}`), ["GET /api/config", "POST /api/template", "POST /api/template", "POST /api/template"])
      assert.deepStrictEqual(ha.pages().map((p) => [p.domains, p.with_areas, p.ids]), [
        [["person"], true, null],
        [["light", "switch", "fan", "input_boolean", "climate", "cover", "media_player", "sensor", "binary_sensor", "lock", "alarm_control_panel"], false, null],
        [["scene"], false, ["scene.movie_time"]]
      ])
      assert.isTrue(ha.requests.every((r) => r.authorization === `Bearer ${TOKEN}`))
      assert.strictEqual(kit.info()?.status?.text, "5 areas · 4 lights · 12 others · HA 2026.11.1")
      assert.strictEqual(valueOf(kit, "server"), `Home 2026.11.1 at ${URL_BASE}`)
      assert.include(valueOf(kit, "lists"), "5 areas; 4 lights, 2 switches, 1 thermostats, 2 blinds, 1 media players, 2 sensors, 2 locks and alarms")
      assert.include(valueOf(kit, "lists"), "1 other cover (garage doors, gates, doors and the like) only read")
      assert.include(valueOf(kit, "lists"), "scenes that can be started: Movie time")
      // Every kind the house has, and the scene the owner named.
      assert.deepStrictEqual(kit.toolNames(), [
        "home_state",
        "home-assistant_lights_on",
        "home-assistant_lights_off",
        "home-assistant_set_brightness",
        "home-assistant_lights_status",
        "home-assistant_switches_on",
        "home-assistant_switches_off",
        "home-assistant_climate_set",
        "home-assistant_climate_mode",
        "home-assistant_climate_status",
        "home-assistant_covers_open",
        "home-assistant_covers_close",
        "home-assistant_covers_stop",
        "home-assistant_cover_position",
        "home-assistant_scene_activate",
        "home-assistant_locks_status"
      ])
    }))

  it.effect("an assistant that chose fewer kinds of devices gets only their actions; scenes need a name under Other names", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), {
        ...configured(),
        household: { assistants: [{ id: "jeff", modules: { "home-assistant": { own: { domains: ["light", "lock"] } } } }] }
      })
      assert.deepStrictEqual(kit.toolNames(), [
        "home_state",
        "home-assistant_lights_on",
        "home-assistant_lights_off",
        "home-assistant_set_brightness",
        "home-assistant_lights_status",
        "home-assistant_locks_status"
      ])
      // What it cannot use, it does not see either.
      const state = yield* kit.tool("home_state", {})
      assert.notInclude(state.content, "Coffee machine")
      assert.notInclude(state.content, "thermostat")
      assert.include(state.content, "Front door: locked (only read)")
    }))

  it.effect("a house without a kind offers none of its actions; when one appears, the module starts again with them", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({ entities: { "light.kitchen": { name: "Kitchen light", state: "off", area: "kitchen" } } })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      assert.deepStrictEqual(kit.toolNames(), ["home_state", "home-assistant_lights_on", "home-assistant_lights_off", "home-assistant_set_brightness", "home-assistant_lights_status"])
      ha.entities["climate.kitchen"] = { name: "Kitchen thermostat", state: "heat", area: "kitchen", current: 19, target: 20 }
      yield* kit.advance(60_000)
      yield* kit.advance(10_000)
      assert.strictEqual(kit.info()?.state, "running")
      assert.include(kit.toolNames(), "home-assistant_climate_set")
      assert.include(kit.toolNames(), "home-assistant_climate_status")
    }))

  it.effect("a restart reads the house again and offers the same", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const before = kit.toolNames()
      const templates = () => ha.requests.filter((r) => r.path === "/api/template").length
      // Everything so far is the start's one read.
      const read = templates()
      yield* kit.restart
      assert.strictEqual(kit.info()?.state, "running")
      assert.strictEqual(templates(), 2 * read)
      assert.deepStrictEqual(kit.toolNames(), before)
      const r = yield* kit.action("lights_on", { target: "kitchen" })
      assert.deepStrictEqual(r, { ok: true, say: "I've turned on the lights in Kitchen." })
    }))
})

describe("home-assistant: settings that are invalid", () => {
  it.effect("no address, no token, an address with a password: the module is down and says what to fix, never repeating it", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const none = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { secrets: { token: TOKEN } })
      assert.strictEqual(none.info()?.state, "error")
      assert.include(none.info()?.error ?? "", "Enter the address of your Home Assistant server")
      const noToken = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { settings: { baseUrl: URL_BASE } })
      assert.strictEqual(noToken.info()?.state, "error")
      const withPassword = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { settings: { baseUrl: "http://sam:hunter2-secret@ha.test:8123" }, secrets: { token: TOKEN } })
      assert.strictEqual(withPassword.info()?.state, "error")
      assert.notInclude(JSON.stringify(withPassword.info()), "hunter2-secret")
      assert.notInclude(JSON.stringify(withPassword.issues()), "hunter2-secret")
      // Nothing was sent anywhere.
      assert.deepStrictEqual(ha.requests, [])
    }))

  it.effect("other names that are not \"name: other names\", and a timeout out of range, are refused with the field's reason", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const bad = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ aliases: "just words without a colon" }))
      assert.notStrictEqual(bad.info()?.state, "running")
      assert.include(JSON.stringify(bad.info()?.settings.errors), "Line 1")
      const slow = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ timeoutMs: 60_000 }))
      assert.notStrictEqual(slow.info()?.state, "running")
    }))

  it.effect("a token Home Assistant refuses, or a user who is not an administrator, is a start error the owner can act on", () =>
    Effect.gen(function*() {
      const wrong = makeFakeHa({ token: "another-token" })
      const refused = yield* startTestModule(homeAssistantModule({ fetch: wrong.fetch }), configured())
      assert.strictEqual(refused.info()?.state, "error")
      assert.include(refused.info()?.error ?? "", "rejected the token")
      const user = makeFakeHa({ nonAdmin: true })
      const notAdmin = yield* startTestModule(homeAssistantModule({ fetch: user.fetch }), configured())
      assert.strictEqual(notAdmin.info()?.state, "error")
      assert.include(notAdmin.info()?.error ?? "", "must be an administrator")
      yield* refused.expectNoSecrets()
    }))
})

describe("home-assistant: health and the Test button", () => {
  it.effect("health: nothing and no request while it is off, set up or not; the address, the token and the server while it runs", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const health = homeAssistantModule({ fetch: ha.fetch }).health!
      const base = { baseUrl: "", token: undefined, domains: ["light"] as const, aliases: "", timeoutMs: 2000, server: "", lists: "" } as never
      assert.deepStrictEqual(yield* health({ settings: base, running: false }), [])
      // Configured, and off: Home Assistant is not contacted at all.
      assert.deepStrictEqual(yield* health({ settings: { ...(base as object), baseUrl: URL_BASE, token: TOKEN } as never, running: false }), [])
      assert.deepStrictEqual(yield* health({ settings: { ...(base as object), token: TOKEN } as never, running: false }), [])
      assert.deepStrictEqual(ha.requests, [])
      assert.deepStrictEqual(yield* health({ settings: undefined, running: true }), [])
      const ids = (issues: ReadonlyArray<{ readonly id: string }>) => issues.map((i) => i.id)
      assert.deepStrictEqual(ids(yield* health({ settings: { ...(base as object), token: TOKEN } as never, running: true })), ["home-assistant.no-address"])
      assert.deepStrictEqual(ids(yield* health({ settings: { ...(base as object), baseUrl: URL_BASE } as never, running: true })), ["home-assistant.no-token"])
      const good = { ...(base as object), baseUrl: URL_BASE, token: TOKEN } as never
      assert.deepStrictEqual(yield* health({ settings: good, running: true }), [])
      ha.down("config")
      assert.deepStrictEqual(ids(yield* health({ settings: good, running: true })), ["home-assistant.unreachable"])
      ha.ok()
      const wrong = makeFakeHa({ token: "another-token" })
      assert.deepStrictEqual(ids(yield* homeAssistantModule({ fetch: wrong.fetch }).health!({ settings: good, running: true })), ["home-assistant.token-refused"])
    }))

  it.effect("configured but switched off: no request at the start, on Check again or from the host's own health run; the Test button is the owner's to press", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { ...configured(), started: false })
      assert.notStrictEqual(kit.info()?.state, "running")
      assert.deepStrictEqual(yield* kit.checkHealth, [])
      yield* kit.advance(5 * 60_000)
      assert.deepStrictEqual(ha.requests, [])
      const test = homeAssistantModule({ fetch: ha.fetch }).fieldActions!.test!
      const pressed = yield* test({ settings: { baseUrl: URL_BASE, token: TOKEN, domains: ["light"], aliases: "", timeoutMs: 2000, server: "", lists: "" } as never, draft: false })
      assert.isTrue(pressed.ok)
      assert.isAbove(ha.requests.length, 0)
    }))

  it.effect("health through the host: Check again reports an unreachable Home Assistant, and clears when it answers", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      assert.deepStrictEqual(yield* kit.checkHealth, [])
      ha.down()
      assert.deepStrictEqual((yield* kit.checkHealth).map((i) => i.id), ["home-assistant.unreachable"])
      ha.ok()
      assert.deepStrictEqual(yield* kit.checkHealth, [])
    }))

  it.effect("the Test button connects with the given settings and says what it found", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const test = homeAssistantModule({ fetch: ha.fetch }).fieldActions!.test!
      const settings = { baseUrl: URL_BASE, token: TOKEN, domains: ["light"], aliases: "", timeoutMs: 2000, server: "", lists: "" } as never
      const ok = yield* test({ settings, draft: true })
      assert.isTrue(ok.ok)
      assert.match(ok.text, /^Connected to Home \(HA 2026\.11\.1\) in \d+ ms: 5 areas, 15 devices\.$/)
      const noAddress = yield* test({ settings: { ...(settings as object), baseUrl: "" } as never, draft: true })
      assert.isFalse(noAddress.ok)
      ha.down()
      const down = yield* test({ settings, draft: true })
      assert.isFalse(down.ok)
      assert.include(down.text, "Could not reach Home Assistant")
      assert.notInclude(down.text, TOKEN)
    }))
})
