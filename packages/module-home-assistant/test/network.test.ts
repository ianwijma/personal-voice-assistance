// Every request goes through @pva/net's fetchOwnerConfiguredLan, as the kit's offline network sees it: GET for the
// config, a JSON POST for the template and for service calls, with the token in a header; no redirect followed, for a
// read or for a service call; loopback as the owner typed it; a POST that may have reached Home Assistant is said to
// be unconfirmed and is never sent again.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant } from "@pva/module-contracts"
import { Effect } from "effect"
import { homeAssistantModule, PAGE_TEMPLATE } from "../src/index.ts"
import { configured, makeFakeHa, TOKEN, URL_BASE } from "./fakeHa.ts"

describe("home-assistant: the network, through @pva/net", () => {
  it.effect("the config is a GET, a page and a service call are JSON POSTs with the token in a header, as the kit's network recorded them", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: true, say: "I've turned on the lights in Kitchen." })
      const [config, firstPage] = ha.sent
      assert.deepStrictEqual([config!.method, config!.url, config!.body], ["GET", `${URL_BASE}/api/config`, undefined])
      assert.strictEqual(firstPage!.method, "POST")
      assert.strictEqual(firstPage!.headers["content-type"], "application/json")
      const page = JSON.parse(firstPage!.body!) as { template: string; variables: { domains: Array<string> } }
      assert.strictEqual(page.template, PAGE_TEMPLATE)
      assert.deepStrictEqual(page.variables.domains, ["person"])
      const call = ha.sent.at(-1)!
      assert.deepStrictEqual([call.method, call.url, JSON.parse(call.body!)], ["POST", `${URL_BASE}/api/services/light/turn_on`, { entity_id: ["light.kitchen"] }])
      assert.isTrue(ha.sent.every((r) => r.headers.authorization === `Bearer ${TOKEN}` && r.address === "192.168.1.20"))
    }))

  it.effect("a redirect answer is never followed: not for the config, a page or a service call; nothing goes to the other place", () =>
    Effect.gen(function*() {
      // To the same server, so a request that followed it would be seen by the kit's network.
      const elsewhere = `${URL_BASE}/unexpected`
      const redirect = () => ({ status: 307, headers: { location: elsewhere }, body: "" })
      const ha = makeFakeHa()
      ha.answer("config", redirect)
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      assert.include(kit.info()?.status?.text ?? "", "Can't read Home Assistant yet")
      ha.ok()
      ha.answer("template", redirect)
      yield* kit.advance(60_000)
      assert.strictEqual(kit.info()?.status?.tone, "warning")
      ha.ok()
      yield* kit.advance(60_000)
      yield* kit.advance(10_000)
      assert.strictEqual(kit.info()?.status?.tone, "ok")
      ha.answer("service", redirect)
      // A redirect to a POST: refused by its own rule, so nothing happened and the module says it could not reach it.
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "I couldn't reach Home Assistant." })
      const e = yield* Effect.flip(kit.service(HomeAssistant)!.callService({ domain: "media_player", service: "media_pause", target: { entityIds: ["media_player.kitchen"] } }))
      assert.strictEqual(e.reason, "not_connected")
      assert.include(e.detail, "post-redirect")
      assert.isFalse(ha.sent.some((r) => r.url.endsWith("/unexpected")))
      assert.strictEqual(ha.calls().length, 2)
    }))

  it.effect("an owner whose saved address is http://localhost:8123 keeps working: loopback as the owner typed it", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa({ base: "http://localhost:8123" })
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), { settings: { baseUrl: "http://localhost:8123" }, secrets: { token: TOKEN } })
      assert.strictEqual(kit.info()?.status?.tone, "ok")
      assert.deepStrictEqual(yield* kit.action("lights_off", { target: "kitchen" }), { ok: true, say: "I've turned off the lights in Kitchen." })
      assert.isTrue(ha.sent.every((r) => r.address === "127.0.0.1"))
    }))

  it.effect("a refused connect sent nothing: it could not reach it; a connection lost after the POST was written: it may or may not have happened; never sent twice", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      ha.down("service")
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "I couldn't reach Home Assistant." })
      assert.strictEqual(ha.calls().length, 1)
      ha.ok()
      ha.answer("service", () => Promise.reject(new Error("socket hang up")))
      assert.deepStrictEqual(yield* kit.action("lights_on", { target: "kitchen" }), { ok: false, code: "failed", message: "I sent it to Home Assistant but couldn't confirm that it happened; it may or may not have." })
      const e = yield* Effect.flip(kit.service(HomeAssistant)!.callService({ domain: "media_player", service: "media_pause", target: { entityIds: ["media_player.kitchen"] } }))
      assert.strictEqual(e.reason, "timeout")
      assert.include(e.detail, "it may or may not have happened")
      assert.strictEqual(ha.calls().length, 3)
    }))

  it.effect("an answer that is neither JSON nor text (a proxy's web page) is not read", () =>
    Effect.gen(function*() {
      const ha = makeFakeHa()
      ha.answer("template", () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>proxy</html>" }))
      const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), configured())
      assert.strictEqual(kit.info()?.status?.tone, "warning")
      assert.deepStrictEqual(yield* kit.action("lights_on", {}), { ok: false, code: "failed", message: "I couldn't reach Home Assistant." })
    }))
})
