import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AudioError, AudioOutput } from "@pva/core"
import { Clock, Effect, Layer, Stream } from "effect"
import { encodeWav } from "./Wav.ts"

export interface FileOutputOptions {
  /** Directory for the WAV files; created if missing. */
  readonly directory: string
  /** File name prefix. Default `"reply"`. */
  readonly prefix?: string | undefined
}

interface Segment {
  readonly chunk: Uint8Array
  /** Monotonic nanos at which this chunk starts / finishes "playing". */
  readonly start: bigint
  readonly end: bigint
}

/** The audio that had been heard by `at` (everything when `at` is undefined), cut on a sample boundary. */
const playedUntil = (segments: ReadonlyArray<Segment>, at: bigint | undefined): Uint8Array => {
  const parts: Array<Uint8Array> = []
  for (const s of segments) {
    if (at === undefined || s.end <= at) parts.push(s.chunk)
    else if (s.start < at) {
      const samples = Math.floor((s.chunk.length / 2) * Number(at - s.start) / Number(s.end - s.start))
      parts.push(s.chunk.subarray(0, samples * 2))
    }
  }
  return Buffer.concat(parts)
}

/**
 * `AudioOutput` that "plays" into WAV files in real time: each chunk takes its
 * duration to play (scheduled on the monotonic clock, so it works under
 * `TestClock`), and `play` returns when the last chunk has finished. If audio
 * arrives slower than real time the speaker idles, as a real one would (the gap
 * is not written to the file).
 *
 * One numbered file per `play` call (`reply-001.wav`, `reply-002.wav`, ...),
 * rather than appending to one file: each `play` is one assistant reply, so a
 * benchmark run can be listened to reply by reply, an interrupted reply is
 * visibly shorter, and replies with different sample rates stay valid WAVs.
 * Numbering restarts at 1 for each layer instance, overwriting older files.
 *
 * The file is written when `play` ends: completely on success, and on
 * interruption or upstream failure with exactly what had been played so far.
 */
export const makeFileOutput = (options: FileOutputOptions) => {
  mkdirSync(options.directory, { recursive: true })
  let count = 0
  return AudioOutput.of({
    play: (audio, sampleRate) =>
      Effect.suspend(() => {
        count += 1
        const path = join(options.directory, `${options.prefix ?? "reply"}-${String(count).padStart(3, "0")}.wav`)
        const segments: Array<Segment> = []
        let playhead = 0n
        const save = (at: bigint | undefined) =>
          Effect.try({
            try: () => writeFileSync(path, encodeWav({ sampleRate, channels: 1, data: playedUntil(segments, at) })),
            catch: (cause) => new AudioError({ message: `cannot write ${path}`, cause })
          })
        const playChunk = (chunk: Uint8Array) =>
          Effect.flatMap(Clock.monotonicTimeNanos, (now) => {
            const start = now > playhead ? now : playhead
            playhead = start + BigInt(Math.round((chunk.length / 2 / sampleRate) * 1e9))
            segments.push({ chunk, start, end: playhead })
            return Effect.sleep(Number(playhead - now) / 1e6)
          })
        return Stream.runForEach(audio, playChunk).pipe(
          Effect.onError(() => Effect.ignore(Effect.flatMap(Clock.monotonicTimeNanos, save))),
          Effect.andThen(save(undefined))
        )
      })
  })
}

export const layerOutput = (options: FileOutputOptions): Layer.Layer<AudioOutput> =>
  Layer.sync(AudioOutput, () => makeFileOutput(options))
