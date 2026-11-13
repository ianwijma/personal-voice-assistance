/**
 * Stt via Deepgram Flux (wss /v2/listen, eager end-of-turn), spoken directly
 * over `ws`. See `docs/protocols/deepgram-flux.md`.
 */
import type { SttEvent } from "@pva/core"
import { Stt, SttError } from "@pva/core"
import { Cause, Config, Effect, Layer, Queue, Redacted, Stream } from "effect"
import { FluxConnection } from "./FluxConnection.ts"

export interface DeepgramSttOptions {
  readonly apiKey: Redacted.Redacted<string>
  /** Default `wss://api.deepgram.com/v2/listen`. */
  readonly url?: string
  /** Default `flux-general-en`. */
  readonly model?: string
  /** Confidence for `EndOfTurn`, 0.5–1.0. Default 0.7. */
  readonly eotThreshold?: number
  /** Confidence for `EagerEndOfTurn`, 0.3–0.9 and <= `eotThreshold`. Default 0.5; 0 disables eager end-of-turn. */
  readonly eagerEotThreshold?: number
  /** Silence after which a turn ends regardless of confidence, 500–60000. Default 5000. */
  readonly eotTimeoutMs?: number
  /** Audio frame size sent to Deepgram. Default 80 (Deepgram's recommendation). */
  readonly chunkMs?: number
  /** Audio kept while reconnecting. Default 480. */
  readonly reconnectBufferMs?: number
  /** Reconnect backoff: doubles from `backoffInitialMs` up to `backoffMaxMs`, with jitter. Default 250 / 8000. */
  readonly backoffInitialMs?: number
  readonly backoffMaxMs?: number
}

export const DEFAULT_URL = "wss://api.deepgram.com/v2/listen"

export const connectionUrl = (options: DeepgramSttOptions): string => {
  const url = new URL(options.url ?? DEFAULT_URL)
  const params = url.searchParams
  params.set("model", options.model ?? "flux-general-en")
  params.set("encoding", "linear16")
  params.set("sample_rate", "16000")
  params.set("eot_threshold", String(options.eotThreshold ?? 0.7))
  const eager = options.eagerEotThreshold ?? 0.5
  if (eager > 0) params.set("eager_eot_threshold", String(eager))
  params.set("eot_timeout_ms", String(options.eotTimeoutMs ?? 5000))
  return url.toString()
}

export const make = (options: DeepgramSttOptions): Stt["Service"] => {
  const connection = {
    url: connectionUrl(options),
    apiKey: Redacted.value(options.apiKey),
    chunkMs: options.chunkMs ?? 80,
    reconnectBufferMs: options.reconnectBufferMs ?? 480,
    backoffInitialMs: options.backoffInitialMs ?? 250,
    backoffMaxMs: options.backoffMaxMs ?? 8000,
    keepAliveMs: 3000,
    stableMs: 10_000,
    closeTimeoutMs: 3000
  }
  return Stt.of({
    transcribe: (audio) =>
      Stream.callback<SttEvent, SttError>((queue) =>
        Effect.gen(function*() {
          const runLog = Effect.runForkWith(yield* Effect.context<never>())
          const flux = new FluxConnection(connection, {
            emit: (event) => Queue.offerUnsafe(queue, event),
            fail: (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
            end: () => Queue.endUnsafe(queue),
            log: (level, message) =>
              runLog(level === "warn" ? Effect.logWarning(message) : Effect.logInfo(message))
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => flux.stop()))
          flux.start()
          yield* Stream.runForEachArray(audio, (chunks) =>
            Effect.sync(() => {
              for (const chunk of chunks) flux.write(chunk)
            })).pipe(
              Effect.mapError((cause) => new SttError({ message: `Audio input failed: ${cause.message}`, cause }))
            )
          flux.finish()
        })
      )
  })
}

export const layer = (options: DeepgramSttOptions): Layer.Layer<Stt> => Layer.succeed(Stt, make(options))

/**
 * Reads `DEEPGRAM_API_KEY` (required) and the optional `DEEPGRAM_MODEL`,
 * `DEEPGRAM_EOT_THRESHOLD`, `DEEPGRAM_EAGER_EOT_THRESHOLD` (0 disables),
 * `DEEPGRAM_EOT_TIMEOUT_MS`, `DEEPGRAM_URL`.
 */
export const layerConfig: Layer.Layer<Stt, Config.ConfigError> = Layer.effect(
  Stt,
  Effect.gen(function*() {
    return make(yield* Config.all({
      apiKey: Config.Redacted("DEEPGRAM_API_KEY"),
      model: Config.String("DEEPGRAM_MODEL").pipe(Config.withDefault("flux-general-en")),
      eotThreshold: Config.Finite("DEEPGRAM_EOT_THRESHOLD").pipe(Config.withDefault(0.7)),
      eagerEotThreshold: Config.Finite("DEEPGRAM_EAGER_EOT_THRESHOLD").pipe(Config.withDefault(0.5)),
      eotTimeoutMs: Config.Int("DEEPGRAM_EOT_TIMEOUT_MS").pipe(Config.withDefault(5000)),
      url: Config.String("DEEPGRAM_URL").pipe(Config.withDefault(DEFAULT_URL))
    }))
  })
)
