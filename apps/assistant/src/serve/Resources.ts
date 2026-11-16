import { CurrentTurnTrace, Llm, LlmError, type Stt, SttError, Tts, TtsError, type VoiceRef, voiceKey } from "@pva/core"
import { DEFAULT_BASE_URL } from "@pva/llm-anthropic"
import type { AssistantHearing, AssistantLlm, LlmAccountId, ResourceInfo } from "@pva/protocol"
import * as DeepgramStt from "@pva/stt-deepgram"
import * as SherpaStt from "@pva/stt-sherpa"
import * as SherpaTts from "@pva/tts-sherpa"
import { Cause, Config, ConfigProvider, Context, Deferred, Effect, Exit, FiberSet, Layer, Schema, Scope, Stream } from "effect"
import { hasLlmAccountLayer, isTtsProvider, llmAccountLayers, ttsProviderInfo } from "../providers.ts"
import { describeStartFailure } from "../startup.ts"
import { ttsLayerFor, voiceConfigProvider, voiceEngineName } from "../voiceSelection.ts"

/**
 * The resource pool of serve mode (docs/ASSISTANTS.md §3.2, WP-9): shared resources keyed by their configuration,
 * built for the assistants in use and released after a grace period once nobody uses them. Two assistants with the
 * same configuration share one instance. A changed configuration builds the new instance first; each assistant
 * switches to it once it is ready, at its next turn start (`llmFor` is read by the turn's setup), and the old one
 * stays for the turns still running on it. One build failing is a problem of that resource only.
 *
 * Scope: language models (WP-9; the accounts `offline`, `anthropic` and the offline stand-in of
 * `claude-subscription`; `openrouter` and `home-model` report a problem until WP-13b), voices (WP-10: one `Tts`
 * per distinct voice, keyed by `voiceKey`; the voices of one local engine share it) and recognisers (WP-11: one per
 * `SttKey`, bound per hearing *place* (a device, or a device type's defaults) rather than per assistant, with the
 * place's hearer's stream options outside the key; `sttFor`).
 */

/** What an instance of a language model is built from: the assistant's `llm` fields the account reads, and its address. */
export interface LlmSpec {
  readonly account: LlmAccountId
  readonly model: string
  readonly effort: AssistantLlm["effort"]
  readonly thinking: AssistantLlm["thinking"]
  readonly maxTokens: number
  readonly giveUpMs: number
  readonly warmUp: boolean
  /** The account's address (`anthropic`: ANTHROPIC_BASE_URL). Part of the key. */
  readonly address?: string
  /**
   * A stamp of the account's key (a hash, never the key; "" when none is set): a new key makes a new instance. Part
   * of the instance's identity, not of the key shown in the status.
   */
  readonly credential?: string
}

/** The shared account settings an `LlmSpec` takes besides the assistant's own fields. */
export interface LlmAccounts {
  readonly anthropic?: { readonly address?: string | undefined; readonly credential?: string | undefined }
}

/**
 * An assistant's `llm` as the pool keys it. Only what the account's adapter reads counts: the offline stand-ins
 * (`offline`, and `claude-subscription`'s, whose agent is the module's) ignore the model fields, so every assistant
 * on them shares one instance.
 */
export const llmSpecOf = (llm: AssistantLlm, accounts: LlmAccounts = {}): LlmSpec => {
  if (llm.account !== "anthropic") {
    return { account: llm.account, model: llm.account === "offline" || llm.account === "claude-subscription" ? "" : llm.model, effort: "low", thinking: "off", maxTokens: 1024, giveUpMs: 5000, warmUp: false }
  }
  const address = accounts.anthropic?.address
  const credential = accounts.anthropic?.credential
  return {
    account: "anthropic",
    model: llm.model,
    effort: llm.effort,
    thinking: llm.thinking,
    maxTokens: llm.maxTokens,
    giveUpMs: llm.giveUpMs,
    warmUp: llm.warmUp,
    address: address === undefined || address === "" ? DEFAULT_BASE_URL : address,
    ...(credential !== undefined ? { credential } : {})
  }
}

/** An address without what may be secret in it (user info, query), for keys and labels. */
const shownAddress = (address: string): string => {
  try {
    const url = new URL(address)
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`
  } catch {
    return "(invalid address)"
  }
}

/** `LlmKey` (docs/ASSISTANTS.md §3.2): account + model + effort + thinking + maxTokens + giveUpMs + warmUp (+ address). */
export const llmKeyOf = (spec: LlmSpec): string =>
  spec.account === "anthropic"
    ? [
      spec.account,
      spec.model,
      spec.effort,
      `thinking-${spec.thinking}`,
      `${spec.maxTokens}tok`,
      `${spec.giveUpMs}ms`,
      spec.warmUp ? "warm" : "cold",
      shownAddress(spec.address ?? DEFAULT_BASE_URL)
    ].join("|")
    : spec.model === ""
    ? spec.account
    : `${spec.account}|${spec.model}`

/** The instance's identity: its key plus what is not shown (the full address, the key stamp). */
const identityOf = (spec: LlmSpec): string => `${llmKeyOf(spec)}\u0000${spec.address ?? ""}\u0000${spec.credential ?? ""}`

const accountLabels: Readonly<Record<LlmAccountId, string>> = {
  offline: "Offline stand-in",
  anthropic: "Claude API",
  "claude-subscription": "Claude subscription (offline stand-in while the agent is not running)",
  openrouter: "OpenRouter",
  "home-model": "Home model"
}

export const llmLabelOf = (spec: LlmSpec): string =>
  spec.account === "anthropic" ? `Claude API ${spec.model} (${spec.effort} effort, thinking ${spec.thinking}, ${spec.maxTokens} tokens)` : accountLabels[spec.account] + (spec.model === "" ? "" : ` ${spec.model}`)

/**
 * The settings an account's adapter reads, from the spec (a `ConfigProvider` over the shared settings: the adapters
 * stay unchanged). The key itself is not here: it comes from the shared settings (vault or environment).
 */
export const llmConfigOf = (spec: LlmSpec): Record<string, string> =>
  spec.account === "anthropic"
    ? {
      ANTHROPIC_MODEL: spec.model,
      ANTHROPIC_EFFORT: spec.effort,
      ANTHROPIC_THINKING: spec.thinking === "adaptive" ? "adaptive" : "disabled",
      ANTHROPIC_MAX_TOKENS: String(spec.maxTokens),
      ANTHROPIC_TIMEOUT_MS: String(spec.giveUpMs),
      ANTHROPIC_WARM_UP: spec.warmUp ? "true" : "false",
      ...(spec.address !== undefined ? { ANTHROPIC_BASE_URL: spec.address } : {})
    }
    : {}

export class ResourceBuildError extends Schema.TaggedError<ResourceBuildError>()("ResourceBuildError", { message: Schema.String }) {}

/** Builds one language-model instance in the scope it is given (closed when the pool releases the instance). */
export type LlmBuilder = (spec: LlmSpec) => Effect.Effect<Llm["Service"], ResourceBuildError, Scope.Scope>

/** The accounts' layers of `providers.ts`, each over `configProvider()` with the spec's own values on top. */
export const defaultLlmBuilder = (configProvider: () => ConfigProvider.ConfigProvider): LlmBuilder => (spec) =>
  Effect.gen(function*() {
    if (!hasLlmAccountLayer(spec.account)) {
      return yield* new ResourceBuildError({ message: `The ${accountLabels[spec.account]} account is not available yet.` })
    }
    const provider = ConfigProvider.orElse(ConfigProvider.fromEnvRecord(llmConfigOf(spec)), configProvider())
    const context = yield* Layer.build(llmAccountLayers[spec.account] as Layer.Layer<Llm, Config.ConfigError>).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.mapError((e) => new ResourceBuildError({ message: describeStartFailure(e) }))
    )
    return Context.get(context, Llm)
  })

// ---- Voices (docs/ASSISTANTS.md §3.2, WP-10)

/** What an instance of a voice is built from: the voice, and a stamp of its provider's key. */
export interface TtsSpec {
  readonly voice: VoiceRef
  /**
   * A stamp of the provider's key (a hash, never the key; "" when none is set; local voices have none): a new key
   * makes a new instance. Part of the instance's identity, not of the key shown in the status.
   */
  readonly credential?: string
}

/** The shared provider settings a `TtsSpec` takes besides the assistant's own voice. */
export interface TtsAccounts {
  /** The key stamp of each hosted provider (`cartesia`, `elevenlabs`). */
  readonly credentials?: Readonly<Record<string, string>>
}

/** An assistant's `voice` as the pool keys it. */
export const ttsSpecOf = (voice: VoiceRef, accounts: TtsAccounts = {}): TtsSpec => {
  const credential = accounts.credentials?.[voice.provider]
  return { voice: { provider: voice.provider, voiceId: voice.voiceId }, ...(credential !== undefined ? { credential } : {}) }
}

/** `TtsKey` (docs/ASSISTANTS.md §3.2): `voiceKey(voice)`, `provider:voiceId`. */
export const ttsKeyOf = (spec: TtsSpec): string => voiceKey(spec.voice)

const ttsIdentityOf = (spec: TtsSpec): string => `${ttsKeyOf(spec)}\u0000${spec.credential ?? ""}`

export const ttsLabelOf = (spec: TtsSpec): string => `Voice ${voiceEngineName(spec.voice)}`

const ttsLocationOf = (spec: TtsSpec): "local" | "hosted" =>
  isTtsProvider(spec.voice.provider) ? ttsProviderInfo[spec.voice.provider].location : "hosted"

/** Builds one voice instance in the scope it is given (closed when the pool releases the instance). */
export type TtsBuilder = (spec: TtsSpec) => Effect.Effect<Tts["Service"], ResourceBuildError, Scope.Scope>

interface EngineSlot {
  refs: number
  readonly scope: Scope.Closeable
  readonly ready: Deferred.Deferred<SherpaTts.SharedEngine, TtsError>
}

/**
 * The voices of `providers.ts`, each over `configProvider()` with the voice's id on top (`voiceSelection.ts`). A
 * voice on this machine runs on an engine (a child process holding the model): the voices that can share one (every
 * Kokoro speaker of the same set-up and options, `SherpaTts.engineSetup`) do, one engine counted by the instances on
 * it and stopped with the last (a Piper voice is an engine of its own). The engine runs one clause at a time, so two
 * assistants speaking at once on one Kokoro engine take turns clause by clause.
 */
export const defaultTtsBuilder = (
  configProvider: () => ConfigProvider.ConfigProvider,
  /** Tests: starts an engine (default `SherpaTts.makeShared`, a child process holding the model). */
  makeShared: (options: SherpaTts.SherpaTtsOptions) => Effect.Effect<SherpaTts.SharedEngine, TtsError, Scope.Scope> = SherpaTts.makeShared
): TtsBuilder => {
  const slots = new Map<string, EngineSlot>()

  /** The engine for `key`, built in a scope of its own by the first instance that needs it; released with the last. */
  const engineFor = (key: string, options: SherpaTts.SherpaTtsOptions): Effect.Effect<SherpaTts.SharedEngine, TtsError, Scope.Scope> =>
    Effect.gen(function*() {
      const joined = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const existing = slots.get(key)
          if (existing !== undefined) {
            existing.refs++
            return { slot: existing, builder: false }
          }
          const slot: EngineSlot = { refs: 1, scope: Effect.runSync(Scope.make()), ready: Deferred.makeUnsafe() }
          slots.set(key, slot)
          return { slot, builder: true }
        }),
        ({ slot }) =>
          Effect.suspend(() => {
            if (--slot.refs > 0) return Effect.void
            if (slots.get(key) === slot) slots.delete(key)
            return Scope.close(slot.scope, Exit.void)
          })
      )
      if (joined.builder) {
        yield* Scope.provide(makeShared(options), joined.slot.scope).pipe(
          Effect.onExit((exit) =>
            Effect.suspend(() => {
              if (Exit.isSuccess(exit)) return Deferred.done(joined.slot.ready, exit)
              // A failed engine is not kept: the next instance that wants one starts a new engine.
              if (slots.get(key) === joined.slot) slots.delete(key)
              const failure = Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? Cause.squash(exit.cause) : undefined
              const error = failure instanceof TtsError ? failure : new TtsError({ message: "The voice engine did not start." })
              return Effect.andThen(Deferred.fail(joined.slot.ready, error), Scope.close(joined.slot.scope, Exit.void))
            })
          ),
          Effect.uninterruptible
        )
      }
      return yield* Deferred.await(joined.slot.ready)
    })

  return (spec) =>
    Effect.gen(function*() {
      const { voice } = spec
      if (!isTtsProvider(voice.provider)) {
        return yield* new ResourceBuildError({ message: `There is no voice provider "${voice.provider}".` })
      }
      const provider = voiceConfigProvider(configProvider(), voice)
      if (voice.provider !== "sherpa") {
        const context = yield* Layer.build(ttsLayerFor(voice) as Layer.Layer<Tts, Config.ConfigError>).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider()),
          Effect.mapError((e) => new ResourceBuildError({ message: describeStartFailure(e) }))
        )
        return Context.get(context, Tts)
      }
      const options = yield* Effect.gen(function*() {
        return yield* SherpaTts.config()
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
        Effect.mapError((e) => new ResourceBuildError({ message: describeStartFailure(e) }))
      )
      const preset = Object.hasOwn(SherpaTts.presets, options.preset ?? "") ? SherpaTts.presets[options.preset!] : undefined
      if (preset === undefined) return yield* new ResourceBuildError({ message: `There is no voice "${voice.voiceId}" on this machine.` })
      const { preset: _, ...rest } = options
      const key = `${SherpaTts.engineSetup(preset)}\u0000${JSON.stringify(rest)}`
      const engine = yield* engineFor(key, options).pipe(Effect.mapError((e) => new ResourceBuildError({ message: e.message })))
      const tts = engine.forPreset(preset.name)
      if (tts === undefined) return yield* new ResourceBuildError({ message: `The voice "${voice.voiceId}" cannot be spoken by its engine.` })
      return tts
    })
}

// ---- Recognisers (docs/ASSISTANTS.md §3.2, §3.5, WP-11)

/**
 * The per-stream share of a hearing (docs/ASSISTANTS.md §1.2: turn timing, VAD and gain on this machine; Deepgram's
 * end-of-turn confidences): not part of the key, so two hearers that differ only here share one instance.
 */
export interface SttStreamSpec {
  readonly eagerSilenceMs: number
  readonly finalSilenceMs: number
  readonly minSpeechMs: number
  readonly vadThreshold: number
  readonly agc: boolean
  readonly agcMaxGainDb: number
  readonly eotThreshold: number
  readonly eagerEotThreshold: number
  readonly eotTimeoutMs: number
}

/** What a recogniser instance is built from (the `SttKey`), plus the stream options of the hearer that wants it. */
export interface SttSpec {
  readonly engine: AssistantHearing["engine"]
  /** A stt-sherpa preset name; for Deepgram, the shared DEEPGRAM_MODEL. */
  readonly model: string
  /** stt-sherpa: the language, "" for a model that takes none (so it does not split the key). Deepgram: "". */
  readonly language: string
  /** stt-sherpa: the shared STT_SHERPA_MODEL_DIR and STT_SHERPA_THREADS (`undefined`: the defaults). */
  readonly modelDir?: string
  readonly threads?: number
  /** Deepgram: the address (DEEPGRAM_URL) and a stamp of the key (a hash, never the key). Part of the identity. */
  readonly address?: string
  readonly credential?: string
  readonly stream: SttStreamSpec
}

/** The shared settings a recogniser takes besides the hearer's own (§2.4 "Speech recognition models"). */
export interface SttShared {
  readonly modelDir?: string | undefined
  readonly threads?: number | undefined
  readonly deepgram?: { readonly model?: string | undefined; readonly address?: string | undefined; readonly credential?: string | undefined }
}

export const DEFAULT_DEEPGRAM_MODEL = "flux-general-en"

/** A hearer's `hearing` as the pool keys it. */
export const sttSpecOf = (hearing: AssistantHearing, shared: SttShared = {}): SttSpec => {
  const stream: SttStreamSpec = {
    eagerSilenceMs: hearing.eagerSilenceMs,
    finalSilenceMs: hearing.finalSilenceMs,
    minSpeechMs: hearing.minSpeechMs,
    vadThreshold: hearing.vadThreshold,
    agc: hearing.agc,
    agcMaxGainDb: hearing.agcMaxGainDb,
    eotThreshold: hearing.deepgram.eotThreshold,
    eagerEotThreshold: hearing.deepgram.eagerEotThreshold,
    eotTimeoutMs: hearing.deepgram.eotTimeoutMs
  }
  if (hearing.engine === "deepgram") {
    const d = shared.deepgram ?? {}
    return {
      engine: "deepgram",
      model: d.model === undefined || d.model === "" ? DEFAULT_DEEPGRAM_MODEL : d.model,
      language: "",
      address: d.address === undefined || d.address === "" ? DeepgramStt.DEFAULT_URL : d.address,
      ...(d.credential !== undefined ? { credential: d.credential } : {}),
      stream
    }
  }
  const model = SherpaStt.resolvePresetName(hearing.model) ?? hearing.model
  const preset = SherpaStt.isPresetName(model) ? SherpaStt.presets[model] : undefined
  return {
    engine: "sherpa",
    model,
    language: preset !== undefined && SherpaStt.takesLanguage(preset) ? hearing.language : "",
    ...(shared.modelDir !== undefined && shared.modelDir !== "" ? { modelDir: shared.modelDir } : {}),
    ...(shared.threads !== undefined ? { threads: shared.threads } : {}),
    stream
  }
}

/** `SttKey` (docs/ASSISTANTS.md §3.2): engine + (sherpa: model + language + modelDir + threads | deepgram: model + address). */
export const sttKeyOf = (spec: SttSpec): string =>
  spec.engine === "deepgram"
    ? ["deepgram", spec.model, shownAddress(spec.address ?? DeepgramStt.DEFAULT_URL)].join("|")
    : ["sherpa", spec.model, spec.language === "" ? "-" : spec.language, spec.modelDir ?? SherpaStt.defaultModelDir, spec.threads === undefined ? "default threads" : `${spec.threads} threads`].join("|")

const sttIdentityOf = (spec: SttSpec): string => `${sttKeyOf(spec)}\u0000${spec.address ?? ""}\u0000${spec.credential ?? ""}`

const sherpaPresetOf = (spec: SttSpec): SherpaStt.Preset | undefined =>
  spec.engine === "sherpa" && SherpaStt.isPresetName(spec.model) ? SherpaStt.presets[spec.model] : undefined

export const sttLabelOf = (spec: SttSpec): string => {
  if (spec.engine === "deepgram") return `Speech recognition Deepgram ${spec.model}`
  const preset = sherpaPresetOf(spec)
  return `Speech model ${preset?.label ?? spec.model}${spec.language === "" ? "" : ` (${spec.language})`}`
}

/** The measured memory of a local speech model (WP-0, `presets.ts` `ramMb`); hosted: none. */
export const sttRamMbOf = (spec: SttSpec): number | undefined => sherpaPresetOf(spec)?.ramMb

/** The measured load time of a local speech model (WP-0, `presets.ts` `loadMs`). */
export const sttLoadMsOf = (spec: SttSpec): number | undefined => sherpaPresetOf(spec)?.loadMs

/** One recogniser instance: a loaded model (or a hosted configuration), heard by streams with their own options. */
export interface Recogniser {
  /** An `Stt` whose streams use these options (cheap: nothing is loaded). */
  readonly forStream: (stream: SttStreamSpec) => Stt["Service"]
  /** Called once if the instance dies (a worker crash). Optional: hosted recognisers have nothing to die. */
  readonly onFailure?: (listener: (problem: string) => void) => void
}

/** Builds one recogniser instance in the scope it is given (closed when the pool releases it). */
export type SttBuilder = (spec: SttSpec) => Effect.Effect<Recogniser, ResourceBuildError, Scope.Scope>

/** stt-sherpa's options for the worker of `spec` and the stream options `stream`. */
export const sherpaOptionsOf = (spec: SttSpec, stream: SttStreamSpec): SherpaStt.SherpaSttOptions => ({
  model: spec.model as SherpaStt.PresetName,
  ...(spec.modelDir !== undefined ? { modelDir: spec.modelDir } : {}),
  ...(spec.threads !== undefined ? { threads: spec.threads } : {}),
  ...(spec.language !== "" ? { language: spec.language } : {}),
  ...sherpaStreamOf(stream)
})

const sherpaStreamOf = (stream: SttStreamSpec): SherpaStt.SherpaStreamOptions => ({
  eagerSilenceMs: stream.eagerSilenceMs,
  finalSilenceMs: stream.finalSilenceMs,
  minSpeechMs: stream.minSpeechMs,
  vadThreshold: stream.vadThreshold,
  agc: stream.agc ? { maxGainDb: stream.agcMaxGainDb } : false
})

/**
 * The recognisers of serve mode. On this machine (stt-sherpa): the shared worker of the key (`SherpaStt.acquire`:
 * one loaded model per key, whoever asks), each stream with its hearer's timing, VAD and gain. A worker of the same
 * key that was left behind (a native decode that did not finish) is waited for before a new one loads (the orphan
 * rule, per key); a worker that dies marks the instance failed. Deepgram: one connection per stream, as before,
 * with the shared key and address (`configProvider()`) and the stream's confidences.
 */
export const defaultSttBuilder = (
  configProvider: () => ConfigProvider.ConfigProvider,
  /** Tests: the worker script of stt-sherpa (a stand-in without a model). */
  script?: SherpaStt.WorkerScript
): SttBuilder => (spec) =>
  Effect.gen(function*() {
    if (spec.engine === "deepgram") {
      const apiKey = yield* Effect.gen(function*() {
        return yield* Config.Redacted("DEEPGRAM_API_KEY")
      }).pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider()),
        Effect.mapError((e) => new ResourceBuildError({ message: describeStartFailure(e) }))
      )
      return {
        forStream: (stream) =>
          DeepgramStt.make({
            apiKey,
            model: spec.model,
            ...(spec.address !== undefined ? { url: spec.address } : {}),
            eotThreshold: stream.eotThreshold,
            eagerEotThreshold: stream.eagerEotThreshold,
            eotTimeoutMs: stream.eotTimeoutMs
          })
      } satisfies Recogniser
    }
    if (!SherpaStt.isPresetName(spec.model)) return yield* new ResourceBuildError({ message: `There is no speech model "${spec.model}".` })
    const options = sherpaOptionsOf(spec, spec.stream)
    const key = SherpaStt.workerKey(options, script)
    const waitForOrphan = Effect.suspend(() =>
      SherpaStt.orphans(key) === 0 ? Effect.void : Effect.andThen(
        Effect.logWarning(`The previous ${spec.model} speech model has not shut down yet; it is loaded again once it has.`),
        Effect.promise(() => SherpaStt.whenNoOrphans(key))
      )
    )
    yield* waitForOrphan
    // A worker of this key still stopping may be left behind as the load starts: wait for it once more, then load.
    const shared = yield* SherpaStt.acquire(options, script).pipe(
      Effect.catch((e) => (SherpaStt.isOrphanedMessage(e.message) ? Effect.andThen(waitForOrphan, SherpaStt.acquire(options, script)) : Effect.fail(e))),
      Effect.mapError((e) => new ResourceBuildError({ message: e.message }))
    )
    // The worker outlives this instance when another one (a full reload's replacement) shares it: drop this
    // instance's failure listeners when its scope closes, so the worker does not keep retired instances alive.
    const unsubscribes = new Set<() => void>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const unsubscribe of unsubscribes) unsubscribe()
        unsubscribes.clear()
      })
    )
    return {
      forStream: (stream) => shared.forStream(sherpaStreamOf(stream)),
      onFailure: (listener) => void unsubscribes.add(shared.onFailure((e) => listener(e.message)))
    } satisfies Recogniser
  })

// ---- The pool

/** How long an instance nobody uses any more is kept (turns still running on it finish). docs/ASSISTANTS.md §1.2. */
export const RESOURCE_GRACE_MS = 10_000

export interface ResourcePoolOptions {
  readonly buildLlm: LlmBuilder
  /** Builds voices. Default: none (a voice then fails with "Voices are not available"). */
  readonly buildTts?: TtsBuilder
  /** Builds recognisers. Default: none (a recogniser then fails with "Speech recognition is not available"). */
  readonly buildStt?: SttBuilder
  /** Default `RESOURCE_GRACE_MS`. */
  readonly graceMs?: number
  /** Something in `status()` changed (a build settled, an instance was released, who uses what). */
  readonly onChange?: () => void
  /**
   * The bindings may have changed (after every reconcile, build and failure): what `sttFor` answers for a place may be
   * different, also when the status is not (changed stream options).
   */
  readonly onRebind?: () => void
  /** Reword a build problem for the owner (a key that is locked away). */
  readonly explainProblem?: (message: string) => string
  readonly log?: (line: string) => void
}

export interface ReconcileOptions {
  /** Build again what failed (a vault unlock, the owner's reload). Default false: a failed instance stays failed. */
  readonly retryFailed?: boolean
  /**
   * Build a fresh instance of every resource in use (the owner's full reload). Each assistant switches when its new
   * instance is ready; the old one is released after the grace period. Implies `retryFailed`.
   */
  readonly rebuild?: boolean
  /** The voice of each assistant in use (`ttsSpecOf`). Default: none. */
  readonly voices?: ReadonlyMap<string, TtsSpec>
  /**
   * The recogniser of every hearing place (docs/ASSISTANTS.md §2.6 "The device's recogniser"): by place
   * (`device:<id>`, or `type:<kind>` for a type's defaults and the sessions that follow them), the hearing spec of its
   * hearer (`sttSpecOf`) and who that hearer is (the status's `usedBy`). Default: none.
   */
  readonly recognisers?: ReadonlyMap<string, { readonly spec: SttSpec; readonly hearer: string }>
}

/** What a hearing place is bound to (`ResourcePool.sttFor`). */
export interface SttBinding {
  /** Changes with every new instance and with the stream options: a session restarts its stream when it changes. */
  readonly id: string
  readonly key: string
  /** The `Stt` of this place: the instance with the place's stream options. */
  readonly stt: Stt["Service"]
  readonly spec: SttSpec
  readonly state: "starting" | "ready" | "failed"
  readonly problem?: string
}

export interface ResourcePool {
  /**
   * The assistants in use now (switched on and on at least one effective list), with the spec of each one's
   * language model (`wanted`) and voice (`options.voices`): builds what is missing, rebinds what is ready, and
   * releases what nobody uses after the grace period. Completes when every build it started has settled (ready or
   * failed).
   */
  readonly reconcile: (wanted: ReadonlyMap<string, LlmSpec>, options?: ReconcileOptions) => Effect.Effect<void>
  /** The ready instance with this key (`llmKeyOf`), if any. */
  readonly llm: (key: string) => Llm["Service"] | undefined
  /**
   * The language model `assistant`'s next turn uses (read once at its start, so a turn never changes model): the
   * ready instance for its spec, else the instance it used before while the new one is built, else the one being
   * built (its turn waits for it). A failed instance answers every request with its problem (an `LlmError`).
   * `undefined`: the assistant is not in use. The same object for as long as the binding lasts.
   */
  readonly llmFor: (assistant: string) => Llm["Service"] | undefined
  /** The key of the instance `assistant` uses now. */
  readonly keyFor: (assistant: string) => string | undefined
  /** The ready voice with this key (`ttsKeyOf`), if any. */
  readonly tts: (key: string) => Tts["Service"] | undefined
  /**
   * The voice `assistant`'s next turn speaks with (read once at its start; same rules as `llmFor`). Every clause of
   * the turn is tagged in the turn trace with the voice's key (`Trace.voices`). A failed voice fails every synthesis
   * with its problem (a `TtsError`). Its `sampleRate` is that of the engine once built (22 050 until then and for a
   * failed one): wait for `ttsReady` before reading it. `undefined`: the assistant is not in use.
   */
  readonly ttsFor: (assistant: string) => Tts["Service"] | undefined
  /**
   * Completes once the voice `assistant` is bound to at this call (the one `ttsFor` returns now) has been built (or
   * has failed): its sample rate is known. The voice is resolved when this is called, not when the effect runs, so a
   * rebinding in between neither skips that voice's build nor waits on another voice.
   */
  readonly ttsReady: (assistant: string) => Effect.Effect<void>
  /** The key of the voice `assistant` uses now. */
  readonly ttsKeyFor: (assistant: string) => string | undefined
  /**
   * The recogniser a hearing place (`ReconcileOptions.recognisers`) hears with now: the ready instance for its spec,
   * else the one it used before while the new one is built (a device keeps hearing during a model load), else the one
   * being built (its streams wait for it). A failed instance fails every stream with its problem (an `SttError`).
   * `undefined`: the place has no recogniser (no hearer, or not reconciled yet).
   */
  readonly sttFor: (place: string) => SttBinding | undefined
  readonly status: () => ReadonlyArray<ResourceInfo>
}

interface Entry<Spec, Svc> {
  /** Unique per instance (a rebuild of the same identity is a new instance). */
  readonly serial: number
  readonly spec: Spec
  readonly key: string
  readonly identity: string
  state: "starting" | "ready" | "failed"
  problem?: string
  inner?: Svc
  readonly scope: Scope.Closeable
  readonly settled: Deferred.Deferred<void>
  /** The wrapper every user gets: waits for the build, answers with the problem, counts streams in flight. */
  service: Svc
  inFlight: number
  /** Released (scheduled, or done): no longer offered. */
  retiring: boolean
  releaseTimer?: ReturnType<typeof setTimeout>
  closed: boolean
}

interface KindConfig<Spec, Svc> {
  /** "Language model", "Voice": for the log. */
  readonly name: string
  readonly build: (spec: Spec) => Effect.Effect<Svc, ResourceBuildError, Scope.Scope>
  readonly identityOf: (spec: Spec) => string
  readonly keyOf: (spec: Spec) => string
  /** The service every user of `entry` gets. */
  readonly wrap: (entry: Entry<Spec, Svc>, release: () => void) => Svc
  readonly describe: (spec: Spec) => { readonly kind: ResourceInfo["kind"]; readonly label: string; readonly location: "local" | "hosted"; readonly ramMb?: number }
  /**
   * Called once the instance is ready, with a way to mark it failed later (a recogniser whose worker died): it is
   * then offered with its problem, as one that failed to build, until it is built again (`retryFailed`).
   */
  readonly afterBuild?: (entry: Entry<Spec, Svc>, fail: (problem: string) => void) => void
  /** Who the status names as users (`usedBy`): the users themselves by default. */
  readonly usedByOf?: (users: ReadonlyArray<string>) => ReadonlyArray<string>
}

interface PoolHooks {
  readonly graceMs: number
  readonly rebound: () => void
  readonly runFork: (effect: Effect.Effect<void>) => unknown
  readonly closing: () => boolean
  readonly changed: () => void
  readonly log: (line: string) => void
  readonly explainProblem: (message: string) => string
}

/**
 * One kind of shared resource (language models, voices): instances by identity, assistants bound to them, build in
 * the background, switch when ready, release after the grace period.
 */
const makeKind = <Spec, Svc>(config: KindConfig<Spec, Svc>, hooks: PoolHooks) => {
  /** The newest instance per identity (what new bindings get). */
  const current = new Map<string, Entry<Spec, Svc>>()
  /** Every instance not closed yet (the newest and those still kept for a running turn). */
  const alive = new Set<Entry<Spec, Svc>>()
  /** The instance each assistant in use is bound to, and the spec it wanted when it was bound. */
  const bound = new Map<string, Entry<Spec, Svc>>()
  const boundSpec = new Map<string, Spec>()
  /** The assistants in use and the spec each one wants. */
  let wanted = new Map<string, Spec>()
  let serials = 0

  const close = (entry: Entry<Spec, Svc>) => {
    if (entry.closed) return
    entry.closed = true
    alive.delete(entry)
    if (current.get(entry.identity) === entry) current.delete(entry.identity)
    hooks.runFork(Scope.close(entry.scope, Exit.void))
    hooks.log(`${config.name} released: ${entry.key}`)
  }

  /** Closes `entry` once it is retiring and no stream runs on it any more. */
  const closeWhenIdle = (entry: Entry<Spec, Svc>) => {
    if (entry.retiring && entry.inFlight === 0 && entry.releaseTimer === undefined) {
      close(entry)
      hooks.changed()
    }
  }

  const makeEntry = (spec: Spec): Entry<Spec, Svc> => {
    const entry: Entry<Spec, Svc> = {
      serial: ++serials,
      spec,
      key: config.keyOf(spec),
      identity: config.identityOf(spec),
      state: "starting",
      scope: Effect.runSync(Scope.make()),
      settled: Deferred.makeUnsafe<void>(),
      service: undefined as unknown as Svc,
      inFlight: 0,
      retiring: false,
      closed: false
    }
    entry.service = config.wrap(entry, () => closeWhenIdle(entry))
    return entry
  }

  /** Who uses `entry`: the assistants bound to it, and those that want its identity while it is the newest. */
  const usersOf = (entry: Entry<Spec, Svc>): Array<string> => {
    const users = new Set<string>()
    for (const [assistant, e] of bound) if (e === entry) users.add(assistant)
    if (current.get(entry.identity) === entry) {
      for (const [assistant, spec] of wanted) if (config.identityOf(spec) === entry.identity) users.add(assistant)
    }
    return [...users]
  }

  /** Bind every assistant to the best instance for it; schedule the release of what nobody uses. */
  const rebind = () => {
    bindAll()
    hooks.rebound()
  }
  const bindAll = () => {
    for (const assistant of [...bound.keys()]) {
      if (wanted.has(assistant)) continue
      bound.delete(assistant)
      boundSpec.delete(assistant)
    }
    for (const [assistant, spec] of wanted) {
      const target = current.get(config.identityOf(spec))
      if (target === undefined) continue
      const before = bound.get(assistant)
      // Building: keep what the assistant used before (its turns keep answering) until the new one has settled.
      if (target.state === "starting" && before !== undefined && before !== target && !before.closed) continue
      bound.set(assistant, target)
      boundSpec.set(assistant, spec)
    }
    for (const entry of alive) {
      const used = usersOf(entry).length > 0
      if (used) {
        if (entry.retiring) {
          entry.retiring = false
          if (entry.releaseTimer !== undefined) clearTimeout(entry.releaseTimer)
          delete entry.releaseTimer
        }
      } else if (!entry.retiring) {
        entry.retiring = true
        // A failed or never-used instance holds nothing a turn needs: released at once; a working one after the grace.
        const wait = entry.state === "ready" ? hooks.graceMs : 0
        if (wait === 0) closeWhenIdle(entry)
        else {
          entry.releaseTimer = setTimeout(() => {
            delete entry.releaseTimer
            if (current.get(entry.identity) === entry && usersOf(entry).length === 0) current.delete(entry.identity)
            closeWhenIdle(entry)
          }, wait)
          entry.releaseTimer.unref?.()
        }
      }
    }
  }

  const start = (spec: Spec): Entry<Spec, Svc> => {
    const entry = makeEntry(spec)
    current.set(entry.identity, entry)
    alive.add(entry)
    hooks.log(`${config.name} starting: ${entry.key}`)
    hooks.runFork(
      Effect.suspend(() => config.build(spec)).pipe(
        Effect.provideService(Scope.Scope, entry.scope),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              entry.inner = exit.value
              entry.state = "ready"
              hooks.log(`${config.name} ready: ${entry.key}`)
              config.afterBuild?.(entry, (problem) => {
                if (entry.closed || entry.state === "failed") return
                entry.state = "failed"
                entry.problem = problem
                hooks.log(`${config.name} failed: ${entry.key}: ${problem}`)
                if (hooks.closing()) return
                rebind()
                hooks.changed()
              })
            } else {
              const failure = Cause.squash(exit.cause)
              entry.state = "failed"
              entry.problem = failure instanceof ResourceBuildError || failure instanceof Error ? failure.message : String(failure)
              hooks.log(`${config.name} failed: ${entry.key}: ${entry.problem}`)
            }
          })
        ),
        Effect.ensuring(Effect.suspend(() =>
          Deferred.succeed(entry.settled, undefined).pipe(
            Effect.andThen(Effect.sync(() => {
              if (hooks.closing()) return
              rebind()
              hooks.changed()
            }))
          )
        ))
      )
    )
    return entry
  }

  return {
    /** Wants `next`: starts what is missing, rebinds. The entries started (to wait for). */
    reconcile: (next: ReadonlyMap<string, Spec>, reconcileOptions: ReconcileOptions): Array<Entry<Spec, Svc>> => {
      wanted = new Map(next)
      const started: Array<Entry<Spec, Svc>> = []
      const seen = new Set<string>()
      for (const spec of wanted.values()) {
        const identity = config.identityOf(spec)
        if (seen.has(identity)) continue
        seen.add(identity)
        const existing = current.get(identity)
        const again = reconcileOptions.rebuild === true || (reconcileOptions.retryFailed === true && existing?.state === "failed")
        if (existing === undefined || existing.closed || again) started.push(start(spec))
      }
      rebind()
      return started
    },
    /** The ready instance with this key. */
    ready: (key: string): Svc | undefined => {
      for (const entry of current.values()) if (entry.key === key && entry.state === "ready") return entry.service
      return undefined
    },
    serviceFor: (assistant: string): Svc | undefined => bound.get(assistant)?.service,
    /** What `assistant` is bound to: the instance (its serial changes with every new instance) and the spec it wanted. */
    bindingFor: (assistant: string): { readonly service: Svc; readonly key: string; readonly serial: number; readonly spec: Spec; readonly state: Entry<Spec, Svc>["state"]; readonly problem?: string } | undefined => {
      const entry = bound.get(assistant)
      const spec = boundSpec.get(assistant)
      if (entry === undefined || spec === undefined) return undefined
      return { service: entry.service, key: entry.key, serial: entry.serial, spec, state: entry.state, ...(entry.problem !== undefined ? { problem: entry.problem } : {}) }
    },
    keyFor: (assistant: string): string | undefined => bound.get(assistant)?.key,
    /** Resolved now (not when run): it waits for the instance bound at the call, the one `serviceFor` returns now. */
    settledFor: (assistant: string): Effect.Effect<void> => {
      const entry = bound.get(assistant)
      return entry === undefined ? Effect.void : Deferred.await(entry.settled)
    },
    info: (): Array<ResourceInfo> =>
      [...alive].map((entry) => {
        const users = usersOf(entry)
        const usedBy = config.usedByOf === undefined ? users : [...config.usedByOf(users)]
        const problem = entry.problem === undefined ? undefined : hooks.explainProblem(entry.problem)
        return {
          ...config.describe(entry.spec),
          key: entry.key,
          usedBy,
          state: entry.state === "ready" && users.length === 0 ? "unused" as const : entry.state,
          ...(problem !== undefined ? { problem } : {})
        }
      }),
    /** The pool is closing: stop every timer, close every instance. */
    closeAll: (): Effect.Effect<void> =>
      Effect.suspend(() => {
        const all = [...alive]
        for (const entry of all) {
          if (entry.releaseTimer !== undefined) clearTimeout(entry.releaseTimer)
          entry.closed = true
        }
        alive.clear()
        current.clear()
        bound.clear()
        boundSpec.clear()
        return Effect.forEach(all, (e) => Scope.close(e.scope, Exit.void), { discard: true })
      })
  }
}

/** Counts a stream on `entry` while it runs (so the instance is not closed under it). */
const counted = <A, E, R>(
  entry: { inFlight: number },
  release: () => void,
  stream: Stream.Stream<A, E, R>
): Stream.Stream<A, E, R> =>
  Stream.suspend(() => {
    entry.inFlight++
    return stream
  }).pipe(Stream.ensuring(Effect.sync(() => {
    entry.inFlight--
    release()
  })))

/** A voice's engine reports its rate once built; until then (and for a failed voice) this one. */
const UNKNOWN_SAMPLE_RATE = 22_050

export const makeResourcePool = (options: ResourcePoolOptions): Effect.Effect<ResourcePool, never, Scope.Scope> =>
  Effect.gen(function*() {
    const runFork = yield* FiberSet.makeRuntime<never, void, never>()
    let closing = false

    /** The status last announced: `onChange` fires only when what `status()` returns is different. */
    let announced = "[]"
    const changed = () => {
      const now = JSON.stringify(statusNow())
      if (now === announced) return
      announced = now
      try {
        options.onChange?.()
      } catch {
        // a throwing listener changes nothing here
      }
    }
    const hooks: PoolHooks = {
      graceMs: options.graceMs ?? RESOURCE_GRACE_MS,
      rebound: () => {
        try {
          options.onRebind?.()
        } catch {
          // a throwing listener changes nothing here
        }
      },
      runFork,
      closing: () => closing,
      changed,
      log: (line) => options.log?.(line),
      explainProblem: (message) => options.explainProblem?.(message) ?? message
    }

    const llms = makeKind<LlmSpec, Llm["Service"]>({
      name: "Language model",
      build: options.buildLlm,
      identityOf,
      keyOf: llmKeyOf,
      wrap: (entry, release) =>
        Llm.of({
          stream: (request) =>
            Stream.unwrap(Effect.map(Deferred.await(entry.settled), () => {
              const inner = entry.inner
              if (inner === undefined) {
                return Stream.fail(new LlmError({ message: entry.problem ?? "The language model could not start." }))
              }
              return counted(entry, release, Stream.suspend(() => inner.stream(request)))
            }))
        }),
      describe: (spec) => ({
        kind: "llm",
        label: llmLabelOf(spec),
        location: spec.account === "offline" || spec.account === "claude-subscription" ? "local" : "hosted"
      })
    }, hooks)

    const voices = makeKind<TtsSpec, Tts["Service"]>({
      name: "Voice",
      build: options.buildTts ?? (() => Effect.fail(new ResourceBuildError({ message: "Voices are not available." }))),
      identityOf: ttsIdentityOf,
      keyOf: ttsKeyOf,
      wrap: (entry, release): Tts["Service"] => ({
        get sampleRate() {
          return entry.inner?.sampleRate ?? UNKNOWN_SAMPLE_RATE
        },
        // Counted from the start, the wait for the build included: a turn waiting for its voice keeps it alive when the
        // assistant is rebound or switched off meanwhile (it finishes with the voice it started with).
        synthesize: (clauses) =>
          counted(
            entry,
            release,
            Stream.unwrap(Effect.gen(function*() {
              // The turn's trace names the voice that spoke it, whatever happens next.
              const trace = yield* CurrentTurnTrace
              if (trace !== undefined && !trace.voices.includes(entry.key)) trace.voices.push(entry.key)
              yield* Deferred.await(entry.settled)
              const inner = entry.inner
              if (inner === undefined) {
                return Stream.fail(new TtsError({ message: entry.problem ?? "The voice could not start." }))
              }
              // Released before this synthesis started (nothing kept it): its engine is shut down.
              if (entry.closed) return Stream.fail(new TtsError({ message: "The voice was released before the turn spoke." }))
              return Stream.suspend(() => inner.synthesize(clauses))
            }))
          )
      }),
      describe: (spec) => ({ kind: "tts", label: ttsLabelOf(spec), location: ttsLocationOf(spec) })
    }, hooks)

    /** Who hears with each place's recogniser (the status names hearers, not places). */
    let hearers = new Map<string, string>()
    const recognisers = makeKind<SttSpec, Recogniser>({
      name: "Speech recogniser",
      build: options.buildStt ?? (() => Effect.fail(new ResourceBuildError({ message: "Speech recognition is not available." }))),
      identityOf: sttIdentityOf,
      keyOf: sttKeyOf,
      wrap: (entry, release): Recogniser => ({
        forStream: (stream) => ({
          transcribe: (audio) =>
            Stream.unwrap(Effect.map(Deferred.await(entry.settled), () => {
              const inner = entry.inner
              if (inner === undefined || entry.state === "failed") {
                return Stream.fail(new SttError({ message: entry.problem ?? "The speech recogniser could not start." }))
              }
              return counted(entry, release, Stream.suspend(() => inner.forStream(stream).transcribe(audio)))
            }))
        })
      }),
      describe: (spec) => {
        const ramMb = sttRamMbOf(spec)
        return { kind: "stt", label: sttLabelOf(spec), location: spec.engine === "deepgram" ? "hosted" : "local", ...(ramMb !== undefined ? { ramMb } : {}) }
      },
      afterBuild: (entry, fail) => entry.inner?.onFailure?.(fail),
      usedByOf: (places) => [...new Set(places.flatMap((p) => (hearers.has(p) ? [hearers.get(p)!] : [])))]
    }, hooks)

    const statusNow = (): Array<ResourceInfo> => [...llms.info(), ...voices.info(), ...recognisers.info()]

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closing = true
        return Effect.andThen(Effect.andThen(llms.closeAll(), voices.closeAll()), recognisers.closeAll())
      })
    )

    const awaitAll = (entries: ReadonlyArray<{ readonly settled: Deferred.Deferred<void> }>) =>
      Effect.forEach(entries, (e) => Deferred.await(e.settled), { discard: true })

    return {
      reconcile: (next, reconcileOptions = {}) =>
        Effect.suspend(() => {
          if (closing) return Effect.void
          const places = reconcileOptions.recognisers ?? new Map()
          hearers = new Map([...places].map(([place, { hearer }]) => [place, hearer]))
          const started = [
            ...llms.reconcile(next, reconcileOptions),
            ...voices.reconcile(reconcileOptions.voices ?? new Map(), reconcileOptions),
            ...recognisers.reconcile(new Map([...places].map(([place, { spec }]) => [place, spec])), reconcileOptions)
          ]
          changed()
          return awaitAll(started)
        }),
      llm: llms.ready,
      llmFor: llms.serviceFor,
      keyFor: llms.keyFor,
      tts: voices.ready,
      ttsFor: voices.serviceFor,
      ttsReady: voices.settledFor,
      ttsKeyFor: voices.keyFor,
      sttFor: (place) => {
        const b = recognisers.bindingFor(place)
        if (b === undefined) return undefined
        return {
          id: `${b.serial}|${JSON.stringify(b.spec.stream)}`,
          key: b.key,
          stt: b.service.forStream(b.spec.stream),
          spec: b.spec,
          state: b.state,
          ...(b.problem !== undefined ? { problem: b.problem } : {})
        }
      },
      status: statusNow
    } satisfies ResourcePool
  })
