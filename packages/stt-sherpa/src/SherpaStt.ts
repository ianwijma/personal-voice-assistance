/**
 * Stt entirely on this machine: a sherpa-onnx recogniser (streaming, whole-turn
 * or both, see presets.ts) + Silero VAD + optional AGC in a worker thread, turn
 * detection by `TurnDetector` on the main thread.
 */
import type { AudioError, SttEvent } from "@pva/core"
import { Stt, SttError } from "@pva/core"
import { Cause, Config, Deferred, Effect, Exit, Layer, Option, Queue, Scope, Stream } from "effect"
import { Worker } from "node:worker_threads"
import type { AgcOptions } from "./agc.d.mts"
import {
  DEFAULT_PRESET,
  DEFAULT_VAD_THRESHOLD,
  defaultModelDir,
  legacyPresetNames,
  missingModelMessage,
  modelFiles,
  type Preset,
  type PresetName,
  presetNames,
  presets,
  resolvePresetName,
  takesLanguage
} from "./presets.ts"
import { type EndOfTurnPolicy, fixedSilence, FRAME_MS, TurnDetector, type TurnInput } from "./TurnDetector.ts"

export interface SherpaSttOptions {
  /** Default `parakeet-v2`. */
  readonly model?: PresetName
  /** Default `<repository root>/models`. */
  readonly modelDir?: string
  /** Recogniser threads. Default: the preset's. */
  readonly threads?: number
  /**
   * Language for models that take one ("auto", "en", "nl", ...): Nemotron's per-stream option,
   * Whisper's decoder language ("auto" = detect). Ignored by Parakeet. Default: the preset's, else "auto".
   */
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
  /** Automatic gain in front of the VAD and the recogniser (agc.mjs). `false` turns it off. Default on. */
  readonly agc?: boolean | AgcOptions
  /** Whole-turn models: longest turn decoded in one piece. Default: the preset's. */
  readonly maxTurnMs?: number
  /** Whole-turn models: interim text every this many ms of speech (0 = none). Default: the preset's. */
  readonly interimMs?: number
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
  | {
    type: "segment"
    session: number
    text: string
    ms: number
    cumulative: boolean
    decodeMs?: number
    audioMs?: number
    gainDb?: number
  }
  | { type: "cancelled"; session: number }
  | { type: "flushed"; session: number }
  | { type: "closed" }
  | { type: "error"; session: number; message: string }
  /** Whole-turn: decoding is so far behind (a native decode that does not return) that a turn was dropped. */
  | { type: "overload"; session: number; message: string }
  /** A turn boundary could not be honoured exactly. */
  | { type: "warning"; session: number; message: string }

interface Session {
  readonly id: number
  readonly onMessage: (message: WorkerMessage) => void
  readonly fail: (error: SttError) => void
}

const workerUrl = new URL("./worker.mjs", import.meta.url)

/** Longest wait for the worker's native decodes to finish when closing (a whole-turn decode takes up to ~3 s). */
const CLOSE_WAIT_MS = 15_000

/**
 * Workers that did not answer `close` in time and were left running (each holds a loaded model, up to about a
 * gigabyte), by worker key (`workerKey`). While one of a key is left behind, no new worker of that key is loaded
 * beside it (see `acquire`), so at most one per key is ever left behind; it is counted out when it finally
 * answers or exits. Workers of other keys (other models) still load (docs/ASSISTANTS.md §3.2: the rule is per key).
 */
const orphanedByKey = new Map<string, number>()

/** Workers left running after a close that timed out (diagnostics, tests): of `key`, or of every key. */
export const orphans = (key?: string): number =>
  key === undefined ? [...orphanedByKey.values()].reduce((a, b) => a + b, 0) : orphanedByKey.get(key) ?? 0

let orphanWaiters: Array<{ readonly key: string | undefined; readonly resolve: () => void }> = []
const orphanGone = () => {
  const waiting = orphanWaiters
  orphanWaiters = []
  for (const w of waiting) {
    if (orphans(w.key) === 0) w.resolve()
    else orphanWaiters.push(w)
  }
}

/** Resolves once no worker (of `key`, or of any key) is left behind (at once if none is). */
export const whenNoOrphans = (key?: string): Promise<void> =>
  orphans(key) === 0 ? Promise.resolve() : new Promise((resolve) => orphanWaiters.push({ key, resolve }))

const orphanedMessage =
  "The previous local speech model has not shut down: a native decode has not finished, and it still holds its memory. " +
  "No second model is loaded beside it; try again once it finishes, or restart the assistant."

/** Whether an error message is the one for a model that cannot load because the previous one is still running. */
export const isOrphanedMessage = (message: string): boolean => message.includes(orphanedMessage)

/**
 * Stops the worker without cutting a native decode short: terminating the thread while `decodeAsync` runs
 * aborts the whole process. The worker is asked to close and answers once its decodes have settled; only then
 * is it terminated. If that takes longer than `closeWaitMs` the worker is left to finish on its own (it no
 * longer keeps the process alive, and is terminated when it answers) and counted in `orphanedByKey` for `key`.
 * Succeeds with `true` when it was left behind. A worker that has already exited (it crashed) has nothing to wait for.
 */
const stopWorker = (worker: Worker, key: string, closeWaitMs: number, exited: () => boolean) =>
  Effect.callback<boolean>((resume) => {
    if (exited()) return resume(Effect.succeed(false))
    let done = false
    let orphaned = false
    const finish = (left: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resume(Effect.succeed(left))
    }
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "closed") worker.terminate().then(() => finish(false), () => finish(false))
    })
    worker.once("exit", () => {
      if (orphaned) {
        orphaned = false
        const left = (orphanedByKey.get(key) ?? 1) - 1
        if (left > 0) orphanedByKey.set(key, left)
        else orphanedByKey.delete(key)
        orphanGone()
      }
      finish(false)
    })
    const timer = setTimeout(() => {
      worker.unref()
      orphaned = true
      orphanedByKey.set(key, (orphanedByKey.get(key) ?? 0) + 1)
      finish(true)
    }, closeWaitMs)
    timer.unref()
    worker.postMessage({ type: "close" })
  })

/** Starts the worker and waits until the model is loaded and warmed up. */
const startWorker = (url: URL, workerData: unknown) =>
  Effect.callback<{ worker: Worker; loadMs: number }, SttError>((resume) => {
    const worker = new Worker(url, { workerData })
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

/** The language the worker is configured with (`""`: the preset takes none, so it is not part of the worker key). */
const languageOf = (preset: Preset, options: Pick<SherpaSttOptions, "language">): string =>
  takesLanguage(preset) ? options.language ?? (preset.kind === "streaming" ? preset.language : undefined) ?? "auto" : ""

/**
 * What the worker needs (see worker.mjs): the model, per model. The VAD threshold, gain control and pre-roll here are
 * only the defaults of a session that does not send its own (every session of `acquire`'s recognisers does).
 */
const workerConfig = (preset: Preset, modelDir: string, options: SherpaSttOptions) => {
  const files = modelFiles(preset, modelDir)
  const language = languageOf(preset, options) || "auto"
  const common = {
    kind: preset.kind,
    vad: { file: files.vad, threshold: DEFAULT_VAD_THRESHOLD },
    prerollMs: DEFAULT_PREROLL_MS,
    agc: {}
  }
  switch (preset.kind) {
    case "streaming":
      return {
        ...common,
        streaming: {
          files: files.streaming!,
          featureDim: preset.model.featureDim,
          threads: options.threads ?? preset.threads,
          language: preset.model.multilingual ? language : undefined,
          tailPaddingMs: options.tailPaddingMs ?? preset.model.tailPaddingMs
        }
      }
    case "offline":
      return {
        ...common,
        offline: {
          files: files.offline!,
          threads: options.threads ?? preset.threads,
          // Whisper: "" = detect the language.
          language: preset.takesLanguage ? (language === "auto" ? "" : language) : undefined,
          maxTurnMs: options.maxTurnMs ?? preset.maxTurnMs,
          interimMs: options.interimMs ?? preset.interimMs
        }
      }
    case "hybrid":
      return {
        ...common,
        streaming: {
          files: files.streaming!,
          featureDim: preset.streaming.featureDim,
          threads: preset.streamingThreads,
          language: "en",
          tailPaddingMs: preset.streaming.tailPaddingMs
        },
        offline: { files: files.offline!, threads: options.threads ?? preset.threads, maxTurnMs: options.maxTurnMs ?? preset.maxTurnMs }
      }
  }
}

const DEFAULT_PREROLL_MS = 400

/** A test stand-in for the worker script (`makeWithWorker`, `acquire`). */
export interface WorkerScript {
  readonly url?: URL
  readonly data?: Readonly<Record<string, unknown>>
  readonly closeWaitMs?: number
}

/**
 * The options that need a worker of their own (docs/ASSISTANTS.md §3.2, `SttKey`): the model, the model directory,
 * the recogniser threads, the language (only for a preset that takes one), and the per-model tuning (tail padding,
 * longest turn, interim interval). Everything else is per stream (`SherpaStreamOptions`). Two `make` / `acquire`
 * calls with the same key share one worker. `script` (tests) is part of the key.
 */
export const workerKey = (options: SherpaSttOptions = {}, script: WorkerScript = {}): string => {
  const name = options.model ?? DEFAULT_PRESET
  const preset: Preset | undefined = presets[name]
  return JSON.stringify([
    name,
    options.modelDir ?? defaultModelDir,
    options.threads ?? preset?.threads ?? 0,
    preset === undefined ? options.language ?? "" : languageOf(preset, options),
    options.tailPaddingMs ?? null,
    options.maxTurnMs ?? null,
    options.interimMs ?? null,
    script.url?.href ?? null,
    script.data ?? null
  ])
}

/**
 * Per stream (one `transcribe` call; docs/ASSISTANTS.md §3.2): turn timing on the main thread (`TurnDetector`), and
 * the worker session's VAD threshold, gain control and pre-roll. Two streams with different values share a worker.
 */
export type SherpaStreamOptions = Pick<
  SherpaSttOptions,
  "eagerSilenceMs" | "finalSilenceMs" | "policy" | "minSpeechMs" | "vadThreshold" | "agc" | "prerollMs" | "maxBacklogMs"
>

/** One loaded model (one worker), shared by every stream that hears with it. */
export interface Recogniser {
  /** `workerKey` of the worker. */
  readonly key: string
  readonly model: PresetName
  /** Time the worker took to load and warm up the model, ms. */
  readonly loadMs: number
  /** An `Stt` whose streams use these per-stream options on this worker (cheap: no model load). */
  readonly forStream: (options?: SherpaStreamOptions) => Stt["Service"]
  /** The worker died (crash or exit): every stream on it has failed, and every later one fails at once. */
  readonly failure: () => SttError | undefined
  /** Called once if the worker dies. The returned function unsubscribes. */
  readonly onFailure: (listener: (error: SttError) => void) => () => void
}

interface WorkerSlot {
  refs: number
  readonly scope: Scope.Closeable
  readonly ready: Deferred.Deferred<Recogniser, SttError>
}

/** Loaded workers by key: shared by every `make` / `acquire` with that key, counted, stopped with the last user. */
const slots = new Map<string, WorkerSlot>()
/** Workers being stopped, by key: a new worker of that key waits for the stop (and its orphan rule). */
const stopping = new Map<string, Promise<void>>()

/** Workers loaded now (one per distinct `workerKey`; diagnostics, tests). */
export const workers = (): number => slots.size

/** `make` with another worker script (tests: a stand-in that speaks the worker protocol without a model). */
export const makeWithWorker = (options: SherpaSttOptions, script: WorkerScript = {}): Effect.Effect<Stt["Service"], SttError, Scope.Scope> =>
  Effect.map(acquire(options, script), (recogniser) => recogniser.forStream(options))

/**
 * The shared worker for `options`' key (`workerKey`): loaded by the first caller, reused by the others, stopped when
 * the last caller's scope closes. A worker that died is not reused: the next caller loads a new one. While a worker
 * of the same key is being stopped, this waits for it; while one of the same key is left behind (an orphan), this
 * fails (no second copy of a model beside one that has not shut down).
 */
export const acquire = (options: SherpaSttOptions = {}, script: WorkerScript = {}): Effect.Effect<Recogniser, SttError, Scope.Scope> =>
  Effect.gen(function*() {
    const key = workerKey(options, script)
    const previous = stopping.get(key)
    if (previous !== undefined && !slots.has(key)) yield* Effect.promise(() => previous)
    const joined = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const existing = slots.get(key)
        if (existing !== undefined) {
          existing.refs++
          return { slot: existing, builder: false }
        }
        const slot: WorkerSlot = { refs: 1, scope: Effect.runSync(Scope.make()), ready: Deferred.makeUnsafe() }
        slots.set(key, slot)
        return { slot, builder: true }
      }),
      ({ slot }) =>
        Effect.suspend(() => {
          if (--slot.refs > 0) return Effect.void
          if (slots.get(key) === slot) slots.delete(key)
          const closed = Effect.runPromise(Scope.close(slot.scope, Exit.void)).finally(() => {
            if (stopping.get(key) === closed) stopping.delete(key)
          })
          stopping.set(key, closed)
          return Effect.promise(() => closed)
        })
    )
    if (joined.builder) {
      yield* Scope.provide(loadWorker(key, options, script, () => {
        // Dead: not offered to later callers (they load a new one).
        if (slots.get(key) === joined.slot) slots.delete(key)
      }), joined.slot.scope).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            if (Exit.isSuccess(exit)) return Deferred.done(joined.slot.ready, exit)
            if (slots.get(key) === joined.slot) slots.delete(key)
            const failure = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Cause.squash(exit.cause) : undefined
            const error = failure instanceof SttError ? failure : new SttError({ message: "The local speech model did not load." })
            return Effect.andThen(Deferred.fail(joined.slot.ready, error), Scope.close(joined.slot.scope, Exit.void))
          })
        ),
        Effect.uninterruptible
      )
    }
    return yield* Deferred.await(joined.slot.ready)
  })

/** Loads one worker in the scope it is given (closed when its last user is gone). */
const loadWorker = (
  key: string,
  options: SherpaSttOptions,
  script: WorkerScript,
  died: () => void
): Effect.Effect<Recogniser, SttError, Scope.Scope> =>
  Effect.gen(function*() {
    const name = options.model ?? DEFAULT_PRESET
    yield* check(options, script)
    if (orphans(key) > 0) return yield* new SttError({ message: orphanedMessage })
    const preset: Preset = presets[name]
    const modelDir = options.modelDir ?? defaultModelDir
    const cumulative = preset.kind !== "streaming"
    const closeWaitMs = script.closeWaitMs ?? CLOSE_WAIT_MS

    let closing = false
    let exited = false
    const { loadMs, worker } = yield* Effect.acquireRelease(
      startWorker(script.url ?? workerUrl, { ...workerConfig(preset, modelDir, options), ...script.data }),
      ({ worker }) =>
        Effect.suspend(() => {
          closing = true
          return stopWorker(worker, key, closeWaitMs, () => exited).pipe(
            Effect.flatMap((left) =>
              left
                ? Effect.logWarning(
                  `The local speech model ${name} did not shut down within ${Math.round(closeWaitMs / 1000)} s ` +
                    "(a native decode is still running); it was left to finish and keeps its memory until then. " +
                    "This model is not loaded again while it runs."
                )
                : Effect.void
            )
          )
        })
    )
    yield* Effect.logInfo(`Local speech model ${name} loaded in ${Math.round(loadMs)} ms`)

    // One worker (one loaded model), any number of concurrent transcriptions: each is a session of its own in the
    // worker (its own VAD and turn state) and here (its own TurnDetector). A crash fails every open one.
    const open = new Map<number, Session>()
    let sessions = 0
    let crashed: SttError | undefined
    const listeners = new Set<(error: SttError) => void>()
    const crash = (error: SttError) => {
      if (closing || crashed) return
      crashed = error
      died()
      // The listeners first: failing a stream may run its consumer at once.
      const told = [...listeners]
      listeners.clear()
      for (const listener of told) {
        try {
          listener(error)
        } catch {
          // a throwing listener changes nothing here
        }
      }
      for (const session of [...open.values()]) session.fail(error)
    }
    worker.on("message", (message: WorkerMessage) => {
      if (!("session" in message)) return
      open.get(message.session)?.onMessage(message)
    })
    worker.on("error", (cause) => crash(new SttError({ message: `Speech worker crashed: ${cause.message}`, cause })))
    worker.on("exit", (code) => {
      exited = true
      crash(new SttError({ message: `Speech worker exited with code ${code}` }))
    })

    const transcribe = (stream: SherpaStreamOptions, audio: Stream.Stream<Uint8Array, AudioError>) =>
      Stream.callback<SttEvent, SttError>((queue) =>
        Effect.gen(function*() {
          if (crashed) return yield* crashed
          const policy = stream.policy ?? fixedSilence(stream.eagerSilenceMs ?? 250, stream.finalSilenceMs ?? 600)
          const minSpeechMs = stream.minSpeechMs ?? 100
          const maxBacklogFrames = Math.ceil((stream.maxBacklogMs ?? 1000) / FRAME_MS)
          const runLog = Effect.runForkWith(yield* Effect.context<never>())
          const id = ++sessions
          const detector = new TurnDetector({ policy, minSpeechMs, cumulative })
          let audioEnded = false
          let done = false
          let sentBytes = 0
          let reportedFrames = 0
          let droppedFrames = 0

          const step = (input: TurnInput) => {
            for (const output of detector.step(input)) {
              if (output._tag === "Finalize") {
                worker.postMessage({ type: "finalize", session: id, frame: output.frame, ...(output.through ? { through: true } : {}) })
              }
              else if (output._tag === "Commit") worker.postMessage({ type: "commit", session: id, frame: output.frame })
              else Queue.offerUnsafe(queue, output)
            }
            if (audioEnded && detector.settled && !done) {
              done = true
              Queue.endUnsafe(queue)
            }
          }

          open.set(id, {
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
                  runLog(Effect.logDebug(
                    message.cumulative
                      ? `Turn decoded (${((message.audioMs ?? 0) / 1000).toFixed(1)} s of audio) in ${(message.decodeMs ?? message.ms).toFixed(0)} ms` +
                        ` (${message.ms.toFixed(0)} ms after the request)` +
                        (message.gainDb !== undefined ? `, gain ${message.gainDb.toFixed(1)} dB` : "") + `: ${message.text}`
                      : `Segment finalised in ${message.ms.toFixed(0)} ms: ${message.text}`
                  ))
                  return step({ _tag: "Segment", text: message.text })
                case "cancelled":
                  return step({ _tag: "SegmentCancelled" })
                case "flushed":
                  // Every frame of the input has been reported: the audio has really ended for the detector.
                  if (!audioEnded) {
                    audioEnded = true
                    step({ _tag: "End" })
                  }
                  return
                case "error":
                  return Queue.failCauseUnsafe(queue, Cause.fail(new SttError({ message: message.message })))
                case "overload":
                  runLog(Effect.logWarning(`Local speech model ${name}: ${message.message}`))
                  return
                case "warning":
                  runLog(Effect.logWarning(`Local speech model ${name}: ${message.message}`))
                  return
              }
            }
          })
          // Closing this transcription ends only its session in the worker; the others keep running.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              open.delete(id)
              if (!crashed && !closing) worker.postMessage({ type: "end", session: id })
            })
          )
          worker.postMessage({ type: "open", session: id, options: sessionOptionsOf(stream) })

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
          // The worker may still be processing the last buffers (and the detector may be waiting for none of
          // them yet): end only after it has reported every frame. Messages to the worker are handled in order.
          worker.postMessage({ type: "flush", session: id })
        })
      )

    return {
      key,
      model: name,
      loadMs,
      forStream: (stream = {}) => Stt.of({ transcribe: (audio) => transcribe(stream, audio) }),
      failure: () => crashed,
      onFailure: (listener) => {
        if (crashed !== undefined) {
          listener(crashed)
          return () => {}
        }
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    } satisfies Recogniser
  })

/** The worker session's share of the per-stream options (`open`'s `options`, worker.mjs). */
const sessionOptionsOf = (stream: SherpaStreamOptions) => ({
  vadThreshold: stream.vadThreshold ?? DEFAULT_VAD_THRESHOLD,
  agc: stream.agc === false ? false : stream.agc === true || stream.agc === undefined ? {} : stream.agc,
  prerollMs: stream.prerollMs ?? DEFAULT_PREROLL_MS
})

/**
 * Fails with the error `make` would give for missing model files (with the download command), without
 * loading anything: a cheap check before an engine reload.
 */
export const check = (options: SherpaSttOptions = {}, script: WorkerScript = {}): Effect.Effect<void, SttError> =>
  Effect.suspend(() => {
    const name = options.model ?? DEFAULT_PRESET
    // A new worker of this key would be refused anyway (see `acquire`): a previous one of it has not shut down.
    if (!slots.has(workerKey(options, script)) && orphans(workerKey(options, script)) > 0) return Effect.fail(new SttError({ message: orphanedMessage }))
    if (!presets[name]) {
      return Effect.fail(new SttError({ message: `Unknown speech model "${name}"; choose one of ${presetNames.join(", ")}` }))
    }
    const message = missingModelMessage(name, options.modelDir ?? defaultModelDir, options.modelDir !== undefined)
    return message === undefined ? Effect.void : Effect.fail(new SttError({ message }))
  })

/**
 * A recogniser: the shared worker of `options`' key (`acquire`; loaded by the first, reused by the others), with
 * `options`' per-stream settings. Two `make` calls that differ only in per-stream options share one loaded model.
 */
export const make = (options: SherpaSttOptions = {}): Effect.Effect<Stt["Service"], SttError, Scope.Scope> => makeWithWorker(options)

export const layer = (options: SherpaSttOptions = {}): Layer.Layer<Stt, SttError> => Layer.effect(Stt, make(options))

const optional = <A>(config: Config.Config<A>) => Config.option(config).pipe(Config.map(Option.getOrUndefined))

/** `STT_SHERPA_MODEL`: a preset name (or a legacy one, mapped). */
const ModelConfig = Config.Literals([...presetNames, ...Object.keys(legacyPresetNames)], "STT_SHERPA_MODEL").pipe(
  Config.withDefault(DEFAULT_PRESET),
  Config.map((name) => resolvePresetName(name) ?? DEFAULT_PRESET)
)

/** The settings `layerConfig` reads, as options. */
export const optionsConfig: Config.Config<SherpaSttOptions> = Config.all({
  model: ModelConfig,
  modelDir: optional(Config.String("STT_SHERPA_MODEL_DIR")),
  threads: optional(Config.Int("STT_SHERPA_THREADS")),
  language: optional(Config.String("STT_SHERPA_LANGUAGE")),
  eagerSilenceMs: Config.Int("STT_SHERPA_EAGER_SILENCE_MS").pipe(Config.withDefault(250)),
  finalSilenceMs: Config.Int("STT_SHERPA_FINAL_SILENCE_MS").pipe(Config.withDefault(600)),
  minSpeechMs: Config.Int("STT_SHERPA_MIN_SPEECH_MS").pipe(Config.withDefault(100)),
  vadThreshold: Config.Finite("STT_SHERPA_VAD_THRESHOLD").pipe(Config.withDefault(DEFAULT_VAD_THRESHOLD)),
  agcOn: Config.Boolean("STT_SHERPA_AGC").pipe(Config.withDefault(true)),
  agcMaxGainDb: Config.Finite("STT_SHERPA_AGC_MAX_GAIN_DB").pipe(Config.withDefault(30))
}).pipe(Config.map(({ agcMaxGainDb, agcOn, ...rest }) =>
  dropUndefined({ ...rest, agc: agcOn ? { maxGainDb: agcMaxGainDb } : false }) as SherpaSttOptions
))

/**
 * Reads `STT_SHERPA_MODEL` (preset, default `parakeet-v2`) and the optional
 * `STT_SHERPA_MODEL_DIR`, `STT_SHERPA_THREADS`, `STT_SHERPA_LANGUAGE`,
 * `STT_SHERPA_EAGER_SILENCE_MS` (250), `STT_SHERPA_FINAL_SILENCE_MS` (600),
 * `STT_SHERPA_MIN_SPEECH_MS` (100), `STT_SHERPA_VAD_THRESHOLD` (0.5),
 * `STT_SHERPA_AGC` (true), `STT_SHERPA_AGC_MAX_GAIN_DB` (30).
 */
export const layerConfig: Layer.Layer<Stt, SttError | Config.ConfigError> = Layer.effect(
  Stt,
  Effect.gen(function*() {
    return yield* make(yield* optionsConfig)
  })
)

/** `check` with the settings `layerConfig` reads. */
export const checkConfig: Effect.Effect<void, SttError | Config.ConfigError> = Effect.gen(function*() {
  return yield* check(yield* optionsConfig)
})

/** `exactOptionalPropertyTypes`: leave unset options out instead of passing `undefined`. */
const dropUndefined = <A extends object>(value: A) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof A]: Exclude<A[K], undefined>
  }
