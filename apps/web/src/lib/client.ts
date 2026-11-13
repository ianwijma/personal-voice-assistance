import type { InterruptMode, OutputPath, SettingsPatch, ToolId } from "@pva/protocol"
import { createDiagnosticsStore, type DiagnosticsStore, type MicProcessing } from "./audio/diagnostics.ts"
import { levels, markInterrupted } from "./audio/levels.ts"
import { describeMicError, type PlayerEvent, VoiceAudio } from "./audio/VoiceAudio.ts"
import { type Connection, makeConnection, type RequestInput, type ResultMessage, resolveWsUrl } from "./connection.ts"
import { runEchoTest } from "./echoTest.ts"
import { createPrefsStore, type Prefs, type PrefsStore } from "./prefs.ts"
import { navigateSettings, type SettingsPath } from "./settingsTree.ts"
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
  /** `confirmWarnings`: the owner saw the warnings and chose "Save anyway". */
  readonly updateSection: (sectionId: string, patch: SettingsPatch, confirmWarnings?: boolean) => Promise<ResultMessage>
  /**
   * Open the settings at `to` (a path such as `["speech", "engine"]`), or close them. With unsaved edits on the page
   * this asks "Leave without saving?" first, unless `discard`.
   */
  readonly settings: (to: SettingsPath | "close", options?: { readonly discard?: boolean }) => void
  readonly reloadEngines: () => Promise<ResultMessage>
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
  readonly setPrefs: (patch: Partial<Prefs>) => void
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

export const createAssistantClient = (): AssistantClient => {
  const store = createClientStore()
  const prefs = createPrefsStore()
  const diagnostics = createDiagnosticsStore()
  const dispatch = store.dispatch
  let localPlayback: ((e: PlayerEvent) => void) | undefined

  const owner = () => store.get().session.role === "owner"

  const updateMicGate = () => {
    // Manual interrupt mode: nothing from the microphone while the assistant is audible.
    const s = store.get()
    connection.setMicGate(!(s.audio.interruptMode === "manual" && s.audio.playing !== undefined))
  }

  const onPlayer = (e: PlayerEvent) => {
    if (e.id >= LOCAL_REPLY_ID) {
      localPlayback?.(e)
      return
    }
    switch (e.type) {
      case "started":
        dispatch({ type: "local/playing", turnId: e.id })
        connection.send({ type: "playback.started", turnId: e.id, outputLatencyMs: audio.outputLatencyMs() ?? 0, startDelayMs: e.startDelayMs })
        break
      case "progress":
        connection.send({ type: "playback.progress", turnId: e.id, playedSamples: e.playedSamples, underruns: e.underruns })
        break
      case "finished":
        if (store.get().audio.playing?.turnId === e.id) dispatch({ type: "local/playing", turnId: undefined })
        connection.send({ type: "playback.finished", turnId: e.id, playedSamples: e.playedSamples })
        break
      case "stopped":
        if (store.get().audio.playing?.turnId === e.id) dispatch({ type: "local/playing", turnId: undefined })
        if (e.report && e.id > 0) connection.send({ type: "playback.stopped", turnId: e.id, playedSamples: e.playedSamples })
        break
      case "underrun":
        break
      case "stats": {
        const { type: _type, ...stats } = e
        diagnostics.dispatch({ type: "reply", stats })
        return
      }
    }
    updateMicGate()
  }

  const audio = new VoiceAudio({
    onMicFrame: (buffer) => connection.sendMic(buffer),
    onPlayer,
    onState: (state, detail) => {
      if (state === "error") {
        dispatch({ type: "local/audio", phase: "error", error: detail ?? "Audio failed." })
        void releaseAudio(true)
        return
      }
      dispatch({ type: "local/audio", phase: state })
    }
  })

  const connection: Connection = makeConnection({
    url: typeof location === "undefined" ? "ws://localhost:8787/ws" : resolveWsUrl(location),
    clientId: typeof sessionStorage === "undefined" ? "c-server-render" : makeClientId(),
    store,
    audio: {
      replyStart: (turnId, rate) => audio.replyStart(turnId, rate),
      replyFrame: (buffer) => audio.replyFrame(buffer),
      replyEnd: (turnId) => audio.replyEnd(turnId),
      replyStop: (turnId) => audio.replyStop(turnId, true),
      socketLost: () => audio.replyStop(undefined, false),
      running: () => audio.running
    },
    hooks: {
      afterWelcome: (resumed) => {
        if (resumed) {
          // The server assumes a live microphone on resume: tell it the truth.
          const s = store.get()
          connection.send({ type: "audio.config", interruptMode: s.audio.interruptMode, audio: audio.info() })
          connection.send({ type: "mic.state", live: s.audio.micLive })
        } else if (audio.running && store.get().session.role !== "owner") {
          // Someone else claimed the audio while we were away.
          void releaseAudio(false)
        }
      },
      afterMessage: (m, previousRole) => {
        if (m.type === "session" && previousRole === "owner" && m.role === "observer" && audio.running) {
          void releaseAudio(false) // taken over by another tab: close our microphone
        }
        if (m.type === "turn.end" && m.outcome === "interrupted") markInterrupted()
      }
    }
  })

  const releaseAudio = async (keepError: boolean) => {
    await audio.stop()
    if (!keepError) dispatch({ type: "local/audio", phase: "off" })
    dispatch({ type: "local/mic", live: true })
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
      // Audio is already open on this page (e.g. the server lost track of us): just claim it again.
      connection.resetMicSequence()
      connection.send({ type: "audio.claim", interruptMode: store.get().audio.interruptMode, audio: audio.info() })
      return
    }
    const p = prefs.get()
    dispatch({ type: "local/audio", phase: "starting" })
    // Synchronous up to the first await inside: the context is created and resumed in the gesture.
    const started = audio.start({
      micDeviceId: p.micDeviceId,
      sinkId: p.sinkId,
      outputPath: p.outputPath,
      prebufferMs: p.prebufferMs,
      processing: processingOf(p)
    })
    void started.then(
      (audioInfo) => {
        diagnostics.dispatch({ type: "mic", report: audio.micReport() })
        dispatch({ type: "local/mic", live: true })
        dispatch({ type: "local/audio", phase: audio.contextState === "running" ? "running" : "suspended" })
        connection.resetMicSequence()
        connection.send({ type: "audio.claim", interruptMode: store.get().audio.interruptMode, audio: audioInfo })
        requestWakeLock()
      },
      (error: unknown) => {
        // A failed retry of the device we stored: forget it so the next Start uses the default.
        if ((error as { name?: string }).name === "OverconstrainedError") prefs.dispatch({ micDeviceId: "" })
        dispatch({ type: "local/audio", phase: "error", error: describeMicError(error) })
      }
    )
  }

  const endAudio = () => {
    if (owner()) connection.send({ type: "audio.release" })
    releaseWakeLock()
    void releaseAudio(false)
  }

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
    if (patch.sinkId !== undefined && patch.sinkId !== before.sinkId) void audio.setSink(after.sinkId).catch(() => undefined)
    if (patch.micDeviceId !== undefined && patch.micDeviceId !== before.micDeviceId) {
      void audio.setMicDevice(after.micDeviceId).then(
        () => diagnostics.dispatch({ type: "mic", report: audio.micReport() }),
        (e: unknown) => {
          dispatch({ type: "local/toast", message: describeMicError(e), tone: "error" })
        }
      )
    }
    const processing = processingOf(after)
    const processingBefore = processingOf(before)
    if (
      processing.echoCancellation !== processingBefore.echoCancellation ||
      processing.noiseSuppression !== processingBefore.noiseSuppression ||
      processing.autoGainControl !== processingBefore.autoGainControl
    ) {
      void audio.setMicProcessing(processing).then(
        () => {
          diagnostics.dispatch({ type: "mic", report: audio.micReport() })
          if (owner() && audio.running) connection.send({ type: "audio.config", interruptMode: after.interruptMode as InterruptMode, audio: info() })
        },
        (e: unknown) => dispatch({ type: "local/toast", message: describeMicError(e), tone: "error" })
      )
    }
    if ((patch.interruptMode !== undefined || patch.outputPath !== undefined) && owner() && audio.running) {
      connection.send({ type: "audio.config", interruptMode: after.interruptMode as InterruptMode, audio: info() })
    }
  }

  // ---- Screen wake lock while this tab owns the audio ----
  let wakeLock: { release: () => Promise<void> } | undefined
  const requestWakeLock = () => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }
    void nav.wakeLock?.request("screen").then((l) => {
      wakeLock = l
    }, () => undefined)
  }
  const releaseWakeLock = () => {
    void wakeLock?.release().catch(() => undefined)
    wakeLock = undefined
  }

  const connect = () => {
    prefs.load()
    dispatch({ type: "local/interrupt-mode", mode: prefs.get().interruptMode })
    const stop = connection.start()
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !audio.running) return
      if (audio.contextState !== "running") void audio.resume().catch(() => undefined)
      if (owner()) requestWakeLock()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
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
      void audio.resume().then(() => dispatch({ type: "local/audio", phase: audio.contextState === "running" ? "running" : "suspended" }))
    },
    sendText,
    request: connection.request,
    enableModule: (moduleId, enabled) => connection.request({ type: enabled ? "module.enable" : "module.disable", moduleId }),
    configureModule: (moduleId, patch) => connection.request({ type: "module.configure", moduleId, patch }),
    updateSection: (sectionId, patch, confirmWarnings) =>
      connection.request({ type: "settings.update", sectionId, patch, ...(confirmWarnings === true ? { confirmWarnings: true } : {}) }),
    settings: (to, options = {}) => dispatch({ type: "local/ui", patch: navigateSettings(store.get().ui, to, options.discard === true) }),
    reloadEngines: () => connection.request({ type: "engine.reload" }),
    setupVault: (password) => connection.request({ type: "vault.setup", password }),
    unlockVault: (password) => connection.request({ type: "vault.unlock", password }),
    lockVault: () => connection.request({ type: "vault.lock" }),
    changeVaultPassword: (oldPassword, newPassword) => connection.request({ type: "vault.changePassword", oldPassword, newPassword }),
    moveFromEnv: (keys) => connection.request({ type: "settings.moveFromEnv", keys: [...keys] }),
    downloadModel: (tool, target) => connection.request({ type: "job.start", tool, action: "download", target }),
    cancelJob: (jobId) => connection.request({ type: "job.cancel", jobId }),
    deleteModel: (tool, target) => connection.request({ type: "model.delete", tool, target }),
    setPrefs,
    diagnostics,
    echoTest: async () => {
      if (!audio.running) throw new Error("Start audio first.")
      connection.setMicGate(false) // the server must not hear the test signal
      try {
        return await runEchoTest({
          play: (pcm, rate) => audio.playLocal(LOCAL_REPLY_ID, rate, pcm),
          micRms: () => levels.micRms,
          onPlayer: (f) => {
            localPlayback = f
          }
        })
      } finally {
        localPlayback = undefined
        updateMicGate()
      }
    }
  }
}
