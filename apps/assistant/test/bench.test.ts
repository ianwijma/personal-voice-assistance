import { assert, describe, it } from "@effect/vitest"
import { encodeWav } from "@pva/audio-file"
import { Stt, type SttEvent, Tts } from "@pva/core"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLive, runLiveSessions } from "../src/bench/live.ts"
import { runOffline, runOfflineSessions, zeroDelays } from "../src/bench/offline.ts"
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

describe("offline bench, several sessions (bench --sessions N)", () => {
  it.live("every session's turns complete, with their turn ends at the same moments", () =>
    Effect.gen(function*() {
      const delays = { ...zeroDelays, llmFirstTokenMs: 20 }
      const perSession = yield* runOfflineSessions({ name: "two", delays, eager: false }, 1, 2)
      assert.strictEqual(perSession.length, 2)
      for (const rows of perSession) {
        assert.strictEqual(rows.length, 4)
        assert.isTrue(rows.every((r) => r.trace?.outcome === "completed" && r.trace.marks.playbackStart !== undefined))
      }
      // Simultaneous: the i-th turn ends of the two sessions are within a few ms of each other.
      for (let i = 0; i < 4; i++) {
        const a = perSession[0]![i]!.trace!.marks.endOfTurn!
        const b = perSession[1]![i]!.trace!.marks.endOfTurn!
        assert.isAtMost(Math.abs(a - b), 15)
      }
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

const writeTone = (dir: string, name: string, ms: number) => {
  const tone = new Int16Array(16 * ms).map((_, i) => Math.round(3000 * Math.sin(i / 5)))
  const path = join(dir, name)
  writeFileSync(path, encodeWav({ sampleRate: 16_000, channels: 1, data: new Uint8Array(tone.buffer) }))
  return path
}

describe("live bench, several sessions (bench --live --sessions N)", () => {
  const run = (staggerMs: number) =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "pva-live-sessions-"))
      // Different lengths: the shorter file of a turn gets leading silence so both end together.
      const files = [writeTone(dir, "a.wav", 300), writeTone(dir, "b.wav", 560)]
      const outputDir = join(dir, "out")
      const perSession = yield* runLiveSessions({
        files,
        outputDir,
        conversation: { systemPrompt: "test" },
        leadInMs: 0,
        maxTurnMs: 5000,
        noiseFloor: false,
        sessions: 2,
        staggerMs
      })
      return { perSession, outputDir }
    }).pipe(Effect.provide(Layer.mergeAll(silenceDetectingStt, silentTts, FakeLlm.layer)))

  it.live("each session answers every file, rotated, with the turn ends at the same moment", () =>
    Effect.gen(function*() {
      const { outputDir, perSession } = yield* run(0)
      assert.deepStrictEqual(perSession.map((rows) => rows.map((r) => [r.label, r.trace?.outcome])), [
        [["s1 a.wav", "completed"], ["s1 b.wav", "completed"]],
        [["s2 b.wav", "completed"], ["s2 a.wav", "completed"]]
      ])
      for (let k = 0; k < 2; k++) {
        const a = perSession[0]![k]!.trace!.marks.endOfTurn!
        const b = perSession[1]![k]!.trace!.marks.endOfTurn!
        assert.isAtMost(Math.abs(a - b), 30, `turn ${k + 1}: ${a} vs ${b}`)
      }
      assert.deepStrictEqual(readdirSync(outputDir).sort(), ["s1", "s2"])
      assert.deepStrictEqual(readdirSync(join(outputDir, "s2")).sort(), ["reply-001.wav", "reply-002.wav"])
    }), 15_000)

  it.live("--stagger: session 2's turn ends that much later", () =>
    Effect.gen(function*() {
      const { perSession } = yield* run(300)
      for (let k = 0; k < 2; k++) {
        const gap = perSession[1]![k]!.trace!.marks.endOfTurn! - perSession[0]![k]!.trace!.marks.endOfTurn!
        assert.isTrue(gap > 260 && gap < 340, `turn ${k + 1}: gap ${gap}`)
      }
    }), 15_000)
})
