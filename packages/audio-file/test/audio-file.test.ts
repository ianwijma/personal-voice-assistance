import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  encodeWav,
  frameBytes,
  loadInputPcm,
  makeFileOutput,
  pacedFrames,
  parseWav,
  toInputFormat,
  wavHeader
} from "../src/index.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "pva-file-"))
const pattern = (n: number) => new Uint8Array(n).map((_, i) => (i * 7 + 1) % 256)
/** Let forked fibers run, then move the clock (see core's Conversation.test.ts). */
const advance = (millis: number) => Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 50 }), TestClock.adjust(millis))

/** Fork a consumer that records each frame. */
const collect = (stream: Stream.Stream<Uint8Array>) =>
  Effect.gen(function*() {
    const frames: Array<Uint8Array> = []
    const fiber = yield* Effect.forkChild(Stream.runForEach(stream, (f) => Effect.sync(() => frames.push(f))))
    return { frames, fiber }
  })

describe("Wav", () => {
  it("round-trips 16-bit PCM", () => {
    const pcm = { sampleRate: 24_000, channels: 1, data: pattern(4_800) }
    const bytes = encodeWav(pcm)
    assert.strictEqual(bytes.length, 44 + 4_800)
    assert.deepStrictEqual(parseWav(bytes), pcm)
  })

  it("skips unknown (odd-sized) chunks and reads WAVE_FORMAT_EXTENSIBLE", () => {
    const fmt = new Uint8Array(48)
    const v = new DataView(fmt.buffer)
    fmt.set([..."fmt "].map((c) => c.charCodeAt(0)))
    v.setUint32(4, 40, true)
    v.setUint16(8, 0xfffe, true)
    v.setUint16(10, 2, true)
    v.setUint32(12, 16_000, true)
    v.setUint16(22, 16, true)
    v.setUint16(32, 1, true) // sub-format: PCM
    const list = Uint8Array.of(...[..."LIST"].map((c) => c.charCodeAt(0)), 3, 0, 0, 0, 1, 2, 3, 0) // odd size + pad
    const data = Uint8Array.of(...[..."data"].map((c) => c.charCodeAt(0)), 8, 0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0)
    const riff = Uint8Array.of(...[..."RIFF"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[..."WAVE"].map((c) => c.charCodeAt(0)))
    const parsed = parseWav(Buffer.concat([riff, fmt, list, data]))
    assert.deepStrictEqual(parsed, { sampleRate: 16_000, channels: 2, data: Uint8Array.of(1, 0, 2, 0, 3, 0, 4, 0) })
  })

  it("converts 32-bit float samples to 16-bit (clamped)", () => {
    const samples = Float32Array.of(0, 0.5, -0.5, 1, -1, 2)
    const bytes = encodeWav({ sampleRate: 16_000, channels: 1, data: new Uint8Array(samples.buffer) })
    const view = new DataView(bytes.buffer)
    view.setUint16(20, 3, true) // WAVE_FORMAT_IEEE_FLOAT
    view.setUint16(32, 4, true) // block align
    view.setUint16(34, 32, true) // bits
    const parsed = parseWav(bytes)
    assert.strictEqual(parsed.sampleRate, 16_000)
    assert.deepStrictEqual([...new Int16Array(parsed.data.slice().buffer)], [0, 16384, -16384, 32767, -32768, 32767])
  })

  it("rejects what it cannot read with a clear message", () => {
    const withFormat = (tag: number, bits: number) => {
      const bytes = encodeWav({ sampleRate: 16_000, channels: 1, data: new Uint8Array(4) })
      new DataView(bytes.buffer).setUint16(20, tag, true)
      new DataView(bytes.buffer).setUint16(34, bits, true)
      return bytes
    }
    assert.throws(() => parseWav(new TextEncoder().encode("not a wav file")), /not a RIFF\/WAVE/)
    assert.throws(() => parseWav(withFormat(6, 8)), /format tag 6 is neither integer PCM nor 32-bit float/)
    assert.throws(() => parseWav(withFormat(3, 64)), /format tag 3 is neither/)
    assert.throws(() => parseWav(withFormat(1, 8)), /8-bit samples/)
    assert.throws(() => parseWav(wavHeader(16_000, 1, 0).subarray(0, 36)), /no data chunk/)
  })
})

describe("input format", () => {
  it("down-mixes stereo by averaging and rejects other sample rates", () => {
    const stereo = new Int16Array([100, 300, -10, -30, 1, 2])
    const mono = toInputFormat({ sampleRate: 16_000, channels: 2, data: new Uint8Array(stereo.buffer) })
    assert.deepStrictEqual(Array.from(new Int16Array(mono.buffer, mono.byteOffset, mono.length / 2)), [200, -20, 2])
    assert.throws(() => toInputFormat({ sampleRate: 44_100, channels: 1, data: new Uint8Array(2) }), /44100 Hz/)
  })

  it.effect("loads .wav and .pcm files and rejects other formats as AudioError", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const data = pattern(640)
      writeFileSync(join(dir, "a.wav"), encodeWav({ sampleRate: 16_000, channels: 1, data }))
      writeFileSync(join(dir, "a.pcm"), data)
      writeFileSync(join(dir, "b.wav"), encodeWav({ sampleRate: 48_000, channels: 1, data }))
      writeFileSync(join(dir, "a.mp3"), data)
      assert.deepStrictEqual(yield* loadInputPcm(join(dir, "a.wav")), data)
      assert.deepStrictEqual(yield* loadInputPcm(join(dir, "a.pcm")), data)
      const rate = yield* Effect.flip(loadInputPcm(join(dir, "b.wav")))
      assert.strictEqual(rate._tag, "AudioError")
      assert.include(rate.message, "48000 Hz")
      assert.include((yield* Effect.flip(loadInputPcm(join(dir, "a.mp3")))).message, "unsupported file type")
      assert.include((yield* Effect.flip(loadInputPcm(join(dir, "missing.wav")))).message, "cannot read")
    }))
})

describe("pacedFrames", () => {
  it.effect("emits 20 ms frames in real time, with silence padding, then ends", () =>
    Effect.gen(function*() {
      // 50 ms of audio = 2.5 frames -> 3 frames, the last zero-padded.
      const pcm = pattern(1_600)
      const { frames, fiber } = yield* collect(pacedFrames(pcm, { leadingSilenceMs: 40, trailingSilenceMs: 20 }))
      const counts: Array<number> = []
      for (let t = 0; t < 8; t++) {
        yield* advance(10)
        counts.push(frames.length)
        yield* advance(10)
        counts.push(frames.length)
      }
      // One frame at every 20 ms boundary, none in between.
      assert.deepStrictEqual(counts, [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 6, 6, 6])
      yield* Fiber.join(fiber)
      assert.isTrue(frames.every((f) => f.length === frameBytes))
      const silent = (f: Uint8Array) => f.every((b) => b === 0)
      assert.deepStrictEqual(frames.map(silent), [true, true, false, false, false, true])
      assert.deepStrictEqual(Buffer.concat(frames.slice(2, 5)).subarray(0, 1_600), Buffer.from(pcm))
      assert.isTrue(silent(frames[4]!.subarray(320)))
    }))

  it.effect("atEnd: silence keeps emitting silent frames after the file", () =>
    Effect.gen(function*() {
      const { frames, fiber } = yield* collect(pacedFrames(pattern(640), { atEnd: "silence" }))
      for (let i = 0; i < 100; i++) yield* advance(20)
      assert.strictEqual(frames.length, 100)
      assert.isTrue(frames.slice(1).every((f) => f.every((b) => b === 0)))
      assert.isUndefined(fiber.pollUnsafe())
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("noiseFloor fills the silences with about -70 dBFS noise, never exact zeros; the audio is untouched", () =>
    Effect.gen(function*() {
      const pcm = pattern(640)
      const { frames, fiber } = yield* collect(pacedFrames(pcm, { leadingSilenceMs: 20, atEnd: "silence", noiseFloor: true }))
      for (let i = 0; i < 52; i++) yield* advance(20)
      assert.deepStrictEqual(Buffer.from(frames[1]!), Buffer.from(pcm))
      const noise = frames.filter((_, i) => i !== 1).map((f) => new Int16Array(f.slice().buffer))
      const all = noise.flatMap((f) => [...f])
      assert.isTrue(all.every((x) => Math.abs(x) <= 10))
      assert.isTrue(noise.every((f) => f.some((x) => x !== 0)))
      const rms = Math.sqrt(all.reduce((n, x) => n + x * x, 0) / all.length)
      assert.isTrue(rms > 4 && rms < 8, `rms ${rms}`) // uniform ±10: about 6.1, i.e. -75 dBFS
      yield* Fiber.interrupt(fiber)
    }))

  it.effect("does not drift when the consumer takes time per frame", () =>
    Effect.gen(function*() {
      // 20 s of audio; the consumer spends 7 ms on each frame before pulling the next,
      // which a fixed 20 ms sleep per frame would add to every frame's period.
      let count = 0
      const fiber = yield* Effect.forkChild(
        Stream.runForEach(pacedFrames(new Uint8Array(frameBytes * 1_000)), () =>
          Effect.andThen(Effect.sleep(7), Effect.sync(() => count++)))
      )
      for (let t = 0; t < 10_000; t += 20) yield* advance(20)
      // Frame 500 is due at exactly 10 000 ms and its 7 ms of processing is still pending.
      assert.strictEqual(count, 499)
      yield* Fiber.interrupt(fiber)
    }))
})

describe("FileOutput", () => {
  const reply = (seconds: number) =>
    Stream.fromIterable(Array.from({ length: seconds * 50 }, (_, i) => new Uint8Array(960).fill(i % 256))) // 24 kHz

  it.effect("takes real time and writes one numbered WAV per play", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const out = makeFileOutput({ directory: dir })
      const fiber = yield* Effect.forkChild(out.play(reply(2), 24_000))
      yield* advance(1_990)
      assert.isUndefined(fiber.pollUnsafe(), "a 2 s reply finished early")
      yield* advance(10)
      yield* Fiber.join(fiber)
      const wav = parseWav(readFileSync(join(dir, "reply-001.wav")))
      assert.strictEqual(wav.sampleRate, 24_000)
      assert.strictEqual(wav.data.length, 2 * 24_000 * 2)

      const second = yield* Effect.forkChild(out.play(reply(1), 16_000))
      yield* advance(1_500)
      yield* Fiber.join(second)
      assert.strictEqual(parseWav(readFileSync(join(dir, "reply-002.wav"))).sampleRate, 16_000)
    }))

  it.effect("interruption stops at once and leaves a valid WAV of what was played", () =>
    Effect.gen(function*() {
      const dir = tmp()
      const out = makeFileOutput({ directory: dir, prefix: "bench" })
      const fiber = yield* Effect.forkChild(out.play(reply(2), 24_000))
      yield* advance(510) // half way through the 26th 20 ms chunk
      yield* Fiber.interrupt(fiber)
      const wav = parseWav(readFileSync(join(dir, "bench-001.wav")))
      assert.strictEqual(wav.data.length, 0.51 * 24_000 * 2)
      assert.deepStrictEqual(wav.data.subarray(-2), Uint8Array.of(25, 25))
    }))
})
