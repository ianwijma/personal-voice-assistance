/**
 * No configured credential leaks into an error, a log line or a status line,
 * whatever TypeSafe (or anything at its address) sends back: every failure the
 * client has, with the credential planted in every position the upstream
 * controls (bodies, validation details, `Retry-After`, schema diagnostics).
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Redacted } from "effect"
import { makeJevDecider } from "../src/decider.ts"
import { makeJevClient, pingRequest } from "../src/JevClient.ts"
import { captureLogs, KEYS, leaksOf, planted, serialise, straddling } from "./leaks.ts"

type Fetch = typeof globalThis.fetch

const respond = (status: number, body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } })

const hang: Fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")))
  })

const scenarios = (p: string): ReadonlyArray<readonly [string, Fetch]> => {
  const headers = { "retry-after": p, "x-request-id": p }
  return [
    ...[400, 401, 403, 404, 413, 415, 422, 429, 500, 503, 529].flatMap((status) => [
      [`${status} {detail: string}`, async () => respond(status, JSON.stringify({ detail: p }), headers)] as const,
      [`${status} {detail: [{loc,msg}]}`, async () => respond(status, JSON.stringify({ detail: [{ loc: ["body", p], msg: p, input: p }] }), headers)] as const,
      [`${status} {detail: object}`, async () => respond(status, JSON.stringify({ detail: { why: p } }), headers)] as const,
      [`${status} {error:{message}}`, async () => respond(status, JSON.stringify({ error: { message: p } }), headers)] as const,
      [`${status} text`, async () => respond(status, `proxy: ${p}`, { ...headers, "content-type": "text/plain" })] as const
    ]),
    ["429 with a date in Retry-After that is the key", async () => respond(429, "{}", { "retry-after": p })],
    ["200 not JSON", async () => respond(200, `<html>${p}</html>`)],
    ["200 wrong shape (top level)", async () => respond(200, JSON.stringify({ answers: p, model: p }))],
    ["200 wrong shape (answer name and value)", async () => respond(200, JSON.stringify({ answers: { [p]: { type: "noul", noul: p } } }))],
    ["200 wrong shape (choice)", async () => respond(200, JSON.stringify({ answers: { fits: { type: "choice", choice: 1, probabilities: { [p]: p } } } }))],
    ["connection error with a cause", () => Promise.reject(new TypeError("fetch failed", { cause: new Error(`getaddrinfo ENOTFOUND ${p}`) }))],
    ["connection error", () => Promise.reject(new Error(p))],
    ["non-Error rejection", () => Promise.reject({ p })],
    ["timeout", hang]
  ]
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
  assert.deepStrictEqual(leaksOf(key, text), [], `${what} leaked the credential: ${text.slice(0, 2000)}`)

describe("credentials never leak (decide-typesafe)", () => {
  for (const key of KEYS) {
    it.live(`every failure of a decision, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        for (const [what, fetch] of scenarios(planted(key))) {
          const client = makeJevClient({ apiKey: Redacted.make(key), baseUrl: "http://upstream.test", timeoutMs: 150, fetch })
          const { exit, logs } = yield* withLogs(client.decide(pingRequest))
          assert.isTrue(Exit.isFailure(exit), `${what}: expected a failure`)
          assertNoLeak(key, what, `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs.join("\n")}`)
          assert.match(String(exit), /TypeSafe/, what)
        }
      }), 30_000)

    it.live(`module start errors and status lines, key ${JSON.stringify(key)}`, () =>
      Effect.gen(function*() {
        const p = planted(key)
        const all: ReadonlyArray<readonly [string, Fetch]> = [
          ...scenarios(p),
          ["200 with the key as the model name", async () => respond(200, JSON.stringify({ model: p, answers: { fits: { type: "noul", noul: 0.9 } } }))]
        ]
        for (const [what, fetch] of all) {
          const statuses: Array<string> = []
          const { exit, logs } = yield* withLogs(
            Effect.scoped(makeJevDecider({ fetch }).start({
              settings: { apiKey: key, model: "jev-1.14.0", baseUrl: "http://upstream.test", timeoutMs: 150 },
              setStatus: (s) => {
                if (s !== undefined) statuses.push(s.text)
              }
            }))
          )
          assertNoLeak(key, what, `${serialise(exit)}\n${Exit.isFailure(exit) ? serialise(exit.cause) : ""}\n${logs.join("\n")}\n${statuses.join("\n")}`)
        }
      }), 60_000)
  }

  it.live("text shortened for the message never ends in part of the key (schema diagnostics, details)", () =>
    Effect.gen(function*() {
      const key = KEYS[0]
      // The key at every offset around the 300-character cut of each kind of upstream text.
      for (const text of straddling(key, 340, 360)) {
        const cases: ReadonlyArray<readonly [string, Fetch]> = [
          ["schema diagnostic", async () => respond(200, JSON.stringify({ answers: { fits: { type: "noul", noul: text } } }))],
          ["top-level schema diagnostic", async () => respond(200, JSON.stringify({ answers: text }))],
          ["detail", async () => respond(500, JSON.stringify({ detail: text }))]
        ]
        for (const [what, fetch] of cases) {
          const exit = yield* Effect.exit(makeJevClient({ apiKey: Redacted.make(key), baseUrl: "http://t", fetch }).decide(pingRequest))
          assertNoLeak(key, `${what} at ${text.length}`, serialise(exit))
        }
      }
    }), 60_000)

  it.live("Retry-After is shown only as a number of seconds", () =>
    Effect.gen(function*() {
      const run = (value: string) =>
        Effect.exit(
          makeJevClient({ apiKey: Redacted.make("ts-key-0123456789"), baseUrl: "http://t", fetch: async () => respond(429, "{}", { "retry-after": value }) })
            .decide(pingRequest)
        )
      assert.include(String(yield* run("12")), "TypeSafe is rate limiting (429, retry after 12 s)")
      const odd = String(yield* run("soon, maybe <b>"))
      assert.include(odd, "TypeSafe is rate limiting (429)")
      assert.notInclude(odd, "soon")
    }))
})
