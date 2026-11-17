import type { Assistant, AssistantBody, AssistantId, ClientMessage, DeviceProfile, DeviceSettingsPatch, DeviceTarget, FrontendRole, SettingsPatch, ToolId } from "@pva/protocol"
import { type Outcome, outcomeOf } from "./assistants.ts"
import { createDiagnosticsStore, type DiagnosticsStore, type MicProcessing } from "./audio/diagnostics.ts"
import { CUE_RATE, wakeCue } from "./audio/cue.ts"
import { levels, markInterrupted } from "./audio/levels.ts"
import { type Guard, guardOf } from "./audio/lifecycle.ts"
import { describeMicError, MicFallbackError, type PlayerEvent, VoiceAudio } from "./audio/VoiceAudio.ts"
import { type Connection, makeConnection, type RequestInput, type ResultMessage, resolveWsUrl } from "./connection.ts"
import { EchoTestCancelled, runEchoTest } from "./echoTest.ts"
import { deviceHello } from "./device.ts"
import { ADMIN_TOKEN_KEY } from "./adminToken.ts"
import { createPrefsStore, type Prefs, type PrefsStore } from "./prefs.ts"
import { sessionsFullText } from "./sessions.ts"
import { navigateSettings, type SettingsPath } from "./settingsTree.ts"
import { type ClientState, profileOf } from "./state.ts"
import { type ClientStore, createClientStore } from "./store.ts"

/**
 * The assistant client: the store, the per-device preferences, the audio engine
 * and the connection, wired together. Components call these actions; nothing
 * here depends on React.
 */
const processingOf = (p: Pick<DeviceProfile, keyof MicProcessing>): MicProcessing => ({
  echoCancellation: p.echoCancellation,
  noiseSuppression: p.noiseSuppression,
  autoGainControl: p.autoGainControl
})

export interface AssistantClient {
  /** Which front end this client serves: `voice` (`/`) or `admin` (`/admin/`, never claims audio). */
  readonly frontend: FrontendRole
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
  /** Typed text goes to `assistantId`'s conversation (the one the chat shows); without one, to the answering assistant. */
  readonly sendText: (text: string, assistantId?: string) => Promise<ResultMessage>
  readonly request: (message: RequestInput) => Promise<ResultMessage>
  readonly enableModule: (moduleId: string, enabled: boolean) => Promise<ResultMessage>
  readonly configureModule: (moduleId: string, patch: SettingsPatch) => Promise<ResultMessage>
  /** `confirmWarnings`: the owner saw the warnings and chose "Save anyway". */
  readonly updateSection: (sectionId: string, patch: SettingsPatch, confirmWarnings?: boolean) => Promise<ResultMessage>
  /**
   * Open the settings at `to` (a path such as `["speech", "engine"]`), or close them. With unsaved edits on the page
   * this asks "Leave without saving?" first, unless `discard`.
   */
  readonly settings: (to: SettingsPath | "close", options?: { readonly discard?: boolean }) => void
  readonly reloadEngines: () => Promise<ResultMessage>
  /** Admin (protocol 9): "Check again" on the Health page; the new issues arrive as `health`. */
  readonly checkHealth: () => Promise<ResultMessage>
  /** Key vault (see `lib/vault.ts`): passwords go to the server only and are never kept here. */
  readonly setupVault: (password: string) => Promise<ResultMessage>
  readonly unlockVault: (password: string) => Promise<ResultMessage>
  readonly lockVault: () => Promise<ResultMessage>
  readonly changeVaultPassword: (oldPassword: string, newPassword: string) => Promise<ResultMessage>
  /** Admin: move these `.env` variables into the saved settings (keys into the vault) and comment them out of the file. */
  readonly moveFromEnv: (keys: ReadonlyArray<string>) => Promise<ResultMessage>
  /** Admin: download a model preset (a job; progress arrives as `job` messages). */
  readonly downloadModel: (tool: ToolId, target: string) => Promise<ResultMessage>
  readonly cancelJob: (jobId: string) => Promise<ResultMessage>
  readonly deleteModel: (tool: ToolId, target: string) => Promise<ResultMessage>
  /** This browser's own choices (microphone, speaker). */
  readonly setPrefs: (patch: Partial<Prefs>) => void
  /** Admin: log in (the token is kept in `sessionStorage` for reloads and reconnects) and out. */
  readonly adminLogin: (password: string) => Promise<ResultMessage>
  readonly adminLogout: () => Promise<ResultMessage>
  /** Admin: forget a device. */
  readonly forgetDevice: (id: string) => Promise<ResultMessage>
  /**
   * Admin, protocol 7 (docs/ASSISTANTS.md §5.2). Each answers with an `Outcome`: `ok` (create: with `assistantId`),
   * `invalid` (field errors by dotted path), `warnings` (send again with `saveAnyway`), `stale` (the entity changed:
   * the user is told with a toast, and the caller drops its draft: the newest version is already in the state) or
   * `refused`. The new lists arrive as `assistants` / `device.types` / `devices` pushes.
   */
  readonly saveAssistant: (assistant: Assistant, options?: { readonly saveAnyway?: boolean; readonly name?: string }) => Promise<Outcome>
  readonly createAssistant: (
    assistant: AssistantBody,
    options?: {
      readonly copyOf?: AssistantId
      readonly placements?: ReadonlyArray<{ readonly target: DeviceTarget; readonly phrase?: string }>
      /** Create although the save warned (a hosted voice without its key): the wizard's and Duplicate's "Create anyway". */
      readonly saveAnyway?: boolean
    }
  ) => Promise<Outcome>
  readonly deleteAssistant: (id: AssistantId, rev: number, name?: string) => Promise<Outcome>
  readonly saveDevice: (
    target: DeviceTarget,
    rev: number,
    settings: DeviceSettingsPatch,
    options?: { readonly saveAnyway?: boolean; readonly name?: string; readonly label?: string }
  ) => Promise<Outcome>
  /**
   * Admin: the phrase tester (`wake.heard` lines arrive while it is on), for one device's session (`deviceId`) or,
   * without one, the most recently active session.
   */
  readonly wakeTest: (on: boolean, deviceId?: string) => Promise<ResultMessage>
  /** Voice: start a new conversation on this device (`conversation.new`); the chat empties on the server's answer. */
  readonly newConversation: (assistantId?: string) => Promise<ResultMessage>
  /**
   * Voice, protocol 7: pick who answers without a phrase on this device (`device.pick`): an assistant id, `"typesafe"`
   * (whichever fits) or `""` (nobody). Device-wide. The new `device.setup` arrives as a push; a refusal is in the result.
   */
  readonly pickAssistant: (withoutPhrase: string) => Promise<ResultMessage>
  /** Voice, protocol 7: ask for one assistant's conversation; the answer is a `conversation.history` (no `result`). */
  readonly readConversation: (assistantId: string) => void
  /**
   * Run the echo test and save its result in the preferences (with the output path it ran on). Rejects
   * (saving nothing) when audio is off, a test already runs, or the test is cancelled: End, a takeover, a
   * failure or a new Start (a new generation), or a change of output path, while it runs.
   */
  readonly echoTest: () => Promise<{ cancelled: boolean; residualDb: number }>
  readonly connection: Connection
}

const clientIdKey = "pva.clientId"
export { ADMIN_TOKEN_KEY }

const readToken = (): string | undefined => {
  try {
    return globalThis.sessionStorage?.getItem(ADMIN_TOKEN_KEY) ?? undefined
  } catch {
    return undefined
  }
}
const writeToken = (token: string | undefined) => {
  try {
    if (token === undefined) globalThis.sessionStorage?.removeItem(ADMIN_TOKEN_KEY)
    else globalThis.sessionStorage?.setItem(ADMIN_TOKEN_KEY, token)
  } catch {
    // Storage disabled: the login lasts for this connection only.
  }
}

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
/** The wake cue: another local id. */
const CUE_REPLY_ID = LOCAL_REPLY_ID + 1

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

export const createAssistantClient = (options: { readonly frontend?: FrontendRole } = {}): AssistantClient => {
  const frontend: FrontendRole = options.frontend ?? "voice"
  const store = createClientStore()
  const prefs = createPrefsStore()
  const diagnostics = createDiagnosticsStore()
  const dispatch = store.dispatch
  /** An answer to an assistant or device message as an `Outcome`; a stale one is told to the user here. */
  const adminOutcome = async (pending: Promise<ResultMessage>, name: string): Promise<Outcome> => {
    const outcome = outcomeOf(await pending) // continuation(none): turns the answer into an outcome; the toast below is the only effect
    if (outcome.kind === "stale") {
      dispatch({ type: "local/toast", message: `${name} was changed somewhere else. Showing the latest version; your edits were not saved.`, tone: "error" })
    }
    return outcome
  }
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
    connection.setMicGate(!(profileOf(s).interruptMode === "manual" && s.audio.playing !== undefined))
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
    identity: () => {
      if (frontend === "admin") {
        const token = readToken()
        return token === undefined ? { frontend } : { frontend, adminToken: token }
      }
      return typeof window === "undefined" ? { frontend } : { frontend, device: deviceHello() }
    },
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
          connection.send({ type: "audio.config", audio: audio.info() })
          connection.send({ type: "mic.state", live: s.audio.micLive })
        } else if (audio.running && store.get().session.role !== "owner") {
          // Someone else claimed the audio while we were away.
          void releaseAudio("takeover")
        }
      },
      afterMessage: (m, previousRole) => {
        if (m.type === "admin.state" && !m.admin.loggedIn) writeToken(undefined)
        if (m.type === "welcome" && frontend === "admin" && !m.snapshot.admin.loggedIn) writeToken(undefined)
        if (m.type === "wake" && m.armed) playCue()
        if (m.type === "session" && previousRole === "owner" && m.role === "observer" && audio.running) {
          void releaseAudio("takeover") // taken over by another tab: close our microphone
        }
        if (m.type === "turn.end" && m.outcome === "interrupted") markInterrupted()
        if (m.type === "error" && m.error.code === "sessions_full") {
          // The claim was refused (too many devices talking): close the microphone and say why where Start was.
          const message = sessionsFullText(m.error.message)
          if (audio.running || store.get().audio.phase !== "off") {
            releaseWakeLock()
            void releaseAudio("end", message) // continuation(generation): `releaseAudio` starts a new generation itself
          } else dispatch({ type: "local/audio", phase: "error", error: message })
        }
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
    if (frontend === "admin") return // the admin page never claims the audio
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
      connection.send({ type: "audio.claim", audio: audio.info() })
      return
    }
    const p = prefs.get()
    const profile = profileOf(store.get())
    const g = nextGeneration()
    dispatch({ type: "local/audio", phase: "starting" })
    // Synchronous up to the first await inside: the context is created and resumed in the gesture.
    const started = audio.start({
      micDeviceId: p.micDeviceId,
      sinkId: p.sinkId,
      outputPath: profile.outputPath,
      prebufferMs: profile.prebufferMs,
      processing: processingOf(profile)
    })
    // continuation(generation): both outcomes act only if no End, takeover or newer Start came first.
    void started.then(
      (audioInfo) => {
        if (!g.current()) return // End, a takeover or a newer Start came first
        diagnostics.dispatch({ type: "mic", report: audio.micReport() })
        dispatch({ type: "local/mic", live: true })
        dispatch({ type: "local/audio", phase: audio.contextState === "running" ? "running" : "suspended" })
        connection.resetMicSequence()
        connection.send({ type: "audio.claim", audio: audioInfo })
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
        // Audio goes on, on the previous (or default) microphone: make the settings say so. (The processing it fell
        // back to is the profile's to decide; it is applied again on the next profile change.)
        prefs.dispatch({ micDeviceId: e.fallback.deviceId })
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

  const sendText = (text: string, assistantId?: string) =>
    connection.request({
      type: "text.send",
      text,
      speak: owner() && audio.running && profileOf(store.get()).speakReplies,
      ...(assistantId !== undefined ? { assistantId } : {})
    })

  const setPrefs = (patch: Partial<Prefs>) => {
    const before = prefs.get()
    prefs.dispatch(patch)
    const after = prefs.get()
    if (patch.sinkId !== undefined && patch.sinkId !== before.sinkId) void audio.setSink(after.sinkId).catch(() => undefined) // continuation(none): ignores the outcome
    const g = guard()
    if (patch.micDeviceId !== undefined && patch.micDeviceId !== before.micDeviceId) {
      void audio.setMicDevice(after.micDeviceId).then(...micChanged(g, () => diagnostics.dispatch({ type: "mic", report: audio.micReport() }))) // continuation(generation): `micChanged`
    }
  }

  /**
   * The browser's part of the device profile, applied live when it changes (an admin edit reaches a running device at
   * once): the microphone re-opens when its processing changes, the output path and prebuffer switch, the interrupt
   * mode moves the microphone gate (the server applies its own copy to the echo gate).
   */
  const applyProfile = (before: DeviceProfile, after: DeviceProfile) => {
    if (after.interruptMode !== before.interruptMode) updateMicGate()
    if (after.prebufferMs !== before.prebufferMs) audio.setPrebuffer(after.prebufferMs)
    if (after.outputPath !== before.outputPath) {
      audio.setOutputPath(after.outputPath)
      if (owner() && audio.running) connection.send({ type: "audio.config", audio: info() })
    }
    const processing = processingOf(after)
    const processingBefore = processingOf(before)
    if (
      processing.echoCancellation !== processingBefore.echoCancellation ||
      processing.noiseSuppression !== processingBefore.noiseSuppression ||
      processing.autoGainControl !== processingBefore.autoGainControl
    ) {
      const g = guard()
      // continuation(generation+state): `micChanged`; the configuration is read when it is sent.
      void audio.setMicProcessing(processing).then(...micChanged(g, () => {
        diagnostics.dispatch({ type: "mic", report: audio.micReport() })
        if (owner() && audio.running) connection.send({ type: "audio.config", audio: info() })
      }))
    }
  }
  let appliedProfile: DeviceProfile = profileOf(store.get())
  // continuation(state): runs synchronously on every store change and compares with the profile applied last.
  store.subscribe(() => {
    const next = profileOf(store.get())
    if (next === appliedProfile) return
    const before = appliedProfile
    appliedProfile = next
    applyProfile(before, next)
  })

  /**
   * "Listening…" after the wake phrase alone: two short soft tones (under 200 ms, generated), through the player so it
   * uses the chosen speaker. Not while a reply or the echo test plays, nor with speaking replies off or the mic muted.
   */
  const playCue = () => {
    const s = store.get()
    if (frontend !== "voice" || !owner() || !audio.running || audio.contextState !== "running") return
    if (!s.audio.micLive || !profileOf(s).speakReplies || s.audio.playing !== undefined || echoRun !== undefined) return
    const open = audio.openReply()
    if (open !== undefined && open < LOCAL_REPLY_ID) return
    audio.playLocal(CUE_REPLY_ID, CUE_RATE, wakeCue())
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

  const adminLogin = async (password: string) => {
    const result = await connection.request({ type: "admin.login", password }) // continuation(none): stores the token of its own answer
    if (result.ok && result.admin !== undefined) writeToken(result.admin.token)
    return result
  }
  const adminLogout = async () => {
    const result = await connection.request({ type: "admin.logout" }) // continuation(none): forgets the token whatever happened
    writeToken(undefined)
    return result
  }

  return {
    frontend,
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
    updateSection: (sectionId, patch, confirmWarnings) =>
      connection.request({ type: "settings.update", sectionId, patch, ...(confirmWarnings === true ? { confirmWarnings: true } : {}) }),
    settings: (to, options = {}) => dispatch({ type: "local/ui", patch: navigateSettings(store.get().ui, to, options.discard === true) }),
    reloadEngines: () => connection.request({ type: "engine.reload" }),
    checkHealth: () => connection.request({ type: "health.check" }),
    setupVault: (password) => connection.request({ type: "vault.setup", password }),
    unlockVault: (password) => connection.request({ type: "vault.unlock", password }),
    lockVault: () => connection.request({ type: "vault.lock" }),
    changeVaultPassword: (oldPassword, newPassword) => connection.request({ type: "vault.changePassword", oldPassword, newPassword }),
    moveFromEnv: (keys) => connection.request({ type: "settings.moveFromEnv", keys: [...keys] }),
    downloadModel: (tool, target) => connection.request({ type: "job.start", tool, action: "download", target }),
    cancelJob: (jobId) => connection.request({ type: "job.cancel", jobId }),
    deleteModel: (tool, target) => connection.request({ type: "model.delete", tool, target }),
    setPrefs,
    adminLogin,
    adminLogout,
    forgetDevice: (id) => connection.request({ type: "device.forget", id }),
    saveAssistant: (assistant, options = {}) =>
      adminOutcome(connection.request({ type: "assistant.save", assistant, ...(options.saveAnyway === true ? { saveAnyway: true } : {}) }), options.name ?? assistant.name),
    createAssistant: (assistant, options = {}) =>
      adminOutcome(
        connection.request({
          type: "assistant.create",
          assistant,
          ...(options.copyOf !== undefined ? { copyOf: options.copyOf } : {}),
          ...(options.placements !== undefined ? { placements: options.placements.map((p) => ({ target: p.target, ...(p.phrase !== undefined ? { phrase: p.phrase } : {}) })) } : {}),
          ...(options.saveAnyway === true ? { saveAnyway: true } : {})
        }),
        assistant.name
      ),
    deleteAssistant: (id, rev, name) => adminOutcome(connection.request({ type: "assistant.delete", id, rev }), name ?? id),
    saveDevice: (target, rev, settings, options = {}) =>
      adminOutcome(
        connection.request({
          type: "device.save",
          target,
          rev,
          settings,
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.saveAnyway === true ? { saveAnyway: true } : {})
        }),
        options.label ?? "The device"
      ),
    wakeTest: (on, deviceId) => connection.request(deviceId === undefined ? { type: "wake.test", on } : { type: "wake.test", on, deviceId }),
    newConversation: (assistantId) => connection.request(assistantId === undefined ? { type: "conversation.new" } : { type: "conversation.new", assistantId }),
    // Who has the turn afterwards is the server's to say: an accepted pick closes its windows and the `state` that follows names the holder.
    pickAssistant: (withoutPhrase) => connection.request({ type: "device.pick", withoutPhrase }),
    readConversation: (assistantId) => {
      connection.send({ type: "conversation.read", requestId: `read-${assistantId}-${Date.now().toString(36)}`, assistantId })
    },
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
      const outputPath = profileOf(store.get()).outputPath
      /** Cancelled: a new generation (End, takeover, failure, Start), or another output path than the one tested. */
      const stale = () => !g.current() || echoRun !== mine || !audio.running || profileOf(store.get()).outputPath !== outputPath
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
