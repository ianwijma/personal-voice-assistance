/**
 * Live benchmark: each 16 kHz mono WAV file is spoken as one user turn into
 * the real selected STT/LLM/TTS, in one conversation. After a file, silence
 * is fed until the reply has finished playing (so the turn detector fires and
 * the next turn never overlaps the reply). Replies are written as WAV files.
 */
import { frameBytes, layerOutput, loadInputPcm, pacedFrames } from "@pva/audio-file"
import { type AudioError, Conversation, type Llm, type LlmError, Stt, type SttEvent, type Trace, type Tts, TurnTrace } from "@pva/core"
import { Config, Deferred, Effect, Layer, Option, Queue, type Scope, Stream } from "effect"
import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { ConversationOptions } from "@pva/core"
import { type CliModules, startCliModules } from "../modules.ts"
import { describeConfigError, observedTurnTraceLayer, StartupError } from "../startup.ts"
import type { BenchRow } from "./report.ts"

/** Expand directories into their `.wav` files (sorted); keep files as given. */
export const collectWavs = (paths: ReadonlyArray<string>): Effect.Effect<Array<string>, StartupError> =>
  Effect.try({
    try: () =>
      paths.flatMap((p) =>
        statSync(p).isDirectory()
          ? readdirSync(p).filter((f) => f.toLowerCase().endsWith(".wav")).sort().map((f) => join(p, f))
          : [p]
      ),
    catch: (e) => new StartupError({ message: `bench --live: ${e instanceof Error ? e.message : String(e)}` })
  })

/**
 * `[--rounds N] [--sessions N] [--stagger MS] [--llm-per-session] [--stt-models A,B,...] [--load-model X] paths...`
 * after `bench --live`. `--stt-models`: session `i` hears with the `i`-th local model of the list (round robin), each
 * its own hearer as in serve mode's pool (equal models share one worker; WP-11). `--load-model`: one more local model
 * is loaded and kept idle for the run (two models loaded, one talking).
 */
export const parseLiveArgs = (
  args: ReadonlyArray<string>
): {
  rounds: number
  sessions: number
  staggerMs: number
  llmPerSession: boolean
  sttModels: Array<string>
  loadModel: string | undefined
  paths: Array<string>
} | string => {
  let rounds = 1
  let sessions = 1
  let staggerMs = 0
  let llmPerSession = false
  let sttModels: Array<string> = []
  let loadModel: string | undefined
  const paths: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--llm-per-session") llmPerSession = true
    else if (args[i] === "--stt-models") {
      sttModels = (args[++i] ?? "").split(",").map((m) => m.trim()).filter((m) => m.length > 0)
      if (sttModels.length === 0) return "--stt-models needs a comma-separated list of speech models"
    } else if (args[i] === "--load-model") {
      loadModel = args[++i]
      if (loadModel === undefined || loadModel === "") return "--load-model needs a speech model"
    }
    else if (args[i] === "--rounds") {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 1) return "--rounds needs a positive whole number"
      rounds = n
    } else if (args[i] === "--sessions") {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 1 || n > 8) return "--sessions needs a whole number from 1 to 8"
      sessions = n
    } else if (args[i] === "--stagger") {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 0 || n > 5000) return "--stagger needs milliseconds from 0 to 5000"
      staggerMs = n
    } else paths.push(args[i]!)
  }
  return { rounds, sessions, staggerMs, llmPerSession, sttModels, loadModel, paths }
}

export interface LiveOptions {
  readonly files: ReadonlyArray<string>
  readonly outputDir: string
  readonly conversation: ConversationOptions
  /** Give up waiting for a reply after this long. Default 30 s. */
  readonly maxTurnMs?: number
  /** Fill the silence between files with a -75 dBFS noise floor rather than digital zeros (see `pacedFrames`). Default true. */
  readonly noiseFloor?: boolean
  /** Silence before the first file, while the STT connection opens. Default 1500 ms. */
  readonly leadInMs?: number
  /** Running modules, read per turn. Default: started from the saved settings. */
  readonly modules?: CliModules
}

export interface LiveSessionsOptions extends LiveOptions {
  /** Sessions talking at once, each its own `Conversation` and `stt.transcribe` stream on the shared providers. */
  readonly sessions: number
  /**
   * Session `i`'s user audio ends `i × staggerMs` after session 1's. 0 (default): every session's audio ends at the
   * same moment (to the 20 ms frame), as when several people stop talking together.
   */
  readonly staggerMs?: number
  /**
   * Each session builds its own language-model instance from this layer (as serve mode's resource pool gives two
   * assistants with different settings two instances: two HTTP clients, two connections). Absent: the one `Llm` of
   * the environment is shared by every session.
   */
  readonly llmPerSession?: Layer.Layer<Llm, Config.ConfigError | LlmError>
  /** Session `i` hears with this recogniser (`--stt-models`). Absent: the one `Stt` of the environment. */
  readonly sttPerSession?: (session: number) => Stt["Service"]
}

/** One 20 ms frame (`pacedFrames`). */
const frameMs = 20
const framesOf = (pcm: Uint8Array) => Math.ceil(pcm.length / frameBytes)

/** Every session reaches turn `k` before any of them starts speaking it (released at one moment). */
const makeBarrier = (parties: number) => {
  const turns = new Map<number, { arrived: number; open: Deferred.Deferred<void> }>()
  return (k: number) =>
    Effect.suspend(() => {
      let entry = turns.get(k)
      if (entry === undefined) {
        entry = { arrived: 0, open: Deferred.makeUnsafe<void>() }
        turns.set(k, entry)
      }
      entry.arrived++
      return entry.arrived >= parties ? Deferred.succeed(entry.open, undefined) : Deferred.await(entry.open)
    })
}

/** One file of every session per turn: turn `k` of session `i` plays file `(k + i) mod n`. */
const fileOf = (k: number, session: number, n: number) => (k + session) % n

/**
 * One session of the live benchmark: its own `Conversation` (own trace, own output directory) on the shared
 * `Stt` / `Llm` / `Tts`. Turn `k` starts when every session has had turn `k - 1` answered (`barrier`); each file is
 * preceded by the silence that makes its end land at the planned moment (`leadFrames`).
 */
const runLiveSession = (
  options: LiveOptions,
  pcms: ReadonlyArray<Uint8Array>,
  session: number,
  leadFrames: (k: number) => number,
  barrier: (k: number) => Effect.Effect<void>,
  outputDir: string,
  modules: CliModules,
  label: string,
  ownStt?: Stt["Service"]
): Effect.Effect<Array<BenchRow>, AudioError | StartupError, Stt | Llm | Tts> =>
  Effect.gen(function*() {
    const finished = yield* Queue.unbounded<Trace>()
    const onFinish = (trace: Trace) => trace.outcome === "discarded" ? Effect.void : Queue.offer(finished, trace)
    const traceLayer = observedTurnTraceLayer(onFinish)
    const layer = Conversation.layerWithSetup({ ...options.conversation, setup: modules.setup(options.conversation.systemPrompt) }).pipe(
      Layer.provideMerge(Layer.mergeAll(traceLayer, layerOutput({ directory: outputDir })))
    )
    return yield* Effect.gen(function*() {
      const conversation = yield* Conversation
      const stt = ownStt ?? (yield* Stt)
      const tt = yield* TurnTrace
      const rows: Array<BenchRow> = []
      const noiseFloor = options.noiseFloor ?? true
      const silence = (ms: number) => pacedFrames(new Uint8Array(0), { trailingSilenceMs: ms, noiseFloor })

      // What the STT reported during the current file (events are attributed to the file being played).
      let heard = { eagerAt: undefined as number | undefined, resumed: 0, text: "" }
      const observe = (event: SttEvent) =>
        Effect.sync(() => {
          if (event._tag === "EagerEndOfTurn") heard.eagerAt = tt.now()
          else if (event._tag === "TurnResumed") heard.resumed++
          else if (event._tag === "EndOfTurn" && event.text !== "") heard.text = event.text // empty: an utterance with no words
        })

      const turn = (k: number): Stream.Stream<Uint8Array> => {
        const index = fileOf(k, session, pcms.length)
        let audioEnd = 0
        const waitForReply = Effect.gen(function*() {
          const trace = yield* Queue.take(finished).pipe(Effect.timeoutOption(options.maxTurnMs ?? 30_000))
          const name = `${label}${basename(options.files[index]!)}`
          const note = `${name}: heard "${heard.text}"${heard.resumed > 0 ? ` (TurnResumed x${heard.resumed})` : ""}`
          if (Option.isNone(trace)) return rows.push({ label: name, note })
          const at = (t: number | undefined) => (t === undefined ? undefined : t - audioEnd)
          const marks = trace.value.marks
          rows.push({
            label: name,
            trace: trace.value,
            note,
            extra: {
              eager: at(heard.eagerAt),
              eot: at(marks.endOfTurn),
              "1st token": at(marks.llmFirstToken),
              "1st clause": at(marks.firstClause),
              "tts audio": at(marks.ttsFirstAudio),
              PLAY: at(marks.playbackStart)
            }
          })
        })
        const next = k + 1 < pcms.length ? barrier(k + 1) : Effect.void
        return Stream.fromEffectDrain(Effect.sync(() => {
          heard = { eagerAt: undefined, resumed: 0, text: "" }
        })).pipe(
          Stream.concat(pacedFrames(pcms[index]!, { leadingSilenceMs: leadFrames(k) * frameMs, noiseFloor })),
          Stream.concat(Stream.fromEffectDrain(Effect.sync(() => {
            audioEnd = tt.now()
          }))),
          // Silence until this reply is over and every other session is ready for the next turn.
          Stream.concat(pacedFrames(new Uint8Array(0), { atEnd: "silence", noiseFloor }).pipe(
            Stream.interruptWhen(Effect.andThen(waitForReply, next))
          ))
        )
      }

      const audio = silence(options.leadInMs ?? 1500).pipe(
        Stream.concat(Stream.fromEffectDrain(barrier(0))),
        Stream.concat(Stream.fromIterable(pcms.map((_, k) => k)).pipe(Stream.flatMap(turn, { concurrency: 1 })))
      )
      yield* conversation.voice(stt.transcribe(audio).pipe(Stream.tap(observe))).pipe(
        Effect.catch((e) => new StartupError({ message: `Speech-to-text failed: ${e.message}` }))
      )
      return rows
    }).pipe(Effect.provide(layer))
  })

/**
 * `bench --live --sessions N`: N sessions at once through the real providers, as serve mode runs several devices:
 * the one speech-to-text model (`transcribe` once per session), the language model and the voices are shared. Every
 * turn's user audio ends at the same moment in all sessions (plus `i × staggerMs` for session `i`); session `i` plays
 * the files rotated by `i`, so the sessions say different things. Rows per session.
 */
export const runLiveSessions = (
  options: LiveSessionsOptions
): Effect.Effect<Array<Array<BenchRow>>, AudioError | LlmError | StartupError, Stt | Llm | Tts | Scope.Scope> =>
  Effect.gen(function*() {
    const pcms = yield* Effect.forEach(options.files, loadInputPcm)
    if (pcms.length === 0) return yield* new StartupError({ message: "bench --live: no .wav files given" })
    const modules = options.modules ?? (yield* startCliModules())
    const n = options.sessions
    const staggerFrames = Math.round((options.staggerMs ?? 0) / frameMs)
    const longest = (k: number) => Math.max(...Array.from({ length: n }, (_, i) => framesOf(pcms[fileOf(k, i, pcms.length)]!)))
    const barrier = makeBarrier(n)
    return yield* Effect.forEach(
      Array.from({ length: n }, (_, i) => i),
      (i) =>
        runLiveSession(
          options,
          pcms,
          i,
          (k) => longest(k) - framesOf(pcms[fileOf(k, i, pcms.length)]!) + i * staggerFrames,
          barrier,
          n === 1 ? options.outputDir : join(options.outputDir, `s${i + 1}`),
          modules,
          n === 1 ? "" : `s${i + 1} `,
          options.sttPerSession?.(i)
        ).pipe((session) =>
          options.llmPerSession === undefined ? session : Effect.provide(session, options.llmPerSession).pipe(
            Effect.mapError((e) => (e instanceof Config.ConfigError ? new StartupError({ message: `language model: ${describeConfigError(e)}` }) : e))
          )
        ),
      { concurrency: "unbounded" }
    )
  })

/** One session (`runLiveSessions` with `sessions: 1`). */
export const runLive = (options: LiveOptions): Effect.Effect<Array<BenchRow>, AudioError | LlmError | StartupError, Stt | Llm | Tts | Scope.Scope> =>
  Effect.map(runLiveSessions({ ...options, sessions: 1 }), (all) => all[0]!)
