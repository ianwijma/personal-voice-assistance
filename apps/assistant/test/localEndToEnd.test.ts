// The whole local pipeline with the real models: Piper synthesises a question, the
// local STT (zipformer-en, the lighter preset) recognises it and detects the turn, the
// fake LLM answers, Piper speaks the reply into a WAV file. Skipped when the models
// are not downloaded (`pnpm download-models` + `pnpm --filter @pva/stt-sherpa download-models zipformer-en`).
import { assert, it } from "@effect/vitest"
import { parseWav } from "@pva/audio-file"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLive } from "../src/bench/live.ts"
import { makeBenchWavs } from "../src/bench/makeWavs.ts"
import { FakeLlm } from "../src/FakeLlm.ts"

const required = [
  join(SherpaTts.defaultModelDir, "vits-piper-en_US-lessac-medium", "en_US-lessac-medium.onnx"),
  join(SherpaStt.defaultModelDir, "silero_vad.onnx"),
  join(SherpaStt.defaultModelDir, "silero_vad.onnx")
]
const missing = required.find((f) => !existsSync(f)) ??
  (SherpaStt.installedPresets().includes("zipformer-en") ? undefined : "the zipformer-en model")
if (missing !== undefined) console.warn(`Skipping the local end-to-end test: ${missing} is missing`)

it.live.skipIf(missing !== undefined)(
  `local end to end: speech in, turn detected, reply synthesised and played to WAV${missing ? " (SKIPPED: models missing)" : ""}`,
  () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "pva-e2e-"))
      const files = yield* makeBenchWavs(join(dir, "in"), ["Hello, can you hear me?"])
      const outputDir = join(dir, "out")
      const rows = yield* runLive({ files, outputDir, conversation: { systemPrompt: "test" }, leadInMs: 500, maxTurnMs: 15_000 })
      assert.strictEqual(rows.length, 1)
      const row = rows[0]!
      assert.strictEqual(row.trace?.outcome, "completed")
      assert.isTrue(row.trace?.speculative, "the eager end of turn should have been promoted")
      assert.match(row.note ?? "", /heard "H[AEU]LLO CAN YOU HEAR ME"/) // zipformer sometimes hears "HULLO"
      const play = row.extra?.PLAY
      assert.isTrue(play !== undefined && play > 0 && play < 2_000, `end of audio -> playback ${play} ms`)
      const reply = parseWav(readFileSync(join(outputDir, "reply-001.wav")))
      assert.strictEqual(reply.sampleRate, 22_050)
      const seconds = reply.data.length / 2 / reply.sampleRate
      assert.isTrue(seconds > 1 && seconds < 4, `reply is ${seconds} s`) // "You said: HELLO CAN YOU HEAR ME"
    }).pipe(
      Effect.provide(Layer.mergeAll(
        SherpaTts.layer(),
        SherpaStt.layer({ model: "zipformer-en" }),
        FakeLlm.layer
      )),
      Effect.scoped
    ),
  60_000
)
