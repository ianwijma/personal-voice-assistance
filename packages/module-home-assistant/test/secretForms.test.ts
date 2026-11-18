// A configured secret in a successful answer, in each form it could take (as written, percent-encoded, base64,
// base64url), compared with decoded text: a token with a quote in it, escaped in the answer's JSON, is still found.
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { HomeAssistant } from "@pva/module-contracts"
import { Effect } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { secretForms } from "../src/secrets.ts"
import { defaultEntities, type FakeEntity, makeFakeHa, URL_BASE } from "./fakeHa.ts"
import { KEYS } from "./leaks.ts"

/** The reviewer's token: a quote, a percent sign, a plus and a slash (escaped in JSON, changed by every encoding). */
const KEY = KEYS[0]
const b64 = Buffer.from(KEY).toString("base64")
const FORMS: ReadonlyArray<readonly [string, string]> = [
  ["as written", KEY],
  ["percent-encoded", encodeURIComponent(KEY)],
  ["base64", b64],
  ["base64url", b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")]
]

const start = (entities: Record<string, FakeEntity>, locationName?: string) =>
  Effect.gen(function*() {
    const ha = makeFakeHa({ token: KEY, entities, ...(locationName !== undefined ? { locationName } : {}) })
    const kit = yield* startTestModule(homeAssistantModule({ net: ha.net }), { settings: { baseUrl: URL_BASE }, secrets: { token: KEY } })
    return { ha, kit, service: kit.service(HomeAssistant)! }
  })

describe("home-assistant: a configured secret in any of its forms", () => {
  it.effect("each form is one the module looks for, and they differ from the token as written", () =>
    Effect.gen(function*() {
      assert.isTrue(FORMS.slice(1).every(([, f]) => f !== KEY))
      for (const [what, form] of FORMS) assert.include(secretForms([KEY]), form, what)
    }))

  it.effect("a successful service answer holding the token with its quote, or a form of it, at any depth or as a key: cut", () =>
    Effect.gen(function*() {
      const { ha, kit, service } = yield* start(defaultEntities())
      const call = { domain: "media_player", service: "browse_media", target: { entityIds: ["media_player.kitchen"] }, returnResponse: true } as const
      const answers: Array<unknown> = []
      for (const [what, form] of FORMS) {
        for (const response of [{ echo: form }, { items: [{ title: `x ${form} y` }] }, { [form]: 1 }]) {
          ha.respondWith(response)
          const got = yield* service.callService(call)
          assert.deepStrictEqual(got, { responseCut: true }, what)
          answers.push(got)
        }
      }
      // An ordinary answer is handed on as it is.
      ha.respondWith({ items: [{ title: "Basic Bedroom" }] })
      assert.deepStrictEqual(yield* service.callService(call), { response: { items: [{ title: "Basic Bedroom" }] } })
      yield* kit.expectNoSecrets(answers)
    }))

  it.effect("a name, a state or a media title holding a form is left out whole and counted; the location name is not shown", () =>
    Effect.gen(function*() {
      const entities: Record<string, FakeEntity> = { "light.kitchen": { name: "Kitchen light", state: "off", area: "kitchen" } }
      for (const [i, [, form]] of FORMS.entries()) {
        entities[`light.name_${i}`] = { name: `Lamp ${form}`, state: "off", area: "kitchen" }
        entities[`sensor.state_${i}`] = { name: `Sensor ${i}`, state: form, area: "kitchen", class: "temperature" }
        entities[`media_player.title_${i}`] = { name: `Player ${i}`, state: "playing", title: `Song ${form}`, area: "kitchen" }
      }
      const { kit, service } = yield* start(entities, `Home ${b64}`)
      assert.deepStrictEqual(service.entities().map((e) => e.entityId), ["light.kitchen"])
      assert.include(String(kit.info()?.settings.values.lists), `${3 * FORMS.length} left out because a name or state held the token`)
      const state = yield* kit.tool("home_state", {})
      for (const [, form] of FORMS) {
        assert.notInclude(state.content, form)
        assert.notInclude(JSON.stringify(kit.info()), form)
      }
      yield* kit.expectNoSecrets(state, service.entities(), kit.info())
    }))
})
