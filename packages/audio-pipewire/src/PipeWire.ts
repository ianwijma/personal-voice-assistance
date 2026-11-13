import { AudioError, AudioInput, AudioOutput } from "@pva/core"
import { Cause, Config, Deferred, Effect, Layer, Queue, Stream } from "effect"
import { type Command, describeExit, spawnScoped } from "./Process.ts"

export interface PipeWireOptions {
  /** `node.name` or serial of the capture source (e.g. an echo-cancel source). Default: PipeWire's choice. */
  readonly captureTarget?: string | undefined
  /** `node.name` or serial of the playback sink (e.g. an echo-cancel sink). Default: PipeWire's choice. */
  readonly playbackTarget?: string | undefined
  /** Requested capture node latency in ms (pw-cat's default is 100 ms). */
  readonly captureLatencyMs: number
  /** Requested playback node latency in ms. */
  readonly playbackLatencyMs: number
}

export const defaultOptions: PipeWireOptions = { captureLatencyMs: 20, playbackLatencyMs: 20 }

export const captureSampleRate = 16_000
/** 20 ms of 16 kHz mono s16le. */
export const captureFrameBytes = (captureSampleRate / 50) * 2

const commonArgs = (sampleRate: number, latencyMs: number, target: string | undefined) => [
  "--raw",
  "--format", "s16",
  "--rate", String(sampleRate),
  "--channels", "1",
  "--latency", `${latencyMs}ms`,
  ...(target === undefined ? [] : ["--target", target]),
  "-" // stdin / stdout
]

/** `pw-record` writing raw 16 kHz mono s16le to stdout. Flags checked against pw-cat 1.6.2 `--help`. */
export const captureCommand = (options: PipeWireOptions): Command => ({
  command: "pw-record",
  args: [...commonArgs(captureSampleRate, options.captureLatencyMs, options.captureTarget), "--media-role", "Communication"]
})

/** `pw-cat --playback` reading raw mono s16le at `sampleRate` from stdin. */
export const playbackCommand = (options: PipeWireOptions, sampleRate: number): Command => ({
  command: "pw-cat",
  args: ["--playback", ...commonArgs(sampleRate, options.playbackLatencyMs, options.playbackTarget), "--media-role", "Communication"]
})

/**
 * Cut an arbitrary byte stream into frames of exactly `frameBytes` (a partial
 * frame is held until the next push). Works on whole byte arrays: one copy per
 * frame, no per-sample work.
 */
export const makeReframer = (frameBytes: number) => {
  let pending = new Uint8Array(0)
  return (data: Uint8Array): Array<Uint8Array> => {
    let bytes = data
    if (pending.length > 0) {
      bytes = new Uint8Array(pending.length + data.length)
      bytes.set(pending)
      bytes.set(data, pending.length)
    }
    const frames: Array<Uint8Array> = []
    let offset = 0
    for (; offset + frameBytes <= bytes.length; offset += frameBytes) {
      frames.push(bytes.slice(offset, offset + frameBytes))
    }
    pending = bytes.slice(offset)
    return frames
  }
}

/**
 * Microphone stream from a capture process writing raw PCM to stdout. The
 * process is spawned when the stream is consumed and killed when the consumer
 * stops. Capture never ends on its own, so any exit fails the stream.
 * A consumer that falls behind loses the oldest audio beyond 3 s (`captureBufferFrames`), as the web input does:
 * a stalled consumer must not make the capture process's output pile up here.
 */
export const captureStream = (command: Command, frameBytes = captureFrameBytes): Stream.Stream<Uint8Array, AudioError> =>
  Stream.callback<Uint8Array, AudioError>((queue) =>
    Effect.gen(function*() {
      const proc = yield* spawnScoped(command)
      const reframe = makeReframer(frameBytes)
      proc.child.stdout.on("data", (data: Buffer) => {
        for (const frame of reframe(data)) Queue.offerUnsafe(queue, frame)
      })
      const exit = yield* Deferred.await(proc.exited)
      // Let stdout deliver what it already read, so the error follows the last audio.
      yield* Effect.callback<void>((resume) => {
        if (proc.child.stdout.readableEnded || proc.child.stdout.destroyed) resume(Effect.void)
        else proc.child.stdout.once("close", () => resume(Effect.void))
      })
      Queue.failCauseUnsafe(queue, Cause.fail(new AudioError({ message: describeExit(command, exit, proc.stderr()) })))
    }), { bufferSize: captureBufferFrames, strategy: "sliding" }
  )

/** Capture frames held for a consumer that falls behind: 3 s of 20 ms frames. */
export const captureBufferFrames = 150

/**
 * A player that stops reading (a hung PipeWire, a stopped process) would hold the reply, and the turn, for ever.
 * A write that waits longer than this, or an exit that does not follow the end of input within it, fails the
 * playback (the player is killed). Longer than the most a player legitimately takes: draining what is buffered
 * ahead of it (the ~200 KiB pipe, about 4.5 s at 22.05 kHz).
 */
export const PLAYER_STALL_MS = 10_000

/**
 * Play `audio` through a player process reading raw PCM from stdin; returns
 * once the player has exited after draining (pw-cat waits for the stream to be
 * drained before exiting at end of input). Interruption SIGKILLs the player,
 * which drops everything still in the pipe, in pw-cat and in its PipeWire node.
 *
 * One process per `play` call rather than a warm player:
 * - A warm player cannot drop what is buffered in the pipe and in its node
 *   without being killed, so barge-in would respawn it anyway.
 * - With a warm player, end of input is not observable, so "finished playing"
 *   could only be estimated from byte counts and clocks.
 * - Spawn costs little: pw-cat reaches the `streaming` state about 10 ms after
 *   spawn (measured with `pw-cat -v` on PipeWire 1.6.2), and we spawn as soon as
 *   `play` is called, so the startup overlaps with waiting for the first chunk.
 *
 * Backpressure: each chunk is written to stdin and, when Node's write buffer is
 * full, we wait for `drain`. What is queued ahead of the player is bounded by
 * the kernel buffer of Node's stdio channel (a socketpair on Linux, ~200 KiB,
 * measured ~176 KiB in the stall test) plus Node's 16 KiB highWaterMark. That
 * read-ahead only protects against underruns; all of it is dropped on kill.
 */
export const playThrough = <E>(command: Command, audio: Stream.Stream<Uint8Array, E>, stallMs = PLAYER_STALL_MS): Effect.Effect<void, E | AudioError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const proc = yield* spawnScoped(command)
      const stdin = proc.child.stdin
      let ended = false

      const write = (chunk: Uint8Array) =>
        Effect.callback<void>((resume) => {
          // The player died: stop writing and let the exit be reported below.
          if (stdin.destroyed) return
          if (stdin.write(chunk)) return resume(Effect.void)
          const done = () => {
            stdin.off("drain", done)
            stdin.off("close", done)
            resume(Effect.void)
          }
          stdin.on("drain", done)
          stdin.on("close", done)
          return Effect.sync(() => {
            stdin.off("drain", done)
            stdin.off("close", done)
          })
        })

      const stalled = (what: string) => () =>
        Effect.fail(new AudioError({ message: `${command.command} ${what} for ${stallMs} ms; playback stopped` }))
      const feed = Stream.runForEach(audio, (chunk) =>
        Effect.timeoutOrElse(write(chunk), { duration: stallMs, orElse: stalled("stopped reading its input") })).pipe(
        Effect.andThen(Effect.sync(() => {
          ended = true
          stdin.end()
        })),
        Effect.andThen(Effect.sleep(stallMs)),
        Effect.andThen(stalled("did not exit after the end of its input")())
      )

      const exit = yield* Effect.raceFirst(feed, Deferred.await(proc.exited))
      if (!ended || exit.code !== 0) {
        const reason = ended ? "" : " before the audio was written"
        return yield* new AudioError({ message: describeExit(command, exit, proc.stderr()) + reason })
      }
    })
  )

/** `AudioInput` from any capture command (tests inject a stand-in). */
export const makeAudioInput = (command: Command, frameBytes = captureFrameBytes) =>
  AudioInput.of({ stream: captureStream(command, frameBytes) })

/** `AudioOutput` from any per-call player command (tests inject a stand-in). */
export const makeAudioOutput = (commandFor: (sampleRate: number) => Command) =>
  AudioOutput.of({ play: (audio, sampleRate) => playThrough(commandFor(sampleRate), audio) })

export const layerInput = (options: PipeWireOptions = defaultOptions): Layer.Layer<AudioInput> =>
  Layer.succeed(AudioInput, makeAudioInput(captureCommand(options)))

export const layerOutput = (options: PipeWireOptions = defaultOptions): Layer.Layer<AudioOutput> =>
  Layer.succeed(AudioOutput, makeAudioOutput((rate) => playbackCommand(options, rate)))

export const layer = (options: PipeWireOptions = defaultOptions): Layer.Layer<AudioInput | AudioOutput> =>
  Layer.mergeAll(layerInput(options), layerOutput(options))

/**
 * Options from the environment:
 * `PIPEWIRE_CAPTURE_TARGET`, `PIPEWIRE_PLAYBACK_TARGET` (node names, optional),
 * `PIPEWIRE_CAPTURE_LATENCY_MS`, `PIPEWIRE_PLAYBACK_LATENCY_MS` (default 20).
 */
export const PipeWireConfig: Config.Config<PipeWireOptions> = Config.all({
  captureTarget: Config.String("PIPEWIRE_CAPTURE_TARGET").pipe(Config.withDefault(undefined)),
  playbackTarget: Config.String("PIPEWIRE_PLAYBACK_TARGET").pipe(Config.withDefault(undefined)),
  captureLatencyMs: Config.Int("PIPEWIRE_CAPTURE_LATENCY_MS").pipe(Config.withDefault(defaultOptions.captureLatencyMs)),
  playbackLatencyMs: Config.Int("PIPEWIRE_PLAYBACK_LATENCY_MS").pipe(Config.withDefault(defaultOptions.playbackLatencyMs))
})

export const layerConfig: Layer.Layer<AudioInput | AudioOutput, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    return layer(yield* PipeWireConfig)
  })
)
