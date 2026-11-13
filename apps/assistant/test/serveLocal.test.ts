// Serve mode with the real local models: Piper synthesises a question, the scripted
// client speaks it into the WebSocket in real time, the local STT (zipformer-en, the
// lighter preset) recognises it, the fake LLM answers, and Piper's reply audio comes
// back over the socket. Skipped when the models are not downloaded.
import { parseWav } from "@pva/audio-file"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Effect } from "effect"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { makeBenchWavs } from "../src/bench/makeWavs.ts"
import { ScriptedClient } from "./support/scriptedClient.ts"
import { startTestServer, type TestServer } from "./support/serveHarness.ts"
import { moduleCatalog } from "../src/modules.ts"
import { defaultProviderBuilder } from "../src/serve/Engine.ts"

const required = [
  join(SherpaTts.defaultModelDir, "vits-piper-en_US-lessac-medium", "en_US-lessac-medium.onnx"),
  join(SherpaStt.defaultModelDir, "silero_vad.onnx"),
  join(SherpaStt.defaultModelDir, "silero_vad.onnx")
]
const missing = required.find((f) => !existsSync(f)) ??
  (SherpaStt.installedPresets().includes("zipformer-en") ? undefined : "the zipformer-en model")
if (missing !== undefined) console.warn(`Skipping the local serve test: ${missing} is missing`)

let server: TestServer | undefined
afterAll(async () => {
  await server?.close()
})

it.skipIf(missing !== undefined)(
  `serve with local models: spoken question in over the socket, recognised, reply audio out${missing ? " (SKIPPED: models missing)" : ""}`,
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "pva-serve-live-"))
    const [wavFile] = await Effect.runPromise(
      Effect.scoped(makeBenchWavs(join(dir, "in"), ["Hello, can you hear me?"]).pipe(Effect.provide(SherpaTts.layer())))
    )
    const speech = parseWav(readFileSync(wavFile!))
    expect(speech.sampleRate).toBe(16_000)

    server = await startTestServer({
      build: defaultProviderBuilder,
      catalog: moduleCatalog,
      env: { ...process.env, LLM_PROVIDER: "fake", STT_PROVIDER: "sherpa", STT_SHERPA_MODEL: "zipformer-en", TTS_PROVIDER: "sherpa", VOICES: "standard" },
      dataDir: join(dir, "data")
    })
    expect(server.handle.engine.status()).toMatchObject({ state: "ready" })

    const client = await ScriptedClient.connect({ url: server.url })
    await client.hello()
    await client.claim("instant")
    await client.silence(500)
    await client.streamPcm(speech.data)
    let done = false
    const ended = client.waitFor("turn.end", () => true, { from: 0, timeoutMs: 20_000 }).finally(() => {
      done = true
    })
    while (!done) await client.silence(100)
    const end = await ended
    expect(end.outcome).toBe("completed")
    const start = client.messages.find((m) => m.type === "turn.start")
    expect(start).toMatchObject({ source: "voice", spoken: true })
    expect((start as { userText: string }).userText).toMatch(/H[AEU]LLO CAN YOU HEAR ME/i)
    expect(end.trace.marks.playbackStart).toBeDefined()
    const reply = client.messages.find((m) => m.type === "reply.start") as { sampleRate: number }
    expect(reply.sampleRate).toBe(22_050)
    const seconds = (client.replySamples.get(end.turnId) ?? 0) / 22_050
    expect(seconds).toBeGreaterThan(1)
    expect(seconds).toBeLessThan(5)
    client.close()
  },
  90_000
)
