import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Stream } from "effect"
import { type ClauseChunkerOptions, chunkClauses } from "./ClauseChunker.ts"
import type { Message, SttEvent, ToolCall, ToolResult } from "./Domain.ts"
import type { AudioError, LlmError, SttError, TtsError } from "./Errors.ts"
import { AudioInput, AudioOutput, Llm, Stt, Tts, type TtsAudio } from "./Services.ts"
import { ToolRegistry } from "./ToolRegistry.ts"
import { CurrentTurnTrace, type Trace, TurnTrace, type TurnOutcome } from "./TurnTrace.ts"

export interface ConversationOptions {
  readonly systemPrompt: string
  /** Maximum tool rounds per turn (LLM calls are capped at this + 1). Default 5. */
  readonly maxToolRounds?: number
  /** Interrupt the assistant when the user starts speaking over it. Default true. */
  readonly bargeIn?: boolean
  readonly chunker?: ClauseChunkerOptions
}

/**
 * The orchestrator. `voice` consumes `SttEvent`s and owns at most one turn
 * fiber; `textTurn` runs a single turn without any audio services. Both share
 * the history and the LLM/tool-loop code path.
 */
export class Conversation extends Context.Service<Conversation, {
  /**
   * Run the voice loop over `events` until the stream ends; then waits for the
   * last committed turn to finish playing.
   */
  voice<E>(events: Stream.Stream<SttEvent, E>): Effect.Effect<void, E, Tts | AudioOutput>
  /** One text turn: text in, assistant text deltas out (rounds separated by "\n"). */
  textTurn(text: string): Stream.Stream<string, LlmError>
  readonly history: Effect.Effect<ReadonlyArray<Message>>
}>()("@pva/core/Conversation") {
  static readonly layer = (options: ConversationOptions) =>
    Layer.effect(Conversation, makeConversation(options))
}

/** Microphone → Stt → Conversation → Tts → speaker, until the input ends. */
export const runVoice: Effect.Effect<
  void,
  AudioError | SttError,
  Conversation | AudioInput | Stt | Tts | AudioOutput
> = Effect.gen(function*() {
  const conversation = yield* Conversation
  const input = yield* AudioInput
  const stt = yield* Stt
  yield* conversation.voice(stt.transcribe(input.stream))
})

/** Normalised transcript comparison for promoting a speculative turn. */
const sameText = (a: string, b: string) => normalize(a) === normalize(b)
const normalize = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim()

interface Round {
  /** Full text the model produced in this round. */
  text: string
  readonly toolCalls: Array<ToolCall>
  /** Set once every tool call of the round has a result. */
  results?: ReadonlyArray<ToolResult>
}

/** What a turn produced so far; turned into history when the turn ends. */
interface TurnLog {
  readonly user: string
  readonly rounds: Array<Round>
  /** Voice only: clauses sent to TTS, in order, with the round they belong to. */
  readonly clauses: Array<{ readonly text: string; readonly round: number }>
  /** Voice only: number of clauses whose audio started playing. */
  played: number
}

interface ActiveTurn {
  readonly text: string
  /** Speculative and not promoted yet: must not play or write history. */
  pending: boolean
  /** First audio chunk handed to the speaker. */
  speaking: boolean
  done: boolean
  readonly promoted: Deferred.Deferred<void>
  readonly trace: Trace
  fiber?: Fiber.Fiber<void>
}

const roundMessages = (rounds: ReadonlyArray<Round>): Array<Message> =>
  rounds.flatMap((r): Array<Message> =>
    r.results === undefined ? [] : [
      { role: "assistant", content: r.text, toolCalls: r.toolCalls },
      { role: "tool", results: r.results }
    ]
  )

export const makeConversation = Effect.fnUntraced(function*(options: ConversationOptions) {
  const llm = yield* Llm
  const registry = yield* ToolRegistry
  const tt = yield* TurnTrace
  const maxToolRounds = options.maxToolRounds ?? 5
  const bargeIn = options.bargeIn ?? true
  const chunk = chunkClauses(options.chunker)

  const history: Array<Message> = []

  /** Stable system prompt plus this turn's context (kept separate so the prompt stays cacheable). */
  interface Prompt {
    readonly system: string
    readonly context?: string
  }
  const prompt: Effect.Effect<Prompt> = Effect.map(registry.context, (context) =>
    context.length === 0 ? { system: options.systemPrompt } : { system: options.systemPrompt, context })

  /**
   * The LLM + tool loop as one stream of text deltas. `gate` is awaited before
   * running any non-speculative tool (it completes when the turn is promoted).
   */
  const assistantText = (
    log: TurnLog,
    prompt: Prompt,
    base: ReadonlyArray<Message>,
    gate: Effect.Effect<void>,
    trace: Trace
  ): Stream.Stream<string, LlmError> => {
    const runTools = (round: Round) =>
      Effect.gen(function*() {
        if (round.toolCalls.some((call) => !registry.isSpeculative(call.name))) yield* gate
        round.results = yield* Effect.forEach(round.toolCalls, (call) => {
          const start = tt.now()
          return Effect.map(registry.run(call), (result) => {
            trace.tools.push({ name: call.name, ms: tt.now() - start })
            return result
          })
        }, { concurrency: "unbounded" })
      })

    const round = (n: number): Stream.Stream<string, LlmError> =>
      Stream.suspend(() => {
        const current: Round = { text: "", toolCalls: [] }
        const messages = [...base, ...roundMessages(log.rounds)]
        log.rounds.push(current)
        tt.mark(trace, "llmRequestSent")
        return llm.stream({ ...prompt, messages, tools: registry.specs }).pipe(
          Stream.map((event) => {
            switch (event._tag) {
              case "TextDelta":
                tt.mark(trace, "llmFirstToken")
                current.text += event.text
                return event.text
              case "ToolCall":
                current.toolCalls.push({ id: event.id, name: event.name, input: event.input })
                return undefined
              case "Done":
                return undefined
            }
          }),
          Stream.filter((text): text is string => text !== undefined && text.length > 0),
          Stream.concat(Stream.suspend(() => {
            if (current.toolCalls.length === 0) return Stream.empty
            if (n >= maxToolRounds) {
              return Stream.fromEffectDrain(Effect.logWarning(`Tool round limit (${maxToolRounds}) reached; ending turn`))
            }
            // "\n" makes the clause chunker flush what was said before the tools run.
            const flush = current.text.length > 0 ? Stream.succeed("\n") : Stream.empty
            return flush.pipe(Stream.concat(Stream.fromEffectDrain(runTools(current))), Stream.concat(round(n + 1)))
          }))
        )
      })

    return round(0)
  }

  /** Append a finished turn to history. Interrupted voice turns keep only what was played. */
  const commit = (log: TurnLog, mode: "voice" | "text", complete: boolean) => {
    const spoken = (index: number): string => {
      const round = log.rounds[index]!
      if (complete || mode === "text") return round.text
      return log.clauses.filter((c, i) => c.round === index && i < log.played).map((c) => c.text).join(" ")
    }
    history.push({ role: "user", content: log.user })
    log.rounds.forEach((round, index) => {
      const content = spoken(index)
      if (round.results !== undefined) {
        history.push({ role: "assistant", content, toolCalls: round.toolCalls }, { role: "tool", results: round.results })
      } else if (content.length > 0) {
        history.push(complete ? { role: "assistant", content } : { role: "assistant", content, interrupted: true })
      }
    })
  }

  const outcomeOf = (exit: Exit.Exit<unknown, unknown>, discarded: boolean): TurnOutcome =>
    Exit.isSuccess(exit)
      ? "completed"
      : Cause.hasInterruptsOnly(exit.cause)
      ? discarded ? "discarded" : "interrupted"
      : "failed"

  const finishTurn = (
    log: TurnLog,
    trace: Trace,
    mode: "voice" | "text",
    exit: Exit.Exit<unknown, unknown>,
    discarded: boolean
  ) =>
    Effect.suspend(() => {
      const outcome = outcomeOf(exit, discarded)
      if (outcome !== "discarded") commit(log, mode, outcome === "completed")
      const logFailure = Exit.isFailure(exit) && outcome === "failed"
        ? Effect.logError("Turn failed", exit.cause)
        : Effect.void
      return Effect.andThen(logFailure, tt.finish(trace, outcome))
    })

  const textTurn = (text: string): Stream.Stream<string, LlmError> =>
    Stream.unwrap(Effect.gen(function*() {
      const trace = tt.begin("text")
      tt.mark(trace, "endOfTurn")
      const turnPrompt = yield* prompt
      const log: TurnLog = { user: text, rounds: [], clauses: [], played: 0 }
      const base: Array<Message> = [...history, { role: "user", content: text }]
      return assistantText(log, turnPrompt, base, Effect.void, trace).pipe(
        Stream.onExit((exit) => finishTurn(log, trace, "text", exit, false))
      )
    }))

  const voice = <E>(events: Stream.Stream<SttEvent, E>): Effect.Effect<void, E, Tts | AudioOutput> =>
    Effect.scoped(Effect.gen(function*() {
      const scope = yield* Effect.scope
      const tts = yield* Tts
      const output = yield* AudioOutput
      let current: ActiveTurn | undefined

      const live = () => (current !== undefined && !current.done ? current : undefined)

      const turnBody = (turn: ActiveTurn, log: TurnLog) =>
        Effect.gen(function*() {
          const turnPrompt = yield* prompt
          const base: Array<Message> = [...history, { role: "user", content: turn.text }]
          const queue = yield* Queue.unbounded<TtsAudio, LlmError | TtsError | Cause.Done>()

          // One TTS stream for the whole turn (all rounds), fed clause by clause as the
          // chunker emits them. Audio is produced ahead of playback (and before
          // promotion for speculative turns); its clause index drives the bookkeeping.
          // The TTS input carries no errors: an LLM failure ends the clause stream and
          // is re-raised after the audio of the clauses already sent.
          let failure: Cause.Cause<LlmError> | undefined
          const clauses = assistantText(log, turnPrompt, base, Deferred.await(turn.promoted), turn.trace).pipe(
            chunk,
            Stream.map((text) => {
              log.clauses.push({ text, round: log.rounds.length - 1 })
              tt.mark(turn.trace, "firstClause")
              return text
            }),
            Stream.catchCause((cause) => {
              failure = cause
              return Stream.empty
            })
          )
          yield* tts.synthesize(clauses).pipe(
            Stream.provideService(CurrentTurnTrace, turn.trace),
            Stream.tap(() => Effect.sync(() => tt.mark(turn.trace, "ttsFirstAudio"))),
            Stream.concat(Stream.suspend(() => failure === undefined ? Stream.empty : Stream.failCause(failure))),
            Stream.runIntoQueue(queue),
            Effect.forkChild
          )

          yield* Deferred.await(turn.promoted)
          // One chunk per pull: `fromQueue` takes everything already queued in one pull,
          // so without `rechunk(1)` a TTS that ran ahead of playback would mark clauses
          // as played long before the speaker reached them.
          yield* output.play(
            Stream.fromQueue(queue).pipe(Stream.rechunk(1), Stream.map(({ audio, clause }) => {
              if (clause >= log.played) {
                log.played = clause + 1
                if (!turn.speaking) {
                  turn.speaking = true
                  tt.mark(turn.trace, "playbackStart")
                }
              }
              return audio
            })),
            tts.sampleRate
          )
        })

      const start = (text: string, speculative: boolean) =>
        Effect.gen(function*() {
          const trace = tt.begin("voice", speculative)
          const promoted = yield* Deferred.make<void>()
          if (!speculative) {
            tt.mark(trace, "endOfTurn")
            yield* Deferred.succeed(promoted, undefined)
          }
          const turn: ActiveTurn = { text, pending: speculative, speaking: false, done: false, promoted, trace }
          const log: TurnLog = { user: text, rounds: [], clauses: [], played: 0 }
          current = turn
          // Forked uninterruptible so the exit handler is installed even if the
          // turn is interrupted before it starts running; the body is interruptible.
          turn.fiber = yield* Effect.interruptible(turnBody(turn, log)).pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                turn.done = true
                if (current === turn) current = undefined
                return finishTurn(log, trace, "voice", exit, turn.pending)
              })
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope, { uninterruptible: true })
            )
        })

      const interrupt = (turn: ActiveTurn) => turn.fiber === undefined ? Effect.void : Fiber.interrupt(turn.fiber)

      const handle = (event: SttEvent): Effect.Effect<void> =>
        Effect.gen(function*() {
          const turn = live()
          switch (event._tag) {
            case "EagerEndOfTurn": {
              if (turn !== undefined) {
                if (!turn.pending && !bargeIn) return
                yield* interrupt(turn)
              }
              return yield* start(event.text, true)
            }
            case "TurnResumed": {
              if (turn?.pending) yield* interrupt(turn)
              return
            }
            case "EndOfTurn": {
              if (turn?.pending && sameText(turn.text, event.text)) {
                turn.pending = false
                tt.mark(turn.trace, "endOfTurn")
                return yield* Deferred.succeed(turn.promoted, undefined)
              }
              if (turn !== undefined) {
                if (!turn.pending && !bargeIn) return
                yield* interrupt(turn)
              }
              return yield* start(event.text, false)
            }
            case "SpeechStarted": {
              // A committed turn is interrupted whether or not its audio has started
              // (otherwise a stale reply could start playing over the user). A pending
              // speculative turn is left to TurnResumed / EndOfTurn.
              if (bargeIn && turn !== undefined && !turn.pending) yield* interrupt(turn)
              return
            }
            case "Interim":
              return
          }
        })

      yield* Stream.runForEach(events, handle)

      const last = live()
      if (last?.fiber !== undefined) {
        if (last.pending) yield* Fiber.interrupt(last.fiber)
        else yield* Fiber.await(last.fiber)
      }
    }))

  return Conversation.of({
    voice,
    textTurn,
    history: Effect.sync(() => history.slice())
  })
})
