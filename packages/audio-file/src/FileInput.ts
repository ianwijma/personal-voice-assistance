import { readFile } from "node:fs/promises"
import { AudioError, AudioInput } from "@pva/core"
import { Clock, Effect, Layer, Stream } from "effect"
import { parseWav, type Pcm16 } from "./Wav.ts"

export const inputSampleRate = 16_000
/** 20 ms of 16 kHz mono s16le. */
export const frameBytes = (inputSampleRate / 50) * 2
const frameNanos = 20_000_000n

export interface FileInputOptions {
  /** A `.wav` (16-bit PCM, 16 kHz, mono or multi-channel) or raw `.pcm` file (16 kHz mono s16le). */
  readonly path: string
  /** Silence before the file's audio. Default 0. */
  readonly leadingSilenceMs?: number | undefined
  /** Silence after the file's audio. Default 0. */
  readonly trailingSilenceMs?: number | undefined
  /**
   * Fill the silences with white noise at about -75 dBFS RMS instead of digital
   * zeros, like a quiet real microphone. Voice activity detectors can misbehave
   * on long runs of exact zeros (Silero holds "speech" longer afterwards).
   * Default false.
   */
  readonly noiseFloor?: boolean | undefined
  /**
   * After the audio (and trailing silence): `"end"` ends the stream (default);
   * `"silence"` keeps emitting silent frames forever, like a quiet microphone,
   * so a downstream turn detector can fire.
   */
  readonly atEnd?: "end" | "silence" | undefined
}

/** Validate and convert to 16 kHz mono s16le. Down-mixes by averaging; never resamples. */
export const toInputFormat = (pcm: Pcm16): Uint8Array => {
  if (pcm.sampleRate !== inputSampleRate) {
    throw new AudioError({ message: `unsupported sample rate ${pcm.sampleRate} Hz (need ${inputSampleRate} Hz; resample the file first)` })
  }
  if (pcm.channels === 1) return pcm.data
  if (pcm.channels < 1) throw new AudioError({ message: `invalid channel count ${pcm.channels}` })
  // Int16Array views assume a little-endian host (x86, ARM), as does the rest of the pipeline.
  const input = new Int16Array(pcm.data.buffer, pcm.data.byteOffset, pcm.data.length / 2)
  const output = new Int16Array(input.length / pcm.channels)
  for (let frame = 0; frame < output.length; frame++) {
    let sum = 0
    for (let c = 0; c < pcm.channels; c++) sum += input[frame * pcm.channels + c]!
    output[frame] = Math.round(sum / pcm.channels)
  }
  return new Uint8Array(output.buffer)
}

/** Read and decode the file into 16 kHz mono s16le. */
export const loadInputPcm = (path: string): Effect.Effect<Uint8Array, AudioError> =>
  Effect.tryPromise({
    try: () => readFile(path),
    catch: (cause) => new AudioError({ message: `cannot read ${path}`, cause })
  }).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => {
          const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          if (path.toLowerCase().endsWith(".pcm")) return data.slice(0, data.length - (data.length % 2))
          if (path.toLowerCase().endsWith(".wav")) return toInputFormat(parseWav(data))
          throw new AudioError({ message: `unsupported file type: ${path} (expected .wav or .pcm)` })
        },
        catch: (cause) => cause instanceof AudioError ? cause : new AudioError({ message: `cannot decode ${path}`, cause })
      })
    )
  )

const framesFor = (ms: number) => Math.ceil(ms / 20)

/** Amplitude of the noise floor: uniform ±10 of 32768, about -75 dBFS RMS. */
export const noiseFloorAmplitude = 10
let noiseState = 0x2545f491
/** One frame of uniform white noise (xorshift32, deterministic across runs). */
const noiseFrame = (): Uint8Array => {
  const samples = new Int16Array(frameBytes / 2)
  for (let i = 0; i < samples.length; i++) {
    noiseState ^= noiseState << 13
    noiseState ^= noiseState >>> 17
    noiseState ^= noiseState << 5
    samples[i] = ((noiseState >>> 0) % (2 * noiseFloorAmplitude + 1)) - noiseFloorAmplitude
  }
  return new Uint8Array(samples.buffer)
}

/**
 * Emit `pcm` as 20 ms frames paced in real time, like a microphone: frame `i`
 * is emitted at `start + (i + 1) * 20 ms` on the monotonic clock (when it would
 * have finished being captured). Each frame is scheduled against the start
 * time rather than by sleeping a fixed interval, so pacing does not drift.
 * The last frame of the file is zero-padded to a full frame.
 */
export const pacedFrames = (
  pcm: Uint8Array,
  options: Omit<FileInputOptions, "path"> = {}
): Stream.Stream<Uint8Array> => {
  const lead = framesFor(options.leadingSilenceMs ?? 0)
  const audio = Math.ceil(pcm.length / frameBytes)
  const total = lead + audio + framesFor(options.trailingSilenceMs ?? 0)
  const silent = options.noiseFloor === true ? noiseFrame : () => new Uint8Array(frameBytes)
  const frameAt = (i: number): Uint8Array => {
    const offset = (i - lead) * frameBytes
    if (i < lead || i >= lead + audio) return silent()
    if (offset + frameBytes <= pcm.length) return pcm.slice(offset, offset + frameBytes)
    const last = new Uint8Array(frameBytes)
    last.set(pcm.subarray(offset))
    return last
  }
  return Stream.unwrap(Effect.map(Clock.monotonicTimeNanos, (start) => {
    const indices = Stream.iterate(0, (i) => i + 1)
    return (options.atEnd === "silence" ? indices : Stream.take(indices, total)).pipe(
      Stream.mapEffect((i) =>
        Effect.flatMap(Clock.monotonicTimeNanos, (now) => {
          const due = start + BigInt(i + 1) * frameNanos
          const frame = frameAt(i)
          return due > now ? Effect.as(Effect.sleep(Number(due - now) / 1e6), frame) : Effect.succeed(frame)
        })
      )
    )
  }))
}

/** `AudioInput` that plays a file as if it were spoken into a microphone. */
export const makeFileInput = (options: FileInputOptions) =>
  AudioInput.of({
    stream: Stream.unwrap(Effect.map(loadInputPcm(options.path), (pcm) => pacedFrames(pcm, options)))
  })

export const layerInput = (options: FileInputOptions): Layer.Layer<AudioInput> =>
  Layer.succeed(AudioInput, makeFileInput(options))
