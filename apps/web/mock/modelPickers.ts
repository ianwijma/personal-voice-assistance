/**
 * The model pickers' HTTP API in the mock (docs/MODEL-PICKERS.md §4), under /api/models/. Self-contained: the mock
 * server hands it what it already has (secrets, values, modules, the assistants, the Models page's jobs) and sends the
 * requests that start with `models/` here.
 *
 * Sample states (each one the server can answer with):
 * - Language models: Anthropic API ready (its key is set in the mock's sections) with the API's list; Claude
 *   subscription follows its module (off: `needs_setup`; switched on and running: Claude Code's list); OpenRouter
 *   follows its key (none: `needs_key`; set: a list with context and prices); the home model pretends its server is at
 *   http://192.168.1.20:11434 (the section's value wins when set) and that server has no `/v1/models`: its list
 *   failed (`error`), only the typed model remains, and the models the assistants use stay listed as "not in the
 *   list"; the offline stand-in is always ready. A locked vault makes the key accounts `needs_key` / `vault_locked`.
 * - Recogniser models: the presets on this machine as the Models page lists them (installed or not; Whisper turbo is
 *   not, and its download progresses through the Models page's job, then it is installed), Deepgram follows its key.
 *
 * POST /mock/models/state {"provider", "state"}: force a provider's state: "auto" (as above), "ready" (a list),
 * "failed" (the list call fails), "slow" (lists answer after 3 s), "needs_key", "needs_address".
 */
import type { JobInfo, ModelEntry, ModelFavourite, ModelProviderInfo, ProviderModels } from "@pva/protocol"
import { MAX_FAVOURITES, modelKey, parseModelKey } from "@pva/protocol"

type Kind = "llm" | "stt"
type Forced = "auto" | "ready" | "failed" | "slow" | "needs_key" | "needs_address"

export interface MockItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly sizeMb: number
  readonly diskMb: number
  readonly installed: boolean
}

export interface ModelPickersDeps {
  readonly secretSet: (key: string) => boolean
  readonly valueOf: (key: string) => unknown
  readonly vaultLocked: () => boolean
  /** The Claude subscription module runs. */
  readonly subscriptionRunning: () => boolean
  readonly assistants: () => ReadonlyArray<{ readonly id: string; readonly llm: { readonly account: string; readonly model: string }; readonly hearing: { readonly engine: string; readonly model: string } }>
  /** The Models page's recogniser items. */
  readonly sttItems: () => ReadonlyArray<MockItem>
  readonly runningJob: (target: string) => JobInfo | undefined
  readonly startJob: (target: string) => { ok: true; job: JobInfo } | { ok: false; code: "unknown" | "installed" | "running"; message: string }
  readonly stopJob: (jobId: string) => JobInfo | undefined
}

export interface Answer {
  readonly status: number
  readonly body: unknown
}

const error = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } })

const ACCOUNTS = { settingsPath: "shared/accounts", settingsLabel: "Shared settings › Language model accounts" }
const SPEECH = { settingsPath: "shared/speech", settingsLabel: "Shared settings › Speech recognition models" }

interface Sample {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly context?: number
  readonly price?: readonly [number, number]
  readonly deprecated?: boolean
}

const ANTHROPIC: ReadonlyArray<Sample> = [
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", context: 200_000 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", context: 1_000_000 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", context: 1_000_000 },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", context: 200_000, deprecated: true }
]
const SUBSCRIPTION: ReadonlyArray<Sample> = [
  { id: "default", name: "Default (recommended)", description: "The model Claude Code picks for your plan." },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", description: "Fastest for quick answers." },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Best for everyday tasks." },
  { id: "claude-opus-5-5", name: "Opus 5.5", description: "Most capable for complex work." }
]
const OPENROUTER: ReadonlyArray<Sample> = [
  { id: "anthropic/claude-haiku-5.5", name: "Anthropic: Claude Haiku 5.5", context: 200_000, price: [1, 5] },
  { id: "openai/gpt-oss-20b", name: "OpenAI: gpt-oss-20b", description: "An open-weight model for tools and quick answers.", context: 131_072, price: [0.04, 0.15] },
  { id: "google/gemini-3-flash", name: "Google: Gemini 3 Flash", context: 1_048_576, price: [0.3, 2.5] },
  { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Meta: Llama 3.3 70B Instruct (free)", context: 65_536, price: [0, 0] },
  { id: "mistralai/mistral-small-3.2", name: "Mistral: Mistral Small 3.2", context: 128_000, price: [0.06, 0.18] }
]
const HOME: ReadonlyArray<Sample> = [{ id: "llama3.1:8b", name: "llama3.1:8b" }, { id: "qwen2.5:14b", name: "qwen2.5:14b" }]

/** The presets' facts the real server takes from stt-sherpa (measured memory, languages), for the mock's items. */
const PRESETS: Readonly<Record<string, { readonly ramMb: number; readonly loadMs: number; readonly languages: ReadonlyArray<string>; readonly languagesLabel: string; readonly takesLanguage: boolean; readonly liveWords: boolean; readonly demoted?: boolean }>> = {
  "parakeet-v2": { ramMb: 1050, loadMs: 1609, languages: ["en"], languagesLabel: "English", takesLanguage: false, liveWords: true },
  "parakeet-ultra": { ramMb: 1067, loadMs: 1632, languages: ["en", "nl"], languagesLabel: "English, Dutch + 23 European", takesLanguage: false, liveWords: true },
  "whisper-turbo": { ramMb: 1640, loadMs: 2621, languages: ["en", "nl", "de", "fr", "es", "it", "pt"], languagesLabel: "99 languages", takesLanguage: true, liveWords: false },
  "nemotron-320": { ramMb: 964, loadMs: 1240, languages: ["en", "nl"], languagesLabel: "Multilingual", takesLanguage: true, liveWords: true },
  "zipformer-en": { ramMb: 167, loadMs: 1308, languages: ["en"], languagesLabel: "English", takesLanguage: false, liveWords: true, demoted: true }
}

const tokens = (n: number) => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`)
const dollars = (n: number) => (n === 0 ? "$0" : `$${n.toFixed(2)}`)

export const createModelPickersMock = (deps: ModelPickersDeps) => {
  const forced = new Map<string, Forced>()
  const fetchedAt = new Map<string, number>()
  let favourites: Record<Kind, Array<ModelFavourite>> = { llm: [], stt: [] }
  const initialFavourites = (): Record<Kind, Array<ModelFavourite>> => {
    const at = Date.UTC(2026, 10, 12)
    const f = (provider: string, modelId: string, name: string, i: number): ModelFavourite => ({ model: { provider, modelId }, key: modelKey({ provider, modelId }), name, addedAt: at + i * 60_000 })
    return {
      // One of an account without a key (OpenRouter), so the favourites list shows it as unavailable.
      llm: [f("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5", 0), f("openrouter", "openai/gpt-oss-20b", "OpenAI: gpt-oss-20b", 1)],
      stt: [f("sherpa", "parakeet-v2", "Parakeet v2", 0)]
    }
  }
  favourites = initialFavourites()

  const isFavourite = (kind: Kind, key: string) => favourites[kind].some((f) => f.key === key)
  const usedByLlm = (account: string, model?: string) =>
    deps.assistants().filter((a) => a.llm.account === account && (model === undefined || account === "offline" || a.llm.model === model)).map((a) => a.id)
  const usedBySttFor = (engine: string, model?: string) =>
    deps.assistants().filter((a) => a.hearing.engine === engine && (model === undefined || engine === "deepgram" || a.hearing.model === model)).map((a) => a.id)

  const info = (kind: Kind, id: string, label: string, location: "local" | "hosted", extra: Partial<ModelProviderInfo>): ModelProviderInfo => ({
    id,
    label,
    location,
    status: "ready",
    ...(kind === "llm" ? ACCOUNTS : SPEECH),
    inUse: (kind === "llm" ? usedByLlm(id) : usedBySttFor(id)).length > 0,
    ...extra
  })

  const llmRow = (provider: string, s: Sample, listed = true): ModelEntry => {
    const key = modelKey({ provider, modelId: s.id })
    return {
      model: { provider, modelId: s.id },
      key,
      name: s.name,
      ...(s.description !== undefined ? { description: s.description } : {}),
      badges: [
        ...(s.context !== undefined ? [{ kind: "context" as const, label: `${tokens(s.context)} context` }] : []),
        ...(s.price !== undefined ? [s.price[0] === 0 && s.price[1] === 0 ? { kind: "price" as const, label: "Free" } : { kind: "price" as const, label: `${dollars(s.price[0])} / ${dollars(s.price[1])} per M` }] : []),
        ...(s.deprecated === true ? [{ kind: "tag" as const, label: "Deprecated" }] : []),
        ...(listed ? [] : [{ kind: "tag" as const, label: "Not in the list" }])
      ],
      tags: [s.id],
      apply: { llm: { account: provider as "anthropic", model: provider === "offline" ? "" : s.id } },
      llm: {
        ...(s.context !== undefined ? { contextTokens: s.context } : {}),
        ...(s.price !== undefined ? { pricing: { inputPerMTok: s.price[0], outputPerMTok: s.price[1] } } : {}),
        ...(s.deprecated === true ? { deprecated: true } : {})
      },
      listed,
      selectable: true,
      usedBy: usedByLlm(provider, s.id),
      favourite: isFavourite("llm", key)
    }
  }

  const withUnlisted = (provider: string, list: ReadonlyArray<Sample>) => {
    const ids = new Set(list.map((s) => s.id))
    const used = [...new Set(deps.assistants().filter((a) => a.llm.account === provider && a.llm.model !== "" && !ids.has(a.llm.model)).map((a) => a.llm.model))]
    return [...list.map((s) => llmRow(provider, s)), ...used.map((id) => llmRow(provider, { id, name: id }, false))]
  }

  const empty = (provider: ModelProviderInfo): ProviderModels => ({ provider, models: [], stale: false, truncated: false })

  const hosted = (id: "anthropic" | "openrouter" | "home-model", refresh: boolean): ProviderModels => {
    const labels = { anthropic: "Anthropic API", openrouter: "OpenRouter", "home-model": "Home model" } as const
    const keyFields = { anthropic: "ANTHROPIC_API_KEY", openrouter: "OPENROUTER_API_KEY", "home-model": "HOME_MODEL_API_KEY" } as const
    const custom = {
      anthropic: { placeholder: "claude-…", help: "A model id of the Anthropic API, as its model list names it." },
      openrouter: { placeholder: "provider/model", help: "An OpenRouter model id, such as those on openrouter.ai/models. Only models that take tools are listed." },
      "home-model": { placeholder: "llama3.1:8b", help: "The model's name as your server knows it (Ollama: ollama list)." }
    } as const
    const label = labels[id]
    const base = { keyField: keyFields[id], implication: id === "home-model" ? "What you say stays on your network." : `What you say is sent to ${id === "anthropic" ? "Anthropic" : "OpenRouter and the model's provider"}.` }
    const mode = forced.get(id) ?? "auto"
    const location = id === "home-model" ? "local" : "hosted"
    const hasKey = id === "home-model" || deps.secretSet(keyFields[id])
    if (mode === "needs_key" || (mode === "auto" && !hasKey)) {
      return empty(info("llm", id, label, location, {
        ...base,
        status: "needs_key",
        ...(deps.vaultLocked()
          ? { reason: "vault_locked" as const, message: `The key vault is locked: unlock it to use ${label}.` }
          : { reason: "missing" as const, message: `${label} is not set up: add its API key in ${ACCOUNTS.settingsLabel}.` })
      }))
    }
    if (mode === "needs_address") {
      return empty(info("llm", id, label, location, { ...base, status: "needs_address", message: `${label} is not set up: add the server address in ${ACCOUNTS.settingsLabel}.` }))
    }
    const address = String(deps.valueOf("HOME_MODEL_BASE_URL") ?? "").trim() || "http://192.168.1.20:11434"
    const failed = mode === "failed" || (mode === "auto" && id === "home-model")
    if (failed) {
      const message = id === "home-model"
        ? `Home model at ${address.replace(/\/+$/, "")}/v1 answered 404 to the model list: not found`
        : id === "anthropic"
        ? "Could not reach Anthropic: getaddrinfo ENOTFOUND api.anthropic.com"
        : "Could not reach OpenRouter at https://openrouter.ai/api/v1: fetch failed"
      // Anthropic falls back to the models the code knows; the others list only what assistants use.
      const known = id === "anthropic" ? ANTHROPIC.slice(0, 3) : []
      return {
        provider: info("llm", id, label, location, { ...base, status: "error", message, customModel: custom[id], ...(known.length > 0 ? { listSource: "known" as const, modelCount: known.length } : {}) }),
        models: withUnlisted(id, known),
        stale: false,
        truncated: false,
        error: { code: "provider_error", message }
      }
    }
    if (refresh || !fetchedAt.has(id)) fetchedAt.set(id, Date.now())
    const list = id === "anthropic" ? ANTHROPIC : id === "openrouter" ? OPENROUTER : HOME
    return {
      provider: info("llm", id, label, location, { ...base, listSource: "provider", modelCount: list.length, customModel: custom[id] }),
      models: withUnlisted(id, list),
      fetchedAt: fetchedAt.get(id)!,
      stale: false,
      truncated: false
    }
  }

  const subscription = (): ProviderModels => {
    const mode = forced.get("claude-subscription") ?? "auto"
    const running = mode === "ready" || (mode === "auto" && deps.subscriptionRunning())
    const base = { implication: "What you say is sent to Anthropic through Claude Code." }
    if (!running) {
      return empty(info("llm", "claude-subscription", "Claude subscription", "hosted", { ...base, status: "needs_setup", message: `Claude subscription is not set up: switch it on in ${ACCOUNTS.settingsLabel}.` }))
    }
    return {
      provider: info("llm", "claude-subscription", "Claude subscription", "hosted", {
        ...base,
        listSource: "provider",
        modelCount: SUBSCRIPTION.length,
        customModel: { placeholder: "claude-…", help: "Any model name Claude Code accepts." }
      }),
      models: withUnlisted("claude-subscription", SUBSCRIPTION),
      stale: false,
      truncated: false
    }
  }

  const offline = (): ProviderModels => ({
    provider: info("llm", "offline", "Offline stand-in", "local", { listSource: "built-in", modelCount: 1 }),
    models: [llmRow("offline", { id: "stand-in", name: "Offline stand-in", description: "Echoes what you say and answers time questions. No language model." })],
    stale: false,
    truncated: false
  })

  const sherpa = (): ProviderModels => {
    const models = deps.sttItems().map((item): ModelEntry => {
      const p = PRESETS[item.id] ?? { ramMb: 1000, loadMs: 1500, languages: [], languagesLabel: "Unknown", takesLanguage: false, liveWords: false }
      const job = deps.runningJob(item.id)
      const state = job !== undefined ? "downloading" as const : item.installed ? "installed" as const : "not_installed" as const
      const key = modelKey({ provider: "sherpa", modelId: item.id })
      return {
        model: { provider: "sherpa", modelId: item.id },
        key,
        name: item.label.split(" — ")[0]!,
        ...(item.description !== undefined ? { description: item.description } : {}),
        badges: [
          { kind: "languages", label: p.languagesLabel },
          { kind: "memory", label: `${(p.ramMb / 1000).toFixed(1)} GB memory`, title: `About ${p.ramMb} MB of memory once loaded (measured)` },
          ...(state !== "installed" ? [{ kind: "size" as const, label: `${item.sizeMb} MB download` }] : []),
          ...(p.demoted === true ? [{ kind: "tag" as const, label: "Not recommended" }] : []),
          ...(item.id === "parakeet-v2" ? [{ kind: "tag" as const, label: "Recommended" }] : [])
        ],
        tags: [item.id, ...p.languages],
        apply: { hearing: { engine: "sherpa", model: item.id } },
        stt: { languages: [...p.languages], languagesLabel: p.languagesLabel, takesLanguage: p.takesLanguage, liveWords: p.liveWords, recommended: item.id === "parakeet-v2" },
        local: { state, sizeMb: item.sizeMb, diskMb: item.diskMb, ramMb: p.ramMb, loadMs: p.loadMs, ...(job !== undefined ? { job } : {}) },
        listed: true,
        selectable: state === "installed",
        usedBy: usedBySttFor("sherpa", item.id),
        favourite: isFavourite("stt", key)
      }
    })
    return {
      provider: info("stt", "sherpa", "On this machine", "local", { listSource: "built-in", modelCount: models.length, implication: "What you say stays on this machine." }),
      models,
      stale: false,
      truncated: false
    }
  }

  const deepgram = (): ProviderModels => {
    const mode = forced.get("deepgram") ?? "auto"
    const base = { keyField: "DEEPGRAM_API_KEY", implication: "What you say is sent to Deepgram." }
    if (mode === "needs_key" || (mode === "auto" && !deps.secretSet("DEEPGRAM_API_KEY"))) {
      return empty(info("stt", "deepgram", "Deepgram", "hosted", {
        ...base,
        status: "needs_key",
        reason: deps.vaultLocked() ? "vault_locked" : "missing",
        message: deps.vaultLocked() ? "The key vault is locked: unlock it to use Deepgram." : `Deepgram is not set up: add its API key in ${SPEECH.settingsLabel}.`
      }))
    }
    const id = String(deps.valueOf("DEEPGRAM_MODEL") ?? "").trim() || "flux-general-en"
    const key = modelKey({ provider: "deepgram", modelId: id })
    return {
      provider: info("stt", "deepgram", "Deepgram", "hosted", { ...base, listSource: "built-in", modelCount: 1 }),
      models: [{
        model: { provider: "deepgram", modelId: id },
        key,
        name: id,
        description: `Deepgram's streaming recogniser, over the internet. Its model is the shared setting DEEPGRAM_MODEL (${SPEECH.settingsLabel}).`,
        badges: [{ kind: "languages", label: "English" }],
        tags: ["deepgram", "en"],
        apply: { hearing: { engine: "deepgram" } },
        stt: { languages: ["en"], languagesLabel: "English", takesLanguage: false, liveWords: true, recommended: false },
        listed: true,
        selectable: true,
        usedBy: usedBySttFor("deepgram"),
        favourite: isFavourite("stt", key)
      }],
      stale: false,
      truncated: false
    }
  }

  const LLM = ["anthropic", "claude-subscription", "openrouter", "home-model", "offline"] as const
  const STT = ["sherpa", "deepgram"] as const
  const one = (kind: Kind, id: string, refresh: boolean): ProviderModels =>
    kind === "stt"
      ? (id === "sherpa" ? sherpa() : deepgram())
      : id === "claude-subscription" ? subscription() : id === "offline" ? offline() : hosted(id as "anthropic", refresh)
  const nameOf = (kind: Kind, provider: string, modelId: string): string | undefined =>
    one(kind, provider, false).models.find((m) => m.model.modelId === modelId)?.name

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** A request under /api/ whose path starts with `models/` (`undefined`: not ours). */
  const route = async (method: string, path: string, query: URLSearchParams, readBody: () => Promise<Record<string, unknown>>): Promise<Answer | undefined> => {
    const m = /^models\/([^/]+)(?:\/(.*))?$/.exec(path)
    if (m === null) return undefined
    const kind = m[1]!
    const rest = m[2] ?? ""
    const only = (...allowed: Array<string>) => (allowed.includes(method) ? undefined : error(405, "method_not_allowed", `Use ${allowed.join(", ")}`))
    if (kind !== "llm" && kind !== "stt") return error(404, "unknown_kind", `There is no model picker "${kind}" (llm or stt)`)
    const ids: ReadonlyArray<string> = kind === "llm" ? LLM : STT
    const unknownProvider = (p: string) => error(404, "unknown_provider", `There is no ${kind === "llm" ? "language model" : "speech recognition"} provider "${p}"`)
    if (rest === "" || rest === "providers") {
      const wrong = only("GET")
      if (wrong !== undefined) return wrong
      const provider = query.get("provider")
      if (rest === "" && provider !== null && !ids.includes(provider)) return unknownProvider(provider)
      const refresh = query.get("refresh") === "1"
      const which = rest === "" && provider !== null ? [provider] : ids
      // Hosted lists take a moment (a refresh longer); a "slow" provider much longer.
      if (rest === "") await sleep(Math.max(refresh ? 500 : 120, ...which.map((id) => (forced.get(id) === "slow" ? 3000 : 0))))
      const lists = which.map((id) => one(kind, id, refresh))
      return { status: 200, body: { kind, providers: rest === "" ? lists : lists.map((l) => l.provider) } }
    }
    if (rest === "favourites") return only("GET") ?? { status: 200, body: { favourites: favourites[kind] } }
    const fav = /^favourites\/([^/]+)$/.exec(rest)
    if (fav !== null) {
      const wrong = only("PUT", "DELETE")
      if (wrong !== undefined) return wrong
      let key: string
      try {
        key = decodeURIComponent(fav[1]!)
      } catch {
        return error(400, "invalid_request", "The model in the address is not valid")
      }
      const ref = parseModelKey(key)
      if (ref === undefined) return error(400, "invalid_request", `"${key.slice(0, 120)}" is not a model (provider:model)`)
      if (!ids.includes(ref.provider)) return unknownProvider(ref.provider)
      const list = favourites[kind]
      if (method === "DELETE") {
        if (!list.some((f) => f.key === key)) return error(404, "not_found", "That model is not a favourite")
        favourites = { ...favourites, [kind]: list.filter((f) => f.key !== key) }
        return { status: 200, body: { favourites: favourites[kind] } }
      }
      const body = await readBody()
      if (body.name !== undefined && (typeof body.name !== "string" || body.name.length === 0 || body.name.length > 100)) {
        return error(400, "invalid_request", "The request is not valid: name")
      }
      const name = typeof body.name === "string" ? body.name : nameOf(kind, ref.provider, ref.modelId) ?? list.find((f) => f.key === key)?.name ?? ref.modelId
      const existing = list.find((f) => f.key === key)
      if (existing === undefined && list.length >= MAX_FAVOURITES) return error(409, "limit_reached", `There are already ${MAX_FAVOURITES} favourites: remove one first`)
      const favourite: ModelFavourite = existing !== undefined ? { ...existing, name } : { model: ref, key, name, addedAt: Date.now() }
      favourites = { ...favourites, [kind]: existing !== undefined ? list.map((f) => (f.key === key ? favourite : f)) : [...list, favourite] }
      return { status: 200, body: { favourite, favourites: favourites[kind] } }
    }
    if (rest === "download" || rest === "download/cancel") {
      const wrong = only("POST")
      if (wrong !== undefined) return wrong
      if (kind !== "stt") return error(404, "not_found", "Only speech recognition models are downloaded")
      const body = await readBody()
      const r = body.model as { provider?: unknown; modelId?: unknown } | undefined
      if (typeof r?.provider !== "string" || typeof r.modelId !== "string") return error(400, "invalid_request", "The request is not valid: model")
      if (!ids.includes(r.provider)) return unknownProvider(r.provider)
      if (r.provider !== "sherpa") return error(400, "invalid_request", "Only models on this machine are downloaded")
      const item = deps.sttItems().find((i) => i.id === r.modelId)
      if (item === undefined) return error(404, "unknown_model", `There is no speech recognition model "${r.modelId}" on this machine`)
      const label = item.label.split(" — ")[0]!
      if (rest === "download/cancel") {
        const job = deps.runningJob(item.id)
        const cancelled = job === undefined ? undefined : deps.stopJob(job.id)
        if (cancelled === undefined) return error(404, "not_found", `${label} is not being downloaded`)
        return { status: 200, body: { cancelled: true, job: cancelled } }
      }
      const started = deps.startJob(item.id)
      if (!started.ok) {
        return started.code === "installed" ? error(409, "already_installed", `${label} is already downloaded`)
          : started.code === "running" ? error(409, "busy", started.message)
          : error(404, "unknown_model", started.message)
      }
      return { status: 202, body: { job: started.job } }
    }
    return error(404, "not_found", `There is nothing at /api/models/${kind}/${rest}`)
  }

  /** POST /mock/models/state {"provider", "state"}. */
  const control = (payload: Record<string, unknown>): Answer => {
    const provider = payload.provider
    const state = payload.state
    const states: ReadonlyArray<Forced> = ["auto", "ready", "failed", "slow", "needs_key", "needs_address"]
    if (typeof provider !== "string" || ![...LLM, ...STT].includes(provider as never)) return { status: 400, body: { error: `provider must be one of ${[...LLM, ...STT].join(", ")}` } }
    if (typeof state !== "string" || !states.includes(state as Forced)) return { status: 400, body: { error: `state must be one of ${states.join(", ")}` } }
    if (state === "auto") forced.delete(provider)
    else forced.set(provider, state as Forced)
    return { status: 200, body: { ok: true, provider, state } }
  }

  const reset = () => {
    forced.clear()
    fetchedAt.clear()
    favourites = initialFavourites()
  }

  return { route, control, reset }
}
