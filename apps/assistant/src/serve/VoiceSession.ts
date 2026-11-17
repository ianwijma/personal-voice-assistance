import { makeWebAudio, type WebAudio } from "@pva/audio-web"
import {
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
  type SttEvent,
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
  type TraceInfo,
  type TraceRoute,
  typedTextTarget,
  WAKE_ARMED_MS
} from "@pva/protocol"
import { Effect, Queue, type Scope, Stream } from "effect"
import type { Engine, EngineProviders, SessionLoop } from "./Engine.ts"
import { type HeardAudio, makeHeardAudio } from "./HeardAudio.ts"
import { makeOutputLease } from "./OutputLease.ts"
import { makePublisher, type Publisher } from "./Publisher.ts"
import { makeSessionConversation, type SendOutcome, type SessionConversation } from "./SessionConversation.ts"
import { type DispatchRoute, type DispatchTarget, makeSessionDispatcher, type SessionDispatcher } from "./SessionDispatcher.ts"
import { makeStateTracker, type StateTracker } from "./StateTracker.ts"

/**
 * One device's voice session (docs/VOICE-SESSIONS.md §2, docs/ASSISTANTS.md §3.3): its own `WebAudio` (microphone in,
 * replies out, to the owner tab of this device), echo gate, route gate, state tracker, publisher, "save what it
 * hears" tap, and one conversation per assistant (each with its own history, id and idle clock), on the shared
 * engines. The device's effective settings (type defaults ← its own sections) decide its assistants, their phrases,
 * the without-phrase mode and the interrupt mode, read live (`syncProfile`); each assistant's prompt, modules,
 * follow-up, quiet spell and "reply early" are read from it at use.
 *
 * The audio path: the recogniser stream runs once per session per engine build (a `SessionLoop` of its own),
 * then the echo gate, the route gate and the session dispatcher, which feeds each assistant's conversation through
 * an inbox (`SessionConversation`'s `speech` seam). All conversations play through one output lease, so two replies
 * never sound at once. Who owns the audio (which tab of the device) is the hub's business: it calls
 * `web.setOwner` / `setMicLive` and `ownerChanged`.
 *
 * WP-4b scope: the language model, the recogniser and the voice are still the one shared build (the engine's);
 * per-assistant resources are the resource pool's (WP-9 onwards).
 */

export interface AssistantSetup {
  readonly setup: Effect.Effect<TurnSetup>
  readonly agentSetup?: (providers: EngineProviders) => Effect.Effect<AgentTurnSetup> | undefined
}

export interface VoiceSessionOptions {
  /** The session's key: the device id, or the client id of a voice connection without a device. */
  readonly key: string
  readonly deviceId?: string
  /** The device's name now (or a description of the connection without a device). */
  readonly name: () => string
  readonly engine: Engine
  /** The device's effective settings now (docs/ASSISTANTS.md §2.6). */
  readonly deviceSettings: () => DeviceSettings
  /** The assistants in effect now, by id. */
  readonly assistants: () => ReadonlyMap<string, Assistant>
  /** Per assistant: its turn setup (prompt, module instructions, its tools), and the agent setup (claude-subscription). */
  readonly conversationSetup: (assistant: string) => AssistantSetup
  /** The module that contributes a tool (module host snapshot). */
  readonly moduleOfTool: (name: string) => string | null
  /** The shared trace service (log line, recent list); this session numbers its own turns and sets `session`. */
  readonly turnTrace: TurnTrace["Service"]
  /** To every connection of this device. */
  readonly send: (message: ServerMessage) => void
  /** One final transcript, for the phrase tester (`wake.heard`). */
  readonly wakeHeard: (text: string, phrase: string | undefined, accepted: boolean) => void
  /** Something admin's `sessions` shows changed (state, a turn, the conversation). */
  readonly onChange: (minor: boolean) => void
  /** A committed turn ended (the recent traces of every session, for admin). */
  readonly onTrace?: (trace: TraceInfo) => void
  /** What one minute of `newConversationAfter` is, in ms (tests shorten it). Default 60 000. */
  readonly minuteMs?: number
  readonly maxPendingInputs?: number
  /** The conversation to start with (an id this device was given before its session existed): the answering assistant's. */
  readonly initialConversation?: { readonly id: string; readonly startedAt: number }
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
  /** Ownership on this device changed (the hub's view): the state follows it. */
  readonly ownerChanged: (present: boolean, micLive: boolean) => void
  readonly ownerPresent: () => boolean
  /** Committed turns in the answering assistant's current conversation. */
  readonly turns: () => number
  /** `performance.now()` of the last activity (a claim, a recognition event, a turn): "the most recently active". */
  readonly lastActiveAt: () => number
  readonly touch: () => void
  readonly info: () => SessionInfo
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
  }
): TurnTrace["Service"] =>
  TurnTrace.of({
    now: shared.now,
    begin: (mode, speculative = false) => {
      const session = fields.session()
      const assistant = fields.assistant?.()
      const route = fields.route?.()
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
        ...(route !== undefined ? { route } : {})
      }
      return trace
    },
    mark: (trace, mark) => {
      shared.mark(trace, mark)
      if (mark === "endOfTurn" && fields.route !== undefined) {
        const route = fields.route()
        if (route !== undefined) trace.route = route
      }
    },
    finish: shared.finish,
    recent: shared.recent
  })

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
    const tracker = makeStateTracker({
      onChange: (s) => {
        options.send({ type: "state", ...s })
        options.onChange(true)
      },
      asleep: () => route.config().withoutPhrase === "nobody" && !route.awake(now())
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => tracker.dispose()))

    /** The voice key this session speaks with ("" while the engines do not run). Shared build: one voice. */
    const voiceNow = (): string => {
      const voice = options.engine.voice()
      return voice === undefined ? "" : voiceKey(voice)
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
      onCommitted: (turnId) => tracker.turnPromoted(turnId),
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
          tracker.wakeChanged(followUpOf(assistant))
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
        // No TypeSafe yet (WP-14): a `decide` utterance is answered by the fallback, the device's default answerer.
        case "decide":
          return { by: "default" }
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

    const dispatcher = makeSessionDispatcher<Target>({
      replyEarly: (assistant) => assistantOf(assistant)?.replyEarly ?? true,
      make: (assistant, hooks) =>
        Effect.gen(function*() {
          const inbox = yield* Queue.unbounded<ConversationInput>()
          let runs = 0
          const { setup, agentSetup } = options.conversationSetup(assistant)
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
              route: () => traceRouteOf(assistant)
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
    const onStt = (event: SttEvent): Effect.Effect<void> =>
      Effect.suspend(() => {
        const t = now()
        if (event._tag !== "EndOfTurn") heard.event(event)
        const echo = gate.filter(event, t)
        const results: Array<RouteResult> = []
        let dropped = false
        for (const e of echo.events) {
          const r = route.filter(e, t)
          results.push(r)
          if (r.heard !== undefined) options.wakeHeard(r.heard.text, r.heard.phrase, r.heard.accepted)
          if (r.woke !== undefined) {
            if (r.woke.armed) armedPhrase.set(r.woke.assistant, r.woke.phrase)
            options.send({ type: "wake", phrase: r.woke.phrase, armed: r.woke.armed, assistantId: r.woke.assistant })
            tracker.wakeChanged(r.woke.armed ? armedMs() : followUpOf(r.woke.assistant))
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
                tracker.wakeChanged(followUpOf(target !== undefined && "assistant" in target ? target.assistant : undefined))
              }
            }
          }
        }
        if (event._tag === "EndOfTurn") {
          if (dropped) heard.discard()
          else heard.event(event)
        }
        if (echo.dropped) transcript("")
        return Effect.forEach(results, dispatcher.dispatch, { discard: true })
      })

    let recogniserRuns = 0
    const recogniser: SessionLoop = {
      run: (built) =>
        Effect.gen(function*() {
          if (recogniserRuns++ > 0) {
            // A new build: an utterance the previous recogniser stream left open is closed (it starts nothing).
            yield* dispatcher.dispatch(route.filter({ _tag: "EndOfTurn", text: "" }, now()))
          }
          yield* Stream.runForEach(built.providers.stt.transcribe(input), onStt)
        })
    }
    let detach: Effect.Effect<void> | undefined

    const syncProfile = () => {
      const settings = options.deviceSettings()
      gate.setMode(settings.interruptMode)
      const next = routeConfigNow()
      const key = routeKeyOf(next)
      if (key === routeKey) return
      routeKey = key
      // `configure` drops a held utterance: only when the routing part of the settings changed.
      route.configure(next)
      tracker.wakeChanged(Math.max(longestFollowUp(), armedMs()))
    }
    syncProfile()

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
      stop: (assistant) => dispatcher.stop(assistant),
      running: () => detach !== undefined && options.engine.ready(),
      history: (assistant) => conversationOf(assistant ?? answering())?.history ?? Effect.succeed([]),
      conversation: (assistant) => {
        const a = assistant ?? answering()
        return conversationOf(a)?.conversation() ?? reservedFor(a ?? "")
      },
      lastTurnAt: (assistant) => conversationOf(assistant ?? answering())?.lastTurnAt(),
      newConversation: (assistant) =>
        Effect.suspend(() => {
          const a = assistant ?? answering()
          const made = conversationOf(a)
          if (made !== undefined) {
            // Its conversation stops the open utterance; the dispatcher must not hand the rest to another one.
            dispatcher.cancelUtterance(a!)
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
          lastTurnAt: last ?? null
        }
      }
    } satisfies VoiceSession
  })
