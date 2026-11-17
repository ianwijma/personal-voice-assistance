import { assert, describe, it } from "@effect/vitest"
import { VoiceCatalogError } from "@pva/core"
import { Effect, Exit, Fiber, Redacted } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { describeVoice, makeVoices } from "../src/index.ts"

// A local HTTP server standing in for the ElevenLabs REST API. No call leaves the machine.

const KEY = "sk_test_elevenlabs_SECRETKEY123"

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
  voice_id: id,
  name,
  category: "premade",
  description: `${name} speaks.`,
  labels: { accent: "american", age: "young", gender: "female", use_case: "social_media" },
  ...extra
})

const failureOf = <A>(exit: Exit.Exit<A, VoiceCatalogError>): VoiceCatalogError => {
  assert.isTrue(Exit.isFailure(exit))
  const error = (exit as Exit.Failure<A, VoiceCatalogError>).cause.reasons.find((r) => r._tag === "Fail")
  return (error as unknown as { error: VoiceCatalogError }).error
}

describe("ElevenLabs voices", () => {
  it.effect("lists every page with the key in xi-api-key, over http on the configured host", () =>
    Effect.gen(function*() {
      const s = yield* server((req, res) => {
        const url = new URL(req.url, "http://x")
        const token = url.searchParams.get("next_page_token")
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify(
          token === null
            ? { voices: [voice("EXAVITQu4vr4xnSDxMaL", "Sarah"), { voice_id: "bad id!", name: "x" }], has_more: true, next_page_token: "p2" }
            : { voices: [voice("JBFqnCBsd6RMkjVDRZzb", "George", { labels: { gender: "male", language: "en" } })], has_more: false, next_page_token: null }
        ))
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base })
      const list = yield* voices.list
      assert.deepStrictEqual(list.voices.map((v) => v.id), ["EXAVITQu4vr4xnSDxMaL", "JBFqnCBsd6RMkjVDRZzb"])
      assert.isFalse(list.truncated)
      assert.deepStrictEqual(list.voices[0], {
        id: "EXAVITQu4vr4xnSDxMaL",
        name: "Sarah",
        description: "Sarah speaks.",
        gender: "female",
        tags: ["american", "young", "social media", "premade"]
      })
      assert.strictEqual(list.voices[1]!.language, "en")
      assert.strictEqual(s.seen.length, 2)
      assert.strictEqual(s.seen[0]!.headers["xi-api-key"], KEY)
      assert.match(s.seen[0]!.url, /^\/v2\/voices\?page_size=100$/)
      assert.match(s.seen[1]!.url, /next_page_token=p2/)
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

  it.effect("previews: POST with the text and model, raw PCM back at the asked rate", () =>
    Effect.gen(function*() {
      const s = yield* server((req, res) => {
        res.setHeader("content-type", "audio/pcm")
        res.end(Buffer.alloc(4_801, 1)) // an odd byte: dropped
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base, model: "eleven_flash_v2_5", language: "nl" })
      const audio = yield* voices.preview("EXAVITQu4vr4xnSDxMaL", "Hallo daar.")
      assert.strictEqual(audio.sampleRate, 24_000)
      assert.strictEqual(audio.pcm.length, 4_800)
      const req = s.seen[0]!
      assert.strictEqual(req.method, "POST")
      assert.strictEqual(req.url, "/v1/text-to-speech/EXAVITQu4vr4xnSDxMaL?output_format=pcm_24000")
      assert.deepStrictEqual(JSON.parse(req.body), { text: "Hallo daar.", model_id: "eleven_flash_v2_5", language_code: "nl" })
      assert.strictEqual(req.headers["xi-api-key"], KEY)
    }))

  it.effect("a voice it does not have is `unknown_voice`; a malformed id is refused without a request", () =>
    Effect.gen(function*() {
      const s = yield* server((_req, res) => {
        res.statusCode = 404
        res.end(JSON.stringify({ detail: { status: "voice_not_found" } }))
      })
      const voices = makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base })
      assert.strictEqual(failureOf(yield* Effect.exit(voices.preview("nosuchvoice", "Hi."))).reason, "unknown_voice")
      assert.strictEqual(failureOf(yield* Effect.exit(voices.preview("../v1/user", "Hi."))).reason, "unknown_voice")
      assert.strictEqual(s.seen.length, 1)
    }))

  it.effect("interrupting a preview aborts the request", () =>
    Effect.gen(function*() {
      let closed = false
      const s = yield* server((req, res) => {
        res.on("close", () => (closed = true))
        // never answers
        void req
      })
      const fiber = yield* Effect.forkChild(makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base }).preview("EXAVITQu4vr4xnSDxMaL", "Hi."))
      while (s.seen.length === 0) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
      yield* Fiber.interrupt(fiber)
      for (let i = 0; i < 100 && !closed; i++) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
      assert.isTrue(closed)
    }))

  it("describeVoice drops what is not a voice", () => {
    assert.isUndefined(describeVoice(null))
    assert.isUndefined(describeVoice({ name: "no id" }))
    assert.deepStrictEqual(describeVoice({ voice_id: "abc", labels: { gender: "non-binary" } }), { id: "abc", name: "abc", gender: "neutral", tags: [] })
  })
})
