import {
  type Agent,
  type AgentTurnSetup,
  type AudioInput,
  AudioOutput,
  type Conversation,
  type ConversationEvent,
  type ConversationInput,
  Llm,
  LlmError,
  makeAgentConversation,
  makeConversationWithSetup,
  type Message,
  type SttEvent,
  Tts,
  TtsError,
  type TurnSetup,
  TurnTrace,
  type VoiceRef,
  voiceKey,
  withTraceVoice
} from "@pva/core"
import type { ConversationInfo } from "@pva/protocol"
import { Deferred, Effect, Fiber, Queue, Stream } from "effect"
import type { BuiltEngines, Engine } from "./Engine.ts"

/**
 * One voice session's conversation on the shared engines (docs/VOICE-SESSIONS.md §2): the `Conversation` and its
 * voice loop, rebuilt on every engine build with this session's history, conversation id and idle clock carried
 * over; and the typed-input admission (`maxPendingInputs`, Stop generations). Every reply is spoken with the voice of
 * the turn's setup (`TurnSetup.tts`: the assistant's own, from the resource pool, docs/ASSISTANTS.md §3.2).
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
   * An agent conversation (a `claude-subscription` assistant), chosen at each run start, its setup read at the start
   * of each turn; `undefined`: the single-model conversation with `setup`, whose `TurnSetup.llm` (the resource
   * pool's instance) answers the turn (default: `providers.llm`, tests). Read again at `bindingChanged`: when the
   * kind differs from the running conversation's, the run restarts with the other kind.
   */
  readonly agentSetup?: () => Effect.Effect<AgentTurnSetup> | undefined
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
   * The assistant's language model binding may have changed (the resource pool published one). When `agentSetup`
   * now gives the other kind of conversation (agents or the single model), this conversation's loop restarts as on
   * an engine rebuild: the turn in flight and the inputs not yet taken are dropped, the history, conversation id and
   * idle clock are kept, and the agents the ended run used are told that the conversation ended for them.
   */
  readonly bindingChanged: () => void
  /**
   * Stop for good (the session is discarded): detach from the engines, wait for the loop to end, and tell the agents
   * that this conversation ended (a Claude subscription session closes).
   */
  readonly end: Effect.Effect<void>
}

/** The conversation's own `Llm` when neither the turn's setup nor the build names one: every turn fails. */
const noLlm = Llm.of({ stream: () => Stream.fail(new LlmError({ message: "No language model is set up for this assistant." })) })

/** The voice loop's own `Tts` when the turn's setup names none: nothing can be spoken. */
const noTts = Tts.of({
  sampleRate: 22_050,
  synthesize: () => Stream.fail(new TtsError({ message: "No voice is set up for this assistant." }))
})

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
    /**
     * The agents the runs of this conversation used (recorded from each turn's setup). Their sessions of it end when a
     * run without agents starts (the kind changed), when it is reset without a running loop, and at `end`.
     */
    const usedAgents = new Set<Agent>()
    /** The running conversation's kind, and the signal that restarts the run with the other kind (`bindingChanged`). */
    let restart: { readonly agents: boolean; readonly signal: Deferred.Deferred<void> } | undefined

    const onEvent = (event: ConversationEvent) => {
      if (event._tag === "ConversationStarted") {
        conversationInfo = { id: event.conversationId, startedAt: Date.now() }
        options.onConversation?.(conversationInfo, event.reason)
      }
      options.onEvent(event)
    }

    /** Tell the agents the runs used that conversation `conversationId` ended (and forget them). Never fails. */
    const endUsedAgents = (conversationId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const agents = [...usedAgents]
        usedAgents.clear()
        return Effect.forEach(
          agents,
          (agent) => Effect.catchCause(Effect.suspend(() => agent.endConversation?.(conversationId) ?? Effect.void), () => Effect.void),
          { discard: true }
        )
      })

    /** One conversation of the kind `agentSetup` gives, on `built`, until its inputs end or it is interrupted. */
    const runConversation = (built: BuiltEngines, agentSetup: Effect.Effect<AgentTurnSetup> | undefined): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        const providers = built.providers
        voice = providers.voice
        // Every turn names its own voice (`TurnSetup.tts`, the pool's instance for the assistant's voice); this one
        // is for a conversation whose setup names none (tests that inject one voice).
        const tts = providers.tts !== undefined && providers.voice !== undefined ? withTraceVoice(providers.tts, voiceKey(providers.voice)) : noTts
        const common = {
          onEvent,
          initialHistory: history,
          initialConversationId: conversationInfo.id,
          ...(lastTurnAt !== undefined ? { initialLastTurnAt: lastTurnAt } : {}),
          ...(options.idleResetMs !== undefined ? { idleResetMs: options.idleResetMs } : {}),
          maxToolRounds: options.maxToolRounds?.() ?? providers.maxToolRounds,
          bargeIn: true
        }
        const conversation = yield* (agentSetup !== undefined
          ? makeAgentConversation({
            ...common,
            setup: Effect.tap(agentSetup, (s) =>
              Effect.sync(() => {
                for (const agent of s.agents.agents.values()) if (agent.endConversation !== undefined) usedAgents.add(agent)
              }))
          })
          : makeConversationWithSetup({ ...common, setup: options.setup }).pipe(Effect.provideService(Llm, providers.llm ?? noLlm))
        ).pipe(Effect.provideService(TurnTrace, options.turnTrace))
        live = conversation
        ready = true

        const speech: Stream.Stream<ConversationInput, unknown> = options.speech !== undefined
          ? options.speech(built)
          : options.input !== undefined && options.gate !== undefined && providers.stt !== undefined
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

    /**
     * The session's loop on one build: one conversation at a time. A change of kind (`bindingChanged`) ends the
     * running one as an engine rebuild does (`runConversation` keeps what the next one starts from) and starts one of
     * the other kind on the same build; other sessions and the engines are not touched.
     */
    const run = (built: BuiltEngines): Effect.Effect<void, unknown> =>
      Effect.gen(function*() {
        while (true) {
          const agentSetup = options.agentSetup?.()
          // The agents an earlier run used, which this one does not: their session of this conversation ends.
          if (agentSetup === undefined) yield* endUsedAgents(conversationInfo.id)
          const signal = yield* Deferred.make<void>()
          restart = { agents: agentSetup !== undefined, signal }
          const fiber = yield* Effect.forkChild(runConversation(built, agentSetup))
          const changed = yield* Effect.raceFirst(Effect.as(Fiber.join(fiber), false), Effect.as(Deferred.await(signal), true)).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber))
          )
          if (!changed) return
          // Waits for the conversation's own ending (its history kept) before the next one starts from it.
          yield* Fiber.interrupt(fiber)
        }
      }).pipe(Effect.ensuring(Effect.sync(() => {
        restart = undefined
      })))

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
        // No loop to tell them: the agents its runs used end the old conversation here.
        return Effect.andThen(
          endUsedAgents(conversationInfo.id),
          Effect.sync(() => {
            history = []
            lastTurnAt = undefined
            conversationInfo = { id: globalThis.crypto.randomUUID(), startedAt: Date.now() }
            options.onConversation?.(conversationInfo, "new")
            return conversationInfo
          })
        )
      }),
      voice: () => voice,
      start: () => {
        detach ??= options.engine.attach(loop)
      },
      bindingChanged: () => {
        const r = restart
        if (r !== undefined && (options.agentSetup?.() !== undefined) !== r.agents) Deferred.doneUnsafe(r.signal, Effect.void)
      },
      end: Effect.suspend(() => {
        const d = detach
        detach = undefined
        const id = conversationInfo.id
        return Effect.andThen(d ?? Effect.void, endUsedAgents(id))
      })
    } satisfies SessionConversation
  })
