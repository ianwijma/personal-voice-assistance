import { MODELS as SUBSCRIPTION_KNOWN_MODELS } from "@pva/agent-claude-code"
import * as AnthropicModels from "@pva/llm-anthropic"
import { accountModelSource, type ModelInfo } from "@pva/llm-openai-compatible"
import type {
  Assistant,
  ChoiceOption,
  JobInfo,
  ModelBadge,
  ModelEntry,
  ModelProviderInfo,
  ModelRefJson,
  ModuleState,
  PickerKind,
  ProviderModels
} from "@pva/protocol"
import { modelKey, parseModelKey } from "@pva/protocol"
import * as SherpaStt from "@pva/stt-sherpa"
import { Config, ConfigProvider, Effect, Redacted, Semaphore } from "effect"
import { ApiFailure } from "./VoiceCatalog.ts"

/**
 * The model pickers' catalog (docs/MODEL-PICKERS.md §3, §5): the language models of each account and the speech
 * recognition models, per provider, with their state. Lists are fetched through the adapter packages on demand (an
 * admin opened a picker), cached in memory, and never on a turn's path. Keys never leave the server: the cache is
 * keyed by a hash of key and address, and every message comes from the adapters' redacted errors.
 */

// ---- Providers

export type LlmProviderId = "anthropic" | "claude-subscription" | "openrouter" | "home-model" | "offline"
export type SttProviderId = "sherpa" | "deepgram"
type HostedLlm = "anthropic" | "openrouter" | "home-model"

export const LLM_PROVIDERS: ReadonlyArray<LlmProviderId> = ["anthropic", "claude-subscription", "openrouter", "home-model", "offline"]
export const STT_PROVIDERS: ReadonlyArray<SttProviderId> = ["sherpa", "deepgram"]

const ACCOUNTS_PAGE = { settingsPath: "shared/accounts", settingsLabel: "Shared settings › Language model accounts" } as const
const SPEECH_PAGE = { settingsPath: "shared/speech", settingsLabel: "Shared settings › Speech recognition models" } as const

interface ProviderDef {
  readonly label: string
  readonly location: "local" | "hosted"
  readonly keyField?: string
  readonly implication?: string
  readonly page: { readonly settingsPath: string; readonly settingsLabel: string }
  readonly customModel?: { readonly placeholder: string; readonly help: string }
}

const llmProviders: Readonly<Record<LlmProviderId, ProviderDef>> = {
  anthropic: {
    label: "Anthropic API",
    location: "hosted",
    keyField: "ANTHROPIC_API_KEY",
    implication: "What you say is sent to Anthropic.",
    page: ACCOUNTS_PAGE,
    customModel: { placeholder: "claude-…", help: "A model id of the Anthropic API, as its model list names it." }
  },
  "claude-subscription": {
    label: "Claude subscription",
    location: "hosted",
    implication: "What you say is sent to Anthropic through Claude Code.",
    page: ACCOUNTS_PAGE,
    customModel: { placeholder: "claude-…", help: "Any model name Claude Code accepts." }
  },
  openrouter: {
    label: "OpenRouter",
    location: "hosted",
    keyField: "OPENROUTER_API_KEY",
    implication: "What you say is sent to OpenRouter and the model's provider.",
    page: ACCOUNTS_PAGE,
    customModel: { placeholder: "provider/model", help: "An OpenRouter model id, such as those on openrouter.ai/models. Only models that take tools are listed." }
  },
  "home-model": {
    label: "Home model",
    location: "local",
    keyField: "HOME_MODEL_API_KEY",
    implication: "What you say stays on your network.",
    page: ACCOUNTS_PAGE,
    customModel: { placeholder: "llama3.1:8b", help: "The model's name as your server knows it (Ollama: ollama list)." }
  },
  offline: { label: "Offline stand-in", location: "local", page: ACCOUNTS_PAGE }
}

const sttProviders: Readonly<Record<SttProviderId, ProviderDef>> = {
  sherpa: { label: "On this machine", location: "local", implication: "What you say stays on this machine.", page: SPEECH_PAGE },
  deepgram: { label: "Deepgram", location: "hosted", keyField: "DEEPGRAM_API_KEY", implication: "What you say is sent to Deepgram.", page: SPEECH_PAGE }
}

/** How long a fetched list is used before it is fetched again (on the next request that needs it). */
export const LIST_MAX_AGE_MS: Readonly<Record<HostedLlm, number>> = {
  // New Anthropic models are rare; OpenRouter adds models daily; a home server's models change with `ollama pull`.
  anthropic: 6 * 60 * 60 * 1000,
  openrouter: 60 * 60 * 1000,
  "home-model": 5 * 60 * 1000
}
/** A list fetch gives up after this long; the providers are fetched in parallel. */
export const LIST_TIMEOUT_MS = 10_000
/** After a failed fetch, the next one waits this long unless refreshed by hand. */
export const FAILED_RETRY_MS = 30_000
/** At most this many models per provider (`truncated` beyond). */
export const MAX_MODELS_PER_PROVIDER = 1000

/**
 * The languages of each preset of this machine, from the presets' own descriptions (packages/stt-sherpa/src/presets.ts)
 * and, for Nemotron, the English and Dutch turns of `SherpaStt.test.ts`. `languages` are the codes known to work (a
 * subset for the multilingual ones; Whisper: the codes the Hearing tab's language setting offers), `label` is shown.
 */
export const PRESET_LANGUAGES: Readonly<Record<SherpaStt.PresetName, { readonly languages: ReadonlyArray<string>; readonly label: string }>> = {
  "parakeet-v2": { languages: ["en"], label: "English" },
  "parakeet-ultra": { languages: ["en", "nl"], label: "English, Dutch + 23 European" },
  "whisper-turbo": { languages: ["en", "nl", "de", "fr", "es", "it", "pt"], label: "99 languages" },
  "hybrid-nemotron-parakeet": { languages: ["en"], label: "English" },
  "nemotron-560": { languages: ["en", "nl"], label: "Multilingual" },
  "nemotron-320": { languages: ["en", "nl"], label: "Multilingual" },
  "zipformer-en": { languages: ["en"], label: "English" },
  "fast-conformer-en": { languages: ["en"], label: "English" }
}

// ---- Options

export interface SubscriptionView {
  /** `missing`: the module is not in the catalog. */
  readonly state: ModuleState | "missing"
  readonly enabled: boolean
  /** The running module's `settingOptions().model` (Claude Code's own list, from its start). */
  readonly models?: ReadonlyArray<ChoiceOption>
}

export interface SttItem {
  readonly id: string
  readonly installed: boolean
  readonly sizeMb: number
  readonly diskMb: number
}

export interface ModelCatalogOptions {
  /** Environment over saved settings and keys. */
  readonly configProvider: () => ConfigProvider.ConfigProvider
  readonly vaultLocked: () => boolean
  readonly assistants: () => ReadonlyArray<Assistant>
  readonly subscription: () => SubscriptionView
  /** The recogniser presets with their install state (the Models page's list). */
  readonly sttItems: () => ReadonlyArray<SttItem>
  /** The running download of a recogniser preset. */
  readonly sttDownload: (preset: string) => JobInfo | undefined
  readonly isFavourite: (kind: PickerKind, ref: ModelRefJson) => boolean
  readonly listTimeoutMs?: number
  /** Tests: the HTTP client of every list fetch (default: the global `fetch`). */
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

export interface ModelCatalog {
  /** The providers and their status. Never fetches: a list's error is the last fetch's. */
  readonly providers: (kind: PickerKind) => Effect.Effect<ReadonlyArray<ModelProviderInfo>>
  /** Every provider's models (or one's): stale lists are fetched again, all of them with `refresh`. */
  readonly models: (kind: PickerKind, provider: string | undefined, refresh: boolean) => Effect.Effect<ReadonlyArray<ProviderModels>, ApiFailure>
  readonly isProvider: (kind: PickerKind, id: string) => boolean
  /** A model's name from the lists at hand (no fetch). */
  readonly nameOf: (kind: PickerKind, ref: ModelRefJson) => string | undefined
}

// ---- Internals

/** One model as a provider lists it, before it becomes an entry. */
interface Described {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly contextTokens?: number
  readonly maxOutputTokens?: number
  readonly pricing?: { readonly inputPerMTok: number; readonly outputPerMTok: number }
  readonly deprecated?: boolean
  readonly releasedAt?: number
  readonly tags?: ReadonlyArray<string>
}

interface CacheEntry {
  readonly identity: string
  list?: ReadonlyArray<Described>
  truncated?: boolean
  fetchedAt?: number
  error?: { readonly code: string; readonly message: string }
  errorAt?: number
}

type HostedState =
  | { readonly status: "needs_key"; readonly reason: "missing" | "vault_locked"; readonly message: string }
  | { readonly status: "needs_address"; readonly message: string }
  | { readonly status: "error"; readonly message: string }
  | {
    readonly status: "usable"
    readonly identity: string
    readonly fetch: (timeoutMs: number) => Effect.Effect<ReadonlyArray<Described>, { readonly message: string; readonly reason: string }>
  }

const fromOpenAi = (m: ModelInfo): Described => ({
  id: m.id,
  name: m.label,
  ...(m.description !== undefined ? { description: m.description } : {}),
  ...(m.contextTokens !== undefined ? { contextTokens: m.contextTokens } : {}),
  ...(m.pricing !== undefined ? { pricing: m.pricing } : {}),
  ...(m.reasoning === true ? { tags: ["reasoning"] } : {})
})

const fromAnthropic = (m: AnthropicModels.AnthropicModel): Described => ({
  id: m.id,
  name: m.label,
  ...(m.contextTokens !== undefined ? { contextTokens: m.contextTokens } : {}),
  ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
  ...(m.lifecycle === "deprecated" ? { deprecated: true } : {}),
  ...(m.releasedAt !== undefined ? { releasedAt: m.releasedAt } : {})
})

/** "200k", "1M", "8k". */
export const tokensLabel = (n: number): string =>
  n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1))}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const dollars = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toPrecision(2)}` : `$${n.toFixed(2)}`)

const llmBadges = (d: Described): Array<ModelBadge> => [
  ...(d.contextTokens !== undefined ? [{ kind: "context" as const, label: `${tokensLabel(d.contextTokens)} context`, title: `${d.contextTokens.toLocaleString("en-US")} tokens of context` }] : []),
  ...(d.pricing !== undefined
    ? [d.pricing.inputPerMTok === 0 && d.pricing.outputPerMTok === 0
      ? { kind: "price" as const, label: "Free" }
      : {
        kind: "price" as const,
        label: `${dollars(d.pricing.inputPerMTok)} / ${dollars(d.pricing.outputPerMTok)} per M`,
        title: `US$ per million tokens: ${d.pricing.inputPerMTok} in, ${d.pricing.outputPerMTok} out`
      }]
    : []),
  ...(d.deprecated === true ? [{ kind: "tag" as const, label: "Deprecated", title: "Still works, but Anthropic is retiring it" }] : [])
]

const timeLabel = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export const makeModelCatalog = (options: ModelCatalogOptions): ModelCatalog => {
  const now = options.now ?? Date.now
  const timeoutMs = options.listTimeoutMs ?? LIST_TIMEOUT_MS
  const fetchOption = options.fetch !== undefined ? { fetch: options.fetch } : {}
  const cache = new Map<HostedLlm, CacheEntry>()
  const locks = new Map<HostedLlm, Semaphore.Semaphore>((["anthropic", "openrouter", "home-model"] as const).map((p) => [p, Semaphore.makeUnsafe(1)]))
  const withConfig = <A, E>(effect: Effect.Effect<A, E>) => Effect.provideService(effect, ConfigProvider.ConfigProvider, options.configProvider())
  const isProvider = (kind: PickerKind, id: string) => Object.hasOwn(kind === "llm" ? llmProviders : sttProviders, id)

  const needsKey = (label: string): HostedState =>
    options.vaultLocked()
      ? { status: "needs_key", reason: "vault_locked", message: `The key vault is locked: unlock it to use ${label}.` }
      : { status: "needs_key", reason: "missing", message: `${label} is not set up: add its API key in ${ACCOUNTS_PAGE.settingsLabel}.` }

  /** Key and address of a hosted account, and how to fetch its list. Reads settings only. */
  const hostedState = (provider: HostedLlm): Effect.Effect<HostedState> =>
    withConfig(Effect.gen(function*() {
      const state = (s: HostedState) => s
      if (provider === "anthropic") {
        const source = yield* AnthropicModels.modelSource
        if (source.state === "not_set_up") return needsKey(llmProviders.anthropic.label)
        return state({
          status: "usable",
          identity: source.identity,
          fetch: (ms) => source.list({ timeoutMs: ms, ...fetchOption }).pipe(Effect.map((list) => list.map(fromAnthropic)))
        })
      }
      const source = yield* accountModelSource(provider)
      if (source.state === "not_set_up") {
        if (source.missing === "key") return needsKey(llmProviders[provider].label)
        return state({ status: "needs_address", message: source.message })
      }
      if (source.state === "invalid") return state({ status: "error", message: source.message })
      return state({
        status: "usable",
        identity: source.identity,
        fetch: (ms) => source.list({ timeoutMs: ms, ...fetchOption }).pipe(Effect.map((list) => list.map(fromOpenAi)))
      })
    })).pipe(Effect.catch((e) => Effect.succeed<HostedState>({ status: "error", message: `The ${llmProviders[provider].label} settings could not be read: ${e.message}` })))

  /** The cache entry for the account's current key and address, fetched when `mode` says so. */
  const hostedList = (provider: HostedLlm, state: Extract<HostedState, { status: "usable" }>, mode: "never" | "if-stale" | "refresh"): Effect.Effect<CacheEntry> =>
    locks.get(provider)!.withPermit(Effect.gen(function*() {
      let entry = cache.get(provider)
      if (entry?.identity !== state.identity) {
        entry = { identity: state.identity }
        cache.set(provider, entry)
      }
      const t = now()
      const fresh = entry.fetchedAt !== undefined && t - entry.fetchedAt < LIST_MAX_AGE_MS[provider]
      const recentFailure = entry.errorAt !== undefined && t - entry.errorAt < FAILED_RETRY_MS && (entry.fetchedAt === undefined || entry.errorAt > entry.fetchedAt)
      const needed = mode === "refresh" || (mode === "if-stale" && !fresh && !recentFailure)
      if (!needed) return entry
      const label = llmProviders[provider].label
      const result = yield* state.fetch(timeoutMs).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail({ reason: "timeout", message: `${label} did not answer the model list within ${timeLabel(timeoutMs)}` })
        }),
        Effect.result
      )
      if (result._tag === "Success") {
        entry.list = result.success.slice(0, MAX_MODELS_PER_PROVIDER)
        entry.truncated = result.success.length > MAX_MODELS_PER_PROVIDER
        entry.fetchedAt = now()
        delete entry.error
        delete entry.errorAt
      } else {
        const code = result.failure.reason === "unauthorized" ? "unauthorized" : result.failure.reason === "timeout" ? "timeout" : "provider_error"
        entry.error = { code, message: result.failure.message }
        entry.errorAt = now()
      }
      return entry
    }))

  const assistantsUsing = (kind: PickerKind, provider: string, modelId: string | undefined): Array<string> =>
    options.assistants().filter((a) => {
      if (kind === "llm") return a.llm.account === provider && (provider === "offline" || modelId === undefined || a.llm.model === modelId)
      if (a.hearing.engine !== provider) return false
      return provider === "deepgram" || modelId === undefined || (SherpaStt.resolvePresetName(a.hearing.model) ?? a.hearing.model) === modelId
    }).map((a) => a.id)

  const info = (kind: PickerKind, id: string, extra: Partial<ModelProviderInfo>): ModelProviderInfo => {
    const def = (kind === "llm" ? llmProviders : sttProviders)[id as never] as ProviderDef
    return {
      id,
      label: def.label,
      location: def.location,
      status: "ready",
      ...(def.keyField !== undefined ? { keyField: def.keyField } : {}),
      settingsPath: def.page.settingsPath,
      settingsLabel: def.page.settingsLabel,
      ...(def.implication !== undefined ? { implication: def.implication } : {}),
      inUse: assistantsUsing(kind, id, undefined).length > 0,
      ...extra
    }
  }

  // ---- Language models

  const llmEntry = (provider: LlmProviderId, d: Described, listed = true): ModelEntry => {
    const ref = { provider, modelId: d.id }
    const badges = llmBadges(d)
    return {
      model: ref,
      key: modelKey(ref),
      name: d.name,
      ...(d.description !== undefined ? { description: d.description } : {}),
      badges: listed ? badges : [...badges, { kind: "tag", label: "Not in the list", title: "An assistant uses it, but the provider's list does not have it" }],
      tags: [...new Set([d.id, ...(d.tags ?? [])])],
      apply: { llm: { account: provider, model: provider === "offline" ? "" : d.id } },
      llm: {
        ...(d.contextTokens !== undefined ? { contextTokens: d.contextTokens } : {}),
        ...(d.maxOutputTokens !== undefined ? { maxOutputTokens: d.maxOutputTokens } : {}),
        ...(d.pricing !== undefined ? { pricing: d.pricing } : {}),
        ...(d.deprecated === true ? { deprecated: true } : {}),
        ...(d.releasedAt !== undefined ? { releasedAt: d.releasedAt } : {})
      },
      listed,
      selectable: true,
      usedBy: assistantsUsing("llm", provider, provider === "offline" ? undefined : d.id),
      favourite: options.isFavourite("llm", ref)
    }
  }

  /**
   * The listed models, then the models assistants use that the list does not have (typed, or gone). A listed id that
   * is not a valid model reference (over 100 characters, control characters) is left out: the answer's schema would
   * refuse it, and with it every provider's list.
   */
  const withUnlisted = (provider: LlmProviderId, all: ReadonlyArray<Described>): Array<ModelEntry> => {
    const list = all.filter((d) => parseModelKey(modelKey({ provider, modelId: d.id })) !== undefined)
    const ids = new Set(list.map((d) => d.id))
    const used = [...new Set(options.assistants().filter((a) => a.llm.account === provider && a.llm.model.trim() !== "" && !ids.has(a.llm.model)).map((a) => a.llm.model))]
    return [
      ...list.map((d) => llmEntry(provider, d)),
      ...used.flatMap((id) => (parseModelKey(modelKey({ provider, modelId: id })) === undefined ? [] : [llmEntry(provider, { id, name: id }, false)]))
    ]
  }

  const customOf = (provider: LlmProviderId) => {
    const c = llmProviders[provider].customModel
    return c !== undefined ? { customModel: c } : {}
  }

  const offlineModels = (): ProviderModels => ({
    provider: info("llm", "offline", { listSource: "built-in", modelCount: 1 }),
    models: [llmEntry("offline", { id: "stand-in", name: "Offline stand-in", description: "Echoes what you say and answers time questions. No language model." })],
    stale: false,
    truncated: false
  })

  const subscriptionModels = (): ProviderModels => {
    const view = options.subscription()
    if (view.state !== "running" || !view.enabled) {
      const message = view.state === "missing" || !view.enabled
        ? `Claude subscription is not set up: switch it on in ${ACCOUNTS_PAGE.settingsLabel}.`
        : view.state === "starting"
        ? "Claude Code is starting; its models are listed once it runs."
        : `Claude Code is not running: see ${ACCOUNTS_PAGE.settingsLabel}.`
      return { provider: info("llm", "claude-subscription", { status: "needs_setup", message }), models: [], stale: false, truncated: false }
    }
    const fromModule = (view.models ?? []).filter((o) => o.value.trim() !== "")
    const list: ReadonlyArray<Described> = fromModule.length > 0
      ? fromModule.map((o) => ({ id: o.value, name: o.label, ...(o.description !== undefined ? { description: o.description } : {}) }))
      : SUBSCRIPTION_KNOWN_MODELS.map((m) => ({ id: m.value, name: m.label }))
    const models = withUnlisted("claude-subscription", list.filter((d) => parseModelKey(modelKey({ provider: "claude-subscription", modelId: d.id })) !== undefined))
    return {
      provider: info("llm", "claude-subscription", { listSource: fromModule.length > 0 ? "provider" : "known", modelCount: list.length, ...customOf("claude-subscription") }),
      models,
      stale: false,
      truncated: false
    }
  }

  const hostedModels = (provider: HostedLlm, mode: "never" | "if-stale" | "refresh"): Effect.Effect<ProviderModels> =>
    Effect.gen(function*() {
      const state = yield* hostedState(provider)
      if (state.status === "needs_key") {
        return { provider: info("llm", provider, { status: "needs_key", reason: state.reason, message: state.message }), models: [], stale: false, truncated: false }
      }
      if (state.status === "needs_address") {
        return { provider: info("llm", provider, { status: "needs_address", message: state.message }), models: [], stale: false, truncated: false }
      }
      if (state.status === "error") {
        return { provider: info("llm", provider, { status: "error", message: state.message, ...customOf(provider) }), models: withUnlisted(provider, []), stale: false, truncated: false }
      }
      const entry = yield* hostedList(provider, state, mode)
      const failed = entry.error !== undefined
      // No list yet and the fetch failed: Anthropic falls back to the models the code knows; the others list none.
      const known = entry.list === undefined && failed && provider === "anthropic" ? AnthropicModels.knownModels.map(fromAnthropic) : undefined
      const list = entry.list ?? known ?? []
      return {
        provider: info("llm", provider, {
          ...(failed ? { status: "error" as const, message: entry.error!.message } : {}),
          ...(entry.list !== undefined || known !== undefined ? { modelCount: list.length } : {}),
          ...(entry.list !== undefined ? { listSource: "provider" as const } : known !== undefined ? { listSource: "known" as const } : {}),
          ...customOf(provider)
        }),
        models: withUnlisted(provider, list),
        ...(entry.fetchedAt !== undefined ? { fetchedAt: entry.fetchedAt } : {}),
        stale: entry.fetchedAt !== undefined && (failed || now() - entry.fetchedAt >= LIST_MAX_AGE_MS[provider]),
        truncated: entry.truncated ?? false,
        ...(failed ? { error: entry.error! } : {})
      }
    })

  const llmProviderModels = (provider: LlmProviderId, mode: "never" | "if-stale" | "refresh"): Effect.Effect<ProviderModels> =>
    provider === "offline" ? Effect.sync(offlineModels) : provider === "claude-subscription" ? Effect.sync(subscriptionModels) : hostedModels(provider, mode)

  // ---- Recogniser models

  const sherpaModels = (): ProviderModels => {
    const items = new Map(options.sttItems().map((i) => [i.id, i]))
    const order = [...SherpaStt.presetNames].sort((a, b) =>
      Number((SherpaStt.presets[a] as SherpaStt.Preset).demoted ?? false) - Number((SherpaStt.presets[b] as SherpaStt.Preset).demoted ?? false)
    )
    const models = order.map((name): ModelEntry => {
      const preset = SherpaStt.presets[name] as SherpaStt.Preset
      const item = items.get(name)
      const job = options.sttDownload(name)
      const installed = item?.installed ?? false
      const state = job !== undefined ? "downloading" as const : installed ? "installed" as const : "not_installed" as const
      const sizeMb = item?.sizeMb ?? SherpaStt.sizeMb(preset)
      const diskMb = item?.diskMb ?? SherpaStt.diskMb(preset)
      const languages = PRESET_LANGUAGES[name]
      const liveWords = preset.kind !== "offline" || preset.interimMs > 0
      const ref = { provider: "sherpa", modelId: name }
      return {
        model: ref,
        key: modelKey(ref),
        name: preset.label.split(" — ")[0]!,
        description: preset.description,
        badges: [
          { kind: "languages", label: languages.label, title: `Languages: ${languages.label}` },
          { kind: "memory", label: `${(preset.ramMb / 1000).toFixed(1)} GB memory`, title: `About ${preset.ramMb} MB of memory once loaded (measured), ${timeLabel(preset.loadMs)} to load` },
          ...(state !== "installed" ? [{ kind: "size" as const, label: `${sizeMb} MB download`, title: `${sizeMb} MB to download, ${diskMb} MB on disk` }] : []),
          ...(preset.demoted === true ? [{ kind: "tag" as const, label: "Not recommended" }] : []),
          ...(name === SherpaStt.DEFAULT_PRESET ? [{ kind: "tag" as const, label: "Recommended" }] : [])
        ],
        tags: [name, ...languages.languages, ...(liveWords ? ["live words"] : [])],
        apply: { hearing: { engine: "sherpa", model: name } },
        stt: {
          languages: [...languages.languages],
          languagesLabel: languages.label,
          takesLanguage: SherpaStt.takesLanguage(preset),
          liveWords,
          recommended: name === SherpaStt.DEFAULT_PRESET
        },
        local: { state, sizeMb, diskMb, ramMb: preset.ramMb, loadMs: preset.loadMs, ...(job !== undefined ? { job } : {}) },
        listed: true,
        selectable: state === "installed",
        usedBy: assistantsUsing("stt", "sherpa", name),
        favourite: options.isFavourite("stt", ref)
      }
    })
    return {
      provider: info("stt", "sherpa", { listSource: "built-in", modelCount: models.length }),
      models,
      stale: false,
      truncated: false
    }
  }

  const deepgramModels = (): Effect.Effect<ProviderModels> =>
    withConfig(Effect.gen(function*() {
      const key = yield* Config.Redacted("DEEPGRAM_API_KEY").pipe(Config.option)
      const model = (yield* Config.String("DEEPGRAM_MODEL").pipe(Config.withDefault("flux-general-en"))).trim() || "flux-general-en"
      return { key: key._tag === "Some" && Redacted.value(key.value).trim() !== "", model }
    })).pipe(
      Effect.catch(() => Effect.succeed({ key: false, model: "flux-general-en" })),
      Effect.map(({ key, model }): ProviderModels => {
        if (!key) {
          const message = options.vaultLocked()
            ? "The key vault is locked: unlock it to use Deepgram."
            : `Deepgram is not set up: add its API key in ${SPEECH_PAGE.settingsLabel}.`
          return {
            provider: info("stt", "deepgram", { status: "needs_key", reason: options.vaultLocked() ? "vault_locked" : "missing", message }),
            models: [],
            stale: false,
            truncated: false
          }
        }
        const ref = { provider: "deepgram", modelId: model }
        const english = /-en$/.test(model)
        const entries: Array<ModelEntry> = parseModelKey(modelKey(ref)) === undefined ? [] : [{
          model: ref,
          key: modelKey(ref),
          name: model,
          description: `Deepgram's streaming recogniser, over the internet. Its model is the shared setting DEEPGRAM_MODEL (${SPEECH_PAGE.settingsLabel}).`,
          badges: [...(english ? [{ kind: "languages" as const, label: "English" }] : [])],
          tags: ["deepgram", ...(english ? ["en"] : [])],
          // The assistant's `hearing.model` stays the stt-sherpa preset it had: Deepgram's model is shared.
          apply: { hearing: { engine: "deepgram" } },
          stt: { languages: english ? ["en"] : [], languagesLabel: english ? "English" : "As the Deepgram model", takesLanguage: false, liveWords: true, recommended: false },
          listed: true,
          selectable: true,
          usedBy: assistantsUsing("stt", "deepgram", undefined),
          favourite: options.isFavourite("stt", ref)
        }]
        return { provider: info("stt", "deepgram", { listSource: "built-in", modelCount: entries.length }), models: entries, stale: false, truncated: false }
      })
    )

  const sttProviderModels = (provider: SttProviderId): Effect.Effect<ProviderModels> =>
    provider === "sherpa" ? Effect.sync(sherpaModels) : deepgramModels()

  // ---- The service

  const models = (kind: PickerKind, provider: string | undefined, refresh: boolean): Effect.Effect<ReadonlyArray<ProviderModels>, ApiFailure> =>
    Effect.gen(function*() {
      if (provider !== undefined && !isProvider(kind, provider)) {
        return yield* new ApiFailure({ status: 404, code: "unknown_provider", message: `There is no ${kind === "llm" ? "language model" : "speech recognition"} provider "${provider}"` })
      }
      const mode = refresh ? "refresh" as const : "if-stale" as const
      if (kind === "llm") {
        const which = provider === undefined ? LLM_PROVIDERS : [provider as LlmProviderId]
        return yield* Effect.forEach(which, (p) => llmProviderModels(p, mode), { concurrency: "unbounded" })
      }
      const which = provider === undefined ? STT_PROVIDERS : [provider as SttProviderId]
      return yield* Effect.forEach(which, sttProviderModels, { concurrency: "unbounded" })
    })

  const providers = (kind: PickerKind): Effect.Effect<ReadonlyArray<ModelProviderInfo>> =>
    kind === "llm"
      ? Effect.forEach(LLM_PROVIDERS, (p) => Effect.map(llmProviderModels(p, "never"), (m) => m.provider), { concurrency: "unbounded" })
      : Effect.forEach(STT_PROVIDERS, (p) => Effect.map(sttProviderModels(p), (m) => m.provider), { concurrency: "unbounded" })

  const nameOf = (kind: PickerKind, ref: ModelRefJson): string | undefined => {
    if (kind === "stt") {
      if (ref.provider === "deepgram") return ref.modelId
      const preset = SherpaStt.isPresetName(ref.modelId) ? (SherpaStt.presets[ref.modelId] as SherpaStt.Preset) : undefined
      return preset?.label.split(" — ")[0]
    }
    if (ref.provider === "offline") return "Offline stand-in"
    if (ref.provider === "claude-subscription") {
      const view = options.subscription()
      return view.models?.find((o) => o.value === ref.modelId)?.label ?? SUBSCRIPTION_KNOWN_MODELS.find((m) => m.value === ref.modelId)?.label
    }
    const listed = cache.get(ref.provider as HostedLlm)?.list?.find((d) => d.id === ref.modelId)?.name
    if (listed !== undefined) return listed
    return ref.provider === "anthropic" ? AnthropicModels.knownModels.find((m) => m.id === ref.modelId)?.label : undefined
  }

  return { providers, models, isProvider, nameOf }
}
