import { assert, describe, it } from "@effect/vitest"
import { encodeWav } from "@pva/audio-file"
import { Stt, type SttEvent, Tts } from "@pva/core"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLive } from "../src/bench/live.ts"
import { runOffline, zeroDelays } from "../src/bench/offline.ts"
import { formatReport, median } from "../src/bench/report.ts"
import { FakeLlm } from "../src/FakeLlm.ts"

describe("offline bench", () => {
  it.live("zero delays: every scripted turn completes and starts playing", () =>
    Effect.gen(function*() {
      const rows = yield* runOffline({ name: "zero", delays: zeroDelays, eager: false }, 1)
      assert.strictEqual(rows.length, 4)
      for (const row of rows) {
        assert.strictEqual(row.trace?.outcome, "completed")
        assert.isDefined(row.trace?.marks.playbackStart)
      }
      assert.match(formatReport("zero", rows), /end of turn -> playback start: median .* over 4 turns/)
    }))

  it.live("eager mode promotes speculative turns", () =>
    Effect.gen(function*() {
      const delays = { ...zeroDelays, llmFirstTokenMs: 20, eagerLeadMs: 10 }
      const rows = yield* runOffline({ name: "eager", delays, eager: true }, 1)
      assert.strictEqual(rows.length, 4)
      assert.isTrue(rows.every((r) => r.trace?.speculative === true && r.trace.outcome === "completed"))
      assert.isTrue(rows.every((r) => r.trace!.marks.llmRequestSent! < r.trace!.marks.endOfTurn!))
    }))
})

it("median", () => {
  assert.strictEqual(median([3, 1, 2]), 2)
  assert.strictEqual(median([4, 1, 2, 3]), 2.5)
  assert.isUndefined(median([]))
})

/** Ends a turn after 100 ms of silence that follows sound. */
const silenceDetectingStt = Layer.succeed(Stt, Stt.of({
  transcribe: (audio) =>
    Stream.suspend(() => {
      let turn = 0
      let heard = false
      let quiet = 0
      return audio.pipe(
        Stream.mapError((e) => e as never),
        Stream.flatMap((frame): Stream.Stream<SttEvent> => {
          const loud = frame.some((b) => b !== 0)
          if (loud && !heard) {
            heard = true
            quiet = 0
            return Stream.make({ _tag: "SpeechStarted" })
          }
          if (!loud && heard && ++quiet === 5) {
            heard = false
            turn++
            return Stream.make({ _tag: "EndOfTurn", text: `turn ${turn}` })
          }
          return Stream.empty
        })
      )
    })
}))

/** 50 ms of silent 24 kHz audio per clause. */
const silentTts = Layer.succeed(Tts, Tts.of({
  sampleRate: 24_000,
  synthesize: (clauses) => clauses.pipe(Stream.zipWithIndex, Stream.map(([, clause]) => ({ audio: new Uint8Array(2400), clause })))
}))

it.live("live bench: one turn per file, waits for each reply, writes the replies", () =>
  Effect.gen(function*() {
    const dir = mkdtempSync(join(tmpdir(), "pva-live-"))
    const tone = new Int16Array(4800).map((_, i) => Math.round(3000 * Math.sin(i / 5))) // 300 ms
    const files = ["a.wav", "b.wav"].map((name) => {
      const path = join(dir, name)
      writeFileSync(path, encodeWav({ sampleRate: 16_000, channels: 1, data: new Uint8Array(tone.buffer) }))
      return path
    })
    const outputDir = join(dir, "out")
    const rows = yield* runLive({ files, outputDir, conversation: { systemPrompt: "test" }, leadInMs: 0, maxTurnMs: 5000, noiseFloor: false })
    assert.deepStrictEqual(rows.map((r) => [r.label, r.trace?.outcome]), [["a.wav", "completed"], ["b.wav", "completed"]])
    for (const row of rows) {
      const eot = row.extra?.eot
      assert.isTrue(eot !== undefined && eot >= 80 && eot < 400, `eot = ${eot}`)
    }
    assert.deepStrictEqual(readdirSync(outputDir).sort(), ["reply-001.wav", "reply-002.wav"])
  }).pipe(Effect.provide(Layer.mergeAll(silenceDetectingStt, silentTts, FakeLlm.layer))), 15_000)
