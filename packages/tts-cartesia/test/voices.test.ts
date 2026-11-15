import { assert, describe, it } from "@effect/vitest"
import { VoiceCatalogError } from "@pva/core"
import { Effect, Exit, Fiber, Redacted } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { describeVoice, makeVoices } from "../src/index.ts"

// A local HTTP server standing in for the Cartesia REST API. No call leaves the machine.

const KEY = "sk_car_test_SECRETKEY123"

interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: string
}

const server = (handler: (req: Seen, res: http.ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly base: string; readonly seen: Array<Seen>; readonly server: http.Server }>((resume) => {
      const seen: Array<Seen> = []
      const s = http.createServer((req, res) => {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body }
          seen.push(entry)
          handler(entry, res)
        })
      })
      s.listen(0, "127.0.0.1", () => resume(Effect.succeed({ base: `ws://127.0.0.1:${(s.address() as AddressInfo).port}`, seen, server: s })))
    }),
    ({ server }) => Effect.callback<void>((resume) => {
      server.closeAllConnections()
      server.close(() => resume(Effect.void))
    })
  )

const voice = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  is_owner: false,
  status: "active",
  access: "public",
  visibility: "all",
  tagline: `${name}, a calm voice`,
  description: `${name} speaks.`,
  created_at: "2026-01-01T00:00:00Z",
  language: "en",
  gender: "feminine",
  accents: [{ accent: "American", locale: "en-US", is_native: true }],
  ...extra
})

const SKYLAR = "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"
const OTHER = "a0e99841-438c-4a64-b679-ae501e7d6091"

const failureOf = <A>(exit: Exit.Exit<A, VoiceCatalogError>): VoiceCatalogError => {
  assert.isTrue(Exit.isFailure(exit))
  const error = (exit as Exit.Failure<A, VoiceCatalogError>).cause.reasons.find((r) => r._tag === "Fail")
  return (error as unknown as { error: VoiceCatalogError }).error
}

describe("Cartesia voices", () => {
  it.effect("lists every page with a bearer key and the API version, over http on the configured host", () =>
    Effect.gen(function*() {
      const s = yield* server((req, res) => {
        const url = new URL(req.url, "http://x")
        const after = url.searchParams.get("starting_after")
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(
          after === null
            ? { data: [voice(SKYLAR, "Skylar"), voice("archived-one", "Old", { status: "archived" })], has_more: true, next_page: SKYLAR }
            : { data: [voice(OTHER, "Barbershop Man", { gender: "masculine", is_owner: true, is_pro: true, accents: [] })], has_more: false, next_page: null }
        ))
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base })
      const list = yield* voices.list
      assert.deepStrictEqual(list.voices.map((v) => v.id), [SKYLAR, OTHER])
      assert.isFalse(list.truncated)
      assert.deepStrictEqual(list.voices[0], {
        id: SKYLAR,
        name: "Skylar",
        description: "Skylar speaks.",
        language: "en-US",
        gender: "female",
        tags: ["american"]
      })
      assert.deepStrictEqual(list.voices[1]!.tags, ["pro", "yours"])
      assert.strictEqual(list.voices[1]!.gender, "male")
      assert.strictEqual(list.voices[1]!.language, "en")
      assert.strictEqual(s.seen.length, 2)
      assert.strictEqual(s.seen[0]!.headers.authorization, `Bearer ${KEY}`)
      assert.strictEqual(s.seen[0]!.headers["cartesia-version"], "2026-08-14")
      assert.strictEqual(s.seen[0]!.url, "/voices?limit=100")
      assert.strictEqual(s.seen[1]!.url, `/voices?limit=100&starting_after=${SKYLAR}`)
    }))

  it.effect("a refused key is `unauthorized`, and the key is not in the message", () =>
    Effect.gen(function*() {
      const s = yield* server((_req, res) => {
        res.statusCode = 401
        res.end(JSON.stringify({ detail: { message: `Invalid API key: ${KEY}` } }))
      })
      const exit = yield* Effect.exit(makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base }).list)
      const error = failureOf(exit)
      assert.strictEqual(error.reason, "unauthorized")
      assert.notInclude(error.message, KEY)
    }))

  it.effect("a rate limit carries Retry-After; another refusal is redacted", () =>
    Effect.gen(function*() {
      let n = 0
      const s = yield* server((_req, res) => {
        n++
        if (n === 1) {
          res.statusCode = 429
          res.setHeader("retry-after", "7")
          res.end("{}")
        } else {
          res.statusCode = 400
          res.end(`bad request for key ${KEY}`)
        }
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base })
      const limited = failureOf(yield* Effect.exit(voices.list))
      assert.strictEqual(limited.reason, "rate_limited")
      assert.strictEqual(limited.retryAfterMs, 7_000)
      const bad = failureOf(yield* Effect.exit(voices.list))
      assert.strictEqual(bad.reason, "invalid")
      assert.notInclude(bad.message, KEY)
      assert.include(bad.message, "[redacted]")
    }))

  it.effect("an unreachable server is `unavailable`", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(makeVoices({ apiKey: Redacted.make(KEY), baseUrl: "ws://127.0.0.1:1", timeoutMs: 2_000 }).list)
      assert.strictEqual(failureOf(exit).reason, "unavailable")
    }))

  it.effect("previews: POST /tts/bytes with raw pcm_s16le, PCM back at the asked rate", () =>
    Effect.gen(function*() {
      const s = yield* server((_req, res) => {
        res.setHeader("content-type", "audio/pcm")
        res.end(Buffer.alloc(4_801, 1)) // an odd byte: dropped
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base, model: "sonic-3.6", language: "en" })
      const audio = yield* voices.preview(SKYLAR, "Good morning.")
      assert.strictEqual(audio.sampleRate, 24_000)
      assert.strictEqual(audio.pcm.length, 4_800)
      const req = s.seen[0]!
      assert.strictEqual(req.method, "POST")
      assert.strictEqual(req.url, "/tts/bytes")
      assert.deepStrictEqual(JSON.parse(req.body), {
        model_id: "sonic-3.6",
        transcript: "Good morning.",
        voice: { id: SKYLAR },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24_000 },
        language: "en"
      })
    }))

  it.effect("a voice it does not have is `unknown_voice`; a malformed id is refused without a request", () =>
    Effect.gen(function*() {
      const s = yield* server((_req, res) => {
        res.statusCode = 404
        res.end(JSON.stringify({ message: "Voice not found" }))
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base })
      assert.strictEqual(failureOf(yield* Effect.exit(voices.preview(OTHER, "Hi."))).reason, "unknown_voice")
      assert.strictEqual(failureOf(yield* Effect.exit(voices.preview("../v1/user", "Hi."))).reason, "unknown_voice")
      // the unknown voice cost two requests (its language, then the preview); the malformed id none
      assert.strictEqual(s.seen.length, 2)
    }))

  it.effect("interrupting a preview aborts the request", () =>
    Effect.gen(function*() {
      let closed = false
      const s = yield* server((req, res) => {
        res.on("close", () => (closed = true))
        // never answers
        void req
      })
      const fiber = yield* Effect.forkChild(makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base }).preview(SKYLAR, "Hi."))
      while (s.seen.length === 0) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
      yield* Fiber.interrupt(fiber)
      for (let i = 0; i < 100 && !closed; i++) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
      assert.isTrue(closed)
    }))

  it("describeVoice drops what is not a voice", () => {
    assert.isUndefined(describeVoice(null))
    assert.isUndefined(describeVoice({ name: "no id" }))
    assert.deepStrictEqual(describeVoice({ id: "abc", gender: "gender_neutral", tagline: "Short." }), { id: "abc", name: "abc", description: "Short.", gender: "neutral", tags: [] })
  })
})
