// Home Assistant unreachable, slow, and answering rubbish: at the start, in the background read, and on a turn. Every
// failure is a sentence the person can act on, in the household's language; nothing waits past an action's 5 s.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect, Fiber } from "effect"
import { HOUSE_LIMITS, homeAssistantModule, OUTSIDE_NOTE } from "../src/index.ts"
import { configured, makeFakeHa } from "./fakeHa.ts"

const respond = (status: number, body: string, type = "application/json") => () => new Response(body, { status, headers: { "content-type": type } })

describe("home-assistant: unreachable", () => {
  it.effect("down at the start: the module runs, says so, answers every command with it, and recovers on its own", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      ha.down()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      assert.strictEqual(kit.info()?.state, "running")
      assert.strictEqual(kit.info()?.status?.tone, "warning")
      assert.include(kit.info()?.status?.text ?? "", "Can't read Home Assistant yet")
      // Before the first read every chosen kind is offered, and says what is wrong.
      assert.include(kit.toolNames(), "home-assistant_climate_set")
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "invalid_params", message: "Unknown room or light \"kitchen\". Valid names: (none)" })
      assert.deepStrictEqual(yield* kit.action("lights_on", {}), { ok: false, code: "failed", message: "I couldn't reach Home Assistant." })
      const state = yield* kit.tool("home_state", {})
      assert.deepStrictEqual([state.ok, state.content], [false, "I couldn't reach Home Assistant."])
      // It comes back: the next background read loads the house, and the module starts again with what it has.
      ha.ok()
      yield* kit.advance(60_000)
      yield* kit.advance(10_000)
      assert.strictEqual(kit.info()?.state, "running")
      assert.strictEqual(kit.info()?.status?.tone, "ok")
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: true, say: "I've turned on the lights in Kitchen." })
    }))

  it.effect("down later: the last list is kept, the status says since when, and a command says it could not reach it", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      ha.down()
      yield* kit.advance(60_000)
      assert.strictEqual(kit.info()?.status?.tone, "warning")
      assert.include(kit.info()?.status?.text ?? "", "Couldn't refresh from Home Assistant")
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "kitchen" }), { ok: false, code: "failed", message: "I couldn't reach Home Assistant." })
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: false, code: "failed", message: "I couldn't reach Home Assistant." })
    }))

  it.effect("in Dutch", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), { ...configured(), household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      ha.down("service")
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "kitchen" }), { ok: false, code: "failed", message: "Ik kon Home Assistant niet bereiken." })
    }))
})

describe("home-assistant: slow", () => {
  it.effect("a command that gets no answer stops after 3 s, within the action's 5 s, says it may or may not have happened, and is not sent again", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ timeoutMs: 10_000 }))
      ha.hang("service")
      const fiber = yield* Effect.forkChild(kit.action("lights_off", { target: "kitchen" }))
      yield* kit.advance(3_000)
      assert.deepStrictEqual(yield* Fiber.join(fiber), { ok: false, code: "failed", message: "I sent it to Home Assistant but couldn't confirm that it happened; it may or may not have." })
      assert.strictEqual(ha.calls().length, 1)
      // A question that gets no answer says only that.
      ha.hang("template")
      const q = yield* Effect.forkChild(kit.action("lights_status"))
      yield* kit.advance(3_000)
      assert.deepStrictEqual(yield* Fiber.join(q), { ok: false, code: "failed", message: "Home Assistant didn't answer in time." })
    }))

  it.effect("a question on a turn never waits behind a slow background read", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ timeoutMs: 10_000 }))
      // The next template request (the background read, a minute on, with a 10 s limit) hangs.
      let hung = false
      ha.answer("template", (init) => {
        hung = true
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      })
      yield* kit.advance(60_000)
      assert.isTrue(hung)
      const started = yield* kit.now
      // While it hangs, a question reads the house at once.
      ha.ok()
      assert.deepStrictEqual(yield* kit.action("lights_status"), { ok: true, say: "Ceiling is on." })
      assert.strictEqual((yield* kit.now) - started, 0)
    }))

  it.effect("slow at the start: the start does not wait past its limit, and the module runs", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      ha.hang("template")
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured({ timeoutMs: 10_000 }))
      assert.strictEqual(kit.info()?.state, "running")
      assert.strictEqual(kit.info()?.status?.tone, "warning")
    }))
})

describe("home-assistant: rubbish", () => {
  it.effect("a template answer that is not the room list, at the start: the module runs and says it cannot read it", () =>
    Effect.gen(function*() {
      for (const body of ["<html>proxy error</html>", "{\"areas\": 5}", "null", "[]"]) {
        const ha = makeFakeHa()
        ha.answer("template", respond(200, body, "text/plain"))
        const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
        assert.strictEqual(kit.info()?.state, "running", body)
        assert.include(kit.info()?.status?.text ?? "", "cannot read", body)
        assert.deepStrictEqual(yield* kit.action("lights_on", {}), { ok: false, code: "failed", message: "Home Assistant sent an answer I can't read." }, body)
      }
    }))

  it.effect("entries of the wrong shape are left out one by one; ids that are not Home Assistant's are never cut but left out", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const long = "a".repeat(HOUSE_LIMITS.idChars)
      // Every page answers the same rows: what is not of the page's kinds, or came already, is left out too.
      ha.answer("template", respond(200, JSON.stringify({
        last: null,
        more: false,
        // The same rows for the page of areas and for each page of entities: what is not of the page's kind is left out.
        rows: [
          { id: "kitchen", name: "Kitchen" },
          { id: "Bad Id", name: "Bad" },
          { id: 5 },
          "x",
          { id: "light.kitchen", name: "Kitchen\nlight‮", state: "on", area: "kitchen", brightness: 9999 },
          { id: `light.${long}`, name: "Too long", state: "on" },
          { id: "light.UPPER", name: "Upper", state: "on" },
          { id: "weird", state: "on" },
          { id: "vacuum.robot", name: "Robot", state: "docked" },
          { id: "light.nameless", state: 5, area: "nowhere", brightness: "high" },
          7
        ]
      }), "text/plain"))
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      const r = yield* kit.tool("home_state", {})
      assert.deepStrictEqual(r.value, { note: OUTSIDE_NOTE, rooms: [{ room: "Kitchen", things: ["Kitchen light: on, 100%"] }, { room: "Without a room", things: ["Nameless: unknown"] }] })
    }))

  it.effect("a page larger than the limit is asked again smaller, and an answer that stays too large is refused, not read", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      ha.answer("template", () => ({ status: 200, headers: { "content-type": "text/plain" }, body: "x".repeat(HOUSE_LIMITS.pageBytes + 1) }))
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      assert.include(kit.info()?.status?.text ?? "", "too large")
      assert.deepStrictEqual(ha.pages().map((p) => p.size), [HOUSE_LIMITS.pageRows, HOUSE_LIMITS.pageRows / 8, 3, 1])
    }))

  it.effect("errors from Home Assistant: 400 and 404 are definite, 503 and 500 may have come after part of it, a token refused later", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      const unconfirmed = { ok: false, code: "failed", message: "I sent it to Home Assistant but couldn't confirm that it happened; it may or may not have." } as const
      ha.answer("service", respond(503, "{\"message\": \"starting\"}"))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), unconfirmed)
      ha.answer("service", respond(500, "{\"message\": \"boom\"}"))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), unconfirmed)
      for (const status of [400, 404]) {
        ha.answer("service", respond(status, "{\"message\": \"no such service\"}"))
        assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "Home Assistant reported an error." }, String(status))
      }
      ha.answer("service", respond(401, "401: Unauthorized", "text/plain"))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "Home Assistant refused my access token; a new one can be set on the module's page." })
    }))

  it.effect("a device removed in Home Assistant since: after the next read it is no longer a name the command takes", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      delete ha.entities["light.bedside"]
      yield* kit.advance(60_000)
      const r = yield* kit.action("lights_on", { target: "bedside lamp" })
      assert.isFalse(r.ok)
      if (!r.ok) assert.strictEqual(r.code, "invalid_params")
      assert.deepStrictEqual(ha.calls(), [])
    }))
})
