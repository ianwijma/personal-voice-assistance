/**
 * Credentials at the edges of the module (third review, family 1): an address
 * with credentials of its own, a malformed one, every cut with whitespace
 * before the token, and anything thrown while building a request.
 */
import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { checkAddressSetting, HomeAssistantError, homeAssistantModule, makeHomeAssistantClient } from "../src/index.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, loadedError, serialise, straddling } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const KEY = KEYS[0]
const { user, password, query } = ADDRESS_SECRETS
const credentialAddress = `http://${user}:${password}@ha.test:8123?token=${query}`

const undiciLike: Fetch = (input) =>
  Promise.reject(new TypeError(`Request cannot be constructed from a URL that includes credentials: ${String(input)}`))

const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(captureLogs(logs))
    )
    return { exit, logs: logs.join("\n") }
  })

const textOf = (exit: Exit.Exit<unknown, unknown>, logs = "") => `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs}`

const assertNoLeak = (secrets: ReadonlyArray<string>, what: string, text: string) => {
  for (const s of secrets) assert.deepStrictEqual(leaksOf(s, text), [], `${what} leaked ${s}: ${text.slice(0, 1500)}`)
}

const assertTypedFailure = (exit: Exit.Exit<unknown, unknown>, what: string) => {
  assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
  if (Exit.isFailure(exit)) assert.isFalse(Cause.hasDies(exit.cause), `${what}: died instead of failing: ${String(exit.cause)}`)
}

const start = (baseUrl: string, fetch: Fetch, token: string = KEY) =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    const r = yield* withLogs(Effect.scoped(homeAssistantModule({ fetch, refreshMs: 60_000 }).start({
      settings: { baseUrl, token, domains: ["light"], aliases: "", timeoutMs: 300 } as never,
      setStatus: (s: { text: string } | undefined) => void (s && statuses.push(s.text))
    } as never)))
    return { ...r, statuses: statuses.join("\n") }
  })

describe("credentials in the configured address (module-home-assistant)", () => {
  it.live("start and client refuse user-info and a query without echoing them", () =>
    Effect.gen(function*() {
      const s = yield* start(credentialAddress, undiciLike)
      assertTypedFailure(s.exit, "start")
      assertNoLeak([KEY, user, password, query], "start", `${textOf(s.exit, s.logs)}\n${s.statuses}`)
      assert.match(String(s.exit), /user name or password/)
      const client = makeHomeAssistantClient({ baseUrl: credentialAddress, token: KEY, timeoutMs: 300, fetch: undiciLike })
      const c = yield* withLogs(client.config)
      assertTypedFailure(c.exit, "client")
      assertNoLeak([KEY, user, password, query], "client", `${textOf(c.exit, c.logs)}\n${client.baseUrl}`)
      const problem = checkAddressSetting(credentialAddress)
      assert.isDefined(problem)
      assertNoLeak([user, password, query], "check", problem!)
      assert.isUndefined(checkAddressSetting("http://homeassistant.local:8123"))
    }))

  for (const address of [`http://[${KEY}`, `http://u:${KEY}@[::1`, `ht tp://${KEY}`]) {
    it.live(`malformed address ${JSON.stringify(address.slice(0, 12))}: a sanitised failure`, () =>
      Effect.gen(function*() {
        const client = makeHomeAssistantClient({ baseUrl: address, token: "other", timeoutMs: 300, fetch: undiciLike })
        const c = yield* withLogs(client.config)
        assertTypedFailure(c.exit, address)
        assertNoLeak([KEY], address, `${textOf(c.exit, c.logs)}\n${client.baseUrl}`)
        const s = yield* start(address, undiciLike, "other")
        assertTypedFailure(s.exit, `${address} (start)`)
        assertNoLeak([KEY], `${address} (start)`, `${textOf(s.exit, s.logs)}\n${s.statuses}`)
      }))
  }
})

describe("shortened text and construction failures (module-home-assistant)", () => {
  it.live("every cut (120, 200 and the upstream window) with whitespace or filler before the token", () =>
    Effect.gen(function*() {
      for (const length of [120, 200, 65_536]) {
        for (const fill of [" ", "\n", "y"]) {
          for (const body of straddling(KEY, length, KEY.length, fill)) {
            const config: Fetch = async (input) =>
              String(input).endsWith("/api/config")
                ? new Response(JSON.stringify({ version: "2026.11" }), { status: 200 })
                : new Response(body, { status: 200 })
            const s = yield* start("http://ha.test:8123", config)
            assertNoLeak([KEY], `template cut ${length}`, `${textOf(s.exit, s.logs)}\n${s.statuses}`)
            const client = makeHomeAssistantClient({ baseUrl: "http://ha.test:8123", token: KEY, timeoutMs: 300, fetch: async () => new Response(body, { status: 500 }) })
            const c = yield* withLogs(client.config)
            assertNoLeak([KEY], `http cut ${length}`, textOf(c.exit, c.logs))
          }
        }
      }
    }), 120_000)

  it.live("a getter that throws, a body that throws while serialised, a fetch that throws", () =>
    Effect.gen(function*() {
      const thrown = () => loadedError(KEYS[1])
      const secrets = [KEYS[1]]
      const getter = makeHomeAssistantClient({
        token: KEYS[1],
        get baseUrl(): string {
          throw thrown()
        },
        timeoutMs: 300,
        fetch: undiciLike
      })
      const a = yield* withLogs(getter.config)
      assertTypedFailure(a.exit, "getter")
      assertNoLeak(secrets, "getter", textOf(a.exit, a.logs))
      for (const fetch of [(() => { throw thrown() }) as unknown as Fetch, (() => Promise.reject(thrown())) as Fetch]) {
        const client = makeHomeAssistantClient({ baseUrl: "http://ha.test:8123", token: KEYS[1], timeoutMs: 300, fetch })
        for (const call of [client.config, client.callService("light", "turn_on", { toJSON: () => { throw thrown() } } as never), client.renderTemplate("x")]) {
          const b = yield* withLogs(call)
          assertTypedFailure(b.exit, "call")
          assertNoLeak(secrets, "call", textOf(b.exit, b.logs))
          if (Exit.isFailure(b.exit)) assert.instanceOf(Cause.squash(b.exit.cause), HomeAssistantError)
        }
        const s = yield* start("http://ha.test:8123", fetch, KEYS[1])
        assertTypedFailure(s.exit, "start")
        assertNoLeak(secrets, "start", `${textOf(s.exit, s.logs)}\n${s.statuses}`)
      }
    }))
})
