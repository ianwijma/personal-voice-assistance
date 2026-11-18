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
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
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
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
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
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { ...configured(), household: { home: { HOME_LANGUAGE: "nl-NL" } } })
      ha.down("service")
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "kitchen" }), { ok: false, code: "failed", message: "Ik heb het naar Home Assistant gestuurd, maar kon niet nagaan of het gebeurd is; misschien wel, misschien niet." })
    }))
})

describe("home-assistant: slow", () => {
  it.effect("a command that gets no answer stops after 3 s, within the action's 5 s, says it may or may not have happened, and is not sent again", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ timeoutMs: 10_000 }))
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
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ timeoutMs: 10_000 }))
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
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured({ timeoutMs: 10_000 }))
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
        const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
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
        areas: [{ id: "kitchen", name: "Kitchen" }, { id: "Bad Id", name: "Bad" }, { id: 5 }, "x"],
        entities: [
          { id: "light.kitchen", name: "Kitchen\nlight‮", state: "on", area: "kitchen", brightness: 9999 },
          { id: `light.${long}`, name: "Too long", state: "on" },
          { id: "light.UPPER", name: "Upper", state: "on" },
          { id: "weird", state: "on" },
          { id: "vacuum.robot", name: "Robot", state: "docked" },
          { id: "light.nameless", state: 5, area: "nowhere", brightness: "high" },
          7
        ]
      }), "text/plain"))
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      const r = yield* kit.tool("home_state", {})
      assert.deepStrictEqual(r.value, { note: OUTSIDE_NOTE, rooms: [{ room: "Kitchen", things: ["Kitchen light: on, 100%"] }, { room: "Without a room", things: ["Nameless: unknown"] }] })
    }))

  it.effect("an answer larger than the limit is not read past it", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      let cancelled = false
      ha.answer("template", () => {
        const chunk = new TextEncoder().encode("x".repeat(64 * 1024))
        let sent = 0
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) => {
            sent += chunk.byteLength
            controller.enqueue(chunk)
            if (sent > 64 * HOUSE_LIMITS.pageBytes) controller.close()
          },
          cancel: () => void (cancelled = true)
        })
        return new Response(body, { status: 200, headers: { "content-type": "text/plain" } })
      })
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      assert.isTrue(cancelled)
      assert.include(kit.info()?.status?.text ?? "", "too large")
      // A declared length over the limit is refused before the body is read.
      const declared = makeFakeHa()
      declared.answer("template", () => new Response("{}", { status: 200, headers: { "content-length": String(HOUSE_LIMITS.pageBytes + 1) } }))
      const other = yield* startTestModule(homeAssistantModule({ fetch: declared.fetch }), configured())
      assert.include(other.info()?.status?.text ?? "", "too large")
    }))

  it.effect("errors from Home Assistant: 503 restarting, 500, a token refused later", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      ha.answer("service", respond(503, "{\"message\": \"starting\"}"))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "Home Assistant is restarting. Try again in a minute." })
      ha.answer("service", respond(500, "{\"message\": \"boom\"}"))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "Home Assistant reported an error." })
      ha.answer("service", respond(401, "401: Unauthorized", "text/plain"))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "Home Assistant refused my access token; a new one can be set on the module's page." })
    }))

  it.effect("a device removed in Home Assistant since: after the next read it is no longer a name the command takes", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), configured())
      delete ha.entities["light.bedside"]
      yield* kit.advance(60_000)
      const r = yield* kit.action("lights_on", { target: "bedside lamp" })
      assert.isFalse(r.ok)
      if (!r.ok) assert.strictEqual(r.code, "invalid_params")
      assert.deepStrictEqual(ha.calls(), [])
    }))
})
