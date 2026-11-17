import { type HostResult, type Llm, type Stt, type Tts, type VoiceRef } from "@pva/core"
import type { EngineInfo, EngineStatus, ResourceInfo, VoiceInfo } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { Cause, type Config, ConfigProvider, Deferred, Effect, Exit, Fiber, FiberSet, Schema, type Scope } from "effect"
import { AppConfig } from "../config.ts"

/**
 * The engine of serve mode (docs/UI-AND-MODULES.md §1.7, §4.5; docs/VOICE-SESSIONS.md §2; docs/ASSISTANTS.md §3.2):
 * since WP-11 it holds no provider. The language models, the voices and the recognisers are the resource pool's
 * (`Resources.ts`): built per configuration, and switched at a turn start (models, voices) or at the next silence
 * (a device's recogniser), never by this build. What remains is the **full reload** of §3.2 (the owner's Reload
 * button, and the reload that model directories and thread counts ask for): a scope that can be rebuilt in-process
 * (`reload`) while the HTTP server, the sockets, the module host and the voice sessions stay, which stops every
 * session's loop (keeping its history), rebuilds the pool's resources in use (`EngineOptions.resources.rebuild`) and
 * starts the loops again; and the engine status, which lists the pool's resources (`EngineStatus.resources`). It owns
 * no conversation: every voice session attaches its loop (`attach`), which runs on each build and is stopped when
 * the build ends. A build failure becomes `state: "failed"` with per-stage problems instead of exiting, so settings
 * stay editable from the UI.
 */

export class EngineBuildProblems extends Schema.TaggedError<EngineBuildProblems>()("EngineBuildProblems", {
  problems: Schema.Array(Schema.Struct({ stage: Schema.String, message: Schema.String }))
}) {}

/** What one engine build provides. */
export interface EngineProviders {
  /**
   * Tests only: one language model for every assistant (serve mode's pool then hands out instances that answer with
   * it, unless `ServeOptions.buildLlm` is given). The real builder leaves it out: language models are the pool's.
   */
  readonly llm?: Llm["Service"]
  /**
   * Tests only: one recogniser for every hearing place (serve mode's pool then hands out instances that hear with it,
   * unless `ServeOptions.buildStt` is given). The real builder leaves it out: recognisers are the pool's (WP-11).
   */
  readonly stt?: Stt["Service"]
  /**
   * Tests only: one voice for every assistant (serve mode's pool then hands out instances that speak with it, unless
   * `ServeOptions.buildTts` is given), and which voice it is. The real builder leaves both out: voices are the pool's.
   */
  readonly tts?: Tts["Service"]
  readonly voice?: VoiceRef
  readonly maxToolRounds: number
  readonly engines: ReadonlyArray<EngineInfo>
  readonly voiceInfo: ReadonlyArray<VoiceInfo>
}

/** Builds the providers, reading settings from the `ConfigProvider` it runs with. */
export type ProviderBuilder = Effect.Effect<EngineProviders, EngineBuildProblems, Scope.Scope>

const read = <A>(config: Config.Config<A>): Effect.Effect<A, Config.ConfigError> => Effect.gen(function*() {
  return yield* config
})

/**
 * The build of the real engines: nothing but the tool rounds' fallback (each assistant's `toolRounds` wins). The
 * language models, the voices and the recognisers are the pool's; serve mode adds their rows to the status
 * (`EngineOptions.describeEngines`).
 */
export const defaultProviderBuilder: ProviderBuilder = Effect.gen(function*() {
  const settings = yield* read(AppConfig).pipe(
    Effect.mapError((e) => new EngineBuildProblems({ problems: [{ stage: "conversation", message: e.message }] }))
  )
  return { maxToolRounds: settings.maxToolRounds, engines: [], voiceInfo: [] }
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
  /**
   * The resource pool (docs/ASSISTANTS.md §3.2): its resources are listed in every status (`EngineStatus.resources`),
   * and a full reload (`reload`) also rebuilds every resource in use (`rebuild`, started alongside the build and not
   * awaited by it; it interrupts nothing: each assistant switches at its next turn start once its new instance is ready).
   */
  readonly resources?: {
    readonly status: () => ReadonlyArray<ResourceInfo>
    readonly rebuild: Effect.Effect<void>
    /** The voices in use (`EngineStatus.voices`); the build's own list is used while none is. */
    readonly voices?: () => ReadonlyArray<VoiceInfo>
  }
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
  /** The output rate of this build's voice (tests that inject one voice); the pool's voices declare their own. */
  readonly sampleRate?: number
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
  /** The voice of the injected build (tests only; the real engines have none, voices are the pool's). */
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

    const view = (s: EngineStatus): EngineStatus => {
      // The pool's rows (models, voices, recognisers) are added while the engines run, though the build has none.
      const described = options.describeEngines === undefined || (s.engines.length === 0 && s.state !== "ready") ? s : { ...s, engines: options.describeEngines(s.engines) }
      if (options.resources === undefined) return described
      const pooled = options.resources.voices?.() ?? []
      const voices = pooled.length > 0 ? pooled : s.voices
      return { ...described, voices, resources: options.resources.status() }
    }
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
        current = { providers, ...(providers.tts !== undefined ? { sampleRate: providers.tts.sampleRate } : {}) }
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
        // The full reload rebuilds the pool's resources too (interrupting no turn); the reload does not wait for it.
        if (state === "reloading" && options.resources !== undefined) yield* Effect.forkIn(options.resources.rebuild, scope)
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
