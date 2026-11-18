/**
 * No configured token, nor a credential typed into the address, leaks into the admin page (error, status line, form,
 * Health issues), a log line, an action's words or a tool result, whatever Home Assistant (or a proxy in front of it)
 * sends back: every failure of the start, the commands, the tool, the background read and the health check, with the
 * token planted in every position the upstream controls. Through the real host (the test kit).
 */
import { assert, describe, it } from "@effect/vitest"
import { startTestModule } from "@pva/core/testing"
import { Effect } from "effect"
import { checkAddressSetting, homeAssistantModule, makeHomeAssistantClient } from "../src/index.ts"
import { makeFakeHa, URL_BASE } from "./fakeHa.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, planted, serialise } from "./leaks.ts"

type Answer = (init?: RequestInit) => Response | Promise<Response>

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

/** Ways one call can fail, with `p` (the planted token text) wherever the upstream decides. */
const failures = (p: string): ReadonlyArray<readonly [string, Answer]> => [
  ...[400, 401, 403, 404, 500, 503].flatMap((status) => [
    [`${status} JSON`, () => respond(status, JSON.stringify({ message: p }), { "x-request-id": p })] as const,
    [`${status} text`, () => respond(status, `proxy: ${p}\n\n${p}`, { "content-type": "text/plain" })] as const
  ]),
  ["connection error with a code", () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(p), { code: p }) }))],
  ["connection error", () => Promise.reject(new Error(p))],
  ["non-Error rejection", () => Promise.reject(p)],
  ["200 that is not the room list", () => respond(200, `{"areas": "${p}"`)],
  ["200 of the wrong shape", () => respond(200, JSON.stringify({ areas: p, entities: [p] }))]
]

const assertNoLeak = (secrets: ReadonlyArray<string>, what: string, text: string) => {
  for (const s of secrets) assert.deepStrictEqual(leaksOf(s, text), [], `${what} leaked ${s}: ${text.slice(0, 1500)}`)
}

const COMMANDS: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ["lights_on", { target: "kitchen" }],
  ["set_brightness", { target: "kitchen", level: 30 }],
  ["lights_status", {}],
  ["switches_on", { target: "coffee machine" }],
  ["climate_set", { target: "living room", temperature: 20 }],
  ["climate_status", {}],
  ["covers_open", { target: "living room" }],
  ["locks_status", {}]
]

describe("credentials never leak (module-home-assistant)", () => {
  for (const key of KEYS) {
    it.effect(`start: every failure of the config and template calls, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        for (const route of ["config", "template"] as const) {
          for (const [what, answer] of failures(p)) {
            const logs: Array<string> = []
            const ha = makeFakeHa({ token: key })
            ha.answer(route, answer)
            const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { settings: { baseUrl: URL_BASE }, secrets: { token: key } }).pipe(Effect.provide(captureLogs(logs)))
            assertNoLeak([key], `${route} ${what}`, `${serialise(kit.info())}\n${serialise(kit.issues())}\n${logs.join("\n")}`)
            assert.match(serialise(kit.info()), /Home Assistant/, `${route} ${what}`)
            if (key.length >= 4) yield* kit.expectNoSecrets()
          }
        }
      }), 60_000)

    it.effect(`running: status line, form, commands, tool, background read and health, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        for (const [what, failure] of failures(p)) {
          const logs: Array<string> = []
          const ha = makeFakeHa({ token: key })
          const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { settings: { baseUrl: URL_BASE }, secrets: { token: key } }).pipe(Effect.provide(captureLogs(logs)))
          ha.answer("template", failure)
          ha.answer("service", failure)
          ha.answer("config", failure)
          const results: Array<unknown> = [kit.info()]
          for (const [id, params] of COMMANDS) results.push(yield* kit.action(id, params))
          results.push(yield* kit.tool("home_state", {}))
          results.push(yield* kit.tool("home-assistant_lights_off", { target: "kitchen" }))
          yield* kit.advance(60_000)
          results.push(yield* kit.checkHealth)
          results.push(kit.info(), kit.issues())
          assertNoLeak([key], what, `${serialise(results)}\n${logs.join("\n")}`)
          if (key.length >= 4) yield* kit.expectNoSecrets(results)
        }
      }), 60_000)
  }

  it.effect("an address with a user name, a password or a query: refused without echoing them, on the page, in the check and in the client", () =>
    Effect.gen(function*() {
      const { user, password, query } = ADDRESS_SECRETS
      const address = `http://${user}:${password}@ha.test:8123?token=${query}`
      const ha = makeFakeHa()
      const kit = yield* startTestModule(homeAssistantModule({ fetch: ha.fetch }), { settings: { baseUrl: address }, secrets: { token: KEYS[0] } })
      assert.notStrictEqual(kit.info()?.state, "running")
      const problem = checkAddressSetting(address)
      assert.isDefined(problem)
      const client = makeHomeAssistantClient({ baseUrl: address, token: KEYS[0], timeoutMs: 300, fetch: ha.fetch })
      const exit = yield* Effect.exit(client.config())
      assertNoLeak([KEYS[0], user, password, query], "address", `${serialise(kit.info())}\n${serialise(kit.issues())}\n${problem}\n${serialise(exit)}\n${client.baseUrl}`)
      assert.deepStrictEqual(ha.requests, [])
    }))
})
