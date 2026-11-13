import { assert, describe, it } from "@effect/vitest"
import {
  buildDecisionPlan,
  type DecisionProvider,
  defineAction,
  type ExtendedModuleInstance,
  interpretDecision,
  makeModuleHost,
  ModuleStartError,
  Param,
  readOnlyPersistence,
  registerActions
} from "@pva/core"
import { Effect, Exit, Fiber, Redacted } from "effect"
import * as Http from "node:http"
import type { AddressInfo } from "node:net"
import { makeJevDecider } from "../src/decider.ts"
import { fromBody, isKeyRejected, makeJevClient, toBody } from "../src/JevClient.ts"

// ---------------------------------------------------------------------------
// A fake of the documented `POST /v1/systemone` endpoint.

interface Recorded {
  readonly path: string
  readonly headers: Http.IncomingHttpHeaders
  readonly body: any
}
type Handler = (req: Http.IncomingMessage, res: Http.ServerResponse, body: any) => void

const fakeJev = (handler: Handler) =>
  Effect.acquireRelease(
    Effect.callback<{ url: string; requests: Array<Recorded>; server: Http.Server }>((resume) => {
      const requests: Array<Recorded> = []
      const server = Http.createServer((req, res) => {
        let raw = ""
        req.on("data", (c) => (raw += c))
        req.on("end", () => {
          const body = raw.length > 0 ? JSON.parse(raw) : undefined
          requests.push({ path: req.url ?? "", headers: req.headers, body })
          handler(req, res, body)
        })
      })
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo
        resume(Effect.succeed({ url: `http://127.0.0.1:${port}`, requests, server }))
      })
    }),
    (api) =>
      Effect.sync(() => {
        api.server.closeAllConnections()
        api.server.close()
      })
  )

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

/** Answers every question like Jev would for "turn on the lights in the living room". */
const jevAnswers: Handler = (req, res, body) => {
  const answers: Record<string, unknown> = {}
  for (const [name, q] of Object.entries<any>(body.questions)) {
    if (q.type === "noul") answers[name] = { type: "noul", noul: name === "fits" ? 0.97 : 0.04 }
    else {
      const options = Object.keys(q.criteria)
      const choice = options.find((o) => o.includes("lights_on") || o.includes("living_room")) ?? options[0]!
      const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 0.94 : 0.06 / (options.length - 1)]))
      answers[name] = { type: "choice", choice, confidence: 0.9, probabilities }
    }
  }
  reply(200, { model: "jev-1.14.0", answers, usage: { input_tokens: 420, output_tokens: 9 } })(req, res, body)
}

// ---------------------------------------------------------------------------
// Fixtures: the demonstration home's actions.

const targets = [
  { value: "area:living_room", label: "Living room", aliases: ["lounge"] },
  { value: "area:kitchen", label: "Kitchen" }
]
const target = Param.dynamic({ label: "Room or light", options: () => targets })
const actions = registerActions("demo-home", [
  defineAction({ id: "lights_on", label: "Turn lights on", description: "Switch on lights.", params: { target }, run: () => Effect.void }),
  defineAction({ id: "lights_off", label: "Turn lights off", description: "Switch off lights.", params: { target }, run: () => Effect.void })
])
const plan = buildDecisionPlan({ utterance: "Turn on the lights in the living room.", actions })

const client = (url: string, timeoutMs = 1_000) => makeJevClient({ apiKey: Redacted.make("ts-test"), baseUrl: url, timeoutMs })

// ---------------------------------------------------------------------------

describe("request and response mapping", () => {
  it("maps options to criteria, strips roles and keeps the state", () => {
    const body = toBody(plan.request, "jev-1.14.0")
    assert.strictEqual(body.model, "jev-1.14.0")
    assert.deepStrictEqual(body.state, plan.request.state)
    const action = body.questions.action!
    assert.deepStrictEqual(Object.keys(action), ["type", "instructions", "criteria"])
    assert.deepStrictEqual(Object.keys(action.type === "choice" ? action.criteria : {}), ["demo-home.lights_on", "demo-home.lights_off"])
    assert.deepStrictEqual(body.questions.fits, { type: "noul", instructions: plan.request.questions.fits!.instructions })
    assert.isTrue(Object.values(body.questions).every((q) => !("role" in q) && !("options" in q)))
  })

  it("validates answers, maps noul to value and ignores other answer types", () => {
    assert.deepStrictEqual(
      fromBody({
        model: "jev-1.14.0",
        answers: {
          a: { type: "choice", choice: "x", confidence: 0.5, probabilities: { x: 0.75, y: 0.25 } },
          b: { type: "noul", noul: 0.2 },
          c: { type: "score", score: 4.2, confidence: 0.3, probabilities: {}, legend: {} }
        },
        usage: { input_tokens: 1, output_tokens: 1 }
      }),
      { model: "jev-1.14.0", answers: { a: { type: "choice", choice: "x", probabilities: { x: 0.75, y: 0.25 } }, b: { type: "noul", value: 0.2 } } }
    )
    assert.isString(fromBody({ answers: { a: { type: "noul", noul: "high" } } }))
    assert.isString(fromBody({ nothing: true }))
  })
})

describe("JevClient against a fake /v1/systemone", () => {
  it.live("sends one request with the bearer key and answers in the core's shape", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(jevAnswers)
      const response = yield* client(api.url).decide(plan.request)
      assert.strictEqual(api.requests.length, 1)
      assert.strictEqual(api.requests[0]?.path, "/v1/systemone")
      assert.strictEqual(api.requests[0]?.headers.authorization, "Bearer ts-test")
      assert.strictEqual(response.model, "jev-1.14.0")
      const outcome = interpretDecision(plan, response)
      assert.strictEqual(outcome._tag, "Act")
      if (outcome._tag === "Act") {
        assert.strictEqual(outcome.action.id, "demo-home.lights_on")
        assert.deepStrictEqual(outcome.params, { target: "area:living_room" })
      }
    }))

  it.live("'no action fits' is an answer, not an error", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(200, {
        model: "jev-1.14.0",
        answers: {
          action: { type: "choice", choice: "demo-home.lights_on", probabilities: { "demo-home.lights_on": 0.5, "demo-home.lights_off": 0.5 } },
          fits: { type: "noul", noul: 0.05 },
          compound: { type: "noul", noul: 0.02 }
        }
      }))
      const response = yield* client(api.url).decide(buildDecisionPlan({ utterance: "What is the capital of France?", actions }).request)
      assert.deepStrictEqual(interpretDecision(plan, response), { _tag: "Fallback", reason: "no_match", probability: 0.05 })
    }))

  it.live("a rejected key is 'unavailable' marked as key-rejected, and later calls fail without a request", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(401, { detail: "Invalid API key" }))
      const jev = client(api.url)
      const first = yield* Effect.flip(jev.decide(plan.request))
      assert.strictEqual(first.reason, "unavailable")
      assert.isTrue(isKeyRejected(first))
      assert.include(first.message, "TypeSafe rejected the API key (401): Invalid API key")
      const second = yield* Effect.flip(jev.decide(plan.request))
      assert.isTrue(isKeyRejected(second))
      assert.strictEqual(api.requests.length, 1)
    }))

  it.live("429 and 529 are 'unavailable' (service failed), not retried, not key-rejected", () =>
    Effect.gen(function*() {
      const limited = yield* fakeJev(reply(429, { detail: "Rate limit exceeded" }, { "retry-after": "2" }))
      const e429 = yield* Effect.flip(client(limited.url).decide(plan.request))
      assert.strictEqual(e429.reason, "unavailable")
      assert.isFalse(isKeyRejected(e429))
      assert.include(e429.message, "rate limiting (429, retry after 2 s)")
      assert.strictEqual(limited.requests.length, 1)

      const overloaded = yield* fakeJev(reply(529, { detail: "Overloaded" }))
      const e529 = yield* Effect.flip(client(overloaded.url).decide(plan.request))
      assert.strictEqual(e529.reason, "unavailable")
      assert.include(e529.message, "overloaded (529)")
    }))

  it.live("422 is 'rejected' with the validation detail", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(422, {
        detail: [{ loc: ["body", "questions", "action", "criteria"], msg: "at most 255 options", type: "too_long" }]
      }))
      const error = yield* Effect.flip(client(api.url).decide(plan.request))
      assert.strictEqual(error.reason, "rejected")
      assert.include(error.message, "body.questions.action.criteria: at most 255 options")
    }))

  it.live("a malformed 200 is 'invalid'", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(200, "<html>proxy</html>"))
      assert.strictEqual((yield* Effect.flip(client(api.url).decide(plan.request))).reason, "invalid")
      const odd = yield* fakeJev(reply(200, { answers: { fits: { type: "noul" } } }))
      assert.strictEqual((yield* Effect.flip(client(odd.url).decide(plan.request))).reason, "invalid")
    }))

  it.live("a slow answer times out within the limit and the request is aborted", () =>
    Effect.gen(function*() {
      let closed!: () => void
      const connectionClosed = new Promise<void>((resolve) => (closed = resolve))
      const api = yield* fakeJev((req) => req.socket.on("close", () => closed())) // never answers
      const started = Date.now()
      const error = yield* Effect.flip(client(api.url, 250).decide(plan.request))
      const elapsed = Date.now() - started
      assert.strictEqual(error.reason, "timeout")
      assert.include(error.message, "within 250 ms")
      assert.isAtLeast(elapsed, 240)
      assert.isBelow(elapsed, 700)
      yield* Effect.promise(() => connectionClosed).pipe(Effect.timeout(1_000))
      assert.strictEqual(api.requests.length, 1)
    }))

  it.live("interrupting the caller aborts the request", () =>
    Effect.gen(function*() {
      let closed!: () => void
      const connectionClosed = new Promise<void>((resolve) => (closed = resolve))
      let arrived!: () => void
      const requestArrived = new Promise<void>((resolve) => (arrived = resolve))
      const api = yield* fakeJev((req) => {
        req.socket.on("close", () => closed())
        arrived()
      })
      const fiber = yield* client(api.url, 10_000).decide(plan.request).pipe(Effect.forkChild)
      yield* Effect.promise(() => requestArrived)
      yield* Fiber.interrupt(fiber)
      yield* Effect.promise(() => connectionClosed).pipe(Effect.timeout(1_000))
    }))

  it.live("an unreachable server is 'unavailable' at once", () =>
    Effect.gen(function*() {
      const started = Date.now()
      const error = yield* Effect.flip(client("http://127.0.0.1:1").decide(plan.request))
      assert.strictEqual(error.reason, "unavailable")
      assert.isFalse(isKeyRejected(error))
      assert.isBelow(Date.now() - started, 500)
    }))
})

describe("jev-typesafe module", () => {
  const settings = (url: string) => ({ apiKey: "ts-test", model: "jev-1.14.0", baseUrl: url, timeoutMs: 1_000 })

  const start = (url: string, statuses: Array<string> = []): Effect.Effect<ExtendedModuleInstance, ModuleStartError> =>
    Effect.scoped(makeJevDecider().start({
      settings: settings(url),
      setStatus: (s) => {
        if (s !== undefined) statuses.push(`${s.tone}: ${s.text}`)
      }
    }))

  it("is enabled by default only once its key is set (decided by the host), and declares its settings", () => {
    assert.isFalse(makeJevDecider().enabledByDefault)
    assert.strictEqual(makeJevDecider().enabledWhenSet, "apiKey")
    const def = makeJevDecider()
    assert.strictEqual(def.kind, "decider")
    assert.strictEqual(def.id, "jev-typesafe")
    assert.deepStrictEqual(Object.keys(def.settings), ["apiKey", "model", "baseUrl", "timeoutMs"])
    assert.strictEqual(def.settings.apiKey.env, "TYPESAFE_API_KEY")
    assert.isTrue(def.settings.apiKey.secret)
    assert.strictEqual(def.settings.model.defaultValue, "jev-1.14.0")
    assert.strictEqual(def.settings.baseUrl.decode("ftp://x").ok, false)
  })

  it.live("start checks the key with one tiny request and contributes a hosted decider", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(jevAnswers)
      const statuses: Array<string> = []
      const instance: ExtendedModuleInstance = yield* start(api.url, statuses)
      assert.strictEqual(api.requests.length, 1)
      assert.deepStrictEqual(Object.keys(api.requests[0]!.body.questions), ["fits"])
      assert.match(statuses[0]!, /^ok: Ready · round trip at start \d+ ms · jev-1\.14\.0$/)
      const decider: DecisionProvider = instance.deciders![0]!
      assert.deepStrictEqual([decider.id, decider.name, decider.location], ["jev-typesafe", "TypeSafe Jev", "hosted"])
      yield* decider.decide(plan.request)
      assert.match(statuses.at(-1)!, /^ok: Last decision \d+ ms$/)
    }))

  it.live("a rejected key is a start error that says how to fix it", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(401, { detail: "Invalid API key" }))
      const exit = yield* Effect.exit(start(api.url))
      assert.isTrue(Exit.isFailure(exit))
      const reason = Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
      assert.isTrue(reason?._tag === "Fail" && reason.error instanceof ModuleStartError)
      assert.include(reason?._tag === "Fail" ? (reason.error as ModuleStartError).message : "", "console.typesafe.ai/keys")
    }))

  it.live("an unknown model name (400) is a start error naming the model", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(400, { detail: "Unknown model 'jev-9'" }))
      const error = yield* Effect.flip(start(api.url))
      assert.include(error.message, "Unknown model 'jev-9'")
      assert.include(error.message, "jev-1.14.0")
    }))

  it.live("an outage at start still starts the module, with a warning, and decisions report failures", () =>
    Effect.gen(function*() {
      const api = yield* fakeJev(reply(503, { detail: "maintenance" }))
      const statuses: Array<string> = []
      const instance = yield* start(api.url, statuses)
      assert.match(statuses[0]!, /^warning: Start check failed/)
      const error = yield* Effect.flip(instance.deciders![0]!.decide(plan.request))
      assert.strictEqual(error.reason, "unavailable")
      assert.match(statuses.at(-1)!, /^warning: Last decision failed: TypeSafe answered 503/)
    }))
})

describe("jev-typesafe: a key in the vault counts like one in the environment", () => {
  // The start check goes to this fake fetch (no network).
  const fetch: typeof globalThis.fetch = async () =>
    new Response(JSON.stringify({ model: "jev-1.14.0", answers: { fits: { value: true } } }), { status: 200, headers: { "content-type": "application/json" } })
  const catalog = [makeJevDecider({ fetch })]
  const enabled = (host: { modules: () => ReadonlyArray<{ id: string; enabled: boolean }> }) => host.modules().find((m) => m.id === "jev-typesafe")!.enabled

  it.effect("off without a key anywhere", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {} })
      assert.isFalse(enabled(host))
    })))

  it.effect("on with TYPESAFE_API_KEY in the environment", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: { TYPESAFE_API_KEY: "ts-env" } })
      assert.isTrue(enabled(host))
    })))

  it.effect("on with the key saved in the vault (the saved secrets), and not when the owner switched it off", () =>
    Effect.scoped(Effect.gen(function*() {
      const saved = yield* makeModuleHost({
        catalog,
        persistence: readOnlyPersistence({ modules: {}, secrets: { "jev-typesafe": { apiKey: "ts-vault" } } }),
        env: {}
      })
      assert.isTrue(enabled(saved))
      const chosenOff = yield* makeModuleHost({
        catalog,
        persistence: readOnlyPersistence({ modules: { "jev-typesafe": { enabled: false } }, secrets: { "jev-typesafe": { apiKey: "ts-vault" } } }),
        env: {}
      })
      assert.isFalse(enabled(chosenOff))
    })))

  it.live("switched on and started when the vault is unlocked later (setSecrets)", () =>
    Effect.scoped(Effect.gen(function*() {
      const host = yield* makeModuleHost({ catalog, persistence: readOnlyPersistence(), env: {} })
      yield* host.startEnabled
      assert.isFalse(enabled(host))
      yield* host.setSecrets({ "jev-typesafe": { apiKey: "ts-vault" } })
      const info = host.modules().find((m) => m.id === "jev-typesafe")!
      assert.isTrue(info.enabled)
      assert.strictEqual(info.state, "running")
    })))
})
