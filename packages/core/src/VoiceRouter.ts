import { Cause, Deferred, Effect, Queue, Stream } from "effect"
import type { TtsError } from "./Errors.ts"
import { makeResampler } from "./Resample.ts"
import { Tts, type TtsAudio } from "./Services.ts"
import { CurrentTurnTrace } from "./TurnTrace.ts"
import { parseVoiceMarker, voiceMarker } from "./VoiceMarkers.ts"

/** A named voice: what it is good for (the model reads this) and the engine that speaks it. */
export interface Voice {
  readonly name: string
  readonly description: string
  readonly tts: Tts["Service"]
}

export type VoiceInfo = Pick<Voice, "name" | "description">

/** Timing of one segment (a run of consecutive clauses spoken by one voice), measured at the engine. */
export interface VoiceSegmentStats {
  readonly voice: string
  readonly clauses: number
  /** When the engine started on the segment (after any earlier segment of the same voice had finished). */
  readonly startedAt: number
  /** First audio chunk from the engine (undefined if it produced none). */
  readonly firstAudioAt: number | undefined
  /** The engine finished the segment. */
  readonly endedAt: number
  /** Audio produced, in seconds. */
  readonly audioSeconds: number
}

export interface VoiceRouterOptions {
  readonly voices: ReadonlyArray<Voice>
  /** Name of the voice used when a reply has no marker (and for unknown names). Its rate is the router's rate. */
  readonly defaultVoice: string
  /**
   * Output rate. Default: the default voice's rate. Set it to keep the rate
   * fixed when the router is rebuilt with another default voice (the web output
   * cannot change rate mid-session).
   */
  readonly sampleRate?: number
  /** Called when a segment's synthesis has finished (for `say`-style measurements). */
  readonly onSegment?: (stats: VoiceSegmentStats) => void
  /** Clock for `onSegment`. Default `performance.now`. */
  readonly now?: () => number
}

/**
 * The system-prompt block that tells the model which voices exist and how to
 * pick one. Deterministic, so the cached system prompt stays identical across
 * turns. Empty when there is only one voice (nothing to choose).
 */
export const voicePrompt = (voices: ReadonlyArray<VoiceInfo>, defaultVoice: string): string => {
  const others = voices.filter((v) => v.name !== defaultVoice)
  if (others.length === 0) return ""
  return [
    `Voices: your replies are spoken by the ${defaultVoice} voice unless you choose another.`,
    `To choose a voice, begin the reply with its marker, for example ${voiceMarker(others[0]!.name)}. ` +
    "To switch part-way, put a marker at the start of a sentence; it applies until the next marker or the end of the reply. " +
    "Markers are never spoken. Each reply starts in the default voice again.",
    "Available voices:",
    ...voices.map((v) => `- ${voiceMarker(v.name)}${v.name === defaultVoice ? " (default)" : ""}: ${v.description}`),
    `Use the ${defaultVoice} voice unless another voice clearly suits the reply better.`
  ].join("\n")
}

interface Segment {
  readonly voice: Voice
  readonly input: Queue.Queue<string, Cause.Done>
  /** Router clause index of each clause sent to this segment's engine. */
  readonly indexes: Array<number>
}

/**
 * A `Tts` over several named voices. The voice is chosen per reply by a
 * `[voice:NAME]` marker at the start of a clause (no marker: the default voice;
 * unknown name: the default voice and a warning). Markers never reach an engine.
 *
 * Each run of consecutive clauses with the same voice is one continuous
 * `synthesize` call on that voice's engine, fed clause by clause as clauses
 * arrive. A segment's engine starts as soon as its first clause arrives, even
 * while earlier segments are still being delivered; its audio is buffered and
 * emitted only after every earlier segment has ended, so order is preserved
 * and clause indexes (indexes into this router's input) never decrease. Two
 * segments of the same voice never synthesise at the same time (engines need
 * not support concurrent calls). Audio is resampled to the default voice's
 * rate. Interrupting the consumer interrupts every running engine.
 */
export const makeVoiceRouter = (options: VoiceRouterOptions): Tts["Service"] & { readonly prompt: string } => {
  const byName = new Map(options.voices.map((v) => [v.name.toLowerCase(), v]))
  const fallback = byName.get(options.defaultVoice.toLowerCase())
  if (fallback === undefined) throw new Error(`default voice "${options.defaultVoice}" is not among the voices`)
  const sampleRate = options.sampleRate ?? fallback.tts.sampleRate
  const now = options.now ?? (() => performance.now())
  const onSegment = options.onSegment

  const synthesize = (clauses: Stream.Stream<string>): Stream.Stream<TtsAudio, TtsError> =>
    Stream.unwrap(Effect.gen(function*() {
      const trace = yield* CurrentTurnTrace
      const outputs = yield* Queue.unbounded<Queue.Dequeue<TtsAudio, TtsError | Cause.Done>, Cause.Done>()
      /** Per voice: completes when that voice's latest segment has finished synthesising. */
      const idle = new Map<Voice, Effect.Effect<void>>()
      let segment: Segment | undefined
      let voice = fallback
      let index = -1

      const open = (voice: Voice) =>
        Effect.gen(function*() {
          const input = yield* Queue.unbounded<string, Cause.Done>()
          const output = yield* Queue.unbounded<TtsAudio, TtsError | Cause.Done>()
          const finished = yield* Deferred.make<void>()
          const previous = idle.get(voice) ?? Effect.void
          idle.set(voice, Deferred.await(finished))
          if (trace !== undefined && !trace.voices.includes(voice.name)) trace.voices.push(voice.name)
          const seg: Segment = { voice, input, indexes: [] }
          const resample = makeResampler(voice.tts.sampleRate, sampleRate)
          let startedAt = 0
          let firstAudioAt: number | undefined
          let samples = 0
          const audio = voice.tts.synthesize(Stream.fromQueue(input)).pipe(
            Stream.map(({ audio, clause }): TtsAudio => {
              if (onSegment !== undefined) {
                firstAudioAt ??= now()
                samples += audio.length / 2
              }
              return { audio: resample(audio), clause: seg.indexes[clause] ?? seg.indexes.at(-1)! }
            }),
            Stream.filter((chunk) => chunk.audio.length > 0)
          )
          // Stats are reported before the output queue ends, so a consumer that
          // stops right after the last chunk still sees them.
          const report = Effect.sync(() =>
            onSegment?.({
              voice: voice.name,
              clauses: seg.indexes.length,
              startedAt,
              firstAudioAt,
              endedAt: now(),
              audioSeconds: samples / voice.tts.sampleRate
            })
          )
          yield* previous.pipe(
            Effect.andThen(Effect.sync(() => {
              startedAt = now()
            })),
            Effect.andThen(Stream.runIntoQueue(Stream.concat(audio, Stream.fromEffectDrain(report)), output)),
            Effect.ensuring(Deferred.succeed(finished, undefined)),
            Effect.forkScoped
          )
          yield* Queue.offer(outputs, output)
          return seg
        })

      const close = Effect.suspend(() => {
        const ending = segment
        segment = undefined
        return ending === undefined ? Effect.void : Effect.asVoid(Queue.end(ending.input))
      })

      const route = (clause: string) =>
        Effect.gen(function*() {
          index++
          const parsed = parseVoiceMarker(clause)
          if (parsed.voice !== undefined) {
            let chosen = byName.get(parsed.voice)
            if (chosen === undefined) {
              yield* Effect.logWarning(`Unknown voice "${parsed.voice}"; using "${fallback.name}"`)
              chosen = fallback
            }
            if (chosen !== voice) {
              yield* close
              voice = chosen
            }
          }
          if (parsed.text.length === 0) return
          segment ??= yield* open(voice)
          segment.indexes.push(index)
          yield* Queue.offer(segment.input, parsed.text)
        })

      yield* Stream.runForEach(clauses, route).pipe(
        Effect.andThen(close),
        Effect.andThen(Queue.end(outputs)),
        Effect.forkScoped
      )
      // Segments in order; each one's audio was buffered while earlier ones played.
      return Stream.fromQueue(outputs).pipe(Stream.flatMap(Stream.fromQueue))
    }))

  return {
    ...Tts.of({ sampleRate, synthesize }),
    prompt: voicePrompt(options.voices, fallback.name)
  }
}
