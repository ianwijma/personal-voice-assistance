import {
  type AgentTurnSetup,
  type AudioInput,
  AudioOutput,
  type Conversation,
  type ConversationEvent,
  type ConversationInput,
  Llm,
  makeAgentConversation,
  makeConversationWithSetup,
  type Message,
  type SttEvent,
  Tts,
  type TurnSetup,
  TurnTrace,
  type VoiceRef,
  voiceKey,
  withTraceVoice
} from "@pva/core"
import type { ConversationInfo } from "@pva/protocol"
import { Effect, Queue, Stream } from "effect"
import type { BuiltEngines, Engine, EngineProviders } from "./Engine.ts"

/**
 * One voice session's conversation on the shared engines (docs/VOICE-SESSIONS.md §2): the `Conversation` and its
 * voice loop, rebuilt on every engine build with this session's history, conversation id and idle clock carried
 * over; and the typed-input admission (`maxPendingInputs`, Stop generations). Every reply is spoken with the build's
 * voice, the assistant's (docs/VOICE-PROVIDERS.md).
 */

export type SendOutcome = "accepted" | "busy" | "not_running"

export interface SessionConversationOptions {
  readonly engine: Engine
  /** The microphone this conversation transcribes itself (with `gate`). Not used when `speech` is given. */
  readonly input?: AudioInput["Service"]
  readonly output: AudioOutput["Service"]
  /** This session's trace service (its own turn ids, `Trace.session` set). */
  readonly turnTrace: TurnTrace["Service"]
  /** The turn setup (system prompt and tools), read at the start of each turn. */
  readonly setup: Effect.Effect<TurnSetup>
  /**
   * An agent conversation for these providers (`LLM_PROVIDER=claude-subscription`), read at the start of each turn;
   * `undefined`: the single-model conversation over `providers.llm` with `setup`.
   */
  readonly agentSetup?: (providers: EngineProviders) => Effect.Effect<AgentTurnSetup> | undefined
  readonly onEvent: (event: ConversationEvent) => void
  /** A new conversation started (`newConversation`, or the conversation's idle reset). */
  readonly onConversation?: (conversation: ConversationInfo, reason: "new" | "idle") => void
  /** The recognition stream on its way to the conversation (echo gate, wake gate, transcript, state). Not used with `speech`. */
  readonly gate?: (events: Stream.Stream<SttEvent, unknown>) => Stream.Stream<SttEvent, unknown>
  /**
   * The session dispatcher's seam (docs/ASSISTANTS.md §3.3, `SessionDispatcher.ts`): when given, the voice loop reads
   * its speech events (and the dispatcher's own interrupts) from this stream, made at each run start, instead of
   * transcribing `input` through `gate` itself. Typed input still goes through `send`. Neither `speech` nor
   * `input` with `gate`: the loop gets typed input only.
   */
  readonly speech?: (built: BuiltEngines) => Stream.Stream<ConversationInput, unknown>
  /** The idle reset (`Conversation.idleResetMs`), read at every turn start. */
  readonly idleResetMs?: () => number | undefined
  /** Tool rounds per turn (the assistant's `toolRounds`), read at every run start. Default: the build's `maxToolRounds`. */
  readonly maxToolRounds?: () => number
  /** Typed inputs accepted but not yet taken by the conversation, at most. Default 4. */
  readonly maxPendingInputs?: number
  /** The conversation to start with (a session's id reserved before it existed). Default: a new one. */
  readonly initialConversation?: ConversationInfo
}

export interface SessionConversation {
  /**
   * Typed text or Stop. `not_running` when the engines are not running; `busy` when `maxPendingInputs` typed
   * inputs are already waiting for the conversation. Stop (`Interrupt`) is always accepted: it drops the typed
   * inputs still waiting, and repeated presses before the conversation takes the first one count as one.
   */
  readonly send: (input: ConversationInput) => SendOutcome
  /** Whether the voice loop runs (the engines are up and this session's loop has started on them, or is starting). */
  readonly running: () => boolean
  readonly history: Effect.Effect<ReadonlyArray<Message>>
  /** The conversation `history` belongs to (its id is carried across reloads). */
  readonly conversation: () => ConversationInfo
  /** When the last turn of this conversation was committed (epoch ms of the conversation's clock). */
  readonly lastTurnAt: () => number | undefined
  /**
   * Start a new conversation (`conversation.new`): the running turn is stopped as by Stop, the history dropped, the
   * id new (`onConversation` is called). Works without running engines.
   */
  readonly newConversation: Effect.Effect<ConversationInfo>
  /** The voice this session speaks with, while the loop runs. */
  readonly voice: () => VoiceRef | undefined
  /** Start running on the engines (now and after every rebuild) until `end`. */
  readonly start: () => void
  /**
   * Stop for good (the session is discarded): detach from the engines, wait for the loop to end, and tell the agents
   * that this conversation ended (a Claude subscription session closes).
   */
  readonly end: Effect.Effect<void>
}

/** A control input with the Stop generation it was accepted in (`undefined`: a speech event). */
interface Control {
  readonly input: ConversationInput
  readonly generation: number | undefined
}

export const makeSessionConversation = (options: SessionConversationOptions): Effect.Effect<SessionConversation> =>
  Effect.gen(function*() {
    /**
     * Inputs for the conversation besides speech. Not bounded by the queue itself (the merge with the speech
     * events below reads ahead of the conversation) but by admission: at most `maxPendingInputs` typed inputs
     * and one Stop are accepted and not yet taken by the conversation, counted until it takes them. Stop
     * raises `stopGeneration`, so typed inputs accepted before it are dropped instead of starting stale turns.
     */
    const control = yield* Queue.unbounded<Control>()
    const maxPendingInputs = options.maxPendingInputs ?? 4
    let pendingInputs = 0
    let stopPending = false
    let stopGeneration = 0
    /** Carried across builds: the history, the conversation, its idle clock. */
    let history: ReadonlyArray<Message> = []
    let conversationInfo: ConversationInfo = options.initialConversation ?? { id: globalThis.crypto.randomUUID(), startedAt: Date.now() }
    let lastTurnAt: number | undefined
    /** The running conversation (while the loop runs on a build). */
    let live: Conversation["Service"] | undefined
    let ready = false
    let detach: Effect.Effect<void> | undefined
    let voice: VoiceRef | undefined

    const onEvent = (event: ConversationEvent) => {
      if (event._tag === "ConversationStarted") {
        conversationInfo = { id: event.conversationId, startedAt: Date.now() }
        options.onConversation?.(conversationInfo, event.reason)
      }
      options.onEvent(event)
    }

    const run = (built: BuiltEngines): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        const providers = built.providers
        voice = providers.voice
        const tts = withTraceVoice(providers.tts, voiceKey(providers.voice))
        const common = {
          onEvent,
          initialHistory: history,
          initialConversationId: conversationInfo.id,
          ...(lastTurnAt !== undefined ? { initialLastTurnAt: lastTurnAt } : {}),
          ...(options.idleResetMs !== undefined ? { idleResetMs: options.idleResetMs } : {}),
          maxToolRounds: options.maxToolRounds?.() ?? providers.maxToolRounds,
          bargeIn: true
        }
        const agentSetup = options.agentSetup?.(providers)
        const conversation = yield* (agentSetup !== undefined
          ? makeAgentConversation({ ...common, setup: agentSetup })
          : makeConversationWithSetup({ ...common, setup: options.setup }).pipe(Effect.provideService(Llm, providers.llm))
        ).pipe(Effect.provideService(TurnTrace, options.turnTrace))
        live = conversation
        ready = true

        const speech: Stream.Stream<ConversationInput, unknown> = options.speech !== undefined
          ? options.speech(built)
          : options.input !== undefined && options.gate !== undefined
          ? options.gate(providers.stt.transcribe(options.input.stream))
          : Stream.never
        const events = Stream.merge(
          speech.pipe(Stream.map((input): Control => ({ input, generation: undefined }))),
          Stream.fromQueue(control)
        ).pipe(
          // One at a time, so each input is counted out (and checked against Stop) just before the conversation takes it.
          Stream.rechunk(1),
          Stream.filter((c) => {
            if (c.generation === undefined) return true
            if (c.input._tag === "Interrupt") {
              stopPending = false
              return true
            }
            pendingInputs--
            return c.generation === stopGeneration
          }),
          Stream.map((c) => c.input)
        )
        yield* conversation.voice(events).pipe(
          Effect.provideService(Tts, tts),
          Effect.provideService(AudioOutput, options.output)
        )
      }).pipe(
        // However the loop ends (reload, failure, discard): keep what the next build starts from.
        // Inputs accepted for this run and not taken are dropped (as the engines stopping drops a turn).
        Effect.ensuring(Effect.suspend(() => {
          ready = false
          voice = undefined
          const c = live
          live = undefined
          return Effect.gen(function*() {
            yield* Queue.clear(control)
            pendingInputs = 0
            stopPending = false
            if (c === undefined) return
            history = yield* c.history
            lastTurnAt = yield* c.lastTurnAt
          })
        }))
      )

    /** Tell the agents of the running build that this conversation ended. Never fails. */
    const endAgents = (conversationId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const built = options.engine.built()
        const setup = built === undefined ? undefined : options.agentSetup?.(built.providers)
        if (setup === undefined) return Effect.void
        return setup.pipe(
          Effect.flatMap((s) => {
            const ends = [...s.agents.agents.values()].flatMap((a) => (a.endConversation !== undefined ? [a.endConversation] : []))
            return Effect.forEach(ends, (end) => Effect.catchCause(Effect.suspend(() => end(conversationId)), () => Effect.void), { discard: true })
          }),
          Effect.catchCause(() => Effect.void)
        )
      })

    const loop = { run }

    return {
      send: (input) => {
        // Also while the loop is starting on running engines (the first input of a new session): it is queued.
        if (!ready && !(detach !== undefined && options.engine.ready())) return "not_running"
        if (input._tag === "Interrupt") {
          stopGeneration++
          if (!stopPending) {
            stopPending = true
            Queue.offerUnsafe(control, { input, generation: stopGeneration })
          }
          return "accepted"
        }
        if (pendingInputs >= maxPendingInputs) return "busy"
        pendingInputs++
        Queue.offerUnsafe(control, { input, generation: stopGeneration })
        return "accepted"
      },
      running: () => ready || (detach !== undefined && options.engine.ready()),
      history: Effect.suspend(() => live?.history ?? Effect.succeed(history)),
      conversation: () => conversationInfo,
      lastTurnAt: () => (live === undefined ? lastTurnAt : Effect.runSync(live.lastTurnAt)),
      newConversation: Effect.suspend(() => {
        if (live !== undefined) return Effect.map(live.newConversation("new"), () => conversationInfo)
        return Effect.sync(() => {
          history = []
          lastTurnAt = undefined
          conversationInfo = { id: globalThis.crypto.randomUUID(), startedAt: Date.now() }
          options.onConversation?.(conversationInfo, "new")
          return conversationInfo
        })
      }),
      voice: () => voice,
      start: () => {
        detach ??= options.engine.attach(loop)
      },
      end: Effect.suspend(() => {
        const d = detach
        detach = undefined
        const id = conversationInfo.id
        return Effect.andThen(d ?? Effect.void, endAgents(id))
      })
    } satisfies SessionConversation
  })
