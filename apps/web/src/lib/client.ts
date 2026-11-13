import type { ClientMessage, InterruptMode, OutputPath, SettingsPatch } from "@pva/protocol"
import { createDiagnosticsStore, type DiagnosticsStore, type MicProcessing } from "./audio/diagnostics.ts"
import { levels, markInterrupted } from "./audio/levels.ts"
import { type Guard, guardOf } from "./audio/lifecycle.ts"
import { describeMicError, MicFallbackError, type PlayerEvent, VoiceAudio } from "./audio/VoiceAudio.ts"
import { type Connection, makeConnection, type RequestInput, type ResultMessage, resolveWsUrl } from "./connection.ts"
import { EchoTestCancelled, runEchoTest } from "./echoTest.ts"
import { createPrefsStore, type Prefs, type PrefsStore } from "./prefs.ts"
import type { ClientState } from "./state.ts"
import { type ClientStore, createClientStore } from "./store.ts"

/**
 * The assistant client: the store, the per-device preferences, the audio engine
 * and the connection, wired together. Components call these actions; nothing
 * here depends on React.
 */
const processingOf = (p: Prefs): MicProcessing => ({
  echoCancellation: p.echoCancellation,
  noiseSuppression: p.noiseSuppression,
  autoGainControl: p.autoGainControl
})

export interface AssistantClient {
  readonly store: ClientStore
  readonly prefs: PrefsStore
  /** Microphone settings as reported and playback counters, for "This device". */
  readonly diagnostics: DiagnosticsStore
  /** Start the connection (from an effect in `App`). Returns a stop function. */
  readonly connect: () => () => void
  /** The Start / "Use this tab" gesture. Must be called synchronously from the click handler. */
  readonly startAudio: () => void
  /** Release the audio and close the microphone. */
  readonly endAudio: () => void
  readonly setMicLive: (live: boolean) => void
  /** Stop the reply now (Stop button / Esc). */
  readonly stopReply: () => void
  readonly resumeAudio: () => void
  readonly sendText: (text: string) => Promise<ResultMessage>
  readonly request: (message: RequestInput) => Promise<ResultMessage>
  readonly enableModule: (moduleId: string, enabled: boolean) => Promise<ResultMessage>
  readonly configureModule: (moduleId: string, patch: SettingsPatch) => Promise<ResultMessage>
  readonly updateSection: (sectionId: string, patch: SettingsPatch) => Promise<ResultMessage>
  readonly reloadEngines: () => Promise<ResultMessage>
  readonly setPrefs: (patch: Partial<Prefs>) => void
  /**
   * Run the echo test and save its result in the preferences (with the output path it ran on). Rejects
   * (saving nothing) when audio is off, a test already runs, or the test is cancelled: End, a takeover, a
   * failure or a new Start (a new generation), or a change of output path, while it runs.
   */
  readonly echoTest: () => Promise<{ cancelled: boolean; residualDb: number }>
  readonly connection: Connection
}

const clientIdKey = "pva.clientId"

const makeClientId = (): string => {
  try {
    const existing = sessionStorage.getItem(clientIdKey)
    if (existing !== null && existing.length >= 8) return existing
    const id = `c-${crypto.randomUUID()}`
    sessionStorage.setItem(clientIdKey, id)
    return id
  } catch {
    return `c-${Math.random().toString(36).slice(2, 12)}`
  }
}

/** Local echo-test replies use ids the server never uses for turns, and are never reported. */
const LOCAL_REPLY_ID = 0xffff_fff0

/**
 * THE place a player event becomes a playback report to the server (or none).
 *
 * PROVISIONAL / EXACT FINALS: a `stopped` event says whether its count is the worklet's own
 * (`exact: true`) or the page's best count, a lower bound sent because the worklet did not answer in time
 * or the page is going away (`exact: false`); a later exact count for the same reply follows as a second
 * `playback.stopped` when it differs. Both go out with `exact` (docs/UI-AND-MODULES.md §2.3, §2.6): the
 * server treats an `exact: false` count as provisional and waits (within its stop deadline) for the exact
 * one. An older server strips the field and takes the first count, as before; an event without `exact`
 * (straight from the worklet) is the worklet's own count.
 */
export const playbackReport = (e: PlayerEvent, outputLatencyMs: number): ClientMessage | undefined => {
  if (e.id >= LOCAL_REPLY_ID) return undefined
  switch (e.type) {
    case "started":
      return { type: "playback.started", turnId: e.id, outputLatencyMs, startDelayMs: e.startDelayMs }
    case "progress":
      return { type: "playback.progress", turnId: e.id, playedSamples: e.playedSamples, underruns: e.underruns }
    case "finished":
      return { type: "playback.finished", turnId: e.id, playedSamples: e.playedSamples }
    case "stopped":
      return e.report && e.id > 0
        ? { type: "playback.stopped", turnId: e.id, playedSamples: e.playedSamples, exact: e.exact !== false }
        : undefined
    default:
      return undefined
  }
}

export const createAssistantClient = (): AssistantClient => {
  const store = createClientStore()
  const prefs = createPrefsStore()
  const diagnostics = createDiagnosticsStore()
  const dispatch = store.dispatch
  let localPlayback: ((e: PlayerEvent) => void) | undefined
  /**
   * The echo test that runs now (its own token): it owns the microphone gate (held shut) and the local
   * playback listener until it ends. A new generation cancels it (`nextGeneration`), so a test of an older
   * session never plays through, listens to, or saves a result for the session that replaced it.
   */
  let echoRun: { preempted: boolean } | undefined

  const owner = () => store.get().session.role === "owner"

  /**
   * The client's side of the audio lifecycle (`audio/lifecycle.ts`): one generation per audio
   * session as this client sees it. Start, End, a takeover and a fatal failure each begin a new
   * one, so every asynchronous continuation (a start that settles, a microphone change, a release
   * that finishes, a resume, a wake lock granted, a callback handed to `VoiceAudio.stop`) captures a
   * `guard()` when it begins and checks it (`current()`, or runs through `wrap`) before it touches the
   * store or the server, and a stale one changes nothing. Each carries a `continuation(...)` comment
   * (enforced by `test/continuations.test.ts`).
   */
  let generation = 0
  /** A guard for work of the current generation (see `audio/lifecycle.ts`, `Guard`). */
  const guard = (): Guard => {
    const g = generation
    return guardOf(() => g === generation)
  }
  /** Begin a new generation; the guard returned belongs to it. */
  const nextGeneration = (): Guard => {
    generation++
    cancelEchoTest(false)
    return guard()
  }

  /**
   * Cancel the running echo test, if any (it notices within one 20 ms sample and saves nothing). `preempted`:
   * a real reply is starting (sixth review, finding 2): a real reply always wins, so the test is cancelled
   * before the reply reaches the player, and the test must not stop the player afterwards (the reply's `start`
   * replaces the chirp; a stop for the chirp could cut the reply's own fade).
   */
  const cancelEchoTest = (preempted: boolean) => {
    if (echoRun === undefined) return
    echoRun.preempted = preempted
    echoRun = undefined
    localPlayback = undefined
    updateMicGate()
  }

  const updateMicGate = () => {
    // The echo test: the server must not hear the test signal.
    if (echoRun !== undefined) return connection.setMicGate(false)
    // Manual interrupt mode: nothing from the microphone while the assistant is audible.
    const s = store.get()
    connection.setMicGate(!(s.audio.interruptMode === "manual" && s.audio.playing !== undefined))
  }

  /**
   * continuation(link): player events, also from an older session's player finishing its final counts
   * (`current` false). Reports always go to the server (it matches them by turn id and owner, and needs
   * the old reply's final count); what the page shows changes only for the current session's player.
   */
  const onPlayer = (e: PlayerEvent, current = true) => {
    if (e.id >= LOCAL_REPLY_ID) {
      if (current) localPlayback?.(e)
      return
    }
    if (e.type === "stats") {
      const { type: _type, ...stats } = e
      if (current) diagnostics.dispatch({ type: "reply", stats })
      return
    }
    const report = playbackReport(e, audio.outputLatencyMs() ?? 0)
    if (report !== undefined) connection.send(report)
    if (!current) return
    if (e.type === "started") dispatch({ type: "local/playing", turnId: e.id })
    else if ((e.type === "finished" || e.type === "stopped") && store.get().audio.playing?.turnId === e.id) dispatch({ type: "local/playing", turnId: undefined })
    updateMicGate()
  }

  // continuation(session+link): the callbacks below are run later by `VoiceAudio`; each says what it relies on.
  const audio = new VoiceAudio({
    onMicFrame: (buffer) => connection.sendMic(buffer), // continuation(session): `VoiceAudio` drops frames of a stale session
    onPlayer,
    // continuation(session): `VoiceAudio` reports only the current session's failures and context changes.
    onState: (state, detail) => {
      if (state === "error") {
        // Fatal (the microphone ended: unplugged, permission revoked). Close everything locally and keep
        // the error on screen; the reply's final count goes out first, then the audio is given back to
        // the server, or it keeps treating this tab as its microphone and speaker.
        releaseWakeLock()
        void releaseAudio("end", detail ?? "Audio failed.", giveBack) // continuation(generation): `releaseAudio` wraps `giveBack` in its guard
        return
      }
      dispatch({ type: "local/audio", phase: state })
    },
    // A microphone the system keeps muted: a recoverable error (audio stays on), cleared when it unmutes.
    // continuation(request): `VoiceAudio`'s muted check runs for its own request only.
    onMicMuted: (message) => {
      if (message !== undefined) dispatch({ type: "local/toast", message, tone: "error" })
    },
    // continuation(link): `VoiceAudio` reports the route of the session's current player only.
    onRoute: (route) => diagnostics.dispatch({ type: "route", route })
  })

  // continuation(state): the connection runs these callbacks on each socket event, on the present state.
  const connection: Connection = makeConnection({
    url: typeof location === "undefined" ? "ws://localhost:8787/ws" : resolveWsUrl(location),
    clientId: typeof sessionStorage === "undefined" ? "c-server-render" : makeClientId(),
    store,
    audio: {
      replyStart: (turnId, rate) => {
        cancelEchoTest(true) // a real reply always wins over the echo test, in any phase of it
        audio.replyStart(turnId, rate)
      },
      replyFrame: (buffer) => audio.replyFrame(buffer),
      replyEnd: (turnId) => audio.replyEnd(turnId),
      replyStop: (turnId) => audio.replyStop(turnId, true),
      socketLost: () => audio.replyStop(undefined, false),
      running: () => audio.running
    },
    // continuation(none): the connection's hooks run synchronously on each message, on the present state.
    hooks: {
      afterWelcome: (resumed) => {
        if (resumed) {
          // The server assumes a live microphone on resume: tell it the truth.
          const s = store.get()
          connection.send({ type: "audio.config", interruptMode: s.audio.interruptMode, audio: audio.info() })
          connection.send({ type: "mic.state", live: s.audio.micLive })
        } else if (audio.running && store.get().session.role !== "owner") {
          // Someone else claimed the audio while we were away.
          void releaseAudio("takeover")
        }
      },
      afterMessage: (m, previousRole) => {
        if (m.type === "session" && previousRole === "owner" && m.role === "observer" && audio.running) {
          void releaseAudio("takeover") // taken over by another tab: close our microphone
        }
        if (m.type === "turn.end" && m.outcome === "interrupted") markInterrupted()
      }
    }
  })

  /**
   * End this audio session (End, a takeover, or a fatal failure with `error`). A new generation
   * starts at once, so continuations of the old session go stale; the state after the close is
   * written only if nothing newer (a Start pressed meanwhile) happened.
   */
  const releaseAudio = async (reason: "end" | "takeover", error?: string, afterFinal?: () => void) => {
    const g = nextGeneration()
    if (error !== undefined) dispatch({ type: "local/audio", phase: "error", error })
    else dispatch({ type: "local/audio", phase: "off" })
    dispatch({ type: "local/mic", live: true })
    // continuation(generation): `afterFinal` (the ownership release) runs only if nothing newer began
    // while the final count was awaited (fourth review, finding 2: a Start pressed meanwhile claimed the
    // audio again, and the old release would have released the new session). The final count itself is
    // reported through `onPlayer`, unguarded.
    await audio.stop(reason, afterFinal === undefined ? undefined : g.wrap(afterFinal))
    if (!g.current()) return
    if (error === undefined && store.get().audio.phase !== "off") dispatch({ type: "local/audio", phase: "off" })
  }

  const info = () => audio.info()

  const startAudio = () => {
    const phase = store.get().audio.phase
    if (phase === "starting") return
    if (!VoiceAudio.supported()) {
      dispatch({ type: "local/audio", phase: "error", error: "This browser cannot use the microphone here. It needs HTTPS or localhost." })
      return
    }
    if (audio.running) {
      // Audio is already open on this page (e.g. the server lost track of us): claim it again, and
      // show the phase it is really in.
      dispatch({ type: "local/audio", phase: audio.contextState === "running" ? "running" : "suspended" })
      connection.resetMicSequence()
      connection.send({ type: "audio.claim", interruptMode: store.get().audio.interruptMode, audio: audio.info() })
      return
    }
    const p = prefs.get()
    const g = nextGeneration()
    dispatch({ type: "local/audio", phase: "starting" })
    // Synchronous up to the first await inside: the context is created and resumed in the gesture.
    const started = audio.start({
      micDeviceId: p.micDeviceId,
      sinkId: p.sinkId,
      outputPath: p.outputPath,
      prebufferMs: p.prebufferMs,
      processing: processingOf(p)
    })
    // continuation(generation): both outcomes act only if no End, takeover or newer Start came first.
    void started.then(
      (audioInfo) => {
        if (!g.current()) return // End, a takeover or a newer Start came first
        diagnostics.dispatch({ type: "mic", report: audio.micReport() })
        dispatch({ type: "local/mic", live: true })
        dispatch({ type: "local/audio", phase: audio.contextState === "running" ? "running" : "suspended" })
        connection.resetMicSequence()
        connection.send({ type: "audio.claim", interruptMode: store.get().audio.interruptMode, audio: audioInfo })
        requestWakeLock()
      },
      (error: unknown) => {
        if (!g.current()) return // abandoned: never overwrite the state of what replaced it
        // A failed retry of the device we stored: forget it so the next Start uses the default.
        if ((error as { name?: string }).name === "OverconstrainedError") prefs.dispatch({ micDeviceId: "" })
        dispatch({ type: "local/audio", phase: "error", error: describeMicError(error) })
      }
    )
  }

  /**
   * Give the audio back to the server: after the reply's final count was sent (`VoiceAudio.stop` calls this
   * once it has it), since the server uses a count only from the tab that owns the audio.
   */
  const giveBack = () => {
    if (owner()) connection.send({ type: "audio.release" })
  }

  const endAudio = () => {
    releaseWakeLock()
    void releaseAudio("end", undefined, giveBack) // continuation(generation): `releaseAudio` wraps `giveBack` in its guard
  }

  /** A microphone change (device or processing) settled: report it, unless it belongs to an older session. */
  const micChanged = (g: Guard, after: () => void) => [
    () => {
      if (g.current()) after()
    },
    (e: unknown) => {
      if (!g.current()) return
      if (e instanceof MicFallbackError) {
        // Audio goes on, on the previous (or default) microphone: make the settings say so.
        prefs.dispatch({ micDeviceId: e.fallback.deviceId, ...e.fallback.processing })
        diagnostics.dispatch({ type: "mic", report: audio.micReport() })
      }
      dispatch({ type: "local/toast", message: e instanceof MicFallbackError ? e.message : describeMicError(e), tone: "error" })
    }
  ] as const

  const setMicLive = (live: boolean) => {
    if (!audio.running) return
    audio.setMicLive(live)
    dispatch({ type: "local/mic", live })
    if (live) connection.resetMicSequence()
    connection.send({ type: "mic.state", live })
  }

  const stopReply = () => {
    const s: ClientState = store.get()
    const playing = s.audio.playing?.turnId
    const turnId = playing ?? s.session.stateTurnId
    markInterrupted()
    // Silence first, locally; the worklet then reports playback.stopped with the final count.
    if (owner() && audio.running) audio.replyStop(playing, true)
    connection.send(turnId === undefined ? { type: "interrupt" } : { type: "interrupt", turnId })
  }

  const sendText = (text: string) =>
    connection.request({ type: "text.send", text, speak: owner() && audio.running && prefs.get().speakReplies })

  const setPrefs = (patch: Partial<Prefs>) => {
    const before = prefs.get()
    prefs.dispatch(patch)
    const after = prefs.get()
    if (patch.interruptMode !== undefined) {
      dispatch({ type: "local/interrupt-mode", mode: patch.interruptMode })
      updateMicGate()
    }
    if (patch.prebufferMs !== undefined) audio.setPrebuffer(after.prebufferMs)
    if (patch.outputPath !== undefined && patch.outputPath !== before.outputPath) audio.setOutputPath(after.outputPath as OutputPath)
    if (patch.sinkId !== undefined && patch.sinkId !== before.sinkId) void audio.setSink(after.sinkId).catch(() => undefined) // continuation(none): ignores the outcome
    const g = guard()
    if (patch.micDeviceId !== undefined && patch.micDeviceId !== before.micDeviceId) {
      void audio.setMicDevice(after.micDeviceId).then(...micChanged(g, () => diagnostics.dispatch({ type: "mic", report: audio.micReport() }))) // continuation(generation): `micChanged`
    }
    const processing = processingOf(after)
    const processingBefore = processingOf(before)
    if (
      processing.echoCancellation !== processingBefore.echoCancellation ||
      processing.noiseSuppression !== processingBefore.noiseSuppression ||
      processing.autoGainControl !== processingBefore.autoGainControl
    ) {
      // continuation(generation+state): `micChanged`; the interrupt mode is read when the configuration is sent
      // (fifth review, finding 2: a mode chosen while the microphone reopened must not be overwritten by the
      // one captured here).
      void audio.setMicProcessing(processing).then(...micChanged(g, () => {
        diagnostics.dispatch({ type: "mic", report: audio.micReport() })
        if (owner() && audio.running) connection.send({ type: "audio.config", interruptMode: prefs.get().interruptMode as InterruptMode, audio: info() })
      }))
    }
    if ((patch.interruptMode !== undefined || patch.outputPath !== undefined) && owner() && audio.running) {
      connection.send({ type: "audio.config", interruptMode: after.interruptMode as InterruptMode, audio: info() })
    }
  }

  // ---- Screen wake lock while this tab owns the audio ----
  let wakeLock: { release: () => Promise<void> } | undefined
  const requestWakeLock = () => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }
    const g = guard()
    // continuation(generation): a lock granted after End, a takeover or a failure (or for an older
    // generation) is released at once instead of keeping the screen on for good; a lock replacing one
    // still held releases the old one.
    void nav.wakeLock?.request("screen").then((l) => {
      if (!g.current() || !audio.running) {
        void l.release().catch(() => undefined) // continuation(none): ignores the outcome
        return
      }
      if (wakeLock !== undefined && wakeLock !== l) void wakeLock.release().catch(() => undefined) // continuation(none): ignores the outcome
      wakeLock = l
    }, () => undefined)
  }
  const releaseWakeLock = () => {
    void wakeLock?.release().catch(() => undefined) // continuation(none): ignores the outcome
    wakeLock = undefined
  }

  const connect = () => {
    prefs.load()
    dispatch({ type: "local/interrupt-mode", mode: prefs.get().interruptMode })
    const stop = connection.start()
    // continuation(none): acts on the present state when the page becomes visible.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !audio.running) return
      if (audio.contextState !== "running") void audio.resume().catch(() => undefined) // continuation(identity): `resume` checks its context
      else audio.checkCapture()
      if (owner()) requestWakeLock()
    }
    document.addEventListener("visibilitychange", onVisible) // continuation(none): see `onVisible`
    // The page is going away (closed, navigated, or put in the back-forward cache): the reply's count is
    // sent now with the best count the page has (it cannot wait for the worklet).
    // continuation(none): acts on the present state, synchronously.
    const onPageHide = () => {
      if (audio.running && owner()) audio.unload()
    }
    window.addEventListener("pagehide", onPageHide) // continuation(none): see `onPageHide`
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("pagehide", onPageHide)
      stop()
    }
  }

  return {
    store,
    prefs,
    connection,
    connect,
    startAudio,
    endAudio,
    setMicLive,
    stopReply,
    resumeAudio: () => {
      const g = guard()
      // continuation(generation): shows the phase only if the same generation is still running.
      void audio.resume().then(
        () => {
          if (g.current() && audio.running) dispatch({ type: "local/audio", phase: audio.contextState === "running" ? "running" : "suspended" })
        },
        () => undefined
      )
    },
    sendText,
    request: connection.request,
    enableModule: (moduleId, enabled) => connection.request({ type: enabled ? "module.enable" : "module.disable", moduleId }),
    configureModule: (moduleId, patch) => connection.request({ type: "module.configure", moduleId, patch }),
    updateSection: (sectionId, patch) => connection.request({ type: "settings.update", sectionId, patch }),
    reloadEngines: () => connection.request({ type: "engine.reload" }),
    setPrefs,
    diagnostics,
    echoTest: async () => {
      if (!audio.running) throw new Error("Start audio first.")
      if (echoRun !== undefined) throw new Error("The echo test is already running.")
      const open = audio.openReply()
      if ((open !== undefined && open < LOCAL_REPLY_ID) || store.get().audio.playing !== undefined) {
        throw new Error("A reply is playing. Run the echo test when it has finished.")
      }
      const g = guard()
      const mine = { preempted: false }
      const outputPath = prefs.get().outputPath
      /** Cancelled: a new generation (End, takeover, failure, Start), or another output path than the one tested. */
      const stale = () => !g.current() || echoRun !== mine || !audio.running || prefs.get().outputPath !== outputPath
      echoRun = mine
      updateMicGate()
      let listener: ((e: PlayerEvent) => void) | undefined
      let played = false
      try {
        // continuation(generation+state): fifth review, finding 1. Every step checks `stale()` when it runs:
        // the chirp is played, the listener installed, and the result saved only for this test of this
        // generation on the output path it started with; a cancelled test rejects and saves nothing.
        const result = await runEchoTest({
          play: (pcm, rate) => {
            if (stale()) return
            played = true
            audio.playLocal(LOCAL_REPLY_ID, rate, pcm)
          },
          micRms: () => levels.micRms,
          onPlayer: (f) => {
            if (stale()) return
            listener = f
            localPlayback = f
          },
          cancelled: stale
        })
        if (stale()) throw new EchoTestCancelled()
        setPrefs({ echoTest: { ...result, at: Date.now(), outputPath } })
        return result
      } finally {
        // Clean up only what this test owns: its listener, its chirp (in its own session), and the gate.
        if (listener !== undefined && localPlayback === listener) localPlayback = undefined
        if (played && stale() && !mine.preempted && g.current() && audio.running) audio.replyStop(LOCAL_REPLY_ID, false)
        if (echoRun === mine) {
          echoRun = undefined
          updateMicGate()
        }
      }
    }
  }
}
