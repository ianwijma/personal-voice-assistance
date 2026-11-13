import {
  type AudioInput,
  AudioOutput,
  type ConversationEvent,
  type ConversationInput,
  type HostResult,
  Llm,
  makeConversationWithSetup,
  makeVoiceRouter,
  type Message,
  Stt,
  type SttEvent,
  Tts,
  type TurnSetup,
  TurnTrace,
  type Voice
} from "@pva/core"
import type { EngineInfo, EngineStatus, VoiceInfo } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Cause, Config, ConfigProvider, Context, Deferred, Effect, Exit, Fiber, Queue, Schema, type Scope, Stream } from "effect"
import { AppConfig } from "../config.ts"
import { LlmLayer, SttLayer } from "../providers.ts"
import { buildStages } from "../startup.ts"
import { builtVoices, loadVoiceSettings, providerOf, voiceCatalog, voiceConfigProvider, voiceStages } from "../voices.ts"

/**
 * The engines of serve mode (docs/UI-AND-MODULES.md §1.7, §4.5): providers
 * (voices → router), the `Conversation` and the voice loop, in one scope that
 * can be rebuilt in-process (`reload`) while the HTTP server, the sockets, the
 * module host and the audio owner stay. The conversation history is carried
 * over. A build failure becomes `state: "failed"` with per-stage problems
 * instead of exiting, so settings stay editable from the UI.
 */

export class EngineBuildProblems extends Schema.TaggedError<EngineBuildProblems>()("EngineBuildProblems", {
  problems: Schema.Array(Schema.Struct({ stage: Schema.String, message: Schema.String }))
}) {}

/** What one engine build provides. */
export interface EngineProviders {
  readonly llm: Llm["Service"]
  readonly stt: Stt["Service"]
  /** The enabled voices. */
  readonly voices: ReadonlyArray<Voice>
  /** The default voice at build time; its rate is the output rate until the next build. */
  readonly defaultVoice: string
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

/** "Piper" or "Kokoro" for a sherpa voice preset (shown in the UI's voice list). */
const sherpaEngineName = (preset: string) =>
  SherpaTts.presets[preset]?.engine === "kokoro" ? "Kokoro" : SherpaTts.presets[preset]?.engine === "piper" ? "Piper" : "Local"

/** The providers selected by the settings, as the CLI builds them (one stage per voice, LLM, STT). */
export const defaultProviderBuilder: ProviderBuilder = Effect.gen(function*() {
  const voices = yield* loadVoiceSettings.pipe(
    Effect.mapError((e) => new EngineBuildProblems({ problems: [{ stage: "voices (VOICES, DEFAULT_VOICE)", message: e.message }] }))
  )
  const settings = yield* read(AppConfig).pipe(
    Effect.mapError((e) => new EngineBuildProblems({ problems: [{ stage: "conversation", message: e.message }] }))
  )
  const { context, problems } = yield* buildStages([
    ...voiceStages(voices),
    { stage: "language model (LLM_PROVIDER)", layer: LlmLayer },
    { stage: "speech-to-text (STT_PROVIDER)", layer: SttLayer }
  ])
  if (problems.length > 0) return yield* new EngineBuildProblems({ problems })

  const base = yield* ConfigProvider.ConfigProvider
  const llmProvider = yield* configValue(Config.String("LLM_PROVIDER"), "fake")
  const sttProvider = yield* configValue(Config.String("STT_PROVIDER"), "sherpa")
  const engines: Array<EngineInfo> = [
    {
      stage: "llm",
      provider: llmProvider,
      detail: llmProvider === "anthropic" ? yield* configValue(Config.String("ANTHROPIC_MODEL"), "claude-haiku-5-5") : "offline stand-in",
      location: llmProvider === "anthropic" ? "hosted" : "local"
    },
    {
      stage: "stt",
      provider: sttProvider,
      detail: sttProvider === "deepgram"
        ? yield* configValue(Config.String("DEEPGRAM_MODEL"), "flux-general-en")
        : yield* configValue(Config.String("STT_SHERPA_MODEL"), SherpaStt.DEFAULT_PRESET),
      location: sttProvider === "deepgram" ? "hosted" : "local"
    }
  ]
  const voiceInfo: Array<VoiceInfo> = []
  for (const voice of voiceCatalog) {
    const provider = yield* configValue(providerOf(voice), "sherpa")
    const detail = yield* (provider === "sherpa"
      ? configValue(Config.String("TTS_SHERPA_PRESET"), SherpaTts.DEFAULT_PRESET)
      : configValue(Config.String("CARTESIA_MODEL"), "sonic")).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, voiceConfigProvider(base, voice))
      )
    const enabled = voices.enabled.some((v) => v.name === voice.name)
    const location = provider === "sherpa" ? "local" : "hosted"
    voiceInfo.push({
      name: voice.name,
      description: voice.description,
      enabled,
      isDefault: voice.name === voices.defaultVoice,
      engine: `${provider === "sherpa" ? sherpaEngineName(detail) : "Cartesia"} ${detail}`,
      location
    })
    if (enabled) engines.push({ stage: "tts", provider, detail: `${voice.name}: ${detail}`, location })
  }
  return {
    llm: Context.get(context as Context.Context<Llm>, Llm),
    stt: Context.get(context as Context.Context<Stt>, Stt),
    voices: builtVoices(context, voices),
    defaultVoice: voices.defaultVoice,
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
  readonly input: AudioInput["Service"]
  readonly output: AudioOutput["Service"]
  readonly turnTrace: TurnTrace["Service"]
  /** The turn setup (system prompt and tools), read at the start of each turn. */
  readonly setup: Effect.Effect<TurnSetup>
  readonly onEvent: (event: ConversationEvent) => void
  /** The recognition stream on its way to the conversation (echo gate, transcript, state). */
  readonly gate: (events: Stream.Stream<SttEvent, unknown>) => Stream.Stream<SttEvent, unknown>
  /** The default voice chosen in the settings now (live). */
  readonly defaultVoice: () => string
  readonly onStatus: (status: EngineStatus) => void
}

export interface Engine {
  readonly status: () => EngineStatus
  /** Build the engines (first start). Completes when they are ready or have failed. */
  readonly start: Effect.Effect<HostResult>
  /** Interrupt the running turn, close the engines, rebuild them with the saved settings, keep the history. */
  readonly reload: Effect.Effect<HostResult>
  /** Typed text or Stop. False when the engines are not running. */
  readonly send: (input: ConversationInput) => boolean
  readonly history: Effect.Effect<ReadonlyArray<Message>>
  readonly setReloadPending: (pending: boolean) => void
  /** The enabled voices and the default voice in effect, while the engines run. */
  readonly voices: () => { readonly names: ReadonlyArray<Voice>; readonly defaultVoice: string } | undefined
}

export const makeEngine = (options: EngineOptions): Effect.Effect<Engine, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Effect.scope
    const control = yield* Queue.unbounded<ConversationInput>()
    let status: EngineStatus = { state: "starting", problems: [], reloadPending: false, engines: [], voices: [] }
    let fiber: Fiber.Fiber<void> | undefined
    let conversationHistory: Effect.Effect<ReadonlyArray<Message>> | undefined
    let history: ReadonlyArray<Message> = []
    let ready = false
    let busy = false
    let running: { readonly voices: ReadonlyArray<Voice>; router: Tts["Service"]; defaultVoice: string; readonly sampleRate: number } | undefined

    const setStatus = (next: EngineStatus) => {
      status = next
      options.onStatus(next)
    }

    /** The router for the default voice in effect: rebuilt (cheaply, engines untouched) when the setting changes. */
    const currentRouter = () => {
      const r = running!
      const wanted = options.defaultVoice()
      if (wanted !== r.defaultVoice && r.voices.some((v) => v.name === wanted)) {
        r.router = makeVoiceRouter({ voices: r.voices, defaultVoice: wanted, sampleRate: r.sampleRate })
        r.defaultVoice = wanted
      }
      return r
    }

    const run = (latch: Deferred.Deferred<HostResult>) =>
      Effect.scoped(Effect.gen(function*() {
        const built = yield* options.build.pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, options.configProvider()),
          Effect.result
        )
        if (built._tag === "Failure") {
          setStatus({ ...status, state: "failed", problems: built.failure.problems, engines: [], voices: status.voices })
          const message = `The engines could not start: ${built.failure.problems.map((p) => `${p.stage}: ${p.message}`).join("; ")}`
          yield* Effect.logError(message)
          yield* Deferred.succeed(latch, { ok: false, error: { code: "engine_failed", message } })
          return
        }
        const providers = built.success
        const router = makeVoiceRouter({ voices: providers.voices, defaultVoice: providers.defaultVoice })
        running = { voices: providers.voices, router, defaultVoice: providers.defaultVoice, sampleRate: router.sampleRate }
        const tts = Tts.of({
          sampleRate: router.sampleRate,
          synthesize: (clauses) => Stream.suspend(() => currentRouter().router.synthesize(clauses))
        })
        const conversation = yield* makeConversationWithSetup({
          setup: options.setup,
          onEvent: options.onEvent,
          initialHistory: history,
          maxToolRounds: providers.maxToolRounds,
          bargeIn: true
        }).pipe(Effect.provideService(Llm, providers.llm), Effect.provideService(TurnTrace, options.turnTrace))
        conversationHistory = conversation.history
        yield* Queue.clear(control)
        ready = true
        setStatus({ state: "ready", problems: [], reloadPending: false, engines: providers.engines, voices: providers.voiceInfo })
        yield* Deferred.succeed(latch, { ok: true })

        const events = Stream.merge(
          options.gate(providers.stt.transcribe(options.input.stream)),
          Stream.fromQueue(control)
        )
        const exit = yield* conversation.voice(events).pipe(
          Effect.provideService(Tts, tts),
          Effect.provideService(AudioOutput, options.output),
          Effect.exit
        )
        ready = false
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          const message = Cause.squash(exit.cause)
          const text = message instanceof Error ? message.message : String(message)
          yield* Effect.logError("The voice loop stopped", exit.cause)
          setStatus({ ...status, state: "failed", problems: [{ stage: "speech-to-text", message: text }] })
        }
      })).pipe(
        Effect.onExit(() =>
          Effect.sync(() => {
            ready = false
            running = undefined
          })
        )
      )

    const launch = (state: "starting" | "reloading") =>
      Effect.gen(function*() {
        if (busy) return { ok: false, error: { code: "busy", message: "The engines are already being rebuilt" } } as HostResult
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
        busy = true
        setStatus({ ...status, state })
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber)
          fiber = undefined
        }
        if (conversationHistory !== undefined) {
          history = yield* conversationHistory
          conversationHistory = undefined
        }
        const latch = yield* Deferred.make<HostResult>()
        fiber = yield* run(latch).pipe(Effect.forkIn(scope))
        return yield* Deferred.await(latch)
      }).pipe(Effect.ensuring(Effect.sync(() => {
        busy = false
      })))

    return {
      status: () => status,
      start: launch("starting"),
      reload: launch("reloading"),
      send: (input) => ready && Queue.offerUnsafe(control, input),
      history: Effect.suspend(() => conversationHistory ?? Effect.succeed(history)),
      setReloadPending: (pending) => {
        if (status.reloadPending !== pending) setStatus({ ...status, reloadPending: pending })
      },
      voices: () => running === undefined ? undefined : { names: running.voices, defaultVoice: currentRouter().defaultVoice }
    } satisfies Engine
  })
