import { makeWebAudio, type WebAudio } from "@pva/audio-web"
import {
  addTraceEvent,
  type AgentTurnSetup,
  type ConversationEvent,
  type ConversationInput,
  ECHO_TAIL_MS,
  type EchoGate,
  makeEchoGate,
  makeRouteGate,
  type Message,
  type RouteConfig,
  type RouteGate,
  type RouteResult,
  type Stt,
  type SttEvent,
  type UtteranceTimes,
  type Trace,
  type TurnSetup,
  TurnTrace,
  voiceKey
} from "@pva/core"
import {
  type Assistant,
  type ConversationInfo,
  type DeviceSettings,
  MAX_DEVICE_NAME_CHARS,
  routeConfigFrom,
  type ServerMessage,
  type SessionInfo,
  type TraceConfig,
  type TraceInfo,
  type TraceRoute,
  typedTextTarget,
  TYPESAFE_GIVE_UP_MS,
  typesafeCandidates,
  WAKE_ARMED_MS
} from "@pva/protocol"
import { Cause, Deferred, Effect, Exit, Fiber, Queue, type Scope, Stream } from "effect"
import type { Engine, SessionLoop } from "./Engine.ts"
import { type HeardAudio, makeHeardAudio } from "./HeardAudio.ts"
import { makeOutputLease } from "./OutputLease.ts"
import { makePublisher, type Publisher } from "./Publisher.ts"
import { makeTypesafeDecide, type RoutingService, typesafeNow } from "./routing.ts"
import { makeSessionConversation, type SendOutcome, type SessionConversation } from "./SessionConversation.ts"
import { type DispatchRoute, type DispatchTarget, makeSessionDispatcher, type RouteDecision, type SessionDispatcher } from "./SessionDispatcher.ts"
import { makeStateTracker, type StateTracker } from "./StateTracker.ts"

/**
 * One device's voice session (docs/VOICE-SESSIONS.md §2, docs/ASSISTANTS.md §3.3): its own `WebAudio` (microphone in,
 * replies out, to the owner tab of this device), echo gate, route gate, state tracker, publisher, "save what it
 * hears" tap, and one conversation per assistant (each with its own history, id and idle clock), on the shared
 * engines. The device's effective settings (type defaults ← its own sections) decide its assistants, their phrases,
 * the without-phrase mode and the interrupt mode, read live (`syncProfile`); each assistant's prompt, modules,
 * follow-up, quiet spell and "reply early" are read from it at use.
 *
 * The audio path: the recogniser stream runs once per session per engine build (a `SessionLoop` of its own) on the
 * recogniser the device hears with (`hearing`: the resource pool's for its hearer, docs/ASSISTANTS.md §2.6, WP-11;
 * none while the device has no assistant), then the echo gate, the route gate and the session dispatcher, which
 * feeds each assistant's conversation through an inbox (`SessionConversation`'s `speech` seam). When the hearing
 * changes (another hearer, model or stream options), the pool binds the new recogniser once it is built, and the
 * stream is replaced at the next moment no utterance is open, waiting at most `HEARER_SWITCH_WAIT_MS` (§3.5). All conversations play through one output lease, so two replies
 * never sound at once. Who owns the audio (which tab of the device) is the hub's business: it calls
 * `web.setOwner` / `setMicLive` and `ownerChanged`.
 *
 * WP-9, WP-10: each assistant's language model and voice are the resource pool's instances for its settings (read at
 * each turn start).
 */

/** The assistant's part of a turn's configuration snapshot (everything but the hearing, which is the device's). */
export type AssistantTraceConfig = Omit<TraceConfig, "hearing">

export interface AssistantSetup {
  /** Read at each turn start: prompt, tools and (`TurnSetup.llm`) the resource pool's language model for the assistant. */
  readonly setup: Effect.Effect<TurnSetup>
  /** A `claude-subscription` assistant's agent setup (chosen at each run start; see `SessionConversation`). */
  readonly agentSetup?: () => Effect.Effect<AgentTurnSetup> | undefined
  /**
   * Read when a turn's trace begins: what the turn uses (`TraceConfig` without the hearing). Must be cheap (the turn
   * path) and return an object that is never changed afterwards (the trace keeps it).
   */
  readonly config?: () => AssistantTraceConfig | undefined
}

/**
 * What this device hears with now (docs/ASSISTANTS.md §2.6 "The device's recogniser", §3.5): `none` (no assistant
 * on the device: no recogniser runs), `waiting` (the pool has not bound one yet), or the recogniser with its hearer's
 * stream options. `id` changes with a new instance and with changed stream options: the session's stream is then
 * replaced at the next silence.
 */
export type Hearing =
  | { readonly kind: "none" }
  | { readonly kind: "waiting" }
  | {
    readonly kind: "ready"
    readonly id: string
    readonly stt: Stt["Service"]
    /** The resource's key, for the log. */
    readonly key: string
    /** The instance failed (its streams fail with this problem until it is built again). */
    readonly problem?: string
    /** What it is, as a turn's configuration snapshot says it (`TraceConfig.hearing`); the same object while unchanged. */
    readonly trace?: TraceConfig["hearing"]
  }

/** Longest wait for silence before a hearer switch closes an utterance that is still open (§3.5). */
export const HEARER_SWITCH_WAIT_MS = 5_000

export interface VoiceSessionOptions {
  /** The session's key: the device id, or the client id of a voice connection without a device. */
  readonly key: string
  readonly deviceId?: string
  /** The device's name now (or a description of the connection without a device). */
  readonly name: () => string
  readonly engine: Engine
  /** The device's effective settings now (docs/ASSISTANTS.md §2.6). */
  readonly deviceSettings: () => DeviceSettings
  /**
   * The recogniser this device hears with now (the resource pool's for its hearer, WP-11). Read when the recogniser
   * loop starts and again after every `hearingChanged`. Absent: the engine build's `stt` (tests).
   */
  readonly hearing?: () => Hearing
  /** Longest wait for silence before a hearer switch (tests shorten it). Default `HEARER_SWITCH_WAIT_MS`. */
  readonly hearerSwitchWaitMs?: number
  /** The assistants in effect now, by id. */
  readonly assistants: () => ReadonlyMap<string, Assistant>
  /** Per assistant: its turn setup (prompt, module instructions, its tools), and the agent setup (claude-subscription). */
  readonly conversationSetup: (assistant: string, deviceId: string | undefined) => AssistantSetup
  /**
   * The key of the voice an assistant speaks with on this device now (the resource pool's, docs/ASSISTANTS.md §3.2):
   * the device's own voice, else the assistant's (docs/LOOKS-AND-VOICES.md §3).
   */
  readonly voiceOf?: (assistant: string, deviceId: string | undefined) => string | undefined
  /** The module that contributes a tool (module host snapshot). */
  readonly moduleOfTool: (name: string) => string | null
  /**
   * TypeSafe routing (the shared `routing` section, docs/ASSISTANTS.md §3.6): asked for an utterance the route gate
   * leaves to `decide` (a TypeSafe device, no phrase, no open window). Absent or not ready: nobody answers it.
   */
  readonly routing?: () => RoutingService | undefined
  /** The shared trace service (log line, recent list); this session numbers its own turns and sets `session`. */
  readonly turnTrace: TurnTrace["Service"]
  /** To every connection of this device. */
  readonly send: (message: ServerMessage) => void
  /** One final transcript, for the phrase tester (`wake.heard`; `assistant`: whose phrase matched here, if anyone's). */
  readonly wakeHeard: (text: string, phrase: string | undefined, accepted: boolean, assistant: string | undefined) => void
  /** Something admin's `sessions` shows changed (state, a turn, the conversation). */
  readonly onChange: (minor: boolean) => void
  /** A committed turn ended (the recent traces of every session, for admin). */
  readonly onTrace?: (trace: TraceInfo) => void
  /** What one minute of `newConversationAfter` is, in ms (tests shorten it). Default 60 000. */
  readonly minuteMs?: number
  readonly maxPendingInputs?: number
  /** The conversation to start with (an id this device was given before its session existed): the answering assistant's. */
  readonly initialConversation?: { readonly id: string; readonly startedAt: number }
  /** Ids the device's other assistants were given before the session existed (`conversation.read`), by assistant. */
  readonly reservedConversations?: ReadonlyMap<string, { readonly id: string; readonly startedAt: number }>
  /** "Save what the assistant hears". */
  readonly heard: {
    readonly dir: string
    readonly enabled: () => boolean
    readonly maxFiles: () => number
    readonly model: () => string
    readonly writable?: () => boolean
    readonly begin?: (what: string) => (() => void) | undefined
    /** Microphone frames lost on the way from this device's owner tab, since the session started. */
    readonly lostOnTheWay: () => number
    /** The "Heard …" line of each recording. Default `log`. */
    readonly log?: (line: string) => void
  }
  readonly stallMs?: number
  readonly log: (line: string) => void
}

/** What typed text came to: `dropped` when nobody answers it on this device (its target is off, or there is none). */
export type TextOutcome = SendOutcome | "dropped"

/**
 * The session's conversations, one per assistant (made on first use), as the hub and `VoiceSessions` use them.
 * Without `assistant`, the methods mean the *answering* assistant: the one holding a follow-up window, else the one
 * that answers without a phrase, else the TypeSafe fallback, else the first in the device's list (§5.3).
 */
export interface SessionConversations {
  /** Typed text, routed as §2.6 "Typed text" says (`named`: the assistant the page names). */
  readonly sendText: (text: string, speak: boolean, named?: string) => Effect.Effect<TextOutcome>
  /** Stop: `assistant`'s conversation, or every active one. */
  readonly stop: (assistant?: string) => SendOutcome
  readonly running: () => boolean
  readonly history: (assistant?: string) => Effect.Effect<ReadonlyArray<Message>>
  readonly conversation: (assistant?: string) => ConversationInfo
  readonly lastTurnAt: (assistant?: string) => number | undefined
  /** The turn whose exchange ends `assistant`'s history (`conversation.history.lastTurnId`, §5.3), if the server knows it. */
  readonly lastTurnId: (assistant?: string) => number | undefined
  /** Committed turns in `assistant`'s current conversation. */
  readonly turnsOf: (assistant?: string) => number
  readonly newConversation: (assistant?: string) => Effect.Effect<ConversationInfo>
  /** The answering assistant now (`undefined`: the device has none). */
  readonly answering: () => string | undefined
  /** Start running on the engines (now and after every rebuild) until `end`. */
  readonly start: () => void
  /** Stop for good: the recogniser loop and every conversation (their agents are told). */
  readonly end: Effect.Effect<void>
  /** The dispatcher (tests and diagnostics). */
  readonly dispatcher: SessionDispatcher<AssistantConversation>
}

export interface VoiceSession {
  readonly key: string
  readonly deviceId: string | undefined
  readonly name: () => string
  readonly web: WebAudio
  readonly tracker: StateTracker
  readonly publisher: Publisher
  readonly gate: EchoGate
  readonly route: RouteGate
  readonly conversation: SessionConversations
  readonly heard: HeardAudio
  /** The device's settings or assistants may have changed: apply the interrupt mode and the route config (only when changed). */
  readonly syncProfile: () => void
  /**
   * What the device hears with may have changed (a save, a pool binding, a recogniser that failed or was rebuilt):
   * read `hearing` again; a different recogniser or stream options replace the stream at the next silence (§3.5).
   */
  readonly hearingChanged: () => void
  /** The key of the recogniser this session's stream runs on now (`undefined`: none runs). Tests, diagnostics. */
  readonly hearingKey: () => string | undefined
  /** Ownership on this device changed (the hub's view): the state follows it. */
  readonly ownerChanged: (present: boolean, micLive: boolean) => void
  readonly ownerPresent: () => boolean
  /** Committed turns in the answering assistant's current conversation. */
  readonly turns: () => number
  /** `performance.now()` of the last activity (a claim, a recognition event, a turn): "the most recently active". */
  readonly lastActiveAt: () => number
  readonly touch: () => void
  readonly info: () => SessionInfo
  /**
   * Who has the turn on the device (`state.holder`, `snapshot.holder`): the assistant of the turn in flight or of the
   * utterance being heard, else the one whose armed or follow-up window is open, else `null` (nobody).
   */
  readonly holder: () => string | null
  /** A `device.pick` was accepted: the open windows close, so the picked assistant answers the next sentence (§5.3). */
  readonly pickAccepted: () => void
}

/**
 * The trace service of one assistant's conversation in a session: turn ids from the session's one counter (unique
 * across its conversations), `session` / `device` = the device name, and the assistant and its route filled at
 * the turn's start (the route again at its end of turn, when the final transcript has decided it).
 */
export const assistantTurnTrace = (
  shared: TurnTrace["Service"],
  counter: { next: number },
  fields: {
    readonly session: () => string
    readonly deviceId?: string | undefined
    readonly assistant?: () => { readonly id: string; readonly name: string } | undefined
    readonly route?: () => TraceRoute | undefined
    /** The routing call's times (trace clock) of the route, when TypeSafe was asked. */
    readonly routeTimes?: () => Pick<RouteDecision, "sentAt" | "receivedAt"> | undefined
    /** When the route was decided and its wake phrase heard (trace clock; the time line's `assistantChosen`, `wakePhrase`). */
    readonly routedAt?: () => { readonly chosenAt: number; readonly phraseAt?: number; readonly phrase?: string } | undefined
    /** The configuration snapshot of the turn (docs/ASSISTANTS.md §3.7), read once at its start; never changed after. */
    readonly config?: () => TraceConfig | undefined
  }
): TurnTrace["Service"] => {
  /** `routeSent`/`routeReceived` of the current route (replaced: the final may have asked again). */
  const markRoute = (trace: Trace) => {
    const times = fields.routeTimes?.()
    delete trace.marks.routeSent
    delete trace.marks.routeReceived
    // The route may be decided again at the final: its entries are replaced.
    if (trace.events !== undefined) trace.events = trace.events.filter((e) => e.name !== "wakePhrase" && e.name !== "assistantChosen")
    const at = fields.routedAt?.()
    if (at !== undefined) {
      if (at.phraseAt !== undefined) addTraceEvent(trace, "wakePhrase", at.phraseAt, undefined, at.phrase)
      addTraceEvent(trace, "assistantChosen", at.chosenAt, undefined, trace.assistant?.id)
    }
    if (times === undefined) return
    trace.marks.routeSent = times.sentAt
    if (times.receivedAt !== undefined) trace.marks.routeReceived = times.receivedAt
  }
  return TurnTrace.of({
    now: shared.now,
    begin: (mode, speculative = false) => {
      const session = fields.session()
      const assistant = fields.assistant?.()
      const route = fields.route?.()
      const config = fields.config?.()
      const trace: Trace = {
        id: counter.next++,
        mode,
        speculative,
        startedAt: shared.now(),
        marks: {},
        tools: [],
        voices: [],
        session,
        ...(assistant !== undefined ? { assistant, device: session } : {}),
        ...(assistant !== undefined && fields.deviceId !== undefined ? { deviceId: fields.deviceId } : {}),
        ...(route !== undefined ? { route } : {}),
        ...(config !== undefined ? { config } : {})
      }
      if (mode === "voice") markRoute(trace)
      return trace
    },
    mark: (trace, mark) => {
      shared.mark(trace, mark)
      if (mark === "endOfTurn" && fields.route !== undefined) {
        const route = fields.route()
        if (route !== undefined) {
          trace.route = route
          markRoute(trace)
        }
      }
    },
    event: shared.event,
    finish: shared.finish,
    recent: shared.recent
  })
}

/** One assistant's conversation in a session, as the dispatcher holds it. */
export interface AssistantConversation extends DispatchTarget {
  readonly conversation: SessionConversation
}
type Target = AssistantConversation

const idleMsOf = (assistant: Assistant | undefined, minuteMs: number): number | undefined =>
  assistant === undefined || assistant.newConversationAfter === "never" ? undefined : assistant.newConversationAfter * minuteMs

export const makeVoiceSession = (options: VoiceSessionOptions): Effect.Effect<VoiceSession, never, Scope.Scope> =>
  Effect.gen(function*() {
    const now = () => performance.now()
    let lastActive = now()
    const touch = () => {
      lastActive = now()
    }
    let owner = { present: false, micLive: false }
    const minuteMs = options.minuteMs ?? 60_000

    const gate = makeEchoGate("instant")
    // After the echo gate, before the dispatcher; configured from this device's settings and the assistants.
    const routeConfigNow = (): RouteConfig => routeConfigFrom(options.deviceSettings(), options.assistants())
    const routeKeyOf = (config: RouteConfig) => JSON.stringify({ ...config, off: [...config.off].sort() })
    const route = makeRouteGate(routeConfigNow())
    let routeKey = routeKeyOf(route.config())
    const followUpOf = (assistant: string | undefined) => (assistant === undefined ? 0 : route.config().followUpMs?.[assistant] ?? 0)
    const longestFollowUp = () => Math.max(0, ...Object.values(route.config().followUpMs ?? {}))
    const armedMs = () => route.config().armedMs ?? WAKE_ARMED_MS
    /**
     * The assistant the open utterance goes to (its route target), from its `SpeechStarted` to its `EndOfTurn` only, not
     * for the hearing tail after it; `undefined` while TypeSafe decides, for nobody, or once Stop or a new conversation
     * cancelled the utterance (`heardStopped`: the rest of it reaches no turn).
     */
    let heardFor: string | undefined
    let heardStopped = false
    /** The assistant a closed utterance's words went to, until their turn is committed (or the next utterance starts). */
    let handedTo: string | undefined
    /** The committed turn in flight (from its commit to its `TurnEnded`), whatever the display shows. */
    let inFlight: number | undefined
    /**
     * Who has the turn, the one rule the pages show (`state.holder`, `snapshot.holder`), from the routing state only:
     * the assistant of the turn in flight, else of the open utterance (an armed window is consumed when the utterance
     * starts, its assistant keeps the turn to its `EndOfTurn`), else of the words a closed utterance handed over, else
     * the one whose armed or follow-up window is open, else nobody. Never the display state (the tracker's hearing
     * timer, the microphone): those change what the page shows, not who answers.
     */
    const holderNow = (): string | null =>
      (inFlight === undefined ? undefined : assistantOfTurn(inFlight)) ?? heardFor ?? handedTo ?? route.window(now())?.assistant ?? null
    let holderSent: string | null = null
    const tracker = makeStateTracker({
      onChange: (s) => {
        holderSent = holderNow()
        options.send({ type: "state", ...s, holder: holderSent })
        options.onChange(true)
      },
      asleep: () => route.config().withoutPhrase === "nobody" && !route.awake(now())
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => tracker.dispose()))
    /** A window closes by time without the state changing (the device keeps listening): the same state, the new holder. */
    const holderCheck = () => {
      const holder = holderNow()
      if (holder === holderSent) return
      holderSent = holder
      options.send({ type: "state", ...tracker.current(), holder })
    }
    const holderTimers = new Set<ReturnType<typeof setTimeout>>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const t of holderTimers) clearTimeout(t)
      })
    )
    /** `tracker.wakeChanged`, and the same re-check for the holder. */
    const wakeChanged = (recheckInMs?: number) => {
      tracker.wakeChanged(recheckInMs)
      holderCheck()
      if (recheckInMs === undefined) return
      const t = setTimeout(() => {
        holderTimers.delete(t)
        holderCheck()
      }, recheckInMs + 10)
      t.unref?.()
      holderTimers.add(t)
    }

    /** The voice key `assistant` speaks with in this session ("" when it has none: not in use, the engines not running). */
    const voiceNow = (assistant: string | undefined): string => {
      const own = assistant === undefined ? undefined : options.voiceOf?.(assistant, options.deviceId)
      if (own !== undefined) return own
      const voice = options.engine.voice()
      return voice === undefined ? "" : voiceKey(voice)
    }

    /**
     * The hearing part of a turn's configuration snapshot: the recogniser the stream runs on (a voice turn was heard
     * with it), else the one the device would hear with now (typed text while no stream runs).
     */
    const hearingTrace = (): TraceConfig["hearing"] | undefined => {
      if (streamHearing?.trace !== undefined) return streamHearing.trace
      const now = options.hearing?.()
      return now?.kind === "ready" ? now.trace : undefined
    }

    // Late-bound: the dispatcher's conversations report their turns here.
    let dispatcherRef: SessionDispatcher<Target> | undefined
    const assistantOfTurn = (turnId: number) => dispatcherRef?.assistantOfTurn(turnId)

    /** Committed turns per assistant in its current conversation (admin `sessions`). */
    const turnsBy = new Map<string, number>()
    const send = (message: ServerMessage) => {
      if (message.type === "turn.end") {
        const a = assistantOfTurn(message.turnId) ?? ""
        turnsBy.set(a, (turnsBy.get(a) ?? 0) + 1)
        touch()
        options.onChange(false)
      }
      options.send(message)
    }
    const publisher = makePublisher({
      broadcast: send,
      onCommitted: (turnId) => {
        // The handed-over words have their turn now: the turn in flight names the holder.
        handedTo = undefined
        inFlight = turnId
        tracker.turnPromoted(turnId)
      },
      moduleOfTool: options.moduleOfTool,
      voice: voiceNow,
      ...(options.onTrace !== undefined ? { onTrace: options.onTrace } : {})
    })

    // Manual interrupt mode: the microphone is replaced by silence while the assistant is audible (plus the reverb tail).
    let unsuppress: ReturnType<typeof setTimeout> | undefined
    const web: WebAudio = yield* makeWebAudio({
      ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      log: options.log,
      onPlayback: (event) => {
        // The reply's assistant: its follow-up window opens when the reply ends (§2.6 rule 3).
        const assistant = assistantOfTurn(event.turnId)
        if (event._tag === "started") {
          tracker.playbackStarted(event.turnId)
          gate.playbackStarted(now())
          if (assistant !== undefined) route.replyStarted(assistant, now())
          if (unsuppress !== undefined) clearTimeout(unsuppress)
          if (options.deviceSettings().interruptMode === "manual") web.setSuppressed(true)
        } else {
          tracker.playbackEnded(event.turnId, event.reason)
          gate.playbackEnded(now())
          if (assistant !== undefined) route.replyEnded(assistant, now())
          wakeChanged(followUpOf(assistant))
          if (unsuppress !== undefined) clearTimeout(unsuppress)
          unsuppress = setTimeout(() => web.setSuppressed(false), ECHO_TAIL_MS)
          unsuppress.unref?.()
        }
      },
      onStall: (turnId) =>
        options.send({
          type: "error",
          error: { code: "playback_timeout", message: "The browser stopped reporting playback, so the reply was stopped", turnId }
        })
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (unsuppress !== undefined) clearTimeout(unsuppress)
      })
    )
    // One speaker for every conversation of the session (docs/ASSISTANTS.md §1.2).
    const lease = makeOutputLease(web.output)

    // Clause texts per turn, so the echo gate knows the words that just played (turn ids are unique per session).
    const clauses = new Map<number, { texts: Array<string>; given: number }>()
    const onEvent = (assistant: string, event: ConversationEvent) => {
      publisher.onEvent(event, assistant)
      switch (event._tag) {
        case "TurnStarted":
          touch()
          // Committed turns reach the tracker through the publisher's onCommitted, right after turn.start.
          if (event.speculative) tracker.turnStarted(event.turnId, true)
          return
        case "TurnEnded":
          clauses.delete(event.turnId)
          if (inFlight === event.turnId) inFlight = undefined
          return tracker.turnEnded(event.turnId)
        case "ClauseQueued": {
          const entry = clauses.get(event.turnId) ?? { texts: [], given: 0 }
          entry.texts[event.index] = event.text
          clauses.set(event.turnId, entry)
          return
        }
        case "ClausePlaying": {
          const entry = clauses.get(event.turnId)
          if (entry === undefined) return
          for (; entry.given <= event.index; entry.given++) gate.clausePlayed(entry.texts[entry.given] ?? "", now())
          return
        }
        default:
          return
      }
    }

    // "What does the assistant hear" (RECORD_HEARD_AUDIO): taps this session's recogniser input and events.
    let lastInput = web.inputStats()
    let lastLost = 0
    const heard = makeHeardAudio({
      dir: options.heard.dir,
      enabled: options.heard.enabled,
      maxFiles: options.heard.maxFiles,
      model: options.heard.model,
      device: () => ({ key: options.key, name: options.name() }),
      // Counters since the previous recording.
      transport: () => {
        const current = web.inputStats()
        const lost = options.heard.lostOnTheWay()
        const delta = {
          micFrames: current.micFrames - lastInput.micFrames,
          droppedFrames: current.droppedFrames - lastInput.droppedFrames,
          noiseFrames: current.noiseFrames - lastInput.noiseFrames,
          unroutedMicFrames: current.unroutedMicFrames - lastInput.unroutedMicFrames,
          lostOnTheWay: lost - lastLost,
          maxMicGapMs: current.maxMicGapMs
        }
        lastInput = current
        lastLost = lost
        return delta
      },
      log: options.heard.log ?? options.log,
      ...(options.heard.writable !== undefined ? { writable: options.heard.writable } : {}),
      ...(options.heard.begin !== undefined ? { begin: options.heard.begin } : {})
    })
    yield* Effect.addFinalizer(() => Effect.promise(() => heard.close()))
    const input = web.input.stream.pipe(Stream.tap((chunk) => Effect.sync(() => heard.audio(chunk))))

    // ---- Assistants and their conversations

    /** Who `assistant` is now (name for traces); `undefined` for an assistant that does not exist (any more). */
    const assistantOf = (assistant: string) => options.assistants().get(assistant)

    /** The phrase that armed each assistant last (an `armed` route reports it). */
    const armedPhrase = new Map<string, string>()
    /** The dispatcher's route for `assistant`, as a trace says it (protocol 7 `TraceRoute`). */
    const traceRouteOf = (assistant: string): TraceRoute | undefined => {
      const r: DispatchRoute | undefined = dispatcherRef?.routeOf(assistant)
      if (r === undefined) return undefined
      switch (r.by) {
        case "phrase":
          return { by: "phrase", phrase: r.phrase }
        case "armed":
          return { by: "armed", phrase: armedPhrase.get(assistant) ?? "" }
        case "follow-up":
        case "default":
        case "typed":
          return { by: r.by }
        // TypeSafe (§3.6): its outcome and time; without a call (no candidate) the fallback, as the device's default.
        case "decide": {
          const d = r.decision
          if (d === undefined) return { by: "default" }
          return {
            by: "typesafe",
            outcome: d.outcome,
            ...(d.probability !== undefined ? { probability: Math.round(d.probability * 1000) / 1000 } : {}),
            ...(d.fits !== undefined ? { fits: Math.round(d.fits * 1000) / 1000 } : {}),
            ms: Math.round(d.ms * 10) / 10,
            fallback: r.fallback
          }
        }
        // It was replying (the barge-in owner) and no transcript chose otherwise.
        case "barge-in":
          return { by: "follow-up" }
      }
    }

    /** One turn counter for every conversation of the session (`assistantOfTurn` relies on unique ids). */
    const counter = { next: 1 }
    let started = false
    /** Conversation ids for assistants whose conversation is not made yet (the first one made takes it). */
    const reserved = new Map<string, ConversationInfo>()
    const fresh = (): ConversationInfo => ({ id: globalThis.crypto.randomUUID(), startedAt: Date.now() })
    const reservedFor = (assistant: string): ConversationInfo => {
      let info = reserved.get(assistant)
      if (info === undefined) {
        info = fresh()
        reserved.set(assistant, info)
      }
      return info
    }

    // TypeSafe routing for `decide` utterances (§3.6): the device's switched-on assistants, described by their Handles.
    const decide = makeTypesafeDecide({
      routing: () => options.routing?.(),
      candidates: () => {
        const assistants = options.assistants()
        return typesafeCandidates(options.deviceSettings(), assistants).map((id) => {
          const a = assistants.get(id)!
          return { id, name: a.name, purpose: a.purpose, handles: a.handles }
        })
      },
      giveUpMs: () => {
        const wp = options.deviceSettings().withoutPhrase
        return wp.mode === "typesafe" ? wp.giveUpMs : TYPESAFE_GIVE_UP_MS.default
      },
      now: options.turnTrace.now,
      log: (line) => options.log(`${options.name()}: ${line}`)
    })

    const dispatcher = makeSessionDispatcher<Target>({
      replyEarly: (assistant) => assistantOf(assistant)?.replyEarly ?? true,
      now: options.turnTrace.now,
      decide,
      // The device may have changed while TypeSafe was asked: the answer goes only to an assistant it still has, and
      // to nobody once the device no longer routes by TypeSafe.
      decideNow: () => typesafeNow(options.deviceSettings(), options.assistants()),
      make: (assistant, hooks) =>
        Effect.gen(function*() {
          const inbox = yield* Queue.unbounded<ConversationInput>()
          let runs = 0
          const { setup, agentSetup, config: assistantConfig } = options.conversationSetup(assistant, options.deviceId)
          /** The assistant's part and the device's hearing, joined once per change of either (the turn path reads it). */
          let joined: { readonly part: AssistantTraceConfig; readonly hearing: TraceConfig["hearing"]; readonly value: TraceConfig } | undefined
          const traceConfig = (): TraceConfig | undefined => {
            const part = assistantConfig?.()
            const hearing = hearingTrace()
            if (part === undefined || hearing === undefined) return undefined
            if (joined?.part !== part || joined.hearing !== hearing) joined = { part, hearing, value: { ...part, hearing } }
            return joined.value
          }
          const initial = reservedFor(assistant)
          reserved.delete(assistant)
          const conversation = yield* makeSessionConversation({
            engine: options.engine,
            output: lease.output(assistant),
            turnTrace: assistantTurnTrace(options.turnTrace, counter, {
              session: options.name,
              deviceId: options.deviceId,
              assistant: () => {
                const a = assistantOf(assistant)
                return { id: assistant, name: a?.name ?? assistant }
              },
              route: () => traceRouteOf(assistant),
              routedAt: () => {
                const t = dispatcherRef?.routedAtOf(assistant)
                if (t === undefined) return undefined
                const r = dispatcherRef?.routeOf(assistant)
                return r?.by === "phrase" ? { ...t, phrase: r.phrase } : t
              },
              routeTimes: () => {
                const r = dispatcherRef?.routeOf(assistant)
                return r?.by === "decide" ? r.decision : undefined
              },
              config: traceConfig
            }),
            setup,
            ...(agentSetup !== undefined ? { agentSetup } : {}),
            onEvent: (event) => {
              hooks.onEvent(event)
              onEvent(assistant, event)
            },
            onConversation: (info, reason) => {
              turnsBy.set(assistant, 0)
              options.send({ type: "conversation", id: info.id, reason, startedAt: info.startedAt, assistantId: assistant })
              options.onChange(false)
            },
            // Events queued while the engines were rebuilt are stale: each run after the first starts empty.
            speech: () => (runs++ === 0 ? Stream.fromQueue(inbox) : Stream.unwrap(Effect.as(Queue.clear(inbox), Stream.fromQueue(inbox)))),
            // The assistant's quiet spell ("never" = no reset) and tool rounds, read live.
            idleResetMs: () => idleMsOf(assistantOf(assistant), minuteMs),
            maxToolRounds: () => assistantOf(assistant)?.toolRounds ?? options.engine.built()?.providers.maxToolRounds ?? 5,
            ...(options.maxPendingInputs !== undefined ? { maxPendingInputs: options.maxPendingInputs } : {}),
            initialConversation: initial
          })
          if (started) conversation.start()
          return { push: (input) => void Queue.offerUnsafe(inbox, input), send: conversation.send, conversation }
        })
    })
    dispatcherRef = dispatcher

    /** §5.3: the follow-up holder, else who answers without a phrase, else the TypeSafe fallback, else the first. */
    const answering = (): string | undefined => {
      const w = route.window(now())
      if (w?.by === "follow-up") return w.assistant
      const settings = options.deviceSettings()
      const wp = settings.withoutPhrase
      if (wp.mode === "assistant") return wp.assistant
      if (wp.mode === "typesafe" && wp.fallback !== null) return wp.fallback
      return settings.assistants[0]?.assistant
    }
    for (const [assistant, info] of options.reservedConversations ?? []) reserved.set(assistant, info)
    // The device's reserved conversation (from before its session existed) is the answering assistant's.
    if (options.initialConversation !== undefined) reserved.set(answering() ?? "", options.initialConversation)

    const conversationOf = (assistant: string | undefined) => (assistant === undefined ? undefined : dispatcher.get(assistant)?.conversation)

    // ---- The recogniser loop: Stt → echo gate → route gate → dispatcher

    let lastTranscript = ""
    const transcript = (text: string) => {
      if (text === lastTranscript) return
      lastTranscript = text
      options.send({ type: "transcript", text })
    }
    /**
     * Only what passed both gates is shown (transcript), moves the state or reaches a conversation: an utterance the
     * route gate drops reaches no page, no history, no agent and no recording (`heard.discard`); its text goes only
     * to admin pages with the phrase tester on (`wake.heard`).
     */
    /** The open utterance's times (trace clock), shared by its events; see `UtteranceTimes`. */
    let utterance: UtteranceTimes | undefined
    /** Stamp the recogniser's events where they enter the session: before any gate can hold them back. */
    const stamp = (event: SttEvent): SttEvent => {
      switch (event._tag) {
        case "SpeechStarted":
          if (utterance === undefined) utterance = { startedAt: options.turnTrace.now() }
          return utterance === undefined || event.heard === utterance ? event : { ...event, heard: utterance }
        case "Interim":
          if (utterance !== undefined && utterance.firstInterimAt === undefined && event.text.trim() !== "") {
            utterance.firstInterimAt = options.turnTrace.now()
          }
          return event
        case "EagerEndOfTurn":
        case "TurnResumed":
          // On the event itself (an utterance may have several): the dispatcher may hold it for the routing call.
          return event.heardAt !== undefined ? event : { ...event, heardAt: options.turnTrace.now() }
        case "EndOfTurn":
          utterance = undefined
          return event
        default:
          return event
      }
    }
    const onStt = (input: SttEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        const event = stamp(input)
        const t = now()
        if (event._tag !== "EndOfTurn") heard.event(event)
        const echo = gate.filter(event, t)
        const results: Array<RouteResult> = []
        let dropped = false
        for (const e of echo.events) {
          const r = route.filter(e, t)
          results.push(r)
          // The utterance's assistant (a phrase in it may change it), before the state that names it is sent.
          const routed = r.target
          const routedTo = routed === undefined || routed.by === "decide" || routed.by === "dropped" ? undefined : routed.assistant
          if (e._tag === "SpeechStarted") handedTo = undefined
          if (e._tag === "EndOfTurn") {
            // The utterance is over: it holds the turn no longer (a phrase alone leaves its armed window). Its words,
            // if any reach a turn, hold it until that turn is committed.
            const words = !heardStopped && r.events.some((p) => p._tag === "EndOfTurn" && p.text.trim().length > 0)
            handedTo = words ? routedTo : undefined
            heardFor = undefined
            heardStopped = false
          } else if (heardStopped) heardFor = undefined
          else if (routed !== undefined) heardFor = routedTo
          else if (e._tag === "SpeechStarted") heardFor = undefined
          if (r.heard !== undefined) options.wakeHeard(r.heard.text, r.heard.phrase, r.heard.accepted, r.heard.assistant)
          if (r.woke !== undefined) {
            // The phrase's utterance is still heard: its new holder goes out before `wake`, which the page shows until the next state.
            holderCheck()
            if (r.woke.armed) armedPhrase.set(r.woke.assistant, r.woke.phrase)
            options.send({ type: "wake", phrase: r.woke.phrase, armed: r.woke.armed, assistantId: r.woke.assistant })
            wakeChanged(r.woke.armed ? armedMs() : followUpOf(r.woke.assistant))
          }
          if (r.dropped !== undefined || (e._tag === "EndOfTurn" && r.events.length === 0)) dropped = true
          for (const passed of r.events) {
            lastActive = t
            tracker.stt(passed)
            if (passed._tag === "Interim") transcript(passed.text)
            else if (passed._tag === "EndOfTurn") {
              transcript("")
              // An accepted utterance opens the follow-up window: the state may go back to asleep by itself.
              if (route.config().withoutPhrase === "nobody") {
                const target = r.target
                wakeChanged(followUpOf(target !== undefined && "assistant" in target ? target.assistant : undefined))
              }
            }
          }
        }
        if (event._tag === "EndOfTurn") {
          if (dropped) heard.discard()
          else heard.event(event)
        }
        if (echo.dropped) transcript("")
        // A phrase inside the utterance may have changed who has the turn while the state stayed `hearing`.
        holderCheck()
        return Effect.forEach(results, dispatcher.dispatch, { discard: true })
      })

    // ---- Which recogniser the device hears with (docs/ASSISTANTS.md §3.5)

    /** An utterance is open in the recogniser's events (`SpeechStarted` … its `EndOfTurn`): no switch now. */
    let utteranceOpen = false
    /** Completed (and replaced) whenever `hearingChanged` is called. */
    let changed = Deferred.makeUnsafe<void>()
    const hearingChanged = () => {
      const was = changed
      changed = Deferred.makeUnsafe<void>()
      Deferred.doneUnsafe(was, Effect.void)
    }
    let streamKey: string | undefined
    /** The hearing the recogniser stream runs on now (what an utterance was heard with). */
    let streamHearing: Extract<Hearing, { kind: "ready" }> | undefined
    const switchWaitMs = options.hearerSwitchWaitMs ?? HEARER_SWITCH_WAIT_MS
    /** The id of a recogniser whose stream failed: not tried again until the hearing changes. */
    let failedId: string | undefined

    /** An utterance closed outside `onStt` (a recogniser switch, a new build): it holds the turn no longer. */
    const utteranceDropped = () => {
      // Its times too: the next `SpeechStarted` begins a new utterance (its `EndOfTurn` never came through `stamp`).
      utterance = undefined
      heardFor = undefined
      heardStopped = false
      handedTo = undefined
      holderCheck()
    }

    /** Closes an utterance the previous stream left open (it starts nothing). */
    const closeOpenUtterance = Effect.suspend(() => {
      if (!utteranceOpen) return Effect.void
      utteranceOpen = false
      utteranceDropped()
      heard.discard()
      return dispatcher.dispatch(route.filter({ _tag: "EndOfTurn", text: "" }, now()))
    })

    const sameHearing = (a: Hearing, b: Hearing) => a.kind === b.kind && (a.kind !== "ready" || (b.kind === "ready" && a.id === b.id))

    /**
     * Runs one stream on `hearing` until another hearing is wanted and no utterance is open (at most
     * `switchWaitMs`), or until it fails. A failed stream is reported once to the device (it hears nothing until the
     * recogniser is built again: a vault unlock or the owner's reload); typed text still works.
     */
    const runStream = (hearing: Extract<Hearing, { kind: "ready" }>, hearingNow: () => Hearing): Effect.Effect<void> =>
      Effect.gen(function*() {
        streamKey = hearing.key
        streamHearing = hearing
        const fiber = yield* Effect.forkChild(Effect.exit(Stream.runForEach(hearing.stt.transcribe(input), (event) =>
          Effect.suspend(() => {
            if (event._tag === "SpeechStarted") utteranceOpen = true
            else if (event._tag === "EndOfTurn") utteranceOpen = false
            return onStt(event)
          }))))
        while (true) {
          const signal = changed
          const ended = yield* Effect.raceFirst(
            Effect.map(Fiber.join(fiber), (exit) => ({ ended: exit })),
            Effect.as(Deferred.await(signal), { ended: undefined })
          )
          if (ended.ended !== undefined) {
            streamKey = undefined
            streamHearing = undefined
            const exit = ended.ended
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
              const squashed = Cause.squash(exit.cause)
              const message = squashed instanceof Error ? squashed.message : String(squashed)
              failedId = hearing.id
              options.log(`${options.name()}: speech recognition stopped (${hearing.key}): ${message}`)
              options.send({ type: "error", error: { code: "engine_failed", message: `Speech recognition stopped: ${message}` } })
            }
            yield* closeOpenUtterance
            return
          }
          const next = hearingNow()
          // A recogniser still being bound (`waiting`) keeps the current one: the device goes on hearing.
          if (next.kind === "waiting") continue
          if (sameHearing(next, hearing)) {
            // The same recogniser, perhaps for another hearer (same hearing settings): the snapshot names the one now.
            if (next.kind === "ready") streamHearing = next
            continue
          }
          // §3.5: the new recogniser is ready (the pool binds it only then); switch at the next silence, waiting at
          // most `switchWaitMs` for an open utterance to end.
          const deadline = now() + switchWaitMs
          while (utteranceOpen && now() < deadline) yield* Effect.sleep(20)
          yield* Fiber.interrupt(fiber)
          streamKey = undefined
          streamHearing = undefined
          yield* closeOpenUtterance
          return
        }
      })

    let recogniserRuns = 0
    const recogniser: SessionLoop = {
      run: (built) =>
        Effect.gen(function*() {
          if (recogniserRuns++ > 0) {
            // A new build: an utterance the previous recogniser stream left open is closed (it starts nothing).
            utteranceOpen = false
            utteranceDropped()
            yield* dispatcher.dispatch(route.filter({ _tag: "EndOfTurn", text: "" }, now()))
          }
          failedId = undefined
          const builtStt = built.providers.stt
          const hearingNow = (): Hearing =>
            options.hearing?.() ?? (builtStt === undefined ? { kind: "none" } : { kind: "ready", id: "build", stt: builtStt, key: "build" })
          while (true) {
            const signal = changed
            const hearing = hearingNow()
            if (hearing.kind === "ready" && hearing.id !== failedId) {
              failedId = undefined
              yield* runStream(hearing, hearingNow)
              continue
            }
            // No recogniser (no assistant on the device, not bound yet, or failed): wait for a change.
            yield* Deferred.await(signal)
          }
        }).pipe(Effect.ensuring(Effect.sync(() => {
          streamKey = undefined
          streamHearing = undefined
        })))
    }
    let detach: Effect.Effect<void> | undefined

    const syncProfile = () => {
      hearingChanged()
      const settings = options.deviceSettings()
      gate.setMode(settings.interruptMode)
      const next = routeConfigNow()
      const key = routeKeyOf(next)
      if (key === routeKey) return
      routeKey = key
      // `configure` drops a held utterance: only when the routing part of the settings changed.
      route.configure(next)
      wakeChanged(Math.max(longestFollowUp(), armedMs()))
    }
    syncProfile()

    /**
     * Stop or a new conversation for `assistant` (`undefined`: every one) cancels the open utterance it has, and the
     * words it was handed: they reach no turn, so they hold the turn no longer.
     */
    const utteranceCancelled = (assistant: string | undefined) => {
      if (heardFor !== undefined && (assistant === undefined || heardFor === assistant)) {
        heardFor = undefined
        heardStopped = true
      }
      if (handedTo !== undefined && (assistant === undefined || handedTo === assistant)) handedTo = undefined
      holderCheck()
    }

    const conversations: SessionConversations = {
      sendText: (text, speak, named) =>
        Effect.suspend(() => {
          const w = route.window(now())
          const target = typedTextTarget(options.deviceSettings(), options.assistants(), {
            named,
            followUpHolder: w?.by === "follow-up" ? w.assistant : undefined
          })
          if ("dropped" in target) return Effect.succeed<TextOutcome>("dropped")
          return dispatcher.send(target.assistant, { _tag: "TextInput", text, speak })
        }),
      stop: (assistant) => {
        const outcome = dispatcher.stop(assistant)
        utteranceCancelled(assistant)
        return outcome
      },
      running: () => detach !== undefined && options.engine.ready(),
      history: (assistant) => conversationOf(assistant ?? answering())?.history ?? Effect.succeed([]),
      conversation: (assistant) => {
        const a = assistant ?? answering()
        return conversationOf(a)?.conversation() ?? reservedFor(a ?? "")
      },
      lastTurnAt: (assistant) => conversationOf(assistant ?? answering())?.lastTurnAt(),
      lastTurnId: (assistant) => conversationOf(assistant ?? answering())?.lastTurnId(),
      turnsOf: (assistant) => turnsBy.get(assistant ?? answering() ?? "") ?? 0,
      newConversation: (assistant) =>
        Effect.suspend(() => {
          const a = assistant ?? answering()
          const made = conversationOf(a)
          if (made !== undefined) {
            // Its conversation stops the open utterance; the dispatcher must not hand the rest to another one.
            dispatcher.cancelUtterance(a!)
            utteranceCancelled(a)
            return made.newConversation
          }
          return Effect.sync(() => {
            const info = fresh()
            reserved.set(a ?? "", info)
            turnsBy.set(a ?? "", 0)
            options.send({ type: "conversation", id: info.id, reason: "new", startedAt: info.startedAt, ...(a !== undefined ? { assistantId: a } : {}) })
            options.onChange(false)
            return info
          })
        }),
      answering,
      start: () => {
        if (started) return
        started = true
        detach = options.engine.attach(recogniser)
        for (const target of dispatcher.conversations().values()) target.conversation.start()
      },
      end: Effect.suspend(() => {
        const d = detach
        detach = undefined
        started = false
        return Effect.andThen(
          d ?? Effect.void,
          Effect.forEach([...dispatcher.conversations().values()], (t) => t.conversation.end, { discard: true })
        )
      }),
      dispatcher
    }

    return {
      key: options.key,
      deviceId: options.deviceId,
      name: options.name,
      web,
      tracker,
      publisher,
      gate,
      route,
      conversation: conversations,
      heard,
      syncProfile,
      hearingChanged,
      hearingKey: () => streamKey,
      ownerChanged: (present, micLive) => {
        owner = { present, micLive }
        if (present) touch()
        tracker.setOwner(present, present && micLive)
        options.onChange(true)
      },
      ownerPresent: () => owner.present,
      turns: () => turnsBy.get(answering() ?? "") ?? 0,
      lastActiveAt: () => lastActive,
      touch,
      holder: holderNow,
      pickAccepted: () => {
        route.release()
        wakeChanged()
      },
      info: (): SessionInfo => {
        const last = conversations.lastTurnAt()
        return {
          key: options.key,
          ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
          name: options.name().trim().slice(0, MAX_DEVICE_NAME_CHARS).trim() || "Voice page",
          state: tracker.current().state,
          ownerPresent: owner.present,
          conversationId: conversations.conversation().id,
          turns: turnsBy.get(answering() ?? "") ?? 0,
          lastTurnAt: last ?? null,
          ...(answering() !== undefined ? { answering: answering()! } : {}),
          conversations: [...dispatcher.conversations().entries()].map(([assistantId, target]) => ({
            assistantId,
            conversationId: target.conversation.conversation().id,
            turns: turnsBy.get(assistantId) ?? 0,
            lastTurnAt: target.conversation.lastTurnAt() ?? null
          }))
        }
      }
    } satisfies VoiceSession
  })
