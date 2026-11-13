/**
 * Live benchmark: each 16 kHz mono WAV file is spoken as one user turn into
 * the real selected STT/LLM/TTS, in one conversation. After a file, silence
 * is fed until the reply has finished playing (so the turn detector fires and
 * the next turn never overlaps the reply). Replies are written as WAV files.
 */
import { layerOutput, loadInputPcm, pacedFrames } from "@pva/audio-file"
import { type AudioError, Conversation, type Llm, Stt, type SttEvent, ToolRegistry, type Trace, type Tts, TurnTrace } from "@pva/core"
import { Effect, Layer, Option, Queue, Stream } from "effect"
import { readdirSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import type { ConversationOptions } from "@pva/core"
import { modules } from "../modules.ts"
import { observedTurnTraceLayer, StartupError } from "../startup.ts"
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

/** `[--rounds N] paths...` after `bench --live`. */
export const parseLiveArgs = (args: ReadonlyArray<string>): { rounds: number; paths: Array<string> } | string => {
  let rounds = 1
  const paths: Array<string> = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rounds") {
      const n = Number(args[++i])
      if (!Number.isInteger(n) || n < 1) return "--rounds needs a positive whole number"
      rounds = n
    } else paths.push(args[i]!)
  }
  return { rounds, paths }
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
}

export const runLive = (options: LiveOptions): Effect.Effect<Array<BenchRow>, AudioError | StartupError, Stt | Llm | Tts> =>
  Effect.gen(function*() {
    const pcms = yield* Effect.forEach(options.files, loadInputPcm)
    if (pcms.length === 0) return yield* new StartupError({ message: "bench --live: no .wav files given" })
    const finished = yield* Queue.unbounded<Trace>()
    const onFinish = (trace: Trace) => trace.outcome === "discarded" ? Effect.void : Queue.offer(finished, trace)
    const traceLayer = observedTurnTraceLayer(onFinish)
    const layer = Conversation.layer(options.conversation).pipe(
      Layer.provideMerge(Layer.mergeAll(ToolRegistry.layer(modules), traceLayer, layerOutput({ directory: options.outputDir })))
    )
    return yield* Effect.gen(function*() {
      const conversation = yield* Conversation
      const stt = yield* Stt
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
          else if (event._tag === "EndOfTurn") heard.text = event.text
        })

      const turn = (pcm: Uint8Array, index: number): Stream.Stream<Uint8Array> => {
        let audioEnd = 0
        const waitForReply = Effect.gen(function*() {
          const trace = yield* Queue.take(finished).pipe(Effect.timeoutOption(options.maxTurnMs ?? 30_000))
          const label = basename(options.files[index]!)
          const note = `${label}: heard "${heard.text}"${heard.resumed > 0 ? ` (TurnResumed x${heard.resumed})` : ""}`
          if (Option.isNone(trace)) return rows.push({ label, note })
          const at = (t: number | undefined) => (t === undefined ? undefined : t - audioEnd)
          const marks = trace.value.marks
          rows.push({
            label,
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
        return Stream.fromEffectDrain(Effect.sync(() => {
          heard = { eagerAt: undefined, resumed: 0, text: "" }
        })).pipe(
          Stream.concat(pacedFrames(pcm)),
          Stream.concat(Stream.fromEffectDrain(Effect.sync(() => {
            audioEnd = tt.now()
          }))),
          Stream.concat(pacedFrames(new Uint8Array(0), { atEnd: "silence", noiseFloor }).pipe(Stream.interruptWhen(waitForReply)))
        )
      }

      const audio = silence(options.leadInMs ?? 1500).pipe(
        Stream.concat(Stream.fromIterable(pcms.map((pcm, i) => [pcm, i] as const)).pipe(
          Stream.flatMap(([pcm, i]) => turn(pcm, i), { concurrency: 1 })
        ))
      )
      yield* conversation.voice(stt.transcribe(audio).pipe(Stream.tap(observe))).pipe(
        Effect.catch((e) => new StartupError({ message: `Speech-to-text failed: ${e.message}` }))
      )
      return rows
    }).pipe(Effect.provide(layer))
  })
