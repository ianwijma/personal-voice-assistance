import { type HostResult, Llm, Stt, Tts, type VoiceRef, voiceKey } from "@pva/core"
import type { EngineInfo, EngineStatus, VoiceInfo } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { Cause, Config, ConfigProvider, Context, Deferred, Effect, Exit, Fiber, FiberSet, Schema, type Scope } from "effect"
import { AppConfig } from "../config.ts"
import { LlmLayer, SttLayer, ttsProviderInfo } from "../providers.ts"
import { buildStages } from "../startup.ts"
import { assistantVoice, ttsLayerFor, voiceEngineName, voiceLabel, voiceStageName } from "../voiceSelection.ts"

/**
 * The shared engines of serve mode (docs/UI-AND-MODULES.md §1.7, §4.5; docs/VOICE-SESSIONS.md §2): the providers
 * (language model, speech-to-text, voices), in one scope that can be rebuilt in-process (`reload`) while the HTTP
 * server, the sockets, the module host and the voice sessions stay. It owns no conversation: every voice session
 * attaches its loop (`attach`), which runs on each build and is stopped (keeping that session's history) when the
 * build ends. A build failure becomes `state: "failed"` with per-stage problems instead of exiting, so settings stay
 * editable from the UI.
 */

export class EngineBuildProblems extends Schema.TaggedError<EngineBuildProblems>()("EngineBuildProblems", {
  problems: Schema.Array(Schema.Struct({ stage: Schema.String, message: Schema.String }))
}) {}

/** What one engine build provides. */
export interface EngineProviders {
  /** The language model (for `claude-subscription`: the offline stand-in that answers while the agent is not running). */
  readonly llm: Llm["Service"]
  /** `LLM_PROVIDER` as built. Default (absent): a single-model conversation over `llm`. */
  readonly llmProvider?: string
  readonly stt: Stt["Service"]
  /** The assistant's voice (docs/VOICE-PROVIDERS.md): every reply is spoken with it; its rate is the output rate. */
  readonly tts: Tts["Service"]
  /** Which voice `tts` is. */
  readonly voice: VoiceRef
  readonly maxToolRounds: number
  readonly engines: ReadonlyArray<EngineInfo>
  readonly voiceInfo: ReadonlyArray<VoiceInfo>
}

/** Builds the providers, reading settings from the `ConfigProvider` it runs with. */
export type ProviderBuilder = Effect.Effect<EngineProviders, EngineBuildProblems, Scope.Scope>

const read = <A>(config: Config.Config<A>): Effect.Effect<A, Config.ConfigError> => Effect.gen(function*() {
  return yield* config
})
const configValue = <A>(config: Config.Config<A>, fallback: A): Effect.Effect<A> => Effect.orElseSucceed(read(config), () => fallback)

/** The providers selected by the settings, as the CLI builds them (the assistant's voice, LLM, STT). */
export const defaultProviderBuilder: ProviderBuilder = Effect.gen(function*() {
  const resolved = yield* assistantVoice
  if ("problem" in resolved) return yield* new EngineBuildProblems({ problems: [{ stage: voiceStageName, message: resolved.problem }] })
  for (const note of resolved.notes) yield* Effect.logWarning(note)
  const settings = yield* read(AppConfig).pipe(
    Effect.mapError((e) => new EngineBuildProblems({ problems: [{ stage: "conversation", message: e.message }] }))
  )
  const voice = resolved.ref
  const { context, problems } = yield* buildStages([
    { stage: voiceStageName, layer: ttsLayerFor(voice) },
    { stage: "language model (LLM_PROVIDER)", layer: LlmLayer },
    { stage: "speech-to-text (STT_PROVIDER)", layer: SttLayer }
  ])
  if (problems.length > 0) return yield* new EngineBuildProblems({ problems })

  const llmProvider = yield* configValue(Config.String("LLM_PROVIDER"), "fake")
  const sttProvider = yield* configValue(Config.String("STT_PROVIDER"), "sherpa")
  const location = (ttsProviderInfo as Record<string, { readonly location: "local" | "hosted" } | undefined>)[voice.provider]?.location ?? "hosted"
  const engines: Array<EngineInfo> = [
    {
      stage: "llm",
      provider: llmProvider,
      // claude-subscription: serve mode fills in the agent module's model (`EngineOptions.describeEngines`).
      detail: llmProvider === "anthropic"
        ? yield* configValue(Config.String("ANTHROPIC_MODEL"), "claude-haiku-5-5")
        : llmProvider === "claude-subscription"
        ? "Claude Code login"
        : "offline stand-in",
      location: llmProvider === "fake" ? "local" : "hosted"
    },
    {
      stage: "stt",
      provider: sttProvider,
      detail: sttProvider === "deepgram"
        ? yield* configValue(Config.String("DEEPGRAM_MODEL"), "flux-general-en")
        : yield* configValue(Config.String("STT_SHERPA_MODEL"), SherpaStt.DEFAULT_PRESET),
      location: sttProvider === "deepgram" ? "hosted" : "local"
    },
    // `detail` is the voice id: for `sherpa` the preset, which the Models page marks as in use.
    { stage: "tts", provider: voice.provider, detail: voice.voiceId, location }
  ]
  const voiceInfo: Array<VoiceInfo> = [{
    name: voiceKey(voice),
    description: voiceLabel(voice),
    enabled: true,
    isDefault: true,
    engine: voiceEngineName(voice),
    location
  }]
  return {
    llm: Context.get(context as Context.Context<Llm>, Llm),
    llmProvider,
    stt: Context.get(context as Context.Context<Stt>, Stt),
    tts: Context.get(context as Context.Context<Tts>, Tts),
    voice,
    maxToolRounds: settings.maxToolRounds,
    engines,
    voiceInfo
  }
})

/**
 * Cheap checks that can fail a reload before the running engines are stopped: a recogniser whose model
 * files are missing (the error names the download command) leaves the previous one running.
 */
export const defaultPreflight: Effect.Effect<void, EngineBuildProblems> = Effect.gen(function*() {
  const sttProvider = yield* configValue(Config.String("STT_PROVIDER"), "sherpa")
  if (sttProvider !== "sherpa") return
  yield* SherpaStt.checkConfig.pipe(
    Effect.mapError((e) => new EngineBuildProblems({ problems: [{ stage: "speech-to-text (STT_PROVIDER)", message: e.message }] }))
  )
})

export interface EngineOptions {
  readonly build: ProviderBuilder
  /** Run before a reload stops the running engines; a failure keeps them running. Default: none. */
  readonly preflight?: Effect.Effect<void, EngineBuildProblems>
  /** Environment over saved settings: what the providers read. Evaluated at every build. */
  readonly configProvider: () => ConfigProvider.ConfigProvider
  readonly onStatus: (status: EngineStatus) => void
  /** Adjust the engine list shown (live details such as an agent module's model). Applied on every status. */
  readonly describeEngines?: (engines: ReadonlyArray<EngineInfo>) => ReadonlyArray<EngineInfo>
  /** Reword build problems for the owner (a missing key while the key vault is locked). */
  readonly explainProblems?: (
    problems: ReadonlyArray<{ readonly stage: string; readonly message: string }>
  ) => ReadonlyArray<{ readonly stage: string; readonly message: string }>
  /**
   * For a build that failed for a reason that clears by itself: what to wait for before building again on its own
   * (`undefined`: no retry, the owner reloads). Default `retryWhenPreviousModelGone`.
   */
  readonly retryAfter?: (problems: ReadonlyArray<{ readonly stage: string; readonly message: string }>) => Effect.Effect<void> | undefined
  /**
   * A reason the engines must not be built now (the settings may come from two saves: `SettingsStore.blocked`).
   * While it is set, start and reload answer `engine_failed` and the status is `failed` with it as the problem.
   */
  readonly blocked?: () => { readonly stage: string; readonly message: string } | undefined
}

/** The engines of one build, as the voice sessions use them. */
export interface BuiltEngines {
  readonly providers: EngineProviders
  /** The output rate of this build (the assistant's voice's rate). */
  readonly sampleRate: number
}

/**
 * A voice session's loop on the shared engines (docs/VOICE-SESSIONS.md §2): `run` is started on every build while the
 * loop is attached and interrupted when the build ends (a reload, a failure, the server stopping). A failure that is
 * not an interruption stops the engines (as a recogniser that died does), reported as a speech-to-text problem.
 */
export interface SessionLoop {
  readonly run: (built: BuiltEngines) => Effect.Effect<void, unknown>
}

/**
 * A reload whose old local recogniser did not shut down in time (a native decode still running) cannot load a new
 * one beside it. The old engine is already closed by then, and was not working (its recogniser was stuck), so
 * instead of leaving the assistant without engines until a restart, the build is retried once that recogniser
 * has gone.
 */
export const retryWhenPreviousModelGone: NonNullable<EngineOptions["retryAfter"]> = (problems) =>
  problems.some((p) => SherpaStt.isOrphanedMessage(p.message)) ? Effect.promise(() => SherpaStt.whenNoOrphans()) : undefined

const RETRY_NOTE = {
  stage: "engines",
  message: "The engines will start by themselves once the previous speech model has shut down. If they do not, restart the assistant."
}

export interface Engine {
  readonly status: () => EngineStatus
  /** Build the engines (first start). Completes when they are ready or have failed. */
  readonly start: Effect.Effect<HostResult>
  /**
   * Like `start`, but does nothing (and answers ok) when the engines are already running. The check is made
   * inside the rebuild guard, so a caller that retries after `busy` can never rebuild engines that the
   * operation it waited for has just brought up (seventh review).
   */
  readonly startIfStopped: Effect.Effect<HostResult>
  /**
   * Stop every session's loop (running turns end interrupted), close the engines, rebuild them with the saved
   * settings, start every session's loop again (each keeps its own history and conversation id).
   */
  readonly reload: Effect.Effect<HostResult>
  /** Whether the engines are running (built, and no loop has failed). */
  readonly ready: () => boolean
  /** The engines of the running build. */
  readonly built: () => BuiltEngines | undefined
  /**
   * Run `loop` on the engines now (when they are running) and on every later build, until the returned effect
   * detaches it (and waits for its run to end).
   */
  readonly attach: (loop: SessionLoop) => Effect.Effect<void>
  /** Saved settings wait for a reload (`path`: the settings page they are on, for `reloadPendingFor`). */
  readonly setReloadPending: (pending: boolean, path?: string) => void
  /** The voice the running engines speak with (undefined while they are not running). */
  readonly voice: () => VoiceRef | undefined
  /** Announce the status again (`describeEngines` has something new to say). */
  readonly refreshStatus: () => void
}

export const makeEngine = (options: EngineOptions): Effect.Effect<Engine, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const runFork = yield* FiberSet.makeRuntime<never, void, unknown>()
    let status: EngineStatus = { state: "starting", problems: [], reloadPending: false, reloadPendingFor: [], engines: [], voices: [] }
    let fiber: Fiber.Fiber<void> | undefined
    let ready = false
    let busy = false
    let current: BuiltEngines | undefined
    /** Attached session loops, and the run of each on the current build. */
    const loops = new Set<SessionLoop>()
    const runs = new Map<SessionLoop, Fiber.Fiber<void, unknown>>()
    /** Completed by the first loop that fails (not by an interruption): the build then ends. */
    let loopFailed: Deferred.Deferred<Cause.Cause<unknown>> | undefined

    const view = (s: EngineStatus): EngineStatus =>
      options.describeEngines === undefined || s.engines.length === 0 ? s : { ...s, engines: options.describeEngines(s.engines) }
    const setStatus = (next: EngineStatus) => {
      status = next
      options.onStatus(view(next))
    }

    const startLoop = (loop: SessionLoop) => {
      const built = current
      const failed = loopFailed
      if (built === undefined || failed === undefined || runs.has(loop)) return
      const run = runFork(Effect.suspend(() => loop.run(built)).pipe(
        Effect.onError((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Deferred.succeed(failed, cause)))
      ))
      runs.set(loop, run)
      run.addObserver(() => {
        if (runs.get(loop) === run) runs.delete(loop)
      })
    }

    /** Interrupt every loop's run and wait for them to end (each keeps its history). Before the providers close. */
    const stopLoops = Effect.suspend(() => {
      const all = [...runs.values()]
      runs.clear()
      return Fiber.interruptAll(all)
    })

    const run = (latch: Deferred.Deferred<HostResult>): Effect.Effect<void> =>
      Effect.scoped(Effect.gen(function*() {
        const built = yield* options.build.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, options.configProvider()),
          Effect.result
        )
        if (built._tag === "Failure") {
          const explained = options.explainProblems?.(built.failure.problems) ?? built.failure.problems
          const retry = (options.retryAfter ?? retryWhenPreviousModelGone)(built.failure.problems)
          const problems = retry === undefined ? explained : [...explained, RETRY_NOTE]
          setStatus({ ...status, state: "failed", problems, engines: [], voices: status.voices })
          const message = `The engines could not start: ${problems.map((p) => `${p.stage}: ${p.message}`).join("; ")}`
          yield* Effect.logError(message)
          if (retry !== undefined) {
            // Outside this build's scope (which ends now); a reload by the owner meanwhile makes this one `busy`.
            yield* retry.pipe(
              Effect.andThen(Effect.suspend(() => (status.state === "failed" ? launch("starting") : Effect.void))),
              Effect.forkIn(scope)
            )
          }
          yield* Deferred.succeed(latch, { ok: false, error: { code: "engine_failed", message } })
          return
        }
        const providers = built.success
        // Added after the providers' finalizers, so it runs before them: the loops end while their engines still work.
        yield* Effect.addFinalizer(() =>
          Effect.andThen(Effect.sync(() => {
            ready = false
            current = undefined
            loopFailed = undefined
          }), stopLoops)
        )
        const failed = yield* Deferred.make<Cause.Cause<unknown>>()
        current = { providers, sampleRate: providers.tts.sampleRate }
        loopFailed = failed
        ready = true
        setStatus({ state: "ready", problems: [], reloadPending: false, reloadPendingFor: [], engines: providers.engines, voices: providers.voiceInfo })
        for (const loop of loops) startLoop(loop)
        yield* Deferred.succeed(latch, { ok: true })

        // Until the build is interrupted (reload, stop) or a loop fails; the finalizer above then stops the others.
        const cause = yield* Deferred.await(failed)
        ready = false
        const squashed = Cause.squash(cause)
        const text = squashed instanceof Error ? squashed.message : String(squashed)
        yield* Effect.logError("The voice loop stopped", cause)
        setStatus({ ...status, state: "failed", problems: [{ stage: "speech-to-text", message: text }] })
      })).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            ready = false
            current = undefined
          })
        )
      )

    const busyResult: HostResult = { ok: false, error: { code: "busy", message: "The engines are already being rebuilt" } }

    /** The rebuild itself; runs only while holding the guard. */
    const rebuild = (state: "starting" | "reloading") =>
      Effect.gen(function*() {
        const blocked = options.blocked?.()
        if (blocked !== undefined && !ready) {
          setStatus({ ...status, state: "failed", problems: [blocked], engines: [] })
          return { ok: false, error: { code: "engine_failed", message: `${blocked.stage}: ${blocked.message}` } } as HostResult
        }
        if (state === "reloading" && options.preflight !== undefined && ready) {
          const checked = yield* options.preflight.pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, options.configProvider()),
            Effect.result
          )
          if (checked._tag === "Failure") {
            const message = `The engines were not reloaded (the running ones are kept): ${
              checked.failure.problems.map((p) => `${p.stage}: ${p.message}`).join("; ")
            }`
            yield* Effect.logError(message)
            return { ok: false, error: { code: "engine_failed", message } } as HostResult
          }
        }
        setStatus({ ...status, state })
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber)
          fiber = undefined
        }
        const latch = yield* Deferred.make<HostResult>()
        const built = yield* run(latch).pipe(Effect.forkIn(scope))
        fiber = built
        // However the build ends (failure, defect, interruption, even before it started), the request is answered.
        yield* Fiber.await(built).pipe(
          Effect.andThen((exit) => {
            const message = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? `The engines stopped while starting: ${String(Cause.squash(exit.cause))}`
              : "The engine build was stopped before it finished"
            return Deferred.succeed(latch, { ok: false, error: { code: "engine_failed", message } }).pipe(
              Effect.map((unanswered) => {
                if (unanswered) setStatus({ ...status, state: "failed", problems: [{ stage: "engines", message }], engines: [] })
              })
            )
          }),
          Effect.forkIn(scope)
        )
        return yield* Deferred.await(latch)
      })

    /**
     * One rebuild at a time. The guard is taken synchronously (before the preflight, which may wait) and only
     * the call that took it releases it, so a refused call can never let a third one interrupt the running build.
     */
    const launch = (state: "starting" | "reloading", needed: () => boolean = () => true): Effect.Effect<HostResult> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (busy) return Effect.succeed(busyResult)
          // Decided in the same synchronous step as taking the guard: nothing can run in between.
          if (!needed()) return Effect.succeed<HostResult>({ ok: true })
          busy = true
          return restore(rebuild(state)).pipe(Effect.ensuring(Effect.sync(() => {
            busy = false
          })))
        })
      )

    return {
      status: () => view(status),
      refreshStatus: () => options.onStatus(view(status)),
      start: launch("starting"),
      startIfStopped: launch("starting", () => !ready),
      reload: launch("reloading"),
      ready: () => ready,
      built: () => (ready ? current : undefined),
      attach: (loop) => {
        loops.add(loop)
        if (ready) startLoop(loop)
        return Effect.suspend(() => {
          loops.delete(loop)
          const run = runs.get(loop)
          runs.delete(loop)
          return run === undefined ? Effect.void : Fiber.interrupt(run)
        })
      },
      setReloadPending: (pending, path) => {
        const before = status.reloadPendingFor ?? []
        const pages = !pending ? [] : path === undefined || before.includes(path) ? before : [...before, path]
        if (status.reloadPending !== pending || pages.length !== before.length) {
          setStatus({ ...status, reloadPending: pending, reloadPendingFor: pages })
        }
      },
      voice: () => (ready ? current?.providers.voice : undefined)
    } satisfies Engine
  })
