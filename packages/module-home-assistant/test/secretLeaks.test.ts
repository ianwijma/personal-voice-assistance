/**
 * No configured token leaks into an error, a log line, a status line or the
 * card's info, whatever Home Assistant (or a proxy in front of it) sends back:
 * every failure of start, actions, tools and the background refresh, with the
 * token planted in every position the upstream controls.
 */
import { assert, describe, it } from "@effect/vitest"
import type { ExtendedModuleInstance } from "@pva/core"
import { Effect, Exit, Scope } from "effect"
import { homeAssistantModule } from "../src/index.ts"
import { captureLogs, KEYS, leaksOf, planted, serialise } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

const hang = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
  })

const inventory = JSON.stringify({
  areas: [{ id: "kitchen", name: "Kitchen", lights: ["light.kitchen"] }],
  lights: [{ id: "light.kitchen", name: "Kitchen light", state: "on", brightness: 128 }]
})

type Answer = (init?: RequestInit) => Promise<Response>
const ok = (body: string): Answer => async () => respond(200, body)

/** Ways one call can fail, with `p` (the planted token text) wherever the upstream decides. */
const failures = (p: string): ReadonlyArray<readonly [string, Answer]> => [
  ...[400, 401, 403, 404, 405, 500, 502, 503].flatMap((status) => [
    [`${status} JSON`, async () => respond(status, JSON.stringify({ message: p }), { "x-request-id": p })] as const,
    [`${status} text`, async () => respond(status, `proxy: ${p}\n\n${p}`, { "content-type": "text/plain" })] as const
  ]),
  ["connection error with a code", () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(p), { code: p }) }))],
  ["connection error", () => Promise.reject(new Error(p))],
  ["non-Error rejection", () => Promise.reject(p)],
  ["timeout", hang]
]

const fetchFor = (routes: { config: Answer; template: Answer; service: Answer }): Fetch => (input, init) => {
  const url = String(input)
  if (url.endsWith("/api/config")) return routes.config(init)
  if (url.endsWith("/api/template")) return routes.template(init)
  return routes.service(init)
}

const withLogs = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    const logs: Array<string> = []
    const exit = yield* effect.pipe(
      Effect.exit,
      Effect.provide(captureLogs(logs))
    )
    return { exit, logs }
  })

const assertNoLeak = (key: string, what: string, text: string) =>
  assert.deepStrictEqual(leaksOf(key, text), [], `${what} leaked the token: ${text.slice(0, 2000)}`)

const settings = (token: string) => ({
  baseUrl: "http://ha.test:8123",
  token,
  domains: ["light"] as ReadonlyArray<"light">,
  aliases: "",
  timeoutMs: 300
})

const startWith = (token: string, fetch: Fetch, refreshMs = 60_000) =>
  Effect.gen(function*() {
    const statuses: Array<string> = []
    const scope = yield* Scope.make()
    const { exit, logs } = yield* withLogs(
      homeAssistantModule({ fetch, refreshMs }).start({
        settings: settings(token),
        setStatus: (s) => {
          if (s !== undefined) statuses.push(s.text)
        }
      }).pipe(Scope.provide(scope))
    )
    return { exit, logs, statuses, scope }
  })

describe("credentials never leak (module-home-assistant)", () => {
  for (const key of KEYS) {
    it.live(`start: every failure of the config and template calls, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        const cases: ReadonlyArray<readonly [string, Fetch]> = [
          ...failures(p).map(([what, answer]) => [`config ${what}`, fetchFor({ config: answer, template: ok(inventory), service: ok("[]") })] as const),
          ["config 200 not JSON", fetchFor({ config: ok(`<html>${p}</html>`), template: ok(inventory), service: ok("[]") })],
          ["config 200 wrong shape", fetchFor({ config: ok(JSON.stringify({ version: 5, location_name: { p } })), template: ok(inventory), service: ok("[]") })],
          ...failures(p).map(([what, answer]) => [`template ${what}`, fetchFor({ config: ok("{}"), template: answer, service: ok("[]") })] as const),
          // The reviewer's case: a 200 template answer that echoes the token but is not the inventory.
          ["template 200 echo, not the inventory", fetchFor({ config: ok("{}"), template: ok(`{"areas": "${p}"`), service: ok("[]") })],
          ["template 200 JSON of the wrong shape", fetchFor({ config: ok("{}"), template: ok(JSON.stringify({ areas: p, lights: [p] })), service: ok("[]") })]
        ]
        for (const [what, fetch] of cases) {
          const { exit, logs, statuses, scope } = yield* startWith(key, fetch)
          yield* Scope.close(scope, Exit.void)
          assert.isTrue(Exit.isFailure(exit), `${what}: expected a start error`)
          assertNoLeak(key, what, `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs.join("\n")}\n${statuses.join("\n")}`)
          assert.match(String(exit), /Home Assistant/, what)
        }
      }), 60_000)

    it.live(`running: status line, info, actions, tool and refresh, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        for (const [what, failure] of [...failures(p), ["200 not the inventory", ok(`{"areas": "${p}"`)] as const]) {
          let failing = false
          const fetch = fetchFor({
            config: ok(JSON.stringify({ version: p, location_name: p })),
            template: (init) => (failing ? failure(init) : ok(inventory)()),
            service: (init) => (failing ? failure(init) : ok("[]")())
          })
          const { exit, logs, statuses, scope } = yield* startWith(key, fetch, 50)
          assert.isTrue(Exit.isSuccess(exit), `${what}: ${String(exit)}`)
          const instance = (exit as Exit.Success<ExtendedModuleInstance>).value
          failing = true
          const results: Array<unknown> = [instance.info?.()]
          for (const action of instance.actions ?? []) {
            const params = action.id === "set_brightness" ? { target: "area:kitchen", level: 30 } : { target: "area:kitchen" }
            results.push(yield* withLogs(action.run(params as never)))
          }
          for (const tool of instance.tools ?? []) results.push(yield* withLogs(tool.execute({})))
          yield* Effect.sleep(400) // the background refresh fails too
          yield* Scope.close(scope, Exit.void)
          assertNoLeak(key, what, `${serialise(results)}\n${logs.join("\n")}\n${statuses.join("\n")}`)
        }
      }), 60_000)
  }
})
