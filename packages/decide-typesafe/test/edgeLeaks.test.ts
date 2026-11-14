/**
 * Credentials at the edges of the adapter (third review, finding 1: "TypeSafe
 * also interpolates its base URL into connection errors"): a base address with
 * credentials of its own, a malformed one, every cut with whitespace before the
 * key, and anything thrown while building a request.
 */
import { assert, describe, it } from "@effect/vitest"
import { DecisionError } from "@pva/core"
import { Cause, Effect, Exit, Redacted } from "effect"
import { checkUrl, makeJevDecider } from "../src/decider.ts"
import { makeJevClient, pingRequest } from "../src/JevClient.ts"
import { ADDRESS_SECRETS, captureLogs, KEYS, leaksOf, loadedError, serialise, straddling } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const KEY = KEYS[0]
const { user, password, query } = ADDRESS_SECRETS
const credentialAddress = `https://${user}:${password}@api.typesafe.test?token=${query}`

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

const startDecider = (settings: Record<string, unknown>, fetch: Fetch) =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    const r = yield* withLogs(Effect.scoped(makeJevDecider({ fetch }).start({
      settings: { apiKey: KEY, baseUrl: "https://api.typesafe.test", model: "jev-1.14.0", timeoutMs: 300, ...settings } as never,
      setStatus: (s: { text: string } | undefined) => void (s && statuses.push(s.text))
    } as never)))
    return { ...r, statuses: statuses.join("\n") }
  })

describe("credentials in the configured address (decide-typesafe)", () => {
  it.live("client: user-info and query in the base address are refused without echoing them", () =>
    Effect.gen(function*() {
      const client = makeJevClient({ apiKey: Redacted.make(KEY), baseUrl: credentialAddress, timeoutMs: 300, fetch: undiciLike })
      const { exit, logs } = yield* withLogs(client.decide(pingRequest))
      assertTypedFailure(exit, "client")
      assertNoLeak([KEY, user, password, query], "client", textOf(exit, logs))
      assert.match(String(exit), /user name or password/)
    }))

  it.live("decider: a start error that does not repeat them, and the setting check refuses them", () =>
    Effect.gen(function*() {
      const { exit, logs, statuses } = yield* startDecider({ baseUrl: credentialAddress }, undiciLike)
      assertTypedFailure(exit, "decider")
      assertNoLeak([KEY, user, password, query], "decider", `${textOf(exit, logs)}\n${statuses}`)
      const problem = checkUrl(credentialAddress)
      assert.isDefined(problem)
      assertNoLeak([user, password, query], "check", problem!)
      assert.isUndefined(checkUrl("https://api.typesafe.ai"))
    }))

  for (const address of [`https://[${KEY}`, `https://u:${KEY}@[::1`, `ht tp://${KEY}`]) {
    it.live(`malformed address ${JSON.stringify(address.slice(0, 12))}: a sanitised failure`, () =>
      Effect.gen(function*() {
        const client = makeJevClient({ apiKey: Redacted.make("other"), baseUrl: address, timeoutMs: 300, fetch: undiciLike })
        const { exit, logs } = yield* withLogs(client.decide(pingRequest))
        assertTypedFailure(exit, address)
        assertNoLeak([KEY], address, textOf(exit, logs))
        assertNoLeak([KEY], `${address} (check)`, checkUrl(address) ?? "")
      }))
  }
})

describe("shortened text and construction failures (decide-typesafe)", () => {
  it.live("every cut (300 and the upstream window) with whitespace or filler before the key", () =>
    Effect.gen(function*() {
      for (const length of [119, 120, 300, 65_536]) {
        for (const fill of [" ", "\n", "y"]) {
          for (const body of straddling(KEY, length, KEY.length, fill)) {
            for (const shaped of [body, JSON.stringify({ detail: body })]) {
              const client = makeJevClient({ apiKey: Redacted.make(KEY), baseUrl: "https://api.typesafe.test", timeoutMs: 300, fetch: async () => new Response(shaped, { status: 422 }) })
              const { exit, logs } = yield* withLogs(client.decide(pingRequest))
              assertNoLeak([KEY], `cut ${length}`, textOf(exit, logs))
            }
          }
        }
      }
    }), 120_000)

  it.live("a getter that throws, a request that throws while serialised, a fetch that throws", () =>
    Effect.gen(function*() {
      const thrown = () => loadedError(KEYS[1])
      const secrets = [KEYS[1]]
      const getter = makeJevClient({
        apiKey: Redacted.make(KEYS[1]),
        get baseUrl(): string {
          throw thrown()
        },
        timeoutMs: 300,
        fetch: undiciLike
      })
      const a = yield* withLogs(getter.decide(pingRequest))
      assertTypedFailure(a.exit, "getter")
      assertNoLeak(secrets, "getter", textOf(a.exit, a.logs))
      const bad = { ...pingRequest, state: { toJSON: () => { throw thrown() } } as never }
      for (const fetch of [(() => { throw thrown() }) as unknown as Fetch, (() => Promise.reject(thrown())) as Fetch]) {
        const client = makeJevClient({ apiKey: Redacted.make(KEYS[1]), baseUrl: "https://api.typesafe.test", timeoutMs: 300, fetch })
        for (const request of [pingRequest, bad]) {
          const b = yield* withLogs(client.decide(request))
          assertTypedFailure(b.exit, "decide")
          assertNoLeak(secrets, "decide", textOf(b.exit, b.logs))
          if (Exit.isFailure(b.exit)) assert.instanceOf(Cause.squash(b.exit.cause), DecisionError)
        }
      }
    }))
})
