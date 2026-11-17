import { assert, describe, it } from "@effect/vitest"
import { Tts } from "@pva/core"
import { ConfigProvider, Effect, Fiber, Redacted, Stream } from "effect"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer } from "ws"
import { effectiveLanguage, languageCode, layerConfig, makeVoices } from "../src/index.ts"

// Which language speech is requested in: the CARTESIA_LANGUAGE override, else the chosen voice's own language
// (as a bare code), else `en`. A local server stands in for Cartesia; no call leaves the machine.

const KEY = "sk_car_test_SECRETKEY123"
const VOICE = "a0e99841-438c-4a64-b679-ae501e7d6091"

interface Hit {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** HTTP (voice lookup, preview) and WebSocket (speech) on one port. `voiceStatus` 200 answers with `voice`. */
const mock = (voice: Record<string, unknown> | undefined) =>
  Effect.acquireRelease(
    Effect.callback<{ base: string; hits: Array<Hit>; spoken: Array<Record<string, any>>; close: () => Promise<void> }>((resume) => {
      const hits: Array<Hit> = []
      const spoken: Array<Record<string, any>> = []
      const s = http.createServer((req, res) => {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          hits.push({ method: req.method ?? "", url: req.url ?? "", body })
          if (req.url?.startsWith("/voices/") && req.method === "GET") {
            if (voice === undefined) {
              res.statusCode = 404
              res.end(JSON.stringify({ message: "Voice not found" }))
            } else {
              res.setHeader("content-type", "application/json")
              res.end(JSON.stringify(voice))
            }
          } else {
            res.setHeader("content-type", "audio/pcm")
            res.end(Buffer.alloc(480, 1))
          }
        })
      })
      const wss = new WebSocketServer({ server: s })
      wss.on("connection", (ws) => ws.on("message", (d) => spoken.push(JSON.parse(d.toString()))))
      s.listen(0, "127.0.0.1", () =>
        resume(Effect.succeed({
          base: `ws://127.0.0.1:${(s.address() as AddressInfo).port}`,
          hits,
          spoken,
          close: () =>
            new Promise<void>((done) => {
              for (const c of wss.clients) c.terminate()
              s.closeAllConnections()
              s.close(() => done())
            })
        })))
    }),
    (m) => Effect.promise(() => m.close())
  )

const voiceBody = (extra: Record<string, unknown>) => ({ id: VOICE, name: "Pim", status: "active", ...extra })
const previewLanguage = (hits: Array<Hit>) => JSON.parse(hits.find((h) => h.method === "POST")!.body).language

describe("Cartesia language", () => {
  it("converts a locale to the bare language code", () => {
    assert.strictEqual(languageCode("en_US"), "en")
    assert.strictEqual(languageCode("en-GB"), "en")
    assert.strictEqual(languageCode("NL"), "nl")
    assert.strictEqual(languageCode("pt-BR"), "pt")
    assert.isUndefined(languageCode(""))
    assert.isUndefined(languageCode("x"))
    assert.isUndefined(languageCode(undefined))
  })

  it("precedence: override, then the voice's language, then en", () => {
    assert.strictEqual(effectiveLanguage("de", "nl-NL"), "de")
    assert.strictEqual(effectiveLanguage(undefined, "nl-NL"), "nl")
    assert.strictEqual(effectiveLanguage("  ", "nl_NL"), "nl")
    assert.strictEqual(effectiveLanguage("", undefined), "en")
    assert.strictEqual(effectiveLanguage(undefined, "???"), "en")
  })

  it.effect("a preview uses the voice's language, converted from its locale", () =>
    Effect.gen(function*() {
      const s = yield* mock(voiceBody({ language: "nl", accents: [{ accent: "Dutch", locale: "nl_NL" }] }))
      yield* makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base }).preview(VOICE, "Hallo.")
      assert.strictEqual(previewLanguage(s.hits), "nl")
      assert.strictEqual(s.hits[0]!.url, `/voices/${VOICE}`)
    }))

  it.effect("a preview with CARTESIA_LANGUAGE set uses it and does not look the voice up", () =>
    Effect.gen(function*() {
      const s = yield* mock(voiceBody({ language: "nl" }))
      yield* makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base, language: "fr" }).preview(VOICE, "Salut.")
      assert.strictEqual(previewLanguage(s.hits), "fr")
      assert.strictEqual(s.hits.length, 1)
    }))

  it.effect("a preview falls back to en when the voice is unknown or the lookup fails", () =>
    Effect.gen(function*() {
      const s = yield* mock(undefined)
      yield* makeVoices({ apiKey: Redacted.make(KEY), baseUrl: s.base }).preview(VOICE, "Hi.")
      assert.strictEqual(previewLanguage(s.hits), "en")
    }))

  /** Builds the engine from the settings, speaks one clause, and returns the `language` it sent. */
  const speak = (voice: Record<string, unknown> | undefined, env: Record<string, string>) =>
    Effect.gen(function*() {
      const s = yield* mock(voice)
      const settings = { CARTESIA_API_KEY: KEY, CARTESIA_URL: s.base, CARTESIA_VOICE: VOICE, ...env }
      const language = yield* Effect.gen(function*() {
        const tts = yield* Tts
        const fiber = yield* Effect.forkChild(Stream.runDrain(tts.synthesize(Stream.make("Hello."))))
        for (let i = 0; i < 200 && s.spoken.length === 0; i++) yield* Effect.promise(() => new Promise((r) => setTimeout(r, 10)))
        yield* Fiber.interrupt(fiber)
        return s.spoken[0]?.language as string | undefined
      }).pipe(
        Effect.provide(layerConfig),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(settings))
      )
      return { language, hits: s.hits }
    })

  it.effect("live speech uses the voice's language when CARTESIA_LANGUAGE is unset", () =>
    Effect.gen(function*() {
      const r = yield* speak(voiceBody({ accents: [{ accent: "British", locale: "en-GB" }], language: "en" }), {})
      assert.strictEqual(r.language, "en")
      const nl = yield* speak(voiceBody({ language: "nl-NL" }), {})
      assert.strictEqual(nl.language, "nl")
      assert.isTrue(nl.hits.some((h) => h.url === `/voices/${VOICE}`))
    }))

  it.effect("live speech: CARTESIA_LANGUAGE wins and no lookup is made", () =>
    Effect.gen(function*() {
      const r = yield* speak(voiceBody({ language: "nl" }), { CARTESIA_LANGUAGE: "de" })
      assert.strictEqual(r.language, "de")
      assert.strictEqual(r.hits.length, 0)
    }))

  it.effect("live speech falls back to en when the voice's language is unknown", () =>
    Effect.gen(function*() {
      const r = yield* speak(undefined, {})
      assert.strictEqual(r.language, "en")
    }))
})
