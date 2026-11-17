import {
  type PreviewAudio,
  type Tts,
  type TtsError,
  type TtsVoices,
  VoiceCatalogError,
  type VoiceDescription,
  type VoiceList,
  type VoiceRef,
  parseVoiceKey,
  voiceKey
} from "@pva/core"
import type { DeviceUser, JobInfo, ProviderInfo, ProviderVoices, VoiceEntry } from "@pva/protocol"
import { MAX_PREVIEW_CHARS, MAX_PREVIEW_SECONDS } from "@pva/protocol"
import * as SherpaTts from "@pva/tts-sherpa"
import { Config, ConfigProvider, Data, Effect, Exit, Fiber, Redacted, Scope, Semaphore } from "effect"
import { createHash } from "node:crypto"
import { hostedTtsVoices, ttsProviderInfo, type TtsProviderName, ttsProviderNames } from "../providers.ts"

/**
 * The voice catalog of serve mode (docs/VOICE-PROVIDERS.md §4, §7.3): every provider's voices with their status, the
 * hosted lists' cache, and previews (one at a time, superseded by a newer one, cached; local previews refused while
 * a device is in a turn and cancelled when one starts; the live engine reused for the assistant's own voice, one
 * kept engine for another local voice).
 */

/** An answer of the API that is not a success: its HTTP status, code and message (docs/VOICE-PROVIDERS.md §5.0). */
export class ApiFailure extends Data.TaggedError("ApiFailure")<{
  readonly status: number
  readonly code: string
  readonly message: string
  readonly retryAfterMs?: number
  readonly fieldErrors?: ReadonlyArray<{ readonly key: string; readonly message: string }>
}> {}

export const SETTINGS_PATH = "voices/providers"
/** A hosted list older than this is fetched again (on the next request that needs it). */
export const LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** After a failed fetch, the next one waits this long unless refreshed by hand. */
const FAILED_RETRY_MS = 30_000
const LIST_TIMEOUT_MS = 15_000
export const PREVIEW_TIMEOUT_MS = 20_000
/** The kept preview engine (a local voice that is not the assistant's) closes after this long unused. */
export const PREVIEW_ENGINE_IDLE_MS = 60_000
const PREVIEW_CACHE_ENTRIES = 20
const PREVIEW_CACHE_BYTES = 16 * 1024 * 1024
const BUSY_POLL_MS = 50

export interface VoiceCatalogOptions {
  /** Environment over saved settings and keys (what the providers read). */
  readonly configProvider: () => ConfigProvider.ConfigProvider
  /** The key vault is locked (a missing key may be in it). */
  readonly vaultLocked: () => boolean
  /** Where local voice models are. */
  readonly modelDir: () => string
  /** The running `Tts` of a voice an assistant speaks with (the resource pool's; `undefined`: none is running). */
  readonly live: (voice: VoiceRef) => Tts["Service"] | undefined
  /** A device is in a turn (hearing, thinking or speaking): local previews wait. */
  readonly busy: () => boolean
  /** The assistants that speak with each voice now (docs/ASSISTANTS.md §5.5): voice key → assistant ids. */
  readonly usedBy: () => ReadonlyMap<string, ReadonlyArray<string>>
  /** The devices that speak with each voice as their own now: voice key → devices (from their effective settings). */
  readonly usedByDevices?: () => ReadonlyMap<string, ReadonlyArray<DeviceUser>>
  readonly isFavourite: (ref: VoiceRef) => boolean
  /** The running download of a local voice. */
  readonly download: (preset: string) => JobInfo | undefined
  /** Tests: the hosted providers' voices (default: the adapters', configured from `configProvider`). */
  readonly hostedVoices?: Partial<Record<TtsProviderName, Effect.Effect<TtsVoices["Service"], Config.ConfigError>>>
  /**
   * Tests: the engine of a local preview (default: `SherpaTts.makeShared`). A plain `Tts` speaks only its own preset; a
   * `SharedEngine` also the other presets of its set-up (another Kokoro speaker of the same lexicon).
   */
  readonly localEngine?: (preset: string, modelDir: string) => Effect.Effect<Tts["Service"] | SherpaTts.SharedEngine, TtsError, Scope.Scope>
  readonly now?: () => number
}

export interface PreviewResult {
  readonly audio: PreviewAudio
  readonly cached: boolean
}

export interface VoiceCatalog {
  readonly providers: Effect.Effect<ReadonlyArray<ProviderInfo>>
  /** Every provider's voices (or one's), refetching hosted lists that are stale, or all of them with `refresh`. */
  readonly voices: (provider: string | undefined, refresh: boolean) => Effect.Effect<ReadonlyArray<ProviderVoices>, ApiFailure>
  /** A voice that can be selected: known to its provider, its provider usable, a local one installed. */
  readonly checkSelectable: (ref: VoiceRef) => Effect.Effect<{ readonly name: string }, ApiFailure>
  /** The name of a voice from the lists at hand (no fetch). */
  readonly nameOf: (ref: VoiceRef) => string | undefined
  readonly preview: (ref: VoiceRef, text: string) => Effect.Effect<PreviewResult, ApiFailure>
  readonly isProvider: (id: string) => id is TtsProviderName
  /** Close the kept preview engine (server shutdown). */
  readonly close: Effect.Effect<void>
}

interface CacheEntry {
  readonly cacheKey: string
  list?: VoiceList
  fetchedAt?: number
  error?: { readonly code: string; readonly message: string }
  errorAt?: number
}

type HostedState =
  | { readonly status: "needs_key"; readonly reason: "missing" | "vault_locked"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "usable"; readonly service: TtsVoices["Service"]; readonly cacheKey: string }

const failure = (status: number, code: string, message: string, extra: { readonly retryAfterMs?: number } = {}) =>
  new ApiFailure({ status, code, message, ...extra })

/** A provider's own error, as the API answers it. */
const fromCatalogError = (e: VoiceCatalogError): ApiFailure => {
  switch (e.reason) {
    case "unknown_voice":
      return failure(404, "unknown_voice", e.message)
    case "not_installed":
      return failure(409, "not_installed", e.message)
    case "rate_limited":
      return failure(502, "provider_error", e.message, e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {})
    default:
      return failure(502, "provider_error", e.message)
  }
}

export const makeVoiceCatalog = (options: VoiceCatalogOptions): Effect.Effect<VoiceCatalog, never, Scope.Scope> =>
  Effect.gen(function*() {
    const now = options.now ?? Date.now
    const hostedVoices = { ...hostedTtsVoices, ...options.hostedVoices }
    const localEngine = (preset: string, modelDir: string): Effect.Effect<SherpaTts.SharedEngine, TtsError, Scope.Scope> =>
      options.localEngine === undefined
        ? SherpaTts.makeShared({ preset, modelDir })
        : Effect.map(options.localEngine(preset, modelDir), (built) =>
          "forPreset" in built ? built : { tts: built, forPreset: (name: string) => (name === preset ? built : undefined) })
    const cache = new Map<string, CacheEntry>()
    const locks = new Map<string, Semaphore.Semaphore>(ttsProviderNames.map((p) => [p, Semaphore.makeUnsafe(1)]))
    const isProvider = (id: string): id is TtsProviderName => Object.hasOwn(ttsProviderInfo, id)
    const withConfig = <A, E>(effect: Effect.Effect<A, E>) => Effect.provideService(effect, ConfigProvider.ConfigProvider, options.configProvider())

    // ---- Hosted providers: key, service, list cache

    const hostedState = (provider: TtsProviderName): Effect.Effect<HostedState> =>
      Effect.gen(function*() {
        const info = ttsProviderInfo[provider]
        const config = Config.Redacted(info.keyEnv!)
        const key = yield* Effect.result(withConfig(Effect.gen(function*() {
          return yield* config
        })))
        if (key._tag === "Failure" || Redacted.value(key.success).trim() === "") {
          return options.vaultLocked()
            ? { status: "needs_key", reason: "vault_locked", message: `The key vault is locked: unlock it to use ${info.label} voices.` } as const
            : { status: "needs_key", reason: "missing", message: `Add a ${info.label} API key to use its voices.` } as const
        }
        const make = hostedVoices[provider as keyof typeof hostedVoices]
        if (make === undefined) return { status: "error", message: `${info.label} cannot list voices` } as const
        const service = yield* Effect.result(withConfig(make))
        if (service._tag === "Failure") return { status: "error", message: `${info.label} could not be set up: ${service.failure.message}` } as const
        const cacheKey = `${provider}:${createHash("sha256").update(Redacted.value(key.success)).digest("hex").slice(0, 16)}`
        return { status: "usable", service: service.success, cacheKey } as const
      })

    /** The cache entry for the provider's current key, fetched when needed (`mode`). */
    const hostedList = (
      provider: TtsProviderName,
      state: Extract<HostedState, { status: "usable" }>,
      mode: "if-none" | "if-stale" | "refresh"
    ): Effect.Effect<CacheEntry> =>
      locks.get(provider)!.withPermit(Effect.gen(function*() {
        let entry = cache.get(provider)
        if (entry?.cacheKey !== state.cacheKey) {
          entry = { cacheKey: state.cacheKey }
          cache.set(provider, entry)
        }
        const t = now()
        const fresh = entry.fetchedAt !== undefined && t - entry.fetchedAt < LIST_MAX_AGE_MS
        const recentFailure = entry.errorAt !== undefined && t - entry.errorAt < FAILED_RETRY_MS &&
          (entry.fetchedAt === undefined || entry.errorAt > entry.fetchedAt)
        const needed = mode === "refresh" ||
          (mode === "if-none" && entry.list === undefined && !recentFailure) ||
          (mode === "if-stale" && !fresh && !recentFailure)
        if (!needed) return entry
        const label = ttsProviderInfo[provider].label
        const result = yield* state.service.list.pipe(
          Effect.timeoutOrElse({
            duration: LIST_TIMEOUT_MS,
            orElse: () => Effect.fail(new VoiceCatalogError({ reason: "unavailable", message: `${label} did not answer within ${LIST_TIMEOUT_MS / 1000} s` }))
          }),
          Effect.result
        )
        if (result._tag === "Success") {
          entry.list = result.success
          entry.fetchedAt = now()
          delete entry.error
          delete entry.errorAt
        } else {
          entry.error = { code: fromCatalogError(result.failure).code, message: result.failure.message }
          entry.errorAt = now()
        }
        return entry
      }))

    const info = (provider: TtsProviderName, used: ReadonlyMap<string, ReadonlyArray<string>>, extra: Partial<ProviderInfo>): ProviderInfo => {
      const p = ttsProviderInfo[provider]
      return {
        id: provider,
        label: p.label,
        location: p.location,
        status: "ready",
        ...(p.keyEnv !== undefined ? { keyField: p.keyEnv } : {}),
        settingsPath: SETTINGS_PATH,
        ...(p.implication !== undefined ? { implication: p.implication } : {}),
        inUse: [...used.keys()].some((key) => parseVoiceKey(key)?.provider === provider),
        ...extra
      }
    }

    // ---- Entries

    const entry = (provider: string, v: VoiceDescription, used: ReadonlyMap<string, ReadonlyArray<string>>, devices: ReadonlyMap<string, ReadonlyArray<DeviceUser>>): VoiceEntry => {
      const ref = { provider, voiceId: v.id }
      const job = v.local !== undefined ? options.download(v.id) : undefined
      const local = v.local === undefined ? undefined : {
        state: job !== undefined ? "downloading" as const : v.local.installed ? "installed" as const : "not_installed" as const,
        sizeMb: v.local.sizeMb,
        diskMb: v.local.diskMb,
        ...(job !== undefined ? { job } : {})
      }
      return {
        voice: ref,
        key: voiceKey(ref),
        name: v.name,
        ...(v.description !== undefined ? { description: v.description } : {}),
        ...(v.language !== undefined ? { language: v.language } : {}),
        ...(v.gender !== undefined ? { gender: v.gender } : {}),
        tags: [...v.tags],
        ...(local !== undefined ? { local } : {}),
        previewable: local === undefined || local.state === "installed",
        usedBy: [...(used.get(voiceKey(ref)) ?? [])],
        usedByDevices: [...(devices.get(voiceKey(ref)) ?? [])],
        favourite: options.isFavourite(ref)
      }
    }

    const localVoices = () => SherpaTts.listVoices(options.modelDir())

    const providerVoices = (provider: TtsProviderName, used: ReadonlyMap<string, ReadonlyArray<string>>, devices: ReadonlyMap<string, ReadonlyArray<DeviceUser>>, mode: "if-stale" | "refresh"): Effect.Effect<ProviderVoices> =>
      Effect.gen(function*() {
        if (ttsProviderInfo[provider].location === "local") {
          const voices = localVoices()
          return {
            provider: info(provider, used, { voiceCount: voices.length }),
            voices: voices.map((v) => entry(provider, v, used, devices)),
            stale: false,
            truncated: false
          }
        }
        const state = yield* hostedState(provider)
        if (state.status === "needs_key") {
          return {
            provider: info(provider, used, { status: "needs_key", reason: state.reason, message: state.message }),
            voices: [],
            stale: false,
            truncated: false
          }
        }
        if (state.status === "error") {
          return { provider: info(provider, used, { status: "error", message: state.message }), voices: [], stale: false, truncated: false }
        }
        const cached = yield* hostedList(provider, state, mode)
        const voices = cached.list?.voices ?? []
        const failed = cached.error !== undefined
        return {
          provider: info(provider, used, {
            ...(failed ? { status: "error" as const, message: cached.error!.message } : {}),
            ...(cached.list !== undefined ? { voiceCount: voices.length } : {})
          }),
          voices: voices.map((v) => entry(provider, v, used, devices)).map((e) => (failed ? { ...e, previewable: false } : e)),
          ...(cached.fetchedAt !== undefined ? { fetchedAt: cached.fetchedAt } : {}),
          stale: cached.fetchedAt !== undefined && (failed || now() - cached.fetchedAt >= LIST_MAX_AGE_MS),
          truncated: cached.list?.truncated ?? false,
          ...(failed ? { error: cached.error! } : {})
        }
      })

    const providers: Effect.Effect<ReadonlyArray<ProviderInfo>> = Effect.gen(function*() {
      const used = options.usedBy()
      return yield* Effect.forEach(ttsProviderNames, (provider) =>
        Effect.gen(function*() {
          if (ttsProviderInfo[provider].location === "local") return info(provider, used, { voiceCount: localVoices().length })
          const state = yield* hostedState(provider)
          if (state.status === "needs_key") return info(provider, used, { status: "needs_key", reason: state.reason, message: state.message })
          if (state.status === "error") return info(provider, used, { status: "error", message: state.message })
          const cached = yield* hostedList(provider, state, "if-none")
          return info(provider, used, {
            ...(cached.error !== undefined ? { status: "error" as const, message: cached.error.message } : {}),
            ...(cached.list !== undefined ? { voiceCount: cached.list.voices.length } : {})
          })
        }), { concurrency: "unbounded" })
    })

    const voices = (provider: string | undefined, refresh: boolean) =>
      Effect.gen(function*() {
        if (provider !== undefined && !isProvider(provider)) return yield* failure(404, "unknown_provider", `There is no voice provider "${provider}"`)
        const used = options.usedBy()
        const devices = options.usedByDevices?.() ?? new Map<string, ReadonlyArray<DeviceUser>>()
        const which = provider === undefined ? ttsProviderNames : [provider as TtsProviderName]
        return yield* Effect.forEach(which, (p) => providerVoices(p, used, devices, refresh ? "refresh" : "if-stale"), { concurrency: "unbounded" })
      })

    const nameOf = (ref: VoiceRef): string | undefined => {
      if (ref.provider === "sherpa") return localVoices().find((v) => v.id === ref.voiceId)?.name
      return cache.get(ref.provider)?.list?.voices.find((v) => v.id === ref.voiceId)?.name
    }

    /** The provider is usable for `ref` (and, for a local voice, the voice exists and is installed). */
    const usable = (ref: VoiceRef): Effect.Effect<{ readonly name?: string; readonly hosted?: Extract<HostedState, { status: "usable" }> }, ApiFailure> =>
      Effect.gen(function*() {
        if (!isProvider(ref.provider)) return yield* failure(404, "unknown_provider", `There is no voice provider "${ref.provider}"`)
        if (ttsProviderInfo[ref.provider].location === "local") {
          const voice = localVoices().find((v) => v.id === ref.voiceId)
          if (voice === undefined) return yield* failure(404, "unknown_voice", `There is no voice "${ref.voiceId}" on this machine`)
          if (voice.local?.installed !== true) {
            return yield* failure(409, "not_installed", `${voice.name} is not downloaded yet (${voice.local?.sizeMb ?? "?"} MB): download it first`)
          }
          return { name: voice.name }
        }
        const state = yield* hostedState(ref.provider)
        if (state.status === "needs_key") return yield* failure(409, "needs_key", state.message)
        if (state.status === "error") return yield* failure(502, "provider_error", state.message)
        return { hosted: state }
      })

    const checkSelectable = (ref: VoiceRef) =>
      Effect.gen(function*() {
        const ok = yield* usable(ref)
        if (ok.hosted === undefined) return { name: ok.name ?? ref.voiceId }
        const cached = yield* hostedList(ref.provider as TtsProviderName, ok.hosted, "if-none")
        if (cached.list === undefined) {
          return yield* failure(502, "provider_error", cached.error?.message ?? "The voice list could not be fetched to check the voice")
        }
        const voice = cached.list.voices.find((v) => v.id === ref.voiceId)
        if (voice === undefined) {
          return yield* failure(404, "unknown_voice", `${ttsProviderInfo[ref.provider as TtsProviderName].label} has no voice "${ref.voiceId}" (refresh the list if it is new)`)
        }
        return { name: voice.name }
      })

    // ---- Previews

    const previewCache = new Map<string, PreviewAudio>()
    let previewBytes = 0
    const remember = (key: string, audio: PreviewAudio) => {
      if (audio.pcm.length > PREVIEW_CACHE_BYTES) return
      previewCache.delete(key)
      previewCache.set(key, audio)
      previewBytes += audio.pcm.length
      for (const [k, a] of previewCache) {
        if (previewCache.size <= PREVIEW_CACHE_ENTRIES && previewBytes <= PREVIEW_CACHE_BYTES) break
        previewCache.delete(k)
        previewBytes -= a.pcm.length
      }
    }

    /**
     * The one kept preview engine (a local voice that is not the assistant's). It also speaks the other presets of its
     * set-up (the Kokoro voices of one lexicon) with their own speaker id, so moving the preview between them does not
     * load the model again. It is its own process: the assistant's engine is never given another speaker.
     */
    let kept: { readonly dir: string; readonly scope: Scope.Closeable; readonly engine: SherpaTts.SharedEngine; timer?: ReturnType<typeof setTimeout> } | undefined
    const closeKept = Effect.suspend(() => {
      const k = kept
      kept = undefined
      if (k === undefined) return Effect.void
      if (k.timer !== undefined) clearTimeout(k.timer)
      return Scope.close(k.scope, Exit.void)
    })
    const services = yield* Effect.context<never>()
    const armIdle = () => {
      const k = kept
      if (k === undefined) return
      if (k.timer !== undefined) clearTimeout(k.timer)
      k.timer = setTimeout(() => {
        if (kept === k) void Effect.runForkWith(services)(closeKept)
      }, PREVIEW_ENGINE_IDLE_MS)
      k.timer.unref?.()
    }

    const engineFor = (preset: string, dir: string): Effect.Effect<Tts["Service"], VoiceCatalogError, Scope.Scope> =>
      Effect.gen(function*() {
        const live = options.live({ provider: "sherpa", voiceId: preset })
        if (live !== undefined) return live
        let tts = kept !== undefined && kept.dir === dir ? kept.engine.forPreset(preset) : undefined
        if (kept !== undefined && tts === undefined) yield* closeKept
        if (kept === undefined) {
          const scope = yield* Scope.make()
          const built = yield* Effect.result(Scope.provide(localEngine(preset, dir), scope))
          if (built._tag === "Failure") {
            yield* Scope.close(scope, Exit.void)
            return yield* new VoiceCatalogError({ reason: "unavailable", message: `The voice could not be started: ${built.failure.message}` })
          }
          kept = { dir, scope, engine: built.success }
          tts = built.success.tts
        }
        if (kept.timer !== undefined) clearTimeout(kept.timer)
        const mine = kept
        // A preview that did not finish (cancelled, superseded, failed) stops the engine at once: the clause in
        // synthesis is not waited for. One that finished keeps it for the next preview, for a while.
        yield* Effect.addFinalizer((exit) => (Exit.isSuccess(exit) && kept === mine ? Effect.sync(armIdle) : kept === mine ? closeKept : Effect.void))
        return tts!
      })
    const localVoicesService = SherpaTts.makeVoices({ modelDir: options.modelDir, engineFor, maxSeconds: MAX_PREVIEW_SECONDS })

    const busyFailure = () => failure(409, "busy", "The assistant is talking on a device; try the preview again in a moment.", { retryAfterMs: 1000 })
    const whenBusy: Effect.Effect<never, ApiFailure> = Effect.gen(function*() {
      while (!options.busy()) yield* Effect.sleep(BUSY_POLL_MS)
      return yield* busyFailure()
    })

    let running: { fiber?: Fiber.Fiber<PreviewAudio, ApiFailure>; superseded: boolean } | undefined

    const preview = (ref: VoiceRef, rawText: string): Effect.Effect<PreviewResult, ApiFailure> =>
      Effect.gen(function*() {
        const text = rawText.trim()
        if (text.length === 0 || [...text].length > MAX_PREVIEW_CHARS) {
          return yield* new ApiFailure({
            status: 400,
            code: "invalid_request",
            message: text.length === 0 ? "The preview text is empty" : `The preview text is longer than ${MAX_PREVIEW_CHARS} characters`,
            fieldErrors: [{ key: "text", message: text.length === 0 ? "Required" : `At most ${MAX_PREVIEW_CHARS} characters` }]
          })
        }
        const cacheKey = `${voiceKey(ref)}\u0000${text}`
        const hit = previewCache.get(cacheKey)
        if (hit !== undefined) {
          remember(cacheKey, hit)
          return { audio: hit, cached: true }
        }
        const ok = yield* usable(ref)
        const local = ok.hosted === undefined
        if (local && options.busy()) return yield* busyFailure()

        if (running !== undefined) {
          running.superseded = true
          if (running.fiber !== undefined) yield* Fiber.interrupt(running.fiber)
        }
        const record: { fiber?: Fiber.Fiber<PreviewAudio, ApiFailure>; superseded: boolean } = { superseded: false }
        running = record
        const work: Effect.Effect<PreviewAudio, ApiFailure> = (local
          ? Effect.raceFirst(localVoicesService.preview(ref.voiceId, text).pipe(Effect.mapError(fromCatalogError)), whenBusy)
          : ok.hosted!.service.preview(ref.voiceId, text).pipe(
            Effect.mapError(fromCatalogError),
            // At most MAX_PREVIEW_SECONDS of what the provider sent (the local engine stops there by itself).
            Effect.map((a) => ({ ...a, pcm: a.pcm.subarray(0, Math.min(a.pcm.length, MAX_PREVIEW_SECONDS * a.sampleRate * 2)) }))
          )
        ).pipe(
          Effect.timeoutOrElse({
            duration: PREVIEW_TIMEOUT_MS,
            orElse: () => Effect.fail(failure(504, "preview_timeout", `No preview audio within ${PREVIEW_TIMEOUT_MS / 1000} s`))
          })
        )
        const fiber = yield* Effect.forkDetach(work)
        record.fiber = fiber
        const exit = yield* Fiber.await(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)))
        if (running === record) running = undefined
        if (Exit.isSuccess(exit)) {
          remember(cacheKey, exit.value)
          return { audio: exit.value, cached: false }
        }
        if (record.superseded) return yield* failure(409, "superseded", "A newer preview replaced this one")
        return yield* Effect.failCause(exit.cause)
      })

    yield* Effect.addFinalizer(() => closeKept)

    return { providers, voices, checkSelectable, nameOf, preview, isProvider, close: closeKept } satisfies VoiceCatalog
  })
