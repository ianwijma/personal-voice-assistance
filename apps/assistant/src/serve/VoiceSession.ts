import { makeWebAudio, type WebAudio } from "@pva/audio-web"
import {
  type AgentTurnSetup,
  type ConversationEvent,
  ECHO_TAIL_MS,
  type EchoGate,
  makeEchoGate,
  makeWakeGate,
  type SttEvent,
  type TurnSetup,
  TurnTrace,
  type Voice,
  type WakeConfig,
  wakeConfigFromProfile
} from "@pva/core"
import { type DeviceProfile, MAX_DEVICE_NAME_CHARS, type ServerMessage, type SessionInfo, type TraceInfo, WAKE_ARMED_MS } from "@pva/protocol"
import { Effect, type Scope, Stream } from "effect"
import type { Engine, EngineProviders } from "./Engine.ts"
import { type HeardAudio, makeHeardAudio } from "./HeardAudio.ts"
import { makePublisher, type Publisher } from "./Publisher.ts"
import { makeSessionConversation, type SessionConversation } from "./SessionConversation.ts"
import { makeStateTracker, type StateTracker } from "./StateTracker.ts"

/**
 * One device's voice session (docs/VOICE-SESSIONS.md §2): what serve mode used to wire once for the whole server,
 * wired per device. Its own `WebAudio` (microphone in, replies out, to the owner tab of this device), echo gate,
 * wake gate, state tracker, publisher, "save what it hears" tap, typed-input admission and `Conversation` (with its
 * own history), on the shared engines. Configured from its device profile (echo-gate mode, wake config, default
 * voice, idle reset), read live. Who owns the audio (which tab of the device) is the hub's business: it calls
 * `web.setOwner` / `setMicLive` and `ownerChanged`.
 */

/** The enabled voices and a default voice. */
export interface VoicesNow {
  readonly names: ReadonlyArray<Voice>
  readonly defaultVoice: string
}

export interface VoiceSessionOptions {
  /** The session's key: the device id, or the client id of a voice connection without a device. */
  readonly key: string
  readonly deviceId?: string
  /** The device's name now (or a description of the connection without a device). */
  readonly name: () => string
  readonly engine: Engine
  /** The device's effective profile now. */
  readonly profile: () => DeviceProfile
  /** The assistant's default voice (`DEFAULT_VOICE`) and the enabled voices, for a profile with `voice: ""`. */
  readonly assistantDefaultVoice: () => string
  readonly enabledVoices: () => ReadonlySet<string>
  /** Per session: the turn setup, and the agent setup (claude-subscription), given this session's voices. */
  readonly conversationSetup: (voices: () => VoicesNow | undefined) => {
    readonly setup: Effect.Effect<TurnSetup>
    readonly agentSetup?: (providers: EngineProviders) => Effect.Effect<AgentTurnSetup> | undefined
  }
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
  /** What one minute of `conversationIdleMinutes` is, in ms (tests shorten it). Default 60 000. */
  readonly minuteMs?: number
  readonly maxPendingInputs?: number
  /** The conversation to start with (an id this device was given before its session existed). */
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

export interface VoiceSession {
  readonly key: string
  readonly deviceId: string | undefined
  readonly name: () => string
  readonly web: WebAudio
  readonly tracker: StateTracker
  readonly publisher: Publisher
  readonly gate: EchoGate
  readonly conversation: SessionConversation
  readonly heard: HeardAudio
  /** The device's profile may have changed: apply the echo-gate mode and the wake config (only when changed). */
  readonly syncProfile: () => void
  /** Ownership on this device changed (the hub's view): the state follows it. */
  readonly ownerChanged: (present: boolean, micLive: boolean) => void
  readonly ownerPresent: () => boolean
  /** Committed turns in the current conversation. */
  readonly turns: () => number
  /** `performance.now()` of the last activity (a claim, a recognition event, a turn): "the most recently active". */
  readonly lastActiveAt: () => number
  readonly touch: () => void
  readonly info: () => SessionInfo
}

/** A per-session trace service: its own turn ids (from 1), `session` = the device name, the shared log and list. */
export const sessionTurnTrace = (shared: TurnTrace["Service"], name: () => string): TurnTrace["Service"] => {
  let nextId = 1
  return TurnTrace.of({
    now: shared.now,
    begin: (mode, speculative = false) => ({
      id: nextId++,
      mode,
      speculative,
      startedAt: shared.now(),
      marks: {},
      tools: [],
      voices: [],
      session: name()
    }),
    mark: shared.mark,
    finish: shared.finish,
    recent: shared.recent
  })
}

export const makeVoiceSession = (options: VoiceSessionOptions): Effect.Effect<VoiceSession, never, Scope.Scope> =>
  Effect.gen(function*() {
    const now = () => performance.now()
    let lastActive = now()
    const touch = () => {
      lastActive = now()
    }
    let turns = 0
    let owner = { present: false, micLive: false }

    const gate = makeEchoGate("instant")
    // After the echo gate, before Conversation; configured from this device's profile.
    const wake = makeWakeGate(wakeConfigFromProfile(options.profile()))
    let wakeKey = JSON.stringify(wake.config())
    const tracker = makeStateTracker({
      onChange: (s) => {
        options.send({ type: "state", ...s })
        options.onChange(true)
      },
      asleep: () => wake.config().activation === "wake-phrase" && !wake.awake(now())
    })
    yield* Effect.addFinalizer(() => Effect.sync(() => tracker.dispose()))

    /** This session's default voice: its profile's (when enabled), else the assistant's. */
    const defaultVoice = () => {
      const own = options.profile().voice
      return own !== "" && options.enabledVoices().has(own) ? own : options.assistantDefaultVoice()
    }
    let conversation: SessionConversation | undefined
    const voicesNow = (): VoicesNow | undefined => conversation?.voices()

    const send = (message: ServerMessage) => {
      if (message.type === "turn.end") {
        turns++
        touch()
        options.onChange(false)
      }
      options.send(message)
    }
    const publisher = makePublisher({
      broadcast: send,
      onCommitted: (turnId) => tracker.turnPromoted(turnId),
      moduleOfTool: options.moduleOfTool,
      voices: () => {
        const v = voicesNow()
        return { defaultVoice: v?.defaultVoice ?? defaultVoice(), names: new Set(v?.names.map((x) => x.name) ?? []) }
      },
      ...(options.onTrace !== undefined ? { onTrace: options.onTrace } : {})
    })

    // Manual interrupt mode: the microphone is replaced by silence while the assistant is audible (plus the reverb tail).
    let unsuppress: ReturnType<typeof setTimeout> | undefined
    const web: WebAudio = yield* makeWebAudio({
      ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
      log: options.log,
      onPlayback: (event) => {
        if (event._tag === "started") {
          tracker.playbackStarted(event.turnId)
          gate.playbackStarted(now())
          wake.replyStarted(now())
          if (unsuppress !== undefined) clearTimeout(unsuppress)
          if (options.profile().interruptMode === "manual") web.setSuppressed(true)
        } else {
          tracker.playbackEnded(event.turnId, event.reason)
          gate.playbackEnded(now())
          wake.replyEnded(now())
          tracker.wakeChanged(wake.config().followUpMs)
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

    // Clause texts per turn, so the echo gate knows the words that just played.
    const clauses = new Map<number, { texts: Array<string>; given: number }>()
    const onEvent = (event: ConversationEvent) => {
      publisher.onEvent(event)
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
    const input = { stream: web.input.stream.pipe(Stream.tap((chunk) => Effect.sync(() => heard.audio(chunk)))) }

    let lastTranscript = ""
    const transcript = (text: string) => {
      if (text === lastTranscript) return
      lastTranscript = text
      options.send({ type: "transcript", text })
    }
    /**
     * Stt → echo gate → wake gate → Conversation. Only what passed both gates is shown (transcript), moves the state
     * or reaches the conversation: an utterance the wake gate ignores reaches no page, no history, no agent and no
     * recording (`heard.discard`); its text goes only to admin pages with the phrase tester on (`wake.heard`).
     */
    const gateStream = (events: Stream.Stream<SttEvent, unknown>) =>
      events.pipe(Stream.flatMap((event) => {
        const t = now()
        if (event._tag !== "EndOfTurn") heard.event(event)
        const echo = gate.filter(event, t)
        const out: Array<SttEvent> = []
        let wakeDropped = false
        for (const e of echo.events) {
          const w = wake.filter(e, t)
          if (w.heard !== undefined) options.wakeHeard(w.heard.text, w.heard.phrase, w.heard.accepted)
          if (w.woke !== undefined) {
            options.send({ type: "wake", phrase: w.woke.phrase, armed: w.woke.armed })
            tracker.wakeChanged(w.woke.armed ? wake.config().armedMs ?? WAKE_ARMED_MS : wake.config().followUpMs)
          }
          if (w.dropped !== undefined || (e._tag === "EndOfTurn" && w.events.length === 0)) wakeDropped = true
          for (const passed of w.events) {
            out.push(passed)
            lastActive = t
            tracker.stt(passed)
            if (passed._tag === "Interim") transcript(passed.text)
            else if (passed._tag === "EndOfTurn") {
              transcript("")
              // An accepted utterance opens the follow-up window: the state may go back to asleep by itself.
              if (wake.config().activation === "wake-phrase") tracker.wakeChanged(wake.config().followUpMs)
            }
          }
        }
        if (event._tag === "EndOfTurn") {
          if (wakeDropped) heard.discard()
          else heard.event(event)
        }
        if (echo.dropped) transcript("")
        return Stream.fromIterable(out)
      }))

    const minuteMs = options.minuteMs ?? 60_000
    const { setup, agentSetup } = options.conversationSetup(voicesNow)
    conversation = yield* makeSessionConversation({
      engine: options.engine,
      input,
      output: web.output,
      turnTrace: sessionTurnTrace(options.turnTrace, options.name),
      setup,
      ...(agentSetup !== undefined ? { agentSetup } : {}),
      onEvent,
      onConversation: (info, reason) => {
        turns = 0
        options.send({ type: "conversation", id: info.id, reason, startedAt: info.startedAt })
        options.onChange(false)
      },
      gate: gateStream,
      defaultVoice,
      // The device's conversationIdleMinutes, live (0 = never).
      idleResetMs: () => {
        const minutes = options.profile().conversationIdleMinutes
        return minutes > 0 ? minutes * minuteMs : undefined
      },
      ...(options.maxPendingInputs !== undefined ? { maxPendingInputs: options.maxPendingInputs } : {}),
      ...(options.initialConversation !== undefined ? { initialConversation: options.initialConversation } : {})
    })
    const theConversation = conversation

    const syncProfile = () => {
      const profile = options.profile()
      gate.setMode(profile.interruptMode)
      const next: WakeConfig = wakeConfigFromProfile(profile)
      const key = JSON.stringify(next)
      if (key === wakeKey) return
      wakeKey = key
      // `configure` drops a held utterance: only when the wake part of the profile changed.
      wake.configure(next)
      tracker.wakeChanged(Math.max(next.followUpMs, next.armedMs ?? WAKE_ARMED_MS))
    }
    syncProfile()

    return {
      key: options.key,
      deviceId: options.deviceId,
      name: options.name,
      web,
      tracker,
      publisher,
      gate,
      conversation: theConversation,
      heard,
      syncProfile,
      ownerChanged: (present, micLive) => {
        owner = { present, micLive }
        if (present) touch()
        tracker.setOwner(present, present && micLive)
        options.onChange(true)
      },
      ownerPresent: () => owner.present,
      turns: () => turns,
      lastActiveAt: () => lastActive,
      touch,
      info: (): SessionInfo => {
        const last = theConversation.lastTurnAt()
        return {
          key: options.key,
          ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
          name: options.name().trim().slice(0, MAX_DEVICE_NAME_CHARS).trim() || "Voice page",
          state: tracker.current().state,
          ownerPresent: owner.present,
          conversationId: theConversation.conversation().id,
          turns,
          lastTurnAt: last ?? null
        }
      }
    } satisfies VoiceSession
  })

