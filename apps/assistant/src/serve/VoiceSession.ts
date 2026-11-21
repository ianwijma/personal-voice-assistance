import { makeWebAudio, type WebAudio } from "@pva/audio-web"
import {
  addTraceEvent,
  announcementChime,
  AudioError,
  chunkClauses,
  type AudioOutput,
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
  type ConnectionRef,
  type CommandSet,
  decideUtterance,
  type KeptReply,
  keptReplyText,
  makeCommandSlot,
  type NotifyEngine,
  type PhraseTrace,
  makeTurnContext,
  matchWakePhrase,
  type PhraseLanguage,
  type PhraseOutcome,
  type PhrasePorts,
  phraseText,
  type RingingCard,
  runTaken,
  type Taken,
  type TurnOrigin,
  type TurnPerson,
  type TurnSetup,
  TurnTrace,
  voiceKey
} from "@pva/core"
import {
  type Assistant,
  type ConversationInfo,
  type DeviceSettings,
  type DeviceTypeDefinition,
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
import { type ConversationEndReason, makeSessionConversation, type SendOutcome, type SessionConversation } from "./SessionConversation.ts"
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
   * The device's type now (docs/VOICE-NODES.md §4.1): its `followUpUnset` is the follow-up of an assignment without
   * its own (a voice node: 0, one answer per phrase). Absent: the assistant's own follow-up.
   */
  readonly deviceType?: () => Pick<DeviceTypeDefinition, "followUpUnset"> | undefined
  /**
   * P5: the room and person every turn here has (`CurrentTurn.room`, `.person`), read at each turn's start (a cache
   * read). Absent: neither.
   */
  readonly place?: () => { readonly room?: string; readonly person?: TurnPerson }
  /**
   * P5: whether replies may be spoken here now (the device's effective speaker), read at the start of every play and
   * before every chunk. Not at the start: the reply's audio is made and counted as played but never sent to the page;
   * no longer during a play: the rest of it is not sent (the hub checks again at every frame it sends). Absent: always.
   */
  readonly speakerAllowed?: () => boolean
  /**
   * The route gate's guard (`GateGuard`): true while something on the device makes every request need the wake phrase
   * (serve mode: the device's own page is playing media, `DevicePlayers.isPlaying`). Asked at each decision. Absent: never.
   */
  readonly guard?: () => boolean
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
  /** The connection that owns the device's audio now, for a voice turn's `CurrentTurn.connection`. */
  readonly audioConnection?: () => ConnectionRef | undefined
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
  /**
   * P7 (E7): a taken utterance's execution trace (`TraceInfo.phrase`: its principal, the gateway's admission and risk
   * outcome, timings, the outcome), published where turn traces are; it is no conversation turn and no history entry.
   */
  readonly onPhraseTrace?: (trace: TraceInfo) => void
  /**
   * One of its conversations ended (conversation-scoped household data is deleted): whose it was and the history it
   * held (a report's previous conversation, docs/REPORTS.md).
   */
  readonly conversationEnded?: (conversationId: string, ended: { readonly assistant: string; readonly history: ReadonlyArray<Message>; readonly reason: ConversationEndReason }) => void
  /** Whether an ended conversation's history is kept by anything now (`SessionConversationOptions.keepsEndedHistory`). */
  readonly keepsEndedHistory?: () => boolean
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
  /**
   * P7: phrase commands, the host's essential controls and the ringing window (docs/PHRASES.md). Absent: no utterance is
   * ever taken (every final goes through the gates as before).
   */
  readonly phrases?: SessionPhrases
}

/** What a voice session needs for phrase commands (serve mode supplies it; every member is read when it is used). */
export interface SessionPhrases {
  /** The household's language now. */
  readonly language: () => PhraseLanguage
  /** The commands of `assistant` now (`undefined`: the host's controls alone). Called at a final, on the turn path: cached. */
  readonly commandsFor: (assistant: string | undefined) => CommandSet
  /** What rings on the device now, or `undefined` when the window cannot open (no device, its "while ringing" is off). */
  readonly ringing: () => ReadonlyArray<RingingCard> | undefined
  /** The runner's ports that are not the session's own (`notify` with the announcement's stop). */
  readonly ports: Pick<PhrasePorts, "volume" | "playback" | "gateway" | "isPublished" | "pageText"> & {
    readonly notify: () => Pick<NotifyEngine, "ringingOn" | "stopRinging" | "press" | "stopSpeech"> | undefined
  }
  /** Every outcome (the log). Must not throw. */
  readonly onOutcome?: (outcome: PhraseOutcome) => void
}

/** How long the settlement waits for the end of the reply an utterance interrupted (the page's stop report), at most. */
export const INTERRUPTED_REPLY_WAIT_MS = 2_000
/** How long the settlement waits for one canned reply to end before it says the next, at most. */
export const CANNED_REPLY_WAIT_MS = 180_000

/** What typed text came to: `dropped` when nobody answers it on this device (its target is off, or there is none). */
export type TextOutcome = SendOutcome | "dropped"

/**
 * The session's conversations, one per assistant (made on first use), as the hub and `VoiceSessions` use them.
 * Without `assistant`, the methods mean the *answering* assistant: the one holding a follow-up window, else the one
 * that answers without a phrase, else the TypeSafe fallback, else the first in the device's list (§5.3).
 */
export interface SessionConversations {
  /** Typed text, routed as §2.6 "Typed text" says (`named`: the assistant the page names). */
  /** `connection`: the tab that typed it (the turn's `CurrentTurn.connection`). */
  readonly sendText: (text: string, speak: boolean, named?: string, connection?: ConnectionRef) => Effect.Effect<TextOutcome>
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
  /**
   * P7: the session's part of `SessionControl` (docs/PHRASES.md): stop the reply or announcement, cancel what is
   * pending, speak the last reply again. The host's spoken controls do exactly these.
   */
  readonly control: {
    readonly stopReply: Effect.Effect<boolean>
    readonly cancelPending: Effect.Effect<boolean>
    readonly repeatLast: Effect.Effect<boolean>
    /** The last spoken reply kept (tests, diagnostics). */
    readonly lastReply: () => KeptReply | undefined
  }
  /** P7: the session's one module action at a time (tests, diagnostics). */
  readonly phraseSlot: ReturnType<typeof makeCommandSlot>
  /**
   * P9: announcements on this device (docs/NOTIFICATIONS.md "Speech"). `speak` makes the answering assistant's voice
   * ready first (`TurnSetup.tts` and its `ttsReady`: the reply's synthesis), then waits until nothing is spoken or heard
   * here (no play holds the lease, no turn is in flight, no utterance is open in the recogniser, addressed or not, and
   * the state is not hearing, thinking or speaking) and, in the same step as it takes the output lease
   * (`playIfFree`), asks `gate` (the service's delivery decision) last: a reply that took the speaker meanwhile, or a
   * gate that says "wait", sends it back to waiting; another answer skips it. A reply that starts while it plays takes
   * the speaker (it fails `superseded`).
   */
  readonly announce: {
    readonly speak: (text: string, options: { readonly cue: boolean; readonly gate: () => string }) => Effect.Effect<"spoken" | { readonly skipped: string }, unknown>
    /** The reply id of the announcement playing now (the page's Stop names it), if one plays. */
    readonly playing: () => number | undefined
  }
}

/** The lease holder of announcements (never an assistant id: those are lower case letters, digits and `-`). */
export const ANNOUNCE_HOLDER = "@announcement"

/** How often `announce.quiet` looks again while it waits (the tracker's states change on events and on timers). */
const QUIET_POLL_MS = 200

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

/**
 * P5: `output` while `allowed()` says so: at the start of a play, and before each chunk (a play whose permission goes
 * mid-way ends there: the rest of the reply is not sent). Not allowed at the start: a play that takes the whole reply
 * and reports it as played (so the turn is recorded as answered) without sending any of it anywhere.
 */
export const silentUnless = (output: AudioOutput["Service"], allowed: () => boolean): AudioOutput["Service"] => ({
  ...(output.reportsPlayback !== undefined ? { reportsPlayback: output.reportsPlayback } : {}),
  play: (audio, sampleRate, observer) =>
    Effect.suspend(() => {
      const ok = () => {
        try {
          return allowed()
        } catch {
          return false
        }
      }
      if (ok()) return output.play(Stream.takeWhile(audio, () => ok()), sampleRate, observer)
      let samples = 0
      let started = false
      return Stream.runForEach(audio, (chunk) =>
        Effect.sync(() => {
          if (!started) {
            started = true
            observer?.started()
          }
          samples += Math.floor(chunk.byteLength / 2)
          observer?.progress(samples)
        })).pipe(Effect.ensuring(Effect.sync(() => observer?.final?.(samples))))
    })
})

export const makeVoiceSession = (options: VoiceSessionOptions): Effect.Effect<VoiceSession, never, Scope.Scope> =>
  Effect.gen(function*() {
    /** P7: a taken utterance's run lives here (interrupted when the session ends). */
    const sessionScope = yield* Effect.scope
    const now = () => performance.now()
    let lastActive = now()
    const touch = () => {
      lastActive = now()
    }
    let owner = { present: false, micLive: false }
    const minuteMs = options.minuteMs ?? 60_000

    const gate = makeEchoGate("instant")
    // After the echo gate, before the dispatcher; configured from this device's settings and the assistants.
    const routeConfigNow = (): RouteConfig => routeConfigFrom(options.deviceSettings(), options.assistants(), options.deviceType?.())
    const routeKeyOf = (config: RouteConfig) => JSON.stringify({ ...config, off: [...config.off].sort() })
    const route = makeRouteGate(routeConfigNow(), options.guard)
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
    /** Done when this session ends (`conversation.end`, or its scope closing): announcements on it end too. */
    const sessionEnded = Deferred.makeUnsafe<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => void Deferred.doneUnsafe(sessionEnded, Effect.void)))
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
    /** P7: turns that were committed (a speculative turn never promoted is no reply anyone heard), until they end. */
    const committedTurns = new Set<number>()
    /** P7: the device's last spoken reply, as far as it was prepared (`keptReplyText`), for "repeat". */
    let lastReply: (KeptReply & { readonly turnId: number; readonly interrupted: boolean }) | undefined
    /** P7: the replies that ended lately, by turn (the reply an utterance interrupted is found by its turn), at most 8. */
    const endedReplies = new Map<number, KeptReply & { readonly interrupted: boolean }>()
    /** P7: waiting for a reply's end, by turn (the settlement, while the page's stop report has not come). */
    const replyEndWaits = new Map<number, Deferred.Deferred<void>>()
    /** P7: canned replies a settlement waits for: the next canned turn of `assistant` after the send, and its end. */
    const cannedWatches: Array<{ readonly assistant: string; turnId: number | undefined; readonly done: Deferred.Deferred<"done" | "cut">; readonly quiet?: () => boolean }> = []
    /**
     * P7 (review round 2, b1): cancellations of every conversation and per assistant (Stop, "never mind", a new
     * conversation). A pending settlement compares them with what they were at its utterance's final: a reply cancelled
     * since is not said again, and its remaining lines open no follow-up window.
     */
    const cancellations = { all: 0, by: new Map<string, number>() }
    /** Settlements running now that will say an interrupted reply again (and whether it is still theirs to say). */
    const pendingResumes = new Set<{ readonly cancelled: () => boolean }>()
    const cancelledFor = (assistant: string | undefined) => {
      if (assistant === undefined) cancellations.all++
      else cancellations.by.set(assistant, (cancellations.by.get(assistant) ?? 0) + 1)
    }
    const keepReply = (assistant: string, turnId: number, texts: ReadonlyArray<string | undefined>, interrupted: boolean) => {
      const text = keptReplyText(texts)
      if (text === "") return
      lastReply = { assistant, text, turnId, interrupted }
      endedReplies.set(turnId, { assistant, text, interrupted })
      while (endedReplies.size > 8) endedReplies.delete(endedReplies.keys().next().value!)
    }
    const publisher = makePublisher({
      broadcast: send,
      onCommitted: (turnId) => {
        committedTurns.add(turnId)
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
          // P7: the device spoke while this utterance was heard: the ringing window does not take it (its own line).
          if (heardUtterance !== undefined) heardUtterance.audible = true
          if (assistant !== undefined && !noFollowUp.has(event.turnId)) route.replyStarted(assistant, now())
          if (unsuppress !== undefined) clearTimeout(unsuppress)
          if (options.deviceSettings().interruptMode === "manual") web.setSuppressed(true)
        } else {
          tracker.playbackEnded(event.turnId, event.reason)
          gate.playbackEnded(now())
          // P7: a reply "never mind" cancelled opens no follow-up window when its end is reported, late or not (E8).
          if (noFollowUp.delete(event.turnId)) wakeChanged()
          else {
            if (assistant !== undefined) route.replyEnded(assistant, now())
            wakeChanged(followUpOf(assistant))
          }
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
    // One speaker for every conversation of the session (docs/ASSISTANTS.md §1.2); silent where the device may not speak.
    const lease = makeOutputLease(options.speakerAllowed === undefined ? web.output : silentUnless(web.output, options.speakerAllowed))

    // Clause texts per turn, so the echo gate knows the words that just played (turn ids are unique per session).
    const clauses = new Map<number, { texts: Array<string>; given: number }>()
    const onEvent = (assistant: string, event: ConversationEvent) => {
      publisher.onEvent(event, assistant)
      switch (event._tag) {
        case "TurnStarted":
          // P7: the canned reply a settlement sent (the first canned turn of that assistant after it).
          // (A `Say` starts a text turn with no words; single-model conversations do not mark it `canned`.)
          if (event.text === "" && event.source === "text" && !event.speculative) {
            const watch = cannedWatches.find((w) => w.assistant === assistant && w.turnId === undefined)
            if (watch !== undefined) {
              watch.turnId = event.turnId
              // A line of a settlement whose reply was cancelled meanwhile: no follow-up window when it ends (b1).
              if (watch.quiet?.() === true) {
                noFollowUp.add(event.turnId)
                while (noFollowUp.size > 16) noFollowUp.delete(noFollowUp.values().next().value!)
              }
            }
          }
          touch()
          // Committed turns reach the tracker through the publisher's onCommitted, right after turn.start.
          if (event.speculative) tracker.turnStarted(event.turnId, true)
          return
        case "TurnEnded": {
          const entry = clauses.get(event.turnId)
          if (entry !== undefined && committedTurns.has(event.turnId)) keepReply(assistant, event.turnId, entry.texts, event.outcome === "interrupted")
          committedTurns.delete(event.turnId)
          clauses.delete(event.turnId)
          if (inFlight === event.turnId) inFlight = undefined
          const waiting = replyEndWaits.get(event.turnId)
          if (waiting !== undefined) {
            replyEndWaits.delete(event.turnId)
            Deferred.doneUnsafe(waiting, Effect.void)
          }
          const at = cannedWatches.findIndex((w) => w.turnId === event.turnId)
          if (at >= 0) {
            const [watch] = cannedWatches.splice(at, 1)
            Deferred.doneUnsafe(watch!.done, Effect.succeed(event.outcome === "completed" ? "done" as const : "cut" as const))
          }
          return tracker.turnEnded(event.turnId)
        }
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
          const made = options.conversationSetup(assistant, options.deviceId)
          const { config: assistantConfig } = made
          // Module API v2 (`CurrentTurn`): every turn's setup names who and where it is for. The origin object is the
          // same while the device's name is, so a turn adds one small object (the setup with it), nothing else.
          // A voice turn's connection is the tab that owns the device's audio as the turn starts; a typed turn names
          // the tab that typed it (`TextInput.connection`, which wins).
          let origin: TurnOrigin | undefined
          const originNow = (): TurnOrigin => {
            const deviceName = options.name()
            const connection = options.audioConnection?.()
            // P5: the device's room and default person (`how: "device-default"`), from the device's place.
            const place = options.place?.()
            if (
              origin?.deviceName !== deviceName || origin.connection !== connection || origin.room !== place?.room ||
              origin.person?.id !== place?.person?.id
            ) {
              origin = {
                assistantId: assistant,
                ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
                deviceName,
                ...(connection !== undefined ? { connection } : {}),
                ...(place?.room !== undefined ? { room: place.room } : {}),
                ...(place?.person !== undefined ? { person: place.person } : {})
              }
            }
            return origin
          }
          const withOrigin = <S extends TurnSetup>(s: S): S => ({ ...s, turnContext: originNow() })
          const setup = Effect.map(made.setup, withOrigin)
          const agentSetup = made.agentSetup === undefined ? undefined : () => {
            const a = made.agentSetup!()
            return a === undefined ? undefined : Effect.map(a, withOrigin)
          }
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
            ...(options.conversationEnded !== undefined ? { onConversationEnded: (id: string, history: ReadonlyArray<Message>, reason: ConversationEndReason) => options.conversationEnded?.(id, { assistant, history, reason }) } : {}),
            ...(options.keepsEndedHistory !== undefined ? { keepsEndedHistory: options.keepsEndedHistory } : {}),
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
     * P7: the utterance being heard (from its `SpeechStarted` to its final), as the one decision needs it: whether the
     * device was audible at any moment of it (a reply or an announcement playing, or its echo tail: the ringing window
     * then does not take it, since its own spoken line may be what was heard), whether a reply was being prepared or
     * spoken as it began (what "stop" stops), and the reply that was playing then (said again after "louder").
     */
    let heardUtterance: { audible: boolean; cancelled: boolean; readonly active: boolean; readonly replyTurn: number | undefined } | undefined
    /** A reply is being prepared or spoken here now (an announcement is not a reply). */
    const replyActiveNow = () => {
      const holder = lease.holder()
      const state = tracker.current().state
      return inFlight !== undefined || (holder !== undefined && holder !== ANNOUNCE_HOLDER) || state === "thinking" || (state === "speaking" && holder !== ANNOUNCE_HOLDER)
    }
    const watchUtterance = (event: SttEvent, t: number) => {
      if (event._tag === "SpeechStarted" && heardUtterance === undefined) {
        const holder = lease.holder()
        heardUtterance = {
          audible: gate.audible(t),
          cancelled: false,
          active: replyActiveNow(),
          replyTurn: holder !== undefined && holder !== ANNOUNCE_HOLDER ? web.playingTurn() : undefined
        }
      } else if (heardUtterance !== undefined && gate.audible(t)) heardUtterance.audible = true
    }

    /**
     * Only what passed both gates is shown (transcript), moves the state or reaches a conversation: an utterance the
     * route gate drops reaches no page, no history, no agent and no recording (`heard.discard`); its text goes only
     * to admin pages with the phrase tester on (`wake.heard`). P7: an utterance's final goes through the one decision
     * (`decideUtterance`, docs/PHRASES.md), which runs the gates on it once; a taken utterance's final reaches them, or
     * the dispatcher, with no words, and what took it runs after it is dispatched.
     */
    /**
     * Stamp the recogniser's events where they enter the session: as they arrive, ahead of the buffer that `onStt`'s
     * serial dispatch drains, before any gate or a pending routing call can hold them back. `onStt` awaits dispatch (a
     * TypeSafe call may take a while), so the stamp runs on the producer side of an unbounded buffer, in its own fiber
     * in the stream's scope: same order (one FIFO), a failure or end after the events before it, interrupted with the
     * stream. The recognisers already push into an unbounded queue (`Stream.callback`), so the buffer takes no
     * backpressure away from them. The open utterance's times (`UtteranceTimes`, shared by its events) belong to that
     * one stream: the producer touches nothing else of the session, and a replacement stream (a switch, a failure, a
     * new build) starts with none, whatever the old one had stamped but not yet delivered.
     */
    const stamped = <E>(events: Stream.Stream<SttEvent, E>): Stream.Stream<SttEvent, E> =>
      Stream.suspend(() => {
        let utterance: UtteranceTimes | undefined
        const stamp = (event: SttEvent): SttEvent => {
          switch (event._tag) {
            case "SpeechStarted":
              if (utterance === undefined) utterance = { startedAt: options.turnTrace.now() }
              return event.heard === utterance ? event : { ...event, heard: utterance }
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
          }
        }
        return events.pipe(Stream.map(stamp), Stream.buffer({ capacity: "unbounded" }))
      })
    const onStt = (event: SttEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        const t = now()
        if (event._tag !== "EndOfTurn") heard.event(event)
        watchUtterance(event, t)
        let echoes: ReadonlyArray<SttEvent> = []
        let echoDropped = false
        const gates = (e: SttEvent): ReadonlyArray<RouteResult> => {
          const echo = gate.filter(e, t)
          echoDropped = echo.dropped
          echoes = echo.events
          return echoes.map((x) => route.filter(x, t))
        }
        let results: ReadonlyArray<RouteResult>
        let taken: { readonly taken: Taken; readonly utterance: NonNullable<typeof heardUtterance> } | undefined
        const phrases = options.phrases
        const utterance = event._tag === "EndOfTurn" ? heardUtterance ?? { audible: gate.audible(t), cancelled: false, active: false, replyTurn: undefined } : undefined
        if (event._tag === "EndOfTurn") heardUtterance = undefined
        if (event._tag === "EndOfTurn" && phrases !== undefined && utterance !== undefined) {
          const decision = decideUtterance({
            final: event,
            // E5: Stop or a new conversation between its first events and its final: nothing takes it.
            cancelled: utterance.cancelled,
            language: phrases.language(),
            ringing: utterance.audible || gate.audible(t) ? undefined : phrases.ringing(),
            wakeAtStart: (text) => matchWakePhrase(text, route.config().phrases.map((p) => p.phrase), route.config().match) !== undefined,
            gates,
            commandsFor: phrases.commandsFor
          })
          results = decision.results
          if (decision.taken !== undefined) taken = { taken: decision.taken, utterance }
        } else results = gates(event)
        // Review round 2, b2: an utterance stopped (the page's Stop, a new conversation) before its final reaches the
        // dispatcher with no words, with or without phrases: the conversation may not have opened it yet when the stop
        // came (speech and stops travel on separate queues), and a final with words would then start a turn. A final
        // with no words is what a taken utterance sends: never a turn, nothing in the history.
        if (utterance?.cancelled === true) {
          results = results.map((r) => ({ ...r, events: r.events.map((e): SttEvent => (e._tag === "EndOfTurn" && e.text !== "" ? { _tag: "EndOfTurn", text: "" } : e)) }))
        }
        let dropped = false
        results.forEach((r, i) => {
          const e = echoes[i]!
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
        })
        if (event._tag === "EndOfTurn") {
          if (dropped && taken === undefined) heard.discard()
          else heard.event(event)
        }
        if (echoDropped) transcript("")
        // A phrase inside the utterance may have changed who has the turn while the state stayed `hearing`.
        holderCheck()
        const dispatched = Effect.forEach(results, dispatcher.dispatch, { discard: true })
        return taken === undefined ? dispatched : Effect.andThen(dispatched, runPhrase(taken.taken, taken.utterance))
      })

    /** P7: one module action at a time on the device (the host's controls and the ringing "stop" are never refused as busy). */
    const phraseSlot = makeCommandSlot()
    /** P7: replies "never mind" cancelled: their end opens no follow-up window (by the reply's turn), at most 16. */
    const noFollowUp = new Set<number>()
    /**
     * Speak `text` as a canned reply of `assistant` (the answering one when absent) and wait until it ended (bounded):
     * `cut` when it did not play to its end (something cut it short, or it could not be sent).
     */
    const sayLine = (assistant: string | undefined, text: string, quiet?: () => boolean): Effect.Effect<"done" | "cut"> =>
      Effect.suspend(() => {
        const a = assistant ?? answering()
        if (a === undefined || text.trim().length === 0) return Effect.succeed("done" as const)
        const watch = { assistant: a, turnId: undefined as number | undefined, done: Deferred.makeUnsafe<"done" | "cut">(), ...(quiet !== undefined ? { quiet } : {}) }
        cannedWatches.push(watch)
        const forget = Effect.sync(() => {
          const i = cannedWatches.indexOf(watch)
          if (i >= 0) cannedWatches.splice(i, 1)
        })
        return Effect.flatMap(dispatcher.send(a, { _tag: "Say", text }), (outcome) =>
          outcome !== "accepted"
            ? Effect.as(forget, "cut" as const)
            : Deferred.await(watch.done).pipe(
              Effect.timeoutOrElse({ duration: CANNED_REPLY_WAIT_MS, orElse: () => Effect.succeed("cut" as const) }),
              Effect.ensuring(forget)
            ))
      })
    /** The reply turn `turnId` once its end is recorded, waiting for it (bounded) while it runs; `undefined`: it played to its end, or is unknown. */
    const interruptedReplyOf = (turnId: number | undefined): Effect.Effect<KeptReply | undefined> =>
      Effect.suspend(() => {
        if (turnId === undefined) return Effect.succeed(undefined)
        const read = () => {
          const r = endedReplies.get(turnId)
          return r !== undefined && r.interrupted ? { assistant: r.assistant, text: r.text } : undefined
        }
        if (endedReplies.has(turnId) || (!committedTurns.has(turnId) && !clauses.has(turnId))) return Effect.succeed(read())
        let waiting = replyEndWaits.get(turnId)
        if (waiting === undefined) {
          waiting = Deferred.makeUnsafe<void>()
          replyEndWaits.set(turnId, waiting)
        }
        return Deferred.await(waiting).pipe(
          Effect.timeoutOrElse({ duration: INTERRUPTED_REPLY_WAIT_MS, orElse: () => Effect.void }),
          Effect.map(read)
        )
      })
    const phraseTurn = (assistant: string) => {
      const place = options.place?.()
      const connection = options.audioConnection?.()
      return makeTurnContext({ turnId: counter.next++, conversationId: conversations.conversation(assistant).id, source: "phrase" }, {
        assistantId: assistant,
        ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
        deviceName: options.name(),
        ...(connection !== undefined ? { connection } : {}),
        ...(place?.room !== undefined ? { room: place.room } : {}),
        ...(place?.person !== undefined ? { person: place.person } : {})
      })
    }
    /** E7: a taken utterance's execution trace, published where turn traces are, without a conversation turn. */
    const publishPhraseTrace = (t: PhraseTrace) => {
      const assistantId = t.turn?.assistantId
      const a = assistantId === undefined ? undefined : assistantOf(assistantId)
      const failed = t.did === "failed" || t.did === "refused" || t.did === "not-running" || t.did === "busy"
      const info: TraceInfo = {
        turnId: t.turn?.turnId ?? counter.next++,
        mode: "voice",
        speculative: false,
        outcome: failed ? "failed" : "completed",
        marks: {},
        totalMs: Math.round(t.totalMs * 10) / 10,
        tools: t.tool !== undefined ? [{ name: t.tool, ms: Math.max(0, Math.round(t.actionMs ?? 0)) }] : [],
        voices: [],
        session: options.name().slice(0, 64),
        ...(assistantId !== undefined ? { assistant: { id: assistantId, name: a?.name ?? assistantId } } : {}),
        ...(options.deviceId !== undefined ? { deviceId: options.deviceId, device: options.name() } : {}),
        phrase: {
          by: t.by,
          name: t.name.slice(0, 120),
          did: t.did,
          ...(t.why !== undefined ? { why: t.why.slice(0, 300) } : {}),
          ...(t.risk !== undefined ? { risk: t.risk } : {}),
          ...(t.refused !== undefined ? { refused: t.refused.slice(0, 300) } : {}),
          ...(t.decision !== undefined ? { decision: { outcome: t.decision.outcome, by: t.decision.by.slice(0, 20) } } : {}),
          ...(t.turn?.person !== undefined ? { person: t.turn.person.id.slice(0, 64) } : {}),
          ...(t.actionMs !== undefined ? { actionMs: Math.max(0, Math.round(t.actionMs * 10) / 10) } : {}),
          ...(t.presented === true ? { presented: true } : {})
        }
      }
      options.onPhraseTrace?.(info)
    }
    /** Run what took an utterance, in the session's scope (the recogniser loop does not wait for it). */
    const runPhrase = (taken: Taken, utterance: { readonly active: boolean; readonly replyTurn: number | undefined }): Effect.Effect<void> =>
      Effect.suspend(() => {
        const phrases = options.phrases!
        const report = (outcome: PhraseOutcome) => {
          try {
            phrases.onOutcome?.(outcome)
          } catch {
            // A throwing observer must not break the session.
          }
        }
        const notify = phrases.ports.notify
        // b1: the cancellations as they are at the final; the interrupted reply's assistant, when the session knows it.
        const replyAssistant = utterance.replyTurn === undefined ? undefined : assistantOfTurn(utterance.replyTurn)
        const atFinal = { all: cancellations.all, by: new Map(cancellations.by) }
        const changedFor = (a: string) => (cancellations.by.get(a) ?? 0) !== (atFinal.by.get(a) ?? 0)
        const replyCancelled = () =>
          cancellations.all !== atFinal.all || (replyAssistant !== undefined ? changedFor(replyAssistant) : [...cancellations.by.keys()].some(changedFor))
        // A reply another pending settlement will say again is the device's reply still to come: "stop" selects it.
        const mine = { cancelled: replyCancelled }
        const otherResumes = () => [...pendingResumes].some((p) => p !== mine && !p.cancelled())
        const ports: PhrasePorts = {
          ...phrases.ports,
          deviceId: options.deviceId,
          language: phrases.language,
          slot: phraseSlot,
          session: {
            replyActive: () => utterance.active || replyActiveNow() || otherResumes(),
            announcementActive: () => lease.holder() === ANNOUNCE_HOLDER,
            stopReply: Effect.sync(() => {
              const was = replyActiveNow() || utterance.active
              conversations.stop()
              return was
            }),
            stopAnnouncement: Effect.suspend(() => {
              const n = notify()
              return options.deviceId === undefined || n === undefined ? Effect.succeed(false) : n.stopSpeech(options.deviceId)
            }),
            cancelPending: cancelPendingFor(utterance.replyTurn),
            lastReply: () => lastReply,
            interruptedReply: interruptedReplyOf(utterance.replyTurn),
            replyCancelled,
            answering,
            say: (assistant, text) => sayLine(assistant, text, replyCancelled)
          },
          turn: phraseTurn,
          trace: publishPhraseTrace
        }
        if (utterance.replyTurn !== undefined) pendingResumes.add(mine)
        return Effect.asVoid(Effect.forkIn(
          runTaken(taken, ports).pipe(Effect.tap((outcome) => Effect.sync(() => report(outcome))), Effect.ensuring(Effect.sync(() => void pendingResumes.delete(mine)))),
          sessionScope
        ))
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
      heardUtterance = undefined
      heardFor = undefined
      heardStopped = false
      handedTo = undefined
      holderCheck()
    }

    /**
     * After the route gate was flushed: an utterance the dispatcher still has open is closed there directly (it starts
     * nothing). That happens when the stream or loop was stopped while a final was still being dispatched (a TypeSafe
     * call): the route gate had closed that utterance already, so its flush forwards nothing, and the dispatcher would
     * treat the next `SpeechStarted` as a repeat and hand the next utterance this one's start and times. Only called
     * once the recogniser loop that delivered the utterance has ended (no turn of it is being delivered); with nothing
     * open it does nothing.
     */
    const closeDispatcherUtterance = Effect.suspend(() => {
      if (!dispatcher.hasOpen()) return Effect.void
      utteranceDropped()
      return dispatcher.dispatch({ events: [{ _tag: "EndOfTurn", text: "" }] })
    })

    /** Closes an utterance the previous stream left open (it starts nothing). */
    const closeOpenUtterance = Effect.suspend(() => {
      if (!utteranceOpen) return closeDispatcherUtterance
      utteranceOpen = false
      utteranceDropped()
      heard.discard()
      return Effect.andThen(dispatcher.dispatch(route.filter({ _tag: "EndOfTurn", text: "" }, now())), closeDispatcherUtterance)
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
        const fiber = yield* Effect.forkChild(Effect.exit(Stream.runForEach(stamped(hearing.stt.transcribe(input)), (event) =>
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
            // The previous run was interrupted (the engine stops every loop before a new build starts them).
            yield* closeDispatcherUtterance
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
      // E5: the utterance being heard is cancelled for the one decision too (nothing takes it at its final).
      if (heardUtterance !== undefined && (assistant === undefined || heardFor === assistant || (heardFor === undefined && dispatcher.delivering() === assistant))) {
        heardUtterance.cancelled = true
      }
      if (heardFor !== undefined && (assistant === undefined || heardFor === assistant)) {
        heardFor = undefined
        heardStopped = true
      }
      if (handedTo !== undefined && (assistant === undefined || handedTo === assistant)) handedTo = undefined
      holderCheck()
    }

    const newConversationOf = (assistant: string | undefined): Effect.Effect<ConversationInfo> =>
      Effect.suspend(() => {
        const a = assistant ?? answering()
        const made = conversationOf(a)
        cancelledFor(a)
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
      })

    /**
     * E8: cancel what is pending: the reply being prepared or spoken (every conversation stopped) and the armed and
     * follow-up windows, and keep the cancelled replies (`turn`, the reply an utterance interrupted, and the one playing or
     * in flight now) from opening a follow-up window when their end is reported later. A later reply opens its own.
     */
    const cancelPendingFor = (turn: number | undefined): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const holder = lease.holder()
        const playing = holder !== undefined && holder !== ANNOUNCE_HOLDER ? web.playingTurn() : undefined
        const was = turn !== undefined || replyActiveNow() || route.window(now()) !== undefined
        for (const t of [turn, inFlight, playing]) if (t !== undefined) noFollowUp.add(t)
        while (noFollowUp.size > 16) noFollowUp.delete(noFollowUp.values().next().value!)
        conversations.stop()
        route.cancelReply()
        wakeChanged()
        return was
      })
    /** P7: the session's part of `SessionControl` (and what the spoken controls do). */
    const control: VoiceSession["control"] = {
      stopReply: Effect.suspend(() => {
        const was = replyActiveNow()
        conversations.stop()
        const notify = options.phrases?.ports.notify()
        const speech = options.deviceId === undefined || notify === undefined ? Effect.succeed(false) : notify.stopSpeech(options.deviceId)
        return Effect.map(speech, (stopped) => was || stopped)
      }),
      cancelPending: Effect.suspend(() => cancelPendingFor(undefined)),
      repeatLast: Effect.suspend(() => {
        const last = lastReply
        return last === undefined ? Effect.succeed(false) : Effect.as(Effect.forkIn(sayLine(last.assistant, last.text), sessionScope), true)
      }),
      lastReply: () => lastReply
    }

    const conversations: SessionConversations = {
      sendText: (text, speak, named, connection) =>
        Effect.suspend(() => {
          const w = route.window(now())
          const target = typedTextTarget(options.deviceSettings(), options.assistants(), {
            named,
            followUpHolder: w?.by === "follow-up" ? w.assistant : undefined
          })
          if ("dropped" in target) return Effect.succeed<TextOutcome>("dropped")
          return dispatcher.send(target.assistant, { _tag: "TextInput", text, speak, ...(connection !== undefined ? { connection } : {}) })
        }),
      stop: (assistant) => {
        const outcome = dispatcher.stop(assistant)
        cancelledFor(assistant)
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
      newConversation: newConversationOf,
      answering,
      start: () => {
        if (started) return
        started = true
        detach = options.engine.attach(recogniser)
        for (const target of dispatcher.conversations().values()) target.conversation.start()
      },
      end: Effect.suspend(() => {
        // An announcement in progress belongs to this session: it ends with it.
        Deferred.doneUnsafe(sessionEnded, Effect.void)
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

    /**
     * Nothing is spoken or heard here: no play holds the lease, no turn is in flight, no utterance is open in the
     * recogniser (routed to an assistant or not), and the state is not hearing, thinking or speaking.
     */
    const isQuiet = () => {
      const state = tracker.current().state
      return lease.holder() === undefined && inFlight === undefined && !utteranceOpen && (state === "idle" || state === "listening" || state === "asleep")
    }
    const sessionOver = () => new AudioError({ message: "the voice session ended" })
    const announce: VoiceSession["announce"] = {
      // Bound to this session's lifetime: when it ends (the device claimed by another page, its boundary changed, it
      // left), the waits (voice readiness, quiet) and any playing are cancelled and the announcement fails, so the
      // device's queue moves on with the session that follows.
      speak: (text, o) =>
        Deferred.isDoneUnsafe(sessionEnded) ? Effect.fail(sessionOver()) : Effect.raceFirst(Effect.gen(function*() {
          // The voice first: everything after this is a wait for quiet, then the last checks as the output is taken.
          const assistant = answering()
          const setup = assistant === undefined ? undefined : yield* options.conversationSetup(assistant, options.deviceId).setup
          const tts = setup?.tts ?? options.engine.built()?.providers.tts
          if (tts === undefined) return yield* new AudioError({ message: "no voice on this device" })
          if (setup?.ttsReady !== undefined) yield* setup.ttsReady
          for (;;) {
            while (!isQuiet()) yield* Effect.sleep(QUIET_POLL_MS)
            // The reply's synthesis: the line cut into clauses, synthesised as it plays.
            // An empty line is a chime alone (`say("", { cue: true })`): nothing is synthesised.
            const voice = text.trim() === "" ? Stream.empty : tts.synthesize(Stream.make(text).pipe(chunkClauses())).pipe(Stream.map((chunk) => chunk.audio))
            const audio = o.cue ? Stream.concat(Stream.make(announcementChime(tts.sampleRate)), voice) : voice
            const how = yield* lease.playIfFree(ANNOUNCE_HOLDER, audio, tts.sampleRate, () => (isQuiet() ? o.gate() : "wait"))
            if (how === "played") return "spoken" as const
            if (how.notStarted === "busy" || how.notStarted === "wait") continue
            return { skipped: how.notStarted }
          }
        }), Effect.andThen(Deferred.await(sessionEnded), Effect.fail(sessionOver()))),
      playing: () => (lease.holder() === ANNOUNCE_HOLDER ? web.playingTurn() : undefined)
    }

    return {
      announce,
      control,
      phraseSlot,
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
