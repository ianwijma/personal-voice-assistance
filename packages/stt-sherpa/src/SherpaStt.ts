/**
 * Stt entirely on this machine: sherpa-onnx streaming transducer + Silero VAD
 * in a worker thread, turn detection by `TurnDetector` on the main thread.
 */
import type { AudioError, SttEvent } from "@pva/core"
import { Stt, SttError } from "@pva/core"
import { Cause, Config, Effect, Layer, Option, Queue, Stream } from "effect"
import type { Scope } from "effect"
import { Worker } from "node:worker_threads"
import {
  defaultModelDir,
  DOWNLOAD_COMMAND,
  missingFile,
  modelFiles,
  type PresetName,
  presetNames,
  presets
} from "./presets.ts"
import { type EndOfTurnPolicy, fixedSilence, FRAME_MS, TurnDetector, type TurnInput } from "./TurnDetector.ts"

export interface SherpaSttOptions {
  /** Default `nemotron-3.5`. */
  readonly model?: PresetName
  /** Default `<repository root>/models`. */
  readonly modelDir?: string
  /** Recogniser threads. Default: the preset's. */
  readonly threads?: number
  /** `language` stream option for multilingual models ("auto", "en", "nl", ...). Default: the preset's. */
  readonly language?: string
  /** Silence before `EagerEndOfTurn`. Default 250. */
  readonly eagerSilenceMs?: number
  /** Silence before `EndOfTurn`. Default 600. */
  readonly finalSilenceMs?: number
  /** Replaces the two fixed silence thresholds. */
  readonly policy?: EndOfTurnPolicy
  /** Continuous speech needed for `SpeechStarted` / `TurnResumed`. Default 100. */
  readonly minSpeechMs?: number
  /** Silence appended when a segment is finalised. Default: the preset's. */
  readonly tailPaddingMs?: number
  /** Silero speech probability threshold. Default 0.5. */
  readonly vadThreshold?: number
  /** Audio before the VAD's speech onset that is also fed to the recogniser. Default 400. */
  readonly prerollMs?: number
  /** Audio waiting for the worker beyond this is dropped (and logged). Default 1000. */
  readonly maxBacklogMs?: number
}

const BYTES_PER_FRAME = FRAME_MS * 32 // 16 kHz * 2 bytes

type WorkerMessage =
  | { type: "ready"; loadMs: number }
  | { type: "frames"; session: number; speech: Array<0 | 1> }
  | { type: "partial"; session: number; text: string }
  | { type: "segment"; session: number; text: string; ms: number }
  | { type: "cancelled"; session: number }
  | { type: "error"; session: number; message: string }

interface Session {
  readonly id: number
  readonly onMessage: (message: WorkerMessage) => void
  readonly fail: (error: SttError) => void
}

const workerUrl = new URL("./worker.mjs", import.meta.url)

/** Starts the worker and waits until the model is loaded and warmed up. */
const startWorker = (workerData: unknown) =>
  Effect.callback<{ worker: Worker; loadMs: number }, SttError>((resume) => {
    const worker = new Worker(workerUrl, { workerData })
    const onMessage = (message: WorkerMessage) => {
      if (message.type !== "ready") return
      cleanup()
      resume(Effect.succeed({ worker, loadMs: message.loadMs }))
    }
    const onError = (cause: Error) => {
      cleanup()
      resume(Effect.fail(new SttError({ message: `Speech model failed to load: ${cause.message}`, cause })))
    }
    const onExit = (code: number) => onError(new Error(`worker exited with code ${code}`))
    const cleanup = () => {
      worker.off("message", onMessage)
      worker.off("error", onError)
      worker.off("exit", onExit)
    }
    worker.on("message", onMessage)
    worker.once("error", onError)
    worker.once("exit", onExit)
    return Effect.promise(() => worker.terminate())
  })

export const make = (options: SherpaSttOptions = {}): Effect.Effect<Stt["Service"], SttError, Scope.Scope> =>
  Effect.gen(function*() {
    const name = options.model ?? "nemotron-3.5"
    const preset = presets[name]
    if (!preset) {
      return yield* new SttError({ message: `Unknown speech model "${name}"; choose one of ${presetNames.join(", ")}` })
    }
    const modelDir = options.modelDir ?? defaultModelDir
    const files = modelFiles(preset, modelDir)
    const missing = missingFile(files)
    if (missing) {
      return yield* new SttError({
        message: `Speech model file not found: ${missing}. Download it with \`${DOWNLOAD_COMMAND} ${name}\`` +
          (options.modelDir ? ` --model-dir ${modelDir}` : "")
      })
    }
    const policy = options.policy ?? fixedSilence(options.eagerSilenceMs ?? 250, options.finalSilenceMs ?? 600)
    const minSpeechMs = options.minSpeechMs ?? 100
    const maxBacklogFrames = Math.ceil((options.maxBacklogMs ?? 1000) / FRAME_MS)

    let closing = false
    const { loadMs, worker } = yield* Effect.acquireRelease(
      startWorker({
        files,
        featureDim: preset.featureDim,
        threads: options.threads ?? preset.threads,
        language: options.language ?? ("language" in preset ? preset.language : undefined),
        tailPaddingMs: options.tailPaddingMs ?? preset.tailPaddingMs,
        vadThreshold: options.vadThreshold ?? 0.5,
        prerollMs: options.prerollMs ?? 400
      }),
      ({ worker }) =>
        Effect.promise(() => {
          closing = true
          return worker.terminate()
        })
    )
    yield* Effect.logInfo(`Local speech model ${name} loaded in ${Math.round(loadMs)} ms`)

    // One worker, one recogniser stream: one transcription at a time.
    let session: Session | undefined
    let sessions = 0
    let crashed: SttError | undefined
    const crash = (error: SttError) => {
      if (closing || crashed) return
      crashed = error
      session?.fail(error)
    }
    worker.on("message", (message: WorkerMessage) => {
      if (session && "session" in message && message.session === session.id) session.onMessage(message)
    })
    worker.on("error", (cause) => crash(new SttError({ message: `Speech worker crashed: ${cause.message}`, cause })))
    worker.on("exit", (code) => crash(new SttError({ message: `Speech worker exited with code ${code}` })))

    const transcribe = (audio: Stream.Stream<Uint8Array, AudioError>) =>
      Stream.callback<SttEvent, SttError>((queue) =>
        Effect.gen(function*() {
          if (crashed) return yield* crashed
          if (session) return yield* new SttError({ message: "The local recogniser is already transcribing" })
          const runLog = Effect.runForkWith(yield* Effect.context<never>())
          const id = ++sessions
          const detector = new TurnDetector({ policy, minSpeechMs })
          let audioEnded = false
          let done = false
          let sentBytes = 0
          let reportedFrames = 0
          let droppedFrames = 0

          const step = (input: TurnInput) => {
            for (const output of detector.step(input)) {
              if (output._tag === "Finalize") worker.postMessage({ type: "finalize", session: id, frame: output.frame })
              else Queue.offerUnsafe(queue, output)
            }
            if (audioEnded && detector.settled && !done) {
              done = true
              Queue.endUnsafe(queue)
            }
          }

          session = {
            id,
            fail: (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
            onMessage: (message) => {
              switch (message.type) {
                case "frames":
                  reportedFrames += message.speech.length
                  for (const speech of message.speech) step({ _tag: "Frame", speech: speech === 1 })
                  return
                case "partial":
                  return step({ _tag: "Partial", text: message.text })
                case "segment":
                  runLog(Effect.logDebug(`Segment finalised in ${message.ms.toFixed(0)} ms: ${message.text}`))
                  return step({ _tag: "Segment", text: message.text })
                case "cancelled":
                  return step({ _tag: "SegmentCancelled" })
                case "error":
                  return Queue.failCauseUnsafe(queue, Cause.fail(new SttError({ message: message.message })))
              }
            }
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              session = undefined
              if (!crashed && !closing) worker.postMessage({ type: "reset", session: 0 })
            })
          )
          worker.postMessage({ type: "reset", session: id })

          // Per batch of chunks: one memcpy into a fresh buffer that is transferred, not cloned.
          const send = (chunks: ReadonlyArray<Uint8Array>) => {
            let total = 0
            for (const chunk of chunks) total += chunk.length
            if (total === 0) return
            const backlog = Math.floor(sentBytes / BYTES_PER_FRAME) - reportedFrames
            if (backlog > maxBacklogFrames) {
              if (droppedFrames === 0) {
                runLog(Effect.logWarning(`Speech worker is ${backlog * FRAME_MS} ms behind; dropping audio`))
              }
              droppedFrames += total / BYTES_PER_FRAME
              return
            }
            if (droppedFrames > 0) {
              runLog(Effect.logWarning(`Speech worker caught up; dropped ${Math.round(droppedFrames * FRAME_MS)} ms of audio`))
              droppedFrames = 0
            }
            const buffer = new Uint8Array(total)
            let offset = 0
            for (const chunk of chunks) {
              buffer.set(chunk, offset)
              offset += chunk.length
            }
            worker.postMessage({ type: "audio", session: id, buffer: buffer.buffer }, [buffer.buffer])
            sentBytes += total
          }

          yield* Stream.runForEachArray(audio, (chunks) => Effect.sync(() => send(chunks))).pipe(
            Effect.mapError((cause) => new SttError({ message: `Audio input failed: ${cause.message}`, cause }))
          )
          audioEnded = true
          step({ _tag: "End" })
        })
      )

    return Stt.of({ transcribe })
  })

export const layer = (options: SherpaSttOptions = {}): Layer.Layer<Stt, SttError> => Layer.effect(Stt, make(options))

const optional = <A>(config: Config.Config<A>) => Config.option(config).pipe(Config.map(Option.getOrUndefined))

/**
 * Reads `STT_SHERPA_MODEL` (preset, default `nemotron-3.5`) and the optional
 * `STT_SHERPA_MODEL_DIR`, `STT_SHERPA_THREADS`, `STT_SHERPA_LANGUAGE`,
 * `STT_SHERPA_EAGER_SILENCE_MS` (250), `STT_SHERPA_FINAL_SILENCE_MS` (600),
 * `STT_SHERPA_MIN_SPEECH_MS` (100), `STT_SHERPA_VAD_THRESHOLD` (0.5).
 */
export const layerConfig: Layer.Layer<Stt, SttError | Config.ConfigError> = Layer.effect(
  Stt,
  Effect.gen(function*() {
    const config = yield* Config.all({
      model: Config.Literals(presetNames, "STT_SHERPA_MODEL").pipe(Config.withDefault("nemotron-3.5" as const)),
      modelDir: optional(Config.String("STT_SHERPA_MODEL_DIR")),
      threads: optional(Config.Int("STT_SHERPA_THREADS")),
      language: optional(Config.String("STT_SHERPA_LANGUAGE")),
      eagerSilenceMs: Config.Int("STT_SHERPA_EAGER_SILENCE_MS").pipe(Config.withDefault(250)),
      finalSilenceMs: Config.Int("STT_SHERPA_FINAL_SILENCE_MS").pipe(Config.withDefault(600)),
      minSpeechMs: Config.Int("STT_SHERPA_MIN_SPEECH_MS").pipe(Config.withDefault(100)),
      vadThreshold: Config.Finite("STT_SHERPA_VAD_THRESHOLD").pipe(Config.withDefault(0.5))
    })
    return yield* make(dropUndefined(config))
  })
)

/** `exactOptionalPropertyTypes`: leave unset options out instead of passing `undefined`. */
const dropUndefined = <A extends object>(value: A) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof A]: Exclude<A[K], undefined>
  }
